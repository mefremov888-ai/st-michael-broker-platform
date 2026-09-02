import { SchedulerService } from "./scheduler.service";
import { getAmoTokens, setAmoTokens } from "@st-michael/integrations";
import {
  AMO_CREATE_IN_PROGRESS_MARKER,
  AMO_CREATE_RECONCILIATION_REQUIRED_MARKER,
} from "../common/amo-sync-retry";

describe("SchedulerService.handleAmoFailedRetry", () => {
  const originalAmoAccessToken = process.env.AMO_ACCESS_TOKEN;
  const originalAmoRefreshToken = process.env.AMO_REFRESH_TOKEN;
  const originalMorekitWebhookUrl = process.env.MOREKIT_WEBHOOK_URL;
  const originalAmoTokens = getAmoTokens();

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalAmoAccessToken === undefined)
      delete process.env.AMO_ACCESS_TOKEN;
    else process.env.AMO_ACCESS_TOKEN = originalAmoAccessToken;
    if (originalAmoRefreshToken === undefined)
      delete process.env.AMO_REFRESH_TOKEN;
    else process.env.AMO_REFRESH_TOKEN = originalAmoRefreshToken;
    if (originalMorekitWebhookUrl === undefined)
      delete process.env.MOREKIT_WEBHOOK_URL;
    else process.env.MOREKIT_WEBHOOK_URL = originalMorekitWebhookUrl;
    setAmoTokens(originalAmoTokens.access, originalAmoTokens.refresh);
  });

  function createService(candidate?: any) {
    const candidateRows = candidate
      ? Array.isArray(candidate)
        ? candidate
        : [candidate]
      : [];
    const findMany = jest.fn().mockImplementation(async (args: any) => {
      const isMarkerQuery = Boolean(
        args?.where?.amoSyncError?.startsWith,
      );
      if (isMarkerQuery) {
        return candidateRows.filter((row) =>
          String(row?.amoSyncError || "").startsWith(
            AMO_CREATE_RECONCILIATION_REQUIRED_MARKER,
          ),
        );
      }
      return candidateRows.filter(
        (row) =>
          !String(row?.amoSyncError || "").startsWith(
            AMO_CREATE_RECONCILIATION_REQUIRED_MARKER,
          ),
      );
    });
    const prisma = {
      client: {
        findMany,
        count: jest.fn().mockImplementation(async (args?: { where?: any }) => {
          const errorEquals = args?.where?.amoSyncError;
          if (errorEquals === "BROKER_AMO_CONTACT_MISSING") {
            return candidateRows.filter(
              (row) => row?.amoSyncError === "BROKER_AMO_CONTACT_MISSING",
            ).length;
          }
          return candidateRows.filter((row) =>
            String(row?.amoSyncError || "").startsWith(
              AMO_CREATE_RECONCILIATION_REQUIRED_MARKER,
            ),
          ).length;
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      agency: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ name: "Агентство", inn: "7700000000" }),
      },
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      broker: {
        findMany: jest.fn().mockResolvedValue([{ id: "manager-1" }]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const notificationQueue = { add: jest.fn().mockResolvedValue({}) };
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    const createFixationRequest = jest.fn().mockResolvedValue({ id: 32270001 });
    const checkUniqueness = jest.fn().mockResolvedValue({
      rule: "NO_CONFLICT",
      verdict: "UNIQUE",
      reason: "No conflict",
    });
    const notifyFixation = jest.fn().mockResolvedValue({ ok: true });
    const phoneLease = {
      key: "client-fixation:semantic:test",
      owner: "scheduler-test-owner",
      hasLostOwnership: jest.fn().mockReturnValue(false),
      assertOwned: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const fixationPhoneLock = {
      tryAcquireLease: jest.fn().mockResolvedValue(phoneLease),
    };
    const provisionBrokerAmoContact = jest.fn().mockResolvedValue(null);
    const clientFixation = { provisionBrokerAmoContact };
    const service = new SchedulerService(
      prisma as any,
      notificationQueue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { recheckDue: jest.fn() } as any,
      fixationPhoneLock as any,
      opsAlerts as any,
      clientFixation as any,
    );
    (service as any).amo = { createFixationRequest, checkUniqueness };
    (service as any).morekit = { notifyFixation };
    return {
      service,
      prisma,
      notificationQueue,
      opsAlerts,
      createFixationRequest,
      checkUniqueness,
      notifyFixation,
      fixationPhoneLock,
      phoneLease,
      provisionBrokerAmoContact,
    };
  }

  beforeEach(() => {
    process.env.AMO_ACCESS_TOKEN = "test-token";
    setAmoTokens("test-token", "");
    delete process.env.MOREKIT_WEBHOOK_URL;
  });

  it("uses the responsible broker for a delegated fixation retry", async () => {
    process.env.MOREKIT_WEBHOOK_URL = "https://morekit.example.test/webhook";
    const creator = {
      id: "creator-1",
      fullName: "Координатор",
      phone: "+79990000001",
      email: "creator@example.test",
      amoContactId: BigInt(111),
    };
    const responsibleBroker = {
      id: "responsible-1",
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
    const {
      service,
      prisma,
      createFixationRequest,
      notifyFixation,
      fixationPhoneLock,
      phoneLease,
    } = createService(candidate);

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
    expect(fixationPhoneLock.tryAcquireLease).toHaveBeenCalledWith(
      candidate.phone,
      "scheduler-amo-retry",
    );
    expect(phoneLease.assertOwned.mock.invocationCallOrder[0]).toBeLessThan(
      createFixationRequest.mock.invocationCallOrder[0],
    );
    expect(phoneLease.release).toHaveBeenCalledTimes(1);
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

  it("skips without claiming or posting when another phone writer owns the lock", async () => {
    const candidate = {
      id: "client-phone-lock-busy",
      fixationAgencyId: "agency-1",
      phone: "+79990000073",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "broker-phone-lock-busy",
        fullName: "Broker",
        phone: "+79990000074",
        email: null,
        amoContactId: BigInt(274),
      },
      responsibleBroker: null,
    };
    const {
      service,
      prisma,
      createFixationRequest,
      fixationPhoneLock,
    } = createService(candidate);
    fixationPhoneLock.tryAcquireLease.mockResolvedValueOnce(null);

    await service.handleAmoFailedRetry();

    expect(fixationPhoneLock.tryAcquireLease).toHaveBeenCalledWith(
      candidate.phone,
      "scheduler-amo-retry",
    );
    expect(prisma.client.updateMany).not.toHaveBeenCalled();
    expect(createFixationRequest).not.toHaveBeenCalled();
  });

  it("coalesces equivalent phone formats to one writer per retry snapshot", async () => {
    const broker = {
      id: "broker-same-phone-batch",
      fullName: "Broker",
      phone: "+79990000075",
      email: null,
      amoContactId: BigInt(275),
    };
    const candidate = (id: string, phone: string) => ({
      id,
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 0,
      amoSyncError: null,
      amoSyncStatus: "PENDING",
      phone,
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker,
      responsibleBroker: null,
    });
    const first = candidate("client-same-phone-a", "+79990000076");
    const second = candidate("client-same-phone-b", "8 (999) 000-00-76");
    const {
      service,
      createFixationRequest,
      checkUniqueness,
      fixationPhoneLock,
    } = createService([first, second]);

    await service.handleAmoFailedRetry();

    expect(fixationPhoneLock.tryAcquireLease).toHaveBeenCalledTimes(1);
    expect(checkUniqueness).toHaveBeenCalledTimes(1);
    expect(createFixationRequest).toHaveBeenCalledTimes(1);
  });

  it("blocks a stale RULE_3 retry when a local same-phone lead is not reflected by amo", async () => {
    const candidate = {
      id: "client-stale-rule-3",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 1,
      amoSyncError: null,
      amoSyncStatus: "PENDING",
      phone: "+79990000077",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "broker-stale-rule-3",
        fullName: "Broker",
        phone: "+79990000078",
        email: null,
        amoContactId: BigInt(278),
      },
      responsibleBroker: null,
    };
    const {
      service,
      prisma,
      createFixationRequest,
      checkUniqueness,
      phoneLease,
    } = createService(candidate);
    checkUniqueness.mockResolvedValueOnce({
      rule: "RULE_3",
      verdict: "UNIQUE",
      reason: "Only an old closed lead is visible",
      leads: [{ id: 7077, pipeline_id: 7600542, status_id: 143 }],
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "newly-linked-sibling" }]);

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: candidate.id }),
      data: expect.objectContaining({
        amoSyncError: "AMO_UNIQUENESS_RECHECK_REQUIRED:SAME_PHONE_LINKED",
      }),
    });
    expect(phoneLease.release).toHaveBeenCalledTimes(1);
  });

  it("alerts on a MoreKIT result failure without rolling back a successful amo retry", async () => {
    process.env.MOREKIT_WEBHOOK_URL = "https://morekit.example.test/webhook";
    const rawMorekitError =
      "HTTP 500 raw-secret for Private Client +79991234567";
    const candidate = {
      id: "client-morekit-failure",
      fixationAgencyId: "agency-1",
      phone: "+79991234567",
      email: "private@example.test",
      fullName: "Private Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "broker-morekit-failure",
        fullName: "Broker Name",
        phone: "+79990000011",
        email: null,
        amoContactId: BigInt(777),
      },
      responsibleBroker: null,
    };
    const { service, prisma, opsAlerts, notifyFixation } =
      createService(candidate);
    notifyFixation.mockResolvedValueOnce({
      ok: false,
      error: rawMorekitError,
    });

    await service.handleAmoFailedRetry();
    await Promise.resolve();

    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: candidate.id }),
      data: expect.objectContaining({ amoSyncStatus: "SYNCED" }),
    });
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("контакт-центр не получил фиксацию"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:morekit-delivery-failed:${candidate.id}`,
      }),
    );
    const directMessage = opsAlerts.sendSafely.mock.calls.find(
      ([, options]) =>
        options.dedupKey ===
        `scheduler:amo-retry:morekit-delivery-failed:${candidate.id}`,
    )?.[0];
    expect(directMessage).toContain(`Номер заявки: ${candidate.id}`);
    expect(directMessage).toContain(`Номер брокера: ${candidate.broker.id}`);
    expect(directMessage).not.toContain(rawMorekitError);
    expect(directMessage).not.toContain(candidate.phone);
    expect(directMessage).not.toContain(candidate.fullName);
  });

  it("falls back to the owner broker when no responsible broker is set", async () => {
    const broker = {
      id: "broker-2",
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
    const { service, opsAlerts, createFixationRequest } = createService(candidate);

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerPhone: broker.phone,
        brokerAmoContactId: 333,
      }),
    );
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
  });

  it("never posts a durable ambiguous-create row and alerts for manual reconciliation", async () => {
    const candidate = {
      id: "client-ambiguous-create",
      amoSyncStatus: "FAILED",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 10,
      amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_NETWORK_ERROR`,
      phone: "+79990000061",
      fullName: "Client",
      project: "ZORGE9",
      broker: {
        id: "broker-ambiguous-create",
        fullName: "Broker",
        phone: "+79990000062",
        amoContactId: BigInt(904),
      },
      responsibleBroker: null,
    };
    const { service, prisma, opsAlerts, createFixationRequest } =
      createService(candidate);

    await service.handleAmoFailedRetry();

    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { amoSyncError: null },
            {
              amoSyncError: {
                not: {
                  startsWith: AMO_CREATE_RECONCILIATION_REQUIRED_MARKER,
                },
              },
            },
          ],
        }),
      }),
    );
    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.agency.findUnique).not.toHaveBeenCalled();
    expect(prisma.client.update).not.toHaveBeenCalled();
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("нужно вручную сверить их с amoCRM"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:reconciliation-summary:1:${candidate.id}`,
      }),
    );
  });

  it("reports all reconciliation rows without one alert per row", async () => {
    const reconciliationRows = Array.from({ length: 21 }, (_, index) => ({
      id: `client-reconciliation-${String(index).padStart(2, "0")}`,
      amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_NETWORK_ERROR`,
      broker: { id: `broker-${index}` },
      responsibleBroker: null,
    }));
    const { service, prisma, opsAlerts, createFixationRequest } = createService();
    prisma.client.count.mockImplementation(async (args?: { where?: any }) => {
      if (args?.where?.amoSyncError === "BROKER_AMO_CONTACT_MISSING") return 0;
      return reconciliationRows.length;
    });
    prisma.client.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.amoSyncError?.startsWith) {
        return reconciliationRows.slice(0, 20);
      }
      return [];
    });

    await service.handleAmoFailedRetry();

    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(1);
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("Заявок для ручной проверки: 21"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:reconciliation-summary:21:${reconciliationRows[0].id}`,
      }),
    );
    expect(String(opsAlerts.sendSafely.mock.calls[0][0])).not.toContain(
      reconciliationRows[20].id,
    );
    expect(createFixationRequest).not.toHaveBeenCalled();
  });

  it("terminalizes a legacy ambiguous create error without another amo POST", async () => {
    const candidate = {
      id: "client-legacy-network-error",
      amoSyncStatus: "FAILED",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 1,
      amoSyncError: "AMO_NETWORK_ERROR",
      phone: "+79990000063",
      fullName: "Client",
      project: "ZORGE9",
      broker: {
        id: "broker-legacy-network-error",
        fullName: "Broker",
        phone: "+79990000064",
        amoContactId: BigInt(906),
      },
      responsibleBroker: null,
    };
    const { service, prisma, opsAlerts, createFixationRequest } =
      createService(candidate);

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: {
        id: candidate.id,
        amoLeadId: null,
        amoSyncError: candidate.amoSyncError,
        amoSyncStatus: candidate.amoSyncStatus,
      },
      data: {
        amoSyncStatus: "FAILED",
        amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_NETWORK_ERROR`,
        amoSyncAttempts: 10,
        amoSyncLastAttemptAt: expect.any(Date),
      },
    });
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("нужно проверить её вручную"),
      expect.any(Object),
    );
  });

  it("GET-links a locked ambiguous-create row and never POSTs a second lead", async () => {
    const createdAt = new Date("2026-08-13T18:02:00.000Z");
    const candidate = {
      id: "client-nikita",
      amoSyncStatus: "FAILED",
      amoSyncAttempts: 10,
      amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_NETWORK_ERROR`,
      amoLeadId: null,
      phone: "+79154018836",
      createdAt,
      fullName: "Никита",
      project: "SILVER_BOR",
      broker: {
        id: "broker-denis",
        fullName: "Кшнякин Денис",
        phone: "+79990000064",
        amoContactId: BigInt(9001),
      },
      responsibleBroker: null,
    };
    const { service, prisma, opsAlerts, createFixationRequest } =
      createService(candidate);
    const recover = jest
      .fn()
      .mockResolvedValue({ kind: "found", leadId: 32233521 });
    (service as any).amo.recoverFixationLeadAfterAmbiguousCreate = recover;
    prisma.client.count.mockResolvedValue(0);
    prisma.client.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.amoSyncError?.startsWith) {
        return args?.select?.id ? [] : [candidate];
      }
      return [];
    });

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledWith(
      expect.objectContaining({
        clientPhone: candidate.phone,
        brokerAmoContactId: 9001,
      }),
    );
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: {
        id: candidate.id,
        amoLeadId: null,
        amoSyncError: candidate.amoSyncError,
        amoSyncStatus: candidate.amoSyncStatus,
      },
      data: {
        amoSyncStatus: "SYNCED",
        amoSyncError: null,
        amoLeadId: BigInt(32233521),
        amoSyncLastAttemptAt: expect.any(Date),
      },
    });
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
  });

  it("persists a successful retry with the canonical Prisma shape before the next cron", async () => {
    const candidate = {
      id: "client-successful-retry",
      amoSyncStatus: "FAILED",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 1,
      amoSyncError: "AMO_AUTH_401",
      phone: "+79990000071",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "broker-successful-retry",
        fullName: "Broker",
        phone: "+79990000072",
        email: null,
        amoContactId: BigInt(905),
      },
      responsibleBroker: null,
    };
    const { service, prisma, createFixationRequest } = createService(candidate);
    let candidateServed = false;
    prisma.client.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.amoSyncError?.startsWith) return [];
      if (candidateServed) return [];
      candidateServed = true;
      return [candidate];
    });

    await service.handleAmoFailedRetry();
    await service.handleAmoFailedRetry();

    expect(createFixationRequest).toHaveBeenCalledTimes(1);
    const successUpdate = prisma.client.updateMany.mock.calls.find(
      ([args]: any[]) => args.data.amoSyncStatus === "SYNCED",
    )?.[0];
    expect(successUpdate).toEqual({
      where: {
        id: candidate.id,
        amoLeadId: null,
        amoSyncStatus: "FAILED",
        amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
        amoSyncAttempts: 10,
      },
      data: {
        amoSyncStatus: "SYNCED",
        amoSyncError: null,
        amoSyncAttempts: 2,
        amoSyncLastAttemptAt: expect.any(Date),
        amoLeadId: BigInt(32270001),
      },
    });
    expect(successUpdate.data).not.toHaveProperty("amoReconciliationStatus");
  });

  it("allows only one scheduler replica to claim and POST the same retry row", async () => {
    const candidate = {
      id: "client-two-replicas",
      amoSyncStatus: "FAILED",
      amoSyncAttempts: 1,
      amoSyncLastAttemptAt: new Date("2026-08-25T10:00:00.000Z"),
      amoSyncError: "AMO_AUTH_401",
      fixationAgencyId: "agency-1",
      phone: "+79990000075",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "broker-two-replicas",
        fullName: "Broker",
        phone: "+79990000076",
        email: null,
        amoContactId: BigInt(909),
      },
      responsibleBroker: null,
    };
    const first = createService(candidate);
    const second = createService(candidate);
    (second.service as any).prisma = first.prisma;
    let claimed = false;
    first.prisma.client.updateMany.mockImplementation(async (args: any) => {
      if (args.data.amoSyncError === AMO_CREATE_IN_PROGRESS_MARKER) {
        if (claimed) return { count: 0 };
        claimed = true;
        return { count: 1 };
      }
      return { count: 1 };
    });
    const sharedCreate = jest.fn().mockResolvedValue({ id: 32270002 });
    (first.service as any).amo.createFixationRequest = sharedCreate;
    (second.service as any).amo.createFixationRequest = sharedCreate;

    await Promise.all([
      first.service.handleAmoFailedRetry(),
      second.service.handleAmoFailedRetry(),
    ]);

    expect(sharedCreate).toHaveBeenCalledTimes(1);
    expect(
      first.prisma.client.updateMany.mock.calls.filter(
        ([args]: any[]) =>
          args.data.amoSyncError === AMO_CREATE_IN_PROGRESS_MARKER,
      ),
    ).toHaveLength(2);
  });

  it("stores a durable marker when scheduler loses an amo create response", async () => {
    const candidate = {
      id: "client-scheduler-ambiguous",
      amoSyncStatus: "FAILED",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 2,
      amoSyncError: "AMO_AUTH_401",
      phone: "+79990000073",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      broker: {
        id: "broker-scheduler-ambiguous",
        fullName: "Broker",
        phone: "+79990000074",
        amoContactId: BigInt(907),
      },
      responsibleBroker: null,
    };
    const { service, prisma, opsAlerts, createFixationRequest } =
      createService(candidate);
    createFixationRequest.mockRejectedValueOnce(
      new Error("amoCRM 503 response lost"),
    );

    await service.handleAmoFailedRetry();

    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: candidate.id }),
      data: expect.objectContaining({
        amoSyncStatus: "FAILED",
        amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_TEMPORARY_UNAVAILABLE`,
        amoSyncAttempts: 10,
      }),
    });
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("Сделка могла уже появиться"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:ambiguous-post:${candidate.id}`,
      }),
    );
  });

  it.each([
    {
      rule: "RULE_1",
      expectedStatus: "CONDITIONALLY_UNIQUE",
      expectedReason: "AMO_RULE_1:7001",
    },
    {
      rule: "RULE_2",
      expectedStatus: "UNDER_REVIEW",
      expectedReason: "AMO_RULE_2:7001",
    },
    {
      rule: "RULE_REJECT_SALES_DEAL",
      expectedStatus: "REJECTED",
      expectedReason: "AMO_RULE_REJECT_SALES_DEAL:7001",
    },
  ])(
    "rechecks REFIX_AMO_DOWN and resolves $rule without creating a lead",
    async ({ rule, expectedStatus, expectedReason }) => {
      const candidate = {
        id: `client-recheck-${rule}`,
        brokerId: "broker-recheck",
        fixationAgencyId: null,
        amoSyncAttempts: 0,
        amoSyncError: "AMO_UNIQUENESS_RECHECK_REQUIRED:previous-client",
        phone: "+79990000031",
        email: null,
        fullName: "Client",
        comment: null,
        project: "ZORGE9",
        broker: {
          id: "broker-recheck",
          fullName: "Broker",
          phone: "+79990000032",
          email: null,
          amoContactId: BigInt(901),
        },
        responsibleBroker: null,
      };
      const {
        service,
        prisma,
        opsAlerts,
        createFixationRequest,
        checkUniqueness,
      } = createService(candidate);
      checkUniqueness.mockResolvedValueOnce({
        rule,
        verdict: rule === "RULE_1" ? "UNIQUE" : "ALARM",
        reason: "Decision from amo",
        triggerLeadId: 7001,
      });

      await service.handleAmoFailedRetry();

      expect(checkUniqueness).toHaveBeenCalledWith(candidate.phone);
      expect(createFixationRequest).not.toHaveBeenCalled();
      expect(prisma.agency.findUnique).not.toHaveBeenCalled();
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: candidate.id },
        data: expect.objectContaining({
          uniquenessStatus: expectedStatus,
          uniquenessReason: expectedReason,
          amoLeadId: BigInt(7001),
          amoSyncStatus: "SYNCED",
          amoSyncError: null,
          amoSyncAttempts: { increment: 1 },
        }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "AMO_RETRY_UNIQUENESS_RESOLVED",
          entityId: candidate.id,
          payload: expect.objectContaining({ rule }),
        }),
      });
      expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
    },
  );

  it("rechecks REFIX_AMO_DOWN before creating an UNDER_REVIEW exception lead", async () => {
    const candidate = {
      id: "client-recheck-exception",
      brokerId: "broker-recheck-exception",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 0,
      amoSyncError: "AMO_UNIQUENESS_RECHECK_REQUIRED:previous-client",
      phone: "+79990000041",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "broker-recheck-exception",
        fullName: "Broker",
        phone: "+79990000042",
        email: null,
        amoContactId: BigInt(902),
      },
      responsibleBroker: null,
    };
    const {
      service,
      prisma,
      opsAlerts,
      createFixationRequest,
      checkUniqueness,
    } = createService(candidate);
    checkUniqueness.mockResolvedValueOnce({
      rule: "RULE_EXCEPTION_AFTER_SALES_MEETING",
      verdict: "ALARM",
      reason: "Manual review required",
      triggerLeadId: 7002,
      leads: [{ id: 7002, pipeline_id: 7600550, status_id: 62907430 }],
    });

    await service.handleAmoFailedRetry();

    expect(checkUniqueness).toHaveBeenCalledWith(candidate.phone);
    expect(checkUniqueness.mock.invocationCallOrder[0]).toBeLessThan(
      createFixationRequest.mock.invocationCallOrder[0],
    );
    expect(createFixationRequest).toHaveBeenCalledTimes(1);
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: candidate.id }),
      data: expect.objectContaining({
        amoSyncStatus: "SYNCED",
        uniquenessStatus: "UNDER_REVIEW",
        uniquenessExpiresAt: null,
        uniquenessReason: "EXCEPTION_AFTER_SALES_MEETING:7002",
      }),
    });
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
  });

  it("replaces a uniqueness marker when the subsequent amo create response is ambiguous", async () => {
    const candidate = {
      id: "client-recheck-create-ambiguous",
      amoSyncStatus: "PENDING",
      brokerId: "broker-recheck-create-ambiguous",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 0,
      amoSyncError: "AMO_UNIQUENESS_RECHECK_REQUIRED:previous-client",
      phone: "+79990000043",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "broker-recheck-create-ambiguous",
        fullName: "Broker",
        phone: "+79990000044",
        email: null,
        amoContactId: BigInt(908),
      },
      responsibleBroker: null,
    };
    const { service, prisma, createFixationRequest, checkUniqueness } =
      createService(candidate);
    checkUniqueness.mockResolvedValueOnce({
      rule: "RULE_EXCEPTION_AFTER_SALES_MEETING",
      verdict: "ALARM",
      reason: "Manual review required",
      triggerLeadId: 7003,
      leads: [{ id: 7003, pipeline_id: 7600550, status_id: 62907430 }],
    });
    createFixationRequest.mockRejectedValueOnce(
      new Error("amoCRM did not return a lead id"),
    );

    await service.handleAmoFailedRetry();

    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: candidate.id }),
      data: expect.objectContaining({
        amoSyncStatus: "FAILED",
        amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_INVALID_RESPONSE`,
        amoSyncAttempts: 10,
      }),
    });
    const terminalUpdate = prisma.client.updateMany.mock.calls.find(
      ([args]: any[]) =>
        args.data.amoSyncError ===
        `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_INVALID_RESPONSE`,
    )?.[0];
    expect(terminalUpdate.data.amoSyncError).not.toBe(candidate.amoSyncError);
  });

  it("does not create a lead when the required uniqueness recheck fails", async () => {
    const candidate = {
      id: "client-recheck-failed",
      brokerId: "broker-recheck-failed",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 9,
      amoSyncError: "AMO_UNIQUENESS_RECHECK_REQUIRED:previous-client",
      phone: "+79990000051",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      broker: {
        id: "broker-recheck-failed",
        fullName: "Broker",
        phone: "+79990000052",
        email: null,
        amoContactId: BigInt(903),
      },
      responsibleBroker: null,
    };
    const {
      service,
      prisma,
      opsAlerts,
      createFixationRequest,
      checkUniqueness,
    } = createService(candidate);
    checkUniqueness.mockRejectedValueOnce(new Error("amoCRM 503 unavailable"));

    await service.handleAmoFailedRetry();

    expect(checkUniqueness).toHaveBeenCalledWith(candidate.phone);
    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: expect.objectContaining({
        amoSyncError: candidate.amoSyncError,
        amoSyncAttempts: { increment: 1 },
        amoSyncStatus: "FAILED",
        amoSyncLastAttemptAt: expect.any(Date),
      }),
    });
    expect(prisma.client.update.mock.calls[0][0].data).not.toHaveProperty(
      "uniquenessReason",
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("10 раз"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:dead-letter:${candidate.id}`,
      }),
    );
  });

  it("keeps missing-broker-contact rows in the queue without consuming retry attempts", async () => {
    const candidate = {
      id: "client-3",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 9,
      phone: "+79990000006",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "creator-3",
        fullName: "Creator",
        phone: "+79990000007",
        email: null,
        amoContactId: BigInt(111),
      },
      responsibleBroker: {
        id: "responsible-3",
        fullName: "Responsible broker",
        phone: "+79990000008",
        email: null,
        amoContactId: null,
      },
    };
    const {
      service,
      prisma,
      opsAlerts,
      createFixationRequest,
      phoneLease,
    } = createService(candidate);

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(phoneLease.release).toHaveBeenCalledTimes(1);
    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: expect.objectContaining({
        amoSyncStatus: "PENDING",
        amoSyncError: "BROKER_AMO_CONTACT_MISSING",
        amoSyncLastAttemptAt: expect.any(Date),
      }),
    });
    expect(prisma.client.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amoSyncAttempts: { increment: 1 },
        }),
      }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining(`Номер заявки: ${candidate.id}`),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:missing-broker-contact:${candidate.id}`,
      }),
    );
    expect(opsAlerts.sendSafely).not.toHaveBeenCalledWith(
      expect.stringContaining("10 раз"),
      expect.anything(),
    );
    expect(
      opsAlerts.sendSafely.mock.calls.some(
        ([, options]: any[]) => String(options?.dedupKey || "").includes(":recovered:"),
      ),
    ).toBe(false);
  });

  it("creates the missing broker amo contact itself and then posts the lead", async () => {
    const candidate = {
      id: "client-provision",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 2,
      phone: "+79990000106",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "creator-provision",
        fullName: "Creator",
        phone: "+79990000107",
        email: null,
        amoContactId: BigInt(111),
      },
      responsibleBroker: {
        id: "responsible-provision",
        fullName: "Responsible broker",
        phone: "+79990000108",
        email: null,
        amoContactId: null,
      },
    };
    const {
      service,
      prisma,
      opsAlerts,
      createFixationRequest,
      provisionBrokerAmoContact,
    } = createService(candidate);
    provisionBrokerAmoContact.mockResolvedValue({
      id: candidate.responsibleBroker.id,
      amoContactId: BigInt(4242),
    });

    await service.handleAmoFailedRetry();

    expect(provisionBrokerAmoContact).toHaveBeenCalledWith(
      candidate.responsibleBroker.id,
    );
    expect(createFixationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ brokerAmoContactId: 4242 }),
    );
    expect(prisma.client.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amoSyncError: "BROKER_AMO_CONTACT_MISSING",
        }),
      }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("контакт брокера создан в amoCRM автоматически"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:broker-contact-provisioned:${candidate.responsibleBroker.id}`,
      }),
    );
  });

  it("still defers without burning an attempt when provisioning the contact fails", async () => {
    const candidate = {
      id: "client-provision-failed",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 2,
      phone: "+79990000116",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "creator-provision-failed",
        fullName: "Creator",
        phone: "+79990000117",
        email: null,
        amoContactId: BigInt(111),
      },
      responsibleBroker: {
        id: "responsible-provision-failed",
        fullName: "Responsible broker",
        phone: "+79990000118",
        email: null,
        amoContactId: null,
      },
    };
    const {
      service,
      prisma,
      opsAlerts,
      createFixationRequest,
      provisionBrokerAmoContact,
    } = createService(candidate);
    provisionBrokerAmoContact.mockRejectedValue(new Error("amo is down"));

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: expect.objectContaining({
        amoSyncStatus: "PENDING",
        amoSyncError: "BROKER_AMO_CONTACT_MISSING",
        amoSyncLastAttemptAt: expect.any(Date),
      }),
    });
    expect(prisma.client.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amoSyncAttempts: { increment: 1 },
        }),
      }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining(`Номер заявки: ${candidate.id}`),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:missing-broker-contact:${candidate.id}`,
      }),
    );
  });

  it("does not post the lead when provisioning reports reconciliation is required", async () => {
    const candidate = {
      id: "client-provision-reconcile",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 2,
      phone: "+79990000126",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "creator-provision-reconcile",
        fullName: "Creator",
        phone: "+79990000127",
        email: null,
        amoContactId: BigInt(111),
      },
      responsibleBroker: {
        id: "responsible-provision-reconcile",
        fullName: "Responsible broker",
        phone: "+79990000128",
        email: null,
        amoContactId: null,
      },
    };
    const { service, createFixationRequest, provisionBrokerAmoContact } =
      createService(candidate);
    provisionBrokerAmoContact.mockResolvedValue({
      id: candidate.responsibleBroker.id,
      amoContactId: null,
      reconciliationRequired: true,
    });

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).not.toHaveBeenCalled();
  });

  it("summarizes a broker-contact-missing queue in Telegram even before per-row retry", async () => {
    const candidate = {
      id: "client-missing-contact-summary",
      amoSyncStatus: "FAILED",
      amoSyncError: "BROKER_AMO_CONTACT_MISSING",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 0,
      phone: "+79990000086",
      email: null,
      fullName: "Client",
      comment: null,
      project: "ZORGE9",
      amount: null,
      propertyType: null,
      broker: {
        id: "broker-missing-contact-summary",
        fullName: "Broker",
        phone: "+79990000087",
        email: null,
        amoContactId: null,
      },
      responsibleBroker: null,
    };
    const { service, opsAlerts, createFixationRequest } = createService(candidate);

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("у брокеров нет контактов"),
      expect.objectContaining({
        dedupKey: "scheduler:amo-retry:missing-broker-contact-summary:1",
      }),
    );
  });

  it.each([BigInt(-1), BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)])(
    "never calls the lead adapter for an invalid broker amo contact id (%s)",
    async (invalidContactId) => {
      const candidate = {
        id: "client-invalid-broker-contact",
        fixationAgencyId: "agency-1",
        amoSyncAttempts: 1,
        phone: "+79990000016",
        email: null,
        fullName: "Client",
        comment: null,
        project: "ZORGE9",
        amount: null,
        propertyType: null,
        broker: {
          id: "broker-invalid-contact",
          fullName: "Broker",
          phone: "+79990000017",
          email: null,
          amoContactId: invalidContactId,
        },
        responsibleBroker: null,
      };
      const { service, prisma, createFixationRequest } = createService(candidate);

      await service.handleAmoFailedRetry();

      expect(createFixationRequest).not.toHaveBeenCalled();
      expect(prisma.client.updateMany).not.toHaveBeenCalled();
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: candidate.id },
        data: expect.objectContaining({
          amoSyncStatus: "PENDING",
          amoSyncError: "BROKER_AMO_CONTACT_MISSING",
          amoSyncLastAttemptAt: expect.any(Date),
        }),
      });
    },
  );

  it("records a missing agency failure and alerts when the retry reaches dead-letter", async () => {
    const candidate = {
      id: "client-with-private-id",
      fixationAgencyId: null,
      amoSyncAttempts: 9,
      phone: "+79991234567",
      email: "private@example.test",
      fullName: "Private Client Name",
      comment: "private comment",
      project: "ZORGE9",
      broker: {
        id: "broker-private",
        fullName: "Broker",
        phone: "+79990000009",
        email: null,
        amoContactId: BigInt(555),
      },
      responsibleBroker: null,
    };
    const { service, prisma, opsAlerts, createFixationRequest } =
      createService(candidate);

    await service.handleAmoFailedRetry();

    expect(prisma.agency.findUnique).not.toHaveBeenCalled();
    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: {
        amoSyncError: "FIXATION_AGENCY_MISSING",
        amoSyncAttempts: { increment: 1 },
        amoSyncLastAttemptAt: expect.any(Date),
        amoSyncStatus: "FAILED",
      },
    });
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("не указано агентство"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:missing-agency:${candidate.id}`,
      }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("10 раз"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:dead-letter:${candidate.id}`,
      }),
    );
    const directMessages = opsAlerts.sendSafely.mock.calls
      .map(([message]) => message)
      .join("\n");
    expect(directMessages).toContain(`Номер заявки: ${candidate.id}`);
    expect(directMessages).toContain("Номер брокера: broker-private");
    expect(directMessages).not.toContain(candidate.phone);
    expect(directMessages).not.toContain(candidate.email);
    expect(directMessages).not.toContain(candidate.fullName);
    expect(directMessages).not.toContain(candidate.comment);
  });

  it("alerts directly when the amo token is missing without querying retry candidates", async () => {
    delete process.env.AMO_ACCESS_TOKEN;
    delete process.env.AMO_REFRESH_TOKEN;
    setAmoTokens("", "");
    const { service, prisma, opsAlerts } = createService();

    await service.handleAmoFailedRetry();

    expect(prisma.client.count).toHaveBeenCalledWith({
      where: {
        amoLeadId: null,
        amoSyncError: {
          startsWith: AMO_CREATE_RECONCILIATION_REQUIRED_MARKER,
        },
      },
    });
    expect(prisma.client.findMany).not.toHaveBeenCalled();
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("Данные доступа отсутствуют"),
      {
        dedupKey: "scheduler:amo:token-missing",
        cooldownMs: 60 * 60 * 1000,
      },
    );
  });

  it("alerts a reconciliation row even while amo credentials are missing", async () => {
    delete process.env.AMO_ACCESS_TOKEN;
    delete process.env.AMO_REFRESH_TOKEN;
    setAmoTokens("", "");
    const candidate = {
      id: "client-marker-without-token",
      amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_CREATE_IN_PROGRESS`,
      broker: { id: "broker-marker-without-token" },
      responsibleBroker: null,
    };
    const { service, prisma, opsAlerts, createFixationRequest } =
      createService(candidate);

    await service.handleAmoFailedRetry();

    expect(prisma.client.count).toHaveBeenCalledTimes(2);
    expect(prisma.client.findMany).toHaveBeenCalledTimes(1);
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining(candidate.id),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:reconciliation-summary:1:${candidate.id}`,
      }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("Данные доступа отсутствуют"),
      expect.objectContaining({
        dedupKey: "scheduler:amo:token-missing",
      }),
    );
    expect(createFixationRequest).not.toHaveBeenCalled();
  });

  it("uses credentials loaded from SystemSetting even when env is empty", async () => {
    delete process.env.AMO_ACCESS_TOKEN;
    delete process.env.AMO_REFRESH_TOKEN;
    setAmoTokens("db-loaded-access-token", "db-loaded-refresh-token");
    const { service, prisma, opsAlerts } = createService();

    await service.handleAmoFailedRetry();

    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          amoLeadId: null,
          amoSyncAttempts: { lt: 10 },
        }),
        orderBy: [
          { amoSyncLastAttemptAt: { sort: "asc", nulls: "first" } },
          { createdAt: "asc" },
        ],
      }),
    );
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
  });

  it("sends a sanitized direct ops alert on token-dead, without a redundant per-manager notification", async () => {
    const rawError =
      "401 Unauthorized token=raw-secret client=Private Client Name";
    const candidate = {
      id: "client-401",
      fixationAgencyId: "agency-1",
      amoSyncAttempts: 1,
      phone: "+79991234567",
      email: null,
      fullName: "Private Client Name",
      comment: null,
      project: "ZORGE9",
      broker: {
        id: "broker-401",
        fullName: "Broker",
        phone: "+79990000010",
        email: null,
        amoContactId: BigInt(666),
      },
      responsibleBroker: null,
    };
    const {
      service,
      prisma,
      notificationQueue,
      opsAlerts,
      createFixationRequest,
    } = createService(candidate);
    createFixationRequest.mockRejectedValueOnce(new Error(rawError));

    await service.handleAmoFailedRetry();

    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: candidate.id }),
      data: expect.objectContaining({ amoSyncError: "AMO_AUTH_401" }),
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "AMO_TOKEN_DEAD" }),
      }),
    );
    // 2026-08-19: раньше здесь ещё рассылались персональные TELEGRAM-нотификации
    // всем MANAGER без проверки telegramChatId — это создавало вечный retry в
    // очереди Bull для менеджеров без привязанного чата. sendOpsAlert ниже —
    // единственный канал доставки теперь.
    expect(notificationQueue.add).not.toHaveBeenCalled();
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("amoCRM отклонила подключение"),
      expect.objectContaining({ dedupKey: "scheduler:amo:token-dead" }),
    );
    const directMessage = opsAlerts.sendSafely.mock.calls.find(
      ([, options]) => options.dedupKey === "scheduler:amo:token-dead",
    )?.[0];
    expect(directMessage).not.toContain("raw-secret");
    expect(directMessage).not.toContain(candidate.fullName);
  });
});

