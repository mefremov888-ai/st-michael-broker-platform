import { HttpException } from "@nestjs/common";
import { MangoCallSafetyService } from "./mango-call-safety.service";

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly rates = new Map<string, number>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]) {
    const nx = args.includes("NX");
    const xx = args.includes("XX");
    if (nx && this.values.has(key)) return null;
    if (xx && !this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }

  async eval(_script: string, _keys: number, key: string) {
    const next = (this.rates.get(key) || 0) + 1;
    this.rates.set(key, next);
    return next;
  }
}

function createService() {
  const redis = new FakeRedis();
  const service = new MangoCallSafetyService({ client: redis } as any);
  return { redis, service };
}

describe("MangoCallSafetyService", () => {
  it("returns the cached response for the same idempotent call", async () => {
    const { service } = createService();
    const action = jest.fn().mockResolvedValue({ callId: "call-1" });
    const request = {
      actorId: "actor-1",
      scope: "broker" as const,
      targetId: "target-1",
      idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
    };

    await expect(service.execute(request, action)).resolves.toEqual({
      callId: "call-1",
    });
    await expect(service.execute(request, action)).resolves.toEqual({
      callId: "call-1",
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("rejects reusing an idempotency key for another target", async () => {
    const { service } = createService();
    const key = "b5066154-6973-4730-bc62-d3df0dc85925";
    await service.execute(
      {
        actorId: "actor-1",
        scope: "broker",
        targetId: "target-1",
        idempotencyKey: key,
      },
      async () => ({ callId: "call-1" }),
    );

    await expect(
      service.execute(
        {
          actorId: "actor-1",
          scope: "broker",
          targetId: "target-2",
          idempotencyKey: key,
        },
        async () => ({ callId: "call-2" }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("releases the idempotency lock after a failed call", async () => {
    const { service } = createService();
    const request = {
      actorId: "actor-1",
      scope: "client" as const,
      targetId: "target-1",
      idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
    };

    await expect(
      service.execute(request, async () => {
        throw new Error("Mango unavailable");
      }),
    ).rejects.toThrow("Mango unavailable");
    await expect(
      service.execute(request, async () => ({ callId: "retry-ok" })),
    ).resolves.toEqual({ callId: "retry-ok" });
  });

  it("enforces the combined per-user minute budget", async () => {
    const { service } = createService();
    for (let index = 0; index < 6; index += 1) {
      await service.execute(
        {
          actorId: "actor-1",
          scope: "broker",
          targetId: `target-${index}`,
          idempotencyKey: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        },
        async () => ({ ok: true }),
      );
    }

    try {
      await service.execute(
        {
          actorId: "actor-1",
          scope: "broker",
          targetId: "target-7",
          idempotencyKey: "00000000-0000-4000-8000-000000000007",
        },
        async () => ({ ok: true }),
      );
      throw new Error("Expected rate limit");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });

  it("gives legacy clients a short double-click cooldown", async () => {
    const { service } = createService();
    const request = {
      actorId: "actor-1",
      scope: "broker" as const,
      targetId: "target-1",
    };
    await service.execute(request, async () => ({ ok: true }));

    await expect(
      service.execute(request, async () => ({ ok: true })),
    ).rejects.toMatchObject({ status: 429 });
  });
});
