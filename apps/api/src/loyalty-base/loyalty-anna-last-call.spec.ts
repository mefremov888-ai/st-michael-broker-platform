import { LoyaltyBaseService } from "./loyalty-base.service";

// 2026-09-28 (владелец): в «Нашей базе» подтягиваем «последний звонок» из
// базы Анны по тому же номеру и делим базу на вкладки с/без номера.
function serviceWith(prisma: any): any {
  const service: any = Object.create(LoyaltyBaseService.prototype);
  service.prisma = prisma;
  return service;
}

const activeDataset = {
  id: "ds-1",
  activeSnapshot: { id: "snap-1", datasetId: "ds-1", status: "PUBLISHED" },
};

describe("attachOurAnnaLastCalls — последний звонок из базы Анны по номеру", () => {
  it("находит запись Анны по основному и дополнительному номеру и берёт самую свежую дату", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { normalizedValue: "+79990000001", sourceRecord: { sourceAggregate: { lastCallAt: new Date("2026-09-10T10:00:00Z"), callCount: 3 } } },
      { normalizedValue: "+79990000002", sourceRecord: { sourceAggregate: { lastCallAt: new Date("2026-09-20T10:00:00Z"), callCount: 1 } } },
      { normalizedValue: "+79990000003", sourceRecord: { sourceAggregate: null } },
    ]);
    const prisma = {
      loyaltyDataset: { findUnique: jest.fn().mockResolvedValue(activeDataset) },
      loyaltyContactPoint: { findMany },
    };
    const service = serviceWith(prisma);
    const records: any[] = [
      { id: "b1", phone: "+79990000001", phones: [{ phone: "8 999 000-00-02" }] },
      { id: "b2", phone: "+79990000003", phones: [] },
      { id: "b3", phone: "tg:nick", phones: [] },
    ];
    await service.attachOurAnnaLastCalls(records);
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.type).toBe("PHONE");
    expect(where.sourceRecord).toEqual({ snapshotId: "snap-1" });
    // tg:<ник> — не телефон, в запрос не попадает
    expect(where.normalizedValue.in).toEqual(["+79990000001", "+79990000002", "+79990000003"]);
    expect(records[0].__annaLastCallAt).toEqual(new Date("2026-09-20T10:00:00Z"));
    expect(records[0].__annaCallCount).toBe(1);
    expect(records[1].__annaLastCallAt).toBeNull();
    expect(records[2].__annaLastCallAt).toBeNull();
  });

  it("без опубликованного снимка Анны ничего не подтягивает и не падает", async () => {
    const prisma = {
      loyaltyDataset: { findUnique: jest.fn().mockResolvedValue(null) },
      loyaltyContactPoint: { findMany: jest.fn() },
    };
    const service = serviceWith(prisma);
    const records: any[] = [{ id: "b1", phone: "+79990000001", phones: [] }];
    await service.attachOurAnnaLastCalls(records);
    expect(prisma.loyaltyContactPoint.findMany).not.toHaveBeenCalled();
    expect(records[0].__annaLastCallAt).toBeNull();
  });

  it("ошибка базы не роняет список — просто без данных Анны", async () => {
    const prisma = {
      loyaltyDataset: { findUnique: jest.fn().mockResolvedValue(activeDataset) },
      loyaltyContactPoint: { findMany: jest.fn().mockRejectedValue(new Error("boom")) },
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const service = serviceWith(prisma);
    const records: any[] = [{ id: "b1", phone: "+79990000001", phones: [] }];
    await expect(service.attachOurAnnaLastCalls(records)).resolves.toBeUndefined();
    expect(records[0].__annaLastCallAt).toBeNull();
    warn.mockRestore();
  });
});

describe("ourLastCallLifetime — дата Анны участвует в «последнем звонке за всё время»", () => {
  it("берёт максимум из звонков кабинета и даты Анны", () => {
    const service = serviceWith({});
    service.ourCalls = () => [];
    service.lastCall = () => null;
    service.callSortKey = () => "";
    expect(
      service.ourLastCallLifetime({
        lastCallAt: new Date("2026-08-01T00:00:00Z"),
        __annaLastCallAt: new Date("2026-09-15T00:00:00Z"),
      }),
    ).toBe("2026-09-15");
    expect(
      service.ourLastCallLifetime({
        lastCallAt: new Date("2026-09-20T00:00:00Z"),
        __annaLastCallAt: new Date("2026-09-15T00:00:00Z"),
      }),
    ).toBe("2026-09-20");
  });
});
