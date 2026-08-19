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
export interface MangoConfig {
  apiKey: string;
  apiSalt: string;
  apiUrl: string;
  callbackUrl: string;
  outboundLine: string;
}

const DEFAULT_MANGO_URL = 'https://app.mango-office.ru/vpbx';
const MANGO_API_HOST = 'app.mango-office.ru';
const MANGO_API_PATH = '/vpbx';
const MANGO_CALLBACK_HOST = 'integration-webhook.mango-office.ru';
const MANGO_CALLBACK_PATH = '/webhookapp/common';
const MANGO_EMPLOYEE_PLACEHOLDER = '{{Ответственный}}';
const MANGO_PHONE_PLACEHOLDER = '{{Телефон}}';

function parseHttpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label}: указан некорректный URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.hash
  ) {
    throw new Error(`${label}: разрешён только HTTPS URL без credentials, порта и fragment`);
  }
  return parsed;
}

/**
 * Mango publishes one fixed VPBX base URL. Keeping this allowlist exact is
 * important because the value is editable through the admin settings page.
 */
export function normalizeMangoApiUrl(value: string): string {
  const candidate = String(value || '').trim() || DEFAULT_MANGO_URL;
  const parsed = parseHttpsUrl(candidate, 'MANGO_API_URL');
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (
    parsed.hostname.toLowerCase() !== MANGO_API_HOST
    || path !== MANGO_API_PATH
    || parsed.search
  ) {
    throw new Error(
      `MANGO_API_URL: разрешён только https://${MANGO_API_HOST}${MANGO_API_PATH}`,
    );
  }
  return DEFAULT_MANGO_URL;
}

/**
 * Validate the official integration-webhook template without ever exposing
 * its credential-like query values in an exception or log message.
 */
export function normalizeMangoCallbackUrl(value: string): string {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  const parsed = parseHttpsUrl(candidate, 'MANGO_CALLBACK_URL');
  if (
    parsed.hostname.toLowerCase() !== MANGO_CALLBACK_HOST
    || parsed.pathname !== MANGO_CALLBACK_PATH
  ) {
    throw new Error(
      `MANGO_CALLBACK_URL: разрешён только https://${MANGO_CALLBACK_HOST}${MANGO_CALLBACK_PATH}`,
    );
  }

  const employeeValues = parsed.searchParams.getAll('EmployeeNUM');
  const phoneValues = parsed.searchParams.getAll('TelNumbr');
  if (
    employeeValues.length !== 1
    || employeeValues[0] !== MANGO_EMPLOYEE_PLACEHOLDER
    || phoneValues.length !== 1
    || phoneValues[0] !== MANGO_PHONE_PLACEHOLDER
  ) {
    throw new Error(
      'MANGO_CALLBACK_URL: требуются безопасные query-плейсхолдеры EmployeeNUM и TelNumbr',
    );
  }
  for (const [key, queryValue] of parsed.searchParams.entries()) {
    if (
      (queryValue.includes('{{') || queryValue.includes('}}'))
      && !(
        (key === 'EmployeeNUM' && queryValue === MANGO_EMPLOYEE_PLACEHOLDER)
        || (key === 'TelNumbr' && queryValue === MANGO_PHONE_PLACEHOLDER)
      )
    ) {
      throw new Error('MANGO_CALLBACK_URL: неизвестный query-плейсхолдер');
    }
  }
  // Preserve the original placeholders: URL#toString percent-encodes braces,
  // while initiateCallbackViaWebhook replaces the literal template tokens.
  return candidate;
}

function safeInitialApiUrl(value: string | undefined): string {
  try {
    return normalizeMangoApiUrl(value || DEFAULT_MANGO_URL);
  } catch {
    return '';
  }
}

function safeInitialCallbackUrl(value: string | undefined): string {
  try {
    return normalizeMangoCallbackUrl(value || '');
  } catch {
    return '';
  }
}

let mangoConfig: MangoConfig = {
  apiKey: process.env.MANGO_API_KEY || '',
  apiSalt: process.env.MANGO_API_SALT || '',
  apiUrl: safeInitialApiUrl(process.env.MANGO_API_URL),
  callbackUrl: safeInitialCallbackUrl(process.env.MANGO_CALLBACK_URL),
  outboundLine: process.env.MANGO_OUTBOUND_LINE || '',
};

export function setMangoConfig(cfg: Partial<MangoConfig>): void {
  // Validate every changed URL before mutating shared state, so a rejected
  // hot update cannot leave the adapter partially reconfigured.
  const apiUrl = cfg.apiUrl === undefined
    ? mangoConfig.apiUrl
    : normalizeMangoApiUrl(cfg.apiUrl);
  const callbackUrl = cfg.callbackUrl === undefined
    ? mangoConfig.callbackUrl
    : normalizeMangoCallbackUrl(cfg.callbackUrl);
  mangoConfig = {
    apiKey: cfg.apiKey ?? mangoConfig.apiKey,
    apiSalt: cfg.apiSalt ?? mangoConfig.apiSalt,
    apiUrl,
    callbackUrl,
    outboundLine: cfg.outboundLine ?? mangoConfig.outboundLine,
  };
}

