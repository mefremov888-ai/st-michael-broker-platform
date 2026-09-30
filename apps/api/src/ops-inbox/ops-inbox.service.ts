import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { telegramApiBase } from '../common/telegram-api-base';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { PrismaClient } from '@st-michael/database';
import { TelegramNewsService } from '../telegram-news/telegram-news.service';

// 2026-09-08 (владелец): «чтобы я мог отвечать через телеграм-бот, а ты брал
// это в работу». Входящие сообщения в ops-бота техподдержки (ответы владельца
// и Анны, файлы с решениями) складываются в таблицу ops_inbox_messages;
// рабочая сессия ассистента забирает их защищённым эндпоинтом и отвечает
// обратно тем же ботом. Бот опрашивается long-poll'ом getUpdates раз в 20 с;
// смещение хранится в SystemSetting, чтобы после рестарта ничего не терять.
//
// Токен доступа к эндпоинту — SystemSetting OPS_INBOX_TOKEN (или env
// OPS_INBOX_TOKEN). Без него эндпоинт закрыт (503), опрос бота всё равно идёт.
//
// 2026-09-29: этот же опрос — единственный потребитель getUpdates бота, поэтому
// посты Telegram-канала компании (channel_post / edited_channel_post) тоже
// приходят сюда и передаются в TelegramNewsService (новости лендинга). В
// таблицу входящих посты канала не пишутся — это не сообщения владельца.

const OFFSET_KEY = 'OPS_INBOX_UPDATE_OFFSET';
const TOKEN_KEY = 'OPS_INBOX_TOKEN';
const TELEGRAM_TIMEOUT_MS = 15_000;
// 2026-09-30: callback_query — нажатия кнопок «Опубликовать/Отклонить» в
// сообщениях «На согласование» (TelegramNewsService.handleCallback).
export const ALLOWED_UPDATES = ['message', 'channel_post', 'edited_channel_post', 'callback_query'];

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: { id: string; from: { id: number; first_name?: string; last_name?: string; username?: string }; message?: any; data?: string };
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
    private readonly telegramNews: TelegramNewsService,
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
          `${telegramApiBase()}/bot${token}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${encodeURIComponent(JSON.stringify(ALLOWED_UPDATES))}`,
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
      let newsSeen = 0;
      let callbacks = 0;
      for (const update of updates) {
        maxUpdateId = Math.max(maxUpdateId, Number(update.update_id));
        if (update.callback_query) {
          // Кнопка согласования новости; чужие callback-и сервис игнорирует.
          callbacks += 1;
          try {
            await this.telegramNews.handleCallback(update.callback_query as any, token);
          } catch (error) {
            this.logger.warn(`[OpsInbox] callback (update ${update.update_id}) не обработан: ${(error as Error)?.message || error}`);
          }
          continue;
        }
        if (update.channel_post || update.edited_channel_post) {
          // Пост Telegram-канала → новости лендинга; ошибка одного поста не
          // должна останавливать ни опрос, ни сдвиг offset.
          newsSeen += 1;
          try {
            await this.telegramNews.handleUpdate(update as any, token);
          } catch (error) {
            this.logger.warn(`[OpsInbox] пост канала (update ${update.update_id}) не обработан: ${(error as Error)?.message || error}`);
          }
          continue;
        }
        const message = update.message;
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
      if (stored || newsSeen || callbacks) this.logger.log(`[OpsInbox] новых сообщений: ${stored}, постов канала: ${newsSeen}, нажатий кнопок: ${callbacks}`);
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
    const body = JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
    // 2026-09-08: из контейнера fetch на sendMessage падал «fetch failed»
    // (getUpdates при этом работает). Логируем причину и пробуем запасной
    // путь через node:https (другой сетевой стек, IPv4 first).
    let payload: any = null;
    let status = 0;
    try {
      const response = await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      status = response.status;
      payload = await response.json().catch(() => null);
    } catch (error) {
      const cause = (error as any)?.cause;
      this.logger.warn(`[OpsInbox] sendMessage fetch failed: ${(error as Error)?.message}; cause=${cause?.code || ''} ${cause?.message || ''}`);
      const fallback = await this.postJsonViaHttps(`/bot${token}/sendMessage`, body);
      status = fallback.status;
      payload = fallback.payload;
    }
    if (status < 200 || status >= 300 || !payload?.ok) {
      throw new ServiceUnavailableException(`Telegram sendMessage: HTTP ${status} ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return { ok: true, messageId: payload.result?.message_id };
  }

  private postJsonViaHttps(path: string, body: string): Promise<{ status: number; payload: any }> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const https = require('node:https');
    return new Promise((resolve, reject) => {
      const req = https.request(
        { host: 'api.telegram.org', family: 4, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 15_000 },
        (res: any) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let payload: any = null;
            try { payload = JSON.parse(raw); } catch { payload = { raw: raw.slice(0, 200) }; }
            resolve({ status: Number(res.statusCode || 0), payload });
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (error: Error) => {
        this.logger.warn(`[OpsInbox] sendMessage https fallback failed: ${error.message}`);
        reject(new ServiceUnavailableException(`Telegram sendMessage (https): ${error.message}`));
      });
      req.write(body);
      req.end();
    });
  }

  /** Скачивание файла из Telegram (документ/фото/голос) по записи входящих. */
  async file(id: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const token = this.botToken();
    if (!token) throw new ServiceUnavailableException('Telegram bot token не настроен');
    const row = await this.inbox.findUnique({ where: { id } });
    if (!row?.fileId) throw new ServiceUnavailableException('У сообщения нет файла');
    const meta = await fetch(`${telegramApiBase()}/bot${token}/getFile?file_id=${encodeURIComponent(row.fileId)}`);
    const metaJson: any = await meta.json().catch(() => null);
    if (!meta.ok || !metaJson?.ok || !metaJson.result?.file_path) {
      throw new ServiceUnavailableException(`Telegram getFile: ${JSON.stringify(metaJson).slice(0, 200)}`);
    }
    const download = await fetch(`${telegramApiBase()}/file/bot${token}/${metaJson.result.file_path}`);
    if (!download.ok) throw new ServiceUnavailableException(`Telegram file download HTTP ${download.status}`);
    const buffer = Buffer.from(await download.arrayBuffer());
    return {
      buffer,
      fileName: row.fileName || String(metaJson.result.file_path).split('/').pop() || 'file',
      mimeType: row.mimeType || 'application/octet-stream',
    };
  }
}
