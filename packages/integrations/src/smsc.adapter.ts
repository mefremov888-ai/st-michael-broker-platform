/**
 * 2026-09-24: СМС Центр (smsc.ru) — только доставка текста на номер.
 *
 * Разделение ответственности (договорённость с владельцем и Андреем):
 * кабинет сам рождает и проверяет коды, ведёт лимиты и журнал; СМС Центр —
 * аккаунт, баланс, имя отправителя, доставка и отчёт о ней. Встроенную
 * услугу «код с проверкой» не используем.
 *
 * HTTP API: https://smsc.ru/api/http/ — send.php / status.php / balance.php,
 * ответ в JSON (fmt=3). В `psw` принимается пароль или API-ключ.
 */

export interface SmscConfig {
  login: string;
  /** Пароль аккаунта или API-ключ (HTTP/S). */
  apiKey: string;
  /** Имя отправителя, зарегистрированное у операторов; пусто — по умолчанию аккаунта. */
  sender?: string;
  /** Базовый адрес API; по умолчанию https://smsc.ru/sys. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface SmscSendResult {
  ok: boolean;
  /** id сообщения у СМС Центра (нужен для status.php). */
  id?: string;
  /** Число частей СМС. */
  parts?: number;
  /** Стоимость отправки в валюте аккаунта. */
  cost?: number;
  /** Баланс после отправки (cost=3). */
  balance?: number;
  errorCode?: number;
  error?: string;
}

export interface SmscStatusResult {
  ok: boolean;
  /** Код статуса по документации smsc.ru (1 — доставлено, 20+ — не доставлено). */
  status?: number;
  statusText?: string;
  changedAt?: Date | null;
  errorCode?: number;
  error?: string;
}

const DEFAULT_BASE_URL = "https://smsc.ru/sys";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Коды ошибок send.php (документация smsc.ru). */
export const SMSC_ERROR_TEXT: Record<number, string> = {
  1: "ошибка в параметрах",
  2: "неверный логин или пароль",
  3: "недостаточно средств на счёте",
  4: "IP-адрес временно заблокирован",
  5: "неверный формат даты",
  6: "сообщение запрещено (по тексту или по имени отправителя)",
  7: "неверный формат номера телефона",
  8: "сообщение на указанный номер не может быть доставлено",
  9: "слишком много запросов",
};

/** Статусы доставки status.php. */
export const SMSC_STATUS_TEXT: Record<number, string> = {
  [-3]: "сообщение не найдено",
  [-2]: "остановлено",
  [-1]: "ожидает отправки",
  0: "передано оператору",
  1: "доставлено",
  2: "прочитано",
  3: "просрочено",
  4: "нажата ссылка",
  20: "невозможно доставить",
  22: "неверный номер",
  23: "запрещено",
  24: "недостаточно средств",
  25: "недоступный номер",
};

/** Статусы, после которых сообщение больше не изменится. */
export function isSmscFinalStatus(status: number): boolean {
  return status === 1 || status === 2 || status === 3 || status === 4 || status >= 20 || status === -2 || status === -3;
}

/** Считаем доставленным: 1 (доставлено), 2 (прочитано), 4 (нажата ссылка). */
export function isSmscDelivered(status: number): boolean {
  return status === 1 || status === 2 || status === 4;
}

/** «+7 (926) 070-11-01» → «79260701101»; null, если это не российский мобильный. */
export function normalizeSmscPhone(phone: string): string | null {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("9")) return `7${digits}`;
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8")) && digits[1] === "9") {
    return `7${digits.slice(1)}`;
  }
  return null;
}

/** Разбор JSON-ответа send.php (fmt=3). */
export function parseSmscSendResponse(json: unknown): SmscSendResult {
  const data = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  if (data.error !== undefined || data.error_code !== undefined) {
    const code = Number(data.error_code);
    return {
      ok: false,
      errorCode: Number.isFinite(code) ? code : undefined,
      error: String(data.error || SMSC_ERROR_TEXT[code] || "ошибка СМС Центра"),
    };
  }
  const id = data.id !== undefined && data.id !== null ? String(data.id) : undefined;
  if (!id) return { ok: false, error: "СМС Центр не вернул id сообщения" };
  const cost = data.cost !== undefined ? Number(data.cost) : undefined;
  const balance = data.balance !== undefined ? Number(data.balance) : undefined;
  const parts = data.cnt !== undefined ? Number(data.cnt) : undefined;
  return {
    ok: true,
    id,
    parts: Number.isFinite(parts as number) ? parts : undefined,
    cost: Number.isFinite(cost as number) ? cost : undefined,
    balance: Number.isFinite(balance as number) ? balance : undefined,
  };
}

