// 2026-10-01: заявка с лендинга от УЖЕ известного брокера — задача + заметка
// на контакте в amoCRM вместо «ничего» (решение владельца 01.10).
import { CmsService } from "./cms.service";
import {
  AmoCrmAdapter as SourceAmoCrmAdapter,
  landingFollowUpCompleteTillSec,
} from "../../../../packages/integrations/src/amo-crm.adapter";

process.env.BROKER_CONTACT_GATE_HMAC_KEY =
  "test-explicit-broker-contact-gate-key-32-bytes";

const PHONE = "+79990000777";
const EXISTING = {
  id: "known-broker",
  fullName: "Известный Брокер",
  phone: PHONE,
  email: null,
  amoContactId: BigInt(777),
  assignedManagerId: null as string | null,
  mergedIntoId: null,
};

function prismaMock(overrides: Record<string, any> = {}) {
  const prisma: any = {
    broker: {
      findUnique: jest.fn().mockResolvedValue(EXISTING),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
    },
    contactRequest: {
      create: jest.fn().mockResolvedValue({ id: "cr-new" }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    brokerAmoContactSync: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    amoUser: { findUnique: jest.fn().mockResolvedValue(null) },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ id: "locked-broker" }]),
    systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    ...overrides,
  };
  prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));
  return prisma;
}

function amoMock() {
  return {
    findContactByPhone: jest.fn(),
    findBrokerContactByPhone: jest.fn(),
    createContact: jest.fn(),
    promoteContactToBroker: jest.fn(),
    createBrokerLeadFromLanding: jest.fn(),
    createLandingFollowUpForKnownBroker: jest
      .fn()
      .mockResolvedValue({
        taskCreated: true,
        noteCreated: true,
        responsibleUserId: 123,
        completeTillSec: 0,
      }),
  };
}

function makeService(prisma: any, opsAlerts?: any) {
  const service = new CmsService(prisma, undefined, opsAlerts);
  const amo = amoMock();
  (service as any).amo = amo;
  (service as any).morekit = { notifyFixation: jest.fn() };
  return { service, amo };
}

const TOUR_INPUT = {
  fullName: "Известный Брокер",
  phone: PHONE,
  email: null,
  note: "Брокер-тур 09.10.2026 в 11:00 — Квартал Серебряный Бор",
  source: "broker-tour",
  contactRequestId: "cr-new",
};

