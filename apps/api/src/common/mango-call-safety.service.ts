import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";

const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60_000;
const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const LEGACY_COOLDOWN_MS = 3_000;

type StoredCall<T = unknown> = {
  fingerprint: string;
  status: "processing" | "completed";
  result?: T;
};

class MangoCallRateLimitException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export interface GuardedMangoCall {
  actorId: string;
  scope: "broker" | "client";
  targetId: string;
  idempotencyKey?: string;
}

/**
 * Redis-backed protection around outbound Mango calls.
 *
 * A caller gets a small per-minute budget shared by both call surfaces. New
 * clients additionally send an idempotency UUID and receive the cached result
 * on a retry. Older clients remain supported, but receive a short cooldown so
 * a double click cannot launch two calls back-to-back.
 */
@Injectable()
export class MangoCallSafetyService {
  private readonly logger = new Logger(MangoCallSafetyService.name);

  constructor(
    @InjectQueue("mango-call-safety") private readonly queue: Queue,
  ) {}

  async execute<T>(
    request: GuardedMangoCall,
    action: () => Promise<T>,
  ): Promise<T> {
    const redis = this.queue.client as any;
    const fingerprint = `${request.scope}:${request.targetId}`;
    const idempotencyKey = request.idempotencyKey?.trim();
    const lockKey = idempotencyKey
      ? `mango:call:idempotency:${request.actorId}:${idempotencyKey}`
      : `mango:call:cooldown:${request.actorId}`;
    let ownsIdempotencyLock = false;

    try {
      if (idempotencyKey) {
        const cached = await redis.get(lockKey);
        if (cached) return this.readCachedResult<T>(cached, fingerprint);

        const acquired = await redis.set(
          lockKey,
          JSON.stringify({
            fingerprint,
            status: "processing",
          } satisfies StoredCall),
          "PX",
          IDEMPOTENCY_TTL_MS,
          "NX",
        );
        if (acquired !== "OK") {
          const raced = await redis.get(lockKey);
          if (raced) return this.readCachedResult<T>(raced, fingerprint);
          throw new ConflictException(
            "Повторный запрос звонка уже обрабатывается",
          );
        }
        ownsIdempotencyLock = true;
      } else {
        const acquired = await redis.set(
          lockKey,
          "1",
          "PX",
          LEGACY_COOLDOWN_MS,
          "NX",
        );
        if (acquired !== "OK") {
          throw new MangoCallRateLimitException(
            "Подождите несколько секунд перед следующим звонком",
          );
        }
      }

      await this.consumeRateBudget(redis, request.actorId);
    } catch (error) {
      if (ownsIdempotencyLock) await this.safeDelete(redis, lockKey);
      if (
        error instanceof ConflictException ||
        error instanceof MangoCallRateLimitException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException(
        "Защита исходящих звонков временно недоступна",
      );
    }

    try {
      const result = await action();
      if (idempotencyKey) {
        try {
          await redis.set(
            lockKey,
            JSON.stringify({
              fingerprint,
              status: "completed",
              result,
            } satisfies StoredCall<T>),
            "PX",
            IDEMPOTENCY_TTL_MS,
            "XX",
          );
        } catch (error: any) {
          // The external call has already been accepted. Returning an error here
          // would encourage a retry and could create a duplicate call.
          this.logger.error(
            `Failed to cache Mango idempotency result: ${error?.message || error}`,
          );
        }
      }
      return result;
    } catch (error) {
      if (ownsIdempotencyLock) await this.safeDelete(redis, lockKey);
      throw error;
    }
  }

  private readCachedResult<T>(raw: string, fingerprint: string): T {
    let stored: StoredCall<T>;
    try {
      stored = JSON.parse(raw) as StoredCall<T>;
    } catch {
      throw new ConflictException(
        "Состояние повторного запроса звонка повреждено",
      );
    }
    if (stored.fingerprint !== fingerprint) {
      throw new ConflictException(
        "Ключ повторного запроса уже использован для другого звонка",
      );
    }
    if (stored.status !== "completed") {
      throw new ConflictException("Повторный запрос звонка уже обрабатывается");
    }
    return stored.result as T;
  }

  private async consumeRateBudget(redis: any, actorId: string): Promise<void> {
    const key = `mango:call:rate:${actorId}`;
    const script = [
      "local current = redis.call('INCR', KEYS[1])",
      "if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
      "return current",
    ].join("\n");
    const current = Number(await redis.eval(script, 1, key, RATE_WINDOW_MS));
    if (!Number.isFinite(current) || current > RATE_LIMIT) {
      throw new MangoCallRateLimitException(
        "Слишком много звонков: попробуйте через минуту",
      );
    }
  }

  private async safeDelete(redis: any, key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch (error: any) {
      this.logger.error(
        `Failed to release Mango call guard: ${error?.message || error}`,
      );
    }
  }
}
