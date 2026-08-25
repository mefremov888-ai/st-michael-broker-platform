import {
  ClientFixationSafetyService,
  clientFixationFingerprint,
  clientFixationSemanticFingerprint,
} from "./client-fixation-safety.service";

class FakeRedis {
  readonly values = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  fail = false;
  now = 0;
  renewCalls = 0;
  denyRenewal = false;

  advance(milliseconds: number) {
    this.now += milliseconds;
    for (const key of this.values.keys()) this.purgeExpired(key);
  }

  private purgeExpired(key: string) {
    const entry = this.values.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.values.delete(key);
    }
  }

  async get(key: string) {
    if (this.fail) throw new Error("Redis unavailable");
    this.purgeExpired(key);
    return this.values.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]) {
    if (this.fail) throw new Error("Redis unavailable");
    this.purgeExpired(key);
    const nx = args.includes("NX");
    const xx = args.includes("XX");
    if (nx && this.values.has(key)) return null;
    if (xx && !this.values.has(key)) return null;
    const pxIndex = args.indexOf("PX");
    const ttl = pxIndex === -1 ? null : Number(args[pxIndex + 1]);
    this.values.set(key, {
      value,
      expiresAt: ttl === null ? null : this.now + ttl,
    });
    return "OK";
  }

  async del(key: string) {
    if (this.fail) throw new Error("Redis unavailable");
    this.purgeExpired(key);
    return this.values.delete(key) ? 1 : 0;
  }

  async eval(script: string, _keyCount: number, key: string, ...args: string[]) {
    if (this.fail) throw new Error("Redis unavailable");
    this.purgeExpired(key);
    const current = this.values.get(key);
    if (!current) return 0;

    let parsed: { owner?: string };
    try {
      parsed = JSON.parse(current.value) as { owner?: string };
    } catch {
      return 0;
    }
    if (parsed.owner !== args[0]) return 0;

    if (script.includes("client-fixation:compare-owner-set")) {
      this.values.set(key, {
        value: args[1],
        expiresAt: this.now + Number(args[2]),
      });
      return 1;
    }
    if (script.includes("client-fixation:compare-owner-delete")) {
      return this.values.delete(key) ? 1 : 0;
    }
    if (script.includes("client-fixation:compare-owner-renew")) {
      this.renewCalls += 1;
      if (this.denyRenewal) return 0;
      current.expiresAt = this.now + Number(args[1]);
      return 1;
    }
    throw new Error("Unknown Lua script");
  }
}

