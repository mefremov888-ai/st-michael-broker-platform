import { Injectable, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class NotificationService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  async sendNotification(data: {
    brokerId: string;
    channel: string;
    subject?: string;
    body: string;
  }) {
    // Add to queue
    await this.notificationQueue.add('send', data);

    // Save to DB
    const notification = await this.prisma.notification.create({
      data,
    });

    return notification;
  }

  // Queue processor would be in a separate file
}