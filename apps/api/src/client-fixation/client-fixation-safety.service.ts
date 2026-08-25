import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { createHash } from "node:crypto";

const PROCESSING_TTL_MS = 10 * 60_000;
const COMPLETED_TTL_MS = 5 * 60_000;

type StoredFixation<T = unknown> = {
  fingerprint: string;
  status: "processing" | "completed" | "uncertain";
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

/**
 * PII-free semantic identity for a parsed fixation request. Object key order
 * does not affect the digest, while confirmDuplicate remains part of it so
 * the explicitly confirmed operation is not mistaken for the first check.
 */
export function clientFixationFingerprint(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
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
    const fingerprint = clientFixationFingerprint(request.payload);
    const semanticKey = `client-fixation:semantic:${request.actorId}:${fingerprint}`;
    const idempotencyKey = request.idempotencyKey?.trim();
    const replayKey = idempotencyKey
      ? `client-fixation:idempotency:${request.actorId}:${idempotencyKey}`
      : null;
    const processing = this.serialize({
      fingerprint,
      status: "processing",
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
              fingerprint,
              stored.result,
            );
          }
          return stored.result as T;
        }
        if (replayKey && ownsReplay) {
          await this.safeDelete(redis, replayKey);
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
                fingerprint,
                stored.result,
              );
            }
            return stored.result as T;
          }
          if (replayKey && ownsReplay) {
            await this.safeDelete(redis, replayKey);
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
      if (ownsSemantic) await this.safeDelete(redis, semanticKey);
      if (ownsReplay) await this.safeDelete(redis, replayKey!);
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException(
        "Защита от повторной фиксации временно недоступна",
      );
    }

    try {
      const result = await action();
      await this.cacheCompleted(redis, semanticKey, fingerprint, result);
      if (replayKey) {
        await this.cacheCompleted(redis, replayKey, fingerprint, result);
      }
      return result;
    } catch (error) {
      // The failure can happen after amoCRM accepted POST /leads. Keep a
      // bounded fail-closed marker instead of releasing the lock and turning
      // an ambiguous response into a second lead on retry.
      await this.markUncertain(redis, semanticKey, fingerprint);
      if (replayKey) await this.markUncertain(redis, replayKey, fingerprint);
      throw error;
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
    fingerprint: string,
    result: T,
  ): Promise<void> {
    try {
      const cached = await redis.set(
        key,
        this.serialize({
          fingerprint,
          status: "completed",
          result,
        } satisfies StoredFixation<T>),
        "PX",
        COMPLETED_TTL_MS,
        "XX",
      );
      if (cached !== "OK") {
        this.logger.error(
          "Client fixation guard expired before the result could be cached",
        );
      }
    } catch (error: any) {
      // The external mutation may already exist. Returning an error here
      // would encourage another POST, so preserve the original response.
      this.logger.error(
        `Failed to cache client fixation result: ${error?.message || error}`,
      );
    }
  }

  private async markUncertain(
    redis: any,
    key: string,
    fingerprint: string,
  ): Promise<void> {
    try {
      await redis.set(
        key,
        this.serialize({
          fingerprint,
          status: "uncertain",
        } satisfies StoredFixation),
        "PX",
        PROCESSING_TTL_MS,
        "XX",
      );
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

  private async safeDelete(redis: any, key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch (error: any) {
      this.logger.error(
        `Failed to release client fixation guard: ${error?.message || error}`,
      );
    }
  }
}
