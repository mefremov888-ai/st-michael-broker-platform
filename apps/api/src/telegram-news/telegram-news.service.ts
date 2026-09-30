import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@st-michael/database';
import { promises as fs } from 'fs';
import * as path from 'path';
import { telegramApiBase } from '../common/telegram-api-base';
import { callTelegramApi } from '../common/telegram-bot-api';
import {
  buildModerationText,
  isAllowedNewsChat,
  isModeratorCallback,
  ModerationNotice,
  ModerationStatus,
  moderationKeyboard,
  parseChannelPost,
  ParsedChannelPost,
  parseModerationCallback,
  parseModeratorChatIds,
  TELEGRAM_NEWS_SOURCE,
  TelegramCallbackQuery,
  telegramUserName,
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
//
// 2026-09-30: согласование. Новый пост канала создаётся со статусом PENDING и
// на лендинг не попадает; модераторам (владелец и Анна — SystemSetting/env
// TELEGRAM_NEWS_MODERATOR_CHAT_IDS, запасной вариант — чаты ops-алертов
// OPS_ALERT_CHAT_IDS/OPS_ALERT_CHAT_ID) бот шлёт «На согласование …» с
// кнопками «✅ Опубликовать» / «❌ Отклонить». Нажатие приходит тем же опросом
// как callback_query: первое решение меняет статус и правит сообщения у обоих
// модераторов (кнопки убираются, дописывается «Опубликовано/Отклонено: имя»),
// повторное — «Уже обработано». Те же действия доступны админу в /admin/news.

export const TELEGRAM_NEWS_CHAT_ID_KEY = 'TELEGRAM_NEWS_CHAT_ID';
export const TELEGRAM_NEWS_LAST_CHAT_KEY = 'TELEGRAM_NEWS_LAST_CHAT';
export const TELEGRAM_NEWS_MODERATORS_KEY = 'TELEGRAM_NEWS_MODERATOR_CHAT_IDS';

const UPLOADS_ROOT = process.env.UPLOADS_DIR || '/app/uploads';
const PUBLIC_PREFIX = '/files';
const NEWS_DIR = 'news/telegram';
const DOWNLOAD_TIMEOUT_MS = 20_000;
const SETTING_CACHE_MS = 60_000;

export type TelegramNewsResult = 'ignored' | 'skipped' | 'created' | 'updated';
export type TelegramCallbackResult = 'ignored' | 'forbidden' | 'not_found' | 'already' | 'approved' | 'rejected';
export type ModerateResult = { result: 'not_found' | 'already' | 'done'; status: ModerationStatus | null; news: any | null };

@Injectable()
export class TelegramNewsService {
  private readonly logger = new Logger(TelegramNewsService.name);
  private chatIdCache: { value: string | null; at: number } = { value: null, at: 0 };
  private moderatorsCache: { value: string[]; at: number } = { value: [], at: 0 };

  constructor(
    @Inject('PrismaClient') private readonly prisma: PrismaClient,
    private readonly config: ConfigService,
  ) {}

  private get news() {
    return (this.prisma as any).landingNews;
  }

  private botToken(): string | undefined {
    return (
      this.config.get<string>('OPS_TELEGRAM_BOT_TOKEN')?.trim() ||
      this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() ||
      undefined
    );
  }

  private async readSetting(key: string): Promise<string | null> {
    try {
      const row = await this.prisma.systemSetting.findUnique({ where: { key } });
      return row?.value?.trim() || null;
    } catch {
      return null;
    }
  }

  /** Id канала новостей: SystemSetting (кэш 60 с) → env. Пусто = любой канал. */
  async newsChatId(): Promise<string | null> {
    if (Date.now() - this.chatIdCache.at < SETTING_CACHE_MS) return this.chatIdCache.value;
    let value = await this.readSetting(TELEGRAM_NEWS_CHAT_ID_KEY);
    if (!value) value = this.config.get<string>(TELEGRAM_NEWS_CHAT_ID_KEY)?.trim() || null;
    this.chatIdCache = { value, at: Date.now() };
    return value;
  }

  /**
   * Чаты модераторов (кому уходит «На согласование» и кто вправе нажимать
   * кнопки): SystemSetting TELEGRAM_NEWS_MODERATOR_CHAT_IDS (кэш 60 с) → env
   * с тем же именем → чаты ops-алертов OPS_ALERT_CHAT_IDS / OPS_ALERT_CHAT_ID.
   */
  async moderatorChatIds(): Promise<string[]> {
    if (Date.now() - this.moderatorsCache.at < SETTING_CACHE_MS) return this.moderatorsCache.value;
    let value = parseModeratorChatIds(await this.readSetting(TELEGRAM_NEWS_MODERATORS_KEY));
    if (!value.length) value = parseModeratorChatIds(this.config.get<string>(TELEGRAM_NEWS_MODERATORS_KEY));
    if (!value.length) {
      value = parseModeratorChatIds(this.config.get<string>('OPS_ALERT_CHAT_IDS'), this.config.get<string>('OPS_ALERT_CHAT_ID'));
    }
    this.moderatorsCache = { value, at: Date.now() };
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
          moderationStatus: 'PENDING',
          telegramChatId: post.chatId,
          telegramMessageId: post.messageId,
          mediaGroupId: post.mediaGroupId,
        },
      });
      this.logger.log(`[TelegramNews] новость создана (на согласовании): ${created.id} ← ${post.chatId}/${post.messageId}${post.mediaGroupId ? ` альбом ${post.mediaGroupId}` : ''}`);
      await this.sendModerationNotices(created, post.photoFileId, botToken);
      return 'created';
    }

    // Правка поста: текст/фото обновляем, статус согласования не трогаем —
    // опубликованная новость остаётся опубликованной, ожидающая — ожидающей.
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
    const updated = await this.news.update({ where: { id: existing.id }, data: patch });
    this.logger.log(`[TelegramNews] новость обновлена: ${existing.id} ← ${post.chatId}/${post.messageId} (${Object.keys(patch).join(', ')})`);
    if (updated.moderationStatus === 'PENDING' && (patch.title || patch.excerpt)) {
      // Модераторы ещё не решили — показываем им актуальный текст.
      await this.refreshModerationNotices(updated, botToken);
    }
    return 'updated';
  }

  /**
   * Нажатие кнопки «Опубликовать»/«Отклонить» в сообщении модератора
   * (callback_query из того же опроса getUpdates).
   */
  async handleCallback(query: TelegramCallbackQuery, botToken: string | undefined): Promise<TelegramCallbackResult> {
    const token = botToken || this.botToken();
    const parsed = parseModerationCallback(query?.data);
    if (!parsed) return 'ignored';
    const answer = (text: string) => this.answerCallback(token, query.id, text);

    const moderators = await this.moderatorChatIds();
    if (!isModeratorCallback(query, moderators)) {
      this.logger.warn(`[TelegramNews] кнопку согласования нажал не модератор: from.id=${query?.from?.id} chat.id=${query?.message?.chat?.id}`);
      await answer('Нет прав на согласование');
      return 'forbidden';
    }

    const status: ModerationStatus = parsed.action === 'approve' ? 'APPROVED' : 'REJECTED';
    const outcome = await this.moderate(parsed.newsId, status, telegramUserName(query.from), token);
    if (outcome.result === 'not_found') {
      await answer('Новость не найдена');
      return 'not_found';
    }
    if (outcome.result === 'already') {
      await answer(`Уже обработано: ${outcome.status === 'APPROVED' ? 'опубликовано' : 'отклонено'}`);
      return 'already';
    }
    await answer(status === 'APPROVED' ? 'Опубликовано' : 'Отклонено');
    return status === 'APPROVED' ? 'approved' : 'rejected';
  }

  /**
   * Решение по новости (из Telegram или из админки). Первое решение
   * фиксируется, повторное — 'already'. У обоих модераторов в сообщении
   * убираются кнопки и дописывается итог.
   */
  async moderate(newsId: string, status: ModerationStatus, byName: string, botToken?: string): Promise<ModerateResult> {
    if (status !== 'APPROVED' && status !== 'REJECTED') return { result: 'not_found', status: null, news: null };
    const row = await this.news.findUnique({ where: { id: newsId } });
    if (!row) return { result: 'not_found', status: null, news: null };
    if (row.moderationStatus !== 'PENDING') return { result: 'already', status: row.moderationStatus, news: row };
    // Условие по статусу в where — защита от двух одновременных нажатий.
    const changed = await this.news.updateMany({
      where: { id: newsId, moderationStatus: 'PENDING' },
      data: { moderationStatus: status, moderatedAt: new Date(), moderatedBy: byName.slice(0, 120) },
    });
    if (!changed?.count) {
      const fresh = await this.news.findUnique({ where: { id: newsId } });
      return { result: 'already', status: fresh?.moderationStatus || null, news: fresh };
    }
    const updated = { ...row, moderationStatus: status, moderatedBy: byName, moderatedAt: new Date() };
    this.logger.log(`[TelegramNews] новость ${newsId}: ${status} (${byName})`);
    await this.finishModerationNotices(updated, botToken || this.botToken());
    return { result: 'done', status, news: updated };
  }

  private fallbackTitle(post: ParsedChannelPost): string {
    return post.chatTitle ? `${post.chatTitle}: фото` : 'St. Michael: фото';
  }

  // ─── уведомления модераторам ───────────────────────────────────────────────

  private async sendModerationNotices(news: any, photoFileId: string | null, botToken: string | undefined): Promise<void> {
    const token = botToken || this.botToken();
    const moderators = await this.moderatorChatIds();
    if (!token || !moderators.length) {
      this.logger.warn(`[TelegramNews] некому отправить «На согласование» (${!token ? 'нет токена бота' : `настройка ${TELEGRAM_NEWS_MODERATORS_KEY} пуста`}) — новость ${news.id} ждёт решения в /admin/news`);
      return;
    }
    const text = buildModerationText(news);
    const replyMarkup = moderationKeyboard(news.id);
    const notices: ModerationNotice[] = [];
    for (const chatId of moderators) {
      let sent: { ok: boolean; payload: any } | null = null;
      let hasPhoto = false;
      if (photoFileId) {
        // Фото пересылаем по file_id — бот получил его из канала, повторно
        // скачивать/загружать не нужно; caption ограничен 1024 символами.
        sent = await callTelegramApi(token, 'sendPhoto', { chat_id: chatId, photo: photoFileId, caption: text.slice(0, 1024), reply_markup: replyMarkup }, this.logger);
        hasPhoto = sent.ok;
        if (!sent.ok) this.logger.warn(`[TelegramNews] sendPhoto модератору ${chatId} не удался: ${JSON.stringify(sent.payload).slice(0, 200)} — шлю текстом`);
      }
      if (!sent?.ok) {
        sent = await callTelegramApi(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000), reply_markup: replyMarkup, disable_web_page_preview: true }, this.logger);
      }
      const messageId = Number(sent?.payload?.result?.message_id);
      if (sent?.ok && messageId) {
        notices.push({ chatId, messageId, hasPhoto });
      } else {
        this.logger.warn(`[TelegramNews] «На согласование» модератору ${chatId} не отправлено: ${JSON.stringify(sent?.payload).slice(0, 200)}`);
      }
    }
    if (notices.length) {
      await this.news.update({ where: { id: news.id }, data: { moderationNotices: notices } });
    }
  }

  /** Пост отредактирован, пока ждал решения — обновляем текст у модераторов. */
  private async refreshModerationNotices(news: any, botToken: string | undefined): Promise<void> {
    const token = botToken || this.botToken();
    const notices = this.noticesOf(news);
    if (!token || !notices.length) return;
    await this.editNotices(token, notices, buildModerationText(news), moderationKeyboard(news.id));
  }

  /** Решение принято — убираем кнопки и дописываем итог у обоих модераторов. */
  private async finishModerationNotices(news: any, botToken: string | undefined): Promise<void> {
    const notices = this.noticesOf(news);
    if (!botToken || !notices.length) return;
    await this.editNotices(botToken, notices, buildModerationText(news), { inline_keyboard: [] });
  }

  private noticesOf(news: any): ModerationNotice[] {
    const raw = news?.moderationNotices;
    if (!Array.isArray(raw)) return [];
    return raw.filter((n) => n && n.chatId && Number(n.messageId)).map((n) => ({ chatId: String(n.chatId), messageId: Number(n.messageId), hasPhoto: Boolean(n.hasPhoto) }));
  }

  private async editNotices(token: string, notices: ModerationNotice[], text: string, replyMarkup: unknown): Promise<void> {
    for (const notice of notices) {
      // Один вызов: новый текст/подпись + пустая клавиатура (кнопки исчезают).
      const method = notice.hasPhoto ? 'editMessageCaption' : 'editMessageText';
      const body: Record<string, unknown> = { chat_id: notice.chatId, message_id: notice.messageId, reply_markup: replyMarkup };
      if (notice.hasPhoto) body.caption = text.slice(0, 1024);
      else {
        body.text = text.slice(0, 4000);
        body.disable_web_page_preview = true;
      }
      const res = await callTelegramApi(token, method, body, this.logger);
      if (!res.ok && !/message is not modified/i.test(String(res.payload?.description || ''))) {
        this.logger.warn(`[TelegramNews] ${method} ${notice.chatId}/${notice.messageId} не удался: ${JSON.stringify(res.payload).slice(0, 200)}`);
      }
    }
  }

  private async answerCallback(token: string | undefined, callbackQueryId: string, text: string): Promise<void> {
    if (!token || !callbackQueryId) return;
    const res = await callTelegramApi(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text }, this.logger);
    if (!res.ok) this.logger.warn(`[TelegramNews] answerCallbackQuery не удался: ${JSON.stringify(res.payload).slice(0, 200)}`);
  }

  // ─── служебное ─────────────────────────────────────────────────────────────

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
