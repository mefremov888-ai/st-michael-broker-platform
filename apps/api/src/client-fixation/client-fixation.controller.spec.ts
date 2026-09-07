import { ClientFixationController } from "./client-fixation.controller";

const validBody = {
  phone: "+79990000001",
  fullName: "Тестовый Клиент",
  project: "ZORGE9",
  agencyInn: "7700000000",
};

describe("ClientFixationController idempotency", () => {
  it("guards the parsed request and keeps the transport UUID out of domain data", async () => {
    const clientFixationService = {
      fixClient: jest.fn().mockResolvedValue({ client: { id: "client-1" } }),
    };
    const assertOwned = jest.fn().mockResolvedValue(undefined);
    const fixationSafety = {
      execute: jest.fn((_request, action) => action({ assertOwned })),
    };
    const controller = new ClientFixationController(
      clientFixationService as any,
      fixationSafety as any,
    );
    const idempotencyKey = "b5066154-6973-4730-bc62-d3df0dc85925";

    await expect(
      controller.fixClient({ id: "broker-1" } as any, {
        ...validBody,
        idempotencyKey,
      }),
    ).resolves.toEqual({ client: { id: "client-1" } });

    expect(fixationSafety.execute).toHaveBeenCalledWith(
      {
        actorId: "broker-1",
        payload: validBody,
        idempotencyKey,
      },
      expect.any(Function),
    );
    expect(clientFixationService.fixClient).toHaveBeenCalledWith(
      "broker-1",
      validBody,
      assertOwned,
    );
  });

  it("keeps legacy clients without a UUID compatible", async () => {
    const clientFixationService = {
      fixClient: jest.fn().mockResolvedValue({ client: { id: "client-1" } }),
    };
    const assertOwned = jest.fn().mockResolvedValue(undefined);
    const fixationSafety = {
      execute: jest.fn((_request, action) => action({ assertOwned })),
    };
    const controller = new ClientFixationController(
      clientFixationService as any,
      fixationSafety as any,
    );

    await controller.fixClient({ id: "broker-1" } as any, validBody);

    expect(fixationSafety.execute).toHaveBeenCalledWith(
      {
        actorId: "broker-1",
        payload: validBody,
        idempotencyKey: undefined,
      },
      expect.any(Function),
    );
  });

  it("rejects a malformed idempotency key before the guarded action", async () => {
    const clientFixationService = { fixClient: jest.fn() };
    const fixationSafety = { execute: jest.fn() };
    const controller = new ClientFixationController(
      clientFixationService as any,
      fixationSafety as any,
    );

    await expect(
      controller.fixClient({ id: "broker-1" } as any, {
        ...validBody,
        idempotencyKey: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(fixationSafety.execute).not.toHaveBeenCalled();
    expect(clientFixationService.fixClient).not.toHaveBeenCalled();
  });

  it("accepts a 12-digit personal agency INN from the broker profile", async () => {
    const clientFixationService = {
      fixClient: jest.fn().mockResolvedValue({ client: { id: "client-1" } }),
    };
    const assertOwned = jest.fn().mockResolvedValue(undefined);
    const fixationSafety = {
      execute: jest.fn((_request, action) => action({ assertOwned })),
    };
    const controller = new ClientFixationController(
      clientFixationService as any,
      fixationSafety as any,
    );

    await expect(
      controller.fixClient({ id: "broker-1" } as any, {
        ...validBody,
        agencyInn: "123456789777",
      }),
    ).resolves.toEqual({ client: { id: "client-1" } });

    expect(clientFixationService.fixClient).toHaveBeenCalledWith(
      "broker-1",
      expect.objectContaining({ agencyInn: "123456789777" }),
      assertOwned,
    );
  });

  // 2026-09-07: схема стала мягкой (4-20 цифр) — 11-значный ИНН больше не
  // валит запрос 400-кой. Строгая проверка 10/12 живёт в сервисе фиксации,
  // который оформляет фиксацию без агентства и возвращает agencyWarning.
  it("accepts an 11-digit agency INN and lets the service decide (soft schema)", async () => {
    const clientFixationService = {
      fixClient: jest.fn().mockResolvedValue({
        client: { id: "client-1" },
        agencyWarning: "warning",
      }),
    };
    const assertOwned = jest.fn().mockResolvedValue(undefined);
    const fixationSafety = {
      execute: jest.fn((_request, action) => action({ assertOwned })),
    };
    const controller = new ClientFixationController(
      clientFixationService as any,
      fixationSafety as any,
    );

    await expect(
      controller.fixClient({ id: "broker-1" } as any, {
        ...validBody,
        agencyInn: "12345678901",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ agencyWarning: "warning" }),
    );

    expect(clientFixationService.fixClient).toHaveBeenCalledWith(
      "broker-1",
      expect.objectContaining({ agencyInn: "12345678901" }),
      assertOwned,
    );
  });

  it("still rejects a non-numeric agency INN by schema", async () => {
    const clientFixationService = { fixClient: jest.fn() };
    const fixationSafety = { execute: jest.fn() };
    const controller = new ClientFixationController(
      clientFixationService as any,
      fixationSafety as any,
    );

    await expect(
      controller.fixClient({ id: "broker-1" } as any, {
        ...validBody,
        agencyInn: "abc",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(fixationSafety.execute).not.toHaveBeenCalled();
  });
});
