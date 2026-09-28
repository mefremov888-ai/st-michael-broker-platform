import {
  brokerCallInPeriodWhere,
  brokerPeriodNarrowingWhere,
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
describe("период звонков сужает список «Нашей базы»", () => {
  const callPeriod = period("2026-08-01T00:00:00Z", "2026-08-31T23:59:59Z");

  it("без периода звонков условия нет — даже при «не звонили»", () => {
    expect(brokerPeriodNarrowingWhere({ notCalledInPeriod: true })).toEqual([]);
  });

  it("остаются брокеры со звонком из любого источника: легаси, обзвон, телефония", () => {
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
  });

  it("«Не звонили в период» — то же условие как исключение", () => {
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
      meetingPeriod: callPeriod,
    });
    expect(clauses).toHaveLength(2);
    expect(clauses[0].OR).toBeDefined();
    expect(clauses[1].meetings).toBeDefined();
  });
});
