/**
 * 2026-09-29: разбор постов закрытого Telegram-канала компании → карточка
 * новости лендинга. Чистые функции без Nest/Prisma, чтобы их можно было
 * проверить тестами отдельно от приёма апдейтов (см. telegram-news.service.ts).
 */

export const TELEGRAM_NEWS_SOURCE = 'Telegram';
export const TELEGRAM_NEWS_TITLE_MAX = 120;

export type TelegramPhotoSize = { file_id: string; file_unique_id?: string; file_size?: number; width?: number; height?: number };

export type TelegramChannelMessage = {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number; type: string; title?: string; username?: string };
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number; url?: string }>;
  caption_entities?: Array<{ type: string; offset: number; length: number; url?: string }>;
  photo?: TelegramPhotoSize[];
  media_group_id?: string;
};

export type TelegramNewsUpdate = {
  update_id: number;
  channel_post?: TelegramChannelMessage;
  edited_channel_post?: TelegramChannelMessage;
};

export type ParsedChannelPost = {
  chatId: string;
  chatTitle: string | null;
  messageId: number;
  publishedAt: Date;
  /** Полный текст поста (text или caption), без markdown-разметки. */
  text: string;
  title: string | null;
  mediaGroupId: string | null;
  /** file_id самого большого размера фото или null. */
  photoFileId: string | null;
  isEdit: boolean;
  url: string;
};

/** Ссылка на пост закрытого канала: t.me/c/<id без -100>/<message_id>. */
export function buildTelegramPostUrl(chatId: string | number, messageId: number): string {
  const raw = String(chatId).trim();
  const internal = raw.startsWith('-100') ? raw.slice(4) : raw.replace(/^-/, '');
  return `https://t.me/c/${internal}/${messageId}`;
}

/** Самое большое фото поста (Telegram отдаёт размеры по возрастанию, но на всякий случай считаем). */
export function pickLargestPhoto(photo?: TelegramPhotoSize[] | null): TelegramPhotoSize | null {
  if (!Array.isArray(photo) || !photo.length) return null;
  return photo.reduce((best, item) => {
    const size = (item.width || 0) * (item.height || 0);
    const bestSize = (best.width || 0) * (best.height || 0);
    return size > bestSize ? item : best;
  }, photo[photo.length - 1]);
}

/** Снимаем markdown-подобные символы, которые владелец мог оставить в посте. */
export function stripMarkdown(input: string): string {
  return input
    .replace(/[*_~`]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Заголовок карточки: первая непустая строка поста; если она длиннее лимита —
 * первое предложение; если и оно длиннее — обрезка по слову с многоточием.
 */
export function pickTitle(text: string | null | undefined, max = TELEGRAM_NEWS_TITLE_MAX): string | null {
  if (!text) return null;
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => stripMarkdown(line))
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  if (firstLine.length <= max) return firstLine;
  const sentence = firstLine.match(/^(.+?[.!?…])(\s|$)/u)?.[1]?.trim();
  if (sentence && sentence.length <= max) return sentence;
  const cut = firstLine.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/**
 * Фильтр канала: настроенный id (например -1001234567890) — принимаем только
 * его; пустая настройка — принимаем посты из любого канала, куда добавлен бот.
 */
export function isAllowedNewsChat(chatId: string | number, configured: string | null | undefined): boolean {
  const wanted = String(configured || '').trim();
  if (!wanted) return true;
  return wanted.split(/[,;\s]+/).filter(Boolean).includes(String(chatId).trim());
}

export function extractChannelMessage(update: TelegramNewsUpdate): { message: TelegramChannelMessage; isEdit: boolean } | null {
  if (update?.edited_channel_post) return { message: update.edited_channel_post, isEdit: true };
  if (update?.channel_post) return { message: update.channel_post, isEdit: false };
  return null;
}

export function parseChannelPost(update: TelegramNewsUpdate): ParsedChannelPost | null {
  const found = extractChannelMessage(update);
  if (!found) return null;
  const { message, isEdit } = found;
  if (!message?.chat || typeof message.message_id !== 'number') return null;
  const chatId = String(message.chat.id);
  const text = (message.text || message.caption || '').trim();
  return {
    chatId,
    chatTitle: message.chat.title || null,
    messageId: message.message_id,
    publishedAt: new Date(Number(message.date || 0) * 1000),
    text,
    title: pickTitle(text),
    mediaGroupId: message.media_group_id ? String(message.media_group_id) : null,
    photoFileId: pickLargestPhoto(message.photo)?.file_id || null,
    isEdit,
    url: buildTelegramPostUrl(chatId, message.message_id),
  };
}
