import { ConflictException, NotFoundException } from "@nestjs/common";
import { LoyaltyBaseService } from "./loyalty-base.service";
import {
  amoLinkStatusOf,
  maskAmoCandidatePhone,
  pickLatestContact,
} from "./loyalty-amo-touch";

// 2026-09-28 (решения владельца): срез amoCRM (BrokerAmoContactSync) в
// «Нашей базе» — ответственный КЦ, «последний контакт» из трёх источников,
// результат звонка amo, фильтр «Привязка к amo», ручная привязка.
function serviceWith(prisma: any): any {
  const service: any = Object.create(LoyaltyBaseService.prototype);
  service.prisma = prisma;
  return service;
}

const T = (iso: string) => new Date(iso);

describe("attachOurBrokerAmoTouches — один findMany по brokerId in + справочник AmoUser", () => {
  it("кладёт срез amo и ответственного КЦ с именем из AmoUser", async () => {
    const syncFindMany = jest.fn().mockResolvedValue([
      {
        brokerId: "b1",
        amoContactId: 1001n,
        amoLookupAt: T("2026-09-27T21:00:00Z"),
        amoLookupStatus: "LINKED",
        kcResponsibleUserId: 777n,
        lastTouchAt: T("2026-09-25T10:00:00Z"),
        lastTouchKind: "TASK_COMPLETED",
        lastTouchRef: "task:5",
        lastTouchUserId: 777n,
        lastCallAt: T("2026-09-20T09:00:00Z"),
        lastCallDirection: "OUT",
        lastCallStatus: 4,
        lastCallResultText: "Договорились о встрече",
        lastCallDurationSec: 120,
        lastCallUserId: 888n,
        syncedAt: T("2026-09-27T21:05:00Z"),
      },
    ]);
    const usersFindMany = jest.fn().mockResolvedValue([
      { id: 777n, name: "Мажаровская Арина", brokerId: null, isActive: true },
      { id: 888n, name: "Скибицкая Анна", brokerId: "mgr-1", isActive: true },
    ]);
    const service = serviceWith({
      brokerAmoContactSync: { findMany: syncFindMany },
      amoUser: { findMany: usersFindMany },
    });
    const records: any[] = [{ id: "b1" }, { id: "b2" }];
    await service.attachOurBrokerAmoTouches(records);
    expect(syncFindMany).toHaveBeenCalledTimes(1);
    expect(syncFindMany.mock.calls[0][0].where).toEqual({
      brokerId: { in: ["b1", "b2"] },
    });
    // без флага candidates — тяжёлый JSON кандидатов не читаем
    expect(syncFindMany.mock.calls[0][0].select.amoLookupCandidates).toBeUndefined();
    expect(usersFindMany).toHaveBeenCalledTimes(1);
    expect(records[0].__amoSync.amoContactId).toBe("1001");
    expect(records[0].__amoSync.lastTouchAt).toBe("2026-09-25T10:00:00.000Z");
    expect(records[0].__amoSync.lastCallUser.name).toBe("Скибицкая Анна");
    expect(records[0].__amoResponsible).toEqual({
      id: "777",
      name: "Мажаровская Арина",
      brokerId: null,
      isActive: true,
    });
    expect(records[1].__amoSync).toBeNull();
    expect(records[1].__amoResponsible).toBeNull();
    // справочник кэшируется — второй вызов не ходит в базу
    await service.attachOurBrokerAmoTouches([{ id: "b1" }]);
    expect(usersFindMany).toHaveBeenCalledTimes(1);
  });

  it("с флагом candidates — маскирует телефоны кандидатов и подставляет ответственных", async () => {
    const service = serviceWith({
      brokerAmoContactSync: {
        findMany: jest.fn().mockResolvedValue([
          {
            brokerId: "b1",
            amoContactId: null,
            amoLookupAt: T("2026-09-27T21:00:00Z"),
            amoLookupStatus: "AMBIGUOUS",
            amoLookupCandidates: [
              {
                id: 501,
                name: "Иванов Иван",
                phone: "+79254259619",
                responsibleUserId: 777,
                updatedAt: "2026-09-01T10:00:00Z",
              },
              { id: "502", name: null, phone: "89991112233", responsibleUserId: null },
              { id: "bad", phone: "1" },
            ],
            syncedAt: T("2026-09-27T21:05:00Z"),
          },
        ]),
      },
      amoUser: {
        findMany: jest.fn().mockResolvedValue([{ id: 777n, name: "Мажаровская Арина" }]),
      },
    });
    const records: any[] = [{ id: "b1", amoContactId: null }];
    await service.attachOurBrokerAmoTouches(records, { candidates: true });
    expect(records[0].__amoSync.candidates).toEqual([
      {
        id: "501",
        name: "Иванов Иван",
        phoneMasked: "+7 925 ***-**-19",
        responsibleUserId: "777",
        responsibleName: "Мажаровская Арина",
        updatedAt: "2026-09-01T10:00:00.000Z",
      },
      {
        id: "502",
        name: null,
        phoneMasked: "+7 999 ***-**-33",
        responsibleUserId: null,
        responsibleName: null,
        updatedAt: null,
      },
    ]);
    const link = service.ourBrokerAmoLink(records[0]);
    expect(link.status).toBe("AMBIGUOUS");
    expect(link.candidates).toHaveLength(2);
  });

  it("ошибка базы не роняет список — просто без среза amo", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const service = serviceWith({
      brokerAmoContactSync: { findMany: jest.fn().mockRejectedValue(new Error("boom")) },
      amoUser: { findMany: jest.fn() },
    });
    const records: any[] = [{ id: "b1" }];
    await expect(service.attachOurBrokerAmoTouches(records)).resolves.toBeUndefined();
    expect(records[0].__amoSync).toBeNull();
    warn.mockRestore();
  });
});

