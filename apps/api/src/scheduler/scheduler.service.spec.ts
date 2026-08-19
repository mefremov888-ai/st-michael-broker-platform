import { SchedulerService } from "./scheduler.service";
import { getAmoTokens, setAmoTokens } from "@st-michael/integrations";

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
    const prisma = {
      client: {
        findMany: jest.fn().mockResolvedValue(candidate ? [candidate] : []),
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
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      broker: {
        findMany: jest.fn().mockResolvedValue([{ id: "manager-1" }]),
      },
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
    const service = new SchedulerService(
      prisma as any,
      notificationQueue as any,
      {} as any,
      {} as any,
      {} as any,
      { recheckDue: jest.fn() } as any,
      opsAlerts as any,
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

    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: expect.objectContaining({ amoSyncStatus: "SYNCED" }),
    });
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("category: MOREKIT_DELIVERY_FAILED"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:morekit-delivery-failed:${candidate.id}`,
      }),
    );
    const directMessage = opsAlerts.sendSafely.mock.calls.find(
      ([, options]) =>
        options.dedupKey ===
        `scheduler:amo-retry:morekit-delivery-failed:${candidate.id}`,
    )?.[0];
    expect(directMessage).toContain(`clientId: ${candidate.id}`);
    expect(directMessage).toContain(`brokerId: ${candidate.broker.id}`);
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
    });

    await service.handleAmoFailedRetry();

    expect(checkUniqueness).toHaveBeenCalledWith(candidate.phone);
    expect(checkUniqueness.mock.invocationCallOrder[0]).toBeLessThan(
      createFixationRequest.mock.invocationCallOrder[0],
    );
    expect(createFixationRequest).toHaveBeenCalledTimes(1);
    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: expect.objectContaining({
        amoSyncStatus: "SYNCED",
        uniquenessStatus: "UNDER_REVIEW",
        uniquenessExpiresAt: null,
        uniquenessReason: "EXCEPTION_AFTER_SALES_MEETING:7002",
      }),
    });
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
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
      expect.stringContaining("10 попыток"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:dead-letter:${candidate.id}`,
      }),
    );
  });

  it("consumes missing-broker-contact attempts and terminalizes at the retry limit", async () => {
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
    const { service, prisma, opsAlerts, createFixationRequest } =
      createService(candidate);

    await service.handleAmoFailedRetry();

    expect(createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: expect.objectContaining({
        amoSyncError:
          "Responsible broker is not linked to an amoCRM contact; retry deferred",
        amoSyncAttempts: { increment: 1 },
        amoSyncLastAttemptAt: expect.any(Date),
        amoSyncStatus: "FAILED",
      }),
    });
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining(`clientId: ${candidate.id}`),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:missing-broker-contact:${candidate.id}`,
      }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("10 попыток"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:dead-letter:${candidate.id}`,
      }),
    );
    expect(
      opsAlerts.sendSafely.mock.calls.some(
        ([, options]: any[]) => String(options?.dedupKey || "").includes(":recovered:"),
      ),
    ).toBe(false);
  });

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
      expect.stringContaining("не указана компания"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:missing-agency:${candidate.id}`,
      }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("10 попыток"),
      expect.objectContaining({
        dedupKey: `scheduler:amo-retry:dead-letter:${candidate.id}`,
      }),
    );
    const directMessages = opsAlerts.sendSafely.mock.calls
      .map(([message]) => message)
      .join("\n");
    expect(directMessages).toContain(`clientId: ${candidate.id}`);
    expect(directMessages).toContain("brokerId: broker-private");
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

    expect(prisma.client.findMany).not.toHaveBeenCalled();
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("AMO_ACCESS_TOKEN отсутствует"),
      {
        dedupKey: "scheduler:amo:token-missing",
        cooldownMs: 60 * 60 * 1000,
      },
    );
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

    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
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
      expect.stringContaining("токен amoCRM недействителен"),
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
      expect.stringContaining("amoCRM недоступен"),
      {
        dedupKey: "scheduler:amo:down",
        cooldownMs: 60 * 60 * 1000,
      },
    );
    expect(opsAlerts.sendSafely).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("amoCRM снова доступен"),
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
      expect.stringContaining("SMTP недоступен"),
      {
        dedupKey: "scheduler:smtp:down",
        cooldownMs: 60 * 60 * 1000,
      },
    );
    expect(opsAlerts.sendSafely).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SMTP снова доступен"),
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
