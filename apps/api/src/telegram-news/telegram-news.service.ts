import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@st-michael/database';
import { promises as fs } from 'fs';
import * as path from 'path';
import { telegramApiBase } from '../common/telegram-api-base';
import {
  isAllowedNewsChat,
  parseChannelPost,
  ParsedChannelPost,
  TELEGRAM_NEWS_SOURCE,
  TelegramNewsUpdate,
} from './telegram-news.parser';

// 2026-09-29 (владелец): блок «Новости» на лендинге должен брать посты из
// закрытого Telegram-канала компании, а не с сайта stmichael.ru.
//
// Как это работает. Бот кабинета (тот же, что читает ответы владельца в
// OpsInboxService) добавлен в канал администратором; Telegram присылает ему
// channel_post / edited_channel_post. Единственный поллер бота — OpsInboxService
// (getUpdates раз в 20 с); он отдаёт нам апдейты канала, а мы складываем их в
// landing_news с source = "Telegram" (upsert по паре chat_id + message_id).
// Webhook на этом боте ставить нельзя: getUpdates тогда отвечает 409 и ломается
// приём входящих техподдержки.
//
// Фильтр канала — SystemSetting/env TELEGRAM_NEWS_CHAT_ID. Пока он пуст,
// принимаем посты из любого канала, куда бота добавили, и печатаем в лог
// chat.id/title — у закрытого канала id иначе не узнать. Последний увиденный
// канал храним в SystemSetting TELEGRAM_NEWS_LAST_CHAT (его печатает инспектор
// scripts/inspect-telegram-bot-chats.js).

export const TELEGRAM_NEWS_CHAT_ID_KEY = 'TELEGRAM_NEWS_CHAT_ID';
export const TELEGRAM_NEWS_LAST_CHAT_KEY = 'TELEGRAM_NEWS_LAST_CHAT';

const UPLOADS_ROOT = process.env.UPLOADS_DIR || '/app/uploads';
const PUBLIC_PREFIX = '/files';
const NEWS_DIR = 'news/telegram';
const DOWNLOAD_TIMEOUT_MS = 20_000;

export type TelegramNewsResult = 'ignored' | 'skipped' | 'created' | 'updated';

@Injectable()
export class TelegramNewsService {
  private readonly logger = new Logger(TelegramNewsService.name);
  private chatIdCache: { value: string | null; at: number } = { value: null, at: 0 };

  constructor(
    @Inject('PrismaClient') private readonly prisma: PrismaClient,
    private readonly config: ConfigService,
  ) {}

  private get news() {
    return (this.prisma as any).landingNews;
  }

  /** Id канала новостей: SystemSetting (кэш 60 с) → env. Пусто = любой канал. */
  async newsChatId(): Promise<string | null> {
    if (Date.now() - this.chatIdCache.at < 60_000) return this.chatIdCache.value;
    let value: string | null = null;
    try {
      const row = await this.prisma.systemSetting.findUnique({ where: { key: TELEGRAM_NEWS_CHAT_ID_KEY } });
      value = row?.value?.trim() || null;
    } catch {
      value = null;
    }
    if (!value) value = this.config.get<string>(TELEGRAM_NEWS_CHAT_ID_KEY)?.trim() || null;
    this.chatIdCache = { value, at: Date.now() };
    return value;
  }

