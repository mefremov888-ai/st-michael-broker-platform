import * as crypto from 'crypto';

export interface CallStatus {
  id: string;
  status: string;
  duration?: number;
  recording_url?: string;
  start_time?: string;
  end_time?: string;
}

export interface CallbackRequest {
  // Кому Mango сначала наберёт (берёт трубку → дальше дозванивается до to_number).
  // Обычно — мобильный/добавочный брокера. Формат — голые цифры (74950123456).
  from: string;
  // Кому соединять. Формат — голые цифры.
  to: string;
  // Caller ID, который увидит to (обычно — общий офисный номер St Michael).
  // Если не задан — Mango берёт дефолтный исходящий по аккаунту.
  lineNumber?: string;
}

export interface IMangoAdapter {
  initiateCallback(req: CallbackRequest): Promise<{ callId: string }>;
  /** @deprecated stub-метод старого API. Используй initiateCallback. */
  initiateCall(from: string, to: string): Promise<{ callId: string }>;
  getCallRecording(callId: string): Promise<string>;
  getCallStatus(callId: string): Promise<CallStatus>;
}

// 2026-06-08: модульный shared-state для Mango-конфигурации.
// Управляется из /admin/integrations через UI без рестарта/SSH.
// На старте API bootstrap читает из SystemSetting → setMangoConfig().
// Если в БД пусто — fallback на env.
// 2026-06-09: добавили поле callbackUrl — полный URL integration-webhook
// шаблона с плейсхолдерами {{Ответственный}} и {{Телефон}}. Пример:
//   https://integration-webhook.mango-office.ru/webhookapp/common?
//     code=<ID>&Source=Other&API_key=<API_KEY>&Action=Callback&
//     EmployeeNUM={{Ответственный}}&TelNumbr={{Телефон}}
type MangoConfig = { apiKey: string; apiSalt: string; apiUrl: string; callbackUrl: string };

const DEFAULT_MANGO_URL = 'https://app.mango-office.ru/vpbx';

let mangoConfig: MangoConfig = {
  apiKey: process.env.MANGO_API_KEY || '',
  apiSalt: process.env.MANGO_API_SALT || '',
  apiUrl: process.env.MANGO_API_URL || DEFAULT_MANGO_URL,
  callbackUrl: process.env.MANGO_CALLBACK_URL || '',
};

export function setMangoConfig(cfg: Partial<MangoConfig>): void {
  mangoConfig = {
    apiKey: cfg.apiKey ?? mangoConfig.apiKey,
    apiSalt: cfg.apiSalt ?? mangoConfig.apiSalt,
    // Нормализуем URL: убираем trailing slash, чтобы `${url}/commands/callback`
    // не получался с двойным слешем.
    apiUrl: (cfg.apiUrl ?? mangoConfig.apiUrl).replace(/\/+$/, '') || DEFAULT_MANGO_URL,
    callbackUrl: cfg.callbackUrl ?? mangoConfig.callbackUrl,
  };
}

export function getMangoConfig(): MangoConfig {
  return { ...mangoConfig };
}

// 2026-06-09: in-memory rate-limit для click-to-call (Mango лимит 20/мин).
// timestamps в мс, чистим до 60 секунд назад при каждом запросе.
const callTimestamps: number[] = [];
const MANGO_RATE_LIMIT_PER_MIN = 20;

/**
 * Mango VPBX integration — outbound callback.
 *
 * Doc: https://www.mango-office.ru/upload/api/vpbx_api.pdf
 * Endpoint: POST {apiUrl}/commands/callback
 * Auth: HMAC-SHA256 от (vpbx_api_key + json_body + vpbx_api_salt).
 *
 * Источники конфигурации (приоритет ↓):
 *   1. SystemSetting в БД (управляется из /admin/integrations)
 *   2. env: MANGO_API_KEY / MANGO_API_SALT / MANGO_API_URL
 *
 * Результат звонка прилетит в наш webhook /webhooks/mango/call-result,
 * где мы найдём запись Call по mangoCallId и обновим status/duration/recording.
 */
export class MangoAdapter implements IMangoAdapter {
  private get apiKey(): string {
    return mangoConfig.apiKey;
  }
  private get apiSalt(): string {
    return mangoConfig.apiSalt;
  }
  private get apiUrl(): string {
    return mangoConfig.apiUrl;
  }

  private digits(phone: string): string {
    return String(phone || '').replace(/\D/g, '');
  }

