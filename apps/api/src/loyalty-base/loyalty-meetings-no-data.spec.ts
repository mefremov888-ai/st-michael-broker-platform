import { LoyaltyBaseService } from "./loyalty-base.service";

/**
 * 2026-09-14 (решение владельца): у брокеров, работавших до появления
 * воронки колл-центра, ноль встреч читается как «не встречался», хотя на
 * деле источника за те годы нет. Такие карточки помечаются meetingsNoData,
 * и интерфейс пишет «нет данных».
 */
describe("«Наша база»: ноль встреч или нет данных о встречах", () => {
  const FIRST_MEETING = new Date("2024-01-15T00:00:00.000Z");

  const makePrisma = () => ({
    client: {
      groupBy: jest.fn(async () => [
        { brokerId: "old", _count: { _all: 12 }, _max: { createdAt: new Date("2021-06-01T00:00:00.000Z") } },
        { brokerId: "now", _count: { _all: 4 }, _max: { createdAt: new Date("2026-05-01T00:00:00.000Z") } },
        { brokerId: "met", _count: { _all: 2 }, _max: { createdAt: new Date("2021-06-01T00:00:00.000Z") } },
      ]),
    },
    meeting: {
      groupBy: jest.fn(async () => [
        { brokerId: "met", _count: { _all: 3 }, _max: { date: new Date("2025-02-02T00:00:00.000Z") } },
      ]),
      aggregate: jest.fn(async () => ({ _min: { date: FIRST_MEETING } })),
    },
    deal: { groupBy: jest.fn(async () => []) },
    callLog: { groupBy: jest.fn(async () => []) },
  });

  const run = async (records: any[]) => {
    const prisma = makePrisma();
    const service = new LoyaltyBaseService(prisma as any);
    await (service as any).attachOurBrokerLifetimeAggregates(records, undefined);
    return records.map((record) => (service as any).mapOurBroker(record));
  };

  it("вся работа до первой известной встречи → «нет данных»", async () => {
    const [row] = await run([{ id: "old", fullName: "Брокер 2021 года", phone: "+79990000001" }]);
    expect(row.metrics.meetings).toBe(0);
    expect(row.metrics.meetingsNoData).toBe(true);
  });

  it("работает сейчас, встреч нет → это настоящий ноль", async () => {
    const [row] = await run([{ id: "now", fullName: "Брокер 2026 года", phone: "+79990000002" }]);
    expect(row.metrics.meetings).toBe(0);
    expect(row.metrics.meetingsNoData).toBe(false);
  });

  it("встречи есть → признак не выставляется", async () => {
    const [row] = await run([{ id: "met", fullName: "Брокер со встречами", phone: "+79990000003" }]);
    expect(row.metrics.meetings).toBe(3);
    expect(row.metrics.meetingsNoData).toBe(false);
  });

  it("активности нет вообще → ноль остаётся нулём, а не «нет данных»", async () => {
    const [row] = await run([{ id: "empty", fullName: "Пустая карточка", phone: "+79990000004" }]);
    expect(row.metrics.meetings).toBe(0);
    expect(row.metrics.meetingsNoData).toBe(false);
  });
});
