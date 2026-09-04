import { RegistryDealsService } from './registry-deals.service';

describe('RegistryDealsService', () => {
  const prisma = {
    registryDeal: {
      groupBy: jest.fn(),
      count: jest.fn(),
    },
  };
  let service: RegistryDealsService;

  beforeEach(() => {
    prisma.registryDeal.groupBy.mockReset();
    prisma.registryDeal.count.mockReset();
    service = new RegistryDealsService(prisma as any);
  });

  describe('getAgencies', () => {
    it('aggregates by agency, sorts by deals desc and fills linkedLeads', async () => {
      prisma.registryDeal.groupBy
        // 1-й вызов — общая группировка
        .mockResolvedValueOnce([
          {
            agencyCanonical: 'Small Agency',
            _count: { _all: 2 },
            _sum: { amount: '1000.50' },
            _min: { signedAt: new Date('2026-01-10') },
            _max: { signedAt: new Date('2026-02-20') },
          },
          {
            agencyCanonical: 'Big Agency',
            _count: { _all: 5 },
            _sum: { amount: null },
            _min: { signedAt: null },
            _max: { signedAt: null },
          },
        ])
        // 2-й вызов — только строки с amoLeadId
        .mockResolvedValueOnce([
          { agencyCanonical: 'Small Agency', _count: { _all: 1 } },
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
        },
        {
          agencyCanonical: 'Small Agency',
          deals: 2,
          amountSum: 1000.5,
          firstDeal: new Date('2026-01-10'),
          lastDeal: new Date('2026-02-20'),
          linkedLeads: 1,
        },
      ]);

      // Обе группировки — только по строкам с agencyCanonical
      expect(prisma.registryDeal.groupBy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          by: ['agencyCanonical'],
          where: { agencyCanonical: { not: null } },
        }),
      );
      expect(prisma.registryDeal.groupBy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { agencyCanonical: { not: null }, amoLeadId: { not: null } },
        }),
      );
    });
  });

  describe('getSummary', () => {
    it('returns totals and a bySource breakdown', async () => {
      prisma.registryDeal.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(4) // withBroker
        .mockResolvedValueOnce(7); // withAgency
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
      });

      expect(prisma.registryDeal.count).toHaveBeenNthCalledWith(1);
      expect(prisma.registryDeal.count).toHaveBeenNthCalledWith(2, {
        where: { brokerId: { not: null } },
      });
      expect(prisma.registryDeal.count).toHaveBeenNthCalledWith(3, {
        where: { agencyCanonical: { not: null } },
      });
    });
  });
});