describe("applyOurBrokerAmoOverlay — слияние «последнего контакта» и ответственного", () => {
  const service = serviceWith({});

  it("ответственный КЦ из amo главнее ручного закрепления и оператора звонка", () => {
    const item: any = {
      assignee: { id: "op-1", name: "Оператор" },
      lastCallAt: "2026-09-10T10:00:00.000Z",
      lastCallSource: "CABINET",
      lastCallResult: "INFORMED",
    };
    const record: any = {
      __amoResponsible: { id: "777", name: "Мажаровская Арина", brokerId: null },
      __amoSync: { lastTouchAt: null, lastCallAt: null },
    };
    service.applyOurBrokerAmoOverlay(record, item);
    expect(item.assignee).toEqual({
      id: "amo:777",
      name: "Мажаровская Арина",
      amoUserId: "777",
    });
    expect(item.assigneeSource).toBe("AMO");
  });

  it("сотрудник amo, привязанный к нашему Broker, считается нашим менеджером", () => {
    const item: any = { assignee: null, lastCallAt: null };
    const record: any = {
      __amoResponsible: { id: "888", name: "Скибицкая Анна", brokerId: "mgr-1" },
    };
    service.applyOurBrokerAmoOverlay(record, item);
    expect(item.assignee.id).toBe("mgr-1");
    expect(item.assigneeSource).toBe("CABINET");
  });

  it("без kcResponsibleUserId — прежнее поведение (оператор последнего звонка остаётся)", () => {
    const item: any = { assignee: { id: "op-1", name: "Оператор" }, lastCallAt: null };
    service.applyOurBrokerAmoOverlay({ __amoResponsible: null, __amoSync: null }, item);
    expect(item.assignee).toEqual({ id: "op-1", name: "Оператор" });
    expect(item.assigneeSource).toBe("CABINET");
  });

  it("последний контакт = самое свежее из наших звонков, касания amo и ленты", () => {
    const record: any = {
      clients: [{ createdAt: T("2026-09-12T08:00:00Z") }],
      meetings: [{ date: T("2026-09-03T13:00:00Z") }],
      deals: [],
      __amoSync: {
        lastTouchAt: "2026-09-15T09:30:00.000Z",
        lastTouchKind: "TASK_COMPLETED",
        lastCallAt: null,
      },
    };
    const item: any = { lastCallAt: "2026-09-10T10:00:00.000Z", lastCallSource: "CABINET" };
    service.applyOurBrokerAmoOverlay(record, item);
    expect(item.lastContactAt).toBe("2026-09-15T09:30:00.000Z");
    expect(item.lastContactKind).toBe("TASK_COMPLETED");
    expect(item.lastContactSource).toBe("amo");

    // фиксация свежее всего
    record.clients = [{ createdAt: T("2026-09-20T08:00:00Z") }];
    service.applyOurBrokerAmoOverlay(record, { lastCallAt: "2026-09-10T10:00:00.000Z" });
    const fresh: any = { lastCallAt: "2026-09-10T10:00:00.000Z" };
    service.applyOurBrokerAmoOverlay(record, fresh);
    expect(fresh.lastContactKind).toBe("FIXATION");
    expect(fresh.lastContactSource).toBe("cabinet");

    // наш звонок свежее всего
    const call: any = { lastCallAt: "2026-09-25T10:00:00.000Z", lastCallSource: "ANNA" };
    service.applyOurBrokerAmoOverlay(record, call);
    expect(call.lastContactKind).toBe("CALL_OUT");
    expect(call.lastContactSource).toBe("anna");
  });

  it("звонок amo свежее наших — русская подпись статуса, текст результата и источник AMO", () => {
    const item: any = {
      lastCallAt: "2026-09-10T10:00:00.000Z",
      lastCallSource: "CABINET",
      lastCallResult: "NO_ANSWER",
    };
    const record: any = {
      __amoSync: {
        lastTouchAt: "2026-09-18T11:00:00.000Z",
        lastTouchKind: "CALL_IN",
        lastCallAt: "2026-09-18T11:00:00.000Z",
        lastCallDirection: "IN",
        lastCallStatus: 4,
        lastCallResultText: "Обсудили объект",
        lastCallUser: { name: "Мажаровская Арина" },
      },
    };
    service.applyOurBrokerAmoOverlay(record, item);
    expect(item.lastCallAt).toBe("2026-09-18T11:00:00.000Z");
    expect(item.lastCallSource).toBe("AMO");
    expect(item.lastCallResultSource).toBe("AMO");
    expect(item.lastCallResultLabel).toBe("разговор состоялся");
    expect(item.lastCallResultText).toBe("Обсудили объект");
    // код нашего результата не трогаем — фильтр/фасет «результат звонка» остаётся про наши звонки
    expect(item.lastCallResult).toBe("NO_ANSWER");
    expect(item.lastContactKind).toBe("CALL_IN");
    expect(item.lastContactSource).toBe("amo");
  });

  it("наш звонок свежее звонка amo — результат остаётся кабинетным", () => {
    const item: any = {
      lastCallAt: "2026-09-20T10:00:00.000Z",
      lastCallSource: "CABINET",
      lastCallResult: "INFORMED",
    };
    service.applyOurBrokerAmoOverlay(
      { __amoSync: { lastCallAt: "2026-09-18T11:00:00.000Z", lastCallStatus: 6 } },
      item,
    );
    expect(item.lastCallSource).toBe("CABINET");
    expect(item.lastCallResultSource).toBe("CABINET");
    expect(item.lastCallResultLabel).toBeNull();
  });
});

