import {
  ClientFixationSafetyService,
  clientFixationFingerprint,
} from "./client-fixation-safety.service";

class FakeRedis {
  readonly values = new Map<string, string>();
  fail = false;

  async get(key: string) {
    if (this.fail) throw new Error("Redis unavailable");
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]) {
    if (this.fail) throw new Error("Redis unavailable");
    const nx = args.includes("NX");
    const xx = args.includes("XX");
    if (nx && this.values.has(key)) return null;
    if (xx && !this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string) {
    if (this.fail) throw new Error("Redis unavailable");
    return this.values.delete(key) ? 1 : 0;
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

  it("fails closed before amoCRM when Redis is unavailable", async () => {
    const { redis, service } = createService();
    redis.fail = true;
    const amoCreateLead = jest.fn().mockResolvedValue({ id: 32310587 });

    await expect(
      service.execute({ actorId: "broker-1", payload }, amoCreateLead),
    ).rejects.toMatchObject({ status: 503 });
    expect(amoCreateLead).not.toHaveBeenCalled();
  });

  it("treats confirmDuplicate as a distinct explicit operation", () => {
    expect(clientFixationFingerprint(payload)).not.toBe(
      clientFixationFingerprint({ ...payload, confirmDuplicate: true }),
    );
  });
});