export function getMangoConfig(): MangoConfig {
  return { ...mangoConfig };
}

// 2026-06-09: in-memory rate-limit для click-to-call (Mango лимит 20/мин).
// timestamps в мс, чистим до 60 секунд назад при каждом запросе.
const callTimestamps: number[] = [];
const MANGO_RATE_LIMIT_PER_MIN = 20;
const MANGO_REQUEST_TIMEOUT_MS = 10_000;

async function mangoFetch(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANGO_REQUEST_TIMEOUT_MS);
  try {
    // A redirect could leave an otherwise valid allowlisted host. Mango's
    // documented endpoints are final, so fail closed instead of following it.
    return await fetch(input, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      // Do not include the requested URL: the legacy callback URL may contain
      // credential-like query parameters.
      throw new Error(`Mango request timed out after ${MANGO_REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mango VPBX integration — outbound callback.
 *
 * Doc: https://www.mango-office.ru/upload/api/vpbx_api.pdf
 * Endpoint: POST {apiUrl}/commands/callback
 * Signature: SHA-256 от (vpbx_api_key + exact json string + vpbx_api_salt).
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

  private get outboundLine(): string {
    return mangoConfig.outboundLine;
  }

  private digits(phone: string): string {
    return String(phone || '').replace(/\D/g, '');
  }

  private outboundLineDigits(value?: string): string {
    const digits = this.digits(value ?? this.outboundLine);
    if (digits && (digits.length < 10 || digits.length > 15)) {
      throw new Error('Mango callback: исходящая линия должна содержать от 10 до 15 цифр');
    }
    return digits;
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
    const lineNumber = this.outboundLineDigits(req.lineNumber);
    if (fromDigits.length < 10 || toDigits.length < 10) {
      throw new Error(`Mango callback: некорректные номера (from=${req.from}, to=${req.to})`);
    }

    const json = JSON.stringify({
      command_id: commandId,
      from: { number: fromDigits },
      to_number: toDigits,
      ...(lineNumber ? { line_number: lineNumber } : {}),
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

    const apiUrl = normalizeMangoApiUrl(this.apiUrl);
    const res = await mangoFetch(`${apiUrl}/commands/callback`, {
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
   * SHA-256-подписью — нужны только api_key + api_salt (MANGO_CALLBACK_URL НЕ
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
    if (!/^\d{1,20}$/.test(extension)) {
      throw new Error('Mango callback: внутренний номер сотрудника должен содержать от 1 до 20 цифр');
    }
    const toDigits = this.digits(req.to);
    const lineNumber = this.outboundLineDigits(req.lineNumber);
    if (toDigits.length < 10) {
      throw new Error(`Mango callback: некорректный номер брокера (${req.to})`);
    }

    const commandId = crypto.randomUUID();
    const json = JSON.stringify({
      command_id: commandId,
      from: { extension },
      to_number: toDigits,
      ...(lineNumber ? { line_number: lineNumber } : {}),
    });
    const sign = crypto
      .createHash('sha256')
      .update(this.apiKey + json + this.apiSalt)
      .digest('hex');

    const params = new URLSearchParams({ vpbx_api_key: this.apiKey, sign, json });
    const apiUrl = normalizeMangoApiUrl(this.apiUrl);
    const res = await mangoFetch(`${apiUrl}/commands/callback`, {
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
   * от Mango. Не требует VPBX-подписи — просто GET на готовый URL шаблона
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
    const employeeNum = String(req.employeeNum || '').trim();
    if (!/^\d{1,20}$/.test(employeeNum)) {
      throw new Error('Mango: EmployeeNUM должен содержать от 1 до 20 цифр');
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

    // Parse and set query values instead of string replacement. This handles
    // both literal and percent-encoded official placeholders and cannot move
    // user-controlled digits into the host/path portion of the URL.
    const callbackUrl = new URL(normalizeMangoCallbackUrl(mangoConfig.callbackUrl));
    callbackUrl.searchParams.set('EmployeeNUM', employeeNum);
    callbackUrl.searchParams.set('TelNumbr', phone);
    const url = callbackUrl.toString();

    const commandId = crypto.randomUUID();
    callTimestamps.push(now);

    const res = await mangoFetch(url, { method: 'GET' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mango webhook ${res.status}: ${text.slice(0, 300)}`);
    }
    return { callId: commandId };
  }

  async getCallRecording(callId: string): Promise<string> {
    // VPBX API не отдаёт прямую ссылку — запись приходит в webhook
    // call-result (recording_url). Тут — для обратной совместимости.
    return `${normalizeMangoApiUrl(this.apiUrl)}/queries/recording/${callId}`;
  }

  async getCallStatus(callId: string): Promise<CallStatus> {
    // Тоже асинхронно через webhook — это заглушка для интерфейса.
    return {
      id: callId,
      status: 'unknown',
    };
  }
}
