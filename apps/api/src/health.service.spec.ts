import { HealthService } from './health.service';
import { HEALTH_READINESS_CACHE_TTL_MS } from './health.constants';

describe('HealthService', () => {
  let prisma: { $queryRawUnsafe: jest.Mock };
  let redis: { ping: jest.Mock };
  let service: HealthService;

  beforeEach(() => {
    prisma = { $queryRawUnsafe: jest.fn() };
    redis = { ping: jest.fn() };
    service = new HealthService(prisma as any, { client: redis } as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports ready after PostgreSQL SELECT 1 and Redis PING succeed', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');

    const result = await service.checkReadiness();

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1');
    expect(redis.ping).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'ok',
      checks: { postgresql: 'ok', redis: 'ok' },
      timestamp: expect.any(String),
    });
  });

  it('reports only safe dependency statuses when PostgreSQL fails', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(
      new Error('postgresql://user:secret@database/internal'),
    );
    redis.ping.mockResolvedValue('PONG');

    const result = await service.checkReadiness();

    expect(redis.ping).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'error',
      checks: { postgresql: 'error', redis: 'ok' },
      timestamp: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('reports Redis as unavailable when PING fails', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockRejectedValue(new Error('redis connection failed'));

    const result = await service.checkReadiness();

    expect(result).toEqual({
      status: 'error',
      checks: { postgresql: 'ok', redis: 'error' },
      timestamp: expect.any(String),
    });
  });

  it('shares one in-flight dependency check across concurrent requests', async () => {
    let resolvePostgresql!: (value: unknown) => void;
    prisma.$queryRawUnsafe.mockReturnValue(
      new Promise((resolve) => {
        resolvePostgresql = resolve;
      }),
    );
    redis.ping.mockResolvedValue('PONG');

    const first = service.checkReadiness();
    const second = service.checkReadiness();
    await Promise.resolve();
    await Promise.resolve();

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);

    resolvePostgresql([{ '?column?': 1 }]);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
  });

  it('caches readiness results for a short TTL', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
    prisma.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');

    const first = await service.checkReadiness();
    const cached = await service.checkReadiness();
    expect(cached).toBe(first);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);

    jest.setSystemTime(
      new Date(Date.now() + HEALTH_READINESS_CACHE_TTL_MS + 1),
    );
    await service.checkReadiness();

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(redis.ping).toHaveBeenCalledTimes(2);
  });
});
