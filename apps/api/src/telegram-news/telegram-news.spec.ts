import { clampPublicNewsLimit, orderPublicNews, PUBLIC_NEWS_LIMIT } from '../cms/cms.service';
import {
  buildModerationText,
  buildTelegramPostUrl,
  isAllowedNewsChat,
  isModeratorCallback,
  moderationPreview,
  parseChannelPost,
  parseModerationCallback,
  parseModeratorChatIds,
  pickLargestPhoto,
  pickTitle,
} from './telegram-news.parser';
import { TelegramNewsService } from './telegram-news.service';

/**
 * 2026-09-29: новости лендинга из закрытого Telegram-канала компании.
 * Проверяем разбор апдейта, выбор заголовка, ссылку t.me/c, upsert по
 * (chatId, messageId), альбомы, правки и фильтр TELEGRAM_NEWS_CHAT_ID.
 */

const CHAT = { id: -1001234567890, type: 'channel', title: 'St. Michael — новости' };

function channelPost(overrides: Record<string, unknown> = {}, edited = false) {
  const message = {
    message_id: 42,
    date: 1_790_000_000,
    chat: CHAT,
    text: 'Открыли продажи в «Зорге 9»!\n\nПодробности у менеджеров.',
    ...overrides,
  };
  return edited ? { update_id: 7, edited_channel_post: message } : { update_id: 7, channel_post: message };
}

describe('разбор поста канала', () => {
  it('текстовый пост: заголовок — первая строка, текст — весь пост, ссылка t.me/c без -100', () => {
    const post = parseChannelPost(channelPost() as any)!;
    expect(post.chatId).toBe('-1001234567890');
    expect(post.chatTitle).toBe(CHAT.title);
    expect(post.messageId).toBe(42);
    expect(post.title).toBe('Открыли продажи в «Зорге 9»!');
    expect(post.text).toBe('Открыли продажи в «Зорге 9»!\n\nПодробности у менеджеров.');
    expect(post.url).toBe('https://t.me/c/1234567890/42');
    expect(post.publishedAt.toISOString()).toBe(new Date(1_790_000_000 * 1000).toISOString());
    expect(post.isEdit).toBe(false);
    expect(post.mediaGroupId).toBeNull();
    expect(post.photoFileId).toBeNull();
  });

  it('фото с подписью: берём caption и самое большое фото', () => {
    const post = parseChannelPost(
      channelPost({
        text: undefined,
        caption: '*Ход строительства* за сентябрь',
        photo: [
          { file_id: 'small', width: 90, height: 60 },
          { file_id: 'big', width: 1280, height: 853 },
          { file_id: 'mid', width: 320, height: 213 },
        ],
      }) as any,
    )!;
    expect(post.title).toBe('Ход строительства за сентябрь');
    expect(post.photoFileId).toBe('big');
  });

  it('элемент альбома без подписи: текста нет, media_group_id есть', () => {
    const post = parseChannelPost(
      channelPost({ text: undefined, media_group_id: '9001', photo: [{ file_id: 'p1', width: 800, height: 600 }] }) as any,
    )!;
    expect(post.text).toBe('');
    expect(post.title).toBeNull();
    expect(post.mediaGroupId).toBe('9001');
  });

  it('правка поста приходит как edited_channel_post', () => {
    const post = parseChannelPost(channelPost({ text: 'Исправленный текст' }, true) as any)!;
    expect(post.isEdit).toBe(true);
    expect(post.title).toBe('Исправленный текст');
  });

  it('апдейт без поста канала игнорируется', () => {
    expect(parseChannelPost({ update_id: 1, message: { text: 'привет' } } as any)).toBeNull();
  });

  it('pickLargestPhoto устойчив к пустому списку', () => {
    expect(pickLargestPhoto(undefined)).toBeNull();
    expect(pickLargestPhoto([])).toBeNull();
  });
});