describe("SchedulerService operations health alerts", () => {
  const originalEnvironment = {
    AMO_ACCESS_TOKEN: process.env.AMO_ACCESS_TOKEN,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
  };

  function restoreEnvironment() {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnvironment();
  });

  function createMonitoringService() {
    const prisma = {
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      client: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      broker: {
        findMany: jest.fn().mockResolvedValue([{ id: "manager-1" }]),
      },
    };
    const notificationQueue = { add: jest.fn().mockResolvedValue({}) };
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    const service = new SchedulerService(
      prisma as any,
      notificationQueue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      opsAlerts as any,
    );
    return { service, prisma, notificationQueue, opsAlerts };
  }

  it("sends sanitized amo down and recovery alerts without duplicating the outage notification", async () => {
    process.env.AMO_ACCESS_TOKEN = "configured-token-that-must-not-leak";
    const rawError =
      "network failure token=configured-token-that-must-not-leak user=Private Name";
    const { service, prisma, notificationQueue, opsAlerts } =
      createMonitoringService();
    const loggerError = jest
      .spyOn((service as any).logger, "error")
      .mockImplementation(() => undefined);
    const getAccount = jest
      .fn()
      .mockRejectedValueOnce(new Error(rawError))
      .mockRejectedValueOnce(new Error(rawError))
      .mockResolvedValueOnce({ id: 1 });
    (service as any).amo = { getAccount };

    await service.handleAmoHealthCheck();
    await service.handleAmoHealthCheck();
    await service.handleAmoHealthCheck();

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.client.updateMany).toHaveBeenCalledTimes(1);
    // 2026-08-19: персональная TELEGRAM-рассылка всем MANAGER без проверки
    // telegramChatId убрана — sendOpsAlert ниже единственный канал доставки.
    expect(notificationQueue.add).not.toHaveBeenCalled();
    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(2);
    expect(opsAlerts.sendSafely).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("amoCRM временно недоступна"),
      {
        dedupKey: "scheduler:amo:down",
        cooldownMs: 60 * 60 * 1000,
      },
    );
    expect(opsAlerts.sendSafely).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("связь с amoCRM восстановлена"),
      {
        dedupKey: "scheduler:amo:recovered",
        cooldownMs: 60 * 60 * 1000,
      },
    );
    const messages = opsAlerts.sendSafely.mock.calls
      .map(([message]) => message)
      .join("\n");
    expect(messages).not.toContain("configured-token-that-must-not-leak");
    expect(messages).not.toContain("Private Name");
    expect(loggerError.mock.calls.flat().join("\n")).not.toContain(rawError);
  });

  it("sends sanitized SMTP down and recovery alerts without duplicating the outage notification", async () => {
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.SMTP_USER = "private-user@example.test";
    process.env.SMTP_PASS = "smtp-raw-secret";
    const rawError =
      "SMTP auth failed for private-user@example.test using smtp-raw-secret";
    const transporter = {
      verify: jest
        .fn()
        .mockRejectedValueOnce(new Error(rawError))
        .mockRejectedValueOnce(new Error(rawError))
        .mockResolvedValueOnce(true),
      close: jest.fn(),
    };
    const nodemailer = require("nodemailer") as {
      createTransport: (...args: any[]) => any;
    };
    jest
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue(transporter as any);
    const { service, prisma, notificationQueue, opsAlerts } =
      createMonitoringService();
    const loggerError = jest
      .spyOn((service as any).logger, "error")
      .mockImplementation(() => undefined);

    await service.handleSmtpHealthCheck();
    await service.handleSmtpHealthCheck();
    await service.handleSmtpHealthCheck();

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    // 2026-08-19: персональная TELEGRAM-рассылка всем MANAGER без проверки
    // telegramChatId убрана — sendOpsAlert ниже единственный канал доставки.
    expect(notificationQueue.add).not.toHaveBeenCalled();
    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(2);
    expect(opsAlerts.sendSafely).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("электронная почта временно не отправляется"),
      {
        dedupKey: "scheduler:smtp:down",
        cooldownMs: 60 * 60 * 1000,
      },
    );
    expect(opsAlerts.sendSafely).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("отправка электронной почты восстановлена"),
      {
        dedupKey: "scheduler:smtp:recovered",
        cooldownMs: 60 * 60 * 1000,
      },
    );
    const messages = opsAlerts.sendSafely.mock.calls
      .map(([message]) => message)
      .join("\n");
    expect(messages).not.toContain(process.env.SMTP_USER);
    expect(messages).not.toContain(process.env.SMTP_PASS);
    expect(loggerError.mock.calls.flat().join("\n")).not.toContain(rawError);
    expect(transporter.close).toHaveBeenCalledTimes(3);
  });
});
