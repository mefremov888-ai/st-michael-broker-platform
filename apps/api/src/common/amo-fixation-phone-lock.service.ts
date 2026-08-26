import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { randomUUID } from "node:crypto";
import { amoFixationPhoneLockRedisKey } from "@st-michael/integrations";

export const AMO_FIXATION_PHONE_LOCK_QUEUE = "client-fixation-safety";
export const AMO_FIXATION_PHONE_LOCK_TTL_MS = 10 * 60_000;
export const AMO_FIXATION_PHONE_LOCK_RENEW_INTERVAL_MS = 30_000;

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

export interface AmoFixationPhoneLease {
  readonly key: string;
  readonly owner: string;
  hasLostOwnership(): boolean;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Shared Redis single-writer primitive for every amo fixation lead creator.
 * The UI keeps its response-replay state in the same key, while background
 * writers use a short processing lease and release it after their bounded
 * GET -> optional POST -> DB-link window.
 */
@Injectable()
export class AmoFixationPhoneLockService {
  private readonly logger = new Logger(AmoFixationPhoneLockService.name);

  constructor(
    @InjectQueue(AMO_FIXATION_PHONE_LOCK_QUEUE)
    private readonly queue: Queue,
  ) {}

  get redisClient(): any {
    return this.queue.client as any;
  }

  key(phone: unknown): string {
    return amoFixationPhoneLockRedisKey(phone);
  }

  async read(phone: unknown): Promise<string | null> {
    return this.readKey(this.key(phone));
  }

  async readKey(key: string): Promise<string | null> {
    return this.redisClient.get(key);
  }

  async tryAcquire(
    phone: unknown,
    owner: string,
    value: string,
    ttlMs = AMO_FIXATION_PHONE_LOCK_TTL_MS,
  ): Promise<boolean> {
    let storedOwner: unknown;
    try {
      storedOwner = JSON.parse(value)?.owner;
    } catch {
      throw new Error("AMO_FIXATION_PHONE_LOCK_VALUE_INVALID");
    }
    if (storedOwner !== owner) {
      throw new Error("AMO_FIXATION_PHONE_LOCK_OWNER_VALUE_MISMATCH");
    }
    return this.tryAcquireKey(this.key(phone), value, ttlMs);
  }

  async tryAcquireKey(
    key: string,
    value: string,
    ttlMs = AMO_FIXATION_PHONE_LOCK_TTL_MS,
  ): Promise<boolean> {
    const acquired = await this.redisClient.set(
      key,
      value,
      "PX",
      ttlMs,
      "NX",
    );
    return acquired === "OK";
  }

  async replaceOwned(
    phone: unknown,
    owner: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    return this.replaceOwnedKey(this.key(phone), owner, value, ttlMs);
  }

  async replaceOwnedKey(
    key: string,
    owner: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.redisClient.eval(
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

  async renewOwned(
    phone: unknown,
    owner: string,
    ttlMs = AMO_FIXATION_PHONE_LOCK_TTL_MS,
  ): Promise<boolean> {
    return this.renewOwnedKey(this.key(phone), owner, ttlMs);
  }

  async renewOwnedKey(
    key: string,
    owner: string,
    ttlMs = AMO_FIXATION_PHONE_LOCK_TTL_MS,
  ): Promise<boolean> {
    return (
      Number(
        await this.redisClient.eval(
          COMPARE_OWNER_RENEW_SCRIPT,
          1,
          key,
          owner,
          String(ttlMs),
        ),
      ) === 1
    );
  }

  async releaseOwned(phone: unknown, owner: string): Promise<boolean> {
    return this.releaseOwnedKey(this.key(phone), owner);
  }

  async releaseOwnedKey(key: string, owner: string): Promise<boolean> {
    return (
      Number(
        await this.redisClient.eval(
          COMPARE_OWNER_DELETE_SCRIPT,
          1,
          key,
          owner,
        ),
      ) === 1
    );
  }

  async tryAcquireLease(
    phone: unknown,
    fingerprint: string,
  ): Promise<AmoFixationPhoneLease | null> {
    const key = this.key(phone);
    const owner = randomUUID();
    const value = JSON.stringify({
      fingerprint,
      status: "processing",
      owner,
    });
    if (!(await this.tryAcquireKey(key, value))) return null;

    let stopped = false;
    let released = false;
    let lostOwnership = false;
    let inFlight = Promise.resolve();
    const renew = async () => {
      if (stopped) return;
      try {
        if (!(await this.renewOwnedKey(key, owner))) {
          lostOwnership = true;
          this.logger.error("amo fixation phone-lock ownership was lost");
        }
      } catch (error: any) {
        lostOwnership = true;
        this.logger.error(
          `Failed to renew amo fixation phone-lock: ${error?.message || error}`,
        );
      }
    };
    const timer = setInterval(() => {
      inFlight = inFlight.then(renew, renew);
    }, AMO_FIXATION_PHONE_LOCK_RENEW_INTERVAL_MS);
    timer.unref?.();

    const stop = async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inFlight;
    };

    return {
      key,
      owner,
      hasLostOwnership: () => lostOwnership,
      assertOwned: async () => {
        await inFlight;
        if (lostOwnership || !(await this.renewOwnedKey(key, owner))) {
          lostOwnership = true;
          throw new Error("AMO_FIXATION_PHONE_LOCK_LOST");
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        await stop();
        try {
          await this.releaseOwnedKey(key, owner);
        } catch (error: any) {
          this.logger.error(
            `Failed to release amo fixation phone-lock: ${error?.message || error}`,
          );
        }
      },
    };
  }
}
