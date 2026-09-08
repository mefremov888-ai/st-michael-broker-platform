import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { PrismaClient } from '@st-michael/database';

// 2026-09-08 (владелец): «чтобы я мог отвечать через телеграм-бот, а ты брал
// это в работу». Входящие сообщения в ops-бота техподдержки (ответы владельца
// и Анны, файлы с решениями) складываются в таблицу ops_inbox_messages;
// рабочая сессия ассистента забирает их защищённым эндпоинтом и отвечает
// обратно тем же ботом. Бот опрашивается long-poll'ом getUpdates раз в 20 с;
// смещение хранится в SystemSetting, чтобы после рестарта ничего не терять.
//
// Токен доступа к эндпоинту — SystemSetting OPS_INBOX_TOKEN (или env
// OPS_INBOX_TOKEN). Без него эндпоинт закрыт (503), опрос бота всё равно идёт.

const OFFSET_KEY = 'OPS_INBOX_UPDATE_OFFSET';
const TOKEN_KEY = 'OPS_INBOX_TOKEN';
const TELEGRAM_TIMEOUT_MS = 15_000;

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

type TelegramMessage = {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string };
  from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  voice?: { file_id: string; mime_type?: string; file_size?: number; duration?: number };
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: { text?: string; caption?: string };
};

@Injectable()
export class OpsInboxService {
  private readonly logger = new Logger(OpsInboxService.name);
  private polling = false;
  private warnedConflict = false;
  private tokenCache: { value: string | null; at: number } = { value: null, at: 0 };

  constructor(
    @Inject('PrismaClient') private readonly prisma: PrismaClient,
    private readonly config: ConfigService,
  ) {}

  private get inbox() {
    return (this.prisma as any).opsInboxMessage;
  }

  private botToken(): string | undefined {
    return (
      this.config.get<string>('OPS_TELEGRAM_BOT_TOKEN')?.trim() ||
      this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() ||
      undefined
    );
  }

  /** Токен доступа к эндпоинту: SystemSetting (кэш 60 с) → env. */
  async accessToken(): Promise<string | null> {
    if (Date.now() - this.tokenCache.at < 60_000) return this.tokenCache.value;
    let value: string | null = null;
    try {
      const row = await this.prisma.systemSetting.findUnique({ where: { key: TOKEN_KEY } });
      value = row?.value?.trim() || null;
    } catch {
      value = null;
    }
    if (!value) value = this.config.get<string>('OPS_INBOX_TOKEN')?.trim() || null;
    this.tokenCache = { value, at: Date.now() };
    return value;
  }

  async assertAccess(provided: string | undefined): Promise<void> {
    const expected = await this.accessToken();
    if (!expected) throw new ServiceUnavailableException('OPS_INBOX_TOKEN не настроен');
    if (!provided || provided.trim() !== expected) {
      // Не раскрываем, есть ли токен вообще.
      throw new ServiceUnavailableException('ops inbox: доступ запрещён');
    }
  }

