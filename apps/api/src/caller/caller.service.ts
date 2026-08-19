import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PUBLIC_CALL_SELECT, toPublicCall } from '../common/public-call';

@Injectable()
export class CallerService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    @InjectQueue('calls') private callQueue: Queue,
  ) {}

  async getCalls(
    brokerId: string,
    query: {
      page?: number;
      limit?: number;
      direction?: string;
      status?: string;
    },
  ) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = { brokerId };
    if (query.direction) where.direction = query.direction;
    if (query.status) where.status = query.status;

    const [calls, total] = await Promise.all([
      this.prisma.call.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: PUBLIC_CALL_SELECT,
      }),
      this.prisma.call.count({ where }),
    ]);

    return {
      calls: calls.map((call) => toPublicCall(call as any)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async scheduleCalls(data: {
    brokerIds: string[];
    cycleDay: number;
    scheduledAt?: string;
  }) {
    const jobs = [];

    for (const brokerId of data.brokerIds) {
      const broker = await this.prisma.broker.findUnique({
        where: { id: brokerId },
      });

      if (!broker || broker.doNotCall) continue;

      const job = await this.callQueue.add(
        'outbound-call',
        {
          brokerId,
          brokerPhone: broker.phone,
          brokerName: broker.fullName,
          cycleDay: data.cycleDay,
          bestCallTime: broker.bestCallTime,
        },
        {
          delay: data.scheduledAt
            ? new Date(data.scheduledAt).getTime() - Date.now()
            : 0,
          attempts: 3,
          backoff: { type: 'exponential', delay: 60000 },
        },
      );

      jobs.push({ brokerId, jobId: job.id });
    }

    return {
      message: `${jobs.length} calls scheduled`,
      jobs,
    };
  }

  async getCallStats(brokerId: string) {
    const [total, completed, noAnswer, meetingScheduled] = await Promise.all([
      this.prisma.call.count({ where: { brokerId } }),
      this.prisma.call.count({ where: { brokerId, status: 'COMPLETED' } }),
      this.prisma.call.count({ where: { brokerId, status: 'NO_ANSWER' } }),
      this.prisma.call.count({ where: { brokerId, result: 'MEETING_SCHEDULED' } }),
    ]);

    return {
      total,
      completed,
      noAnswer,
      meetingScheduled,
      answerRate: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }
}
