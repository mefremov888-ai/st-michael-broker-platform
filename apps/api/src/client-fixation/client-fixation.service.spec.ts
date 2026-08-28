import { ClientFixationService } from "./client-fixation.service";
import {
  AMO_CREATE_IN_PROGRESS_MARKER,
  AMO_CREATE_RECONCILIATION_REQUIRED_MARKER,
  AMO_RETRY_MAX_ATTEMPTS,
} from "../common/amo-sync-retry";

describe("ClientFixationService amo broker attachment", () => {
  process.env.BROKER_CONTACT_GATE_HMAC_KEY =
    "test-explicit-broker-contact-gate-key-32-bytes";
  let prisma: any;
  let amo: any;
  let queue: any;
  let opsAlerts: any;
  let service: ClientFixationService;
  let consoleError: jest.SpyInstance;
  let assertAmoCreateLeaseOwned: jest.Mock;

  beforeEach(() => {
    prisma = {
      broker: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      brokerAgency: { create: jest.fn().mockResolvedValue({}) },
      agency: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      client: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockImplementation(async (strings: any) => {
        const sql = Array.from(strings || []).join("");
        return sql.includes('FROM "clients"')
          ? []
          : [{ id: "locked-broker" }];
      }),
    };
    prisma.$transaction = jest.fn(async (callback: any, _options?: any) =>
      callback(prisma),
    );
    amo = {
      findContactByPhone: jest.fn(),
      updateContact: jest.fn().mockResolvedValue(undefined),
      promoteContactToBroker: jest.fn().mockResolvedValue(undefined),
      createContact: jest.fn(),
      checkUniqueness: jest.fn(),
      createFixationRequest: jest.fn(),
      createBrokerLeadFromLanding: jest.fn(),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    service = new ClientFixationService(prisma, amo, queue, opsAlerts);
    assertAmoCreateLeaseOwned = jest.fn().mockResolvedValue(undefined);
    consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    delete process.env.MOREKIT_WEBHOOK_URL;
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("fails closed before lead creation when exact amo contacts are ambiguous", async () => {
    const broker = {
      id: "broker-ambiguous-client-contact",
      fullName: "Broker",
      phone: "+79990000151",
      email: null,
      amoContactId: BigInt(8151),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-ambiguous-client-contact",
      name: "Agency",
      inn: "7766666666",
    };
    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    (service as any).ensureBrokerAmoContact = jest
      .fn()
      .mockResolvedValue(broker);
    amo.checkUniqueness.mockRejectedValue(
      new Error("AMBIGUOUS_EXACT_CONTACT"),
    );

    await expect(
      service.fixClient(broker.id, {
        phone: "+79991110151",
        fullName: "Client",
        project: "ZORGE9" as any,
        agencyInn: agency.inn,
      }, assertAmoCreateLeaseOwned),
    ).rejects.toMatchObject({ status: 409 });

    expect(prisma.client.create).not.toHaveBeenCalled();
    expect(amo.createFixationRequest).not.toHaveBeenCalled();
  });

  it("blocks a UI lead when a formatted same-phone dead letter is unresolved", async () => {
    const broker = {
      id: "broker-same-phone-dead-letter",
      fullName: "Broker",
      phone: "+79990000161",
      email: null,
      amoContactId: BigInt(8161),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-same-phone-dead-letter",
      name: "Agency",
      inn: "7777777777",
    };
    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockImplementation(async (strings: any) => {
      const sql = Array.from(strings || []).join("");
      return sql.includes('FROM "clients"')
        ? [{ id: "unresolved-sibling" }]
        : [{ id: "locked-broker" }];
    });
    (service as any).ensureBrokerAmoContact = jest
      .fn()
      .mockResolvedValue(broker);
    amo.checkUniqueness.mockResolvedValue({
      rule: "NO_CONFLICT",
      verdict: "UNIQUE",
      reason: "No conflict",
    });

    await expect(
      service.fixClient(broker.id, {
        phone: "+79991110161",
        fullName: "Client",
        project: "ZORGE9" as any,
        agencyInn: agency.inn,
      }, assertAmoCreateLeaseOwned),
    ).rejects.toMatchObject({ status: 409 });

    const guardCall = prisma.$queryRaw.mock.calls.find((call: any[]) =>
      Array.from(call[0] || []).join("").includes('FROM "clients"'),
    );
    expect(guardCall).toBeDefined();
    expect(Array.from(guardCall[0]).join("")).toContain(
      "right(regexp_replace",
    );
    expect(Array.from(guardCall[0]).join("")).toContain("LIMIT 1");
    expect(guardCall).toContain("9991110161");
    expect(prisma.client.create).not.toHaveBeenCalled();
    expect(amo.createFixationRequest).not.toHaveBeenCalled();
  });

  it("keeps a new-client reconciliation row and sends no POST when phone-lock ownership is lost", async () => {
    const broker = {
      id: "broker-new-lease-lost",
      fullName: "Broker",
      phone: "+79990000171",
      email: null,
      amoContactId: BigInt(8171),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-new-lease-lost",
      name: "Agency",
      inn: "7788888888",
    };
    const client = { id: "client-new-lease-lost" };
    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(null);
    prisma.client.create.mockResolvedValue(client);
    (service as any).ensureBrokerAmoContact = jest
      .fn()
      .mockResolvedValue(broker);
    amo.checkUniqueness.mockResolvedValue({
      rule: "NO_CONFLICT",
      verdict: "UNIQUE",
      reason: "No conflict",
    });
    assertAmoCreateLeaseOwned.mockRejectedValue(
      new Error("CLIENT_FIXATION_PHONE_LOCK_LOST"),
    );

    const result = await service.fixClient(
      broker.id,
      {
        phone: "+79991110171",
        fullName: "Client",
        project: "ZORGE9" as any,
        agencyInn: agency.inn,
      },
      assertAmoCreateLeaseOwned,
    );

    expect(prisma.client.create.mock.invocationCallOrder[0]).toBeLessThan(
      assertAmoCreateLeaseOwned.mock.invocationCallOrder[0],
    );
    expect(amo.createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: client.id,
        amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
      }),
      data: expect.objectContaining({
        amoSyncStatus: "FAILED",
        amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_SYNC_FAILED`,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
      }),
    });
    expect(result).toEqual(expect.objectContaining({ amoSyncStatus: "FAILED" }));
  });

  it("keeps a refix reconciliation row and sends no POST when phone-lock ownership is lost", async () => {
    const broker = {
      id: "broker-refix-lease-lost",
      fullName: "Broker",
      phone: "+79990000181",
      email: null,
      amoContactId: BigInt(8181),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-refix-lease-lost",
      name: "Agency",
      inn: "7799999999",
    };
    const existingClient = {
      id: "client-old-refix-lease-lost",
      brokerId: broker.id,
      uniquenessStatus: "CONDITIONALLY_UNIQUE",
      uniquenessExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
      amoLeadId: BigInt(9181),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      deals: [],
      broker,
    };
    const newClient = { id: "client-new-refix-lease-lost" };
    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(existingClient);
    prisma.client.create.mockResolvedValue(newClient);
    (service as any).ensureBrokerAmoContact = jest
      .fn()
      .mockResolvedValue(broker);
    amo.checkUniqueness.mockResolvedValue({
      rule: "RULE_3",
      verdict: "UNIQUE",
      reason: "Previous lead closed",
      leads: [{ id: 9181, pipeline_id: 7600542, status_id: 143 }],
    });
    assertAmoCreateLeaseOwned.mockRejectedValue(
      new Error("CLIENT_FIXATION_PHONE_LOCK_LOST"),
    );

    const result = await service.fixClient(
      broker.id,
      {
        phone: "+79991110181",
        fullName: "Client",
        project: "ZORGE9" as any,
        agencyInn: agency.inn,
      },
      assertAmoCreateLeaseOwned,
    );

    expect(prisma.client.create.mock.invocationCallOrder[0]).toBeLessThan(
      assertAmoCreateLeaseOwned.mock.invocationCallOrder[0],
    );
    expect(amo.createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: newClient.id,
        amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
      }),
      data: expect.objectContaining({
        amoSyncStatus: "FAILED",
        amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_SYNC_FAILED`,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
      }),
    });
    expect(result).toEqual(expect.objectContaining({ amoSyncStatus: "FAILED" }));
  });

  it("blocks a UI POST when a local same-phone lead is absent from a stale amo verdict", async () => {
    const broker = {
      id: "broker-stale-linked-phone",
      fullName: "Broker",
      phone: "+79990000191",
      email: null,
      amoContactId: BigInt(8191),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-stale-linked-phone",
      name: "Agency",
      inn: "7711111111",
    };
    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(null);
    prisma.client.create.mockResolvedValue({ id: "client-stale-linked-phone" });
    (service as any).ensureBrokerAmoContact = jest
      .fn()
      .mockResolvedValue(broker);
    amo.checkUniqueness.mockResolvedValue({
      rule: "RULE_3",
      verdict: "UNIQUE",
      reason: "Only the historical closed lead is visible",
      leads: [{ id: 9190, pipeline_id: 7600542, status_id: 143 }],
    });
    let phoneStateQueries = 0;
    prisma.$queryRaw.mockImplementation(async (strings: any) => {
      const sql = Array.from(strings || []).join("");
      if (!sql.includes('FROM "clients"')) return [{ id: "locked-broker" }];
      phoneStateQueries += 1;
      return phoneStateQueries === 1 ? [] : [{ id: "newly-linked-sibling" }];
    });

    await expect(
      service.fixClient(
        broker.id,
        {
          phone: "+79991110191",
          fullName: "Client",
          project: "ZORGE9" as any,
          agencyInn: agency.inn,
        },
        assertAmoCreateLeaseOwned,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(prisma.client.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
      }),
    });
    expect(assertAmoCreateLeaseOwned).not.toHaveBeenCalled();
    expect(amo.createFixationRequest).not.toHaveBeenCalled();
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
    amo.findContactByPhone.mockResolvedValue({
      id: 777,
      custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
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
    }, assertAmoCreateLeaseOwned);

    expect(amo.findContactByPhone).toHaveBeenCalledWith(responsible.phone, {
      strict: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(String(prisma.$queryRaw.mock.calls[0][0][0])).toContain(
      "pg_advisory_xact_lock",
    );
    expect(Array.from(prisma.$queryRaw.mock.calls[1][0]).join("")).toContain(
      "FOR UPDATE",
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      amo.findContactByPhone.mock.invocationCallOrder[0],
    );
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: {
        id: "responsible",
        amoContactId: null,
        mergedIntoId: null,
      },
      data: { amoContactId: BigInt(777) },
    });
    expect(amo.createFixationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerPhone: responsible.phone,
        brokerAmoContactId: 777,
      }),
    );
  });

  it("creates the lead with the stored broker contact id when live amo contact sync fails", async () => {
    const broker = {
      id: "broker-contact-unavailable-new",
      fullName: "Broker",
      phone: "+79990000131",
      email: null,
      amoContactId: BigInt(8131),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-contact-unavailable-new",
      name: "Agency",
      inn: "7744444444",
    };
    const client = { id: "client-contact-unavailable-new" };
    const rawResolutionError =
      "amoCRM 503 broker contact lookup failed secret=DO-NOT-LOG";

    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(null);
    prisma.client.create.mockResolvedValue(client);
    amo.checkUniqueness.mockResolvedValue({
      rule: "NO_CONFLICT",
      verdict: "UNIQUE",
      reason: "No conflict",
    });
    amo.createFixationRequest.mockResolvedValue({ id: 33131 });
    (service as any).ensureBrokerAmoContact = jest
      .fn()
      .mockRejectedValue(new Error(rawResolutionError));

    const result = await service.fixClient(broker.id, {
      phone: "+79991110131",
      fullName: "Client",
      project: "ZORGE9" as any,
      agencyInn: agency.inn,
    }, assertAmoCreateLeaseOwned);

    expect(amo.createFixationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerPhone: broker.phone,
        brokerAmoContactId: 8131,
      }),
    );
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: {
        id: client.id,
        amoLeadId: null,
        amoSyncStatus: "FAILED",
        amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
      },
      data: expect.objectContaining({
        amoSyncStatus: "SYNCED",
        amoSyncError: null,
        amoLeadId: BigInt(33131),
      }),
    });
    expect(result).toEqual(
      expect.objectContaining({
        client,
        amoSyncStatus: "SYNCED",
      }),
    );
    const loggedText = consoleError.mock.calls.flat().join(" ");
    expect(loggedText).toContain("creating the lead with the stored contact id");
    expect(loggedText).not.toContain(rawResolutionError);
    expect(loggedText).not.toContain("DO-NOT-LOG");
  });

  it("queues a new fixation as PENDING when the responsible broker has no amo contact id", async () => {
    const broker = {
      id: "broker-contact-missing-new",
      fullName: "Broker",
      phone: "+79990000132",
      email: null,
      amoContactId: null,
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-contact-missing-new",
      name: "Agency",
      inn: "7744444445",
    };
    const client = { id: "client-contact-missing-new" };

    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(null);
    prisma.client.create.mockResolvedValue(client);
    amo.checkUniqueness.mockResolvedValue({
      rule: "NO_CONFLICT",
      verdict: "UNIQUE",
      reason: "No conflict",
    });
    (service as any).ensureBrokerAmoContact = jest
      .fn()
      .mockRejectedValue(new Error("BROKER_AMO_CONTACT_MISSING"));

    const result = await service.fixClient(
      broker.id,
      {
        phone: "+79991110132",
        fullName: "Client",
        project: "ZORGE9" as any,
        agencyInn: agency.inn,
      },
      assertAmoCreateLeaseOwned,
    );

    expect(amo.createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: {
        id: client.id,
        amoLeadId: null,
        amoSyncStatus: "FAILED",
        amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
      },
      data: expect.objectContaining({
        amoSyncStatus: "PENDING",
        amoSyncError: "BROKER_AMO_CONTACT_MISSING",
        amoSyncAttempts: 0,
      }),
    });
    expect(result).toEqual(
      expect.objectContaining({
        client,
        amoSyncStatus: "PENDING",
      }),
    );
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
  });

  it("durably blocks automatic retry when a new-client amo create response is ambiguous", async () => {
    const broker = {
      id: "broker-new-ambiguous",
      fullName: "Broker",
      phone: "+79990000101",
      email: null,
      amoContactId: BigInt(8101),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-new-ambiguous",
      name: "Agency",
      inn: "7711111111",
    };
    const client = { id: "client-new-ambiguous" };
    const manager = {
      id: "manager-1",
      fullName: "Manager",
      phone: "+79990000102",
      telegramUsername: null,
    };

    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.broker.findMany.mockResolvedValue([manager]);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(null);
    prisma.client.create.mockResolvedValue(client);
    amo.checkUniqueness.mockResolvedValue({
      rule: "NO_CONFLICT",
      verdict: "UNIQUE",
      reason: "No conflict",
    });
    amo.createFixationRequest.mockRejectedValue(
      new Error("fetch timeout after POST /leads"),
    );

    const result = await service.fixClient(broker.id, {
      phone: "+79991110001",
      fullName: "Client",
      project: "ZORGE9" as any,
      agencyInn: agency.inn,
    }, assertAmoCreateLeaseOwned);

    const syncUpdate = prisma.client.updateMany.mock.calls.find(
      ([args]: any[]) => args.where.id === client.id && args.data.amoSyncStatus,
    )?.[0];
    expect(syncUpdate).toEqual({
      where: {
        id: client.id,
        amoLeadId: null,
        amoSyncStatus: "FAILED",
        amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
      },
      data: expect.objectContaining({
        amoSyncStatus: "FAILED",
        amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_NETWORK_ERROR`,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
        amoSyncLastAttemptAt: expect.any(Date),
      }),
    });
    expect(result).toEqual(
      expect.objectContaining({
        client,
        amoSyncStatus: "FAILED",
        message: expect.stringContaining(
          "результат передачи в amoCRM не подтверждён",
        ),
        managerContacts: [
          expect.objectContaining({
            fullName: manager.fullName,
            phone: manager.phone,
          }),
        ],
      }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining("Automatic retry is blocked"),
      expect.any(Object),
    );
    expect(opsAlerts.sendSafely.mock.calls[0][0]).toContain(
      "amoCRM fixation result is ambiguous",
    );
    const managerBody = String(queue.add.mock.calls[0][1].body);
    expect(managerBody).toContain(
      "Результат передачи фиксации в amoCRM не подтверждён",
    );
    expect(managerBody).not.toContain("Фиксация не передана в amoCRM");
  });

  it.each(["throws", "CAS misses"])(
    "keeps the pre-POST marker when final new-client linkage persistence %s",
    async (failureMode) => {
      const broker = {
        id: "broker-new-link-failure",
        fullName: "Broker",
        phone: "+79990000111",
        email: null,
        amoContactId: BigInt(8111),
        funnelStage: "FIXATION",
        brokerAgencies: [],
      };
      const agency = {
        id: "agency-new-link-failure",
        name: "Agency",
        inn: "7722222222",
      };
      const client = { id: "client-new-link-failure" };
      prisma.broker.findUnique.mockResolvedValue(broker);
      prisma.broker.findMany.mockResolvedValue([
        {
          id: "manager-1",
          fullName: "Manager",
          phone: "+79990000112",
          telegramUsername: null,
        },
      ]);
      prisma.agency.findUnique.mockResolvedValue(agency);
      prisma.client.findFirst.mockResolvedValue(null);
      prisma.client.create.mockResolvedValue(client);
      if (failureMode === "throws") {
        prisma.client.updateMany.mockRejectedValueOnce(
          new Error("database unavailable"),
        );
      } else {
        prisma.client.updateMany.mockResolvedValueOnce({ count: 0 });
      }
      amo.checkUniqueness.mockResolvedValue({
        rule: "NO_CONFLICT",
        verdict: "UNIQUE",
        reason: "No conflict",
      });
      amo.createFixationRequest.mockResolvedValue({ id: 9101 });

      const result = await service.fixClient(broker.id, {
        phone: "+79991110011",
        fullName: "Client",
        project: "ZORGE9" as any,
        agencyInn: agency.inn,
      }, assertAmoCreateLeaseOwned);

      expect(prisma.client.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amoSyncStatus: "FAILED",
          amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
          amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
        }),
      });
      expect(prisma.client.create.mock.invocationCallOrder[0]).toBeLessThan(
        amo.createFixationRequest.mock.invocationCallOrder[0],
      );
      expect(result).toEqual(
        expect.objectContaining({
          amoSyncStatus: "FAILED",
          message: expect.stringContaining(
            "результат передачи в amoCRM не подтверждён",
          ),
          managerContacts: expect.any(Array),
        }),
      );
      expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
        expect.stringContaining("amoCRM fixation result is ambiguous"),
        expect.any(Object),
      );
    },
  );

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
    amo.findContactByPhone.mockResolvedValue({
      id: 778,
      custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
      name: existing.fullName,
    });

    const result = await service.createBrokerByCreator("creator", {
      fullName: existing.fullName,
      phone: existing.phone,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result).toEqual({ broker: existing, created: false });
    expect(amo.findContactByPhone).toHaveBeenCalledWith(existing.phone, {
      strict: true,
    });
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: {
        id: "existing",
        amoContactId: null,
        mergedIntoId: null,
      },
      data: { amoContactId: BigInt(778) },
    });
    expect(prisma.broker.create).not.toHaveBeenCalled();
  });

  it("promotes one exact unflagged contact before linking the broker", async () => {
    const broker = {
      id: "promote-unflagged",
      fullName: "Promote Broker",
      phone: "+79990000007",
      email: null,
      amoContactId: null,
      mergedIntoId: null,
      brokerAgencies: [],
    };
    prisma.broker.findUnique.mockResolvedValue(broker);
    amo.findContactByPhone
      .mockResolvedValueOnce({
        id: 781,
        custom_fields_values: [
          { field_id: 835415, values: [{ value: false }] },
        ],
      })
      .mockResolvedValueOnce({
        id: 781,
        custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
      });

    await expect(
      (service as any).ensureBrokerAmoContact(broker.id),
    ).resolves.toEqual(expect.objectContaining({ amoContactId: BigInt(781) }));

    expect(amo.createContact).not.toHaveBeenCalled();
    expect(amo.updateContact).not.toHaveBeenCalled();
    expect(amo.promoteContactToBroker).toHaveBeenCalledTimes(1);
    expect(amo.promoteContactToBroker).toHaveBeenCalledWith(781);
    expect(amo.findContactByPhone).toHaveBeenCalledTimes(2);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: {
        id: broker.id,
        amoContactId: null,
        mergedIntoId: null,
      },
      data: { amoContactId: BigInt(781) },
    });
    expect(
      prisma.broker.updateMany.mock.invocationCallOrder[0],
    ).toBeGreaterThan(amo.findContactByPhone.mock.invocationCallOrder[1]);
  });

  it("does not let the broker-lead helper perform a second unlocked contact create fallback", async () => {
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
    amo.findContactByPhone.mockResolvedValue(null);
    amo.createContact.mockRejectedValue(
      new Error("amoCRM 400 /contacts: custom field rejected"),
    );
    await expect(
      service.createBrokerByCreator("creator", {
        fullName: created.fullName,
        phone: created.phone,
      }),
    ).rejects.toThrow("Не удалось создать контакт брокера в amoCRM");

    expect(amo.createBrokerLeadFromLanding).not.toHaveBeenCalled();
    expect(prisma.broker.update).not.toHaveBeenCalled();
    expect(prisma.broker.updateMany).not.toHaveBeenCalled();
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
    amo.findContactByPhone.mockRejectedValue(new Error("amoCRM 401"));

    await expect(
      (service as any).ensureBrokerAmoContact("new-broker"),
    ).rejects.toThrow("amoCRM 401");

    expect(amo.createContact).not.toHaveBeenCalled();
    expect(prisma.broker.update).not.toHaveBeenCalled();
    expect(prisma.broker.updateMany).not.toHaveBeenCalled();
  });

  it("resolves a lost broker-contact POST only by strict GET and never posts twice", async () => {
    const broker = {
      id: "lost-broker-contact-response",
      fullName: "Lost Response Broker",
      phone: "+79990000006",
      email: null,
      amoContactId: null,
      mergedIntoId: null,
      brokerAgencies: [],
    };
    prisma.broker.findUnique.mockResolvedValue(broker);
    amo.findContactByPhone.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 780,
      custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
    });
    amo.createContact.mockRejectedValue(new Error("lost response"));

    await expect(
      (service as any).ensureBrokerAmoContact(broker.id),
    ).resolves.toEqual(expect.objectContaining({ amoContactId: BigInt(780) }));

    expect(amo.createContact).toHaveBeenCalledTimes(1);
    expect(amo.findContactByPhone).toHaveBeenCalledTimes(2);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: {
        id: broker.id,
        amoContactId: null,
        mergedIntoId: null,
      },
      data: { amoContactId: BigInt(780) },
    });
  });

  it("fails closed without a local fallback when uniqueness lookup is unavailable", async () => {
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
    const rawError =
      "amoCRM 503 socket reset; diagnostic=TOP-SECRET; Ivan +79991112233";

    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    (service as any).ensureBrokerAmoContact = jest
      .fn()
      .mockResolvedValue(broker);
    amo.checkUniqueness.mockRejectedValue(new Error(rawError));

    await expect(
      service.fixClient(broker.id, {
        phone: "+79991112233",
        fullName: "Sensitive Client Name",
        project: "ZORGE9" as any,
        agencyInn: agency.inn,
      }, assertAmoCreateLeaseOwned),
    ).rejects.toMatchObject({ status: 503 });

    expect(prisma.client.create).not.toHaveBeenCalled();
    expect(amo.createFixationRequest).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    const loggedText = consoleError.mock.calls.flat().join(" ");
    expect(loggedText).toContain("AMO_TEMPORARY_UNAVAILABLE");
    expect(loggedText).not.toContain("TOP-SECRET");
    expect(loggedText).not.toContain(rawError);
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
      leads: [{ id: 8801, pipeline_id: 7600550, status_id: 62907430 }],
    });
    amo.createFixationRequest.mockResolvedValue({ id: 9901 });

    const result = await service.fixClient(broker.id, {
      phone: "+79991112255",
      fullName: "Client",
      project: "ZORGE9" as any,
      agencyInn: agency.inn,
    }, assertAmoCreateLeaseOwned);

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
      leads: [],
    });
    amo.createFixationRequest.mockRejectedValue(new Error(rawError));

    const result = await service.fixClient(broker.id, {
      phone: "+79991112244",
      fullName: "Closed Refix Client",
      project: "ZORGE9" as any,
      agencyInn: agency.inn,
    }, assertAmoCreateLeaseOwned);

    expect(result).toEqual(
      expect.objectContaining({
        client: newClient,
        amoSyncStatus: "FAILED",
      }),
    );
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: {
        id: newClient.id,
        amoLeadId: null,
        amoSyncStatus: "FAILED",
        amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
      },
      data: expect.objectContaining({
        amoSyncStatus: "FAILED",
        amoSyncError: `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}AMO_TEMPORARY_UNAVAILABLE`,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
      }),
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
    expect(opsAlerts.sendSafely.mock.calls[0][0]).toContain(
      "Automatic retry is blocked",
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

  it("creates a refix lead with the stored broker contact id when live amo contact sync fails", async () => {
    const broker = {
      id: "broker-contact-unavailable-refix",
      fullName: "Broker",
      phone: "+79990000141",
      email: null,
      amoContactId: BigInt(8141),
      funnelStage: "FIXATION",
      brokerAgencies: [],
    };
    const agency = {
      id: "agency-contact-unavailable-refix",
      name: "Agency",
      inn: "7755555555",
    };
    const existingClient = {
      id: "client-contact-unavailable-closed",
      brokerId: broker.id,
      uniquenessStatus: "EXPIRED",
      uniquenessExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
      amoLeadId: BigInt(9941),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      deals: [],
      broker,
    };
    const newClient = { id: "client-contact-unavailable-refix" };

    prisma.broker.findUnique.mockResolvedValue(broker);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.client.findFirst.mockResolvedValue(existingClient);
    prisma.client.create.mockResolvedValue(newClient);
    amo.checkUniqueness.mockResolvedValue({
      rule: "RULE_3",
      verdict: "UNIQUE",
      reason: "Previous lead is closed",
      leads: [],
    });
    amo.createFixationRequest.mockResolvedValue({ id: 33141 });
    (service as any).ensureBrokerAmoContact = jest
      .fn()
      .mockRejectedValue(new Error("broker contact lookup unavailable"));

    const result = await service.fixClient(broker.id, {
      phone: "+79991110141",
      fullName: "Client",
      project: "ZORGE9" as any,
      agencyInn: agency.inn,
    }, assertAmoCreateLeaseOwned);

    expect(amo.createFixationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerAmoContactId: 8141,
      }),
    );
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: {
        id: newClient.id,
        amoLeadId: null,
        amoSyncStatus: "FAILED",
        amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
        amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
      },
      data: expect.objectContaining({
        amoSyncStatus: "SYNCED",
        amoLeadId: BigInt(33141),
      }),
    });
    expect(result).toEqual(
      expect.objectContaining({
        client: newClient,
        amoSyncStatus: "SYNCED",
      }),
    );
  });

  it.each(["throws", "CAS misses"])(
    "keeps the pre-POST marker when final refix linkage persistence %s",
    async (failureMode) => {
      const broker = {
        id: "broker-refix-link-failure",
        fullName: "Broker",
        phone: "+79990000121",
        email: null,
        amoContactId: BigInt(8121),
        funnelStage: "FIXATION",
        brokerAgencies: [],
      };
      const agency = {
        id: "agency-refix-link-failure",
        name: "Agency",
        inn: "7733333333",
      };
      const existingClient = {
        id: "client-refix-closed-link-failure",
        brokerId: broker.id,
        uniquenessStatus: "EXPIRED",
        uniquenessExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
        amoLeadId: BigInt(9921),
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        deals: [],
        broker,
      };
      const newClient = { id: "client-refix-link-failure" };
      prisma.broker.findUnique.mockResolvedValue(broker);
      prisma.broker.findMany.mockResolvedValue([
        {
          id: "manager-1",
          fullName: "Manager",
          phone: "+79990000122",
          telegramUsername: null,
        },
      ]);
      prisma.agency.findUnique.mockResolvedValue(agency);
      prisma.client.findFirst.mockResolvedValue(existingClient);
      prisma.client.create.mockResolvedValue(newClient);
      if (failureMode === "throws") {
        prisma.client.updateMany.mockRejectedValueOnce(
          new Error("database unavailable"),
        );
      } else {
        prisma.client.updateMany.mockResolvedValueOnce({ count: 0 });
      }
      amo.checkUniqueness.mockResolvedValue({
        rule: "RULE_3",
        verdict: "UNIQUE",
        reason: "Previous lead is closed",
        leads: [],
      });
      amo.createFixationRequest.mockResolvedValue({ id: 9102 });

      const result = await service.fixClient(broker.id, {
        phone: "+79991110021",
        fullName: "Client",
        project: "ZORGE9" as any,
        agencyInn: agency.inn,
      }, assertAmoCreateLeaseOwned);

      expect(prisma.client.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amoSyncStatus: "FAILED",
          amoSyncError: AMO_CREATE_IN_PROGRESS_MARKER,
          amoSyncAttempts: AMO_RETRY_MAX_ATTEMPTS,
        }),
      });
      expect(prisma.client.create.mock.invocationCallOrder[0]).toBeLessThan(
        amo.createFixationRequest.mock.invocationCallOrder[0],
      );
      expect(result).toEqual(
        expect.objectContaining({
          amoSyncStatus: "FAILED",
          message: expect.stringContaining(
            "результат передачи в amoCRM не подтверждён",
          ),
          managerContacts: expect.any(Array),
        }),
      );
      expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
        expect.stringContaining("amoCRM fixation result is ambiguous"),
        expect.any(Object),
      );
    },
  );

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
      expect.objectContaining({
        dedupKey: "fixation-morekit:client-morekit-failed",
      }),
    );
    expect(opsAlerts.sendSafely.mock.calls[0][0]).toContain(
      "amoLeadId: 123456",
    );
  });
});