function createService() {
  const redis = new FakeRedis();
  const service = new ClientFixationSafetyService({ client: redis } as any);
  return { redis, service };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const payload = {
  phone: "+79990000001",
  fullName: "Тестовый Клиент",
  project: "ZORGE9",
  agencyInn: "7700000000",
  amount: 17_000_000,
};

describe("ClientFixationSafetyService", () => {
  it("builds the same PII-free fingerprint regardless of object key order", () => {
    const left = clientFixationFingerprint(payload);
    const right = clientFixationFingerprint({
      amount: payload.amount,
      agencyInn: payload.agencyInn,
      project: payload.project,
      fullName: payload.fullName,
      phone: payload.phone,
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(left).not.toContain(payload.phone);
  });

  it("uses canonical phone for the global semantic lock", () => {
    const base = clientFixationSemanticFingerprint(payload);
    const changedPresentation = clientFixationSemanticFingerprint({
      ...payload,
      fullName: "Другое написание имени",
      comment: "Изменённый комментарий",
      amount: 18_000_000,
      project: "MOMENTS",
      agencyInn: "7800000000",
      responsibleBrokerId: "a6019ff9-7cc4-45d4-b13e-6678e0bf0f55",
      confirmDuplicate: true,
    });
    const changedPhone = clientFixationSemanticFingerprint({
      ...payload,
      phone: "+79990000002",
    });

    expect(changedPresentation).toBe(base);
    expect(changedPhone).not.toBe(base);
  });

  it("allows only one amo lead for two parallel identical legacy requests", async () => {
    const { service } = createService();
    const releaseAmo = deferred<{ id: number }>();
    const enteredAmo = deferred<void>();
    const amoCreateLead = jest.fn(() => {
      enteredAmo.resolve();
      return releaseAmo.promise;
    });
    const request = { actorId: "broker-1", payload };

    const first = service.execute(request, amoCreateLead);
    await enteredAmo.promise;
    const second = service.execute(request, amoCreateLead);

    await expect(second).rejects.toMatchObject({ status: 409 });
    releaseAmo.resolve({ id: 32310587 });
    await expect(first).resolves.toEqual({ id: 32310587 });
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("uses the semantic lock when parallel requests carry different UUIDs", async () => {
    const { service } = createService();
    const releaseAmo = deferred<{ id: number }>();
    const enteredAmo = deferred<void>();
    const amoCreateLead = jest.fn(() => {
      enteredAmo.resolve();
      return releaseAmo.promise;
    });
    const first = service.execute(
      {
        actorId: "broker-1",
        payload,
        idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
      },
      amoCreateLead,
    );
    await enteredAmo.promise;
    const second = service.execute(
      {
        actorId: "broker-1",
        payload,
        idempotencyKey: "7c5ae5b9-33b7-4420-98d7-a562edda3731",
      },
      amoCreateLead,
    );

    await expect(second).rejects.toMatchObject({ status: 409 });
    releaseAmo.resolve({ id: 32310587 });
    await expect(first).resolves.toEqual({ id: 32310587 });
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("blocks parallel variations of the same business fixation", async () => {
    const { service } = createService();
    const releaseAmo = deferred<{ id: number }>();
    const enteredAmo = deferred<void>();
    const amoCreateLead = jest.fn(() => {
      enteredAmo.resolve();
      return releaseAmo.promise;
    });

    const first = service.execute(
      {
        actorId: "broker-1",
        payload,
        idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
      },
      amoCreateLead,
    );
    await enteredAmo.promise;
    const second = service.execute(
      {
        actorId: "broker-1",
        payload: {
          ...payload,
          fullName: "Другое написание имени",
          comment: "Изменённый комментарий",
          project: "MOMENTS",
          agencyInn: "7800000000",
          confirmDuplicate: true,
        },
        idempotencyKey: "7c5ae5b9-33b7-4420-98d7-a562edda3731",
      },
      amoCreateLead,
    );

    await expect(second).rejects.toMatchObject({ status: 409 });
    releaseAmo.resolve({ id: 32310587 });
    await expect(first).resolves.toEqual({ id: 32310587 });
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("serializes the same phone globally without replaying another actor result", async () => {
    const { service } = createService();
    const releaseAmo = deferred<{ id: number }>();
    const enteredAmo = deferred<void>();
    const firstAction = jest.fn(() => {
      enteredAmo.resolve();
      return releaseAmo.promise;
    });
    const secondAction = jest.fn().mockResolvedValue({ id: 32310589 });

    const first = service.execute(
      { actorId: "broker-1", payload },
      firstAction,
    );
    await enteredAmo.promise;
    await expect(
      service.execute({ actorId: "broker-2", payload }, secondAction),
    ).rejects.toMatchObject({ status: 409 });

    releaseAmo.resolve({ id: 32310587 });
    await expect(first).resolves.toEqual({ id: 32310587 });
    await expect(
      service.execute({ actorId: "broker-2", payload }, secondAction),
    ).rejects.toMatchObject({ status: 409 });
    expect(firstAction).toHaveBeenCalledTimes(1);
    expect(secondAction).not.toHaveBeenCalled();
  });

  it("replays a completed response for the same UUID without another amo lead", async () => {
    const { service } = createService();
    const amoCreateLead = jest.fn().mockResolvedValue({
      client: { id: "client-1", amoLeadId: BigInt(32310587) },
      amoSyncStatus: "SYNCED",
    });
    const request = {
      actorId: "broker-1",
      payload,
      idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
    };

    await expect(service.execute(request, amoCreateLead)).resolves.toEqual({
      client: { id: "client-1", amoLeadId: BigInt(32310587) },
      amoSyncStatus: "SYNCED",
    });
    await expect(service.execute(request, amoCreateLead)).resolves.toEqual({
      client: { id: "client-1", amoLeadId: "32310587" },
      amoSyncStatus: "SYNCED",
    });
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("rejects reusing one UUID for a different fixation payload", async () => {
    const { service } = createService();
    const key = "b5066154-6973-4730-bc62-d3df0dc85925";
    await service.execute(
      { actorId: "broker-1", payload, idempotencyKey: key },
      async () => ({ id: 32310587 }),
    );

    await expect(
      service.execute(
        {
          actorId: "broker-1",
          payload: { ...payload, phone: "+79990000002" },
          idempotencyKey: key,
        },
        async () => ({ id: 32310589 }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps an ambiguous failure locked instead of retrying the amo mutation", async () => {
    const { service } = createService();
    const amoCreateLead = jest
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ id: 32310589 });
    const request = { actorId: "broker-1", payload };

    await expect(service.execute(request, amoCreateLead)).rejects.toThrow(
      "response lost",
    );
    await expect(service.execute(request, amoCreateLead)).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    expect(amoCreateLead).toHaveBeenCalledTimes(1);
  });

  it("does not let an expired owner overwrite or delete replacement semantic and replay leases", async () => {
    const { redis, service } = createService();
    const firstResult = deferred<{ id: number }>();
    const secondResult = deferred<{ id: number }>();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const request = {
      actorId: "broker-1",
      payload,
      idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
    };
    const semanticFingerprint = clientFixationSemanticFingerprint(payload);
    const semanticKey = `client-fixation:semantic:${semanticFingerprint}`;
    const replayKey =
      "client-fixation:idempotency:broker-1:b5066154-6973-4730-bc62-d3df0dc85925";

    const first = service.execute(request, () => {
      firstEntered.resolve();
      return firstResult.promise;
    });
    await firstEntered.promise;
    const firstOwner = JSON.parse((await redis.get(semanticKey))!).owner;

    redis.advance(10 * 60_000 + 1);
    const second = service.execute(request, () => {
      secondEntered.resolve();
      return secondResult.promise;
    });
    await secondEntered.promise;
    const secondOwner = JSON.parse((await redis.get(semanticKey))!).owner;
    expect(secondOwner).not.toBe(firstOwner);

    await (service as any).releaseOwned(redis, semanticKey, firstOwner);
    await (service as any).releaseOwned(redis, replayKey, firstOwner);
    expect(JSON.parse((await redis.get(semanticKey))!).owner).toBe(secondOwner);
    expect(JSON.parse((await redis.get(replayKey))!).owner).toBe(secondOwner);

    firstResult.resolve({ id: 32310587 });
    await expect(first).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse((await redis.get(semanticKey))!).owner).toBe(secondOwner);
    expect(JSON.parse((await redis.get(replayKey))!).owner).toBe(secondOwner);

    secondResult.resolve({ id: 32310589 });
    await expect(second).resolves.toEqual({ id: 32310589 });
    expect(JSON.parse((await redis.get(semanticKey))!).status).toBe(
      "completed",
    );
    expect(JSON.parse((await redis.get(replayKey))!).status).toBe(
      "completed",
    );
  });

  it("renews both owned leases until the external mutation settles", async () => {
    jest.useFakeTimers();
    try {
      const { redis, service } = createService();
      const releaseAmo = deferred<{ id: number }>();
      const enteredAmo = deferred<void>();
      const operation = service.execute(
        {
          actorId: "broker-1",
          payload,
          idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
        },
        () => {
          enteredAmo.resolve();
          return releaseAmo.promise;
        },
      );
      await enteredAmo.promise;

      await jest.advanceTimersByTimeAsync(30_000);
      expect(redis.renewCalls).toBe(2);

      releaseAmo.resolve({ id: 32310587 });
      await expect(operation).resolves.toEqual({ id: 32310587 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("fails closed when renewal reports that lease ownership was lost", async () => {
    jest.useFakeTimers();
    try {
      const { redis, service } = createService();
      const releaseAmo = deferred<{ id: number }>();
      const enteredAmo = deferred<void>();
      const operation = service.execute(
        { actorId: "broker-1", payload },
        () => {
          enteredAmo.resolve();
          return releaseAmo.promise;
        },
      );
      await enteredAmo.promise;
      redis.denyRenewal = true;

      await jest.advanceTimersByTimeAsync(30_000);
      releaseAmo.resolve({ id: 32310587 });

      await expect(operation).rejects.toMatchObject({ status: 409 });
    } finally {
      jest.useRealTimers();
    }
  });

  it("fails closed before amoCRM when Redis is unavailable", async () => {
    const { redis, service } = createService();
    redis.fail = true;
    const amoCreateLead = jest.fn().mockResolvedValue({ id: 32310587 });

    await expect(
      service.execute({ actorId: "broker-1", payload }, amoCreateLead),
    ).rejects.toMatchObject({ status: 503 });
    expect(amoCreateLead).not.toHaveBeenCalled();
  });

  it("keeps confirmDuplicate distinct in the exact UUID fingerprint", () => {
    expect(clientFixationFingerprint(payload)).not.toBe(
      clientFixationFingerprint({ ...payload, confirmDuplicate: true }),
    );
  });
});
