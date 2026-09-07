/**
 * Morekit (https://morekit.io) — лидов-distribution endpoint.
 *
 * Раньше payload в Morekit формировал Salesbot-плагин внутри amoCRM
 * (по триггеру в КЦ-pipeline 7600542). По договорённости 2026-06-04
 * с Анной из Morekit'а — переходим на прямой POST из нашего API
 * с теми же полями, что и Salesbot. URL приходит в env, чтобы менять
 * без релиза (Анна время от времени даёт новый — у них процесс «копия»).
 *
 * Шлём fire-and-forget: response от Morekit не нужен на месте,
 * распределение оператора КЦ происходит уже на их стороне (они зайдут
 * в amoCRM и проставят responsible_user_id).
 */

const MOREKIT_URL = process.env.MOREKIT_WEBHOOK_URL || '';
const MOREKIT_TIMEOUT_MS = 7000;

export interface MorekitClientPayload {
  name: string;
  phone: string;
}

export interface MorekitFixationPayload {
  /** amoCRM lead id (как строка — Morekit ждёт string). */
  id: string;
  /** Название агентства. */
  agency: string;
  /** amoCRM contact id брокера-агента, как строка. */
  broker_id: string;
  agent_name: string;
  /** Голые цифры (79261433414), без `+`. */
  agent_phone: string;
  agent_mail: string;
  /** Бюджет, как строка. */
  budget: string;
  clients: MorekitClientPayload[];
  /** Тип недвижимости — например «Квартира». */
  type: string;
  /** PHP-style serialized DateTime. */
  lead_date: {
    date: string;       // YYYY-MM-DD HH:mm:ss.uuuuuu
    timezone_type: string; // "3" (PHP стиль, всегда строка)
    timezone: string;   // "UTC"
  };
  /** Название проекта в нотации Morekit'а («Квартал Серебряный Бор»). */
  project: string;
}

const MOREKIT_PROJECT_NAMES: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Квартал Серебряный Бор',
};

/** Преобразовать наш ProjectCode в строку для Morekit. */
export function morekitProjectName(project: string): string {
  return MOREKIT_PROJECT_NAMES[project] || project;
}

/** Телефон в формат Morekit'а: только цифры, 11 знаков, ведущая 7. */
export function morekitPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d;
}

/** PHP-style serialized DateTime для поля lead_date. */
export function morekitLeadDate(d: Date = new Date()): MorekitFixationPayload['lead_date'] {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    pad(d.getUTCMilliseconds() * 1000, 6);
  return { date, timezone_type: '3', timezone: 'UTC' };
}

export class MorekitAdapter {
  /**
   * Отправить fixation в Morekit. Логирует ошибку, не бросает —
   * сбой Morekit'а не должен валить фиксацию у брокера.
   *
   * URL берётся (приоритет ↓): аргумент `urlOverride` (например из
   * БД-настроек админки) → env MOREKIT_WEBHOOK_URL. Если оба пусты — skip.
   */
  async notifyFixation(
    payload: MorekitFixationPayload,
    urlOverride?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const url = (urlOverride && urlOverride.trim()) || MOREKIT_URL;
    if (!url) {
      console.warn('[morekit] URL не задан (ни в БД, ни в env), skip notify');
      return { ok: false, error: 'URL_NOT_CONFIGURED' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MOREKIT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'st-michael-broker-platform/1.0' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        const err = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        console.error('[morekit] notifyFixation failed:', err);
        return { ok: false, error: err };
      }
      console.log(`[morekit] notifyFixation ok (lead ${payload.id}, broker ${payload.broker_id})`);
      return { ok: true };
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 300);
      console.error('[morekit] notifyFixation exception:', err);
      return { ok: false, error: err };
    } finally {
      clearTimeout(timer);
    }
  }
}
