import { ClientFixationService } from "./client-fixation.service";

describe("ClientFixationService amo broker attachment", () => {
  let prisma: any;
  let amo: any;
  let queue: any;
  let opsAlerts: any;
  let service: ClientFixationService;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      broker: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      brokerAgency: { create: jest.fn().mockResolvedValue({}) },
      agency: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      client: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    amo = {
      findBrokerContactByPhone: jest.fn(),
      updateContact: jest.fn().mockResolvedValue(undefined),
      createContact: jest.fn(),
      checkUniqueness: jest.fn(),
      createFixationRequest: jest.fn(),
      createBrokerLeadFromLanding: jest.fn(),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    service = new ClientFixationService(prisma, amo, queue, opsAlerts);
    consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    delete process.env.MOREKIT_WEBHOOK_URL;
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("resolves the responsible broker contact before creating a fixation lead", async () => {
    const creator = {
      id: "creator",
      fullName: "Координатор",
      phone: "+70000000001",
      email: null,
      amoContactId: BigInt(101),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const responsible = {
      id: "responsible",
      fullName: "Новый брокер",
      phone: "+79990000002",
      email: "new@example.test",
      amoContactId: null,
      funnelStage: "NEW_BROKER",
      brokerAgencies: [
        {
          isPrimary: true,
          agency: { id: "a1", name: "Агентство", inn: "7700000000" },
        },
      ],
    };

    prisma.broker.findUnique.mockImplementation(async (args: any) => {
      if (args.where.id === "creator") return creator;
      if (args.where.id === "responsible") return responsible;
      return null;
    });
    prisma.agency.findUnique.mockResolvedValue({
      id: "a1",
      name: "Агентство",
      inn: "7700000000",
    });
    prisma.client.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.client.create.mockResolvedValue({ id: "client-1" });
    amo.findBrokerContactByPhone.mockResolvedValue({
      id: 777,
      name: "Новый брокер",
    });
    amo.checkUniqueness.mockResolvedValue({
      rule: "NO_CONFLICT",
      verdict: "UNIQUE",
      reason: "Контакт не найден",
    });
    amo.createFixationRequest.mockResolvedValue({ id: 9001 });

    await service.fixClient("creator", {
      phone: "+79991112233",
      fullName: "Клиент",
      project: "ZORGE9" as any,
      agencyInn: "7700000000",
      responsibleBrokerId: "responsible",
    });

    expect(amo.findBrokerContactByPhone).toHaveBeenCalledWith(
      responsible.phone,
      { strict: true },
    );
    expect(prisma.broker.update).toHaveBeenCalledWith({
      where: { id: "responsible" },
      data: { amoContactId: BigInt(777) },
    });
    expect(amo.createFixationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerPhone: responsible.phone,
        brokerAmoContactId: 777,
      }),
    );
  });

  it("syncs an existing broker found by phone before returning it", async () => {
    const creator = {
      id: "creator",
      fullName: "Создатель",
      brokerAgencies: [
        {
          isPrimary: true,
          agency: { id: "a1", name: "Агентство", inn: "7700000000" },
        },
      ],
    };
    const existing = {
      id: "existing",
      fullName: "Существующий брокер",
      phone: "+79990000003",
      email: null,
      isCoordinator: false,
    };
    const fullExisting = {
      ...existing,
      amoContactId: null,
      brokerAgencies: [],
    };

    prisma.broker.findUnique.mockImplementation(async (args: any) => {
      if (args.where.id === "creator") return creator;
      if (args.where.phone === existing.phone) return existing;
      if (args.where.id === "existing") return fullExisting;
      return null;
    });
    amo.findBrokerContactByPhone.mockResolvedValue({
      id: 778,
      name: existing.fullName,
    });

    const result = await service.createBrokerByCreator("creator", {
      fullName: existing.fullName,
      phone: existing.phone,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result).toEqual({ broker: existing, created: false });
    expect(amo.findBrokerContactByPhone).toHaveBeenCalledWith(existing.phone, {
      strict: true,
    });
    expect(prisma.broker.update).toHaveBeenCalledWith({
      where: { id: "existing" },
      data: { amoContactId: BigInt(778) },
    });
    expect(prisma.broker.create).not.toHaveBeenCalled();
  });

  it("persists a fallback contact id returned while creating the broker lead", async () => {
    const creator = {
      id: "creator",
      fullName: "Создатель",
      brokerAgencies: [
        {
          isPrimary: true,
          agency: { id: "a1", name: "Агентство", inn: "7700000000" },
        },
      ],
    };
    const created = {
      id: "new-broker",
      fullName: "Новый брокер",
      phone: "+79990000004",
      email: null,
      amoContactId: null,
    };
    const fullCreated = {
      ...created,
      brokerAgencies: creator.brokerAgencies,
    };

    prisma.broker.findUnique.mockImplementation(async (args: any) => {
      if (args.where.id === "creator") return creator;
      if (args.where.phone === created.phone) return null;
      if (args.where.id === "new-broker" && args.select?.amoContactId) {
        return { amoContactId: null };
      }
      if (args.where.id === "new-broker") return fullCreated;
      return null;
    });
    prisma.broker.create.mockResolvedValue(created);
    amo.findBrokerContactByPhone.mockResolvedValue(null);
    amo.createContact.mockRejectedValue(
      new Error("amoCRM 400 /contacts: custom field rejected"),
    );
    amo.createBrokerLeadFromLanding.mockResolvedValue({
      contactId: 779,
      leadId: 880,
    });

    const result = await service.createBrokerByCreator("creator", {
      fullName: created.fullName,
      phone: created.phone,
    });

    expect(result.created).toBe(true);
    expect(amo.createBrokerLeadFromLanding).toHaveBeenCalledWith(
      expect.objectContaining({ existingContactId: undefined }),
    );
    expect(prisma.broker.update).toHaveBeenCalledWith({
      where: { id: "new-broker" },
      data: { amoContactId: BigInt(779) },
    });
  });

  it("does not create a contact when the strict amo lookup fails", async () => {
    const broker = {
      id: "new-broker",
      fullName: "Новый брокер",
      phone: "+79990000005",
      email: null,
      amoContactId: null,
      brokerAgencies: [],
    };
    prisma.broker.findUnique.mockResolvedValue(broker);
    amo.findBrokerContactByPhone.mockRejectedValue(new Error("amoCRM 401"));

    await expect(
      (service as any).ensureBrokerAmoContact("new-broker"),
    ).rejects.toThrow("amoCRM 401");

    expect(amo.createContact).not.toHaveBeenCalled();
    expect(prisma.broker.update).not.toHaveBeenCalled();
  });

  it("queues REFIX_AMO_DOWN for retry and sends sanitized failure alerts", async () => {
    const broker = {
      id: "broker-refix-down",
      fullName: "Sensitive Broker Name",
      phone: "+79990000011",
      email: null,
      amoContactId: BigInt(811),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-1",
      name: "Agency",
      inn: "7700000000",
    };
    const existingClient = {
      id: "client-existing",
      brokerId: broker.id,
      uniquenessStatus: "CONDITIONALLY_UNIQUE",
      uniquenessExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      amoLeadId: BigInt(991),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      deals: [],
      broker,
    };
    const refixClient = {
      id: "client-refix-pending",
      amoSyncStatus: "PENDING",
    };
    const rawError =
      "amoCRM 503 socket reset; diagnostic=TOP-SECRET; Ivan +79991112233";

    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.broker.findMany.mockResolvedValue([{ id: "manager-1" }]);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(existingClient);
    prisma.client.create.mockResolvedValue(refixClient);
    amo.checkUniqueness.mockRejectedValue(new Error(rawError));

    const result = await service.fixClient(broker.id, {
      phone: "+79991112233",
      fullName: "Sensitive Client Name",
      project: "ZORGE9" as any,
      agencyInn: agency.inn,
    });

    expect(prisma.client.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amoSyncStatus: "PENDING",
        amoSyncError: `AMO_UNIQUENESS_RECHECK_REQUIRED:${existingClient.id}`,
        uniquenessReason:
          "Повторная фиксация: проверка amoCRM будет повторена автоматически.",
      }),
    });
    expect(
      prisma.client.create.mock.calls[0][0].data.uniquenessReason,
    ).not.toContain("AMO_UNIQUENESS_RECHECK_REQUIRED");
    expect(result).toEqual(
      expect.objectContaining({
        client: refixClient,
        amoSyncStatus: "PENDING",
      }),
    );
    expect(amo.createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AMO_SYNC_FAILED",
        entityId: refixClient.id,
        payload: expect.objectContaining({ scenario: "REFIX_AMO_DOWN" }),
      }),
    });

    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(1);
    const opsMessage = opsAlerts.sendSafely.mock.calls[0][0] as string;
    expect(opsMessage).toContain(`clientId: ${refixClient.id}`);
    expect(opsMessage).toContain(`brokerId: ${broker.id}`);
    expect(opsMessage).toContain("category: AMO_UNAVAILABLE");
    expect(opsMessage).toContain("scenario: REFIX_AMO_DOWN");

    expect(queue.add).toHaveBeenCalledTimes(1);
    const managerNotification = queue.add.mock.calls[0][1];
    expect(managerNotification.payload).toEqual(
      expect.objectContaining({
        clientId: refixClient.id,
        brokerId: broker.id,
        category: "AMO_UNAVAILABLE",
        scenario: "REFIX_AMO_DOWN",
      }),
    );
    for (const externalText of [opsMessage, managerNotification.body]) {
      expect(externalText).not.toContain("Sensitive Broker Name");
      expect(externalText).not.toContain("Sensitive Client Name");
      expect(externalText).not.toContain(broker.phone);
      expect(externalText).not.toContain("+79991112233");
      expect(externalText).not.toContain("TOP-SECRET");
      expect(externalText).not.toContain(rawError);
    }
  });

  it("does not classify a successful sales-meeting exception as REFIX_AMO_DOWN", async () => {
    const broker = {
      id: "broker-sales-exception",
      fullName: "Broker",
      phone: "+79990000021",
      email: null,
      amoContactId: BigInt(821),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-sales-exception",
      name: "Agency",
      inn: "7900000000",
    };
    const existingClient = {
      id: "client-active-before-exception",
      brokerId: broker.id,
      uniquenessStatus: "CONDITIONALLY_UNIQUE",
      uniquenessExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      amoLeadId: BigInt(7771),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      deals: [],
      broker,
    };
    const newClient = { id: "client-sales-exception" };

    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(existingClient);
    prisma.client.create.mockResolvedValue(newClient);
    amo.checkUniqueness.mockResolvedValue({
      rule: "RULE_EXCEPTION_AFTER_SALES_MEETING",
      verdict: "ALARM",
      reason: "Sales meeting exception",
      triggerLeadId: 8801,
    });
    amo.createFixationRequest.mockResolvedValue({ id: 9901 });

    const result = await service.fixClient(broker.id, {
      phone: "+79991112255",
      fullName: "Client",
      project: "ZORGE9" as any,
      agencyInn: agency.inn,
    });

    expect(prisma.client.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        uniquenessStatus: "UNDER_REVIEW",
        uniquenessExpiresAt: null,
        uniquenessReason: expect.stringContaining(
          "EXCEPTION_AFTER_SALES_MEETING:8801",
        ),
      }),
    });
    expect(amo.createFixationRequest).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        client: newClient,
        status: "UNDER_REVIEW",
        amoSyncStatus: "SYNCED",
      }),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AMO_SYNC_FAILED",
        payload: expect.objectContaining({ scenario: "REFIX_AMO_DOWN" }),
      }),
    });
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("audits and alerts when refix-after-closed cannot create an amo lead", async () => {
    const broker = {
      id: "broker-refix-closed",
      fullName: "Closed Refix Broker",
      phone: "+79990000012",
      email: null,
      amoContactId: BigInt(812),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-2",
      name: "Agency",
      inn: "7800000000",
    };
    const existingClient = {
      id: "client-closed",
      brokerId: broker.id,
      uniquenessStatus: "EXPIRED",
      uniquenessExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
      amoLeadId: BigInt(992),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      deals: [],
      broker,
    };
    const newClient = { id: "client-refix-failed" };
    const rawError = "amoCRM 503 network failure TOP-SECRET";

    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.broker.findMany.mockResolvedValue([
      {
        id: "manager-1",
        fullName: "Manager",
        phone: "+79990000099",
        telegramUsername: null,
      },
    ]);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(existingClient);
    prisma.client.create.mockResolvedValue(newClient);
    amo.checkUniqueness.mockResolvedValue({
      rule: "RULE_3",
      verdict: "UNIQUE",
      reason: "Previous lead is closed",
    });
    amo.createFixationRequest.mockRejectedValue(new Error(rawError));

    const result = await service.fixClient(broker.id, {
      phone: "+79991112244",
      fullName: "Closed Refix Client",
      project: "ZORGE9" as any,
      agencyInn: agency.inn,
    });

    expect(result).toEqual(
      expect.objectContaining({
        client: newClient,
        amoSyncStatus: "FAILED",
      }),
    );
    expect(prisma.client.update).toHaveBeenCalledWith({
      where: { id: newClient.id },
      data: expect.objectContaining({ amoSyncStatus: "FAILED" }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AMO_SYNC_FAILED",
        entityId: newClient.id,
        payload: expect.objectContaining({
          step: "refixAfterClosed.createFixationRequest",
        }),
      }),
    });
    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(1);
    expect(opsAlerts.sendSafely.mock.calls[0][0]).toContain(
      "scenario: REFIX_AFTER_CLOSED",
    );
    expect(queue.add).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        payload: expect.objectContaining({
          clientId: newClient.id,
          brokerId: broker.id,
          category: "AMO_UNAVAILABLE",
          scenario: "REFIX_AFTER_CLOSED",
        }),
      }),
    );
  });

  it("keeps ordinary manager notifications while routing a sanitized copy to ops", async () => {
    prisma.broker.findMany.mockResolvedValue([
      { id: "manager-1" },
      { id: "coordinator-1" },
    ]);
    const rawError =
      "amoCRM 401 Unauthorized for Ivan +79998887766; secret=TOP-SECRET";

    await (service as any).notifyAmoSyncFailed(
      "client-normal-failure",
      "broker-normal-failure",
      rawError,
      "NEW_CLIENT",
    );

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(1);
    const opsText = opsAlerts.sendSafely.mock.calls[0][0] as string;
    const managerTexts = queue.add.mock.calls.map((call: any[]) =>
      String(call[1].body),
    );
    for (const text of [opsText, ...managerTexts]) {
      expect(text).toContain("clientId: client-normal-failure");
      expect(text).toContain("brokerId: broker-normal-failure");
      expect(text).toContain("category: AMO_AUTH_ERROR");
      expect(text).not.toContain("Ivan");
      expect(text).not.toContain("+79998887766");
      expect(text).not.toContain("TOP-SECRET");
      expect(text).not.toContain(rawError);
    }
  });

  it("alerts ops when Morekit rejects an already-created amo fixation", async () => {
    await (service as any).notifyMorekitFailed(
      "client-morekit-failed",
      "broker-morekit-failed",
      123456,
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "MOREKIT_DELIVERY_FAILED",
        entity: "Client",
        entityId: "client-morekit-failed",
      }),
    });
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("clientId: client-morekit-failed"),
      expect.objectContaining({ dedupKey: "fixation-morekit:client-morekit-failed" }),
    );
    expect(opsAlerts.sendSafely.mock.calls[0][0]).toContain("amoLeadId: 123456");
  });
});
