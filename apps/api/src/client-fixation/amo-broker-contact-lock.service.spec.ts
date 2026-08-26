import { AuthService } from "../auth/auth.service";
import { CmsService } from "../cms/cms.service";
import { AmoCrmAdapter as SourceAmoCrmAdapter } from "../../../../packages/integrations/src/amo-crm.adapter";
import {
  AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
  amoBrokerContactAdvisoryLockKey,
  amoBrokerContactGateDigest,
  getUnresolvedAmoBrokerContactCreateGate,
  reconcileExactAmoBrokerContact,
} from "../common/amo-broker-contact-lock";

describe("shared amo broker-contact advisory lock", () => {
  process.env.BROKER_CONTACT_GATE_HMAC_KEY =
    "test-explicit-broker-contact-gate-key-32-bytes";
  function transactionPrisma(overrides: Record<string, any> = {}) {
    const prisma: any = {
      broker: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "locked-broker" }]),
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      ...overrides,
    };
    prisma.$transaction = jest.fn(async (callback: any, _options?: any) =>
      callback(prisma),
    );
    return prisma;
  }

  it("pairs gate resolutions by gateId regardless of event order or timestamps", async () => {
    const gateA = "11111111-1111-4111-8111-111111111111";
    const gateB = "22222222-2222-4222-8222-222222222222";
    const phone = "+79990000020";
    const event = (action: string, gateId: string) => ({
      action,
      payload: { gateVersion: 1, gateId },
      createdAt: new Date(0),
    });
    const database = {
      auditLog: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            event("AMO_BROKER_CONTACT_CREATE_RESOLVED", gateA),
            event("AMO_BROKER_CONTACT_CREATE_UNCERTAIN", gateB),
            event("AMO_BROKER_CONTACT_CREATE_UNCERTAIN", gateA),
          ]),
      },
    };
    await expect(
      getUnresolvedAmoBrokerContactCreateGate(database, phone),
    ).resolves.toBe(gateB);
  });

  function authHarness() {
    const fullBroker = {
      id: "auth-broker",
      fullName: "Auth Broker",
      phone: "+79990000021",
      email: null,
      amoContactId: null,
      mergedIntoId: null,
      brokerAgencies: [],
    };
    const prisma = transactionPrisma();
    prisma.broker.findUnique
      .mockResolvedValueOnce({ id: fullBroker.id, phone: fullBroker.phone })
      .mockResolvedValueOnce(fullBroker);
    const service = new AuthService(
      prisma,
      { sign: jest.fn(), verify: jest.fn() } as any,
      { add: jest.fn() } as any,
      { syncFromFeed: jest.fn() } as any,
    );
    const amo = {
      findContactByPhone: jest.fn(),
      createContact: jest.fn(),
      updateContact: jest.fn(),
      promoteContactToBroker: jest.fn(),
    };
    (service as any).amo = amo;
    return { service, prisma, amo, fullBroker };
  }

  it("serializes AuthService find -> one POST -> CAS under the shared lock", async () => {
    const { service, prisma, amo, fullBroker } = authHarness();
    amo.findContactByPhone.mockResolvedValueOnce(null).mockResolvedValue({
      id: 2101,
      custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
    });
    amo.createContact.mockResolvedValue({ id: 2101 });

    await expect(service.syncBrokerProfileToAmo(fullBroker.id)).resolves.toBe(
      undefined,
    );

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(String(prisma.$queryRaw.mock.calls[0][0][0])).toContain(
      "pg_advisory_xact_lock",
    );
    expect(Array.from(prisma.$queryRaw.mock.calls[1][0]).join("")).toContain(
      "FOR UPDATE",
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      amo.findContactByPhone.mock.invocationCallOrder[0],
    );
    expect(amo.findContactByPhone).toHaveBeenCalledWith(fullBroker.phone, {
      strict: true,
    });
    expect(amo.createContact).toHaveBeenCalledTimes(1);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: {
        id: fullBroker.id,
        amoContactId: null,
        mergedIntoId: null,
      },
      data: { amoContactId: BigInt(2101) },
    });
  });

  it("AuthService resolves a lost POST only by strict GET and never posts twice", async () => {
    const { service, prisma, amo, fullBroker } = authHarness();
    amo.findContactByPhone.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 2102,
      custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
    });
    amo.createContact.mockRejectedValue(new Error("lost response"));

    await service.syncBrokerProfileToAmo(fullBroker.id);

    expect(amo.createContact).toHaveBeenCalledTimes(1);
    expect(amo.findContactByPhone).toHaveBeenCalledTimes(2);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { amoContactId: BigInt(2102) } }),
    );
  });

  it("recovers crash-after-link by exact GET, sends zero POSTs and resolves the observed gate", async () => {
    const { service, prisma, amo, fullBroker } = authHarness();
    const gateId = "33333333-3333-4333-8333-333333333333";
    fullBroker.amoContactId = BigInt(2199);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        action: AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
        payload: { gateVersion: 1, gateId },
      },
    ]);
    amo.findContactByPhone.mockResolvedValue({
      id: 2199,
      custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
    });
    amo.updateContact.mockResolvedValue(undefined);

    await service.syncBrokerProfileToAmo(fullBroker.id);

    expect(amo.createContact).not.toHaveBeenCalled();
    expect(amo.findContactByPhone).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AMO_BROKER_CONTACT_CREATE_RESOLVED",
        payload: expect.objectContaining({ gateId }),
      }),
    });
  });

  it("leaves an observed gate open when the only exact contact is unflagged", async () => {
    const { service, prisma, amo, fullBroker } = authHarness();
    const gateId = "44444444-4444-4444-8444-444444444444";
    prisma.auditLog.findMany.mockResolvedValue([
      {
        action: AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
        payload: { gateVersion: 1, gateId },
      },
    ]);
    amo.findContactByPhone.mockResolvedValue({
      id: 2200,
      custom_fields_values: [{ field_id: 835415, values: [{ value: false }] }],
    });

    await expect(service.syncBrokerProfileToAmo(fullBroker.id)).rejects.toThrow(
      "AMO_BROKER_CONTACT_GATE_NOT_CONFIRMED",
    );
    expect(amo.createContact).not.toHaveBeenCalled();
    expect(amo.promoteContactToBroker).not.toHaveBeenCalled();
    expect(prisma.broker.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "AMO_BROKER_CONTACT_CREATE_RESOLVED",
        }),
      }),
    );
  });

  it("AuthService promotes one exact unflagged contact and reconciles before CAS", async () => {
    const { service, prisma, amo, fullBroker } = authHarness();
    amo.findContactByPhone
      .mockResolvedValueOnce({
        id: 2103,
        custom_fields_values: [
          { field_id: 835415, values: [{ value: false }] },
        ],
      })
      .mockResolvedValueOnce({
        id: 2103,
        custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
      });
    amo.promoteContactToBroker.mockResolvedValue(undefined);

    await service.syncBrokerProfileToAmo(fullBroker.id);

    expect(amo.createContact).not.toHaveBeenCalled();
    expect(amo.updateContact).not.toHaveBeenCalled();
    expect(amo.promoteContactToBroker).toHaveBeenCalledTimes(1);
    expect(amo.promoteContactToBroker).toHaveBeenCalledWith(2103);
    expect(amo.findContactByPhone).toHaveBeenCalledTimes(2);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { amoContactId: BigInt(2103) } }),
    );
    expect(
      prisma.broker.updateMany.mock.invocationCallOrder[0],
    ).toBeGreaterThan(amo.findContactByPhone.mock.invocationCallOrder[1]);
  });

  it("durably blocks a later AuthService POST after an ambiguous create", async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma, amo, fullBroker } = authHarness();
      amo.findContactByPhone.mockResolvedValue(null);
      amo.createContact.mockRejectedValue(
        new Error("amoCRM network error /contacts"),
      );

      const pending = service.syncBrokerProfileToAmo(fullBroker.id);
      const pendingAssertion = expect(pending).rejects.toThrow(
        "AMO_BROKER_CONTACT_RECONCILIATION_REQUIRED",
      );
      await jest.runAllTimersAsync();
      await pendingAssertion;

      expect(amo.createContact).toHaveBeenCalledTimes(1);
      expect(amo.findContactByPhone).toHaveBeenCalledTimes(7);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
          entityId: amoBrokerContactGateDigest(fullBroker.phone),
        }),
      });
      expect(prisma.broker.update).not.toHaveBeenCalled();
      expect(prisma.broker.updateMany).not.toHaveBeenCalled();

      const armedEvent = prisma.auditLog.create.mock.calls.find(
        ([call]: any[]) =>
          call.data.action === AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
      )?.[0].data;
      prisma.auditLog.findMany.mockResolvedValue([armedEvent]);
      prisma.broker.findUnique.mockResolvedValue(fullBroker);
      amo.findContactByPhone.mockClear().mockResolvedValue(null);
      amo.createContact.mockClear();
      const blocked = service.syncBrokerProfileToAmo(fullBroker.id);
      await expect(blocked).rejects.toThrow(
        "AMO_BROKER_CONTACT_RECONCILIATION_REQUIRED",
      );
      expect(amo.createContact).not.toHaveBeenCalled();
      expect(amo.findContactByPhone).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("uses one normalized-phone lock key across formatting and broker identities", () => {
    expect(amoBrokerContactAdvisoryLockKey("+7 (999) 000-00-21")).toBe(
      amoBrokerContactAdvisoryLockKey("8 999 000 00 21"),
    );
  });

  it("bounded reconciliation waits for eventual exact broker visibility", async () => {
    const lookup = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 2199,
        custom_fields_values: [
          { field_id: 835415, values: [{ value: false }] },
        ],
      })
      .mockResolvedValueOnce({
        id: 2199,
        custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
      });
    const sleepImpl = jest.fn().mockResolvedValue(undefined);

    await expect(
      reconcileExactAmoBrokerContact({
        lookup,
        expectedContactId: 2199,
        sleepImpl,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 2199 }));
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it("runs the CMS new-broker contact creator under the same transaction lock", async () => {
    const created = {
      id: "cms-broker",
      fullName: "CMS Broker",
      phone: "+79990000031",
      email: null,
    };
    const prisma = transactionPrisma();
    prisma.broker.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      amoContactId: null,
      phone: created.phone,
      mergedIntoId: null,
    });
    prisma.broker.create.mockResolvedValue(created);
    const service = new CmsService(prisma);
    const amo = {
      findContactByPhone: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({
          id: 3101,
          custom_fields_values: [
            { field_id: 835415, values: [{ value: true }] },
          ],
        }),
      createContact: jest.fn().mockResolvedValue({ id: 3101 }),
      updateContact: jest.fn().mockResolvedValue(undefined),
      promoteContactToBroker: jest.fn().mockResolvedValue(undefined),
      createBrokerLeadFromLanding: jest
        .fn()
        .mockResolvedValue({ contactId: 3101, leadId: 4101 }),
    };
    (service as any).amo = amo;

    await expect(
      (service as any).upsertBrokerFromLandingLead({
        fullName: created.fullName,
        phone: created.phone,
        email: null,
        note: null,
        source: "broker-tour",
      }),
    ).resolves.toBe(created.id);

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    expect(amo.createBrokerLeadFromLanding).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerPhone: created.phone,
        existingContactId: 3101,
      }),
    );
    expect(amo.findContactByPhone).toHaveBeenCalledWith(created.phone, {
      strict: true,
    });
    expect(amo.createContact).toHaveBeenCalledTimes(1);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: {
        id: created.id,
        amoContactId: null,
        mergedIntoId: null,
      },
      data: { amoContactId: BigInt(3101) },
    });
  });

  it("CMS fails closed when the broker phone changes after lock-key capture", async () => {
    const created = {
      id: "cms-phone-drift",
      fullName: "CMS Phone Drift",
      phone: "+79990000034",
      email: null,
    };
    const prisma = transactionPrisma();
    prisma.broker.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      amoContactId: null,
      phone: "+79990000999",
      mergedIntoId: null,
    });
    prisma.broker.create.mockResolvedValue(created);
    const service = new CmsService(prisma);
    const amo = {
      findContactByPhone: jest.fn(),
      createContact: jest.fn(),
      updateContact: jest.fn(),
      promoteContactToBroker: jest.fn(),
      createBrokerLeadFromLanding: jest.fn(),
    };
    (service as any).amo = amo;
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await expect(
        (service as any).upsertBrokerFromLandingLead({
          fullName: created.fullName,
          phone: created.phone,
          email: null,
          note: null,
          source: "broker-tour",
        }),
      ).resolves.toBe(created.id);
      expect(amo.findContactByPhone).not.toHaveBeenCalled();
      expect(amo.createContact).not.toHaveBeenCalled();
      expect(amo.promoteContactToBroker).not.toHaveBeenCalled();
      expect(amo.createBrokerLeadFromLanding).not.toHaveBeenCalled();
      expect(prisma.broker.updateMany).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[upsertBrokerFromLandingLead] amo create failed:",
        "AMO_BROKER_CONTACT_LOCK_PHONE_DRIFT",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("CMS resolves a lost contact POST by strict GET and never posts twice", async () => {
    const created = {
      id: "cms-lost-response",
      fullName: "CMS Broker",
      phone: "+79990000032",
      email: null,
    };
    const prisma = transactionPrisma();
    prisma.broker.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      amoContactId: null,
      phone: created.phone,
      mergedIntoId: null,
    });
    prisma.broker.create.mockResolvedValue(created);
    const service = new CmsService(prisma);
    const amo = {
      findContactByPhone: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 3102,
          custom_fields_values: [
            { field_id: 835415, values: [{ value: true }] },
          ],
        }),
      createContact: jest.fn().mockRejectedValue(new Error("lost response")),
      updateContact: jest.fn().mockResolvedValue(undefined),
      promoteContactToBroker: jest.fn().mockResolvedValue(undefined),
      createBrokerLeadFromLanding: jest
        .fn()
        .mockResolvedValue({ contactId: 3102, leadId: 4102 }),
    };
    (service as any).amo = amo;

    await (service as any).upsertBrokerFromLandingLead({
      fullName: created.fullName,
      phone: created.phone,
      email: null,
      note: null,
      source: "broker-tour",
    });

    expect(amo.createContact).toHaveBeenCalledTimes(1);
    expect(amo.findContactByPhone).toHaveBeenCalledTimes(2);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { amoContactId: BigInt(3102) } }),
    );
    expect(amo.createBrokerLeadFromLanding).toHaveBeenCalledWith(
      expect.objectContaining({ existingContactId: 3102 }),
    );
  });

  it("CMS promotes one exact unflagged contact before linking or creating a lead", async () => {
    const created = {
      id: "cms-promote",
      fullName: "CMS Promote Broker",
      phone: "+79990000033",
      email: null,
    };
    const prisma = transactionPrisma();
    prisma.broker.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      amoContactId: null,
      phone: created.phone,
      mergedIntoId: null,
    });
    prisma.broker.create.mockResolvedValue(created);
    const service = new CmsService(prisma);
    const amo = {
      findContactByPhone: jest
        .fn()
        .mockResolvedValueOnce({
          id: 3103,
          custom_fields_values: [
            { field_id: 835415, values: [{ value: false }] },
          ],
        })
        .mockResolvedValueOnce({
          id: 3103,
          custom_fields_values: [
            { field_id: 835415, values: [{ value: true }] },
          ],
        }),
      createContact: jest.fn(),
      updateContact: jest.fn().mockResolvedValue(undefined),
      promoteContactToBroker: jest.fn().mockResolvedValue(undefined),
      createBrokerLeadFromLanding: jest
        .fn()
        .mockResolvedValue({ contactId: 3103, leadId: 4103 }),
    };
    (service as any).amo = amo;

    await (service as any).upsertBrokerFromLandingLead({
      fullName: created.fullName,
      phone: created.phone,
      email: null,
      note: null,
      source: "broker-tour",
    });

    expect(amo.createContact).not.toHaveBeenCalled();
    expect(amo.updateContact).not.toHaveBeenCalled();
    expect(amo.promoteContactToBroker).toHaveBeenCalledWith(3103);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { amoContactId: BigInt(3103) } }),
    );
    expect(amo.createBrokerLeadFromLanding).toHaveBeenCalledWith(
      expect.objectContaining({ existingContactId: 3103 }),
    );
  });

  it("makes the broker-lead helper consume an existing contact and never provision one", async () => {
    const adapter = new SourceAmoCrmAdapter() as any;
    adapter.findContactByPhone = jest.fn();
    adapter.createContact = jest.fn();
    adapter.createLead = jest.fn().mockResolvedValue({ id: 5101 });
    adapter.addNoteToLead = jest.fn().mockResolvedValue(undefined);
    adapter.createTask = jest.fn().mockResolvedValue(undefined);

    await expect(
      adapter.createBrokerLeadFromLanding({
        brokerName: "Locked Broker",
        brokerPhone: "+79990000041",
        source: "LANDING_FORM",
        existingContactId: 4101,
      }),
    ).resolves.toEqual({ contactId: 4101, leadId: 5101 });
    expect(adapter.findContactByPhone).not.toHaveBeenCalled();
    expect(adapter.createContact).not.toHaveBeenCalled();

    await expect(
      adapter.createBrokerLeadFromLanding({
        brokerName: "Unlocked Broker",
        brokerPhone: "+79990000042",
        source: "LANDING_FORM",
      }),
    ).rejects.toThrow("AMO_BROKER_CONTACT_ID_REQUIRED");
  });
});
