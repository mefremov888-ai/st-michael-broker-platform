import {
  brokerCallInPeriodWhere,
  brokerPeriodNarrowingWhere,
  brokerPhonePresenceWhere,
} from "./loyalty-base.service";

const period = (from: string, to: string) => ({
  from: new Date(from),
  to: new Date(to),
});

describe("периоды сужают список «Нашей базы»", () => {
  it("без периодов список не сужается", () => {
    expect(brokerPeriodNarrowingWhere({})).toEqual([]);
  });

  it("период встреч оставляет только тех, у кого встреча в эти даты", () => {
    const clauses = brokerPeriodNarrowingWhere({
      meetingPeriod: period("2026-01-17T00:00:00Z", "2026-09-17T23:59:59Z"),
    });
    expect(clauses).toHaveLength(1);
    const meetings = clauses[0].meetings.some;
    expect(meetings.status).toEqual({ in: ["CONFIRMED", "COMPLETED"] });
    // брокер-тур встречей не считается
    expect(meetings.type).toEqual({ not: "BROKER_TOUR" });
    expect(meetings.date.gte.toISOString()).toBe("2026-01-17T00:00:00.000Z");
  });

  it("период фиксаций опирается на правила фиксации, а не на все карточки", () => {
    const clauses = brokerPeriodNarrowingWhere({
      fixationPeriod: period("2026-08-01T00:00:00Z", "2026-08-31T23:59:59Z"),
    });
    expect(clauses).toHaveLength(1);
    const clients = clauses[0].clients.some;
    expect(clients.createdAt.gte.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    // правила фиксации подмешаны (отклонённые и «на проверке» не в счёт)
    expect(Object.keys(clients).length).toBeGreaterThan(1);
  });

  it("период сделок ищет и в кабинете, и в реестре", () => {
    const clauses = brokerPeriodNarrowingWhere({
      dealPeriod: period("2026-01-10T00:00:00Z", "2026-09-17T23:59:59Z"),
      dealWhere: { status: "CONFIRMED" },
      registryWhere: { paidAt: { gte: new Date("2026-01-10T00:00:00Z") } },
    });
    expect(clauses).toHaveLength(1);
    expect(clauses[0].OR).toHaveLength(2);
    expect(clauses[0].OR[0].deals.some).toEqual({ status: "CONFIRMED" });
    expect(clauses[0].OR[1].registryDeals.some).toBeDefined();
  });

  it("если выбран отдельный фильтр «Сделка в периоде» — второй раз не сужаем", () => {
    const clauses = brokerPeriodNarrowingWhere({
      dealPeriod: period("2026-01-10T00:00:00Z", "2026-09-17T23:59:59Z"),
      dealsInPeriod: true,
      dealWhere: {},
      registryWhere: {},
    });
    expect(clauses).toEqual([]);
  });

  it("три периода сразу дают три независимых условия", () => {
    const clauses = brokerPeriodNarrowingWhere({
      fixationPeriod: period("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
      meetingPeriod: period("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
      dealPeriod: period("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z"),
      dealWhere: {},
      registryWhere: {},
    });
    expect(clauses).toHaveLength(3);
  });
});

// 2026-09-28 (решение владельца): «Период звонков» сам сужает список —
// остаются только брокеры, с кем за период был звонок: мы звонили или нам
// звонили. «Не звонили в период» — то же условие, но как исключение.
// 2026-09-28 (перф, 504 на проде): в бою множество звонивших считается
// заранее прямыми запросами и передаётся списком id — в where попадает
// `id in (...)`, а не три коррелированных подзапроса по связям.
describe("период звонков сужает список «Нашей базы»", () => {
  const callPeriod = period("2026-08-01T00:00:00Z", "2026-08-31T23:59:59Z");

  it("без периода звонков условия нет — даже при «не звонили»", () => {
    expect(brokerPeriodNarrowingWhere({ notCalledInPeriod: true })).toEqual([]);
    expect(
      brokerPeriodNarrowingWhere({
        notCalledInPeriod: true,
        calledBrokerIds: ["b1"],
      }),
    ).toEqual([]);
  });

  it("с заранее посчитанным множеством — простое условие id in", () => {
    const clauses = brokerPeriodNarrowingWhere({
      callPeriod,
      calledBrokerIds: ["b1", "b2"],
    });
    expect(clauses).toEqual([{ id: { in: ["b1", "b2"] } }]);
  });

  it("пустое множество звонивших даёт пустой список, а не «все»", () => {
    const clauses = brokerPeriodNarrowingWhere({
      callPeriod,
      calledBrokerIds: [],
    });
    expect(clauses).toEqual([{ id: { in: [] } }]);
  });

  it("«Не звонили в период» — то же множество под NOT (а не notIn)", () => {
    const clauses = brokerPeriodNarrowingWhere({
      callPeriod,
      notCalledInPeriod: true,
      calledBrokerIds: ["b1"],
    });
    expect(clauses).toEqual([{ NOT: { id: { in: ["b1"] } } }]);
    expect(clauses[0].id).toBeUndefined();
  });

  it("без множества (нет делегатов) остаётся условие по трём источникам", () => {
    const clauses = brokerPeriodNarrowingWhere({ callPeriod });
    expect(clauses).toHaveLength(1);
    const sources = clauses[0].OR;
    expect(sources).toHaveLength(3);
    expect(sources[0].callLogs.some.createdAt.gte.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(
      sources[1].loyaltyAssignmentsAsTarget.some.attempts.some.occurredAt.lte.toISOString(),
    ).toBe("2026-08-31T23:59:59.000Z");
    // телефония Mango: входящие и исходящие любой направленности, но не
    // звонки брокера своему клиенту из кабинета (clientId задан)
    expect(sources[2].calls.some).toEqual({
      clientId: null,
      createdAt: { gte: callPeriod.from, lte: callPeriod.to },
    });
    expect(sources[2].calls.some).not.toHaveProperty("direction");
    expect(sources[2].calls.some).not.toHaveProperty("status");
    // null — то же, что отсутствие множества
    expect(
      brokerPeriodNarrowingWhere({ callPeriod, calledBrokerIds: null }),
    ).toEqual(clauses);
  });

  it("без множества «Не звонили в период» — условие по связям под NOT", () => {
    const clauses = brokerPeriodNarrowingWhere({
      callPeriod,
      notCalledInPeriod: true,
    });
    expect(clauses).toHaveLength(1);
    expect(clauses[0].NOT).toEqual(brokerCallInPeriodWhere(callPeriod));
    expect(clauses[0].OR).toBeUndefined();
  });

  it("период звонков не мешает периодам встреч и сделок", () => {
    const clauses = brokerPeriodNarrowingWhere({
      callPeriod,
      calledBrokerIds: ["b1"],
      meetingPeriod: callPeriod,
    });
    expect(clauses).toHaveLength(2);
    expect(clauses[0].id).toEqual({ in: ["b1"] });
    expect(clauses[1].meetings).toBeDefined();
  });
});

// 2026-09-28: вкладки «с номерами» / «без номеров» — одно условие для списка
// и для счётчика «Брокеры» в обзоре.
describe("вкладка «с номерами / без номеров»", () => {
  it("без номера — контакты из Telegram (phone='tg:…'), с номером — все прочие", () => {
    expect(brokerPhonePresenceWhere("WITHOUT")).toEqual({
      phone: { startsWith: "tg:" },
    });
    expect(brokerPhonePresenceWhere("WITH")).toEqual({
      phone: { not: { startsWith: "tg:" } },
    });
  });

  it("без вкладки условие пустое (вся база)", () => {
    expect(brokerPhonePresenceWhere(undefined)).toEqual({});
    expect(brokerPhonePresenceWhere(null)).toEqual({});
  });
});
