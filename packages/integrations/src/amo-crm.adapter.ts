import { Project } from "@st-michael/shared";
import {
  backgroundThrottle,
  isInteractiveAmoContext,
  noteInteractiveAmoActivity,
  runInteractive,
} from "./amo-traffic-light";
import {
  AMO_LEAD_FIELDS,
  AMO_LEAD_ENUMS,
  AMO_CONTACT_FIELDS,
  AMO_PIPELINES,
  readinessLevelToEnumId,
  purchaseTimingToEnumId,
  evaluateUniqueness,
  isClassifiedUniquenessLeadStage,
  isKnownUniquenessLeadStage,
  brokerLeadMarkerFields,
  AMO_BROKER_STAGE,
  agencyToAmoCompanyFields,
} from "./amo-crm.fields";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 2026-08-19: без таймаута зависший amoCRM держит fetch() открытым
// бесконечно — вместе с overlap-guard'ом в handleAmoFailedRetry это
// раньше позволяло двум прогонам крона параллельно слать один и тот же
// лид (см. code-review PR #288).
const AMO_REQUEST_TIMEOUT_MS = 15_000;
// POST /leads is one-shot (retryTransient:false). 15s was aborting while amo
// still created the lead — cabinet then stored "response not received" and
// locked auto-retry to avoid duplicates.
export const AMO_LEAD_CREATE_TIMEOUT_MS = 45_000;
export const AMO_FIXATION_RECOVER_CLOCK_SKEW_SECONDS = 120;
export const AMO_FIXATION_RECOVER_STRONG_WINDOW_SECONDS = 15 * 60;
export const AMO_FIXATION_CREATE_UNCONFIRMED_NO_LEAD =
  "AMO_FIXATION_CREATE_UNCONFIRMED_NO_LEAD";
const AMO_FIXATION_RECOVER_LOOKUP_ATTEMPTS = 3;
const AMO_FIXATION_RECOVER_RETRY_DELAY_MS = process.env.JEST_WORKER_ID
  ? 0
  : 1_500;

export type RecoverFixationLeadResult =
  | { kind: "found"; leadId: number }
  | { kind: "empty" }
  | { kind: "ambiguous"; reason: string };

export function amoFixationRecoverWindowFromCreatedAt(createdAt: Date): {
  createdAfterUnix: number;
  createdBeforeUnix: number;
} {
  const createdMs =
    createdAt instanceof Date ? createdAt.getTime() : Number.NaN;
  if (!Number.isFinite(createdMs)) {
    const now = Math.floor(Date.now() / 1000);
    return {
      createdAfterUnix: now - AMO_FIXATION_RECOVER_CLOCK_SKEW_SECONDS,
      createdBeforeUnix: now + AMO_FIXATION_RECOVER_STRONG_WINDOW_SECONDS,
    };
  }
  const unix = Math.floor(createdMs / 1000);
  return {
    createdAfterUnix: unix - AMO_FIXATION_RECOVER_CLOCK_SKEW_SECONDS,
    createdBeforeUnix: unix + AMO_FIXATION_RECOVER_STRONG_WINDOW_SECONDS,
  };
}

function isAmbiguousLeadCreateTransportError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message || error || "");
  if (!msg) return true;
  const normalized = msg.toLowerCase();
  if (normalized.includes("amo_access_token")) return false;
  if (normalized.includes("broker_amo_contact")) return false;
  if (/\b401\b/.test(normalized) || /\b403\b/.test(normalized)) return false;
  if (/\b429\b/.test(normalized) || /\b400\b/.test(normalized)) return false;
  if (normalized.includes("network error")) return true;
  if (/\b5\d\d\b/.test(normalized)) return true;
  if (normalized.includes("did not return a lead id")) return true;
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return true;
  }
  if (normalized.includes("abort")) return true;
  return false;
}

function leadHasBrokerContact(
  lead: { _embedded?: { contacts?: Array<{ id?: unknown }> } },
  brokerAmoContactId: number,
): boolean {
  const contacts = Array.isArray(lead?._embedded?.contacts)
    ? lead._embedded.contacts
    : [];
  return contacts.some(
    (contact) => Number(contact?.id) === brokerAmoContactId,
  );
}

function isKcPipelineLeadInWindow(
  lead: { pipeline_id?: unknown; created_at?: unknown },
  createdAfterUnix: number,
  createdBeforeUnix: number,
): boolean {
  const pipelineId = Number(lead?.pipeline_id);
  const createdAt = Number(lead?.created_at);
  return (
    pipelineId === AMO_PIPELINES.KC &&
    Number.isSafeInteger(createdAt) &&
    createdAt >= createdAfterUnix &&
    createdAt <= createdBeforeUnix
  );
}
const AMO_READONLY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const AMO_EXACT_CONTACT_PAGE_LIMIT = 250;
const AMO_EXACT_CONTACT_MAX_PAGES = 20;

// Fictional redacted example: "+70000000000" / "8 (000) 000-00-00" /
// "+7-000-000-00-00" → "0000000000". amoCRM ?query=<substring> капризно
// реагирует на формат: E.164 может не найти тот же placeholder, сохранённый с
// локальным префиксом, поэтому ищем по
// 10 цифрам и постфильтруем по custom_fields_values.PHONE.
const last10Digits = (phone: any): string =>
  String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);

export interface AmoContact {
  id: number;
  name: string;
  first_name?: string;
  last_name?: string;
  custom_fields_values?: any[];
  created_at?: number;
  updated_at?: number;
  _embedded?: any;
}

export interface AmoCompany {
  id: number;
  name: string;
  custom_fields_values?: any[];
  created_at?: number;
  updated_at?: number;
}

export interface AmoLead {
  id: number;
  name: string;
  price?: number;
  status_id?: number;
  pipeline_id?: number;
  created_at?: number;
  updated_at?: number;
  responsible_user_id?: number;
  custom_fields_values?: any[];
  contacts?: { id: number }[];
  companies?: { id: number }[];
  _embedded?: any;
}

export interface CreateContactDto {
  name: string;
  first_name?: string;
  last_name?: string;
  custom_fields_values?: any[];
}

export interface CreateCompanyDto {
  name: string;
  custom_fields_values?: any[];
}

export interface CreateLeadDto {
  name: string;
  price?: number;
  status_id?: number;
  pipeline_id?: number;
  responsible_user_id?: number;
  contacts?: { id: number }[];
  companies?: { id: number }[];
  custom_fields_values?: any[];
}

export interface FixationClientContactInput {
  clientPhone: string;
  clientEmail?: string;
  clientName: string;
  clientRegion?: string;
  presentationSent?: boolean;
}

function fixationClientCustomFields(data: FixationClientContactInput): any[] {
  const fields: any[] = [
    {
      field_code: "PHONE",
      values: [{ value: data.clientPhone, enum_code: "WORK" }],
    },
  ];
  if (data.clientEmail) {
    fields.push({
      field_code: "EMAIL",
      values: [{ value: data.clientEmail, enum_code: "WORK" }],
    });
  }
  if (data.clientRegion) {
    fields.push({
      field_id: 589265,
      values: [{ value: data.clientRegion }],
    });
  }
  if (data.presentationSent) {
    fields.push({ field_id: 835955, values: [{ value: true }] });
  }
  return fields;
}

export interface UpdateLeadDto {
  name?: string;
  price?: number;
  status_id?: number;
  responsible_user_id?: number;
  custom_fields_values?: any[];
}

export type AmoReadonlyResource = "contacts" | "companies" | "leads";

export interface AmoReadonlyScanOptions {
  limit?: number;
  maxPages?: number;
  with?: string;
  pipelineIds?: number[];
  updatedFrom?: number;
}

export interface AmoReadonlyScanResult<T = any> {
  items: T[];
  pagesRead: number;
  complete: true;
  readAt: string;
}

export interface AmoReadonlyPage<T = any> {
  items: T[];
  page: number;
  limit: number;
}

export type AmoReadonlyPageConsumer<T = any> = (
  page: AmoReadonlyPage<T>,
) => Promise<void> | void;

export interface AmoReadonlyPageScanResult {
  itemsRead: number;
  pagesRead: number;
  complete: true;
  readAt: string;
}

// 2026-06-05: модульный shared-state для access/refresh токенов amoCRM.
// Все экземпляры AmoCrmAdapter читают из этого state-а, refresh обновляет
// его + дёргает hook (для персистенса в БД). На старте API bootstrap
// загружает токены из SystemSetting → setAmoTokens(), и регистрирует
// hook → setAmoTokenRefreshHook(). Если в БД пусто — fallback на env.
type AmoTokens = { access: string; refresh: string };
type AmoTokenRefreshHook = (tokens: AmoTokens) => Promise<void> | void;
type AmoRequestOptions = {
  retryTransient?: boolean;
  maxResponseBytes?: number;
  timeoutMs?: number;
};

let amoTokens: AmoTokens = {
  access: process.env.AMO_ACCESS_TOKEN || "",
  refresh: process.env.AMO_REFRESH_TOKEN || "",
};
let amoTokenRefreshHook: AmoTokenRefreshHook | null = null;
let amoRefreshInFlight: Promise<boolean> | null = null; // дедуп параллельных refresh

function safeAmoRequestPath(path: string): string {
  try {
    const parsed = new URL(path, "https://amo.invalid");
    return parsed.pathname || "/";
  } catch {
    return String(path || "/").split("?")[0] || "/";
  }
}

async function cancelAmoResponse(
  response: Response,
  controller: AbortController,
): Promise<void> {
  controller.abort();
  try {
    await response.body?.cancel();
  } catch {
    // The abort may have already errored or locked the stream.
  }
}

async function readAmoJsonBounded<T>(
  response: Response,
  maxResponseBytes: number,
  controller: AbortController,
): Promise<T> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      await cancelAmoResponse(response, controller);
      throw new Error("AMO_READONLY_RESPONSE_INVALID");
    }
    if (contentLength > maxResponseBytes) {
      await cancelAmoResponse(response, controller);
      throw new Error("AMO_READONLY_RESPONSE_TOO_LARGE");
    }
  }

  // Native fetch always exposes a ReadableStream for a non-204 response. Keep
  // compatibility with existing lightweight test doubles, while production
  // responses must pass through the pre-parse stream limit below.
  if (response.body === undefined && typeof response.json === "function") {
    const value = (await response.json()) as T;
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxResponseBytes) {
      controller.abort();
      throw new Error("AMO_READONLY_RESPONSE_TOO_LARGE");
    }
    return value;
  }
  if (!response.body) {
    controller.abort();
    throw new Error("AMO_READONLY_RESPONSE_INVALID");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // Abort may have already errored the reader.
        }
        throw new Error("AMO_READONLY_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as T;
  } catch {
    throw new Error("AMO_READONLY_RESPONSE_INVALID");
  }
}

export function setAmoTokens(access: string, refresh: string): void {
  amoTokens = { access: access || "", refresh: refresh || "" };
}

export function getAmoTokens(): AmoTokens {
  return { ...amoTokens };
}

export function setAmoTokenRefreshHook(hook: AmoTokenRefreshHook | null): void {
  amoTokenRefreshHook = hook;
}

