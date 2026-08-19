import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BrokerCallsService } from "./broker-calls.service";
import { InitiateBrokerCallDto } from "./broker-calls.dto";

describe("BrokerCalls Mango safety", () => {
  it("validates both client and idempotency UUIDs", async () => {
    const invalid = plainToInstance(InitiateBrokerCallDto, {
      clientId: "not-a-uuid",
      idempotencyKey: "not-a-uuid",
    });
    expect(await validate(invalid)).not.toHaveLength(0);
  });

  it("runs client callback through the shared per-user idempotency guard", async () => {
    const prisma: any = {
      broker: {
        findUnique: jest.fn().mockResolvedValue({
          id: "broker-1",
          fullName: "Broker One",
          phone: "+79990000000",
          mangoEmployeeNum: "17",
          doNotCall: false,
        }),
      },
      client: {
        findUnique: jest.fn().mockResolvedValue({
          id: "client-1",
          brokerId: "broker-1",
          fullName: "Client One",
          phone: "+79990000001",
          amoLeadId: null,
        }),
      },
      call: { create: jest.fn().mockResolvedValue({ id: "call-1" }) },
    };
    const safety = {
      execute: jest.fn((_request: unknown, action: () => Promise<unknown>) =>
        action(),
      ),
    };
    const service = new BrokerCallsService(prisma, safety as any);
    (service as any).mango = {
      initiateCallbackFromExtension: jest
        .fn()
        .mockResolvedValue({ callId: "mango-1" }),
      initiateCallbackViaWebhook: jest
        .fn()
        .mockResolvedValue({ callId: "mango-1" }),
      initiateCallback: jest.fn().mockResolvedValue({ callId: "mango-1" }),
    };

    await service.initiate(
      "broker-1",
      "client-1",
      "b5066154-6973-4730-bc62-d3df0dc85925",
    );

    expect(safety.execute).toHaveBeenCalledWith(
      {
        actorId: "broker-1",
        scope: "client",
        targetId: "client-1",
        idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
      },
      expect.any(Function),
    );
    expect(prisma.call.create).toHaveBeenCalledTimes(1);
  });
});
