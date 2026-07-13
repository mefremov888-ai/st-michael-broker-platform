import { Process, Processor } from '@nestjs/bull';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaClient } from '@st-michael/database';
import * as webpush from 'web-push';
import * as sgMail from '@sendgrid/mail';

interface NotificationJob {
  brokerId: string;
  // 2026-07-02: убран WHATSAPP (не подключён). TELEGRAM оставлен на случай
  // старых job'ов в очереди — processor молча пропустит без TOKEN.
  channel: 'SMS' | 'TELEGRAM' | 'EMAIL' | 'PUSH';
  subject?: string;
  body: string;
  // Event type — if set, processor checks broker's notification preferences and
  // skips sending when (eventType × channel) is disabled. Missing pref row = enabled.
  eventType?: string;
  // Optional payload for push — link to open, icon, tag for de-dup
  data?: { url?: string; tag?: string; icon?: string };
}

let sendgridConfigured = false;
function configureSendgrid() {
  if (sendgridConfigured) return;
  const key = process.env.SENDGRID_API_KEY;
  if (key) {
    sgMail.setApiKey(key);
    sendgridConfigured = true;
  }
}

let webPushConfigured = false;
function configureWebPush() {
  if (webPushConfigured) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const prv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:info@zorge9.com';
  if (pub && prv) {
    webpush.setVapidDetails(subject, pub, prv);
    webPushConfigured = true;
  }
}

@Processor('notifications')
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  @Process('send')
  async handleSend(job: Job<NotificationJob>) {
    const { brokerId, channel, subject, body, data, eventType } = job.data;
    this.logger.log(`Processing notification: ${channel} → broker ${brokerId}${eventType ? ` (${eventType})` : ''}`);

    // Honor broker preferences — skip silently if (eventType × channel) is disabled.
    if (eventType) {
      const pref = await this.prisma.notificationPreference.findUnique({
        where: { brokerId_eventType_channel: { brokerId, eventType, channel: channel as any } },
      });
      if (pref && !pref.enabled) {
        this.logger.log(`[Pref] Skipping ${channel}/${eventType} for broker ${brokerId}`);
        return;
      }
    }

    // Save notification record
    const notification = await this.prisma.notification.create({
      data: { brokerId, channel: channel as any, subject, body, status: 'PENDING' },
    });

    try {
      const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (!broker) {
        this.logger.warn(`Broker ${brokerId} not found, skipping notification`);
        await this.updateStatus(notification.id, 'FAILED');
        return;
      }

      switch (channel) {
        case 'SMS':
          await this.sendSms(broker.phone, body);
          break;
        case 'TELEGRAM':
          await this.sendTelegram(broker.telegramChatId, body);
          break;
        case 'EMAIL':
          await this.sendEmail(broker.email, subject || 'Уведомление', body);
          break;
        case 'PUSH':
          await this.sendPush(brokerId, subject || 'ST Michael', body, data);
          break;
      }

      await this.updateStatus(notification.id, 'SENT');
      this.logger.log(`Notification ${notification.id} sent via ${channel}`);
    } catch (error: any) {
      this.logger.error(`Failed to send notification ${notification.id}: ${error.message}`);
      await this.updateStatus(notification.id, 'FAILED');
      throw error; // Let BullMQ retry
    }
  }

  private async updateStatus(id: string, status: 'SENT' | 'FAILED') {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: status as any,
        sentAt: status === 'SENT' ? new Date() : undefined,
      },
    });
  }

  // ─── Channel Implementations ────────────────────────

  private async sendSms(phone: string, body: string) {
    const apiKey = process.env.SMS_PROVIDER_API_KEY;
    if (!apiKey) {
      this.logger.warn(`[SMS] No API key configured. Message to ${phone}: ${body}`);
      return;
    }

    // Integration with SMS provider (e.g., SMS.RU, SMSC)
    this.logger.log(`[SMS] Sending to ${phone}: ${body.substring(0, 50)}...`);
    // In production: await fetch(`https://sms.ru/sms/send?api_id=${apiKey}&to=${phone}&msg=${encodeURIComponent(body)}&json=1`)
  }

  private async sendTelegram(chatId: bigint | null, body: string) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || !chatId) {
      this.logger.warn(`[Telegram] Not configured or no chatId. Message: ${body}`);
      return;
    }

    this.logger.log(`[Telegram] Sending to chat ${chatId}: ${body.substring(0, 50)}...`);

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId.toString(), text: body, parse_mode: 'HTML' }),
    });
  }

  private async sendEmail(email: string | null, subject: string, body: string) {
    if (!email) {
      this.logger.warn(`[Email] No email for broker. Subject: ${subject}`);
      return;
    }
    configureSendgrid();
    if (!sendgridConfigured) {
      this.logger.warn(`[Email] SENDGRID_API_KEY not configured — skip. To: ${email}, Subject: ${subject}`);
      return;
    }

    // 2026-07-02: Real SendGrid отправка. FROM_EMAIL — верифицированный
    // отправитель в SendGrid (Ксения настраивает через Sender Authentication).
    // Fallback: info@zorge9.com — уже есть в CMS-блоке contact.
    const from = process.env.SENDGRID_FROM || 'info@zorge9.com';
    const fromName = process.env.SENDGRID_FROM_NAME || 'ST Michael';

    // Тело письма: если body содержит HTML-теги, используем его как HTML.
    // Иначе оборачиваем в простой text-only.
    const isHtml = /<[a-z][^>]*>/i.test(body);
    const html = isHtml ? body : body.replace(/\n/g, '<br>');
    const text = body.replace(/<[^>]+>/g, '');

    this.logger.log(`[Email→SendGrid] To: ${email}, Subject: ${subject}`);
    try {
      await sgMail.send({
        to: email,
        from: { email: from, name: fromName },
        subject,
        text,
        html,
      });
    } catch (e: any) {
      const details = e?.response?.body?.errors
        ? JSON.stringify(e.response.body.errors)
        : (e?.message || String(e));
      this.logger.error(`[Email→SendGrid] Failed: ${details}`);
      throw e; // Let BullMQ retry.
    }
  }

  private async sendPush(
    brokerId: string,
    title: string,
    body: string,
    data?: NotificationJob['data'],
  ) {
    configureWebPush();
    if (!webPushConfigured) {
      this.logger.warn('[Push] VAPID keys not configured — skip');
      return;
    }

    const subs = await this.prisma.pushSubscription.findMany({ where: { brokerId } });
    if (subs.length === 0) {
      this.logger.warn(`[Push] Broker ${brokerId} has no subscriptions`);
      return;
    }

    const payload = JSON.stringify({
      title,
      body,
      url: data?.url || '/',
      tag: data?.tag,
      icon: data?.icon || '/icon-192.png',
    });

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
      } catch (e: any) {
        // 404/410 — subscription is gone, drop it from DB
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          this.logger.log(`[Push] Subscription ${sub.id} expired (${e.statusCode}) — removing`);
          await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          this.logger.error(`[Push] Failed for sub ${sub.id}: ${e?.message || e}`);
        }
      }
    }
  }
}
