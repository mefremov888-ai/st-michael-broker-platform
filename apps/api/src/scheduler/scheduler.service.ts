import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaClient } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  // Run every day at 09:00
  @Cron('0 9 * * *')
  async handleFixationReminders() {
    this.logger.log('Running fixation reminder check...');

    const now = new Date();
    const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const in3days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const in1day = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

    // 7-day reminder
    const expiring7 = await this.prisma.client.findMany({
      where: {
        uniquenessStatus: 'CONDITIONALLY_UNIQUE',
        uniquenessExpiresAt: { gte: now, lte: in7days },
      },
      include: { broker: true },
    });

    for (const client of expiring7) {
      const daysLeft = Math.ceil(
        (client.uniquenessExpiresAt!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      );

      // Only send for exact 7, 3, 1 day boundaries (avoid duplicates)
      if (daysLeft === 7 || daysLeft === 3 || daysLeft === 1) {
        await this.notificationQueue.add('send', {
          brokerId: client.brokerId,
          channel: 'SMS',
          body: `Уникальность клиента ${client.fullName} (${client.phone}) истекает через ${daysLeft} дн. Продлите или завершите фиксацию.`,
        });

        if (client.broker.telegramChatId) {
          await this.notificationQueue.add('send', {
            brokerId: client.brokerId,
            channel: 'TELEGRAM',
            body: `⚠️ Уникальность клиента <b>${client.fullName}</b> истекает через <b>${daysLeft} дн.</b>\nТелефон: ${client.phone}`,
          });
        }

        this.logger.log(`Reminder sent: ${client.fullName} → ${client.broker.fullName} (${daysLeft}d left)`);
      }
    }

    this.logger.log(`Fixation reminders: checked ${expiring7.length} clients`);
  }

  // Run every hour — expire stale fixations
  @Cron(CronExpression.EVERY_HOUR)
  async handleFixationExpiry() {
    const now = new Date();

    // Expire uniqueness
    const expiredUniqueness = await this.prisma.client.updateMany({
      where: {
        uniquenessStatus: 'CONDITIONALLY_UNIQUE',
        uniquenessExpiresAt: { lt: now },
      },
      data: {
        uniquenessStatus: 'EXPIRED',
        uniquenessReason: 'Автоматически истёк срок уникальности',
      },
    });

    if (expiredUniqueness.count > 0) {
      this.logger.log(`Expired ${expiredUniqueness.count} uniqueness records`);

      // Notify brokers about expired clients
      const expiredClients = await this.prisma.client.findMany({
        where: {
          uniquenessStatus: 'EXPIRED',
          uniquenessReason: 'Автоматически истёк срок уникальности',
          updatedAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) }, // Last hour
        },
      });

      for (const client of expiredClients) {
        await this.notificationQueue.add('send', {
          brokerId: client.brokerId,
          channel: 'SMS',
          body: `Уникальность клиента ${client.fullName} (${client.phone}) истекла. Подайте новую заявку для продления.`,
        });
      }
    }

    // Expire fixations
    const expiredFixations = await this.prisma.client.updateMany({
      where: {
        fixationStatus: 'FIXED',
        fixationExpiresAt: { lt: now },
      },
      data: {
        fixationStatus: 'EXPIRED',
      },
    });

    if (expiredFixations.count > 0) {
      this.logger.log(`Expired ${expiredFixations.count} fixation records`);
    }
  }

  // Run daily at 02:00 — cleanup and stats
  @Cron('0 2 * * *')
  async handleDailyMaintenance() {
    this.logger.log('Running daily maintenance...');

    // Update broker funnel stages based on activity
    const brokersWithDeals = await this.prisma.broker.findMany({
      where: {
        funnelStage: { not: 'DEAL' },
        deals: { some: { status: { in: ['PAID', 'COMMISSION_PAID'] } } },
      },
    });

    for (const broker of brokersWithDeals) {
      await this.prisma.broker.update({
        where: { id: broker.id },
        data: { funnelStage: 'DEAL' },
      });
    }

    if (brokersWithDeals.length > 0) {
      this.logger.log(`Updated ${brokersWithDeals.length} broker funnel stages to DEAL`);
    }

    // Log daily stats
    const [totalBrokers, activeBrokers, totalClients, activeFixations, totalDeals] =
      await Promise.all([
        this.prisma.broker.count(),
        this.prisma.broker.count({ where: { status: 'ACTIVE' } }),
        this.prisma.client.count(),
        this.prisma.client.count({ where: { uniquenessStatus: 'CONDITIONALLY_UNIQUE' } }),
        this.prisma.deal.count(),
      ]);

    this.logger.log(
      `Daily stats: ${activeBrokers}/${totalBrokers} brokers, ${totalClients} clients, ${activeFixations} active fixations, ${totalDeals} deals`,
    );
  }
}
