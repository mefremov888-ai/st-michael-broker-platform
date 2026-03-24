import { Process, Processor } from '@nestjs/bull';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaClient } from '@st-michael/database';

interface NotificationJob {
  brokerId: string;
  channel: 'SMS' | 'WHATSAPP' | 'TELEGRAM' | 'EMAIL';
  subject?: string;
  body: string;
}

@Processor('notifications')
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  @Process('send')
  async handleSend(job: Job<NotificationJob>) {
    const { brokerId, channel, subject, body } = job.data;
    this.logger.log(`Processing notification: ${channel} → broker ${brokerId}`);

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
        case 'WHATSAPP':
          await this.sendWhatsApp(broker.phone, body);
          break;
        case 'TELEGRAM':
          await this.sendTelegram(broker.telegramChatId, body);
          break;
        case 'EMAIL':
          await this.sendEmail(broker.email, subject || 'Уведомление', body);
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

  private async sendWhatsApp(phone: string, body: string) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
      this.logger.warn(`[WhatsApp] Not configured. Message to ${phone}: ${body}`);
      return;
    }

    this.logger.log(`[WhatsApp] Sending to ${phone}: ${body.substring(0, 50)}...`);
    // In production: await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, { ... })
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

    this.logger.log(`[Email] Sending to ${email}: ${subject}`);
    // In production: integrate with nodemailer, SendGrid, etc.
  }
}
