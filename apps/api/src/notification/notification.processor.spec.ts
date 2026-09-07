import { NotificationProcessor } from './notification.processor';

describe('NotificationProcessor Telegram delivery', () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalTimeout = process.env.TELEGRAM_REQUEST_TIMEOUT_MS;
  let fetchMock: jest.SpyInstance;

  function createProcessor(chatId: bigint | null) {
    const prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'notification-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      broker: {
        findUnique: jest.fn().mockResolvedValue({
          phone: '+79990000000',
          email: 'broker@example.test',
          telegramChatId: chatId,
        }),
      },
    };
    return {
      processor: new NotificationProcessor(prisma as any),
      prisma,
    };
  }

  function telegramJob() {
    return {
      data: {
        brokerId: 'broker-1',
        channel: 'TELEGRAM',
        body: '<b>Plain text</b>',
      },
    } as any;
  }

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.TELEGRAM_REQUEST_TIMEOUT_MS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalTimeout === undefined) delete process.env.TELEGRAM_REQUEST_TIMEOUT_MS;
    else process.env.TELEGRAM_REQUEST_TIMEOUT_MS = originalTimeout;
  });

  it('marks a notification as FAILED when the token is missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { processor, prisma } = createProcessor(BigInt(42));

    await expect(processor.handleSend(telegramJob())).rejects.toThrow('TELEGRAM_BOT_TOKEN is not configured');
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'notification-1' },
      data: { status: 'FAILED', sentAt: undefined },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks a notification as FAILED when the broker has no chat ID', async () => {
    const { processor, prisma } = createProcessor(null);

    await expect(processor.handleSend(telegramJob())).rejects.toThrow('Broker has no Telegram chat ID');
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'notification-1' },
      data: { status: 'FAILED', sentAt: undefined },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends plain text and marks SENT only after Telegram returns ok', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ ok: true }),
    } as any);
    const { processor, prisma } = createProcessor(BigInt(42));

    await expect(processor.handleSend(telegramJob())).resolves.toBeUndefined();

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      chat_id: '42',
      text: '<b>Plain text</b>',
    });
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'notification-1' },
      data: { status: 'SENT', sentAt: expect.any(Date) },
    });
  });

  it.each([
    [false, 502, { ok: false }, 'HTTP 502'],
    [true, 200, { ok: false }, 'API rejected'],
  ])('marks FAILED for Telegram response ok=%s status=%s', async (httpOk, status, responseBody, expectedError) => {
    fetchMock.mockResolvedValue({
      ok: httpOk,
      status,
      json: jest.fn().mockResolvedValue(responseBody),
    } as any);
    const { processor, prisma } = createProcessor(BigInt(42));

    await expect(processor.handleSend(telegramJob())).rejects.toThrow(expectedError);
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'notification-1' },
      data: { status: 'FAILED', sentAt: undefined },
    });
  });

  it('aborts Telegram delivery after the configured timeout', async () => {
    jest.useFakeTimers();
    process.env.TELEGRAM_REQUEST_TIMEOUT_MS = '25';
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      async (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          requestSignal = init.signal as AbortSignal;
          requestSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const { processor, prisma } = createProcessor(BigInt(42));

    const delivery = processor.handleSend(telegramJob());
    const expectation = expect(delivery).rejects.toThrow('Request timed out after 25 ms');
    await jest.advanceTimersByTimeAsync(25);

    await expectation;
    expect(requestSignal?.aborted).toBe(true);
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'notification-1' },
      data: { status: 'FAILED', sentAt: undefined },
    });
  });
});