describe('заголовок карточки', () => {
  it('первая непустая строка без markdown', () => {
    expect(pickTitle('\n\n**Важно!** _Новый_ ЖК\nвторая строка')).toBe('Важно! Новый ЖК');
  });

  it('длинная первая строка → первое предложение', () => {
    const long = 'Короткое предложение. ' + 'Очень длинное продолжение '.repeat(10);
    expect(pickTitle(long)).toBe('Короткое предложение.');
  });

  it('длинная строка без точек → обрезка по слову с многоточием, не длиннее 120', () => {
    const words = Array.from({ length: 40 }, (_, i) => `слово${i}`).join(' ');
    const title = pickTitle(words)!;
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it('пустой текст → null', () => {
    expect(pickTitle('')).toBeNull();
    expect(pickTitle('   \n  ')).toBeNull();
  });
});

describe('ссылка на пост и фильтр канала', () => {
  it('t.me/c/<id без -100>/<message_id>', () => {
    expect(buildTelegramPostUrl('-1001234567890', 5)).toBe('https://t.me/c/1234567890/5');
    expect(buildTelegramPostUrl(-1009876543210, 12)).toBe('https://t.me/c/9876543210/12');
  });

  it('без настройки принимаем любой канал; с настройкой — только указанный', () => {
    expect(isAllowedNewsChat('-1001', '')).toBe(true);
    expect(isAllowedNewsChat('-1001', undefined)).toBe(true);
    expect(isAllowedNewsChat('-1001', '-1001')).toBe(true);
    expect(isAllowedNewsChat('-1002', '-1001')).toBe(false);
    expect(isAllowedNewsChat('-1002', '-1001, -1002')).toBe(true);
  });
});

describe('TelegramNewsService.handleUpdate', () => {
  let fetchMock: jest.SpyInstance;

  function createService(env: Record<string, string | undefined> = {}, settings: Record<string, string> = {}) {
    const rows = new Map<string, any>();
    const news = {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return rows.get(where.id) || null;
        const key = where.telegramChatId_telegramMessageId;
        return [...rows.values()].find((r) => r.telegramChatId === key.telegramChatId && r.telegramMessageId === key.telegramMessageId) || null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row || (where.moderationStatus && row.moderationStatus !== where.moderationStatus)) return { count: 0 };
        rows.set(where.id, { ...row, ...data });
        return { count: 1 };
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        [...rows.values()]
          .filter((r) => r.telegramChatId === where.telegramChatId && r.mediaGroupId === where.mediaGroupId)
          .sort((a, b) => a.telegramMessageId - b.telegramMessageId)[0] || null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `id-${rows.size + 1}`, ...data };
        rows.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...rows.get(where.id), ...data };
        rows.set(where.id, row);
        return row;
      }),
    };
    const systemSetting = {
      findUnique: jest.fn(async ({ where }: any) => (settings[where.key] ? { key: where.key, value: settings[where.key] } : null)),
      upsert: jest.fn(async ({ where, create }: any) => {
        settings[where.key] = create.value;
        return { key: where.key, value: create.value };
      }),
    };
    const prisma = { landingNews: news, systemSetting };
    const config = { get: jest.fn((key: string) => env[key]) };
    const service = new TelegramNewsService(prisma as any, config as any);
    return { service, news, systemSetting, rows, settings };
  }

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('новый текстовый пост → создаёт карточку с source=Telegram и запоминает канал', async () => {
    const { service, news, settings } = createService();
    await expect(service.handleUpdate(channelPost() as any, 'token')).resolves.toBe('created');
    expect(news.create).toHaveBeenCalledTimes(1);
    const data = news.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      title: 'Открыли продажи в «Зорге 9»!',
      source: 'Telegram',
      url: 'https://t.me/c/1234567890/42',
      telegramChatId: '-1001234567890',
      telegramMessageId: 42,
      isActive: true,
      imageUrl: null,
      moderationStatus: 'PENDING',
    });
    expect(data.excerpt).toContain('Подробности у менеджеров.');
    expect(JSON.parse(settings.TELEGRAM_NEWS_LAST_CHAT)).toMatchObject({ chatId: '-1001234567890', title: CHAT.title });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('повторный апдейт того же поста → обновление, а не дубль; правка → новый текст', async () => {
    const { service, news } = createService();
    await service.handleUpdate(channelPost() as any, 'token');
    await expect(service.handleUpdate(channelPost() as any, 'token')).resolves.toBe('updated');
    await expect(service.handleUpdate(channelPost({ text: 'Новый заголовок\nи текст' }, true) as any, 'token')).resolves.toBe('updated');
    expect(news.create).toHaveBeenCalledTimes(1);
    const last = news.update.mock.calls[news.update.mock.calls.length - 1][0];
    expect(last.data).toMatchObject({ title: 'Новый заголовок', excerpt: 'Новый заголовок\nи текст' });
  });

  it('фильтр: пост из чужого канала пропускается, из настроенного — принимается', async () => {
    const { service, news } = createService({}, { TELEGRAM_NEWS_CHAT_ID: '-1009999' });
    await expect(service.handleUpdate(channelPost() as any, 'token')).resolves.toBe('skipped');
    expect(news.create).not.toHaveBeenCalled();

    const allowed = createService({ TELEGRAM_NEWS_CHAT_ID: '-1001234567890' });
    await expect(allowed.service.handleUpdate(channelPost() as any, 'token')).resolves.toBe('created');
  });

  it('служебный пост без текста и фото пропускается', async () => {
    const { service, news } = createService();
    await expect(service.handleUpdate(channelPost({ text: undefined, new_chat_title: 'x' }) as any, 'token')).resolves.toBe('skipped');
    expect(news.create).not.toHaveBeenCalled();
  });

  it('альбом: одна новость на media_group_id, обложка — первое фото, подпись с любого элемента', async () => {
    jest.spyOn(require('fs').promises, 'mkdir').mockResolvedValue(undefined);
    const writeFile = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);
    fetchMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/getFile')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'photos/file_1.jpg' } }) } as any;
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as any;
    });
    const { service, news } = createService();
    const first = channelPost({ message_id: 50, text: undefined, media_group_id: 'g1', photo: [{ file_id: 'p1', width: 800, height: 600 }] });
    const second = channelPost({ message_id: 51, text: undefined, caption: 'Альбом: ход строительства', media_group_id: 'g1', photo: [{ file_id: 'p2', width: 800, height: 600 }] });
    const third = channelPost({ message_id: 52, text: undefined, media_group_id: 'g1', photo: [{ file_id: 'p3', width: 800, height: 600 }] });

    await expect(service.handleUpdate(first as any, 'token')).resolves.toBe('created');
    await expect(service.handleUpdate(second as any, 'token')).resolves.toBe('updated');
    await expect(service.handleUpdate(third as any, 'token')).resolves.toBe('skipped');

    expect(news.create).toHaveBeenCalledTimes(1);
    expect(news.create.mock.calls[0][0].data).toMatchObject({
      telegramMessageId: 50,
      mediaGroupId: 'g1',
      imageUrl: '/files/news/telegram/1234567890-50.jpg',
      url: 'https://t.me/c/1234567890/50',
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(news.update.mock.calls[0][0].data).toMatchObject({ title: 'Альбом: ход строительства', excerpt: 'Альбом: ход строительства' });
    expect(news.update.mock.calls[0][0].data.imageUrl).toBeUndefined();
    // в ссылке на скачивание токен не попадает в публичный URL
    expect(String(fetchMock.mock.calls[0][0])).toContain('/bottoken/getFile');
  });

  it('фото не скачалось → карточка без обложки, но создаётся', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) }) as any);
    const { service, news } = createService();
    await expect(
      service.handleUpdate(channelPost({ text: undefined, caption: 'Подпись', photo: [{ file_id: 'p', width: 10, height: 10 }] }) as any, 'token'),
    ).resolves.toBe('created');
    expect(news.create.mock.calls[0][0].data.imageUrl).toBeNull();
  });
});