describe("заявка с лендинга от известного брокера → amoCRM", () => {
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("брокер с amoContactId: задача + заметка на контакте, лид не создаётся", async () => {
    const prisma = prismaMock();
    prisma.brokerAmoContactSync.findUnique.mockResolvedValue({
      kcResponsibleUserId: BigInt(123),
    });
    const { service, amo } = makeService(prisma);

    await expect(
      (service as any).upsertBrokerFromLandingLead(TOUR_INPUT),
    ).resolves.toBe(EXISTING.id);

    expect(prisma.broker.update).toHaveBeenCalledWith({
      where: { id: EXISTING.id },
      data: { isInBase: true, doNotCall: false, nextCallAt: null },
    });
    expect(amo.createLandingFollowUpForKnownBroker).toHaveBeenCalledTimes(1);
    expect(amo.createLandingFollowUpForKnownBroker).toHaveBeenCalledWith({
      contactId: 777,
      brokerName: TOUR_INPUT.fullName,
      brokerPhone: PHONE,
      source: "LANDING_BROKER_TOUR",
      note: TOUR_INPUT.note,
      responsibleUserId: 123,
    });
    expect(amo.createBrokerLeadFromLanding).not.toHaveBeenCalled();
    expect(amo.findBrokerContactByPhone).not.toHaveBeenCalled();
    expect(prisma.broker.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("«перезвоним за 1 час» известному брокеру: задача со source LANDING_CALLBACK", async () => {
    const prisma = prismaMock();
    const { service, amo } = makeService(prisma);

    await (service as any).upsertBrokerFromLandingLead({
      ...TOUR_INPUT,
      note: null,
      source: "landing-callback",
    });

    expect(amo.createLandingFollowUpForKnownBroker).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 777, source: "LANDING_CALLBACK" }),
    );
    expect(amo.createBrokerLeadFromLanding).not.toHaveBeenCalled();
  });

  it("старая форма landing-contact известному брокеру: в amo ничего не шлём (как раньше)", async () => {
    const prisma = prismaMock();
    const { service, amo } = makeService(prisma);

    await (service as any).upsertBrokerFromLandingLead({
      ...TOUR_INPUT,
      source: "landing-contact",
    });

    expect(amo.createLandingFollowUpForKnownBroker).not.toHaveBeenCalled();
    expect(amo.createBrokerLeadFromLanding).not.toHaveBeenCalled();
    expect(prisma.contactRequest.findFirst).not.toHaveBeenCalled();
  });

  it("без amoContactId, контакт найден по телефону: привязка + задача; ответственный — amo-пользователь закреплённого менеджера", async () => {
    const prisma = prismaMock();
    prisma.broker.findUnique.mockResolvedValue({
      ...EXISTING,
      amoContactId: null,
      assignedManagerId: "manager-1",
    });
    prisma.amoUser.findUnique.mockResolvedValue({
      id: BigInt(321),
      isActive: true,
    });
    const { service, amo } = makeService(prisma);
    amo.findBrokerContactByPhone.mockResolvedValue({ id: 555 });

    await (service as any).upsertBrokerFromLandingLead(TOUR_INPUT);

    expect(amo.findBrokerContactByPhone).toHaveBeenCalledWith(PHONE, {
      strict: true,
    });
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: { id: EXISTING.id, amoContactId: null, mergedIntoId: null },
      data: { amoContactId: BigInt(555) },
    });
    expect(prisma.amoUser.findUnique).toHaveBeenCalledWith({
      where: { brokerId: "manager-1" },
      select: { id: true, isActive: true },
    });
    expect(amo.createLandingFollowUpForKnownBroker).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 555, responsibleUserId: 321 }),
    );
    expect(amo.createBrokerLeadFromLanding).not.toHaveBeenCalled();
  });

  it("без ответственного в базе: responsibleUserId не передаём (адаптер возьмёт env)", async () => {
    const prisma = prismaMock();
    const { service, amo } = makeService(prisma);

    await (service as any).upsertBrokerFromLandingLead(TOUR_INPUT);

    expect(amo.createLandingFollowUpForKnownBroker).toHaveBeenCalledWith(
      expect.objectContaining({ responsibleUserId: undefined }),
    );
  });

  it("контакт в amo не найден: идём путём нового брокера — контакт + лид под общим замком", async () => {
    const prisma = prismaMock();
    prisma.broker.findUnique
      .mockResolvedValueOnce({ ...EXISTING, amoContactId: null })
      .mockResolvedValueOnce({
        amoContactId: null,
        phone: PHONE,
        mergedIntoId: null,
      });
    const { service, amo } = makeService(prisma);
    amo.findBrokerContactByPhone.mockResolvedValue(null);
    amo.findContactByPhone
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 3101,
        custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
      });
    amo.createContact.mockResolvedValue({ id: 3101 });
    amo.createBrokerLeadFromLanding.mockResolvedValue({
      contactId: 3101,
      leadId: 4101,
    });

    await expect(
      (service as any).upsertBrokerFromLandingLead(TOUR_INPUT),
    ).resolves.toBe(EXISTING.id);

    expect(amo.createLandingFollowUpForKnownBroker).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    expect(amo.createContact).toHaveBeenCalledTimes(1);
    expect(prisma.broker.updateMany).toHaveBeenCalledWith({
      where: { id: EXISTING.id, amoContactId: null, mergedIntoId: null },
      data: { amoContactId: BigInt(3101) },
    });
    expect(amo.createBrokerLeadFromLanding).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerPhone: PHONE,
        existingContactId: 3101,
        source: "LANDING_BROKER_TOUR",
        pipeline: "BROKERS",
      }),
    );
    expect(prisma.broker.create).not.toHaveBeenCalled();
  });

  it("неоднозначный контакт (AMBIGUOUS): ошибка поиска не роняет заявку", async () => {
    const prisma = prismaMock();
    prisma.broker.findUnique
      .mockResolvedValueOnce({ ...EXISTING, amoContactId: null })
      .mockResolvedValueOnce({
        amoContactId: null,
        phone: PHONE,
        mergedIntoId: null,
      });
    const { service, amo } = makeService(prisma);
    amo.findBrokerContactByPhone.mockRejectedValue(
      new Error("AMBIGUOUS_BROKER_CONTACT ids=1,2"),
    );
    amo.findContactByPhone.mockRejectedValue(
      new Error("AMBIGUOUS_EXACT_CONTACT"),
    );

    await expect(
      (service as any).upsertBrokerFromLandingLead(TOUR_INPUT),
    ).resolves.toBe(EXISTING.id);
    expect(amo.createLandingFollowUpForKnownBroker).not.toHaveBeenCalled();
    expect(amo.createBrokerLeadFromLanding).not.toHaveBeenCalled();
  });

  it("дедуп: та же форма за 10 минут — вторую задачу не ставим", async () => {
    const prisma = prismaMock();
    prisma.contactRequest.findFirst.mockResolvedValue({ id: "cr-prev" });
    const { service, amo } = makeService(prisma);

    await (service as any).upsertBrokerFromLandingLead(TOUR_INPUT);

    expect(prisma.contactRequest.findFirst).toHaveBeenCalledWith({
      where: {
        id: { not: "cr-new" },
        source: "broker-tour",
        phone: { in: [PHONE] },
        message: TOUR_INPUT.note,
        createdAt: { gte: expect.any(Date) },
      },
      select: { id: true },
    });
    const since = prisma.contactRequest.findFirst.mock.calls[0][0].where
      .createdAt.gte as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(10 * 60_000 - 50);
    expect(Date.now() - since.getTime()).toBeLessThan(10 * 60_000 + 5_000);
    expect(amo.createLandingFollowUpForKnownBroker).not.toHaveBeenCalled();
    expect(amo.createBrokerLeadFromLanding).not.toHaveBeenCalled();
    // карточку всё равно пробуждаем для КЦ
    expect(prisma.broker.update).toHaveBeenCalledTimes(1);
  });

  it("дедуп сравнивает и сырой номер формы, и нормализованный", async () => {
    const prisma = prismaMock();
    const { service } = makeService(prisma);

    await (service as any).upsertBrokerFromLandingLead({
      ...TOUR_INPUT,
      phone: "8 (999) 000-07-77",
    });

    expect(prisma.broker.findUnique).toHaveBeenCalledWith({
      where: { phone: PHONE },
    });
    expect(prisma.contactRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone: { in: ["8 (999) 000-07-77", PHONE] },
        }),
      }),
    );
  });

  it("ошибка amo не роняет ответ пользователю; ops-алерт только при повторной ошибке", async () => {
    const prisma = prismaMock();
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    const { service, amo } = makeService(prisma, opsAlerts);
    amo.createLandingFollowUpForKnownBroker.mockRejectedValue(
      new Error("amo 503"),
    );

    const first = await service.createContactRequest(
      {
        name: TOUR_INPUT.fullName,
        phone: PHONE,
        message: TOUR_INPUT.note,
        source: "broker-tour",
      },
      "127.0.0.1",
      "jest",
    );
    expect(first).toEqual({ id: "cr-new" });
    expect(amo.createLandingFollowUpForKnownBroker).toHaveBeenCalledTimes(1);
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();

    const second = await service.createContactRequest(
      {
        name: TOUR_INPUT.fullName,
        phone: "+79990000778",
        message: null as any,
        source: "landing-callback",
      },
      null,
      null,
    );
    expect(second).toEqual({ id: "cr-new" });
    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(1);
    const [text, options] = opsAlerts.sendSafely.mock.calls[0];
    expect(text).toContain("не передана в amoCRM");
    expect(text).toContain("landing-callback");
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(TOUR_INPUT.fullName);
    expect(options).toEqual({
      dedupKey: "landing-amo:landing-callback",
      cooldownMs: 15 * 60_000,
    });
  });

  it("createContactRequest передаёт id сохранённой заявки для исключения из дедупа", async () => {
    const prisma = prismaMock();
    const { service } = makeService(prisma);

    await service.createContactRequest(
      { name: "Имя Фамилия", phone: PHONE, source: "broker-tour" },
      null,
      null,
    );

    expect(prisma.contactRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "cr-new" } }),
      }),
    );
  });
});

