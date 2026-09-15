import { LoyaltyBaseService, toPeriodSet } from "./loyalty-base.service";

/**
 * 2026-09-14 (две просьбы владельца):
 *   1) фильтр по датам не работал, если заполнена только одна граница —
 *      интерфейс молча выбрасывал такой фильтр, а API отвечал ошибкой;
 *   2) нужны отдельные даты для фиксаций, встреч и сделок.
 */
describe("периоды в фильтрах «Нашей базы»", () => {
  const service = new LoyaltyBaseService({} as any);
  const normalize = (query: any, canonical?: any) =>
    (service as any).normalizeListFilter(query, canonical);

  describe("одна граница вместо двух", () => {
    it("указана только дата «с» — период до сегодняшнего дня", () => {
      const f = normalize({}, { callPeriod: { from: "2026-09-01" } });
      expect(f.callPeriod).toBeDefined();
      expect(f.callPeriod.fromIso).toBe("2026-09-01");
      expect(f.callPeriod.toIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.callPeriod.from.getTime()).toBeLessThanOrEqual(f.callPeriod.to.getTime());
    });

    it("указана только дата «по» — период с начала данных", () => {
      const f = normalize({}, { activityPeriod: { to: "2026-09-10" } });
      expect(f.activityPeriod.toIso).toBe("2026-09-10");
      expect(f.activityPeriod.fromIso).toBe("2015-01-01");
    });

    it("обе даты пусты — фильтра нет, «за всё время»", () => {
      const f = normalize({}, { callPeriod: {} });
      expect(f.callPeriod).toBeUndefined();
    });

    it("даты наоборот — понятная ошибка, а не молчание", () => {
      expect(() =>
        normalize({}, { activityPeriod: { from: "2026-09-10", to: "2026-09-01" } }),
      ).toThrow();
    });
  });

  describe("отдельные периоды по видам активности", () => {
    it("свой период у фиксаций не затрагивает встречи и сделки", () => {
      const f = normalize({}, { fixationPeriod: { from: "2026-08-01", to: "2026-08-31" } });
      expect(f.fixationPeriod.fromIso).toBe("2026-08-01");
      expect(f.meetingPeriod).toBeUndefined();
      expect(f.dealPeriod).toBeUndefined();
    });

    it("общий период действует на все три, если свои не заданы", () => {
      const f = normalize({}, { activityPeriod: { from: "2026-07-01", to: "2026-07-31" } });
      expect(f.fixationPeriod.fromIso).toBe("2026-07-01");
      expect(f.meetingPeriod.fromIso).toBe("2026-07-01");
      expect(f.dealPeriod.fromIso).toBe("2026-07-01");
    });

    it("свой период перебивает общий только для своей метрики", () => {
      const f = normalize({}, {
        activityPeriod: { from: "2026-01-01", to: "2026-12-31" },
        dealPeriod: { from: "2026-09-01", to: "2026-09-30" },
      });
      expect(f.dealPeriod.fromIso).toBe("2026-09-01");
      expect(f.fixationPeriod.fromIso).toBe("2026-01-01");
      expect(f.meetingPeriod.fromIso).toBe("2026-01-01");
    });

    it("легаси-параметры from/to остаются общим периодом", () => {
      const f = normalize({ from: "2026-06-01", to: "2026-06-30" });
      expect(f.activityPeriod.fromIso).toBe("2026-06-01");
      expect(f.meetingPeriod.fromIso).toBe("2026-06-01");
      expect(f.callPeriod.fromIso).toBe("2026-06-01");
    });
  });

  describe("набор периодов", () => {
    it("один период раскладывается на три — старые вызовы не ломаются", () => {
      const single = { from: new Date(), to: new Date(), fromIso: "2026-09-01", toIso: "2026-09-30" };
      const set = toPeriodSet(single as any);
      expect(set.fixation).toBe(single);
      expect(set.meeting).toBe(single);
      expect(set.deal).toBe(single);
    });

    it("пусто остаётся пустым", () => {
      expect(toPeriodSet(undefined)).toEqual({});
    });
  });
});
