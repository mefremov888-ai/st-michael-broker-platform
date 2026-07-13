import { Project } from '@st-michael/shared';
import {
  AMO_LEAD_FIELDS, AMO_LEAD_ENUMS, AMO_CONTACT_FIELDS,
  readinessLevelToEnumId, purchaseTimingToEnumId,
  evaluateUniqueness, brokerLeadMarkerFields,
} from './amo-crm.fields';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// "+79039606053" / "8 (903) 960-60-53" / "+7-903-960-60-53" → "9039606053".
// amoCRM ?query=<substring> капризно реагирует на формат: поиск по «+79039606053»
// не находит контакт сохранённый как «8 (903) 960-60-53», поэтому ищем по
// 10 цифрам и постфильтруем по custom_fields_values.PHONE.
const last10Digits = (phone: any): string =>
  String(phone || '').replace(/\D/g, '').slice(-10);

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
  contacts?: { id: number }[];
  companies?: { id: number }[];
  custom_fields_values?: any[];
}

export interface UpdateLeadDto {
  name?: string;
  price?: number;
  status_id?: number;
  responsible_user_id?: number;
  custom_fields_values?: any[];
}

// 2026-06-05: модульный shared-state для access/refresh токенов amoCRM.
// Все экземпляры AmoCrmAdapter читают из этого state-а, refresh обновляет
// его + дёргает hook (для персистенса в БД). На старте API bootstrap
// загружает токены из SystemSetting → setAmoTokens(), и регистрирует
// hook → setAmoTokenRefreshHook(). Если в БД пусто — fallback на env.
type AmoTokens = { access: string; refresh: string };
type AmoTokenRefreshHook = (tokens: AmoTokens) => Promise<void> | void;

let amoTokens: AmoTokens = {
  access: process.env.AMO_ACCESS_TOKEN || '',
  refresh: process.env.AMO_REFRESH_TOKEN || '',
};
let amoTokenRefreshHook: AmoTokenRefreshHook | null = null;
let amoRefreshInFlight: Promise<boolean> | null = null; // дедуп параллельных refresh

export function setAmoTokens(access: string, refresh: string): void {
  amoTokens = { access: access || '', refresh: refresh || '' };
}

export function getAmoTokens(): AmoTokens {
  return { ...amoTokens };
}

export function setAmoTokenRefreshHook(hook: AmoTokenRefreshHook | null): void {
  amoTokenRefreshHook = hook;
}

export class AmoCrmAdapter {
  private baseUrl: string;