/** Разбор JSON-ответа status.php (fmt=3). */
export function parseSmscStatusResponse(json: unknown): SmscStatusResult {
  const data = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  if (data.error !== undefined || data.error_code !== undefined) {
    const code = Number(data.error_code);
    return {
      ok: false,
      errorCode: Number.isFinite(code) ? code : undefined,
      error: String(data.error || SMSC_ERROR_TEXT[code] || "ошибка СМС Центра"),
    };
  }
  const status = Number(data.status);
  if (!Number.isFinite(status)) return { ok: false, error: "СМС Центр не вернул статус" };
  // last_date: «24.09.2026 14:05:31» (московское время).
  let changedAt: Date | null = null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(data.last_date || ""));
  if (m) changedAt = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+03:00`);
  return { ok: true, status, statusText: SMSC_STATUS_TEXT[status] || `статус ${status}`, changedAt };
}

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export class SmscAdapter {
  private readonly cfg: Required<Pick<SmscConfig, "login" | "apiKey" | "baseUrl" | "timeoutMs">> & { sender: string };
  private readonly fetchImpl: FetchLike;

  constructor(cfg: SmscConfig, fetchImpl?: FetchLike) {
    this.cfg = {
      login: cfg.login,
      apiKey: cfg.apiKey,
      sender: (cfg.sender || "").trim(),
      baseUrl: (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
      timeoutMs: cfg.timeoutMs || DEFAULT_TIMEOUT_MS,
    };
    this.fetchImpl = fetchImpl || ((globalThis as any).fetch as FetchLike);
  }

  get isConfigured(): boolean {
    return Boolean(this.cfg.login && this.cfg.apiKey);
  }

  /** Одно сообщение на один номер. Текст — как есть (кабинет уже уложил в 70 знаков). */
  async send(phone: string, text: string): Promise<SmscSendResult> {
    if (!this.isConfigured) return { ok: false, error: "СМС Центр не настроен (логин/ключ)" };
    const normalized = normalizeSmscPhone(phone);
    if (!normalized) return { ok: false, errorCode: 7, error: SMSC_ERROR_TEXT[7] };
    const body: Record<string, string> = {
      login: this.cfg.login,
      psw: this.cfg.apiKey,
      phones: normalized,
      mes: text,
      charset: "utf-8",
      fmt: "3",
      // 3 — отправить и вернуть стоимость и баланс.
      cost: "3",
    };
    if (this.cfg.sender) body.sender = this.cfg.sender;
    const json = await this.post("/send.php", body);
    return parseSmscSendResponse(json);
  }

  async getStatus(id: string, phone: string): Promise<SmscStatusResult> {
    if (!this.isConfigured) return { ok: false, error: "СМС Центр не настроен (логин/ключ)" };
    const normalized = normalizeSmscPhone(phone);
    if (!normalized) return { ok: false, errorCode: 7, error: SMSC_ERROR_TEXT[7] };
    const json = await this.post("/status.php", {
      login: this.cfg.login,
      psw: this.cfg.apiKey,
      phone: normalized,
      id: String(id),
      fmt: "3",
    });
    return parseSmscStatusResponse(json);
  }

  async getBalance(): Promise<{ ok: boolean; balance?: number; currency?: string; error?: string }> {
    if (!this.isConfigured) return { ok: false, error: "СМС Центр не настроен (логин/ключ)" };
    const json = (await this.post("/balance.php", {
      login: this.cfg.login,
      psw: this.cfg.apiKey,
      cur: "1",
      fmt: "3",
    })) as Record<string, unknown>;
    if (json && (json.error !== undefined || json.error_code !== undefined)) {
      const code = Number(json.error_code);
      return { ok: false, error: String(json.error || SMSC_ERROR_TEXT[code] || "ошибка СМС Центра") };
    }
    const balance = Number(json?.balance);
    if (!Number.isFinite(balance)) return { ok: false, error: "СМС Центр не вернул баланс" };
    return { ok: true, balance, currency: json?.currency ? String(json.currency) : undefined };
  }

  private async post(path: string, params: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: new URLSearchParams(params).toString(),
        signal: controller.signal,
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { error: `неожиданный ответ СМС Центра (HTTP ${res.status}): ${text.slice(0, 120)}` };
      }
    } catch (e: any) {
      return { error: `сеть до СМС Центра: ${e?.name === "AbortError" ? "таймаут" : e?.message || e}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
