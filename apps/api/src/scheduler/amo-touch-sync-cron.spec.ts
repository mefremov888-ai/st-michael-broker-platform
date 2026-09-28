// 2026-09-28: крон ночного синка касаний — флаг выключения, проверка токена,
// делегирование в AmoTouchSyncService.
import { SchedulerService } from './scheduler.service';

function makeService(amoTouchSync: any, opsAlerts?: any) {
  const service = new SchedulerService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    opsAlerts as any,
    undefined as any,
    undefined as any,
    amoTouchSync,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  return service;
}

describe('SchedulerService.handleAmoTouchSync', () => {
  const originalEnabled = process.env.AMO_TOUCH_SYNC_ENABLED;
  const originalToken = process.env.AMO_ACCESS_TOKEN;
  const originalRefresh = process.env.AMO_REFRESH_TOKEN;
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(() => {
    delete process.env.AMO_TOUCH_SYNC_ENABLED;
    delete process.env.AMO_REFRESH_TOKEN;
  });

  afterEach(() => {
    restore('AMO_TOUCH_SYNC_ENABLED', originalEnabled);
    restore('AMO_ACCESS_TOKEN', originalToken);
    restore('AMO_REFRESH_TOKEN', originalRefresh);
  });

  it('запускает run({mode:"apply"}) когда токен есть', async () => {
    process.env.AMO_ACCESS_TOKEN = 'test-token';
    const run = jest.fn().mockResolvedValue({
      status: 'SUCCEEDED',
      errorCode: null,
      reason: null,
      stats: { contactsTotal: 1, contactsChanged: 0, touched: 0, linked: 0, errors: 0, requests: 2, durationMs: 10 },
    });
    const service = makeService({ run });
    await service.handleAmoTouchSync();
    expect(run).toHaveBeenCalledWith({ mode: 'apply' });
  });

  it('AMO_TOUCH_SYNC_ENABLED=false — не запускает', async () => {
    process.env.AMO_ACCESS_TOKEN = 'test-token';
    process.env.AMO_TOUCH_SYNC_ENABLED = 'false';
    const run = jest.fn();
    await makeService({ run }).handleAmoTouchSync();
    expect(run).not.toHaveBeenCalled();
  });

  it('без токена — алерт и пропуск; исключение из run не роняет крон', async () => {
    delete process.env.AMO_ACCESS_TOKEN;
    const run = jest.fn();
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    await makeService({ run }, opsAlerts).handleAmoTouchSync();
    expect(run).not.toHaveBeenCalled();
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining('amoCRM'),
      expect.objectContaining({ dedupKey: 'scheduler:amo:token-missing' }),
    );

    process.env.AMO_ACCESS_TOKEN = 'test-token';
    const failing = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(makeService({ run: failing }).handleAmoTouchSync()).resolves.toBeUndefined();
  });
});
