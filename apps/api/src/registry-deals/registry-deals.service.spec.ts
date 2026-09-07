import { BadRequestException } from '@nestjs/common';
import { RegistryDealsService } from './registry-deals.service';

describe('RegistryDealsService', () => {
  const prisma = {
    registryDeal: {
      groupBy: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    client: {
      findMany: jest.fn(),
    },
  };
  let service: RegistryDealsService;

  beforeEach(() => {
    prisma.registryDeal.groupBy.mockReset();
    prisma.registryDeal.count.mockReset();
    prisma.registryDeal.findMany.mockReset();
    prisma.client.findMany.mockReset();
    service = new RegistryDealsService(prisma as any);
  });

  describe('getAgencies', () => {
    it('считает только оплаченные ДДУ (paidAt), сортирует по сделкам, добавляет платные брони', async () => {
      prisma.registryDeal.groupBy
        // 1-й вызов — оплаченные сделки по агентствам
        .mockResolvedValueOnce([
          {
            agencyCanonical: 'Small Agency',
            _count: { _all: 2 },
            _sum: { amount: '1000.50' },
            _min: { paidAt: new Date('2026-01-10') },
            _max: { paidAt: new Date('2026-02-20') },
          },
          {
            agencyCanonical: 'Big Agency',
            _count: { _all: 5 },
            _sum: { amount: null },
            _min: { paidAt: null },
            _max: { paidAt: null },
          },
        ])
        // 2-й вызов — оплаченные строки с amoLeadId
        .mockResolvedValueOnce([
          { agencyCanonical: 'Small Agency', _count: { _all: 1 } },
        ])
        // 3-й вызов — платные брони (dvouPaidAt), в т.ч. агентство без ДДУ
        .mockResolvedValueOnce([
          { agencyCanonical: 'Big Agency', _count: { _all: 4 } },
          { agencyCanonical: 'Bookings Only', _count: { _all: 1 } },
        ]);

      const result = await service.getAgencies();

      expect(result).toEqual([
        {
          agencyCanonical: 'Big Agency',
          deals: 5,
          amountSum: 0,
          firstDeal: null,
          lastDeal: null,
          linkedLeads: 0,
          paidBookings: 4,
        },
        {
          agencyCanonical: 'Small Agency',
          deals: 2,
          amountSum: 1000.5,
          firstDeal: new Date('2026-01-10'),
          lastDeal: new Date('2026-02-20'),
          linkedLeads: 1,
          paidBookings: 0,
        },
        {
          agencyCanonical: 'Bookings Only',
          deals: 0,
          amountSum: 0,
          firstDeal: null,
          lastDeal: null,
          linkedLeads: 0,
          paidBookings: 1,
        },
      ]);

      // Сделки — только строки с датой оплаты ДДУ; даты первой/последней — по paidAt.
      expect(prisma.registryDeal.groupBy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          by: ['agencyCanonical'],
          where: { agencyCanonical: { not: null }, paidAt: { not: null } },
          _min: { paidAt: true },
          _max: { paidAt: true },
        }),
      );
      expect(prisma.registryDeal.groupBy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            agencyCanonical: { not: null },
            paidAt: { not: null },
            amoLeadId: { not: null },
          },
        }),
      );
      expect(prisma.registryDeal.groupBy).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          where: { agencyCanonical: { not: null }, dvouPaidAt: { not: null } },
        }),
      );
    });
  });

  describe('getSummary', () => {
    it('returns totals, bySource, paid deals, unpaid rows and paid bookings', async () => {
      prisma.registryDeal.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(4) // withBroker
        .mockResolvedValueOnce(7) // withAgency
        .mockResolvedValueOnce(8) // paidDeals
        .mockResolvedValueOnce(6); // paidBookings
      prisma.registryDeal.groupBy.mockResolvedValueOnce([
        { source: 'REGISTRY', _count: { _all: 6 } },
        { source: 'BOTH', _count: { _all: 3 } },
        { source: 'AMO_ONLY', _count: { _all: 1 } },
      ]);

      await expect(service.getSummary()).resolves.toEqual({
        total: 10,
        bySource: { REGISTRY: 6, BOTH: 3, AMO_ONLY: 1 },
        withBroker: 4,
        withAgency: 7,
        paidDeals: 8,
        unpaidRows: 2,
        paidBookings: 6,
      });

      expect(prisma.registryDeal.count).toHaveBeenNthCalledWith(1);
      expect(prisma.registryDeal.count).toHaveBeenNthCalledWith(2, {
        where: { brokerId: { not: null } },
      });
      expect(prisma.registryDeal.count).toHaveBeenNthCalledWith(3, {
        where: { agencyCanonical: { not: null } },
      });
      expect(prisma.registryDeal.count).toHaveBeenNthCalledWith(4, {
        where: { paidAt: { not: null } },
      });
      expect(prisma.registryDeal.count).toHaveBeenNthCalledWith(5, {
        where: { dvouPaidAt: { not: null } },
      });
    });
  });

  describe('getSeries', () => {
    it('строит ряд по дням: сделки по paidAt, брони по dvouPaidAt, фиксации по createdAt, с проектом', async () => {
      prisma.registryDeal.findMany
        .mockResolvedValueOnce([
          { paidAt: new Date('2026-09-01T00:00:00.000Z'), amount: '10000000.00', project: 'ZORGE9' },
        ])
        .mockResolvedValueOnce([
          { dvouPaidAt: new Date('2026-09-02T00:00:00.000Z'), dvouAmount: '50000.00', project: 'ZORGE9' },
        ]);
      prisma.client.findMany.mockResolvedValueOnce([
        { createdAt: new Date('2026-09-02T09:00:00.000Z'), project: 'ZORGE9' },
        { createdAt: new Date('2026-09-02T10:00:00.000Z'), project: 'ZORGE9' },
      ]);

      const result = await service.getSeries({
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-02T20:59:59.000Z', // 23:59:59 МСК 02.09
        granularity: 'day',
        project: 'ZORGE9',
      });

      expect(result.granularity).toBe('day');
      expect(result.project).toBe('ZORGE9');
      expect(result.buckets.map((b) => [b.key, b.deals, b.paidBookings, b.fixations])).toEqual([
        ['2026-09-01', 1, 0, 0],
        ['2026-09-02', 0, 1, 2],
      ]);
      expect(result.totals).toEqual({
        deals: 1,
        dealAmount: '10000000.00',
        paidBookings: 1,
        paidBookingAmount: '50000.00',
        fixations: 2,
      });
      expect(result.methodology.deals).toContain('Датой оплаты ДДУ');

      const range = {
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-02T20:59:59.000Z'),
      };
      expect(prisma.registryDeal.findMany).toHaveBeenNthCalledWith(1, {
        where: { paidAt: range, project: 'ZORGE9' },
        select: { paidAt: true, amount: true, project: true },
      });
      expect(prisma.registryDeal.findMany).toHaveBeenNthCalledWith(2, {
        where: { dvouPaidAt: range, project: 'ZORGE9' },
        select: { dvouPaidAt: true, dvouAmount: true, project: true },
      });
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: range,
            project: 'ZORGE9',
            broker: { is: { role: 'BROKER', mergedIntoId: null } },
          }),
        }),
      );
    });

    it('по умолчанию — помесячно, 12 корзин до текущего месяца; без фильтра проекта', async () => {
      prisma.registryDeal.findMany.mockResolvedValue([]);
      prisma.client.findMany.mockResolvedValue([]);
      const result = await service.getSeries({});
      expect(result.granularity).toBe('month');
      expect(result.project).toBeNull();
      expect(result.buckets).toHaveLength(12);
      expect(prisma.registryDeal.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ where: { paidAt: expect.any(Object) } }),
      );
    });

    it('отклоняет перевёрнутый и слишком длинный период', async () => {
      await expect(
        service.getSeries({ from: '2026-09-02T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.getSeries({ from: '2019-01-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z', granularity: 'day' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.registryDeal.findMany).not.toHaveBeenCalled();
    });
  });
});
