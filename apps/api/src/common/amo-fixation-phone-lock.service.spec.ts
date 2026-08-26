import { AmoFixationPhoneLockService } from "./amo-fixation-phone-lock.service";

class FakeRedis {
  readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]) {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async eval(script: string, _keyCount: number, key: string, ...args: string[]) {
    const raw = this.values.get(key);
    if (!raw) return 0;
    let stored: { owner?: string };
    try {
      stored = JSON.parse(raw);
    } catch {
      return 0;
    }
    if (stored.owner !== args[0]) return 0;
    if (script.includes("compare-owner-renew")) return 1;
    if (script.includes("compare-owner-delete")) {
      this.values.delete(key);
      return 1;
    }
    if (script.includes("compare-owner-set")) {
      this.values.set(key, args[1]);
      return 1;
    }
    throw new Error("unknown script");
  }
}

describe("AmoFixationPhoneLockService", () => {
  it("excludes formatted equivalents across independent writers", async () => {
    const redis = new FakeRedis();
    const firstWriter = new AmoFixationPhoneLockService({ client: redis } as any);
    const secondWriter = new AmoFixationPhoneLockService({ client: redis } as any);

    const first = await firstWriter.tryAcquireLease(
      "+79990000021",
      "ui-or-scheduler",
    );
    expect(first).not.toBeNull();
    await expect(first!.assertOwned()).resolves.toBeUndefined();
    await expect(
      secondWriter.tryAcquireLease("8 (999) 000-00-21", "recoverer"),
    ).resolves.toBeNull();

    await first!.release();
    const second = await secondWriter.tryAcquireLease(
      "9990000021",
      "recoverer",
    );
    expect(second).not.toBeNull();
    await second!.release();
  });

  it("fails ownership proof after the lease key disappears", async () => {
    const redis = new FakeRedis();
    const service = new AmoFixationPhoneLockService({ client: redis } as any);
    const lease = await service.tryAcquireLease(
      "+79990000022",
      "scheduler",
    );
    expect(lease).not.toBeNull();
    redis.values.delete(lease!.key);

    await expect(lease!.assertOwned()).rejects.toThrow(
      "AMO_FIXATION_PHONE_LOCK_LOST",
    );
    expect(lease!.hasLostOwnership()).toBe(true);
    await lease!.release();
  });
});