  @Interval(20_000)
  async poll(): Promise<void> {
    if (this.polling || !this.inbox) return;
    const token = this.botToken();
    if (!token) return;
    this.polling = true;
    try {
      const offsetRow = await this.prisma.systemSetting.findUnique({ where: { key: OFFSET_KEY } });
      const offset = Number(offsetRow?.value || 0) || 0;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
      let payload: any;
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${encodeURIComponent('["message"]')}`,
          { signal: controller.signal },
        );
        payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          if (response.status === 409 && !this.warnedConflict) {
            this.warnedConflict = true;
            this.logger.warn(`[OpsInbox] getUpdates 409: у бота установлен webhook — снимите его, иначе входящие не читаются`);
          } else if (response.status !== 409) {
            this.logger.warn(`[OpsInbox] getUpdates HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 200)}`);
          }
          return;
        }
      } finally {
        clearTimeout(timer);
      }
      const updates: TelegramUpdate[] = Array.isArray(payload.result) ? payload.result : [];
      if (!updates.length) return;
      let maxUpdateId = offset - 1;
      let stored = 0;
      for (const update of updates) {
        maxUpdateId = Math.max(maxUpdateId, Number(update.update_id));
        const message = update.message || update.channel_post;
        if (!message || message.from?.is_bot) continue;
        const record = this.toRecord(update.update_id, message);
        try {
          await this.inbox.upsert({
            where: { updateId: BigInt(update.update_id) },
            update: {},
            create: record,
          });
          stored += 1;
        } catch (error) {
          this.logger.warn(`[OpsInbox] не удалось сохранить update ${update.update_id}: ${(error as Error)?.message || error}`);
        }
      }
      await this.prisma.systemSetting.upsert({
        where: { key: OFFSET_KEY },
        update: { value: String(maxUpdateId + 1), updatedBy: 'ops-inbox' },
        create: { key: OFFSET_KEY, value: String(maxUpdateId + 1), updatedBy: 'ops-inbox' },
      });
      if (stored) this.logger.log(`[OpsInbox] новых сообщений: ${stored}`);
    } catch (error) {
      this.logger.warn(`[OpsInbox] poll failed: ${(error as Error)?.message || error}`);
    } finally {
      this.polling = false;
    }
  }

  private toRecord(updateId: number, message: TelegramMessage) {
    const from = message.from;
    const fromName = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim() || null;
    const largestPhoto = Array.isArray(message.photo) && message.photo.length
      ? message.photo[message.photo.length - 1]
      : null;
    const file =
      message.document ||
      message.video ||
      message.audio ||
      message.voice ||
      (largestPhoto ? { file_id: largestPhoto.file_id, file_name: `photo_${message.message_id}.jpg`, mime_type: 'image/jpeg', file_size: largestPhoto.file_size } : null);
    return {
      updateId: BigInt(updateId),
      chatId: String(message.chat.id),
      chatTitle: message.chat.title || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') || null,
      fromName,
      fromUsername: from?.username || null,
      messageId: BigInt(message.message_id),
      text: message.text || message.caption || null,
      fileId: file?.file_id || null,
      fileName: (file as any)?.file_name || null,
      fileSize: typeof file?.file_size === 'number' ? file.file_size : null,
      mimeType: (file as any)?.mime_type || null,
      replyToText: message.reply_to_message?.text || message.reply_to_message?.caption || null,
      sentAt: new Date(Number(message.date) * 1000),
    };
  }

  async list(afterId?: string, limit = 50) {
    if (!this.inbox) return { items: [], configured: false };
    let after: Date | null = null;
    if (afterId) {
      const anchor = await this.inbox.findUnique({ where: { id: afterId }, select: { createdAt: true } });
      after = anchor?.createdAt || null;
    }
    const rows = await this.inbox.findMany({
      where: after ? { createdAt: { gt: after } } : {},
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(1, limit), 200),
    });
    return {
      configured: Boolean(this.botToken()),
      items: rows.map((row: any) => ({
        ...row,
        updateId: String(row.updateId),
        messageId: String(row.messageId),
      })),
    };
  }

  async markHandled(ids: string[]) {
    if (!this.inbox || !ids.length) return { updated: 0 };
    const result = await this.inbox.updateMany({
      where: { id: { in: ids }, handledAt: null },
      data: { handledAt: new Date() },
    });
    return { updated: result.count };
  }

  async reply(chatId: string, text: string) {
    const token = this.botToken();
    if (!token) throw new ServiceUnavailableException('Telegram bot token не настроен');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    const payload: any = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new ServiceUnavailableException(`Telegram sendMessage: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return { ok: true, messageId: payload.result?.message_id };
  }

  /** Скачивание файла из Telegram (документ/фото/голос) по записи входящих. */
  async file(id: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const token = this.botToken();
    if (!token) throw new ServiceUnavailableException('Telegram bot token не настроен');
    const row = await this.inbox.findUnique({ where: { id } });
    if (!row?.fileId) throw new ServiceUnavailableException('У сообщения нет файла');
    const meta = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(row.fileId)}`);
    const metaJson: any = await meta.json().catch(() => null);
    if (!meta.ok || !metaJson?.ok || !metaJson.result?.file_path) {
      throw new ServiceUnavailableException(`Telegram getFile: ${JSON.stringify(metaJson).slice(0, 200)}`);
    }
    const download = await fetch(`https://api.telegram.org/file/bot${token}/${metaJson.result.file_path}`);
    if (!download.ok) throw new ServiceUnavailableException(`Telegram file download HTTP ${download.status}`);
    const buffer = Buffer.from(await download.arrayBuffer());
    return {
      buffer,
      fileName: row.fileName || String(metaJson.result.file_path).split('/').pop() || 'file',
      mimeType: row.mimeType || 'application/octet-stream',
    };
  }
}
