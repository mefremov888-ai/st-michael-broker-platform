import { ClientFixationService } from "./client-fixation.service";

describe("ClientFixationService amo broker attachment", () => {
  let prisma: any;
  let amo: any;
  let queue: any;
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
    service = new ClientFixationService(prisma, amo, queue);
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
});