  /**
   * Инициировать callback: Mango звонит сначала `from`, после поднятия трубки
   * дозванивается до `to` и соединяет. callId возвращается СРАЗУ (это наш
   * command_id), реальный mango_call_id придёт в webhook позже.
   */
  async initiateCallback(req: CallbackRequest): Promise<{ callId: string }> {
    if (!this.apiKey || !this.apiSalt) {
      throw new Error('Mango: API key / salt не настроены (см. /admin/integrations)');
    }
    const commandId = crypto.randomUUID();
    const fromDigits = this.digits(req.from);
    const toDigits = this.digits(req.to);
    if (fromDigits.length < 10 || toDigits.length < 10) {
      throw new Error(`Mango callback: некорректные номера (from=${req.from}, to=${req.to})`);
    }

    const json = JSON.stringify({
      command_id: commandId,
      from: { number: fromDigits },
      to_number: toDigits,
      ...(req.lineNumber ? { line_number: this.digits(req.lineNumber) } : {}),
    });
    const sign = crypto
      .createHash('sha256')
      .update(this.apiKey + json + this.apiSalt)
      .digest('hex');

    const params = new URLSearchParams({
      vpbx_api_key: this.apiKey,
      sign,
      json,
    });

    const res = await fetch(`${this.apiUrl}/commands/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mango callback ${res.status}: ${text.slice(0, 300)}`);
    }
    return { callId: commandId };
  }

  /**
   * 2026-07 (issue #2): callback от ВНУТРЕННЕГО НОМЕРА сотрудника.
   * Mango звонит на extension менеджера (его SIP/МангоМобайл), после ответа
   * дозванивается до `to` и соединяет. Штатный VPBX commands/callback с
   * HMAC-подписью — нужны только api_key + api_salt (MANGO_CALLBACK_URL НЕ
   * требуется). extension — короткий внутренний номер сотрудника (напр. "33").
   */
  async initiateCallbackFromExtension(req: {
    extension: string;
    to: string;
    lineNumber?: string;
  }): Promise<{ callId: string }> {
    if (!this.apiKey || !this.apiSalt) {
      throw new Error('Mango: API key / salt не настроены (см. /admin/integrations)');
    }
    const extension = String(req.extension || '').trim();
    if (!extension) {
      throw new Error('Mango callback: не указан внутренний номер сотрудника (extension)');
    }
    const toDigits = this.digits(req.to);
    if (toDigits.length < 10) {
      throw new Error(`Mango callback: некорректный номер брокера (${req.to})`);
    }

    const commandId = crypto.randomUUID();
    const json = JSON.stringify({
      command_id: commandId,
      from: { extension },
      to_number: toDigits,
      ...(req.lineNumber ? { line_number: this.digits(req.lineNumber) } : {}),
    });
    const sign = crypto
      .createHash('sha256')
      .update(this.apiKey + json + this.apiSalt)
      .digest('hex');

    const params = new URLSearchParams({ vpbx_api_key: this.apiKey, sign, json });
    const res = await fetch(`${this.apiUrl}/commands/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mango callback ${res.status}: ${text.slice(0, 300)}`);
    }
    return { callId: commandId };
  }
  /** Совместимость со старым stub-API. */
  async initiateCall(from: string, to: string): Promise<{ callId: string }> {
    return this.initiateCallback({ from, to });
  }

  /**
   * 2026-06-09: альтернативный путь через готовый integration-webhook URL
   * от Mango. Не требует HMAC-подписи — просто GET на готовый URL шаблона
   * с подстановкой EmployeeNUM (внутренний номер оператора) и TelNumbr
   * (телефон того кого набираем).
   *
   * Mango сам обеспечивает обратный webhook со статусом звонка на наш
   * /api/webhooks/mango/call-result (настраивается в ЛК Mango).
   *
   * Лимит: 20 звонков в минуту (проверяется in-memory).
   */
  async initiateCallbackViaWebhook(req: { employeeNum: string; phone: string }): Promise<{ callId: string }> {
    if (!mangoConfig.callbackUrl) {
      throw new Error('Mango: MANGO_CALLBACK_URL не настроен (см. /admin/integrations)');
    }
    if (!req.employeeNum) {
      throw new Error('Mango: не указан EmployeeNUM (внутренний номер оператора)');
    }
    const phone = this.digits(req.phone);
    if (phone.length < 10) {
      throw new Error(`Mango: некорректный номер для набора (${req.phone})`);
    }

    // Rate-limit: чистим записи старше 60 сек.
    const now = Date.now();
    while (callTimestamps.length > 0 && now - callTimestamps[0] > 60_000) {
      callTimestamps.shift();
    }
    if (callTimestamps.length >= MANGO_RATE_LIMIT_PER_MIN) {
      throw new Error(`Mango: превышен лимит ${MANGO_RATE_LIMIT_PER_MIN} звонков в минуту`);
    }

    // Подставляем плейсхолдеры. Шаблон от Mango:
    //   EmployeeNUM={{Ответственный}}&TelNumbr={{Телефон}}
    const url = mangoConfig.callbackUrl
      .replace(/\{\{Ответственный\}\}/g, encodeURIComponent(req.employeeNum))
      .replace(/\{\{Телефон\}\}/g, encodeURIComponent(phone));

    const commandId = crypto.randomUUID();
    callTimestamps.push(now);

    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mango webhook ${res.status}: ${text.slice(0, 300)}`);
    }
    return { callId: commandId };
  }

  async getCallRecording(callId: string): Promise<string> {
    // VPBX API не отдаёт прямую ссылку — запись приходит в webhook
    // call-result (recording_url). Тут — для обратной совместимости.
    return `${this.apiUrl}/queries/recording/${callId}`;
  }

  async getCallStatus(callId: string): Promise<CallStatus> {
    // Тоже асинхронно через webhook — это заглушка для интерфейса.
    return {
      id: callId,
      status: 'unknown',
    };
  }
}
