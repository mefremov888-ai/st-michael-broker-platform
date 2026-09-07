import { Injectable, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaClient } from '@st-michael/database';
import type { NotificationChannel } from '@st-michael/database';

@Injectable()
export class NotificationService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  async sendNotification(data: {
    brokerId: string;
    channel: NotificationChannel;
    subject?: string;
    body: string;
    eventType?: string;
    data?: { url?: string; tag?: string; icon?: string };
  }) {
    await this.notificationQueue.add('send', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    return { message: 'Notification queued' };
  }

  async getNotifications(brokerId: string, query: { page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { brokerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where: { brokerId } }),
    ]);

    return { notifications, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
