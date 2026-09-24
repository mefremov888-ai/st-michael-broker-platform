import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaClient } from "@st-michael/database";
import { SmscAdapter, isSmscDelivered, isSmscFinalStatus } from "@st-michael/integrations";
import {
  SMS_KINDS,
  SMS_MAX_CHARS,
  SmsKind,
  fixationExpiryText,
  loginCodeText,
  maskCodeInText,
  passwordResetCodeText,
  registerCodeText,
} from "./sms-templates";

/**
 * 2026-09-24: отправка СМС через СМС Центр с журналом в БД.
 *
 * Настройки — в SystemSetting (правятся из админки «Интеграции») с
 * fallback на переменные окружения:
 *   SMSC_LOGIN, SMSC_API_KEY, SMSC_SENDER — доступ к smsc.ru;
 *   SMS_ENABLED — общий выключатель (по умолчанию выключено);
 *   SMS_OTP_LOGIN, SMS_OTP_REGISTER, SMS_OTP_PASSWORD_RESET,
 *   SMS_FIXATION_EXPIRY — по видам сообщений.
 * Включаем по плану: сначала коды входа и регистрации, через неделю —
 * смену пароля и истечение закрепления.
 */

export const SMS_SETTING_KEYS = [
  "SMSC_LOGIN",
  "SMSC_API_KEY",
  "SMSC_SENDER",
  "SMS_ENABLED",
  "SMS_OTP_LOGIN",
  "SMS_OTP_REGISTER",
  "SMS_OTP_PASSWORD_RESET",
  "SMS_FIXATION_EXPIRY",
] as const;

export interface SmsSettings {
  login: string;
  apiKey: string;
  sender: string;
  enabled: boolean;
  otpLogin: boolean;
  otpRegister: boolean;
  otpPasswordReset: boolean;
  fixationExpiry: boolean;
}

export interface SmsSendInput {
  kind: SmsKind;
  phone: string;
  text: string;
  brokerId?: string | null;
}

export interface SmsSendOutcome {
  ok: boolean;
  messageId: string | null;
  providerId?: string;
  skipped?: boolean;
  error?: string;
}

