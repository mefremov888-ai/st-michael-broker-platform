import { brokerPeriodNarrowingWhere } from "./loyalty-base.service";

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
