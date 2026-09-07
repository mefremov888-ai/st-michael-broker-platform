import {
  bucketKey,
  bucketLabel,
  bucketRange,
  buildSeries,
  enumerateBuckets,
  moscowDateKey,
  toCents,
  centsToMoneyString,
} from './registry-series';

describe('registry-series (Europe/Moscow buckets)', () => {
  it('moscowDateKey: 23:30 UTC — уже следующий московский день', () => {
    expect(moscowDateKey(new Date('2026-08-31T23:30:00.000Z'))).toBe('2026-09-01');
    expect(moscowDateKey(new Date('2026-08-31T20:59:59.000Z'))).toBe('2026-08-31');
  });

  it('bucketKey: день / неделя с понедельника / месяц', () => {
    const sunday = new Date('2026-09-06T12:00:00.000Z'); // воскресенье 06.09.2026
    expect(bucketKey(sunday, 'day')).toBe('2026-09-06');
    expect(bucketKey(sunday, 'week')).toBe('2026-08-31'); // понедельник
    expect(bucketKey(sunday, 'month')).toBe('2026-09');
    const monday = new Date('2026-09-06T21:00:00.000Z'); // 00:00 МСК понедельника 07.09
    expect(bucketKey(monday, 'week')).toBe('2026-09-07');
  });

  it('bucketRange: границы в UTC со сдвигом −3ч', () => {
    expect(bucketRange('2026-09-07', 'day').from.toISOString()).toBe('2026-09-06T21:00:00.000Z');
    expect(bucketRange('2026-09-07', 'week').to.toISOString()).toBe('2026-09-13T21:00:00.000Z');
    expect(bucketRange('2026-02', 'month').to.toISOString()).toBe('2026-02-28T21:00:00.000Z');
  });

  it('enumerateBuckets: покрывает период, включая нулевые корзины', () => {
    const from = new Date('2026-08-30T00:00:00.000Z');
    const to = new Date('2026-09-02T00:00:00.000Z');
    expect(enumerateBuckets(from, to, 'day')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
    expect(enumerateBuckets(from, to, 'week')).toEqual(['2026-08-24', '2026-08-31']);
    expect(enumerateBuckets(new Date('2025-11-15T00:00:00.000Z'), to, 'month')).toEqual([
      '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
    expect(enumerateBuckets(to, from, 'day')).toEqual([]);
  });

  it('bucketLabel по-русски', () => {
    expect(bucketLabel('2026-09-07', 'day')).toBe('07.09.2026');
    expect(bucketLabel('2026-09-07', 'week')).toBe('нед. с 07.09.2026');
    expect(bucketLabel('2026-09', 'month')).toBe('сентябрь 2026');
  });

  it('деньги: копейки без плавающей точки', () => {
    expect(toCents('12345678.50')).toBe(1234567850);
    expect(toCents('0.1')).toBe(10);
    expect(toCents(null)).toBe(0);
    expect(centsToMoneyString(1234567850 + 10)).toBe('12345678.60');
  });

  it('buildSeries: сделки по paidAt, брони по dvouPaidAt, фиксации по createdAt, разрез по проекту', () => {
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-09-03T20:59:59.999Z'); // 23:59:59 МСК 03.09
    const result = buildSeries(
      { from, to, granularity: 'day' },
      {
        deals: [
          { date: new Date('2026-09-01T10:00:00.000Z'), project: 'ZORGE9', amount: '10000000.00' },
          { date: new Date('2026-09-01T18:30:00.000Z'), project: 'SILVER_BOR', amount: '5000000.50' },
          { date: new Date('2026-09-05T10:00:00.000Z'), project: 'ZORGE9', amount: '1' }, // вне периода
          { date: null, project: 'ZORGE9', amount: '1' }, // без даты — не считается
        ],
        paidBookings: [{ date: '2026-09-02', project: null, amount: '50000' }],
        fixations: [
          { date: new Date('2026-09-02T21:30:00.000Z'), project: 'ZORGE9' }, // 00:30 МСК 03.09
          { date: new Date('2026-09-03T05:00:00.000Z'), project: 'ZORGE9' },
        ],
      },
    );
    expect(result.buckets.map((b) => b.key)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(result.buckets[0]).toMatchObject({
      deals: 2,
      dealAmount: '15000000.50',
      paidBookings: 0,
      fixations: 0,
      byProject: {
        SILVER_BOR: { deals: 1, dealAmount: '5000000.50' },
        ZORGE9: { deals: 1, dealAmount: '10000000.00' },
      },
    });
    expect(result.buckets[1]).toMatchObject({ paidBookings: 1, paidBookingAmount: '50000.00', fixations: 0 });
    expect(result.buckets[1].byProject.UNKNOWN.paidBookings).toBe(1);
    expect(result.buckets[2]).toMatchObject({ fixations: 2, deals: 0 });
    expect(result.totals).toEqual({
      deals: 2,
      dealAmount: '15000000.50',
      paidBookings: 1,
      paidBookingAmount: '50000.00',
      fixations: 2,
    });
    expect(result.totalsByProject.ZORGE9.fixations).toBe(2);
  });
});
