import * as crypto from 'crypto';
import {
  getMangoConfig,
  MangoAdapter,
  setMangoConfig,
} from '@st-michael/integrations';
import { MangoBootstrapService } from './mango-bootstrap.service';

describe('Mango runtime config', () => {
  const originalConfig = getMangoConfig();
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.useRealTimers();
    setMangoConfig(originalConfig);
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('loads outbound line from SystemSetting', async () => {
    const prisma = {
      systemSetting: {
        findMany: jest.fn().mockResolvedValue([
          { key: 'MANGO_OUTBOUND_LINE', value: '+7 (499) 000-00-00' },
        ]),
      },
    };
    const service = new MangoBootstrapService(prisma as any);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    await service.onApplicationBootstrap();

    expect(getMangoConfig().outboundLine).toBe('+7 (499) 000-00-00');
  });

  it('uses the centralized outbound line in a signed VPBX callback', async () => {
    setMangoConfig({
      apiKey: 'test-api-key',
      apiSalt: 'test-api-salt',
      apiUrl: 'https://app.mango-office.ru/vpbx',
      callbackUrl: '',
      outboundLine: '+7 (499) 000-00-00',
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await new MangoAdapter().initiateCallbackFromExtension({
      extension: '17',
      to: '+7 (999) 111-22-33',
    });

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = new URLSearchParams(String(options.body));
    const json = String(body.get('json'));
    const payload = JSON.parse(json);
    expect(url).toBe('https://app.mango-office.ru/vpbx/commands/callback');
    expect(payload).toMatchObject({
      from: { extension: '17' },
      to_number: '79991112233',
      line_number: '74990000000',
    });
    expect(body.get('sign')).toBe(
      crypto
        .createHash('sha256')
        .update(`test-api-key${json}test-api-salt`)
        .digest('hex'),
    );
  });

  it('substitutes only query placeholders on the allowlisted callback endpoint', async () => {
    setMangoConfig({
      callbackUrl:
        'https://integration-webhook.mango-office.ru/webhookapp/common'
        + '?code=test&Source=Other&API_key=test&Action=Callback'
        + '&EmployeeNUM=%7B%7B%D0%9E%D1%82%D0%B2%D0%B5%D1%82%D1%81%D1%82%D0%B2%D0%B5%D0%BD%D0%BD%D1%8B%D0%B9%7D%7D'
        + '&TelNumbr=%7B%7B%D0%A2%D0%B5%D0%BB%D0%B5%D1%84%D0%BE%D0%BD%7D%7D',
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await new MangoAdapter().initiateCallbackViaWebhook({
      employeeNum: '17',
      phone: '+7 (999) 111-22-33',
    });

    const [rawUrl, options] = (global.fetch as jest.Mock).mock.calls[0];
    const calledUrl = new URL(String(rawUrl));
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      'https://integration-webhook.mango-office.ru/webhookapp/common',
    );
    expect(calledUrl.searchParams.get('EmployeeNUM')).toBe('17');
    expect(calledUrl.searchParams.get('TelNumbr')).toBe('79991112233');
    expect(options.redirect).toBe('error');
  });

  it('aborts a VPBX request after the bounded 10 second timeout', async () => {
    jest.useFakeTimers();
    setMangoConfig({
      apiKey: 'test-api-key',
      apiSalt: 'test-api-salt',
      apiUrl: 'https://app.mango-office.ru/vpbx',
      callbackUrl: '',
      outboundLine: '',
    });
    global.fetch = jest.fn((_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    ) as any;

    const request = new MangoAdapter().initiateCallback({
      from: '+7 (999) 000-00-01',
      to: '+7 (999) 000-00-02',
    });
    const assertion = expect(request).rejects.toThrow(
      'Mango request timed out after 10s',
    );

    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it.each(['', '17A', '1 7', '123456789012345678901'])(
    'rejects invalid extension %j before sending a request',
    async (extension) => {
      setMangoConfig({
        apiKey: 'test-api-key',
        apiSalt: 'test-api-salt',
        apiUrl: 'https://app.mango-office.ru/vpbx',
        outboundLine: '',
      });
      global.fetch = jest.fn() as any;

      await expect(
        new MangoAdapter().initiateCallbackFromExtension({
          extension,
          to: '+7 (999) 111-22-33',
        }),
      ).rejects.toThrow('от 1 до 20 цифр');
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid env/runtime outbound line before sending a request', async () => {
    setMangoConfig({
      apiKey: 'test-api-key',
      apiSalt: 'test-api-salt',
      apiUrl: 'https://app.mango-office.ru/vpbx',
      outboundLine: '12345',
    });
    global.fetch = jest.fn() as any;

    await expect(
      new MangoAdapter().initiateCallbackFromExtension({
        extension: '17',
        to: '+7 (999) 111-22-33',
      }),
    ).rejects.toThrow('от 10 до 15 цифр');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
