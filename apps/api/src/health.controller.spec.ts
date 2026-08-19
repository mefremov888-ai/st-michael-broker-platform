import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const healthService = {
    checkReadiness: jest.fn(),
  };
  let controller: HealthController;

  beforeEach(() => {
    healthService.checkReadiness.mockReset();
    controller = new HealthController(healthService as any);
  });

  it('keeps the liveness check shallow', () => {
    const result = controller.check();

    expect(result).toEqual({
      status: 'ok',
      timestamp: expect.any(String),
    });
    expect(healthService.checkReadiness).not.toHaveBeenCalled();
  });

  it('returns readiness details when all dependencies are available', async () => {
    const readiness = {
      status: 'ok' as const,
      checks: { postgresql: 'ok' as const, redis: 'ok' as const },
      timestamp: '2026-08-18T12:00:00.000Z',
    };
    healthService.checkReadiness.mockResolvedValue(readiness);

    await expect(controller.checkReadiness()).resolves.toBe(readiness);
  });

  it('returns HTTP 503 with a safe response when a dependency is unavailable', async () => {
    const readiness = {
      status: 'error' as const,
      checks: { postgresql: 'error' as const, redis: 'ok' as const },
      timestamp: '2026-08-18T12:00:00.000Z',
    };
    healthService.checkReadiness.mockResolvedValue(readiness);

    try {
      await controller.checkReadiness();
      throw new Error('Expected readiness check to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      expect((error as ServiceUnavailableException).getResponse()).toEqual(
        readiness,
      );
    }
  });
});
