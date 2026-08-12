import { AnalyticsService } from './analytics.service';
import { BadRequestException } from '@nestjs/common';

describe('AnalyticsService.getAdminOverview', () => {
  const from = '2026-07-01T00:00:00.000Z';
  const to = '2026-07-31T23:59:59.999Z';

  function createService(overrides: {
    tourClients?: any[];
    tourDeals?: any[];
    registrationBrokers?: Array<{ createdAt: Date }>;
    fixationGroups?: any[];
    tourBrokers?: Array<{ id: string; brokerTourDate: Date | null }>;
  } = {}) {
    const tourDate = new Date('2026-07-10T09:00:00.000Z');
    const canonicalBrokers = [
      {
        id: 'broker-a',
        fullName: 'Анна Агент',
        phone: '+70000000001',
        brokerTourVisited: true,
        brokerTourDate: tourDate,
      },
      {
        id: 'broker-b',
        fullName: 'Борис Брокер',
        phone: '+70000000002',
        brokerTourVisited: true,
        brokerTourDate: tourDate,
      },
      {
        id: 'broker-zero',
        fullName: 'Зоя Ноль',
        phone: '+70000000003',
        brokerTourVisited: false,
        brokerTourDate: null,
      },
    ];
    const fixationGroups = overrides.fixationGroups || [
      {
        brokerId: 'broker-a',
        responsibleBrokerId: null,
        uniquenessStatus: 'CONDITIONALLY_UNIQUE',
        fixationStatus: 'FIXED',
        _count: 2,
      },
      {
        brokerId: 'broker-a',
        responsibleBrokerId: 'broker-b',
        uniquenessStatus: 'REJECTED',
        fixationStatus: 'NOT_FIXED',
        _count: 3,
      },
      {
        brokerId: 'broker-b',
        responsibleBrokerId: null,
        uniquenessStatus: 'EXPIRED',
        fixationStatus: 'FIXED',
        _count: 1,
      },
      {
        brokerId: 'manager',
        responsibleBrokerId: null,
        uniquenessStatus: 'CONDITIONALLY_UNIQUE',
        fixationStatus: 'FIXED',
        _count: 7,
      },
    ];
    const tourClients = overrides.tourClients || [
      {
        brokerId: 'broker-a',
        responsibleBrokerId: null,
        amoCreatedAt: new Date(tourDate.getTime() + 1),
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
      },
      {
        brokerId: 'broker-a',
        responsibleBrokerId: 'broker-b',
        amoCreatedAt: null,
        createdAt: tourDate,
      },
    ];
    const tourDeals = overrides.tourDeals || [
      {
        signedAt: new Date(tourDate.getTime() + 1),
        createdAt: new Date(tourDate.getTime() - 1000),
        client: {
          brokerId: 'broker-a',
          responsibleBrokerId: null,
          amoCreatedAt: new Date(tourDate.getTime() + 1),
          createdAt: new Date(tourDate.getTime() - 1000),
        },
      },
      {
        signedAt: tourDate,
        createdAt: new Date(tourDate.getTime() + 1000),
        client: {
          brokerId: 'broker-a',
          responsibleBrokerId: null,
          amoCreatedAt: new Date(tourDate.getTime() + 1),
          createdAt: new Date(tourDate.getTime() - 1000),
        },
      },
      {
        signedAt: new Date(tourDate.getTime() + 1),
        createdAt: new Date(tourDate.getTime() + 1),
        client: {
          brokerId: 'broker-a',
          responsibleBrokerId: 'broker-b',
          amoCreatedAt: null,
          createdAt: tourDate,
        },
      },
    ];

    let brokerFindManyCall = 0;
    let clientFindManyCall = 0;
    const prisma = {
      broker: {
        count: jest.fn().mockResolvedValue(3),
        findMany: jest.fn().mockImplementation((args: any) => {
          brokerFindManyCall++;
          if (args?.where?.brokerTourVisited) {
            return Promise.resolve(overrides.tourBrokers ?? [
              { id: 'broker-a', brokerTourDate: tourDate },
              { id: 'broker-b', brokerTourDate: tourDate },
            ]);
          }
          if (args?.where?.id?.in) return Promise.resolve([]);
          if (args?.where?.createdAt) return Promise.resolve(overrides.registrationBrokers || []);
          if (args?.where?.role === 'BROKER' && args?.where?.mergedIntoId === null) {
            return Promise.resolve(canonicalBrokers);
          }
          return Promise.resolve([]);
        }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      client: {
        groupBy: jest.fn().mockResolvedValue(fixationGroups),
        findMany: jest.fn().mockImplementation(() => {
          clientFindManyCall++;
          return Promise.resolve(tourClients);
        }),
      },
      deal: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue(tourDeals),
      },
    };

    return {
      service: new AnalyticsService(prisma as any),
      prisma,
      getBrokerFindManyCallCount: () => brokerFindManyCall,
      getClientFindManyCallCount: () => clientFindManyCall,
    };
  }

  it('aggregates all canonical brokers by effective broker and keeps submitter attribution', async () => {
    const { service, prisma } = createService();

    const result = await service.getAdminOverview({ startDate: from, endDate: to });

    expect(prisma.client.groupBy).toHaveBeenCalledWith({
      by: ['brokerId', 'responsibleBrokerId', 'uniquenessStatus', 'fixationStatus'],
      where: {
        AND: [
          {
            OR: [
              {
                amoCreatedAt: {
                  gte: new Date(from),
                  lt: new Date('2026-08-01T00:00:00.000Z'),
                },
              },
              {
                amoCreatedAt: null,
                createdAt: {
                  gte: new Date(from),
                  lt: new Date('2026-08-01T00:00:00.000Z'),
                },
              },
            ],
          },
          {
            OR: [
              { responsibleBrokerId: { in: ['broker-a', 'broker-b', 'broker-zero'] } },
              {
                responsibleBrokerId: null,
                brokerId: { in: ['broker-a', 'broker-b', 'broker-zero'] },
              },
            ],
          },
        ],
      },
      _count: true,
    });

    expect(result.fixations).toMatchObject({
      total: 6,
      conditionallyUnique: 2,
      rejected: 3,
      expired: 1,
      fixed: 3,
    });
    expect(result.fixationsByBroker.reduce((sum, row) => sum + row.total, 0))
      .toBe(result.fixations.total);
    expect(result.fixationsByBroker.reduce((sum, row) => sum + row.fixed, 0))
      .toBe(result.fixations.fixed);
    expect(result.fixationsByBroker).toEqual([
      {
        brokerId: 'broker-b',
        fullName: 'Борис Брокер',
        phone: '+70000000002',
        brokerTourVisited: true,
        brokerTourDate: new Date('2026-07-10T09:00:00.000Z'),
        brokerTourInPeriod: true,
        fixationAfterTour: false,
        total: 4,
        conditionallyUnique: 0,
        rejected: 3,
        underReview: 0,
        expired: 1,
        fixed: 1,
        submittedBySelf: 1,
        submittedByOthers: 3,
        submitters: [
          { brokerId: 'broker-a', fullName: 'Анна Агент', count: 3 },
          { brokerId: 'broker-b', fullName: 'Борис Брокер', count: 1 },
        ],
      },
      {
        brokerId: 'broker-a',
        fullName: 'Анна Агент',
        phone: '+70000000001',
        brokerTourVisited: true,
        brokerTourDate: new Date('2026-07-10T09:00:00.000Z'),
        brokerTourInPeriod: true,
        fixationAfterTour: true,
        total: 2,
        conditionallyUnique: 2,
        rejected: 0,
        underReview: 0,
        expired: 0,
        fixed: 2,
        submittedBySelf: 2,
        submittedByOthers: 0,
        submitters: [{ brokerId: 'broker-a', fullName: 'Анна Агент', count: 2 }],
      },
      {
        brokerId: 'broker-zero',
        fullName: 'Зоя Ноль',
        phone: '+70000000003',
        brokerTourVisited: false,
        brokerTourDate: null,
        brokerTourInPeriod: false,
        fixationAfterTour: false,
        total: 0,
        conditionallyUnique: 0,
        rejected: 0,
        underReview: 0,
        expired: 0,
        fixed: 0,
        submittedBySelf: 0,
        submittedByOthers: 0,
        submitters: [],
      },
    ]);
  });

  it('uses the canonical tour cohort and counts only lifetime post-tour fixations', async () => {
    const { service, prisma } = createService();

    const result = await service.getAdminOverview({ startDate: from, endDate: to });

    expect(prisma.broker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: 'BROKER',
          mergedIntoId: null,
          brokerTourVisited: true,
          brokerTourDate: {
            gte: new Date(from),
            lt: new Date('2026-08-01T00:00:00.000Z'),
          },
        },
      }),
    );
    expect(result.brokerTourFunnel).toMatchObject({
      tourVisited: 2,
      withAnyFixation: 1,
      withFixation: 1,
      withDeal: 1,
      toAnyFixationPct: 50,
      toFixationPct: 50,
      toDealPct: 50,
    });
  });

  it('marks only the selected-period tour cohort for the UI list filter', async () => {
    const tourDate = new Date('2026-07-10T09:00:00.000Z');
    const { service } = createService({
      tourBrokers: [{ id: 'broker-a', brokerTourDate: tourDate }],
      tourClients: [],
      tourDeals: [],
    });

    const result = await service.getAdminOverview({ startDate: from, endDate: to });

    expect(result.brokerTourFunnel.tourVisited).toBe(1);
    expect(result.fixationsByBroker.find((row) => row.brokerId === 'broker-a'))
      .toMatchObject({ brokerTourVisited: true, brokerTourInPeriod: true });
    expect(result.fixationsByBroker.find((row) => row.brokerId === 'broker-b'))
      .toMatchObject({ brokerTourVisited: true, brokerTourInPeriod: false });
  });
  it('treats fixation at the tour timestamp as not converted and +1 ms as converted', async () => {
    const tourDate = new Date('2026-07-10T09:00:00.000Z');
    const { service } = createService({
      tourClients: [
        {
          brokerId: 'broker-a',
          responsibleBrokerId: null,
          amoCreatedAt: tourDate,
          createdAt: new Date(tourDate.getTime() - 1000),
        },
        {
          brokerId: 'broker-a',
          responsibleBrokerId: 'broker-b',
          amoCreatedAt: null,
          createdAt: new Date(tourDate.getTime() + 1),
        },
      ],
      tourDeals: [],
    });

    const result = await service.getAdminOverview({ startDate: from, endDate: to });

    expect(result.brokerTourFunnel).toMatchObject({
      withAnyFixation: 1,
      withFixation: 1,
    });
    expect(result.fixationsByBroker.find((row) => row.brokerId === 'broker-a')?.fixationAfterTour)
      .toBe(false);
    expect(result.fixationsByBroker.find((row) => row.brokerId === 'broker-b')?.fixationAfterTour)
      .toBe(true);
  });

  it('counts only sequential post-tour paid deals by the Client effective broker', async () => {
    const tourDate = new Date('2026-07-10T09:00:00.000Z');
    const delegatedAfterTourClient = {
      brokerId: 'broker-a',
      responsibleBrokerId: 'broker-b',
      amoCreatedAt: null,
      createdAt: new Date(tourDate.getTime() + 1),
    };
    const { service } = createService({
      tourClients: [delegatedAfterTourClient],
      tourDeals: [
        {
          signedAt: new Date(tourDate.getTime() + 1),
          createdAt: new Date(tourDate.getTime() - 1000),
          client: delegatedAfterTourClient,
        },
        {
          signedAt: tourDate,
          createdAt: new Date(tourDate.getTime() + 1000),
          client: {
            brokerId: 'broker-a',
            responsibleBrokerId: null,
            amoCreatedAt: new Date(tourDate.getTime() + 1),
            createdAt: new Date(tourDate.getTime() - 1000),
          },
        },
        {
          signedAt: new Date(tourDate.getTime() + 1),
          createdAt: new Date(tourDate.getTime() + 1),
          client: {
            brokerId: 'broker-a',
            responsibleBrokerId: null,
            amoCreatedAt: tourDate,
            createdAt: new Date(tourDate.getTime() - 1000),
          },
        },
      ],
    });

    const result = await service.getAdminOverview({ startDate: from, endDate: to });

    expect(result.brokerTourFunnel).toMatchObject({
      withAnyFixation: 1,
      withDeal: 1,
      toDealPct: 50,
    });
    expect(result.fixationsByBroker.find((row) => row.brokerId === 'broker-b')?.fixationAfterTour)
      .toBe(true);
  });

  it('interprets date-only boundaries as Moscow days and groups trend in Moscow time', async () => {
    const { service, prisma } = createService({
      registrationBrokers: [
        { createdAt: new Date('2026-06-30T21:00:00.000Z') },
        { createdAt: new Date('2026-07-01T20:59:59.999Z') },
      ],
    });

    const result = await service.getAdminOverview({
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });

    expect(result.period).toEqual({
      from: '2026-06-30T21:00:00.000Z',
      to: '2026-07-01T20:59:59.999Z',
    });
    expect(result.brokers.registrationTrend).toEqual([{ date: '2026-07-01', count: 2 }]);
    expect(prisma.client.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                {
                  amoCreatedAt: {
                    gte: new Date('2026-06-30T21:00:00.000Z'),
                    lt: new Date('2026-07-01T21:00:00.000Z'),
                  },
                },
                {
                  amoCreatedAt: null,
                  createdAt: {
                    gte: new Date('2026-06-30T21:00:00.000Z'),
                    lt: new Date('2026-07-01T21:00:00.000Z'),
                  },
                },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it.each([
    [{ startDate: 'not-a-date', endDate: '2026-07-31' }],
    [{ startDate: '2026-02-30', endDate: '2026-07-31' }],
    [{ startDate: '2026-08-01', endDate: '2026-07-31' }],
  ])('rejects invalid or reversed periods: %p', async (period) => {
    const { service, prisma } = createService();

    await expect(service.getAdminOverview(period)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.broker.findMany).not.toHaveBeenCalled();
  });

  it('uses canonical role and merged filters for broker KPIs, trend, funnel and sources', async () => {
    const { service, prisma } = createService();

    await service.getAdminOverview({ startDate: from, endDate: to });

    expect(prisma.broker.count).toHaveBeenNthCalledWith(1, {
      where: { role: 'BROKER', mergedIntoId: null },
    });
    for (const call of prisma.broker.count.mock.calls) {
      expect(call[0].where).toMatchObject({ role: 'BROKER', mergedIntoId: null });
    }
    const periodFind = prisma.broker.findMany.mock.calls.find(
      ([args]: any[]) => args?.where?.createdAt,
    );
    expect(periodFind?.[0].where).toMatchObject({ role: 'BROKER', mergedIntoId: null });
    for (const call of prisma.broker.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({ role: 'BROKER', mergedIntoId: null });
    }
  });
});