  /**
   * Приём одного апдейта канала. `botToken` — токен бота, которым апдейт
   * получен (file_id фото привязаны к боту, скачивать надо им же).
   */
  async handleUpdate(update: TelegramNewsUpdate, botToken: string | undefined): Promise<TelegramNewsResult> {
    const post = parseChannelPost(update);
    if (!post) return 'ignored';
    await this.rememberLastChat(post);

    const configured = await this.newsChatId();
    if (!isAllowedNewsChat(post.chatId, configured)) {
      this.logger.log(`[TelegramNews] пост из чужого канала пропущен: chat.id=${post.chatId} title=${JSON.stringify(post.chatTitle || '')} (настроен ${configured})`);
      return 'skipped';
    }
    if (!configured) {
      this.logger.warn(`[TelegramNews] TELEGRAM_NEWS_CHAT_ID не задан — принимаю канал chat.id=${post.chatId} title=${JSON.stringify(post.chatTitle || '')}; впишите этот id в настройку`);
    }
    if (!post.text && !post.photoFileId) {
      this.logger.log(`[TelegramNews] пост ${post.chatId}/${post.messageId} без текста и фото — пропущен`);
      return 'skipped';
    }

    let existing = await this.news.findUnique({
      where: { telegramChatId_telegramMessageId: { telegramChatId: post.chatId, telegramMessageId: post.messageId } },
    });
    let sameMessage = Boolean(existing);
    if (!existing && post.mediaGroupId) {
      // Альбом: одна новость на media_group_id, ключ — первое пришедшее сообщение.
      existing = await this.news.findFirst({
        where: { telegramChatId: post.chatId, mediaGroupId: post.mediaGroupId },
        orderBy: { telegramMessageId: 'asc' },
      });
      sameMessage = false;
    }

    const wantsImage =
      Boolean(post.photoFileId) && (!existing || !existing.imageUrl || (sameMessage && post.isEdit));
    const imageUrl = wantsImage ? await this.storePhoto(post, botToken) : null;

    if (!existing) {
      const created = await this.news.create({
        data: {
          title: post.title || this.fallbackTitle(post),
          source: TELEGRAM_NEWS_SOURCE,
          publishedAt: post.publishedAt,
          excerpt: post.text || null,
          imageUrl,
          url: post.url,
          sortOrder: 0,
          isActive: true,
          telegramChatId: post.chatId,
          telegramMessageId: post.messageId,
          mediaGroupId: post.mediaGroupId,
        },
      });
      this.logger.log(`[TelegramNews] новость создана: ${created.id} ← ${post.chatId}/${post.messageId}${post.mediaGroupId ? ` альбом ${post.mediaGroupId}` : ''}`);
      return 'created';
    }

    const patch: Record<string, unknown> = {};
    if (post.text && (sameMessage || !existing.excerpt)) {
      // Тот же пост отредактирован — переписываем текст; другой элемент альбома
      // принёс подпись, которой у новости ещё не было — добавляем.
      patch.title = post.title || this.fallbackTitle(post);
      patch.excerpt = post.text;
    }
    if (imageUrl) patch.imageUrl = imageUrl;
    if (sameMessage && existing.mediaGroupId !== post.mediaGroupId) patch.mediaGroupId = post.mediaGroupId;
    if (!Object.keys(patch).length) return 'skipped';
    await this.news.update({ where: { id: existing.id }, data: patch });
    this.logger.log(`[TelegramNews] новость обновлена: ${existing.id} ← ${post.chatId}/${post.messageId} (${Object.keys(patch).join(', ')})`);
    return 'updated';
  }

  private fallbackTitle(post: ParsedChannelPost): string {
    return post.chatTitle ? `${post.chatTitle}: фото` : 'St. Michael: фото';
  }

  private async rememberLastChat(post: ParsedChannelPost): Promise<void> {
    const value = JSON.stringify({
      chatId: post.chatId,
      title: post.chatTitle,
      messageId: post.messageId,
      at: new Date().toISOString(),
    });
    try {
      await this.prisma.systemSetting.upsert({
        where: { key: TELEGRAM_NEWS_LAST_CHAT_KEY },
        update: { value, updatedBy: 'telegram-news' },
        create: { key: TELEGRAM_NEWS_LAST_CHAT_KEY, value, updatedBy: 'telegram-news' },
      });
    } catch (error) {
      this.logger.warn(`[TelegramNews] не удалось запомнить канал: ${(error as Error)?.message || error}`);
    }
  }

  /**
   * Скачиваем самое большое фото поста в файловое хранилище (том uploads,
   * nginx отдаёт его как /files/...). Ссылку на файл Telegram публиковать
   * нельзя — в ней токен бота, да и живёт она около часа; при неудаче
   * оставляем карточку без обложки, следующая правка поста повторит попытку.
   */
  private async storePhoto(post: ParsedChannelPost, botToken: string | undefined): Promise<string | null> {
    if (!post.photoFileId) return null;
    if (!botToken) {
      this.logger.warn('[TelegramNews] нет токена бота — фото не скачано');
      return null;
    }
    try {
      const meta = await this.fetchWithTimeout(`${telegramApiBase()}/bot${botToken}/getFile?file_id=${encodeURIComponent(post.photoFileId)}`);
      const metaJson: any = await meta.json().catch(() => null);
      const filePath: string | undefined = metaJson?.result?.file_path;
      if (!meta.ok || !metaJson?.ok || !filePath) {
        this.logger.warn(`[TelegramNews] getFile не удался: HTTP ${meta.status} ${JSON.stringify(metaJson).slice(0, 200)}`);
        return null;
      }
      const download = await this.fetchWithTimeout(`${telegramApiBase()}/file/bot${botToken}/${filePath}`);
      if (!download.ok) {
        this.logger.warn(`[TelegramNews] скачивание фото не удалось: HTTP ${download.status}`);
        return null;
      }
      const buffer = Buffer.from(await download.arrayBuffer());
      const ext = (path.extname(filePath) || '.jpg').toLowerCase();
      const internalId = post.chatId.startsWith('-100') ? post.chatId.slice(4) : post.chatId.replace(/^-/, '');
      const fileName = `${internalId}-${post.messageId}${ext}`;
      const targetDir = path.join(UPLOADS_ROOT, NEWS_DIR);
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, fileName), buffer);
      return `${PUBLIC_PREFIX}/${NEWS_DIR}/${fileName}`;
    } catch (error) {
      this.logger.warn(`[TelegramNews] фото не сохранено: ${(error as Error)?.message || error}`);
      return null;
    }
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
