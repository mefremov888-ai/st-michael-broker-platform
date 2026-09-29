import { orderPublicNews, TELEGRAM_NEWS_ENOUGH } from '../cms/cms.service';
import {
  buildTelegramPostUrl,
  isAllowedNewsChat,
  parseChannelPost,
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
        const key = where.telegramChatId_telegramMessageId;
        return [...rows.values()].find((r) => r.telegramChatId === key.telegramChatId && r.telegramMessageId === key.telegramMessageId) || null;
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

describe('порядок публичных новостей', () => {
  const tg = (n: number, day: number) => ({ id: `tg${n}`, source: 'Telegram', telegramChatId: '-100', publishedAt: new Date(2026, 8, day), sortOrder: 0 });
  const site = (n: number, day: number) => ({ id: `s${n}`, source: 'stmichael.ru', telegramChatId: null, publishedAt: new Date(2026, 8, day), sortOrder: 0 });

  it('Telegram первыми по дате, сайт хвостом, если Telegram-новостей мало', () => {
    const out = orderPublicNews([site(1, 30), tg(1, 1), site(2, 29), tg(2, 5)]);
    expect(out.map((r) => r.id)).toEqual(['tg2', 'tg1', 's1', 's2']);
  });

  it(`при ≥ ${TELEGRAM_NEWS_ENOUGH} Telegram-новостях сайт не отдаём`, () => {
    const out = orderPublicNews([site(1, 30), tg(1, 1), tg(2, 2), tg(3, 3), tg(4, 4)]);
    expect(out.map((r) => r.id)).toEqual(['tg4', 'tg3', 'tg2', 'tg1']);
  });

  it('без Telegram-новостей порядок сайта по дате сохраняется', () => {
    const out = orderPublicNews([site(1, 1), site(2, 9)]);
    expect(out.map((r) => r.id)).toEqual(['s2', 's1']);
  });
});