export class AmoCrmAdapter {
  // 2026-05-27: api-b.amocrm.ru (JWT payload.api_domain) отдаёт 401 даже на
  // валидный токен — используем AMO_API_DOMAIN/дефолт stmichael.amocrm.ru.
  // Не читать домен из JWT (см. 7750ec2), даже если он там есть.
  private get baseUrl(): string {
    const subdomain = process.env.AMO_SUBDOMAIN || "stmichael";
    const domain = process.env.AMO_BASE_DOMAIN || "amocrm.ru";
    return `https://${process.env.AMO_API_DOMAIN || `${subdomain}.${domain}`}/api/v4`;
  }

  constructor() {}

  /**
   * 2026-09-05: пометить живую операцию брокера интерактивной — все
   * запросы к amo внутри fn идут без ожиданий, а фоновый трафик в это
   * время (и AMO_BG_HOLD_AFTER_INTERACTIVE_MS после) стоит.
   * Делегат runInteractive из amo-traffic-light (процесс-глобально).
   */
  asInteractive<T>(fn: () => Promise<T>): Promise<T> {
    return runInteractive(fn);
  }

  private get token(): string {
    return amoTokens.access;
  }

  /**
   * 2026-06-05: OAuth2 refresh. Возвращает true если новый access_token получен
   * и сохранён в shared-state (+ через hook в БД). Дедупит параллельные вызовы.
   */
  private async refreshAccessToken(): Promise<boolean> {
    if (amoRefreshInFlight) return amoRefreshInFlight;
    amoRefreshInFlight = (async (): Promise<boolean> => {
      const refresh = amoTokens.refresh;
      if (!refresh) {
        console.error(
          "[amo-refresh] AMO_REFRESH_TOKEN не задан — refresh невозможен",
        );
        return false;
      }
      const clientId = process.env.AMO_CLIENT_ID;
      const clientSecret = process.env.AMO_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        console.error(
          "[amo-refresh] AMO_CLIENT_ID / AMO_CLIENT_SECRET не заданы",
        );
        return false;
      }
      const redirectUri =
        process.env.AMO_REDIRECT_URI || "https://broker.stmichael.ru/";
      const subdomain = process.env.AMO_SUBDOMAIN || "stmichael";
      const url = `https://${subdomain}.amocrm.ru/oauth2/access_token`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "refresh_token",
            refresh_token: refresh,
            redirect_uri: redirectUri,
          }),
        });
        if (!res.ok) {
          // OAuth/WAF bodies can contain implementation details. Status is
          // enough for diagnostics and keeps secrets out of server logs.
          console.error(`[amo-refresh] failed: HTTP ${res.status}`);
          return false;
        }
        const data: any = await res.json();
        const newAccess = String(data?.access_token || "");
        const newRefresh = String(data?.refresh_token || "") || refresh;
        if (!newAccess) {
          console.error("[amo-refresh] response missing access_token");
          return false;
        }
        amoTokens = { access: newAccess, refresh: newRefresh };
        if (amoTokenRefreshHook) {
          try {
            await amoTokenRefreshHook(amoTokens);
          } catch (e: any) {
            console.error(
              "[amo-refresh] persist hook failed:",
              e?.message || e,
            );
          }
        }
        console.log("[amo-refresh] OK, access_token обновлён");
        return true;
      } catch {
        console.error("[amo-refresh] network exception");
        return false;
      }
    })();
    try {
      return await amoRefreshInFlight;
    } finally {
      amoRefreshInFlight = null;
    }
  }

  // КБ6 fix #44 (2026-05-25): retry с экспоненциальным backoff для 429/5xx.
  // amoCRM v4 ограничивает 7 req/sec — без retry массовый импорт ловит сотни
  // 429 (наблюдали 776 amoErrors на coverage-анализ).
  // 2026-06-05: на 401 пробуем refresh access_token через AMO_REFRESH_TOKEN
  // и retry один раз. При пустом access — тоже пробуем refresh.
  private async request<T = any>(
    path: string,
    init: RequestInit = {},
    options: AmoRequestOptions = {},
    attempt = 1,
    didRefresh = false,
  ): Promise<T> {
    if (
      options.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(options.maxResponseBytes) ||
        options.maxResponseBytes <= 0)
    ) {
      throw new Error("AMO_READONLY_RESPONSE_LIMIT_INVALID");
    }
    // 2026-09-05: «светофор» — живым запросам приоритет. Контекст по
    // умолчанию «background»: перед каждым запросом (и каждым retry)
    // фон ждёт backgroundThrottle(). Интерактивные (см. asInteractive /
    // runInteractive) идут сразу и продлевают «зелёный» интерактиву.
    if (isInteractiveAmoContext()) {
      noteInteractiveAmoActivity();
    } else {
      await backgroundThrottle();
    }
    if (!this.token) {
      if (
        options.retryTransient !== false &&
        !didRefresh &&
        amoTokens.refresh
      ) {
        const ok = await this.refreshAccessToken();
        if (ok) return this.request<T>(path, init, options, attempt, true);
      }
      throw new Error("AMO_ACCESS_TOKEN not configured");
    }

    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const safePath = safeAmoRequestPath(path);
    let res: Response;
    const controller = new AbortController();
    const timeoutMs =
      Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs as number) > 0
        ? (options.timeoutMs as number)
        : AMO_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          // 2026-05-27: «человеческий» User-Agent + Accept — без них
          // WAF возвращает 403. С браузерным UA проходит.
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });
    } catch {
      clearTimeout(timer);
      // Network-level (timeout, ECONNRESET) — ретраим до 3 раз.
      if (options.retryTransient !== false && attempt < 3) {
        await sleep(500 * attempt);
        return this.request<T>(path, init, options, attempt + 1, didRefresh);
      }
      throw new Error(`amoCRM network error ${safePath}`);
    }

    if (res.status === 204) {
      clearTimeout(timer);
      return null as T;
    }

    // 2026-06-05: 401 → попытка refresh + одиночный retry. Если refresh уже
    // делали в этом цепочке — не повторяем, бросаем.
    if (options.retryTransient !== false && res.status === 401 && !didRefresh) {
      clearTimeout(timer);
      console.warn(`[amo] 401 на ${safePath}, пробуем refresh access_token`);
      const ok = await this.refreshAccessToken();
      if (ok) return this.request<T>(path, init, options, attempt, true);
    }

    // 429 (rate-limit) и 5xx — retry. Уважаем Retry-After если пришёл.
    if (
      options.retryTransient !== false &&
      (res.status === 429 || res.status >= 500) &&
      attempt < 4
    ) {
      clearTimeout(timer);
      const retryAfter = Number(res.headers.get("Retry-After")) || 0;
      const wait =
        retryAfter > 0 ? retryAfter * 1000 : 300 * Math.pow(2, attempt); // 300 / 600 / 1200ms
      await sleep(wait);
      return this.request<T>(path, init, options, attempt + 1, didRefresh);
    }

    if (!res.ok) {
      clearTimeout(timer);
      // Never surface the raw response body or query string: amo WAF replies
      // with HTML and contact searches include a phone number in the query.
      throw new Error(`amoCRM ${res.status} ${safePath}`);
    }
    if (options.maxResponseBytes !== undefined) {
      try {
        const value = await readAmoJsonBounded<T>(
          res,
          options.maxResponseBytes,
          controller,
        );
        clearTimeout(timer);
        return value;
      } catch (error) {
        clearTimeout(timer);
        const message = error instanceof Error ? error.message : "";
        if (message.startsWith("AMO_READONLY_")) throw error;
        if (options.retryTransient !== false && attempt < 3) {
          await sleep(500 * attempt);
          return this.request<T>(path, init, options, attempt + 1, didRefresh);
        }
        throw new Error(`amoCRM network error ${safePath}`);
      }
    }
    // Preserve the historical generic adapter behavior: its body parsing is
    // unchanged and only the readonly page consumer opts into the hard cap.
    clearTimeout(timer);
    return res.json() as Promise<T>;
  }

  // === Account info ===
  async getAccount(): Promise<any> {
    return this.request("/account");
  }

  /**
   * Exhaustive GET-only scanner used by the loyalty audit. It deliberately
   * exposes no arbitrary path or HTTP method and fails closed on any page
   * error or an exhausted safety bound. Callers can therefore distinguish a
   * complete snapshot from a partial amoCRM response.
   */
  async scanReadonly<T = any>(
    resource: AmoReadonlyResource,
    options: AmoReadonlyScanOptions = {},
  ): Promise<AmoReadonlyScanResult<T>> {
    const items: T[] = [];
    const result = await this.consumeReadonlyPages<T>(
      resource,
      ({ items: pageItems }) => {
        items.push(...pageItems);
      },
      options,
    );
    return {
      items,
      pagesRead: result.pagesRead,
      complete: true,
      readAt: result.readAt,
    };
  }

  /**
   * Bounded-memory variant of scanReadonly. The callback receives exactly one
   * validated page at a time. amoCRM is explicitly asked for id ASC ordering,
   * and the adapter fails closed if IDs are missing, duplicated or not globally
   * strictly increasing across page boundaries.
   */
  async consumeReadonlyPages<T = any>(
    resource: AmoReadonlyResource,
    consume: AmoReadonlyPageConsumer<T>,
    options: AmoReadonlyScanOptions = {},
  ): Promise<AmoReadonlyPageScanResult> {
    if (!["contacts", "companies", "leads"].includes(resource)) {
      throw new Error("AMO_READONLY_RESOURCE_INVALID");
    }
    if (typeof consume !== "function") {
      throw new Error("AMO_READONLY_CONSUMER_INVALID");
    }
    const limit = options.limit ?? 250;
    const maxPages = options.maxPages ?? 2_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      throw new Error("AMO_READONLY_LIMIT_INVALID");
    }
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
      throw new Error("AMO_READONLY_MAX_PAGES_INVALID");
    }
    const allowedWith: Record<AmoReadonlyResource, Set<string>> = {
      contacts: new Set([
        "leads",
        "companies",
        "customers",
        "catalog_elements",
      ]),
      companies: new Set([
        "contacts",
        "leads",
        "customers",
        "catalog_elements",
      ]),
      leads: new Set([
        "contacts",
        "companies",
        "source_id",
        "catalog_elements",
      ]),
    };
    const withParts = String(options.with || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (withParts.some((value) => !allowedWith[resource].has(value))) {
      throw new Error("AMO_READONLY_WITH_INVALID");
    }
    const pipelineIds = Array.from(new Set(options.pipelineIds || []));
    if (
      resource !== "leads" &&
      (pipelineIds.length > 0 || options.updatedFrom !== undefined)
    ) {
      throw new Error("AMO_READONLY_FILTER_INVALID");
    }
    if (
      pipelineIds.some(
        (value) => !Number.isSafeInteger(value) || Number(value) <= 0,
      )
    ) {
      throw new Error("AMO_READONLY_PIPELINE_INVALID");
    }
    if (
      options.updatedFrom !== undefined &&
      (!Number.isSafeInteger(options.updatedFrom) || options.updatedFrom < 0)
    ) {
      throw new Error("AMO_READONLY_UPDATED_FROM_INVALID");
    }

    let pagesRead = 0;
    let itemsRead = 0;
    let previousId = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      const params = new URLSearchParams({
        limit: String(limit),
        page: String(page),
      });
      params.set("order[id]", "asc");
      if (withParts.length) params.set("with", withParts.join(","));
      for (const pipelineId of pipelineIds) {
        params.append("filter[pipeline_id][]", String(pipelineId));
      }
      if (options.updatedFrom !== undefined) {
        params.set("filter[updated_at][from]", String(options.updatedFrom));
      }
      const data = await this.request<any>(
        `/${resource}?${params.toString()}`,
        {},
        {
          maxResponseBytes: AMO_READONLY_MAX_RESPONSE_BYTES,
        },
      );
      const pageItems = data?._embedded?.[resource];
      if (!Array.isArray(pageItems)) {
        throw new Error("AMO_READONLY_PAGE_INVALID");
      }
      if (pageItems.length > limit) {
        throw new Error("AMO_READONLY_PAGE_SIZE_INVALID");
      }
      pagesRead = page;
      for (const item of pageItems) {
        const id = Number((item as any)?.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
          throw new Error("AMO_READONLY_INVALID_ID");
        }
        if (id === previousId) {
          throw new Error("AMO_READONLY_DUPLICATE_ID");
        }
        if (id < previousId) {
          throw new Error("AMO_READONLY_ORDER_INVALID");
        }
        previousId = id;
      }
      if (pageItems.length) {
        await consume({ items: pageItems, page, limit });
        itemsRead += pageItems.length;
      }
      if (pageItems.length < limit) {
        return {
          itemsRead,
          pagesRead,
          complete: true,
          readAt: new Date().toISOString(),
        };
      }
    }
    throw new Error("AMO_READONLY_PAGE_BOUND_EXCEEDED");
  }

  // === Contacts ===
  async findContactByPhone(
    phone: string,
    options: { strict?: boolean } = {},
  ): Promise<AmoContact | null> {
    // Bug fix 2026-06-02: раньше брали `contacts[0]` без постфильтрации —
    // amoCRM ?query= ищет по подстроке и возвращает совпадения по имени/email/
    // комменту, а главное — не находит контакт сохранённый в другом формате
    // телефона. Из-за этого createFixationRequest лепил дубль контакта
    // в amoCRM, хотя клиент там уже был (redacted fictional example:
    // +70000000000 был КЦ-контактом, новая фиксация создавала второй).
    const target = last10Digits(phone);
    if (target.length < 10) return null;
    let contacts: any[] = [];
    if (options.strict) {
      const seenIds = new Set<number>();
      for (let page = 1; page <= AMO_EXACT_CONTACT_MAX_PAGES; page += 1) {
        const data = await this.request<any>(
          `/contacts?query=${target}&limit=${AMO_EXACT_CONTACT_PAGE_LIMIT}&page=${page}`,
        );
        if (data === null) break;
        const pageContacts = data?._embedded?.contacts;
        if (!Array.isArray(pageContacts)) {
          throw new Error("AMO_EXACT_CONTACT_PAGE_INVALID");
        }
        for (const contact of pageContacts) {
          const id = Number(contact?.id);
          if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) {
            throw new Error("AMO_EXACT_CONTACT_PAGE_ID_INVALID");
          }
          seenIds.add(id);
          contacts.push(contact);
        }
        if (!data?._links?.next) break;
        if (page === AMO_EXACT_CONTACT_MAX_PAGES) {
          throw new Error("AMO_EXACT_CONTACT_PAGE_BOUND_EXCEEDED");
        }
      }
    } else {
      const data = await this.request<any>(
        `/contacts?query=${target}&limit=50`,
      );
      contacts = data?._embedded?.contacts || [];
    }
    const matches = contacts.filter((c: any) => {
      const fields = c.custom_fields_values || [];
      const phoneField = fields.find(
        (f: any) =>
          f?.field_id === AMO_CONTACT_FIELDS.PHONE || f?.field_code === "PHONE",
      );
      const vals = phoneField?.values || [];
      return vals.some((v: any) => last10Digits(v?.value) === target);
    });
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    if (options.strict) {
      throw new Error("AMBIGUOUS_EXACT_CONTACT");
    }
    // An upstream failure must propagate. Returning null on 401/403/timeout
    // means "contact does not exist" and lets callers create duplicates.
    matches.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    return matches[0];
  }

  async findBrokerContactByPhone(
    phone: string,
    options: { strict?: boolean } = {},
  ): Promise<AmoContact | null> {
    const target = last10Digits(phone);
    if (target.length < 10) return null;
    try {
      const data = await this.request<any>(
        `/contacts?query=${target}&limit=50`,
      );
      const contacts: any[] = data?._embedded?.contacts || [];
      const brokerCandidates = contacts.filter((c: any) => {
        const fields = c.custom_fields_values || [];
        const brokerField = fields.find(
          (f: any) => f.field_id === AMO_CONTACT_FIELDS.IS_BROKER,
        );
        const phoneField = fields.find(
          (f: any) =>
            f.field_id === AMO_CONTACT_FIELDS.PHONE || f.field_code === "PHONE",
        );
        const hasExactPhone = (phoneField?.values || []).some(
          (v: any) => last10Digits(v?.value) === target,
        );
        return brokerField?.values?.[0]?.value === true && hasExactPhone;
      });
      if (brokerCandidates.length === 0) return null;
      if (brokerCandidates.length === 1) return brokerCandidates[0];
      if (options.strict) {
        const ids = brokerCandidates.map((c: any) => c.id).join(",");
        throw new Error(`AMBIGUOUS_BROKER_CONTACT ids=${ids}`);
      }

      // Multiple broker candidates — pick the one with the most linked leads
      let best: any = null;
      let bestLeads = -1;
      for (const cand of brokerCandidates) {
        const full = await this.getContact(cand.id);
        const leadsCount = full?._embedded?.leads?.length || 0;
        if (leadsCount > bestLeads) {
          bestLeads = leadsCount;
          best = full || cand;
        }
      }
      return best;
    } catch (e) {
      if (options.strict) throw e;
      return null;
    }
  }

  async getContact(id: number): Promise<AmoContact | null> {
    try {
      return await this.request<AmoContact>(`/contacts/${id}?with=leads`);
    } catch {
      return null;
    }
  }

  // КБ6 fix #44 (2026-05-25): bulk-получение контактов пачками до 250.
  // amoCRM API позволяет filter[id][]=…&filter[id][]=… (до 250 ID в одном запросе).
  // Это ~250x меньше HTTP-запросов чем перебор по одному.
  // Возвращает Map<id, AmoContact> с найденными контактами. Те, что не вернулись,
  // в map просто отсутствуют — вызывающий код решает, ошибка это или нет.
  async getContactsByIds(
    ids: number[],
    options: { strict?: boolean } = {},
  ): Promise<Map<number, AmoContact>> {
    if (
      options.strict &&
      (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(ids).size !== ids.length)
    ) {
      throw new Error("AMO_UNIQUENESS_CONTACT_IDS_INVALID");
    }
    const result = new Map<number, AmoContact>();
    const BATCH = 250;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const requested = new Set(chunk);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const data = await this.request<any>(
          `/contacts?${q}&with=leads&limit=${BATCH}`,
        );
        const rawList = data?._embedded?.contacts;
        if (options.strict && !Array.isArray(rawList)) {
          throw new Error("AMO_UNIQUENESS_CONTACTS_PAGE_INVALID");
        }
        const list: AmoContact[] = Array.isArray(rawList) ? rawList : [];
        for (const c of list) {
          const id = Number(c?.id);
          if (options.strict) {
            if (!Number.isSafeInteger(id) || id <= 0) {
              throw new Error("AMO_UNIQUENESS_CONTACT_ID_INVALID");
            }
            if (!requested.has(id)) {
              throw new Error("AMO_UNIQUENESS_CONTACT_ID_UNREQUESTED");
            }
            if (result.has(id)) {
              throw new Error("AMO_UNIQUENESS_CONTACT_ID_DUPLICATE");
            }
          }
          result.set(id, c);
        }
        if (
          options.strict &&
          chunk.some((requestedId) => !result.has(requestedId))
        ) {
          throw new Error("AMO_UNIQUENESS_CONTACTS_INCOMPLETE");
        }
      } catch (e: any) {
        if (options.strict) throw e;
        // Pacht прошёл с ошибкой — оставляем missing, не валим всю операцию.
        console.error("[getContactsByIds] batch failed:", e?.message || e);
      }
      // Лёгкая задержка между пачками чтобы не словить 429 на больших объёмах.
      if (i + BATCH < ids.length) await sleep(150);
    }
    return result;
  }

  async createContact(data: CreateContactDto): Promise<AmoContact> {
    const result = await this.request<any>(
      "/contacts",
      {
        method: "POST",
        body: JSON.stringify([data]),
      },
      { retryTransient: false },
    );
    return result?._embedded?.contacts?.[0];
  }

  /**
   * One-shot client-contact mutation for a caller that already owns the
   * shared fixation phone lease and has durably armed reconciliation. It does
   * no lookup/upsert and inherits createContact's retryTransient:false POST.
   */
  async createFixationClientContactOnce(
    data: FixationClientContactInput,
  ): Promise<AmoContact> {
    if (
      typeof data?.clientPhone !== "string" ||
      last10Digits(data.clientPhone).length !== 10 ||
      typeof data?.clientName !== "string" ||
      !data.clientName.trim()
    ) {
      throw new Error("FIXATION_CLIENT_CONTACT_INPUT_INVALID");
    }
    return this.createContact({
      name: data.clientName,
      custom_fields_values: fixationClientCustomFields(data),
    });
  }

  async updateContact(
    id: number,
    data: Partial<CreateContactDto>,
  ): Promise<void> {
    await this.request(`/contacts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  /**
   * Broker promotion is a one-shot mutation. A timeout/401/429/5xx must be
   * reconciled by an exact GET at the service layer and must never replay the
   * PATCH, even though the generic updateContact remains retryable for its
   * existing idempotent callers.
   */
  async promoteContactToBroker(id: number): Promise<void> {
    await this.request(
      `/contacts/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          custom_fields_values: [
            {
              field_id: AMO_CONTACT_FIELDS.IS_BROKER,
              values: [{ value: true }],
            },
          ],
        }),
      },
      { retryTransient: false },
    );
  }

  // Добавить примечание к лиду в amoCRM. Используется для уведомления
  // менеджеров о действиях брокера (создал встречу, оператор зафиксировал
  // звонок и т.д.) — пока не настроены полноценные custom_fields.
  async addNoteToLead(leadId: number, text: string): Promise<void> {
    await this.request(`/leads/${leadId}/notes`, {
      method: "POST",
      body: JSON.stringify([{ note_type: "common", params: { text } }]),
    });
  }

  // 2026-05-26: задача в amoCRM с дедлайном и текстом.
  // Появляется в задачах сотрудника КЦ → отработает.
  // entityType: 'leads' | 'contacts' | 'companies'
  // taskTypeId: 1 = звонок, 2 = встреча, 3+ = кастомные (зависит от настроек amoCRM)
  // completeTill: unix timestamp в секундах (когда задача должна быть выполнена)
  async createTask(data: {
    text: string;
    entityType: "leads" | "contacts" | "companies";
    entityId: number;
    completeTillSec?: number; // default: +24h
    taskTypeId?: number; // default: 1 (звонок)
    responsibleUserId?: number; // если знаем кому именно
  }): Promise<void> {
    const completeTill =
      data.completeTillSec || Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const body: any = {
      text: data.text,
      complete_till: completeTill,
      entity_type: data.entityType,
      entity_id: data.entityId,
      task_type_id: data.taskTypeId || 1,
    };
    if (data.responsibleUserId)
      body.responsible_user_id = data.responsibleUserId;
    await this.request("/tasks", {
      method: "POST",
      body: JSON.stringify([body]),
    });
  }

  // 2026-06-15: список НЕзавершённых задач конкретного ответственного
  // в указанном временном окне. Используется для определения занятых
  // слотов менеджера встреч (Ксения) — чтобы брокер в кабинете не мог
  // забронировать время, на которое у неё уже есть задача в amo.
  // amoCRM filter[complete_till] — unix timestamp в секундах.
  async getOpenTasksForUser(
    responsibleUserId: number,
    fromSec: number,
    toSec: number,
  ): Promise<
    Array<{
      id: number;
      text: string;
      completeTill: number;
      durationSec: number;
    }>
  > {
    if (!responsibleUserId) return [];
    try {
      const params = [
        `filter[responsible_user_id]=${responsibleUserId}`,
        `filter[is_completed]=0`,
        `filter[complete_till][from]=${fromSec}`,
        `filter[complete_till][to]=${toSec}`,
        `limit=250`,
      ].join("&");
      const data = await this.request<any>(`/tasks?${params}`);
      const items = data?._embedded?.tasks || [];
      // У задачи в amo нет «продолжительности» — есть только complete_till
      // (deadline). Берём фиксированный слот 60 минут (стандарт для встреч
      // у Ксении). Если задача не «встреча» а просто «позвонить», 60 минут
      // — пессимистичная оценка, лучше перебдеть чем недобдеть.
      return items.map((t: any) => ({
        id: t.id,
        text: t.text,
        completeTill: Number(t.complete_till) * 1000, // ms
        durationSec: 60 * 60,
      }));
    } catch (e: any) {
      console.error("[getOpenTasksForUser] failed:", e?.message || e);
      return [];
    }
  }

  // 2026-06-10: список задач по entity (лиду / контакту). Используется
  // для диагностики «кто ответственный за задачу» — чтобы убедиться
  // что Морикит / наш код проставляет правильного человека.
  async getTasksByEntity(
    entityType: "leads" | "contacts",
    entityId: number,
  ): Promise<
    Array<{
      id: number;
      text: string;
      task_type_id: number;
      responsible_user_id: number;
      is_completed: boolean;
      complete_till: number;
      created_at: number;
    }>
  > {
    try {
      const data = await this.request<any>(
        `/tasks?filter[entity_type]=${entityType}&filter[entity_id]=${entityId}&limit=50`,
      );
      const items = data?._embedded?.tasks || [];
      return items.map((t: any) => ({
        id: t.id,
        text: t.text,
        task_type_id: t.task_type_id,
        responsible_user_id: t.responsible_user_id,
        is_completed: t.is_completed,
        complete_till: t.complete_till,
        created_at: t.created_at,
      }));
    } catch (e: any) {
      console.error("[getTasksByEntity] failed:", e?.message || e);
      return [];
    }
  }

  // 2026-06-11: Морикит создаёт задачу на КЦ-менеджере по графику смен, НО
  // не обновляет responsible_user_id на самом лиде — там остаётся автор
  // OAuth-токена (= админ). КЦ-менеджер не видит лид в своих фильтрах.
  //
  // Этот helper делает post-sync: периодически (раз в intervalMs, до maxAttempts)
  // читает задачи на лиде. Как только появится задача с responsible_user_id
  // отличным от текущего на лиде — обновляет лид и выходит. Возвращает true
  // если ответственный был обновлён.
  //
  // 2026-06-11 v2: Морикит создаёт задачу через ~30 сек после webhook'а
  // (по наблюдению на тестовом лиде 32208713). Раньше делали одну проверку
  // через 8 сек — не успевали. Теперь polling: 10 сек × 6 попыток = до 60 сек.
  //
  // 2026-06-17: до 5 минут (30×10с) — был кейс с лидом 32216265 (RULE_EXCEPTION
  // _AFTER_SALES_MEETING), когда Морикит-задача появилась после 60с и polling
  // её не дождался → ответственный на лиде остался админом. ПЛЮС: захватываем
  // initialResponsible при старте и обновляем ТОЛЬКО если он не изменился
  // (защита от перетирания, если КЦ-менеджер вручную взял лид во время
  // polling).
  async syncLeadResponsibleFromLatestTask(
    leadId: number,
    opts: { intervalMs?: number; maxAttempts?: number } = {},
  ): Promise<boolean> {
    const intervalMs = opts.intervalMs ?? 10000;
    const maxAttempts = opts.maxAttempts ?? 30;
    // Фиксируем начального ответственного — если кто-то вручную возьмёт лид
    // во время polling, не перетираем его выбор.
    let initialResponsible: number | undefined;
    try {
      const initial = await this.getLead(leadId);
      initialResponsible = (initial as any)?.responsible_user_id;
    } catch (e: any) {
      console.warn(
        `[sync-lead-responsible] lead=${leadId} initial getLead failed:`,
        e?.message || e,
      );
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (intervalMs > 0) await sleep(intervalMs);
      try {
        const tasks = await this.getTasksByEntity("leads", leadId);
        if (!tasks.length) continue;
        const latest = tasks
          .filter((t) => !!t.responsible_user_id)
          .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
        if (!latest?.responsible_user_id) continue;
        const lead = await this.getLead(leadId);
        const currentResponsible = (lead as any)?.responsible_user_id;
        if (currentResponsible === latest.responsible_user_id) return false;
        // Защита от перетирания ручного выбора КЦ-менеджера: если responsible
        // на лиде УЖЕ изменился относительно начального — значит кто-то
        // вручную взял лид → не трогаем.
        if (
          initialResponsible !== undefined &&
          currentResponsible !== initialResponsible
        ) {
          console.log(
            `[sync-lead-responsible] lead=${leadId} skip — responsible изменился вручную (${initialResponsible} → ${currentResponsible}), не перетираем`,
          );
          return false;
        }
        await this.updateLead(leadId, {
          responsible_user_id: latest.responsible_user_id,
        });
        console.log(
          `[sync-lead-responsible] lead=${leadId} updated: ${currentResponsible} → ${latest.responsible_user_id} (task ${latest.id}, attempt ${attempt})`,
        );
        return true;
      } catch (e: any) {
        console.error(
          `[sync-lead-responsible] attempt ${attempt} failed:`,
          e?.message || e,
        );
      }
    }
    console.warn(
      `[sync-lead-responsible] lead=${leadId}: задачу с responsible не нашли за ${(maxAttempts * intervalMs) / 1000}с — Морикит залип?`,
    );
    return false;
  }

  async addNoteToContact(contactId: number, text: string): Promise<void> {
    await this.request(`/contacts/${contactId}/notes`, {
      method: "POST",
      body: JSON.stringify([{ note_type: "common", params: { text } }]),
    });
  }

  // === Companies ===
  async findCompanyByInn(inn: string): Promise<AmoCompany | null> {
    try {
      const data = await this.request<any>(
        `/companies?query=${encodeURIComponent(inn)}`,
      );
      const companies = data?._embedded?.companies || [];
      return companies[0] || null;
    } catch {
      return null;
    }
  }

  async createCompany(data: CreateCompanyDto): Promise<AmoCompany> {
    const result = await this.request<any>("/companies", {
      method: "POST",
      body: JSON.stringify([data]),
    });
    return result?._embedded?.companies?.[0];
  }

  /**
   * 2026-07-03: PATCH одной компании — используется для синка реквизитов
   * агентства (Юр. лицо, ОГРН, КПП, банк, БИК, р/с, к/с и т.д.). amoCRM v4
   * принимает объект напрямую (не массив как в create).
   */
  async updateCompany(
    id: number,
    data: { name?: string; custom_fields_values?: any[] },
  ): Promise<AmoCompany | null> {
    try {
      return await this.request<AmoCompany>(`/companies/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    } catch (e) {
      return null;
    }
  }

  async linkContactToCompany(
    contactId: number,
    companyId: number,
  ): Promise<void> {
    await this.request(`/contacts/${contactId}/link`, {
      method: "POST",
      body: JSON.stringify([
        { to_entity_id: companyId, to_entity_type: "companies" },
      ]),
    });
  }

  async getContactCompanyIds(contactId: number): Promise<number[]> {
    const links = await this.request<any>(
      `/contacts/${contactId}/links?filter[to_entity_type]=companies&limit=250`,
    );
    return Array.from(
      new Set(
        (Array.isArray(links?._embedded?.links) ? links._embedded.links : [])
          .filter((link: any) => link?.to_entity_type === "companies")
          .map((link: any) => Number(link?.to_entity_id))
          .filter((id: number) => Number.isSafeInteger(id) && id > 0),
      ),
    ) as number[];
  }

  async replaceContactCompany(
    contactId: number,
    companyId: number,
  ): Promise<void> {
    const currentCompanyIds = await this.getContactCompanyIds(contactId);

    if (!currentCompanyIds.includes(companyId)) {
      await this.linkContactToCompany(contactId, companyId);
    }

    const obsoleteCompanyIds = currentCompanyIds.filter(
      (id) => id !== companyId,
    );
    if (obsoleteCompanyIds.length > 0) {
      await this.request(`/contacts/${contactId}/unlink`, {
        method: "POST",
        body: JSON.stringify(
          obsoleteCompanyIds.map((id) => ({
            to_entity_id: id,
            to_entity_type: "companies",
          })),
        ),
      });
    }
  }

  /**
   * Связывает контакт брокера с Company в amoCRM (поле «Компания» в карточке).
   * Ищем по ИНН, иначе создаём компанию с названием агентства.
   */
  async syncAgencyCompanyToAmoContact(
    contactId: number,
    agency: {
      name?: string | null;
      inn?: string | null;
      legalName?: string | null;
      legalAddress?: string | null;
      address?: string | null;
      ogrn?: string | null;
      kpp?: string | null;
      bankName?: string | null;
      bankBik?: string | null;
      bankAccount?: string | null;
      correspondentAccount?: string | null;
      phone?: string | null;
      email?: string | null;
    } | null,
  ): Promise<number | null> {
    const agencyName = String(agency?.name || "").trim();
    if (!contactId || !agencyName) return null;
    const companyPayload = {
      name: agencyName,
      custom_fields_values: agencyToAmoCompanyFields(agency || {}),
    };
    let amoCompanyId: number | null = null;
    if (agency?.inn) {
      const found = await this.findCompanyByInn(agency.inn);
      if (found?.id) {
        amoCompanyId = Number(found.id);
        await this.updateCompany(amoCompanyId, companyPayload);
      }
    }
    if (!amoCompanyId) {
      const created = await this.createCompany(companyPayload);
      if (created?.id) amoCompanyId = Number(created.id);
    }
    if (amoCompanyId) {
      await this.replaceContactCompany(contactId, amoCompanyId);
    }
    return amoCompanyId;
  }

  // === Leads (deals) ===
  async getLead(id: number): Promise<AmoLead | null> {
    try {
      return await this.request<AmoLead>(
        `/leads/${id}?with=contacts,companies`,
      );
    } catch {
      return null;
    }
  }

  async createLead(data: CreateLeadDto): Promise<AmoLead> {
    // amoCRM API v4 ждёт contacts/companies в _embedded, не на верхнем уровне.
    // До правки 2026-05-15 контакты передавались на верхнем уровне → терялись,
    // лид создавался "сиротой" без привязки к контакту.
    const { contacts, companies, ...rest } = data as any;
    const payload: any = { ...rest };
    if (contacts || companies) {
      payload._embedded = {};
      if (contacts) payload._embedded.contacts = contacts;
      if (companies) payload._embedded.companies = companies;
    }
    const result = await this.request<any>(
      "/leads",
      {
        method: "POST",
        body: JSON.stringify([payload]),
      },
      { retryTransient: false, timeoutMs: AMO_LEAD_CREATE_TIMEOUT_MS },
    );
    return result?._embedded?.leads?.[0];
  }

  /**
   * GET-only recovery after a lost POST /leads response. Matches exactly one
   * KC-pipeline lead on the client contact, created in the given window, with
   * the responsible broker attached. Never POSTs.
   */
  async recoverFixationLeadAfterAmbiguousCreate(params: {
    clientPhone: string;
    brokerAmoContactId: number;
    createdAfterUnix: number;
    createdBeforeUnix: number;
    lookupAttempts?: number;
  }): Promise<RecoverFixationLeadResult> {
    if (
      !Number.isSafeInteger(params.brokerAmoContactId) ||
      params.brokerAmoContactId <= 0 ||
      !Number.isSafeInteger(params.createdAfterUnix) ||
      !Number.isSafeInteger(params.createdBeforeUnix) ||
      params.createdAfterUnix > params.createdBeforeUnix
    ) {
      return { kind: "ambiguous", reason: "invalid_recover_window" };
    }
    const attempts = Number.isSafeInteger(params.lookupAttempts)
      ? Math.max(1, Number(params.lookupAttempts))
      : 1;
    let last: RecoverFixationLeadResult = { kind: "empty" };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await this.lookupFixationLeadAfterAmbiguousCreate(params);
      if (last.kind === "found" || last.kind === "ambiguous") return last;
      if (attempt < attempts) await sleep(AMO_FIXATION_RECOVER_RETRY_DELAY_MS);
    }
    return last;
  }

  private async lookupFixationLeadAfterAmbiguousCreate(params: {
    clientPhone: string;
    brokerAmoContactId: number;
    createdAfterUnix: number;
    createdBeforeUnix: number;
  }): Promise<RecoverFixationLeadResult> {
    try {
      const contact = await this.findContactByPhone(params.clientPhone, {
        strict: true,
      });
      if (!contact) return { kind: "empty" };
      const contactId = Number(contact.id);
      if (!Number.isSafeInteger(contactId) || contactId <= 0) {
        return { kind: "ambiguous", reason: "invalid_contact_id" };
      }
      const leads = await this.getLeadsByContact(contactId);
      const matches = leads.filter(
        (lead) =>
          isKcPipelineLeadInWindow(
            lead,
            params.createdAfterUnix,
            params.createdBeforeUnix,
          ) && leadHasBrokerContact(lead, params.brokerAmoContactId),
      );
      if (matches.length === 0) return { kind: "empty" };
      if (matches.length > 1) {
        return {
          kind: "ambiguous",
          reason: `multiple_leads:${matches
            .map((lead) => Number(lead.id))
            .join(",")}`,
        };
      }
      const leadId = Number(matches[0].id);
      if (!Number.isSafeInteger(leadId) || leadId <= 0) {
        return { kind: "ambiguous", reason: "invalid_lead_id" };
      }
      return { kind: "found", leadId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "lookup_failed";
      return { kind: "ambiguous", reason: message.slice(0, 120) };
    }
  }

  private async createFixationLeadOrRecover(params: {
    leadData: Record<string, unknown>;
    clientPhone: string;
    brokerAmoContactId: number;
  }): Promise<AmoLead> {
    const createdAfterUnix =
      Math.floor(Date.now() / 1000) - AMO_FIXATION_RECOVER_CLOCK_SKEW_SECONDS;
    try {
      const created = await this.createLead(params.leadData as any);
      const id = Number(created?.id);
      if (Number.isSafeInteger(id) && id > 0) return created;
      throw new Error("amoCRM did not return a lead id");
    } catch (error) {
      if (!isAmbiguousLeadCreateTransportError(error)) throw error;
      const createdBeforeUnix =
        Math.floor(Date.now() / 1000) + AMO_FIXATION_RECOVER_CLOCK_SKEW_SECONDS;
      const recovered = await this.recoverFixationLeadAfterAmbiguousCreate({
        clientPhone: params.clientPhone,
        brokerAmoContactId: params.brokerAmoContactId,
        createdAfterUnix,
        createdBeforeUnix,
        lookupAttempts: AMO_FIXATION_RECOVER_LOOKUP_ATTEMPTS,
      });
      if (recovered.kind === "found") {
        const lead = await this.getLead(recovered.leadId);
        if (lead && Number(lead.id) === recovered.leadId) return lead;
        return { id: recovered.leadId } as AmoLead;
      }
      if (recovered.kind === "empty") {
        throw new Error(AMO_FIXATION_CREATE_UNCONFIRMED_NO_LEAD);
      }
      throw error;
    }
  }

  async updateLead(id: number, data: UpdateLeadDto): Promise<void> {
    await this.request(`/leads/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  /**
   * 2026-06-11: прикрепить контакт к лиду (в наш сценарий — брокера к старому
   * лиду клиента по Правилу 1). Эквивалент кнопки «Добавить контакт» в карточке
   * лида amoCRM. Идемпотентно: если контакт уже привязан, amoCRM вернёт 200 ОК.
   */
  async linkContactToLead(leadId: number, contactId: number): Promise<void> {
    await this.request(`/leads/${leadId}/link`, {
      method: "POST",
      body: JSON.stringify([
        {
          to_entity_id: contactId,
          to_entity_type: "contacts",
        },
      ]),
    });
  }

  /**
   * 2026-06-03: проверка уникальности клиента по телефону через amoCRM.
   * Делает 3 запроса: findContactByPhone + getLeadsByContact + getContactsByIds
   * (для проверки IS_BROKER на каждом лиде). Применяет 4 правила пользователя.
   *
   * Возвращает 'UNIQUE' → создавать Client с CONDITIONALLY_UNIQUE
   * Возвращает 'ALARM' → создавать Client с UNDER_REVIEW + задача для КЦ
   */
  async checkUniqueness(phone: string): Promise<{
    rule: import("./amo-crm.fields").FixationRule;
    verdict: "UNIQUE" | "ALARM"; // @deprecated: для совместимости со старым кодом
    reason: string;
    contactId?: number;
    leads?: Array<{ id: number; pipeline_id: number; status_id: number }>;
    triggerType?: "DEFERRED_DEMAND" | "NEW_REQUEST_NO_BROKER" | "ACTIVE_SALES";
    triggerLeadId?: number;
  }> {
    // Uniqueness must be based on the complete exact-phone result set. A
    // best-effort first page (or choosing one of several exact contacts) can
    // hide active leads and authorize a duplicate fixation.
    const contact = await this.findContactByPhone(phone, { strict: true });
    if (!contact) {
      return {
        rule: "NO_CONFLICT",
        verdict: "UNIQUE",
        reason: "Контакт в amoCRM не найден",
      };
    }
    const leads = await this.getLeadsByContact(contact.id);
    if (leads.length === 0) {
      return {
        rule: "NO_CONFLICT",
        verdict: "UNIQUE",
        reason: "У контакта нет лидов в amoCRM",
        contactId: contact.id,
        leads: [],
      };
    }
    // Собрать все contactId из всех лидов одним батчем — экономим запросы.
    const allContactIds = new Set<number>();
    for (const lead of leads) {
      const contactRefs = (lead as any)?._embedded?.contacts;
      if (!Array.isArray(contactRefs)) {
        throw new Error("AMO_UNIQUENESS_LEAD_CONTACTS_INVALID");
      }
      const leadContactIds = new Set<number>();
      for (const contactRef of contactRefs) {
        const contactId = Number(contactRef?.id);
        if (!Number.isSafeInteger(contactId) || contactId <= 0) {
          throw new Error("AMO_UNIQUENESS_LEAD_CONTACT_ID_INVALID");
        }
        if (leadContactIds.has(contactId)) {
          throw new Error("AMO_UNIQUENESS_LEAD_CONTACT_ID_DUPLICATE");
        }
        leadContactIds.add(contactId);
        allContactIds.add(contactId);
      }
      if (!leadContactIds.has(Number(contact.id))) {
        throw new Error("AMO_UNIQUENESS_LEAD_CONTACT_INCOMPLETE");
      }
    }
    const contactsMap = await this.getContactsByIds(Array.from(allContactIds), {
      strict: true,
    });

    const isBroker = (c: any): boolean => {
      const fields = c?.custom_fields_values || [];
      const brokerField = fields.find(
        (f: any) => f?.field_id === AMO_CONTACT_FIELDS.IS_BROKER,
      );
      return brokerField?.values?.[0]?.value === true;
    };

    const leadsForEval = leads.map((lead: any) => {
      const contactIds = lead._embedded.contacts.map((c: any) => Number(c.id));
      const hasBroker = contactIds.some((id: number) => {
        const c = contactsMap.get(id);
        return c ? isBroker(c) : false;
      });
      return {
        id: lead.id,
        pipeline_id: lead.pipeline_id,
        status_id: lead.status_id,
        hasBrokerAttached: hasBroker,
      };
    });

    const verdict = evaluateUniqueness(leadsForEval);

    return {
      rule: verdict.rule,
      verdict: verdict.verdict,
      reason: verdict.reason,
      contactId: contact.id,
      leads: leadsForEval.map((l) => ({
        id: l.id,
        pipeline_id: l.pipeline_id,
        status_id: l.status_id,
      })),
      triggerType: verdict.triggerType,
      triggerLeadId: verdict.triggerLeadId,
    };
  }

  async getLeadsByContact(contactId: number): Promise<AmoLead[]> {
    if (!Number.isSafeInteger(contactId) || contactId <= 0) {
      throw new Error("AMO_UNIQUENESS_CONTACT_ID_INVALID");
    }
    const contact = await this.request<any>(
      `/contacts/${contactId}?with=leads`,
    );
    const leadRefs = contact?._embedded?.leads;
    if (!Array.isArray(leadRefs)) {
      throw new Error("AMO_UNIQUENESS_CONTACT_LEADS_INVALID");
    }
    const leadIds: number[] = [];
    const requestedLeadIds = new Set<number>();
    for (const leadRef of leadRefs) {
      const leadId = Number(leadRef?.id);
      if (!Number.isSafeInteger(leadId) || leadId <= 0) {
        throw new Error("AMO_UNIQUENESS_LEAD_ID_INVALID");
      }
      if (requestedLeadIds.has(leadId)) {
        throw new Error("AMO_UNIQUENESS_LEAD_ID_DUPLICATE");
      }
      requestedLeadIds.add(leadId);
      leadIds.push(leadId);
    }
    if (leadIds.length === 0) return [];
    // A failed lookup must propagate. Treating a 401/403/timeout as "no leads"
    // makes uniqueness appear successful and can create a duplicate fixation.
    const leads: AmoLead[] = [];
    const returnedLeadIds = new Set<number>();
    const BATCH = 250;
    for (let i = 0; i < leadIds.length; i += BATCH) {
      const chunk = leadIds.slice(i, i + BATCH);
      const chunkIds = new Set(chunk);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      const data = await this.request<any>(
        `/leads?${q}&with=contacts&limit=${BATCH}`,
      );
      const batchLeads = data?._embedded?.leads;
      if (!Array.isArray(batchLeads)) {
        throw new Error("AMO_UNIQUENESS_LEADS_PAGE_INVALID");
      }
      for (const lead of batchLeads) {
        const leadId = Number(lead?.id);
        if (!Number.isSafeInteger(leadId) || leadId <= 0) {
          throw new Error("AMO_UNIQUENESS_LEAD_ID_INVALID");
        }
        if (!chunkIds.has(leadId)) {
          throw new Error("AMO_UNIQUENESS_LEAD_ID_UNREQUESTED");
        }
        if (returnedLeadIds.has(leadId)) {
          throw new Error("AMO_UNIQUENESS_LEAD_ID_DUPLICATE");
        }
        const pipelineId = Number((lead as any)?.pipeline_id);
        const statusId = Number((lead as any)?.status_id);
        if (
          !Number.isSafeInteger(pipelineId) ||
          pipelineId <= 0 ||
          !Number.isSafeInteger(statusId) ||
          statusId <= 0
        ) {
          throw new Error("AMO_UNIQUENESS_LEAD_FIELDS_INVALID");
        }
        if (!isKnownUniquenessLeadStage(pipelineId, statusId)) {
          throw new Error("AMO_UNIQUENESS_LEAD_STAGE_UNRECOGNIZED");
        }
        if (!isClassifiedUniquenessLeadStage(pipelineId, statusId)) {
          throw new Error("AMO_UNIQUENESS_LEAD_STAGE_UNCLASSIFIED");
        }
        const contactRefs = (lead as any)?._embedded?.contacts;
        if (!Array.isArray(contactRefs)) {
          throw new Error("AMO_UNIQUENESS_LEAD_CONTACTS_INVALID");
        }
        const contactIds = new Set<number>();
        for (const contactRef of contactRefs) {
          const linkedContactId = Number(contactRef?.id);
          if (!Number.isSafeInteger(linkedContactId) || linkedContactId <= 0) {
            throw new Error("AMO_UNIQUENESS_LEAD_CONTACT_ID_INVALID");
          }
          if (contactIds.has(linkedContactId)) {
            throw new Error("AMO_UNIQUENESS_LEAD_CONTACT_ID_DUPLICATE");
          }
          contactIds.add(linkedContactId);
        }
        if (!contactIds.has(contactId)) {
          throw new Error("AMO_UNIQUENESS_LEAD_CONTACT_INCOMPLETE");
        }
        returnedLeadIds.add(leadId);
        leads.push(lead);
      }
      if (chunk.some((leadId) => !returnedLeadIds.has(leadId))) {
        throw new Error("AMO_UNIQUENESS_LEADS_INCOMPLETE");
      }
      if (i + BATCH < leadIds.length) await sleep(150);
    }
    return leads;
  }

  async getLeadsByPipeline(
    pipelineId: number,
    limit = 250,
  ): Promise<AmoLead[]> {
    const allLeads: AmoLead[] = [];
    let page = 1;
    try {
      while (true) {
        const data = await this.request<any>(
          `/leads?filter[pipeline_id][]=${pipelineId}&limit=${limit}&page=${page}&with=contacts`,
        );
        const leads = data?._embedded?.leads || [];
        if (leads.length === 0) break;
        allLeads.push(...leads);
        if (leads.length < limit) break;
        page++;
        if (page > 20) break; // safety
      }
    } catch {}
    return allLeads;
  }

  async getLeadsByResponsibleUser(
    userId: number,
    limit = 250,
  ): Promise<AmoLead[]> {
    const allLeads: AmoLead[] = [];
    let page = 1;
    try {
      while (true) {
        const data = await this.request<any>(
          `/leads?filter[responsible_user_id][]=${userId}&limit=${limit}&page=${page}&with=contacts`,
        );
        const leads = data?._embedded?.leads || [];
        if (leads.length === 0) break;
        allLeads.push(...leads);
        if (leads.length < limit) break;
        page++;
      }
    } catch {}
    return allLeads;
  }

  // 2026-07-23: лиды воронки в руках конкретного ответственного, опционально
  // созданные не раньше createdFromSec. Используется кроном, который чинит
  // КЦ-заявки, зависшие на Админе (responsible = владелец токена по умолчанию).
  async getLeadsByPipelineAndResponsible(
    pipelineId: number,
    userId: number,
    createdFromSec?: number,
    limit = 250,
  ): Promise<AmoLead[]> {
    const allLeads: AmoLead[] = [];
    let page = 1;
    try {
      while (true) {
        const params = [
          `filter[pipeline_id][]=${pipelineId}`,
          `filter[responsible_user_id][]=${userId}`,
          `limit=${limit}`,
          `page=${page}`,
        ];
        if (createdFromSec)
          params.push(`filter[created_at][from]=${createdFromSec}`);
        const data = await this.request<any>(`/leads?${params.join("&")}`);
        const leads = data?._embedded?.leads || [];
        if (leads.length === 0) break;
        allLeads.push(...leads);
        if (leads.length < limit) break;
        page++;
        if (page > 20) break; // safety
      }
    } catch {}
    return allLeads;
  }

  async reopenLead(id: number, newBrokerAmoId: number): Promise<AmoLead> {
    await this.updateLead(id, { status_id: 142 } as any);
    return (await this.getLead(id))!;
  }

  async getLeadStage(leadId: number): Promise<string> {
    const lead = await this.getLead(leadId);
    return lead?.status_id ? String(lead.status_id) : "";
  }

  // === Pipelines ===
  async getPipelines(): Promise<any[]> {
    const data = await this.request<any>("/leads/pipelines");
    return data?._embedded?.pipelines || [];
  }

  // === Custom fields ===
  async getContactCustomFields(): Promise<any[]> {
    const data = await this.request<any>("/contacts/custom_fields");
    return data?._embedded?.custom_fields || [];
  }

  async getCompanyCustomFields(): Promise<any[]> {
    const data = await this.request<any>("/companies/custom_fields");
    return data?._embedded?.custom_fields || [];
  }

  // === Users ===
  async getUsers(): Promise<any[]> {
    const data = await this.request<any>("/users");
    return data?._embedded?.users || [];
  }

  async findUserByPhone(phone: string): Promise<any | null> {
    const users = await this.getUsers();
    const cleanPhone = phone.replace(/\D/g, "");
    return (
      users.find((u: any) => {
        const userPhone = String(u.phone || "").replace(/\D/g, "");
        return userPhone && userPhone.endsWith(cleanPhone.slice(-10));
      }) || null
    );
  }

  // === Fixation request (create lead with broker info) ===
  async createFixationRequest(data: {
    clientPhone: string;
    clientEmail?: string; // правка 2026-05-15: записывается на контакт
    clientName: string;
    clientRegion?: string; // правка 2026-05-22: регион клиента (REGION=589265)
    presentationSent?: boolean; // правка 2026-05-22: «Отправлена презентация» на контакт клиента
    existingClientAmoContactId?: number;
    brokerPhone: string;
    brokerAmoContactId: number; // required invariant; linked as the lead's second contact
    additionalBrokerAmoContactIds?: number[];
    agencyName: string;
    agencyInn: string;
    comment: string;
    project: Project;
    // Новые поля 2026-05-14 — мапятся в amoCRM custom_fields_values.
    propertyType?: string;
    roomsCount?: string;
    amount?: number;
    sqm?: number;
    // Новые поля 2026-05-22 — заполняются опционально из формы фиксации.
    purchaseTiming?: string; // «Планирует покупку»: от 1 до 3 месяцев, 3-6, и т.д.
    readinessLevel?: string; // «Готовность к сделке»: Холодный/Тёплый/Горячий
    fromBroker?: boolean; // «От брокера» radio (по умолчанию true для fixation request)
    // 2026-06-03: если задан — не создаём новый лид, а прикрепляем брокера
    // к существующему. Логика «конкурирующие брокеры до акта осмотра»:
    // несколько брокеров одновременно могут быть условно-уникальными.
    reuseLeadId?: number;
    // 2026-06-14: id и краткое описание ПРЕДЫДУЩЕГО (закрытого) лида этого
    // же брокера на этого же клиента. Создаём НОВЫЙ лид + добавляем ссылку
    // на старый в первой ноте. Используется когда брокер повторно фиксирует
    // клиента, у которого прошлая сделка закрыта (143 / 142 / CANCELLED).
    previousLeadId?: number;
    previousLeadInfo?: string;
  }): Promise<AmoLead> {
    // Every `createFixationRequest` path represents a broker fixation, including
    // reuse/link flows. `fromBroker` only controls an amo custom-field marker; it
    // must never become a bypass that permits a client-only lead. Reject a
    // missing or malformed broker contact before the client lookup/contact
    // upsert and, critically, before either POST /leads path.
    if (
      !Number.isSafeInteger(data.brokerAmoContactId) ||
      data.brokerAmoContactId <= 0
    ) {
      throw new Error("BROKER_AMO_CONTACT_MISSING");
    }

    const additionalBrokerAmoContactIds =
      data.additionalBrokerAmoContactIds === undefined
        ? []
        : data.additionalBrokerAmoContactIds;
    if (
      !Array.isArray(additionalBrokerAmoContactIds) ||
      additionalBrokerAmoContactIds.some(
        (id) => !Number.isSafeInteger(id) || id <= 0,
      ) ||
      new Set(additionalBrokerAmoContactIds).size !==
        additionalBrokerAmoContactIds.length ||
      additionalBrokerAmoContactIds.includes(data.brokerAmoContactId)
    ) {
      throw new Error("AMO_FIXATION_BROKER_CONTACT_SET_INVALID");
    }
    if (
      data.reuseLeadId !== undefined &&
      (data.existingClientAmoContactId !== undefined ||
        data.additionalBrokerAmoContactIds !== undefined)
    ) {
      throw new Error("AMO_FIXATION_RECOVERY_CONTRACT_REUSE_UNSUPPORTED");
    }
    const brokerAmoContactIds = [
      data.brokerAmoContactId,
      ...additionalBrokerAmoContactIds
        .slice()
        .sort((left, right) => left - right),
    ];
    if (
      data.existingClientAmoContactId !== undefined &&
      (!Number.isSafeInteger(data.existingClientAmoContactId) ||
        data.existingClientAmoContactId <= 0)
    ) {
      throw new Error("AMO_FIXATION_CLIENT_CONTACT_ID_INVALID");
    }
    if (
      additionalBrokerAmoContactIds.length > 0 &&
      data.existingClientAmoContactId === undefined
    ) {
      throw new Error("AMO_FIXATION_ADDITIONAL_BROKERS_REQUIRE_EXACT_CLIENT");
    }
    if (
      data.existingClientAmoContactId !== undefined &&
      brokerAmoContactIds.includes(data.existingClientAmoContactId)
    ) {
      throw new Error("AMO_FIXATION_CONTACT_ROLE_COLLISION");
    }

    // Контакт КЛИЕНТА — формируем custom_fields_values, отдельно от создания
    const clientCustomFields = fixationClientCustomFields(data);

    const contactWasPreResolved = data.existingClientAmoContactId !== undefined;
    let contact = contactWasPreResolved
      ? ({
          id: data.existingClientAmoContactId,
          name: data.clientName,
        } as AmoContact)
      : await this.findContactByPhone(data.clientPhone, { strict: true });
    if (!contact) {
      contact = await this.createContact({
        name: data.clientName,
        custom_fields_values: clientCustomFields,
      });
    } else if (!contactWasPreResolved) {
      // Контакт существует — обновим переданные поля (email/region/presentation).
      // Без try/catch: если amo вернёт ошибку, мы не валим всю операцию.
      try {
        await this.updateContact(contact.id, {
          custom_fields_values: clientCustomFields,
        } as any);
      } catch {}
    }

    // Заполняем custom_fields на лиде (правка 2026-05-14):
    //   587387 — "Тип объекта"
    //   583447 — "Сколько комнат рассматривает"
    //   833045 — "Стоимость без скидок, руб" (= бюджет покупки)
    //   604555 — "Метраж, м2"
    if (!Number.isSafeInteger(contact?.id) || contact.id <= 0) {
      throw new Error("AMO_FIXATION_CLIENT_CONTACT_ID_INVALID");
    }

    const customFields: any[] = [];
    // 2026-06-09: 587387 «Тип объекта» и 583447 «Кол-во комнат» — это
    // multiselect (нужны enum_id). PATCH с value=строкой возвращает
    // 400 Bad Request и валит ВЕСЬ запрос (другие поля тоже не применяются).
    // Маппинг строка→enum_id пока не реализован — данные брокер ввёл
    // отдельным блоком в кабинете (см. PR #92), а в комментарий лида
    // они идут в текстовой ноте. Чтобы не блокировать остальные поля,
    // отправляем эти два поля как multiselect-enum через текстовый
    // helper, если совпадает (иначе пропускаем).
    const propertyTypeEnums: Record<string, number> = {
      // 2026-06-11: ID перевыверены через inspect-amo-fields --grep="Тип объекта".
      // Старые значения были перепутаны: 859233 на самом деле «Апартамент»,
      // 981093 — «Кладовая», 1025397 — «Квартира». В результате форма «Апартаменты»
      // улетала в amoCRM как «Кладовая». Реальные enum_id для field 587387:
      //   859233  «Апартамент»
      //   859235  «Паркинг»
      //   889061  «Покупка коммерческого помещения»
      //   981093  «Кладовая»
      //   981095  «Аренда коммерческого помещения»
      //   1025397 «Квартира»
      // Форма (apps/web/.../fixation/page.tsx) шлёт только 3 значения:
      // «Квартира», «Апартаменты», «Коммерческая» — мапим эти три.
      квартира: 1025397,
      апартаменты: 859233,
      апартамент: 859233,
      коммерческая: 889061,
      "коммерческое помещение": 889061,
      кладовая: 981093,
      паркинг: 859235,
      машиноместо: 859235,
    };
    if (data.propertyType) {
      const enumId =
        propertyTypeEnums[String(data.propertyType).toLowerCase().trim()];
      if (enumId)
        customFields.push({ field_id: 587387, values: [{ enum_id: enumId }] });
    }
    const roomsCountEnums: Record<string, number> = {
      // ID получены через GET /leads/custom_fields/583447 (multiselect).
      "1": 852923,
      "1к": 852923,
      однушка: 852923,
      "2": 852925,
      "2к": 852925,
      двушка: 852925,
      "3": 852927,
      "3к": 852927,
      трёшка: 852927,
      трешка: 852927,
      студия: 889059,
    };
    if (data.roomsCount) {
      const enumId =
        roomsCountEnums[String(data.roomsCount).toLowerCase().trim()];
      if (enumId)
        customFields.push({ field_id: 583447, values: [{ enum_id: enumId }] });
    }
    if (data.amount && data.amount > 0)
      customFields.push({
        field_id: 833045,
        values: [{ value: String(data.amount) }],
      });
    if (data.sqm && data.sqm > 0)
      customFields.push({
        field_id: 604555,
        values: [{ value: String(data.sqm) }],
      });
    // Правка 2026-05-15: добавляем поля левого сайдбара лида автоматом.
    // 583155 «Цель покупки» — по умолчанию «Себе» (большинство случаев).
    // 839179 «Объект интереса» — из выбранного проекта.
    customFields.push({ field_id: 583155, values: [{ value: "Себе" }] });
    const objectByProject: Record<string, string> = {
      ZORGE9: "Зорге 9",
      SILVER_BOR: "Берзарина 37",
    };
    const projectObj = objectByProject[String(data.project)] || "Зорге 9";
    customFields.push({ field_id: 839179, values: [{ value: projectObj }] });

    // Поля воронки КЦ (2026-05-22, ID получены через debug-endpoint):
    // — От брокера (radio): для fixation request ВСЕГДА Да
    if (data.fromBroker !== false) {
      customFields.push({
        field_id: AMO_LEAD_FIELDS.FROM_BROKER,
        values: [{ enum_id: AMO_LEAD_ENUMS.FROM_BROKER_YES }],
      });
    }
    // — Дата создания заявки от брокера (date, unix sec) — текущий момент
    customFields.push({
      field_id: AMO_LEAD_FIELDS.BROKER_REQUEST_DATE,
      values: [{ value: Math.floor(Date.now() / 1000) }],
    });
    // — Опросник заполнен (select) = Нет (по умолчанию для свежей фиксации)
    customFields.push({
      field_id: AMO_LEAD_FIELDS.QUESTIONNAIRE_FILLED,
      values: [{ enum_id: AMO_LEAD_ENUMS.QUESTIONNAIRE_NO }],
    });
    // — Готовность к сделке (select) — если оператор выбрал в форме
    if (data.readinessLevel) {
      const eid = readinessLevelToEnumId(data.readinessLevel);
      if (eid)
        customFields.push({
          field_id: AMO_LEAD_FIELDS.READINESS_LEVEL,
          values: [{ enum_id: eid }],
        });
    }
    // — Планирует покупку в срок (select)
    if (data.purchaseTiming) {
      const eid = purchaseTimingToEnumId(data.purchaseTiming);
      if (eid)
        customFields.push({
          field_id: AMO_LEAD_FIELDS.PURCHASE_TIMING,
          values: [{ enum_id: eid }],
        });
    }

    // 2026-06-09 OFF: ранее тут подмешивали brokerLeadMarkerFields()
    // (UTM/tracking/calltouch/mango маркеры «Заявка от брокера»). amoCRM
    // возвращает 400 на любую попытку поставить эти поля через API
    // (поля type=text/url но связаны с системными tracking-интеграциями;
    // их пишут только сами трекеры — Calltouch виджет, Yandex/Google и т.д.).
    // Из-за 400 валился ВЕСЬ PATCH и остальные кастомные поля (Тип, Бюджет,
    // От брокера, Дата заявки, Готовность) тоже не применялись.
    // Лид «Дмитрий от Ивана» (эталон) был заполнен этими маркерами не через
    // API, а через виджет на стороне amo. См. PR #94.

    // Шаг 1: создаём лид с минимумом — name, contacts, pipeline, price.
    // Salesbot/Morekit отрабатывает и пишет свои поля (Этапы продаж, Ответственный КЦ).
    // Правка 2026-05-15: разделено на 2 шага потому что Salesbot затирал наши
    // custom_fields_values при создании в одном вызове.
    //
    // Правка 2026-05-22: к лиду привязываются ДВА контакта — клиент И брокер.
    // Без брокера в `contacts` непонятно «от кого пришла заявка» (на скриншоте
    // КБ3 в лиде виден второй контакт «Малыгина Елена Александровна» — агент).
    const leadContacts: Array<{ id: number }> = [
      { id: contact.id },
      ...brokerAmoContactIds.map((id) => ({ id })),
    ];

    // 2026-06-03: режим переиспользования существующего лида.
    // Когда у контакта уже есть активный лид в КЦ (Новое обращение /
    // Квалифицировали выводим на встречу) — новый брокер прикрепляется
    // к нему вторым контактом. Это «конкурирующие брокеры до акта осмотра».
    // 2026-06-10: распределение делает Морикит после webhook'а из
    // ClientFixationService. У Морикита свой график менеджеров КЦ — он
    // знает кто сейчас на смене и ставит responsible_user_id уже созданного
    // лида. Если мы здесь сами проставим — Морикит не перезапишет уже
    // занятого ответственного, и график не сработает.
    // Поэтому по умолчанию НЕ передаём responsible_user_id. env
    // AMO_DEFAULT_RESPONSIBLE_USER_ID можно задать только если Морикит
    // временно сломан и нужен аварийный fallback (например, на Юлю).
    const envFallback = process.env.AMO_DEFAULT_RESPONSIBLE_USER_ID;
    const defaultResponsibleUserId = envFallback
      ? Number(envFallback)
      : undefined;

    let resultLead: AmoLead;
    if (data.reuseLeadId) {
      const existing = await this.getLead(data.reuseLeadId);
      if (!existing) {
        // Лид не нашёлся — fallback на создание нового.
        resultLead = await this.createFixationLeadOrRecover({
          leadData: {
            name: `Фиксация: ${data.clientName} (${data.project})`,
            contacts: leadContacts.length > 0 ? leadContacts : undefined,
            pipeline_id: 7600542,
            ...(defaultResponsibleUserId
              ? { responsible_user_id: defaultResponsibleUserId }
              : {}),
            ...(data.amount && data.amount > 0 ? { price: data.amount } : {}),
          },
          clientPhone: data.clientPhone,
          brokerAmoContactId: data.brokerAmoContactId,
        });
      } else {
        // Прикрепляем нашего брокера к контактам существующего лида.
        // amo: чтобы добавить второй контакт — `contacts: [{id: A, is_main: ...}, {id: B}]`.
        if (data.brokerAmoContactId) {
          const existingContactIds = (
            (existing as any)._embedded?.contacts || []
          ).map((c: any) => c.id);
          if (!existingContactIds.includes(data.brokerAmoContactId)) {
            try {
              await this.request(`/leads/${data.reuseLeadId}/link`, {
                method: "POST",
                body: JSON.stringify([
                  {
                    to_entity_id: data.brokerAmoContactId,
                    to_entity_type: "contacts",
                  },
                ]),
              });
            } catch (e) {
              // Не валим — main path всё равно lead уже есть.
            }
          }
        }
        resultLead = existing;
      }
    } else {
      // Стандартный путь: создаём новый лид.
      const leadData: any = {
        name: `Фиксация: ${data.clientName} (${data.project})`,
        contacts: leadContacts.length > 0 ? leadContacts : undefined,
        pipeline_id: 7600542,
      };
      if (defaultResponsibleUserId)
        leadData.responsible_user_id = defaultResponsibleUserId;
      if (data.amount && data.amount > 0) leadData.price = data.amount;
      resultLead = await this.createFixationLeadOrRecover({
        leadData,
        clientPhone: data.clientPhone,
        brokerAmoContactId: data.brokerAmoContactId,
      });
    }

    // Шаг 2: PATCH с custom_fields_values — только для НОВОГО лида,
    // в reuse-режиме custom_fields_values НЕ перезаписываем (там уже могут
    // быть данные другого брокера).
    if (!data.reuseLeadId && resultLead?.id && customFields.length > 0) {
      try {
        await this.updateLead(resultLead.id, {
          custom_fields_values: customFields,
        } as any);
      } catch (e) {
        // Не валим всю операцию если PATCH упал — лид создан, контакт связан.
      }
    }

    // Шаг 2b: UTM/tracking-маркеры «Заявка от брокера» — ОТДЕЛЬНЫМ PATCH'ем.
    // Раньше включали в общий PATCH, но amoCRM возвращал 400 на эти поля
    // (они системные, привязаны к трекерам Calltouch/Yandex/Mango) и из-за
    // этого ВСЕ кастом-поля терялись (PR #94 их вырубил полностью).
    // 2026-06-11: возвращаем, но изолированно — если 400, основной PATCH
    // уже прошёл, мы только маркеры не записали. Если bulk прошёл — отлично,
    // utm-вкладка в лиде заполнена как у эталонного «Дмитрий от Ивана» 32205511.
    if (!data.reuseLeadId && resultLead?.id) {
      const markerFields = brokerLeadMarkerFields();
      try {
        await this.updateLead(resultLead.id, {
          custom_fields_values: markerFields,
        } as any);
        console.log(
          `[createFixationRequest] utm-маркеры записаны на лид ${resultLead.id}`,
        );
      } catch (e: any) {
        console.warn(
          `[createFixationRequest] utm-маркеры bulk-PATCH упал на лиде ${resultLead.id}: ${e?.message || e}. Пробую по одному...`,
        );
        // Fallback: PATCH каждое поле отдельно, чтобы изолировать «битые»
        // поля. amoCRM может блокировать одно конкретное (напр. CallTouch),
        // но остальные пройдут.
        let ok = 0;
        let failed = 0;
        for (const f of markerFields) {
          try {
            await this.updateLead(resultLead.id, {
              custom_fields_values: [f],
            } as any);
            ok++;
          } catch {
            failed++;
          }
        }
        console.log(
          `[createFixationRequest] utm-маркеры fallback: ok=${ok} failed=${failed}`,
        );
      }
    }

    // 2026-06-03: возвращаем ДЛИННУЮ ноту с полным дублированием заявки
    // из кабинета (пользователь явно попросил — «не забывай дублировать
    // заявку из кабинета брокера в поле СРМ как ранее на скрине»).
    // Менеджер КЦ должен видеть ВСЕ детали в ленте лида, не открывая
    // наш кабинет отдельно.
    if (resultLead?.id) {
      const projectName =
        (
          { ZORGE9: "Зорге 9", SILVER_BOR: "Берзарина 37" } as Record<
            string,
            string
          >
        )[String(data.project)] || String(data.project);
      const lines: string[] = [];
      if (data.reuseLeadId) {
        lines.push(`🟢 Аукция уникальности — новый брокер на этом клиенте`);
      } else if (data.previousLeadId) {
        lines.push(
          `🔁 Повторная фиксация — клиент возвращается после закрытой сделки`,
        );
        lines.push(
          `Предыдущий лид: #${data.previousLeadId}${data.previousLeadInfo ? ` (${data.previousLeadInfo})` : ""}`,
        );
      } else {
        lines.push(`📝 Фиксация клиента от брокера`);
      }
      lines.push(`Клиент: ${data.clientName}`);
      lines.push(`Телефон: ${data.clientPhone}`);
      if (data.clientEmail) lines.push(`Email: ${data.clientEmail}`);
      if (data.clientRegion) lines.push(`Регион: ${data.clientRegion}`);
      lines.push(``);
      lines.push(`Проект: ${projectName}`);
      if (data.propertyType) lines.push(`Тип: ${data.propertyType}`);
      if (data.roomsCount) lines.push(`Комнат: ${data.roomsCount}`);
      if (data.sqm) lines.push(`Метраж: ${data.sqm} м²`);
      if (data.amount)
        lines.push(`Бюджет: ${data.amount.toLocaleString("ru-RU")} ₽`);
      if (data.purchaseTiming)
        lines.push(`Планирует покупку: ${data.purchaseTiming}`);
      if (data.readinessLevel)
        lines.push(`Готовность к сделке: ${data.readinessLevel}`);
      lines.push(``);
      lines.push(`Брокер-агент: ${data.brokerPhone}`);
      lines.push(`Агентство: ${data.agencyName} (ИНН ${data.agencyInn})`);
      if (data.comment) {
        lines.push(``);
        lines.push(`Комментарий брокера: ${data.comment}`);
      }
      try {
        await this.addNoteToLead(resultLead.id, lines.join("\n"));
      } catch (e) {
        // Не валим — note вторичен, главное лид с полями.
      }
      // 2026-06-10: задачу «Связаться по сделке брокера» создаёт Морикит
      // после распределения менеджера КЦ (это его прямая функция).
      // Раньше мы создавали свою задачу без responsibleUserId — она
      // валилась на автора OAuth-токена (админа). Удалено.
    }

    return resultLead;
  }

  // 2026-05-26: создаёт лид нового брокера в pipeline 10787390 (БРОКЕРЫ).
  // Используется когда брокер оставил заявку на брокер-тур / форму с лендинга.
  // Создаёт контакт с IS_BROKER=true и лид с задачей КЦ.
  async createBrokerLeadFromLanding(data: {
    brokerName: string;
    brokerPhone: string;
    brokerEmail?: string | null;
    source: string; // 'LANDING_BROKER_TOUR' | 'LANDING_FORM' | 'FIXATION_BY_OTHER_BROKER'
    note?: string | null;
    // Contact provisioning is owned by the API's shared advisory-lock flows.
    // This lead helper must only consume an already resolved contact id and
    // must never run its own unlocked find -> POST fallback.
    existingContactId: number;
    // 2026-07-01: кастомное название лида. Если не передано — используется
    // старое «Заявка с лендинга — X» для обратной совместимости.
    leadName?: string;
  }): Promise<{ contactId?: number; leadId?: number } | null> {
    if (
      !Number.isSafeInteger(data.existingContactId) ||
      data.existingContactId <= 0
    ) {
      throw new Error("AMO_BROKER_CONTACT_ID_REQUIRED");
    }
    const contact: { id: number } = { id: data.existingContactId };
    try {
      // 2026-06-17: ответственный — менеджер брокеров (Ксения). Раньше lead
      // и task создавались без responsible_user_id → попадали на тех.админа,
      // КЦ-менеджер их в своих фильтрах НЕ видел. Берём из env: сначала
      // AMO_BROKER_MEETINGS_MANAGER_ID (Ксения, уже настроена), иначе
      // AMO_DEFAULT_RESPONSIBLE_USER_ID. Если оба пусты — оставляем как было.
      const brokerMgrEnv =
        process.env.AMO_BROKER_MEETINGS_MANAGER_ID ||
        process.env.AMO_DEFAULT_RESPONSIBLE_USER_ID;
      const parsedResponsible = brokerMgrEnv ? Number(brokerMgrEnv) : NaN;
      const responsibleUserId =
        Number.isFinite(parsedResponsible) && parsedResponsible > 0
          ? parsedResponsible
          : undefined;
      if (!responsibleUserId) {
        console.error(
          "[createBrokerLeadFromLanding] AMO_BROKER_MEETINGS_MANAGER_ID is empty — amo will assign the OAuth token owner (Admin)",
        );
      }

      const fromCabinet = data.source === "FIXATION_BY_OTHER_BROKER";
      const fromTour = data.source === "LANDING_BROKER_TOUR";
      const headline = fromCabinet
        ? "Заявка из кабинета брокера"
        : "Заявка с лендинга";
      const origin = fromCabinet
        ? "Координатор / брокер завёл нового брокера"
        : fromTour
          ? "Запись на брокер-тур"
          : "Форма «Связаться с нами»";
      const taskSuffix = fromCabinet
        ? "заявка из кабинета брокера"
        : "заявка с лендинга";

      // 2) Лид в пайплайне брокеров
      const lead = await this.createLead({
        name: data.leadName || `${headline} — ${data.brokerName}`,
        pipeline_id: 10787390, // BROKERS
        status_id: AMO_BROKER_STAGE.NEW,
        contacts: contact?.id ? [{ id: contact.id }] : undefined,
        ...(responsibleUserId
          ? { responsible_user_id: responsibleUserId }
          : {}),
      });

      // 3) Примечание и задача
      if (lead?.id) {
        const noteText = [
          `📥 ${headline}`,
          `Источник: ${origin}`,
          `Имя: ${data.brokerName}`,
          `Телефон: ${data.brokerPhone}`,
          ...(data.brokerEmail ? [`Email: ${data.brokerEmail}`] : []),
          ...(data.note ? [``, `Сообщение: ${data.note}`] : []),
        ].join("\n");
        try {
          await this.addNoteToLead(lead.id, noteText);
        } catch {}
        try {
          await this.createTask({
            text: `Связаться с новым брокером ${data.brokerName} (${data.brokerPhone}) — ${taskSuffix}`,
            entityType: "leads",
            entityId: lead.id,
            taskTypeId: 1, // звонок
            completeTillSec: Math.floor(Date.now() / 1000) + 4 * 60 * 60, // 4 часа — новый лид срочно
            responsibleUserId,
          });
        } catch (e: any) {
          console.error(
            "[createBrokerLeadFromLanding] task failed:",
            e?.message || e,
          );
        }
      }

      return { contactId: contact?.id, leadId: lead?.id };
    } catch (e: any) {
      console.error("[createBrokerLeadFromLanding] failed:", e?.message || e);
      return contact?.id ? { contactId: contact.id } : null;
    }
  }

  // 2026-05-26: добавляет примечание о попытке повторной фиксации в
  // существующий amoCRM-лид. Используется когда другой брокер пробует
  // зафиксировать клиента который уже на уникальности.
  async addRefixationAttemptNote(
    leadId: number,
    data: {
      requestingBrokerName: string;
      requestingBrokerPhone: string;
      clientPhone: string;
    },
  ): Promise<void> {
    const text = [
      `⚠ Попытка повторной фиксации`,
      ``,
      `Клиент ${data.clientPhone} уже на уникальности.`,
      `Брокер ${data.requestingBrokerName} (${data.requestingBrokerPhone}) пытался зафиксировать этого клиента сейчас.`,
      ``,
      `Менеджер уведомлён, заявка переведена в статус UNDER_REVIEW в нашей системе.`,
    ].join("\n");
    // Note для истории + задача чтобы сотрудник КЦ её разобрал
    await this.addNoteToLead(leadId, text);
    try {
      // 2026-06-10: задачу ставим на ответственного лида (Морикит уже
      // распределил его на менеджера КЦ). Без responsibleUserId amo
      // ставит автора OAuth-токена = админа.
      let responsibleUserId: number | undefined;
      try {
        const lead = await this.getLead(leadId);
        responsibleUserId = (lead as any)?.responsible_user_id;
      } catch {
        // если getLead упал — оставим без ответственного, amo поставит автора токена
      }
      await this.createTask({
        text: `⚠ Разрешить конфликт: ${data.requestingBrokerName} (${data.requestingBrokerPhone}) пытался повторно зафиксировать клиента ${data.clientPhone}. Уточнить кому отдать.`,
        entityType: "leads",
        entityId: leadId,
        taskTypeId: 1,
        completeTillSec: Math.floor(Date.now() / 1000) + 4 * 60 * 60, // 4 часа — конфликты разруливаем быстро
        responsibleUserId,
      });
    } catch (e) {
      // note уже создан — главное чтобы менеджер увидел
    }
  }
}
