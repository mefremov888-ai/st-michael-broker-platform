import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { createHash, randomUUID } from "node:crypto";

const PROCESSING_TTL_MS = 10 * 60_000;
const COMPLETED_TTL_MS = 5 * 60_000;
const LEASE_RENEW_INTERVAL_MS = 30_000;

const COMPARE_OWNER_SET_SCRIPT = [
  "-- client-fixation:compare-owner-set",
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, current = pcall(cjson.decode, raw)",
  "if not ok or current.owner ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])",
  "return 1",
].join("\n");

const COMPARE_OWNER_DELETE_SCRIPT = [
  "-- client-fixation:compare-owner-delete",
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, current = pcall(cjson.decode, raw)",
  "if not ok or current.owner ~= ARGV[1] then return 0 end",
  "return redis.call('DEL', KEYS[1])",
].join("\n");

const COMPARE_OWNER_RENEW_SCRIPT = [
  "-- client-fixation:compare-owner-renew",
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, current = pcall(cjson.decode, raw)",
  "if not ok or current.owner ~= ARGV[1] then return 0 end",
  "return redis.call('PEXPIRE', KEYS[1], ARGV[2])",
].join("\n");

type StoredFixation<T = unknown> = {
  fingerprint: string;
  status: "processing" | "completed" | "uncertain";
  owner?: string;
  result?: T;
};