describe("AmoCrmAdapter.createLandingFollowUpForKnownBroker", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  function adapterWithMocks() {
    const adapter = new SourceAmoCrmAdapter() as any;
    adapter.createTask = jest.fn().mockResolvedValue(undefined);
    adapter.addNoteToContact = jest.fn().mockResolvedValue(undefined);
    return adapter;
  }

  it("задача «звонок» на контакте с явным ответственным и заметка на контакте", async () => {
    const adapter = adapterWithMocks();
    const now = new Date("2026-10-09T09:00:00+03:00");

    const result = await adapter.createLandingFollowUpForKnownBroker({
      contactId: 777,
      brokerName: "Известный Брокер",
      brokerPhone: PHONE,
      source: "LANDING_BROKER_TOUR",
      note: "Брокер-тур 09.10.2026 в 11:00 — Квартал Серебряный Бор",
      responsibleUserId: 123,
      now,
    });

    expect(adapter.createTask).toHaveBeenCalledWith({
      text: `Брокер-тур: Брокер-тур 09.10.2026 в 11:00 — Квартал Серебряный Бор. Подтвердить запись. Имя: Известный Брокер, тел.: ${PHONE}`,
      entityType: "contacts",
      entityId: 777,
      taskTypeId: 1,
      completeTillSec: landingFollowUpCompleteTillSec(now),
      responsibleUserId: 123,
    });
    expect(adapter.addNoteToContact).toHaveBeenCalledWith(
      777,
      expect.stringContaining(
        "📅 Запись на брокер-тур с лендинга: Брокер-тур 09.10.2026 в 11:00 — Квартал Серебряный Бор. Источник: landing/broker-tour, 09.10.2026",
      ),
    );
    expect(result).toEqual({
      taskCreated: true,
      noteCreated: true,
      responsibleUserId: 123,
      completeTillSec: landingFollowUpCompleteTillSec(now),
    });
  });

  it("без ответственного — env AMO_KC_CALLBACK_RESPONSIBLE_USER_ID, затем AMO_ADMIN_USER_ID", async () => {
    const adapter = adapterWithMocks();
    delete process.env.AMO_KC_CALLBACK_RESPONSIBLE_USER_ID;
    process.env.AMO_ADMIN_USER_ID = "6089620";

    await adapter.createLandingFollowUpForKnownBroker({
      contactId: 777,
      brokerName: "Б",
      brokerPhone: PHONE,
      source: "LANDING_CALLBACK",
      note: null,
    });
    expect(adapter.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        responsibleUserId: 6089620,
        text: `Перезвонить в течение часа: Б (${PHONE}) — заявка с сайта «перезвоним за 1 час»`,
      }),
    );

    process.env.AMO_KC_CALLBACK_RESPONSIBLE_USER_ID = "9796826";
    adapter.createTask.mockClear();
    await adapter.createLandingFollowUpForKnownBroker({
      contactId: 777,
      brokerName: "Б",
      brokerPhone: PHONE,
      source: "LANDING_CALLBACK",
      note: null,
    });
    expect(adapter.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ responsibleUserId: 9796826 }),
    );
    expect(adapter.addNoteToContact).toHaveBeenLastCalledWith(
      777,
      expect.stringContaining("📞 Заявка «перезвоним за 1 час» с лендинга. Источник: landing/landing-callback"),
    );
  });

  it("упавшая заметка не мешает задаче; упавшая задача пробрасывается", async () => {
    const adapter = adapterWithMocks();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    adapter.addNoteToContact.mockRejectedValue(new Error("note 500"));
    await expect(
      adapter.createLandingFollowUpForKnownBroker({
        contactId: 777,
        brokerName: "Б",
        brokerPhone: PHONE,
        source: "LANDING_BROKER_TOUR",
      }),
    ).resolves.toEqual(expect.objectContaining({ taskCreated: true, noteCreated: false }));

    adapter.createTask.mockRejectedValue(new Error("task 500"));
    await expect(
      adapter.createLandingFollowUpForKnownBroker({
        contactId: 777,
        brokerName: "Б",
        brokerPhone: PHONE,
        source: "LANDING_BROKER_TOUR",
      }),
    ).rejects.toThrow("task 500");
    errorSpy.mockRestore();
  });

  it("без contactId — ошибка, в amo не ходим", async () => {
    const adapter = adapterWithMocks();
    await expect(
      adapter.createLandingFollowUpForKnownBroker({
        contactId: 0,
        brokerName: "Б",
        brokerPhone: PHONE,
        source: "LANDING_BROKER_TOUR",
      }),
    ).rejects.toThrow("AMO_BROKER_CONTACT_ID_REQUIRED");
    expect(adapter.createTask).not.toHaveBeenCalled();
  });
});