export function parseFlag(value: string | null | undefined): boolean {
  const v = String(value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on" || v === "да";
}

const FLAG_BY_KIND: Record<SmsKind, keyof SmsSettings | null> = {
  LOGIN_CODE: "otpLogin",
  REGISTER_CODE: "otpRegister",
  PASSWORD_RESET_CODE: "otpPasswordReset",
  FIXATION_EXPIRY: "fixationExpiry",
  // Тестовая отправка из админки — только по явному действию администратора,
  // общий выключатель на неё не влияет (нужна до включения потоков).
  TEST: null,
};

const STATUS_RECHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
const STATUS_RECHECK_WINDOW_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(@Inject("PrismaClient") private readonly prisma: PrismaClient) {}

  async getSettings(): Promise<SmsSettings> {
    const byKey = new Map<string, string>();
    try {
      const rows = await this.prisma.systemSetting.findMany({
        where: { key: { in: [...SMS_SETTING_KEYS] } },
        select: { key: true, value: true },
      });
      for (const r of rows) if (r.value) byKey.set(r.key, r.value);
    } catch (e: any) {
      this.logger.warn(`settings read failed, env fallback: ${e?.message || e}`);
    }
    const get = (key: (typeof SMS_SETTING_KEYS)[number]) => byKey.get(key) || process.env[key] || "";
    return {
      login: get("SMSC_LOGIN").trim(),
      apiKey: get("SMSC_API_KEY").trim(),
      sender: get("SMSC_SENDER").trim(),
      enabled: parseFlag(get("SMS_ENABLED")),
      otpLogin: parseFlag(get("SMS_OTP_LOGIN")),
      otpRegister: parseFlag(get("SMS_OTP_REGISTER")),
      otpPasswordReset: parseFlag(get("SMS_OTP_PASSWORD_RESET")),
      fixationExpiry: parseFlag(get("SMS_FIXATION_EXPIRY")),
    };
  }

  isKindEnabled(kind: SmsKind, s: SmsSettings): boolean {
    const flag = FLAG_BY_KIND[kind];
    if (flag === null) return true;
    return s.enabled && Boolean(s[flag]);
  }

  /** Что включено — для публичной формы входа/регистрации (без секретов). */
  async publicOptions(): Promise<{ login: boolean; register: boolean; passwordReset: boolean }> {
    const s = await this.getSettings();
    const configured = Boolean(s.login && s.apiKey);
    return {
      login: configured && this.isKindEnabled("LOGIN_CODE", s),
      register: configured && this.isKindEnabled("REGISTER_CODE", s),
      passwordReset: configured && this.isKindEnabled("PASSWORD_RESET_CODE", s),
    };
  }

  private adapter(s: SmsSettings): SmscAdapter {
    return new SmscAdapter({ login: s.login, apiKey: s.apiKey, sender: s.sender });
  }

  /**
   * Отправить одно сообщение. В журнал пишется всегда (в том числе SKIPPED,
   * когда вид выключен) — чтобы видеть, что кабинет хотел отправить.
   */
  async send(input: SmsSendInput): Promise<SmsSendOutcome> {
    if (!SMS_KINDS.includes(input.kind)) {
      throw new Error(`Недопустимый вид СМС: ${input.kind}`);
    }
    const text = String(input.text || "").trim();
    if (!text) return { ok: false, messageId: null, error: "пустой текст" };
    if (text.length > SMS_MAX_CHARS) {
      this.logger.warn(`${input.kind}: текст ${text.length} знаков — уйдёт в несколько частей`);
    }
    const s = await this.getSettings();
    const journalText = maskCodeInText(text);
    const base = { brokerId: input.brokerId || null, phone: input.phone, kind: input.kind, text: journalText };

    if (!this.isKindEnabled(input.kind, s)) {
      const row = await this.prisma.smsMessage.create({ data: { ...base, status: "SKIPPED", error: "вид СМС выключен в настройках" } });
      return { ok: false, messageId: row.id, skipped: true, error: "disabled" };
    }
    if (!s.login || !s.apiKey) {
      const row = await this.prisma.smsMessage.create({ data: { ...base, status: "FAILED", error: "СМС Центр не настроен (логин/ключ)" } });
      return { ok: false, messageId: row.id, error: "not configured" };
    }

    const row = await this.prisma.smsMessage.create({ data: { ...base, status: "QUEUED" } });
    const res = await this.adapter(s).send(input.phone, text);
    if (res.ok) {
      await this.prisma.smsMessage.update({
        where: { id: row.id },
        data: { status: "SENT", providerId: res.id, parts: res.parts ?? null, cost: res.cost ?? null, sentAt: new Date() },
      });
      return { ok: true, messageId: row.id, providerId: res.id };
    }
    const error = `${res.errorCode ? `[${res.errorCode}] ` : ""}${res.error || "ошибка отправки"}`;
    await this.prisma.smsMessage.update({ where: { id: row.id }, data: { status: "FAILED", error } });
    this.logger.warn(`${input.kind} → ${input.phone.slice(0, 5)}***: ${error}`);
    return { ok: false, messageId: row.id, error };
  }

  /** Подтянуть статусы доставки у СМС Центра по недавним отправкам. */
  async refreshStatuses(limit = 100): Promise<{ checked: number; delivered: number; failed: number }> {
    const s = await this.getSettings();
    if (!s.login || !s.apiKey) return { checked: 0, delivered: 0, failed: 0 };
    const now = Date.now();
    const rows = await this.prisma.smsMessage.findMany({
      where: {
        status: "SENT",
        providerId: { not: null },
        createdAt: { gte: new Date(now - STATUS_RECHECK_WINDOW_MS) },
        OR: [{ statusCheckedAt: null }, { statusCheckedAt: { lt: new Date(now - STATUS_RECHECK_MIN_INTERVAL_MS) } }],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true, providerId: true, phone: true },
    });
    const adapter = this.adapter(s);
    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      const st = await adapter.getStatus(String(row.providerId), row.phone);
      const checkedAt = new Date();
      if (!st.ok || st.status === undefined) {
        await this.prisma.smsMessage.update({ where: { id: row.id }, data: { statusCheckedAt: checkedAt } });
        continue;
      }
      if (isSmscDelivered(st.status)) {
        delivered++;
        await this.prisma.smsMessage.update({
          where: { id: row.id },
          data: { status: "DELIVERED", providerStatus: st.status, deliveredAt: st.changedAt || checkedAt, statusCheckedAt: checkedAt },
        });
      } else if (isSmscFinalStatus(st.status)) {
        failed++;
        await this.prisma.smsMessage.update({
          where: { id: row.id },
          data: { status: "FAILED", providerStatus: st.status, error: st.statusText || `статус ${st.status}`, statusCheckedAt: checkedAt },
        });
      } else {
        await this.prisma.smsMessage.update({ where: { id: row.id }, data: { providerStatus: st.status, statusCheckedAt: checkedAt } });
      }
    }
    return { checked: rows.length, delivered, failed };
  }

  async getBalance(): Promise<{ ok: boolean; balance?: number; currency?: string; error?: string; configured: boolean; sender: string }> {
    const s = await this.getSettings();
    const configured = Boolean(s.login && s.apiKey);
    if (!configured) return { ok: false, configured, sender: s.sender, error: "СМС Центр не настроен (логин/ключ)" };
    const res = await this.adapter(s).getBalance();
    return { ...res, configured, sender: s.sender };
  }

  async listJournal(limit = 50) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.prisma.smsMessage.findMany({ orderBy: { createdAt: "desc" }, take });
  }

  /**
   * Тестовая отправка из админки: те же четыре текста с случайным кодом и
   * условным клиентом. В журнале — вид TEST, чтобы не путать с боевыми.
   */
  async sendTest(phone: string, sample: SmsKind, brokerId?: string | null): Promise<SmsSendOutcome> {
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    let text: string;
    switch (sample) {
      case "LOGIN_CODE":
        text = loginCodeText(code);
        break;
      case "REGISTER_CODE":
        text = registerCodeText(code);
        break;
      case "PASSWORD_RESET_CODE":
        text = passwordResetCodeText(code);
        break;
      case "FIXATION_EXPIRY":
        text = fixationExpiryText("Иванов Александр", new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
        break;
      default:
        text = "Тест кабинета брокера: связь со СМС Центром работает.";
    }
    return this.send({ kind: "TEST", phone, text, brokerId });
  }
}