describe('порядок публичных новостей (единая лента)', () => {
  const tg = (n: number, day: number, hour = 12) => ({ id: `tg${n}`, source: 'Telegram', telegramChatId: '-100', publishedAt: new Date(2026, 8, day, hour), sortOrder: 0 });
  const site = (n: number, day: number, sortOrder = 0) => ({ id: `s${n}`, source: 'stmichael.ru', telegramChatId: null, publishedAt: new Date(2026, 8, day), sortOrder });

  it('Telegram и сайт вместе по дате, свежие выше', () => {
    const out = orderPublicNews([site(1, 30), tg(1, 1), site(2, 29), tg(2, 5)]);
    expect(out.map((r) => r.id)).toEqual(['s1', 's2', 'tg2', 'tg1']);
  });

  it('в один день Telegram первым, дальше по времени, затем sortOrder', () => {
    const out = orderPublicNews([site(1, 30, 2), site(2, 30, 1), tg(1, 30, 9), tg(2, 30, 18)]);
    expect(out.map((r) => r.id)).toEqual(['tg2', 'tg1', 's2', 's1']);
  });

  it('правило «≥ 4 Telegram → сайт не показываем» больше не действует', () => {
    const out = orderPublicNews([site(1, 30), tg(1, 1), tg(2, 2), tg(3, 3), tg(4, 4)]);
    expect(out.map((r) => r.id)).toEqual(['s1', 'tg4', 'tg3', 'tg2', 'tg1']);
  });

  it('без Telegram-новостей порядок сайта по дате сохраняется', () => {
    const out = orderPublicNews([site(1, 1), site(2, 9)]);
    expect(out.map((r) => r.id)).toEqual(['s2', 's1']);
  });

  it('лимит публичного endpoint: по умолчанию 20, не больше 20, мусор → 20', () => {
    expect(PUBLIC_NEWS_LIMIT).toBe(20);
    expect(clampPublicNewsLimit(undefined)).toBe(20);
    expect(clampPublicNewsLimit('5')).toBe(5);
    expect(clampPublicNewsLimit('99')).toBe(20);
    expect(clampPublicNewsLimit('abc')).toBe(20);
    expect(clampPublicNewsLimit(0)).toBe(20);
  });
});

