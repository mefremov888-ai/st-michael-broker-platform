import { AnalyticsService } from './analytics.service';

describe('AnalyticsService.getAdminOverview', () => {
  const from = '2026-07-01T00:00:00.000Z';
  const to = '2026-07-31T23:59:59.999Z';

  function createService() {
    const tourDate = new Date('2026-07-10T09:00:00.000Z');
    const canonicalBrokers = [
      { id: 'broker-a', fullName: 'Анна Агент', phone: '+70000000001' },
      { id: 'broker-b', fullName: 'Борис Брокер', phone: '+70000000002' },
      { id: 'broker-zero', fullName: 'Зоя Ноль', phone: '+70000000003' },
    ];
    const fixationGroups = [
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
    ];

    let brokerFindManyCall = 0;
    let clientFindManyCall = 0;
    const prisma = {
      broker: {
        count: jest.fn().mockResolvedValue(3),
        findMany: jest.fn().mockImplementation((args: any) => {
          brokerFindManyCall++;
          if (args?.where?.brokerTourVisited) {
            return Promise.resolve([
              { id: 'broker-a', brokerTourDate: tourDate },
              { id: 'broker-b', brokerTourDate: tourDate },
            ]);
          }
          if (args?.where?.role === 'BROKER' && args?.where?.mergedIntoId === null) {
            return Promise.resolve(canonicalBrokers);
          }
          if (args?.where?.id?.in) return Promise.resolve([]);
          if (args?.where?.createdAt) return Promise.resolve([]);
          return Promise.resolve([]);
        }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      client: {
        groupBy: jest.fn().mockResolvedValue(fixationGroups),
        findMany: jest.fn().mockImplementation(() => {
          clientFindManyCall++;
          return Promise.resolve([
            // Uses amoCreatedAt and converts broker A after the tour.
            {
              brokerId: 'broker-a',
              responsibleBrokerId: null,
              amoCreatedAt: new Date('2026-07-11T10:00:00.000Z'),
              createdAt: new Date('2026-07-01T10:00:00.000Z'),
            },
            // Delegated to B, but predates B's tour and must not convert it.
            {
              brokerId: 'broker-a',
              responsibleBrokerId: 'broker-b',
              amoCreatedAt: null,
              createdAt: new Date('2026-07-09T10:00:00.000Z'),
            },
          ]);
        }),
      },
      deal: {
        groupBy: jest.fn().mockResolvedValue([]),
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
        OR: [
          {
            amoCreatedAt: {
              gte: new Date(from),
              lte: new Date(to),
            },
          },
          {
            amoCreatedAt: null,
            createdAt: {
              gte: new Date(from),
              lte: new Date(to),
            },
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
    expect(result.fixationsByBroker).toEqual([
      {
        brokerId: 'broker-b',
        fullName: 'Борис Брокер',
        phone: '+70000000002',
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
          brokerTourDate: { gte: new Date(from), lte: new Date(to) },
        },
      }),
    );
    expect(result.brokerTourFunnel).toMatchObject({
      tourVisited: 2,
      withAnyFixation: 1,
      withFixation: 1,
      toAnyFixationPct: 50,
      toFixationPct: 50,
    });
  });
});