  constructor() {
    // 2026-05-27: amoCRM имеет 2 endpoint'а:
    //   1) subdomain.amocrm.ru — веб-интерфейс, защищён WAF
    //   2) api-b.amocrm.ru или другой шард — для API (читается из JWT.api_domain)
    // Раньше били в (1), nginx-WAF возвращал 403 для node-fetch-запросов.
    // Теперь по умолчанию используем (2) если AMO_API_DOMAIN не задан явно.
    const subdomain = process.env.AMO_SUBDOMAIN || 'stmichael';
    const domain = process.env.AMO_BASE_DOMAIN || 'amocrm.ru';
    const apiDomain = process.env.AMO_API_DOMAIN || `${subdomain}.${domain}`;
    this.baseUrl = `https://${apiDomain}/api/v4`;
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
        console.error('[amo-refresh] AMO_REFRESH_TOKEN не задан — refresh невозможен');
        return false;
      }
      const clientId = process.env.AMO_CLIENT_ID;
      const clientSecret = process.env.AMO_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        console.error('[amo-refresh] AMO_CLIENT_ID / AMO_CLIENT_SECRET не заданы');
        return false;
      }
      const redirectUri = process.env.AMO_REDIRECT_URI || 'https://broker.stmichael.ru/';
      const subdomain = process.env.AMO_SUBDOMAIN || 'stmichael';
      const url = `https://${subdomain}.amocrm.ru/oauth2/access_token`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refresh,
            redirect_uri: redirectUri,
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.error(`[amo-refresh] failed: HTTP ${res.status} ${text.slice(0, 300)}`);
          return false;
        }
        const data: any = await res.json();
        const newAccess = String(data?.access_token || '');
        const newRefresh = String(data?.refresh_token || '') || refresh;
        if (!newAccess) {
          console.error('[amo-refresh] response missing access_token');
          return false;
        }
        amoTokens = { access: newAccess, refresh: newRefresh };
        if (amoTokenRefreshHook) {
          try {
            await amoTokenRefreshHook(amoTokens);
          } catch (e: any) {
            console.error('[amo-refresh] persist hook failed:', e?.message || e);
          }
        }
        console.log('[amo-refresh] OK, access_token обновлён');
        return true;
      } catch (e: any) {
        console.error('[amo-refresh] exception:', e?.message || e);
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
  private async request<T = any>(path: string, init: RequestInit = {}, attempt = 1, didRefresh = false): Promise<T> {
    if (!this.token) {
      if (!didRefresh && amoTokens.refresh) {
        const ok = await this.refreshAccessToken();
        if (ok) return this.request<T>(path, init, attempt, true);
      }
      throw new Error('AMO_ACCESS_TOKEN not configured');
    }

    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          // 2026-05-27: «человеческий» User-Agent + Accept — без них
          // WAF возвращает 403. С браузерным UA проходит.
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (e: any) {
      // Network-level (timeout, ECONNRESET) — ретраим до 3 раз.
      if (attempt < 3) {
        await sleep(500 * attempt);
        return this.request<T>(path, init, attempt + 1, didRefresh);
      }
      throw e;
    }

    if (res.status === 204) return null as T;

    // 2026-06-05: 401 → попытка refresh + одиночный retry. Если refresh уже
    // делали в этом цепочке — не повторяем, бросаем.
    if (res.status === 401 && !didRefresh) {
      console.warn(`[amo] 401 на ${path}, пробуем refresh access_token`);
      const ok = await this.refreshAccessToken();
      if (ok) return this.request<T>(path, init, attempt, true);
    }

    // 429 (rate-limit) и 5xx — retry. Уважаем Retry-After если пришёл.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get('Retry-After')) || 0;
      const wait = retryAfter > 0 ? retryAfter * 1000 : 300 * Math.pow(2, attempt); // 300 / 600 / 1200ms
      await sleep(wait);
      return this.request<T>(path, init, attempt + 1, didRefresh);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`amoCRM ${res.status} ${path}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  // === Account info ===
  async getAccount(): Promise<any> {
    return this.request('/account');
  }

  // === Contacts ===
  async findContactByPhone(phone: string): Promise<AmoContact | null> {
    // Bug fix 2026-06-02: раньше брали `contacts[0]` без постфильтрации —
    // amoCRM ?query= ищет по подстроке и возвращает совпадения по имени/email/
    // комменту, а главное — не находит контакт сохранённый в другом формате
    // телефона. Из-за этого createFixationRequest лепил дубль контакта
    // в amoCRM, хотя клиент там уже был (пример: +79039606053 был в amo
    // как КЦ-контакт, новая фиксация создавала второй).
    const target = last10Digits(phone);
    if (target.length < 10) return null;
    try {
      const data = await this.request<any>(`/contacts?query=${target}&limit=50`);
      const contacts: any[] = data?._embedded?.contacts || [];
      const matches = contacts.filter((c: any) => {
        const fields = c.custom_fields_values || [];
        const phoneField = fields.find(
          (f: any) => f?.field_id === AMO_CONTACT_FIELDS.PHONE || f?.field_code === 'PHONE',
        );
        const vals = phoneField?.values || [];
        return vals.some((v: any) => last10Digits(v?.value) === target);
      });
      if (matches.length === 0) return null;
      if (matches.length === 1) return matches[0];
      // Несколько контактов с тем же номером (дубли в самой amo) — берём
      // самого свежего по updated_at, чтобы фиксация привязалась к актуальному.
      matches.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
      return matches[0];
    } catch {
      return null;
    }
  }

  async findBrokerContactByPhone(phone: string): Promise<AmoContact | null> {
    const query = encodeURIComponent(phone);
    try {
      const data = await this.request<any>(`/contacts?query=${query}&limit=50`);
      const contacts: any[] = data?._embedded?.contacts || [];
      // Filter contacts with "Брокер" checkbox = true
      const brokerCandidates = contacts.filter((c: any) => {
        const fields = c.custom_fields_values || [];
        const brokerField = fields.find((f: any) => f.field_id === 835415);
        return brokerField?.values?.[0]?.value === true;
      });
      if (brokerCandidates.length === 0) return null;
      if (brokerCandidates.length === 1) return brokerCandidates[0];

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
    } catch {
      return null;
    }
  }

  async getContact(id: number): Promise<AmoContact | null> {
    try { return await this.request<AmoContact>(`/contacts/${id}?with=leads`); }
    catch { return null; }
  }

  // КБ6 fix #44 (2026-05-25): bulk-получение контактов пачками до 250.
  // amoCRM API позволяет filter[id][]=…&filter[id][]=… (до 250 ID в одном запросе).
  // Это ~250x меньше HTTP-запросов чем перебор по одному.
  // Возвращает Map<id, AmoContact> с найденными контактами. Те, что не вернулись,
  // в map просто отсутствуют — вызывающий код решает, ошибка это или нет.
  async getContactsByIds(ids: number[]): Promise<Map<number, AmoContact>> {
    const result = new Map<number, AmoContact>();
    const BATCH = 250;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join('&');
      try {
        const data = await this.request<any>(`/contacts?${q}&with=leads&limit=${BATCH}`);
        const list: AmoContact[] = data?._embedded?.contacts || [];
        for (const c of list) result.set(Number(c.id), c);
      } catch (e: any) {
        // Pacht прошёл с ошибкой — оставляем missing, не валим всю операцию.
        console.error('[getContactsByIds] batch failed:', e?.message || e);
      }
      // Лёгкая задержка между пачками чтобы не словить 429 на больших объёмах.
      if (i + BATCH < ids.length) await sleep(150);
    }
    return result;
  }

  async createContact(data: CreateContactDto): Promise<AmoContact> {
    const result = await this.request<any>('/contacts', {
      method: 'POST',
      body: JSON.stringify([data]),
    });
    return result?._embedded?.contacts?.[0];
  }

  async updateContact(id: number, data: Partial<CreateContactDto>): Promise<void> {
    await this.request(`/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  // Добавить примечание к лиду в amoCRM. Используется для уведомления
  // менеджеров о действиях брокера (создал встречу, оператор зафиксировал
  // звонок и т.д.) — пока не настроены полноценные custom_fields.
  async addNoteToLead(leadId: number, text: string): Promise<void> {
    await this.request(`/leads/${leadId}/notes`, {
      method: 'POST',
      body: JSON.stringify([{ note_type: 'common', params: { text } }]),
    });
  }

  // 2026-05-26: задача в amoCRM с дедлайном и текстом.
  // Появляется в задачах сотрудника КЦ → отработает.
  // entityType: 'leads' | 'contacts' | 'companies'
  // taskTypeId: 1 = звонок, 2 = встреча, 3+ = кастомные (зависит от настроек amoCRM)
  // completeTill: unix timestamp в секундах (когда задача должна быть выполнена)
  async createTask(data: {
    text: string;
    entityType: 'leads' | 'contacts' | 'companies';
    entityId: number;
    completeTillSec?: number; // default: +24h
    taskTypeId?: number; // default: 1 (звонок)
    responsibleUserId?: number; // если знаем кому именно
  }): Promise<void> {
    const completeTill = data.completeTillSec || Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const body: any = {
      text: data.text,
      complete_till: completeTill,
      entity_type: data.entityType,
      entity_id: data.entityId,
      task_type_id: data.taskTypeId || 1,
    };
    if (data.responsibleUserId) body.responsible_user_id = data.responsibleUserId;
    await this.request('/tasks', {
      method: 'POST',
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
  ): Promise<Array<{ id: number; text: string; completeTill: number; durationSec: number }>> {
    if (!responsibleUserId) return [];
    try {
      const params = [
        `filter[responsible_user_id]=${responsibleUserId}`,
        `filter[is_completed]=0`,
        `filter[complete_till][from]=${fromSec}`,
        `filter[complete_till][to]=${toSec}`,
        `limit=250`,
      ].join('&');
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
      console.error('[getOpenTasksForUser] failed:', e?.message || e);
      return [];
    }
  }

  // 2026-06-10: список задач по entity (лиду / контакту). Используется
  // для диагностики «кто ответственный за задачу» — чтобы убедиться
  // что Морикит / наш код проставляет правильного человека.
  async getTasksByEntity(entityType: 'leads' | 'contacts', entityId: number): Promise<Array<{
    id: number;
    text: string;
    task_type_id: number;
    responsible_user_id: number;
    is_completed: boolean;
    complete_till: number;
    created_at: number;
  }>> {
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
      console.error('[getTasksByEntity] failed:', e?.message || e);
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
      console.warn(`[sync-lead-responsible] lead=${leadId} initial getLead failed:`, e?.message || e);
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (intervalMs > 0) await sleep(intervalMs);
      try {
        const tasks = await this.getTasksByEntity('leads', leadId);
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
        if (initialResponsible !== undefined && currentResponsible !== initialResponsible) {
          console.log(
            `[sync-lead-responsible] lead=${leadId} skip — responsible изменился вручную (${initialResponsible} → ${currentResponsible}), не перетираем`,
          );
          return false;
        }
        await this.updateLead(leadId, { responsible_user_id: latest.responsible_user_id });
        console.log(
          `[sync-lead-responsible] lead=${leadId} updated: ${currentResponsible} → ${latest.responsible_user_id} (task ${latest.id}, attempt ${attempt})`,
        );
        return true;
      } catch (e: any) {
        console.error(`[sync-lead-responsible] attempt ${attempt} failed:`, e?.message || e);
      }
    }
    console.warn(
      `[sync-lead-responsible] lead=${leadId}: задачу с responsible не нашли за ${(maxAttempts * intervalMs) / 1000}с — Морикит залип?`,
    );
    return false;
  }

  async addNoteToContact(contactId: number, text: string): Promise<void> {
    await this.request(`/contacts/${contactId}/notes`, {
      method: 'POST',
      body: JSON.stringify([{ note_type: 'common', params: { text } }]),
    });
  }

  // === Companies ===
  async findCompanyByInn(inn: string): Promise<AmoCompany | null> {
    try {
      const data = await this.request<any>(`/companies?query=${encodeURIComponent(inn)}`);
      const companies = data?._embedded?.companies || [];
      return companies[0] || null;
    } catch {
      return null;
    }
  }

  async createCompany(data: CreateCompanyDto): Promise<AmoCompany> {
    const result = await this.request<any>('/companies', {
      method: 'POST',
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
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    } catch (e) {
      return null;
    }
  }

  async linkContactToCompany(contactId: number, companyId: number): Promise<void> {
    await this.request(`/contacts/${contactId}/link`, {
      method: 'POST',
      body: JSON.stringify([{ to_entity_id: companyId, to_entity_type: 'companies' }]),
    });
  }

  // === Leads (deals) ===
  async getLead(id: number): Promise<AmoLead | null> {
    try { return await this.request<AmoLead>(`/leads/${id}?with=contacts,companies`); }
    catch { return null; }
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
    const result = await this.request<any>('/leads', {
      method: 'POST',
      body: JSON.stringify([payload]),
    });
    return result?._embedded?.leads?.[0];
  }

  async updateLead(id: number, data: UpdateLeadDto): Promise<void> {
    await this.request(`/leads/${id}`, {
      method: 'PATCH',
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
      method: 'POST',
      body: JSON.stringify([
        {
          to_entity_id: contactId,
          to_entity_type: 'contacts',
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
    rule: import('./amo-crm.fields').FixationRule;
    verdict: 'UNIQUE' | 'ALARM'; // @deprecated: для совместимости со старым кодом
    reason: string;
    contactId?: number;
    leads?: Array<{ id: number; pipeline_id: number; status_id: number }>;
    triggerType?: 'DEFERRED_DEMAND' | 'NEW_REQUEST_NO_BROKER' | 'ACTIVE_SALES';
    triggerLeadId?: number;
  }> {
    const contact = await this.findContactByPhone(phone);
    if (!contact) {
      return {
        rule: 'NO_CONFLICT',
        verdict: 'UNIQUE',
        reason: 'Контакт в amoCRM не найден',
      };
    }
    const leads = await this.getLeadsByContact(contact.id);
    if (leads.length === 0) {
      return {
        rule: 'NO_CONFLICT',
        verdict: 'UNIQUE',
        reason: 'У контакта нет лидов в amoCRM',
        contactId: contact.id,
        leads: [],
      };
    }
    // Собрать все contactId из всех лидов одним батчем — экономим запросы.
    const allContactIds = new Set<number>();
    for (const lead of leads) {
      const contactIds = ((lead as any)._embedded?.contacts || []).map((c: any) => c.id);
      contactIds.forEach((id: number) => allContactIds.add(id));
    }
    const contactsMap = await this.getContactsByIds(Array.from(allContactIds));

    const isBroker = (c: any): boolean => {
      const fields = c?.custom_fields_values || [];
      const brokerField = fields.find((f: any) => f?.field_id === AMO_CONTACT_FIELDS.IS_BROKER);
      return brokerField?.values?.[0]?.value === true;
    };

    const leadsForEval = leads.map((lead: any) => {
      const contactIds = (lead._embedded?.contacts || []).map((c: any) => c.id);
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
    try {
      const contact = await this.request<any>(`/contacts/${contactId}?with=leads`);
      const leadIds = (contact?._embedded?.leads || []).map((l: any) => l.id);
      if (leadIds.length === 0) return [];
      // 2026-06-03: with=contacts чтобы для проверки уникальности можно было
      // понять, привязан ли к лиду «брокер» (контакт с IS_BROKER=true).
      const data = await this.request<any>(
        `/leads?filter[id][]=${leadIds.join('&filter[id][]=')}&with=contacts`,
      );
      return data?._embedded?.leads || [];
    } catch {
      return [];
    }
  }

  async getLeadsByPipeline(pipelineId: number, limit = 250): Promise<AmoLead[]> {
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

  async getLeadsByResponsibleUser(userId: number, limit = 250): Promise<AmoLead[]> {
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

  async reopenLead(id: number, newBrokerAmoId: number): Promise<AmoLead> {
    await this.updateLead(id, { status_id: 142 } as any);
    return (await this.getLead(id))!;
  }

  async getLeadStage(leadId: number): Promise<string> {
    const lead = await this.getLead(leadId);
    return lead?.status_id ? String(lead.status_id) : '';
  }

  // === Pipelines ===
  async getPipelines(): Promise<any[]> {
    const data = await this.request<any>('/leads/pipelines');
    return data?._embedded?.pipelines || [];
  }

  // === Custom fields ===
  async getContactCustomFields(): Promise<any[]> {
    const data = await this.request<any>('/contacts/custom_fields');
    return data?._embedded?.custom_fields || [];
  }

  async getCompanyCustomFields(): Promise<any[]> {
    const data = await this.request<any>('/companies/custom_fields');
    return data?._embedded?.custom_fields || [];
  }

  // === Users ===
  async getUsers(): Promise<any[]> {
    const data = await this.request<any>('/users');
    return data?._embedded?.users || [];
  }

  async findUserByPhone(phone: string): Promise<any | null> {
    const users = await this.getUsers();
    const cleanPhone = phone.replace(/\D/g, '');
    return users.find((u: any) => {
      const userPhone = String(u.phone || '').replace(/\D/g, '');
      return userPhone && userPhone.endsWith(cleanPhone.slice(-10));
    }) || null;
  }

  // === Fixation request (create lead with broker info) ===
  async createFixationRequest(data: {
    clientPhone: string;
    clientEmail?: string;        // правка 2026-05-15: записывается на контакт
    clientName: string;
    clientRegion?: string;       // правка 2026-05-22: регион клиента (REGION=589265)
    presentationSent?: boolean;  // правка 2026-05-22: «Отправлена презентация» на контакт клиента
    brokerPhone: string;
    brokerAmoContactId?: number; // правка 2026-05-22: привязка брокера-агента как 2-го контакта лида
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
    purchaseTiming?: string;     // «Планирует покупку»: от 1 до 3 месяцев, 3-6, и т.д.
    readinessLevel?: string;     // «Готовность к сделке»: Холодный/Тёплый/Горячий
    fromBroker?: boolean;        // «От брокера» radio (по умолчанию true для fixation request)
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
    // Контакт КЛИЕНТА — формируем custom_fields_values, отдельно от создания
    const clientCustomFields: any[] = [
      { field_code: 'PHONE', values: [{ value: data.clientPhone, enum_code: 'WORK' }] },
    ];
    if (data.clientEmail) {
      clientCustomFields.push({ field_code: 'EMAIL', values: [{ value: data.clientEmail, enum_code: 'WORK' }] });
    }
    if (data.clientRegion) {
      clientCustomFields.push({ field_id: 589265, values: [{ value: data.clientRegion }] });
    }
    if (data.presentationSent) {
      clientCustomFields.push({ field_id: 835955, values: [{ value: true }] });
    }

    let contact = await this.findContactByPhone(data.clientPhone);
    if (!contact) {
      contact = await this.createContact({
        name: data.clientName,
        custom_fields_values: clientCustomFields,
      });
    } else {
      // Контакт существует — обновим переданные поля (email/region/presentation).
      // Без try/catch: если amo вернёт ошибку, мы не валим всю операцию.
      try {
        await this.updateContact(contact.id, { custom_fields_values: clientCustomFields } as any);
      } catch {}
    }

    // Заполняем custom_fields на лиде (правка 2026-05-14):
    //   587387 — "Тип объекта"
    //   583447 — "Сколько комнат рассматривает"
    //   833045 — "Стоимость без скидок, руб" (= бюджет покупки)
    //   604555 — "Метраж, м2"
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
      'квартира': 1025397,
      'апартаменты': 859233,
      'апартамент': 859233,
      'коммерческая': 889061,
      'коммерческое помещение': 889061,
      'кладовая': 981093,
      'паркинг': 859235,
      'машиноместо': 859235,
    };
    if (data.propertyType) {
      const enumId = propertyTypeEnums[String(data.propertyType).toLowerCase().trim()];
      if (enumId) customFields.push({ field_id: 587387, values: [{ enum_id: enumId }] });
    }
    const roomsCountEnums: Record<string, number> = {
      // ID получены через GET /leads/custom_fields/583447 (multiselect).
      '1': 852923, '1к': 852923, 'однушка': 852923,
      '2': 852925, '2к': 852925, 'двушка': 852925,
      '3': 852927, '3к': 852927, 'трёшка': 852927, 'трешка': 852927,
      'студия': 889059,
    };
    if (data.roomsCount) {
      const enumId = roomsCountEnums[String(data.roomsCount).toLowerCase().trim()];
      if (enumId) customFields.push({ field_id: 583447, values: [{ enum_id: enumId }] });
    }
    if (data.amount && data.amount > 0) customFields.push({ field_id: 833045, values: [{ value: String(data.amount) }] });
    if (data.sqm && data.sqm > 0) customFields.push({ field_id: 604555, values: [{ value: String(data.sqm) }] });
    // Правка 2026-05-15: добавляем поля левого сайдбара лида автоматом.
    // 583155 «Цель покупки» — по умолчанию «Себе» (большинство случаев).
    // 839179 «Объект интереса» — из выбранного проекта.
    customFields.push({ field_id: 583155, values: [{ value: 'Себе' }] });
    const objectByProject: Record<string, string> = {
      ZORGE9: 'Зорге 9',
      SILVER_BOR: 'Берзарина 37',
    };
    const projectObj = objectByProject[String(data.project)] || 'Зорге 9';
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
      if (eid) customFields.push({ field_id: AMO_LEAD_FIELDS.READINESS_LEVEL, values: [{ enum_id: eid }] });
    }
    // — Планирует покупку в срок (select)
    if (data.purchaseTiming) {
      const eid = purchaseTimingToEnumId(data.purchaseTiming);
      if (eid) customFields.push({ field_id: AMO_LEAD_FIELDS.PURCHASE_TIMING, values: [{ enum_id: eid }] });
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
    const leadContacts: Array<{ id: number }> = [];
    if (contact?.id) leadContacts.push({ id: contact.id });
    if (data.brokerAmoContactId) leadContacts.push({ id: data.brokerAmoContactId });

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
    const defaultResponsibleUserId = envFallback ? Number(envFallback) : undefined;

    let resultLead: AmoLead;
    if (data.reuseLeadId) {
      const existing = await this.getLead(data.reuseLeadId);
      if (!existing) {
        // Лид не нашёлся — fallback на создание нового.
        resultLead = await this.createLead({
          name: `Фиксация: ${data.clientName} (${data.project})`,
          contacts: leadContacts.length > 0 ? leadContacts : undefined,
          pipeline_id: 7600542,
          ...(defaultResponsibleUserId ? { responsible_user_id: defaultResponsibleUserId } : {}),
          ...(data.amount && data.amount > 0 ? { price: data.amount } : {}),
        } as any);
      } else {
        // Прикрепляем нашего брокера к контактам существующего лида.
        // amo: чтобы добавить второй контакт — `contacts: [{id: A, is_main: ...}, {id: B}]`.
        if (data.brokerAmoContactId) {
          const existingContactIds = ((existing as any)._embedded?.contacts || []).map((c: any) => c.id);
          if (!existingContactIds.includes(data.brokerAmoContactId)) {
            try {
              await this.request(`/leads/${data.reuseLeadId}/link`, {
                method: 'POST',
                body: JSON.stringify([{
                  to_entity_id: data.brokerAmoContactId,
                  to_entity_type: 'contacts',
                }]),
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
      if (defaultResponsibleUserId) leadData.responsible_user_id = defaultResponsibleUserId;
      if (data.amount && data.amount > 0) leadData.price = data.amount;
      resultLead = await this.createLead(leadData);
    }

    // Шаг 2: PATCH с custom_fields_values — только для НОВОГО лида,
    // в reuse-режиме custom_fields_values НЕ перезаписываем (там уже могут
    // быть данные другого брокера).
    if (!data.reuseLeadId && resultLead?.id && customFields.length > 0) {
      try {
        await this.updateLead(resultLead.id, { custom_fields_values: customFields } as any);
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
        await this.updateLead(resultLead.id, { custom_fields_values: markerFields } as any);
        console.log(`[createFixationRequest] utm-маркеры записаны на лид ${resultLead.id}`);
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
            await this.updateLead(resultLead.id, { custom_fields_values: [f] } as any);
            ok++;
          } catch {
            failed++;
          }
        }
        console.log(`[createFixationRequest] utm-маркеры fallback: ok=${ok} failed=${failed}`);
      }
    }

    // 2026-06-03: возвращаем ДЛИННУЮ ноту с полным дублированием заявки
    // из кабинета (пользователь явно попросил — «не забывай дублировать
    // заявку из кабинета брокера в поле СРМ как ранее на скрине»).
    // Менеджер КЦ должен видеть ВСЕ детали в ленте лида, не открывая
    // наш кабинет отдельно.
    if (resultLead?.id) {
      const projectName = ({ ZORGE9: 'Зорге 9', SILVER_BOR: 'Берзарина 37' } as Record<string, string>)[String(data.project)] || String(data.project);
      const lines: string[] = [];
      if (data.reuseLeadId) {
        lines.push(`🟢 Аукция уникальности — новый брокер на этом клиенте`);
      } else if (data.previousLeadId) {
        lines.push(`🔁 Повторная фиксация — клиент возвращается после закрытой сделки`);
        lines.push(`Предыдущий лид: #${data.previousLeadId}${data.previousLeadInfo ? ` (${data.previousLeadInfo})` : ''}`);
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
      if (data.amount) lines.push(`Бюджет: ${data.amount.toLocaleString('ru-RU')} ₽`);
      if (data.purchaseTiming) lines.push(`Планирует покупку: ${data.purchaseTiming}`);
      if (data.readinessLevel) lines.push(`Готовность к сделке: ${data.readinessLevel}`);
      lines.push(``);
      lines.push(`Брокер-агент: ${data.brokerPhone}`);
      lines.push(`Агентство: ${data.agencyName} (ИНН ${data.agencyInn})`);
      if (data.comment) {
        lines.push(``);
        lines.push(`Комментарий брокера: ${data.comment}`);
      }
      try {
        await this.addNoteToLead(resultLead.id, lines.join('\n'));
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
    // 2026-07-01: если передан contactId — используем существующий контакт
    // (без дублирования). Иначе создаём новый как раньше.
    existingContactId?: number;
    // 2026-07-01: кастомное название лида. Если не передано — используется
    // старое «Заявка с лендинга — X» для обратной совместимости.
    leadName?: string;
  }): Promise<{ contactId?: number; leadId?: number } | null> {
    try {
      // 1) Контакт с IS_BROKER=true. Если передан existingContactId — не
      // создаём новый (контакт уже настроен через syncBrokerProfileToAmo).
      let contact: { id: number } | null | undefined = data.existingContactId
        ? { id: data.existingContactId }
        : null;
      if (!contact) {
        contact = await this.createContact({
          name: data.brokerName,
          custom_fields_values: [
            { field_code: 'PHONE', values: [{ value: data.brokerPhone, enum_code: 'WORK' }] },
            ...(data.brokerEmail
              ? [{ field_code: 'EMAIL' as const, values: [{ value: data.brokerEmail, enum_code: 'WORK' }] }]
              : []),
            { field_id: 835415, values: [{ value: true }] }, // IS_BROKER
          ],
        });
      }

      // 2026-06-17: ответственный — менеджер брокеров (Ксения). Раньше lead
      // и task создавались без responsible_user_id → попадали на тех.админа,
      // КЦ-менеджер их в своих фильтрах НЕ видел. Берём из env: сначала
      // AMO_BROKER_MEETINGS_MANAGER_ID (Ксения, уже настроена), иначе
      // AMO_DEFAULT_RESPONSIBLE_USER_ID. Если оба пусты — оставляем как было.
      const brokerMgrEnv = process.env.AMO_BROKER_MEETINGS_MANAGER_ID
        || process.env.AMO_DEFAULT_RESPONSIBLE_USER_ID;
      const responsibleUserId = brokerMgrEnv ? Number(brokerMgrEnv) : undefined;

      // 2) Лид в пайплайне брокеров
      const lead = await this.createLead({
        name: data.leadName || `Заявка с лендинга — ${data.brokerName}`,
        pipeline_id: 10787390, // BROKERS
        contacts: contact?.id ? [{ id: contact.id }] : undefined,
        ...(responsibleUserId ? { responsible_user_id: responsibleUserId } : {}),
      } as any);

      // 3) Примечание и задача
      if (lead?.id) {
        const noteText = [
          `📥 Заявка с лендинга`,
          `Источник: ${data.source === 'LANDING_BROKER_TOUR' ? 'Запись на брокер-тур' : 'Форма «Связаться с нами»'}`,
          `Имя: ${data.brokerName}`,
          `Телефон: ${data.brokerPhone}`,
          ...(data.brokerEmail ? [`Email: ${data.brokerEmail}`] : []),
          ...(data.note ? [``, `Сообщение: ${data.note}`] : []),
        ].join('\n');
        try { await this.addNoteToLead(lead.id, noteText); } catch {}
        try {
          await this.createTask({
            text: `Связаться с новым брокером ${data.brokerName} (${data.brokerPhone}) — заявка с лендинга`,
            entityType: 'leads',
            entityId: lead.id,
            taskTypeId: 1, // звонок
            completeTillSec: Math.floor(Date.now() / 1000) + 4 * 60 * 60, // 4 часа — новый лид срочно
            responsibleUserId,
          });
        } catch (e: any) {
          console.error('[createBrokerLeadFromLanding] task failed:', e?.message || e);
        }
      }

      return { contactId: contact?.id, leadId: lead?.id };
    } catch (e: any) {
      console.error('[createBrokerLeadFromLanding] failed:', e?.message || e);
      return null;
    }
  }

  // 2026-05-26: добавляет примечание о попытке повторной фиксации в
  // существующий amoCRM-лид. Используется когда другой брокер пробует
  // зафиксировать клиента который уже на уникальности.
  async addRefixationAttemptNote(leadId: number, data: {
    requestingBrokerName: string;
    requestingBrokerPhone: string;
    clientPhone: string;
  }): Promise<void> {
    const text = [
      `⚠ Попытка повторной фиксации`,
      ``,
      `Клиент ${data.clientPhone} уже на уникальности.`,
      `Брокер ${data.requestingBrokerName} (${data.requestingBrokerPhone}) пытался зафиксировать этого клиента сейчас.`,
      ``,
      `Менеджер уведомлён, заявка переведена в статус UNDER_REVIEW в нашей системе.`,
    ].join('\n');
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
        entityType: 'leads',
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