describe("landingFollowUpCompleteTillSec — ближайший рабочий час (МСК 10:00–20:00)", () => {
  const msk = (iso: string) => new Date(`${iso}+03:00`);
  const sec = (iso: string) => Math.floor(msk(iso).getTime() / 1000);

  it("днём — ровно через час", () => {
    expect(landingFollowUpCompleteTillSec(msk("2026-10-09T12:15:00"))).toBe(
      sec("2026-10-09T13:15:00"),
    );
  });
  it("19:00 → 20:00 (ещё в окне)", () => {
    expect(landingFollowUpCompleteTillSec(msk("2026-10-09T19:00:00"))).toBe(
      sec("2026-10-09T20:00:00"),
    );
  });
  it("19:30 → позже 20:00 → 10:00 следующего дня", () => {
    expect(landingFollowUpCompleteTillSec(msk("2026-10-09T19:30:00"))).toBe(
      sec("2026-10-10T10:00:00"),
    );
  });
  it("ночью 03:00 → 10:00 того же дня", () => {
    expect(landingFollowUpCompleteTillSec(msk("2026-10-09T03:00:00"))).toBe(
      sec("2026-10-09T10:00:00"),
    );
  });
  it("23:30 → час уже на следующих сутках → 10:00 следующего дня", () => {
    expect(landingFollowUpCompleteTillSec(msk("2026-10-09T23:30:00"))).toBe(
      sec("2026-10-10T10:00:00"),
    );
  });
  it("конец месяца переносится корректно", () => {
    expect(landingFollowUpCompleteTillSec(msk("2026-10-31T21:00:00"))).toBe(
      sec("2026-11-01T10:00:00"),
    );
  });
});