describe('согласование: разбор callback и права модератора', () => {
  it('news:approve:<id> / news:reject:<id>; чужие данные → null', () => {
    expect(parseModerationCallback('news:approve:3f1c-uuid')).toEqual({ action: 'approve', newsId: '3f1c-uuid' });
    expect(parseModerationCallback('news:reject:abc')).toEqual({ action: 'reject', newsId: 'abc' });
    expect(parseModerationCallback('news:publish:abc')).toBeNull();
    expect(parseModerationCallback('news:approve:')).toBeNull();
    expect(parseModerationCallback('news:approve:a b')).toBeNull();
    expect(parseModerationCallback(undefined)).toBeNull();
  });

  it('список модераторов: запятые/пробелы, только числа, без дублей', () => {
    expect(parseModeratorChatIds('111, 222;333 111', undefined, '-100444')).toEqual(['111', '222', '333', '-100444']);
    expect(parseModeratorChatIds('', null)).toEqual([]);
    expect(parseModeratorChatIds('abc')).toEqual([]);
  });

  it('модератор — по from.id или по чату сообщения; пустой список — никто', () => {
    const query = { id: 'q', from: { id: 111 }, message: { message_id: 1, chat: { id: -100999, type: 'group' } }, data: 'news:approve:x' };
    expect(isModeratorCallback(query, ['111'])).toBe(true);
    expect(isModeratorCallback(query, ['-100999'])).toBe(true);
    expect(isModeratorCallback(query, ['222'])).toBe(false);
    expect(isModeratorCallback(query, [])).toBe(false);
  });

  it('текст «На согласование»: шапка, заголовок, первые 300 символов, ссылка, итог', () => {
    const long = 'Заголовок\n' + 'слово '.repeat(120);
    const text = buildModerationText({ title: 'Заголовок', excerpt: long, url: 'https://t.me/c/1/2' });
    expect(text.startsWith('На согласование: новость для кабинета брокера\n\nЗаголовок\n\n')).toBe(true);
    expect(text).toContain('https://t.me/c/1/2');
    expect(text).not.toContain('Опубликовано');
    expect(moderationPreview(long).length).toBeLessThanOrEqual(300);
    expect(moderationPreview(long).endsWith('…')).toBe(true);
    expect(buildModerationText({ title: 'Т', moderationStatus: 'APPROVED', moderatedBy: 'Анна' })).toContain('✅ Опубликовано: Анна');
    expect(buildModerationText({ title: 'Т', moderationStatus: 'REJECTED', moderatedBy: 'Михаил' })).toContain('❌ Отклонено: Михаил');
  });
});