describe("amoLinkStatusOf / фильтр «Привязка к amo»", () => {
  it("статусы: привязан / требует решения / не найден / не проверялся", () => {
    expect(amoLinkStatusOf(1001n, null)).toBe("LINKED");
    expect(amoLinkStatusOf(null, null)).toBe("UNCHECKED");
    expect(amoLinkStatusOf(null, { amoLookupAt: null, amoLookupStatus: "NOT_FOUND" })).toBe("UNCHECKED");
    expect(amoLinkStatusOf(null, { amoLookupAt: "2026-09-27", amoLookupStatus: "AMBIGUOUS" })).toBe("AMBIGUOUS");
    expect(amoLinkStatusOf(null, { amoLookupAt: "2026-09-27", amoLookupStatus: "NOT_FOUND" })).toBe("NOT_FOUND");
    expect(amoLinkStatusOf(null, { amoLookupAt: "2026-09-27", amoLookupStatus: "NOT_BROKER" })).toBe("NOT_FOUND");
    expect(amoLinkStatusOf(null, { amoContactId: "5", amoLookupAt: "2026-09-27" })).toBe("LINKED");
  });

  it("matchesOurBroker отсекает по amoLink и пропускает без фильтра", () => {
    const service = serviceWith({});
    service.ourCalls = () => [];
    service.ourBrokerCallPresence = () => null;
    service.callAssigneeValues = () => [];
    service.ourBrokerStatusCodes = () => ["NEW"];
    service.ourDataQualityCodes = () => [];
    service.ourLastActivity = () => null;
    service.applyCallSummary = (item: any) => {
      item.lastCallAt = null;
      item.lastCallResult = null;
      return null;
    };
    service.matchesColumnFilters = () => true;
    const filter: any = {
      campaignIds: [],
      lastCallResults: [],
      assigneeIds: [],
      specializations: [],
      geography: [],
      workFormats: [],
      relationshipStages: [],
      brokerStatuses: [],
      dataQuality: [],
      dealCount: {},
      meetings: {},
      partnershipStatuses: [],
      agencySizes: [],
      projectsOnSite: [],
      columns: {},
      amoLink: "AMBIGUOUS",
    };
    const ambiguous: any = {
      id: "b1",
      amoContactId: null,
      __amoSync: { amoLookupAt: "2026-09-27T21:00:00.000Z", amoLookupStatus: "AMBIGUOUS" },
    };
    const linked: any = { id: "b2", amoContactId: 1001n, __amoSync: null };
    const unchecked: any = { id: "b3", amoContactId: null, __amoSync: null };
    expect(service.matchesOurBroker(ambiguous, {}, filter)).toBe(true);
    expect(service.matchesOurBroker(linked, {}, filter)).toBe(false);
    expect(service.matchesOurBroker(unchecked, {}, filter)).toBe(false);
    expect(service.matchesOurBroker(unchecked, {}, { ...filter, amoLink: "UNCHECKED" })).toBe(true);
    expect(service.matchesOurBroker(linked, {}, { ...filter, amoLink: "LINKED" })).toBe(true);
    const anyItem: any = {};
    expect(service.matchesOurBroker(linked, anyItem, { ...filter, amoLink: undefined })).toBe(true);
    expect(anyItem.amoLink.status).toBe("LINKED");
    expect(anyItem.amoLink.contactId).toBe("1001");
  });

  it("ответственный amo попадает в фильтр assigneeIds по имени и по id нашего сотрудника", () => {
    const service = serviceWith({});
    service.ourCalls = () => [];
    service.ourBrokerCallPresence = () => null;
    service.callAssigneeValues = () => [];
    service.ourBrokerStatusCodes = () => ["NEW"];
    service.ourDataQualityCodes = () => [];
    service.ourLastActivity = () => null;
    service.applyCallSummary = () => null;
    service.matchesColumnFilters = () => true;
    const base: any = {
      campaignIds: [], lastCallResults: [], assigneeIds: [], specializations: [], geography: [],
      workFormats: [], relationshipStages: [], brokerStatuses: [], dataQuality: [], dealCount: {},
      meetings: {}, partnershipStatuses: [], agencySizes: [], projectsOnSite: [], columns: {},
    };
    const record: any = {
      id: "b1",
      assignedManagerId: "mgr-old",
      assignedManager: { id: "mgr-old", fullName: "Старый менеджер" },
      __amoResponsible: { id: "888", name: "Скибицкая Анна", brokerId: "mgr-1" },
    };
    expect(service.matchesOurBroker(record, {}, { ...base, assigneeIds: ["mgr-1"] })).toBe(true);
    expect(service.matchesOurBroker(record, {}, { ...base, assigneeIds: ["Скибицкая Анна"] })).toBe(true);
    const item: any = {};
    expect(service.matchesOurBroker(record, item, { ...base, assigneeIds: ["никто"] })).toBe(false);
    expect(item.assignee).toEqual({ id: "mgr-1", name: "Скибицкая Анна", amoUserId: "888" });
  });
});