export interface GuardedClientFixation {
  actorId: string;
  payload: unknown;
  idempotencyKey?: string;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return `{${Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(objectValue[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** Exact, PII-free identity used for UUID replay/conflict detection. */
export function clientFixationFingerprint(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

/**
 * Global business identity used for the distributed single-writer lock.
 * amoCRM uniqueness is phone-based, so every simultaneous submission for one
 * canonical phone must share a writer regardless of actor, project, agency,
 * presentation fields, or the obsolete confirmDuplicate flag. The stored
 * exact request fingerprint includes actorId, preventing a completed response
 * from ever being replayed into another cabinet.
 */
export function clientFixationSemanticFingerprint(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return clientFixationFingerprint(payload);
  }

  const parsed = payload as Record<string, unknown>;
  return clientFixationFingerprint({
    phone: typeof parsed.phone === "string" ? parsed.phone.trim() : parsed.phone,
  });
}

/**
 * Redis-backed single-writer guard for POST /clients/fix.
 *
 * The semantic key is always acquired, including for legacy callers without
 * an idempotency UUID. This is important because two browser requests can
 * carry different UUIDs and still represent the same double click. The
 * optional UUID key adds bounded response replay and rejects reuse with a
 * different payload. Redis is a readiness dependency, so the guard fails
 * closed instead of creating an amoCRM lead without distributed protection.
 */
@Injectable()
export class ClientFixationSafetyService {
  private readonly logger = new Logger(ClientFixationSafetyService.name);

  constructor(
    @InjectQueue("client-fixation-safety") private readonly queue: Queue,
  ) {}

  async execute<T>(
    request: GuardedClientFixation,
    action: () => Promise<T>,
  ): Promise<T> {
    const redis = this.queue.client as any;
    const fingerprint = clientFixationFingerprint({
      actorId: request.actorId,
      payload: request.payload,
    });
    const semanticFingerprint = clientFixationSemanticFingerprint(
      request.payload,
    );
    const semanticKey = `client-fixation:semantic:${semanticFingerprint}`;
    const idempotencyKey = request.idempotencyKey?.trim();
    const replayKey = idempotencyKey
      ? `client-fixation:idempotency:${request.actorId}:${idempotencyKey}`
      : null;
    const owner = randomUUID();
    const processing = this.serialize({
      fingerprint,
      status: "processing",
      owner,
    } satisfies StoredFixation);
    let ownsReplay = false;
    let ownsSemantic = false;

    try {
      if (replayKey) {
        const existingReplay = await redis.get(replayKey);
        if (existingReplay) {
          return this.readStoredResult<T>(existingReplay, fingerprint);
        }

        const acquiredReplay = await redis.set(
          replayKey,
          processing,
          "PX",
          PROCESSING_TTL_MS,
          "NX",
        );
        if (acquiredReplay !== "OK") {
          const racedReplay = await redis.get(replayKey);
          if (racedReplay) {
            return this.readStoredResult<T>(racedReplay, fingerprint);
          }
          throw new ConflictException(
            "Повторный запрос фиксации уже обрабатывается",
          );
        }
        ownsReplay = true;
      }

      const existingSemantic = await redis.get(semanticKey);
      if (existingSemantic) {
        const stored = this.parseStored<T>(existingSemantic, fingerprint);
        if (stored.status === "completed") {
          if (replayKey && ownsReplay) {
            await this.cacheCompleted(
              redis,
              replayKey,
              owner,
              fingerprint,
              stored.result,
            );
          }
          return stored.result as T;
        }
        if (replayKey && ownsReplay) {
          await this.releaseOwned(redis, replayKey, owner);
          ownsReplay = false;
        }
        throw this.processingConflict(stored.status);
      }

      const acquiredSemantic = await redis.set(
        semanticKey,
        processing,
        "PX",
        PROCESSING_TTL_MS,
        "NX",
      );
      if (acquiredSemantic !== "OK") {
        const racedSemantic = await redis.get(semanticKey);
        if (racedSemantic) {
          const stored = this.parseStored<T>(racedSemantic, fingerprint);
          if (stored.status === "completed") {
            if (replayKey && ownsReplay) {
              await this.cacheCompleted(
                redis,
                replayKey,
                owner,
                fingerprint,
                stored.result,
              );
            }
            return stored.result as T;
          }
          if (replayKey && ownsReplay) {
            await this.releaseOwned(redis, replayKey, owner);
            ownsReplay = false;
          }
          throw this.processingConflict(stored.status);
        }
        throw new ConflictException(
          "Повторный запрос фиксации уже обрабатывается",
        );
      }
      ownsSemantic = true;
    } catch (error) {
      if (ownsSemantic) await this.releaseOwned(redis, semanticKey, owner);
      if (ownsReplay) await this.releaseOwned(redis, replayKey!, owner);
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException(
        "Защита от повторной фиксации временно недоступна",
      );
    }

    const lease = this.startLeaseRenewal(
      redis,
      replayKey ? [semanticKey, replayKey] : [semanticKey],
      owner,
    );
    try {
      const result = await action();
      await lease.stop();
      if (lease.hasLostOwnership()) {
        throw new ConflictException(
          "Защита фиксации потеряла владение запросом; результат требует сверки, повтор заблокирован",
        );
      }
      const semanticCached = await this.cacheCompleted(
        redis,
        semanticKey,
        owner,
        fingerprint,
        result,
      );
      let replayCached = true;
      if (replayKey) {
        replayCached = await this.cacheCompleted(
          redis,
          replayKey,
          owner,
          fingerprint,
          result,
        );
      }
      if (!semanticCached || !replayCached) {
        throw new ConflictException(
          "Результат фиксации не удалось безопасно закэшировать; повтор заблокирован до сверки",
        );
      }
      return result;
    } catch (error) {
      await lease.stop();
      // The failure can happen after amoCRM accepted POST /leads. Keep a
      // bounded fail-closed marker instead of releasing the lock and turning
      // an ambiguous response into a second lead on retry.
      await this.markUncertain(redis, semanticKey, owner, fingerprint);
      if (replayKey) {
        await this.markUncertain(redis, replayKey, owner, fingerprint);
      }
      throw error;
    } finally {
      await lease.stop();
    }
  }

  private parseStored<T>(raw: string, fingerprint: string): StoredFixation<T> {
    let stored: StoredFixation<T>;
    try {
      stored = JSON.parse(raw) as StoredFixation<T>;
    } catch {
      throw new ConflictException(
        "Состояние повторного запроса фиксации повреждено",
      );
    }
    if (stored.fingerprint !== fingerprint) {
      throw new ConflictException(
        "Ключ повторного запроса уже использован для другой фиксации",
      );
    }
    if (!["processing", "completed", "uncertain"].includes(stored.status)) {
      throw new ConflictException(
        "Состояние повторного запроса фиксации повреждено",
      );
    }
    return stored;
  }

  private readStoredResult<T>(raw: string, fingerprint: string): T {
    const stored = this.parseStored<T>(raw, fingerprint);
    if (stored.status !== "completed") {
      throw this.processingConflict(stored.status);
    }
    return stored.result as T;
  }

  private processingConflict(
    status: StoredFixation["status"],
  ): ConflictException {
    return new ConflictException(
      status === "uncertain"
        ? "Предыдущая фиксация завершилась неоднозначно; повтор временно заблокирован"
        : "Повторный запрос фиксации уже обрабатывается",
    );
  }

  private async cacheCompleted<T>(
    redis: any,
    key: string,
    owner: string,
    fingerprint: string,
    result: T,
  ): Promise<boolean> {
    try {
      const cached = await this.compareOwnerSet(
        redis,
        key,
        owner,
        this.serialize({
          fingerprint,
          status: "completed",
          result,
        } satisfies StoredFixation<T>),
        COMPLETED_TTL_MS,
      );
      if (!cached) {
        this.logger.error(
          "Client fixation lease was lost before the result could be cached",
        );
      }
      return cached;
    } catch (error: any) {
      this.logger.error(
        `Failed to cache client fixation result: ${error?.message || error}`,
      );
      return false;
    }
  }

  private async markUncertain(
    redis: any,
    key: string,
    owner: string,
    fingerprint: string,
  ): Promise<void> {
    try {
      const preserved = await this.compareOwnerSet(
        redis,
        key,
        owner,
        this.serialize({
          fingerprint,
          status: "uncertain",
        } satisfies StoredFixation),
        PROCESSING_TTL_MS,
      );
      if (!preserved) {
        this.logger.error(
          "Client fixation lease was lost before ambiguity could be recorded",
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to preserve ambiguous client fixation guard: ${error?.message || error}`,
      );
    }
  }

  private serialize(value: unknown): string {
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  }

  private startLeaseRenewal(
    redis: any,
    keys: string[],
    owner: string,
  ): {
    hasLostOwnership: () => boolean;
    stop: () => Promise<void>;
  } {
    let stopped = false;
    let lostOwnership = false;
    let inFlight = Promise.resolve();
    const renew = async () => {
      if (stopped) return;
      try {
        const renewed = await Promise.all(
          keys.map((key) => this.renewOwned(redis, key, owner)),
        );
        if (renewed.some((owned) => !owned)) {
          lostOwnership = true;
          this.logger.error(
            "Client fixation lease ownership was lost during renewal",
          );
        }
      } catch (error: any) {
        lostOwnership = true;
        this.logger.error(
          `Failed to renew client fixation lease: ${error?.message || error}`,
        );
      }
    };
    const timer = setInterval(() => {
      inFlight = inFlight.then(renew, renew);
    }, LEASE_RENEW_INTERVAL_MS);
    timer.unref?.();
    return {
      hasLostOwnership: () => lostOwnership,
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await inFlight;
      },
    };
  }

  private async compareOwnerSet(
    redis: any,
    key: string,
    owner: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    return (
      Number(
        await redis.eval(
          COMPARE_OWNER_SET_SCRIPT,
          1,
          key,
          owner,
          value,
          String(ttlMs),
        ),
      ) === 1
    );
  }

  private async renewOwned(
    redis: any,
    key: string,
    owner: string,
  ): Promise<boolean> {
    return (
      Number(
        await redis.eval(
          COMPARE_OWNER_RENEW_SCRIPT,
          1,
          key,
          owner,
          String(PROCESSING_TTL_MS),
        ),
      ) === 1
    );
  }

  private async releaseOwned(
    redis: any,
    key: string,
    owner: string,
  ): Promise<void> {
    try {
      await redis.eval(COMPARE_OWNER_DELETE_SCRIPT, 1, key, owner);
    } catch (error: any) {
      this.logger.error(
        `Failed to release client fixation guard: ${error?.message || error}`,
      );
    }
  }
}
