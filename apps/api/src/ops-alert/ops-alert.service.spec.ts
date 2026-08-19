import { OpsAlertService } from './ops-alert.service';

describe('OpsAlertService', () => {
  let fetchMock: jest.SpyInstance;

  function createService(values: Record<string, string | undefined>) {
    const config = {
      get: jest.fn((key: string) => values[key]),
    };
    return new OpsAlertService(config as any);
  }

  const telegramSuccess = () =>
    ({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ ok: true }),
    }) as any;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('sends plain text to every unique configured chat', async () => {
    fetchMock.mockImplementation(async () => telegramSuccess());
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'ops-token',
      TELEGRAM_BOT_TOKEN: 'fallback-token',
      OPS_ALERT_CHAT_IDS: '-1001, -1002',
      OPS_ALERT_CHAT_ID: '-1002; -1003',
    });

    await expect(service.send('Service is unavailable')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botops-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: '-1001',
          text: 'Service is unavailable',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body)).not.toHaveProperty('parse_mode');
    }
  });

  it('uses TELEGRAM_BOT_TOKEN as a fallback', async () => {
    fetchMock.mockResolvedValue(telegramSuccess());
    const service = createService({
      TELEGRAM_BOT_TOKEN: 'fallback-token',
      OPS_ALERT_CHAT_ID: '42',
    });

    await service.send('Alert');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/botfallback-token/sendMessage');
  });

  it('skips a duplicate key during its cooldown', async () => {
    fetchMock.mockResolvedValue(telegramSuccess());
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_ID: '42',
    });

    await expect(service.send('First', { dedupKey: 'service-down', cooldownMs: 60_000 })).resolves.toBe(true);
    await expect(service.send('Second', { dedupKey: 'service-down', cooldownMs: 60_000 })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not consume the dedup cooldown when delivery fails', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ ok: false }),
      } as any)
      .mockResolvedValueOnce(telegramSuccess());
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_ID: '42',
    });
    const options = { dedupKey: 'service-down', cooldownMs: 60_000 };

    await expect(service.send('First', options)).rejects.toThrow('Telegram delivery failed');
    await expect(service.send('Retry', options)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the dedup cooldown after partial multi-chat delivery', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const { chat_id: chatId } = JSON.parse(String(init.body));
      if (chatId === '-1002') {
        return {
          ok: false,
          status: 400,
          json: jest.fn().mockResolvedValue({ ok: false }),
        } as any;
      }
      return telegramSuccess();
    });
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_IDS: '-1001,-1002',
    });
    const options = { dedupKey: 'service-down', cooldownMs: 60_000 };

    await expect(service.send('First', options)).rejects.toThrow(
      'Telegram delivery failed for 1 of 2 configured ops chats',
    );
    await expect(service.send('Duplicate', options)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects unsuccessful HTTP and Telegram API responses', async () => {
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_ID: '42',
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: jest.fn().mockResolvedValue({ ok: false }),
    } as any);
    await expect(service.send('HTTP failure')).rejects.toThrow('Telegram delivery failed');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ ok: false }),
    } as any);
    await expect(service.send('API failure')).rejects.toThrow('Telegram delivery failed');
  });

  it('returns false without sending when configuration is incomplete', async () => {
    const service = createService({});

    await expect(service.send('Alert')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a request after the configured timeout', async () => {
    jest.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      async (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          requestSignal = init.signal as AbortSignal;
          requestSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const service = createService({
      OPS_TELEGRAM_BOT_TOKEN: 'token',
      OPS_ALERT_CHAT_ID: '42',
      OPS_TELEGRAM_TIMEOUT_MS: '25',
    });

    const delivery = service.send('Alert');
    const expectation = expect(delivery).rejects.toThrow('Telegram delivery failed');
    await jest.advanceTimersByTimeAsync(25);

    await expectation;
    expect(requestSignal?.aborted).toBe(true);
  });
});
