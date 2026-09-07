import "reflect-metadata";
import { ForbiddenException, BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UserRole } from "@st-michael/shared";
import { getMangoConfig, setMangoConfig } from "@st-michael/integrations";
import { BrokerCallsService } from "./broker-calls.service";
import { BrokerCallsController } from "./broker-calls.controller";
import { InitiateBrokerCallDto } from "./broker-calls.dto";

const originalMangoConfig = getMangoConfig();

function harness(operator: Record<string, unknown>) {
  const prisma: any = {
    broker: {
      findUnique: jest.fn().mockResolvedValue(operator),
    },
    client: {
      findUnique: jest.fn().mockResolvedValue({
        id: "client-1",
        brokerId: "other-broker",
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
  const mango = {
    initiateCallbackFromExtension: jest
      .fn()
      .mockResolvedValue({ callId: "mango-1" }),
    initiateCallbackViaWebhook: jest
      .fn()
      .mockResolvedValue({ callId: "mango-1" }),
    initiateCallback: jest.fn().mockResolvedValue({ callId: "mango-1" }),
  };
  (service as any).mango = mango;
  return { prisma, safety, service, mango };
}

describe("BrokerCalls Mango safety", () => {
  beforeEach(() => {
    setMangoConfig({
      apiKey: "test-vpbx-key",
      apiSalt: "test-vpbx-salt",
    });
  });

  afterEach(() => {
    setMangoConfig(originalMangoConfig);
  });

  it("validates both client and idempotency UUIDs", async () => {
    const invalid = plainToInstance(InitiateBrokerCallDto, {
      clientId: "not-a-uuid",
      idempotencyKey: "not-a-uuid",
    });
    expect(await validate(invalid)).not.toHaveLength(0);
  });

  it("admits only ADMIN/MANAGER at the route boundary", () => {
    expect(Reflect.getMetadata("roles", BrokerCallsController)).toEqual([
      UserRole.ADMIN,
      UserRole.MANAGER,
    ]);
  });

  it("rejects a broker even if they hit the endpoint", async () => {
    const { service, mango, prisma } = harness({
      id: "broker-1",
      role: "BROKER",
      fullName: "Broker One",
      phone: "+79990000000",
      mangoEmployeeNum: "17",
      doNotCall: false,
    });

    await expect(
      service.initiate(
        { id: "broker-1", role: "BROKER" },
        "client-1",
        "b5066154-6973-4730-bc62-d3df0dc85925",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mango.initiateCallbackFromExtension).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
  });

  it("rejects staff without a Mango EmployeeNUM", async () => {
    const { service, mango } = harness({
      id: "manager-1",
      role: "MANAGER",
      fullName: "Manager One",
      phone: "+79990000000",
      mangoEmployeeNum: null,
      doNotCall: false,
    });

    await expect(
      service.initiate(
        { id: "manager-1", role: "MANAGER" },
        "client-1",
        "b5066154-6973-4730-bc62-d3df0dc85925",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mango.initiateCallback).not.toHaveBeenCalled();
  });

  it("lets КЦ call a client that belongs to another broker via EmployeeNUM", async () => {
    const { prisma, safety, service, mango } = harness({
      id: "manager-1",
      role: "MANAGER",
      fullName: "Manager One",
      phone: "+79990000000",
      mangoEmployeeNum: "17",
      doNotCall: false,
    });

    await service.initiate(
      { id: "manager-1", role: "MANAGER" },
      "client-1",
      "b5066154-6973-4730-bc62-d3df0dc85925",
    );

    expect(safety.execute).toHaveBeenCalledWith(
      {
        actorId: "manager-1",
        scope: "client",
        targetId: "client-1",
        idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
      },
      expect.any(Function),
    );
    expect(mango.initiateCallbackFromExtension).toHaveBeenCalledWith({
      extension: "17",
      to: "+79990000001",
    });
    expect(mango.initiateCallback).not.toHaveBeenCalled();
    expect(prisma.call.create).toHaveBeenCalledTimes(1);
  });
});
