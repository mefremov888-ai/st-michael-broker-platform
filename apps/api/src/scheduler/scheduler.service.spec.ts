import { SchedulerService } from "./scheduler.service";

describe("SchedulerService.handleAmoFailedRetry", () => {
  const originalAmoAccessToken = process.env.AMO_ACCESS_TOKEN;
  const originalMorekitWebhookUrl = process.env.MOREKIT_WEBHOOK_URL;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalAmoAccessToken === undefined)
      delete process.env.AMO_ACCESS_TOKEN;
    else process.env.AMO_ACCESS_TOKEN = originalAmoAccessToken;
    if (originalMorekitWebhookUrl === undefined)
      delete process.env.MOREKIT_WEBHOOK_URL;
    else process.env.MOREKIT_WEBHOOK_URL = originalMorekitWebhookUrl;
  });

  function createService(candidate: any) {
    const prisma = {
      client: {
        findMany: jest.fn().mockResolvedValue([candidate]),
        update: jest.fn().mockResolvedValue({}),
      },
      agency: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ name: "Агентство", inn: "7700000000" }),
      },
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const createFixationRequest = jest.fn().mockResolvedValue({ id: 32270001 });
    const notifyFixation = jest.fn().mockResolvedValue(undefined);
    const service = new SchedulerService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { recheckDue: jest.fn() } as any,
    );
    (service as any).amo = { createFixationRequest };
    (service as any).morekit = { notifyFixation };
    return { service, prisma, createFixationRequest, notifyFixation };
  }

  beforeEach(() => {
    process.env.AMO_ACCESS_TOKEN = "test-token";
    delete process.env.MOREKIT_WEBHOOK_URL;
  });

  it("uses the responsible broker for a delegated fixation retry", async () => {
    process.env.MOREKIT_WEBHOOK_URL = "https://morekit.example.test/webhook";
    const creator = {
      fullName: "Координатор",
      phone: "+79990000001",
      email: "creator@example.test",
      amoContactId: BigInt(111),
    };
    const responsibleBroker = {
      fullName: "Ответственный брокер",
      phone: "+79990000002",
      email: "responsible@example.test",
      amoContactId: BigInt(222),
    };
    const candidate = {
      id: "client-1",
      fixationAgencyId: "agency-1",
      phone: "+79990000003",
      email: null,
      fullName: "Клиент",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: creator,
      responsibleBroker,
    };
    const { service, prisma, createFixationRequest, notifyFixation } =
      createService(candidate);

    await service.handleAmoFailedRetry();

    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { broker: true, responsibleBroker: true },
      }),
    );
    expect(createFixationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerPhone: responsibleBroker.phone,
        brokerAmoContactId: 222,
      }),
    );
    expect(notifyFixation).toHaveBeenCalledWith(
      expect.objectContaining({
        broker_id: "222",
        agent_name: responsibleBroker.fullName,
        agent_phone: "79990000002",
        agent_mail: responsibleBroker.email,
      }),
      process.env.MOREKIT_WEBHOOK_URL,
    );
  });

  it("falls back to the owner broker when no responsible broker is set", async () => {
    const broker = {
      fullName: "Обычный брокер",
      phone: "+79990000004",
      email: null,
      amoContactId: BigInt(333),
    };
    const candidate = {
      id: "client-2",
      fixationAgencyId: "agency-1",
      phone: "+79990000005",
      email: null,
      fullName: "Клиент",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker,
      responsibleBroker: null,
    };
    const { service, createFixationRequest } = createService(candidate);

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerPhone: broker.phone,
        brokerAmoContactId: 333,
      }),
    );
  });

  it("defers without consuming an attempt and self-recovers when the responsible broker gets an amo contact", async () => {
    const candidate = {
      id: "client-3",
      fixationAgencyId: "agency-1",
      phone: "+79990000006",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        fullName: "Creator",
        phone: "+79990000007",
        email: null,
        amoContactId: BigInt(111),
      },
      responsibleBroker: {
        fullName: "Responsible broker",
        phone: "+79990000008",
        email: null,
        amoContactId: null,
      },
    };
    const { service, prisma, createFixationRequest } = createService(candidate);

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: expect.objectContaining({
        amoSyncError:
          "Responsible broker is not linked to an amoCRM contact; retry deferred",
        amoSyncLastAttemptAt: expect.any(Date),
      }),
    });
    expect(prisma.client.update.mock.calls[0][0].data).not.toHaveProperty(
      "amoSyncAttempts",
    );

    candidate.responsibleBroker.amoContactId = BigInt(444);
    prisma.client.update.mockClear();

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerPhone: candidate.responsibleBroker.phone,
        brokerAmoContactId: 444,
      }),
    );
    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: expect.objectContaining({
        amoSyncStatus: "SYNCED",
        amoSyncAttempts: { increment: 1 },
      }),
    });
  });
});
