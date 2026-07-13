import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { PrismaClient } from '@st-michael/database';
import type { NotificationChannel } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

interface SubscribePayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Catalog of notification event types — front renders the matrix from this.
// Keep in sync with notification triggers (scheduler.service, fixation flow, etc).
export const NOTIFICATION_EVENTS = [
  { type: 'NEW_LOTS', label: 'Новые лоты по фильтрам', icon: '🏠' },
  { type: 'PROMOTIONS', label: 'Новые акции и спецпредложения', icon: '🔥' },
  { type: 'COMMISSION_ACCRUED', label: 'Начисление комиссии', icon: '💰' },
  { type: 'COMMISSION_PAID', label: 'Выплата комиссии', icon: '💳' },
  { type: 'FIXATION_EXPIRY', label: 'Истечение срока фиксации', icon: '⏰' },
  { type: 'MEETING_REMINDER', label: 'Напоминание о встрече', icon: '📅' },
  { type: 'BOOKING_CONFIRMED', label: 'Подтверждение брони', icon: '✅' },
  { type: 'DEAL_STATUS', label: 'Смена статуса сделки', icon: '📝' },
  { type: 'ANNOUNCEMENTS', label: 'Объявления застройщика', icon: '📢' },
] as const;

// 2026-07-02: работают только EMAIL (через SendGrid) и PUSH (VAPID).
// TELEGRAM/SMS/WHATSAPP убраны из UI т.к. не подключены.
const NOTIFICATION_CHANNELS: NotificationChannel[] = ['EMAIL', 'PUSH'];

@Controller('notifications')
export class NotificationController {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  // 2026-07-02: test-endpoint для проверки что SendGrid реально отправляет.
  // Отсылает подтверждающий email на broker.email. Только под JWT.
  @UseGuards(AuthGuard('jwt'))
  @Post('test-email')
  async testEmail(@Req() req: Request) {
    const brokerAuth = req.user as { id: string };
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerAuth.id },
      select: { id: true, email: true, fullName: true },
    });
    if (!broker) return { ok: false, message: 'Broker not found' };
    if (!broker.email) return { ok: false, message: 'В профиле не задан email' };
    await this.notificationQueue.add('send', {
      brokerId: broker.id,
      channel: 'EMAIL',
      subject: 'ST Michael — тест уведомлений',
      body: `Здравствуйте, ${broker.fullName}!\n\nЭто тестовое письмо от системы уведомлений ST Michael.\nЕсли вы его получили, значит канал Email через SendGrid работает.\n\n— ST Michael Кабинет брокера`,
    });
    return { ok: true, sentTo: broker.email };
  }

  // Public — клиенту нужен публичный VAPID-ключ до подписки
  @Get('push/vapid-key')
  getVapidKey() {
    return { publicKey: process.env.VAPID_PUBLIC_KEY || '' };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('push/subscribe')
  async subscribe(@Req() req: Request, @Body() body: SubscribePayload) {
    const broker = req.user as { id: string };
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
      return { ok: false, message: 'Invalid subscription payload' };
    }

    const userAgent = req.headers['user-agent'] || null;

    // Upsert by endpoint — same browser/device re-subscribes after permission reset
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      update: {
        brokerId: broker.id,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent,
      },
      create: {
        brokerId: broker.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent,
      },
    });

    return { ok: true };
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete('push/unsubscribe')
  async unsubscribe(@Req() req: Request, @Query('endpoint') endpoint?: string) {
    const broker = req.user as { id: string };

    if (endpoint) {
      await this.prisma.pushSubscription.deleteMany({
        where: { endpoint, brokerId: broker.id },
      });
    } else {
      // No endpoint — drop all subscriptions for this broker (e.g. logout-everywhere)
      await this.prisma.pushSubscription.deleteMany({
        where: { brokerId: broker.id },
      });
    }

    return { ok: true };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('push/status')
  async status(@Req() req: Request) {
    const broker = req.user as { id: string };
    const count = await this.prisma.pushSubscription.count({
      where: { brokerId: broker.id },
    });
    return { subscribed: count > 0, count };
  }

  // ─── Notification preferences ────────────────────────────────

  @UseGuards(AuthGuard('jwt'))
  @Get('preferences')
  async getPreferences(@Req() req: Request) {
    const broker = req.user as { id: string };
    const rows = await this.prisma.notificationPreference.findMany({
      where: { brokerId: broker.id },
    });

    // Build a map { eventType: { channel: enabled } }, defaulting to true (opt-out model).
    const map: Record<string, Record<string, boolean>> = {};
    for (const ev of NOTIFICATION_EVENTS) {
      map[ev.type] = {};
      for (const ch of NOTIFICATION_CHANNELS) {
        map[ev.type][ch] = true;
      }
    }
    for (const r of rows) {
      if (!map[r.eventType]) map[r.eventType] = {};
      map[r.eventType][r.channel] = r.enabled;
    }

    return { events: NOTIFICATION_EVENTS, channels: NOTIFICATION_CHANNELS, preferences: map };
  }

  @UseGuards(AuthGuard('jwt'))
  @Put('preferences')
  async updatePreferences(
    @Req() req: Request,
    @Body() body: { preferences: Record<string, Record<string, boolean>> },
  ) {
    const broker = req.user as { id: string };
    if (!body?.preferences || typeof body.preferences !== 'object') {
      return { ok: false, message: 'Invalid payload' };
    }

    const validEvents = new Set(NOTIFICATION_EVENTS.map((e) => e.type));
    const validChannels = new Set(NOTIFICATION_CHANNELS as string[]);

    const ops: Promise<any>[] = [];
    for (const [eventType, channels] of Object.entries(body.preferences)) {
      if (!validEvents.has(eventType as any)) continue;
      for (const [channel, enabled] of Object.entries(channels)) {
        if (!validChannels.has(channel)) continue;
        ops.push(
          this.prisma.notificationPreference.upsert({
            where: {
              brokerId_eventType_channel: {
                brokerId: broker.id,
                eventType,
                channel: channel as NotificationChannel,
              },
            },
            update: { enabled: !!enabled },
            create: {
              brokerId: broker.id,
              eventType,
              channel: channel as NotificationChannel,
              enabled: !!enabled,
            },
          }),
        );
      }
    }

    await Promise.all(ops);
    return { ok: true, updated: ops.length };
  }
}
