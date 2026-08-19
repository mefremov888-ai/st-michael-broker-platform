import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { PrismaClient } from '@st-michael/database';
import type { Queue } from 'bull';
import {
  HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_READINESS_CACHE_TTL_MS,
  HEALTH_REDIS_QUEUE,
} from './health.constants';

type CheckStatus = 'ok' | 'error';

export interface ReadinessResult {
  status: CheckStatus;
  checks: {
    postgresql: CheckStatus;
    redis: CheckStatus;
  };
  timestamp: string;
}

@Injectable()
export class HealthService {
  private readinessInFlight?: Promise<ReadinessResult>;
  private cachedReadiness?: { result: ReadinessResult; expiresAt: number };

  constructor(
    @Inject('PrismaClient') private readonly prisma: PrismaClient,
    @InjectQueue(HEALTH_REDIS_QUEUE) private readonly redisQueue: Queue,
  ) {}

  async checkReadiness(): Promise<ReadinessResult> {
    const now = Date.now();
    if (this.cachedReadiness && this.cachedReadiness.expiresAt > now) {
      return this.cachedReadiness.result;
    }
    if (this.readinessInFlight) return this.readinessInFlight;

    const check = this.runReadinessChecks()
      .then((result) => {
        this.cachedReadiness = {
          result,
          expiresAt: Date.now() + HEALTH_READINESS_CACHE_TTL_MS,
        };
        return result;
      })
      .finally(() => {
        this.readinessInFlight = undefined;
      });
    this.readinessInFlight = check;
    return check;
  }

  private async runReadinessChecks(): Promise<ReadinessResult> {
    const [postgresql, redis] = await Promise.all([
      this.runCheck(() => this.prisma.$queryRawUnsafe('SELECT 1')),
      this.runCheck(async () => {
        const response = await this.redisQueue.client.ping();

        if (response !== 'PONG') {
          throw new Error('Unexpected Redis PING response');
        }
      }),
    ]);

    return {
      status: postgresql === 'ok' && redis === 'ok' ? 'ok' : 'error',
      checks: { postgresql, redis },
      timestamp: new Date().toISOString(),
    };
  }

  private async runCheck(check: () => Promise<unknown>): Promise<CheckStatus> {
    let timeout: ReturnType<typeof setTimeout>;

    try {
      await Promise.race([
        Promise.resolve().then(check),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Readiness check timed out')),
            HEALTH_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return 'ok';
    } catch {
      return 'error';
    } finally {
      clearTimeout(timeout!);
    }
  }
}