describe("linkOurBrokerAmoContact — ручная привязка из карточки", () => {
  function prismaWith(overrides: any = {}) {
    const tx = jest.fn(async (ops: any[]) => ops);
    return {
      broker: {
        findUnique: jest.fn().mockResolvedValue({
          id: "b1",
          role: "BROKER",
          amoContactId: null,
          fullName: "Петров Пётр",
          displayName: null,
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: "b1" }),
      },
      brokerAmoContactSync: { upsert: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: tx,
      ...overrides,
    };
  }

  it("пишет Broker.amoContactId, upsert строки sync LINKED без кандидатов и sourceHash, аудит", async () => {
    const prisma = prismaWith();
    const service = serviceWith(prisma);
    const result = await service.linkOurBrokerAmoContact("b1", "501", "admin-1");
    expect(prisma.broker.findFirst.mock.calls[0][0].where).toEqual({
      amoContactId: 501n,
      NOT: { id: "b1" },
    });
    expect(prisma.broker.update).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { amoContactId: 501n },
    });
    const upsert = prisma.brokerAmoContactSync.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ brokerId: "b1" });
    expect(upsert.update.amoLookupStatus).toBe("LINKED");
    expect(upsert.update.sourceHash).toBeNull();
    expect(upsert.update.amoContactId).toBe(501n);
    expect(upsert.create.brokerId).toBe("b1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("AMO_CONTACT_LINK");
    expect(audit.entityId).toBe("b1");
    expect(audit.userId).toBe("admin-1");
    expect(audit.payload).toMatchObject({ before: null, after: "501" });
    expect(result.amoLink.status).toBe("LINKED");
    expect(result.amoContactId).toBe("501");
  });

  it("409 с понятным русским текстом, если контакт уже привязан к другому брокеру", async () => {
    const prisma = prismaWith();
    prisma.broker.findFirst.mockResolvedValue({
      id: "b2",
      fullName: "Сидоров Сидор",
      displayName: null,
    });
    const service = serviceWith(prisma);
    await expect(service.linkOurBrokerAmoContact("b1", "501")).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.linkOurBrokerAmoContact("b1", "501")).rejects.toThrow(
      /уже привязан к другому брокеру/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("гонка: P2002 на записи тоже превращается в 409 без сырого текста Prisma", async () => {
    const prisma = prismaWith({
      $transaction: jest.fn().mockRejectedValue(
        Object.assign(new Error("Unique constraint failed on the fields: (`amo_contact_id`)"), {
          code: "P2002",
        }),
      ),
    });
    const service = serviceWith(prisma);
    await expect(service.linkOurBrokerAmoContact("b1", "501")).rejects.toThrow(
      /уже привязан к другому брокеру/,
    );
    await expect(service.linkOurBrokerAmoContact("b1", "501")).rejects.not.toThrow(
      /Unique constraint/,
    );
  });

  it("404 для неизвестного брокера и 400 для нечислового id", async () => {
    const prisma = prismaWith();
    prisma.broker.findUnique.mockResolvedValue(null);
    const service = serviceWith(prisma);
    await expect(service.linkOurBrokerAmoContact("nope", "501")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.linkOurBrokerAmoContact("b1", "abc")).rejects.toThrow(
      /числовой id/,
    );
  });
});

describe("чистые помощники loyalty-amo-touch", () => {
  it("маскирует телефон кандидата как +7 9xx ***-**-xx", () => {
    expect(maskAmoCandidatePhone("+7 (925) 425-96-19")).toBe("+7 925 ***-**-19");
    expect(maskAmoCandidatePhone("89254259619")).toBe("+7 925 ***-**-19");
    expect(maskAmoCandidatePhone("9254259619")).toBe("+7 925 ***-**-19");
    expect(maskAmoCandidatePhone("")).toBe("");
    expect(maskAmoCandidatePhone("12345")).toBe("***45");
  });

  it("pickLatestContact выбирает самое свежее и пропускает пустые даты", () => {
    expect(
      pickLatestContact([
        { at: null, kind: "MEETING", source: "cabinet" },
        { at: "2026-09-01T00:00:00Z", kind: "FIXATION", source: "cabinet" },
        { at: new Date("2026-09-05T00:00:00Z"), kind: "CALL_IN", source: "amo" },
        { at: "не дата", kind: "DEAL", source: "cabinet" },
      ]),
    ).toEqual({ at: "2026-09-05T00:00:00.000Z", kind: "CALL_IN", source: "amo" });
    expect(pickLatestContact([])).toBeNull();
  });
});