describe('согласование: уведомления модераторам и кнопки', () => {
  let fetchMock: jest.SpyInstance;
  const calls = () => fetchMock.mock.calls.map((c) => ({ method: String(c[0]).split('/').pop(), body: c[1]?.body ? JSON.parse(c[1].body) : null }));

  function createService(env: Record<string, string | undefined> = {}, settings: Record<string, string> = {}) {
    const rows = new Map<string, any>();
    const news = {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return rows.get(where.id) || null;
        const key = where.telegramChatId_telegramMessageId;
        return [...rows.values()].find((r) => r.telegramChatId === key.telegramChatId && r.telegramMessageId === key.telegramMessageId) || null;
      }),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `id-${rows.size + 1}`, moderationNotices: null, ...data };
        rows.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...rows.get(where.id), ...data };
        rows.set(where.id, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row || (where.moderationStatus && row.moderationStatus !== where.moderationStatus)) return { count: 0 };
        rows.set(where.id, { ...row, ...data });
        return { count: 1 };
      }),
    };
    const systemSetting = {
      findUnique: jest.fn(async ({ where }: any) => (settings[where.key] ? { key: where.key, value: settings[where.key] } : null)),
      upsert: jest.fn(async () => ({})),
    };
    const config = { get: jest.fn((key: string) => env[key]) };
    const service = new TelegramNewsService({ landingNews: news, systemSetting } as any, config as any);
    return { service, news, rows };
  }

  beforeEach(() => {
    let messageId = 100;
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: ++messageId } }),
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('новый пост → PENDING, «На согласование» с кнопками обоим модераторам, message_id сохранены', async () => {
    const { service, rows } = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token' }, { TELEGRAM_NEWS_MODERATOR_CHAT_IDS: '111, 222' });
    await expect(service.handleUpdate(channelPost() as any, 'token')).resolves.toBe('created');
    const sent = calls().filter((c) => c.method === 'sendMessage');
    expect(sent.map((c) => c.body.chat_id)).toEqual(['111', '222']);
    expect(sent[0].body.text).toContain('На согласование: новость для кабинета брокера');
    expect(sent[0].body.text).toContain('Открыли продажи в «Зорге 9»!');
    expect(sent[0].body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(['news:approve:id-1', 'news:reject:id-1']);
    const row = rows.get('id-1');
    expect(row.moderationStatus).toBe('PENDING');
    expect(row.moderationNotices).toEqual([
      { chatId: '111', messageId: 101, hasPhoto: false },
      { chatId: '222', messageId: 102, hasPhoto: false },
    ]);
  });

  it('пост с фото → sendPhoto по file_id с подписью; без модераторов — ничего не шлём', async () => {
    fetchMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/getFile')) return { ok: false, status: 500, json: async () => ({ ok: false }) } as any;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) } as any;
    });
    const withPhoto = channelPost({ text: undefined, caption: 'Ход строительства', photo: [{ file_id: 'big', width: 100, height: 100 }] });
    const { service, rows } = createService({ OPS_ALERT_CHAT_IDS: '333' });
    await expect(service.handleUpdate(withPhoto as any, 'token')).resolves.toBe('created');
    const photo = calls().find((c) => c.method === 'sendPhoto')!;
    expect(photo.body).toMatchObject({ chat_id: '333', photo: 'big' });
    expect(photo.body.caption).toContain('Ход строительства');
    expect(rows.get('id-1').moderationNotices).toEqual([{ chatId: '333', messageId: 7, hasPhoto: true }]);

    fetchMock.mockClear();
    const nobody = createService({});
    await expect(nobody.service.handleUpdate(channelPost() as any, 'token')).resolves.toBe('created');
    expect(calls().some((c) => c.method === 'sendMessage' || c.method === 'sendPhoto')).toBe(false);
    expect(nobody.rows.get('id-1').moderationStatus).toBe('PENDING');
  });

  it('✅ модератор → APPROVED, ответ «Опубликовано», у обоих убраны кнопки и дописан итог; повтор → «Уже обработано»', async () => {
    const { service, rows } = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token' }, { TELEGRAM_NEWS_MODERATOR_CHAT_IDS: '111,222' });
    await service.handleUpdate(channelPost() as any, 'token');
    fetchMock.mockClear();

    const query = { id: 'cb1', from: { id: 222, first_name: 'Анна', last_name: 'Скибицкая' }, message: { message_id: 102, chat: { id: 222, type: 'private' } }, data: 'news:approve:id-1' };
    await expect(service.handleCallback(query as any, 'token')).resolves.toBe('approved');
    const row = rows.get('id-1');
    expect(row.moderationStatus).toBe('APPROVED');
    expect(row.moderatedBy).toBe('Анна Скибицкая');
    expect(row.moderatedAt).toBeInstanceOf(Date);

    const answer = calls().find((c) => c.method === 'answerCallbackQuery')!;
    expect(answer.body).toMatchObject({ callback_query_id: 'cb1', text: 'Опубликовано' });
    const edits = calls().filter((c) => c.method === 'editMessageText');
    expect(edits.map((c) => [c.body.chat_id, c.body.message_id])).toEqual([['111', 101], ['222', 102]]);
    for (const edit of edits) {
      expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
      expect(edit.body.text).toContain('✅ Опубликовано: Анна Скибицкая');
    }

    fetchMock.mockClear();
    await expect(service.handleCallback({ ...query, id: 'cb2', from: { id: 111, first_name: 'Михаил' } } as any, 'token')).resolves.toBe('already');
    expect(calls().map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(calls()[0].body.text).toMatch(/^Уже обработано/);
    expect(rows.get('id-1').moderatedBy).toBe('Анна Скибицкая');
  });

  it('❌ → REJECTED и «Отклонено»; не модератор → «Нет прав», статус не меняется; чужой callback игнорируется', async () => {
    const { service, rows } = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token' }, { TELEGRAM_NEWS_MODERATOR_CHAT_IDS: '111' });
    await service.handleUpdate(channelPost() as any, 'token');
    fetchMock.mockClear();

    const stranger = { id: 'cb9', from: { id: 999, first_name: 'Гость' }, message: { message_id: 5, chat: { id: 999, type: 'private' } }, data: 'news:reject:id-1' };
    await expect(service.handleCallback(stranger as any, 'token')).resolves.toBe('forbidden');
    expect(rows.get('id-1').moderationStatus).toBe('PENDING');
    expect(calls().map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(calls()[0].body.text).toBe('Нет прав на согласование');

    fetchMock.mockClear();
    await expect(service.handleCallback({ id: 'cb0', from: { id: 111 }, data: 'something:else' } as any, 'token')).resolves.toBe('ignored');
    expect(fetchMock).not.toHaveBeenCalled();

    const owner = { id: 'cb3', from: { id: 111, first_name: 'Михаил' }, message: { message_id: 101, chat: { id: 111, type: 'private' } }, data: 'news:reject:id-1' };
    await expect(service.handleCallback(owner as any, 'token')).resolves.toBe('rejected');
    expect(rows.get('id-1').moderationStatus).toBe('REJECTED');
    expect(calls().find((c) => c.method === 'answerCallbackQuery')!.body.text).toBe('Отклонено');
    expect(calls().find((c) => c.method === 'editMessageText')!.body.text).toContain('❌ Отклонено: Михаил');

    await expect(service.handleCallback({ ...owner, id: 'cb4', data: 'news:approve:no-such' } as any, 'token')).resolves.toBe('not_found');
  });

  it('правка поста: PENDING → текст обновлён и у модераторов тоже; APPROVED → текст обновлён, статус остаётся', async () => {
    const { service, rows } = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token' }, { TELEGRAM_NEWS_MODERATOR_CHAT_IDS: '111' });
    await service.handleUpdate(channelPost() as any, 'token');
    fetchMock.mockClear();

    await expect(service.handleUpdate(channelPost({ text: 'Новый текст поста' }, true) as any, 'token')).resolves.toBe('updated');
    expect(rows.get('id-1')).toMatchObject({ moderationStatus: 'PENDING', title: 'Новый текст поста' });
    const edit = calls().find((c) => c.method === 'editMessageText')!;
    expect(edit.body).toMatchObject({ chat_id: '111', message_id: 101 });
    expect(edit.body.text).toContain('Новый текст поста');
    expect(edit.body.reply_markup.inline_keyboard[0]).toHaveLength(2);

    await service.moderate('id-1', 'APPROVED', 'Админ');
    fetchMock.mockClear();
    await expect(service.handleUpdate(channelPost({ text: 'Ещё одна правка' }, true) as any, 'token')).resolves.toBe('updated');
    expect(rows.get('id-1')).toMatchObject({ moderationStatus: 'APPROVED', title: 'Ещё одна правка', moderatedBy: 'Админ' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('moderate из админки: первое решение done, второе already', async () => {
    const { service } = createService({}, {});
    await service.handleUpdate(channelPost() as any, 'token');
    await expect(service.moderate('id-1', 'REJECTED', 'Михаил (админка)')).resolves.toMatchObject({ result: 'done', status: 'REJECTED' });
    await expect(service.moderate('id-1', 'APPROVED', 'Кто-то ещё')).resolves.toMatchObject({ result: 'already', status: 'REJECTED' });
    await expect(service.moderate('nope', 'APPROVED', 'x')).resolves.toMatchObject({ result: 'not_found' });
  });

  // 2026-09-30: из админки решение можно менять — «Скрыть» опубликованную и
  // «Опубликовать» скрытую; из бота (без allowChange) — только первое решение.
  it('allowChange (админка): APPROVED → REJECTED («Скрыть») → APPROVED; тот же статус → already; бот менять не может', async () => {
    const { service, rows } = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token' }, { TELEGRAM_NEWS_MODERATOR_CHAT_IDS: '111' });
    await service.handleUpdate(channelPost() as any, 'token');
    await expect(service.moderate('id-1', 'APPROVED', 'Анна')).resolves.toMatchObject({ result: 'done', status: 'APPROVED' });

    await expect(service.moderate('id-1', 'REJECTED', 'Михаил', undefined, { allowChange: true })).resolves.toMatchObject({ result: 'done', status: 'REJECTED' });
    expect(rows.get('id-1')).toMatchObject({ moderationStatus: 'REJECTED', moderatedBy: 'Михаил' });
    const edits = calls().filter((c) => c.method === 'editMessageText');
    expect(edits[edits.length - 1].body.text).toContain('❌ Отклонено: Михаил');
    expect(edits[edits.length - 1].body.reply_markup).toEqual({ inline_keyboard: [] });

    await expect(service.moderate('id-1', 'REJECTED', 'Михаил', undefined, { allowChange: true })).resolves.toMatchObject({ result: 'already', status: 'REJECTED' });
    await expect(service.moderate('id-1', 'APPROVED', 'Михаил', undefined, { allowChange: true })).resolves.toMatchObject({ result: 'done', status: 'APPROVED' });
    expect(rows.get('id-1').moderationStatus).toBe('APPROVED');

    // Кнопка в боте по уже решённой новости — «Уже обработано», статус не меняется.
    const query = { id: 'cb', from: { id: 111, first_name: 'Анна' }, message: { message_id: 101, chat: { id: 111, type: 'private' } }, data: 'news:reject:id-1' };
    await expect(service.handleCallback(query as any, 'token')).resolves.toBe('already');
    expect(rows.get('id-1').moderationStatus).toBe('APPROVED');
  });

  // 2026-09-30: новость с сайта stmichael.ru (парсер) — то же уведомление с
  // кнопками; обложка уходит по https-ссылке сайта, кнопки общие по id.
  it('requestModeration (сайт): sendPhoto по https-ссылке обложки, кнопки news:approve/reject:<id>; без обложки — текстом; не PENDING — молчим', async () => {
    const { service, rows, news } = createService({ OPS_TELEGRAM_BOT_TOKEN: 'token' }, { TELEGRAM_NEWS_MODERATOR_CHAT_IDS: '111, 222' });
    const site = await news.create({
      data: { title: 'Новая школа на 1 000 мест появится рядом с «Зорге 9»', source: 'stmichael.ru', url: 'https://stmichael.ru/news/novaya-shkola', imageUrl: 'https://stmichael.ru/proxy/w:960/q:80/abc.jpg', excerpt: null, moderationStatus: 'PENDING' },
    });
    await service.requestModeration(site, site.imageUrl);
    const photos = calls().filter((c) => c.method === 'sendPhoto');
    expect(photos.map((c) => c.body.chat_id)).toEqual(['111', '222']);
    expect(photos[0].body.photo).toBe('https://stmichael.ru/proxy/w:960/q:80/abc.jpg');
    expect(photos[0].body.caption).toContain('На согласование: новость для кабинета брокера');
    expect(photos[0].body.caption).toContain('Новая школа на 1 000 мест появится рядом с «Зорге 9»');
    expect(photos[0].body.caption).toContain('https://stmichael.ru/news/novaya-shkola');
    expect(photos[0].body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([`news:approve:${site.id}`, `news:reject:${site.id}`]);
    expect(rows.get(site.id).moderationNotices).toEqual([
      { chatId: '111', messageId: 101, hasPhoto: true },
      { chatId: '222', messageId: 102, hasPhoto: true },
    ]);

    // Кнопка модератора по сайтовой новости — та же обработка.
    const query = { id: 'cb', from: { id: 222, first_name: 'Анна' }, message: { message_id: 102, chat: { id: 222, type: 'private' } }, data: `news:approve:${site.id}` };
    await expect(service.handleCallback(query as any, 'token')).resolves.toBe('approved');
    expect(rows.get(site.id)).toMatchObject({ moderationStatus: 'APPROVED', moderatedBy: 'Анна' });
    expect(calls().filter((c) => c.method === 'editMessageCaption').map((c) => c.body.chat_id)).toEqual(['111', '222']);

    fetchMock.mockClear();
    const noCover = await news.create({ data: { title: 'Без обложки', source: 'stmichael.ru', url: 'https://stmichael.ru/news/x', imageUrl: null, moderationStatus: 'PENDING' } });
    await service.requestModeration(noCover);
    expect(calls().map((c) => c.method)).toEqual(['sendMessage', 'sendMessage']);

    fetchMock.mockClear();
    const approved = await news.create({ data: { title: 'Старая', source: 'stmichael.ru', url: 'https://stmichael.ru/news/y', imageUrl: null, moderationStatus: 'APPROVED' } });
    await service.requestModeration(approved);
    expect(calls()).toEqual([]);
  });
});
