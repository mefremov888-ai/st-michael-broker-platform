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
    const fixationSafety = {
      execute: jest.fn((_request, action) => action()),
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
    );
  });

  it("keeps legacy clients without a UUID compatible", async () => {
    const clientFixationService = {
      fixClient: jest.fn().mockResolvedValue({ client: { id: "client-1" } }),
    };
    const fixationSafety = {
      execute: jest.fn((_request, action) => action()),
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
});
