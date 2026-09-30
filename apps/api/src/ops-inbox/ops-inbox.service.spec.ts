import { ALLOWED_UPDATES, OpsInboxService } from './ops-inbox.service';

/**
 * 2026-09-30: опрос getUpdates — единственный потребитель апдейтов бота.
 * Проверяем маршрутизацию: сообщения → входящие, посты канала →
 * TelegramNewsService.handleUpdate, нажатия кнопок согласования →
 * TelegramNewsService.handleCallback; offset сдвигается за всеми.
 */

function createService(updates: any[]) {
  const settings: Record<string, string> = {};
  const inbox = { upsert: jest.fn(async () => ({})) };
  const prisma = {
    opsInboxMessage: inbox,
    systemSetting: {
      findUnique: jest.fn(async ({ where }: any) => (settings[where.key] ? { key: where.key, value: settings[where.key] } : null)),
      upsert: jest.fn(async ({ where, create }: any) => {
        settings[where.key] = create.value;
        return {};
      }),
    },
  };
  const config = { get: jest.fn((key: string) => (key === 'OPS_TELEGRAM_BOT_TOKEN' ? 'token' : undefined)) };
  const telegramNews = {
    handleUpdate: jest.fn(async () => 'created'),
    handleCallback: jest.fn(async () => 'approved'),
  };
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: updates }),
  } as any);
  const service = new OpsInboxService(prisma as any, config as any, telegramNews as any);
  return { service, inbox, telegramNews, settings, fetchMock };
}

describe('OpsInboxService.poll', () => {
  afterEach(() => jest.restoreAllMocks());

  it('подписывается на callback_query вместе с постами канала и сообщениями', () => {
    expect(ALLOWED_UPDATES).toEqual(expect.arrayContaining(['message', 'channel_post', 'edited_channel_post', 'callback_query']));
  });

  it('раскладывает апдейты: сообщение → входящие, пост → новости, кнопка → согласование; offset = max+1', async () => {
    const updates = [
      { update_id: 10, message: { message_id: 1, date: 1, chat: { id: 111, type: 'private' }, from: { id: 111, first_name: 'Михаил' }, text: 'привет' } },
      { update_id: 11, channel_post: { message_id: 2, date: 1, chat: { id: -100, type: 'channel' }, text: 'пост' } },
      { update_id: 12, callback_query: { id: 'cb', from: { id: 111 }, data: 'news:approve:x' } },
      { update_id: 13, message: { message_id: 3, date: 1, chat: { id: 5, type: 'private' }, from: { id: 5, is_bot: true }, text: 'бот' } },
    ];
    const { service, inbox, telegramNews, settings, fetchMock } = createService(updates);
    await service.poll();

    expect(String(fetchMock.mock.calls[0][0])).toContain(encodeURIComponent(JSON.stringify(ALLOWED_UPDATES)));
    expect(inbox.upsert).toHaveBeenCalledTimes(1);
    expect(telegramNews.handleUpdate).toHaveBeenCalledWith(updates[1], 'token');
    expect(telegramNews.handleCallback).toHaveBeenCalledWith(updates[2].callback_query, 'token');
    expect(settings.OPS_INBOX_UPDATE_OFFSET).toBe('14');
  });

  it('ошибка в обработке кнопки не останавливает опрос и не мешает сдвигу offset', async () => {
    const updates = [
      { update_id: 20, callback_query: { id: 'cb', from: { id: 111 }, data: 'news:approve:x' } },
      { update_id: 21, message: { message_id: 1, date: 1, chat: { id: 111, type: 'private' }, from: { id: 111 }, text: 'после' } },
    ];
    const { service, inbox, telegramNews, settings } = createService(updates);
    telegramNews.handleCallback.mockRejectedValueOnce(new Error('boom'));
    await service.poll();
    expect(inbox.upsert).toHaveBeenCalledTimes(1);
    expect(settings.OPS_INBOX_UPDATE_OFFSET).toBe('22');
  });
});
