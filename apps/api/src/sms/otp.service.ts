import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaClient } from "@st-michael/database";
import { createHash, randomInt, randomUUID, timingSafeEqual } from "crypto";
import { SmsService } from "./sms.service";
import { OTP_KIND_BY_PURPOSE, OtpPurpose, otpText } from "./sms-templates";

/**
 * 2026-09-24: одноразовые коды по СМС. Правила (согласованы с владельцем):
 *   - 6 цифр из криптостойкого генератора, ведущие нули сохраняем;
 *   - в базе только хеш (SHA-256 с серверным «перцем» и id записи);
 *   - срок 10 минут, одно назначение — один код, новый запрос гасит старый;
 *   - 5 попыток ввода, потом код сгорает;
 *   - выдача: не чаще раза в минуту на номер, не более 5 в час на номер,
 *     отдельно 10 в час и 30 в сутки на IP (защита от перебора и от
 *     СМС-бомбинга чужих номеров за наш счёт);
 *   - сравнение за постоянное время, один ответ «код неверный или истёк».
 */

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_PHONE_MIN_INTERVAL_MS = 60 * 1000;
export const OTP_PHONE_PER_HOUR = 5;
export const OTP_IP_PER_HOUR = 10;
export const OTP_IP_PER_DAY = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const OTP_INVALID_MESSAGE = "Код неверный или истёк. Запросите новый код.";

export function hashOtp(otpId: string, code: string, pepper = process.env.OTP_PEPPER || process.env.JWT_SECRET || ""): string {
  return createHash("sha256").update(`${pepper}:${otpId}:${code}`).digest("hex");
}

export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function tooMany(message: string, code: string, retryAfterSec?: number): HttpException {
  return new HttpException({ message, code, retryAfterSec, statusCode: HttpStatus.TOO_MANY_REQUESTS }, HttpStatus.TOO_MANY_REQUESTS);
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly sms: SmsService,
  ) {}

  async isPurposeEnabled(purpose: OtpPurpose): Promise<boolean> {
    const s = await this.sms.getSettings();
    return Boolean(s.login && s.apiKey) && this.sms.isKindEnabled(OTP_KIND_BY_PURPOSE[purpose], s);
  }

  /**
   * Выдать и отправить код. Бросает 400 (выключено / плохой номер),
   * 429 (лимиты) или 502 (СМС не ушла).
   */
  async request(input: { purpose: OtpPurpose; phone: string; ip?: string | null; brokerId?: string | null }): Promise<{ ok: true; expiresInSec: number; retryAfterSec: number }> {
    const phone = String(input.phone || "").trim();
    if (!/^\+7\d{10}$/.test(phone)) {
      throw new BadRequestException({ message: "Введите номер в формате +7XXXXXXXXXX", code: "OTP_BAD_PHONE" });
    }
    if (!(await this.isPurposeEnabled(input.purpose))) {
      throw new BadRequestException({ message: "Подтверждение по СМС сейчас недоступно.", code: "SMS_OTP_DISABLED" });
    }
    const ip = input.ip ? String(input.ip).slice(0, 64) : null;
    const now = Date.now();

    const last = await this.prisma.phoneOtp.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last) {
      const elapsed = now - last.createdAt.getTime();
      if (elapsed < OTP_PHONE_MIN_INTERVAL_MS) {
        const retryAfterSec = Math.ceil((OTP_PHONE_MIN_INTERVAL_MS - elapsed) / 1000);
        throw tooMany(`Код уже отправлен. Запросить новый можно через ${retryAfterSec} сек.`, "OTP_TOO_SOON", retryAfterSec);
      }
    }
    const perPhoneHour = await this.prisma.phoneOtp.count({ where: { phone, createdAt: { gte: new Date(now - HOUR_MS) } } });
    if (perPhoneHour >= OTP_PHONE_PER_HOUR) {
      throw tooMany("Слишком много запросов кода на этот номер. Попробуйте через час.", "OTP_PHONE_LIMIT", 3600);
    }
    if (ip) {
      const perIpHour = await this.prisma.phoneOtp.count({ where: { ip, createdAt: { gte: new Date(now - HOUR_MS) } } });
      if (perIpHour >= OTP_IP_PER_HOUR) {
        throw tooMany("Слишком много запросов кода. Попробуйте через час.", "OTP_IP_LIMIT", 3600);
      }
      const perIpDay = await this.prisma.phoneOtp.count({ where: { ip, createdAt: { gte: new Date(now - DAY_MS) } } });
      if (perIpDay >= OTP_IP_PER_DAY) {
        throw tooMany("Слишком много запросов кода. Попробуйте завтра.", "OTP_IP_LIMIT", 24 * 3600);
      }
    }

    // Новый запрос гасит прежние коды того же назначения.
    await this.prisma.phoneOtp.updateMany({
      where: { phone, purpose: input.purpose, consumedAt: null },
      data: { consumedAt: new Date(now) },
    });

    const id = randomUUID();
    const code = generateOtpCode();
    await this.prisma.phoneOtp.create({
      data: {
        id,
        phone,
        purpose: input.purpose,
        codeHash: hashOtp(id, code),
        expiresAt: new Date(now + OTP_TTL_MS),
        ip,
      },
    });

    const sent = await this.sms.send({
      kind: OTP_KIND_BY_PURPOSE[input.purpose],
      phone,
      text: otpText(input.purpose, code),
      brokerId: input.brokerId || null,
    });
    if (!sent.ok) {
      await this.prisma.phoneOtp.update({ where: { id }, data: { consumedAt: new Date(), smsMessageId: sent.messageId } });
      this.logger.warn(`${input.purpose} → ${phone.slice(0, 5)}***: СМС не отправлена (${sent.error || "?"})`);
      throw new HttpException({ message: "Не удалось отправить СМС. Попробуйте позже.", code: "SMS_SEND_FAILED" }, HttpStatus.BAD_GATEWAY);
    }
    await this.prisma.phoneOtp.update({ where: { id }, data: { smsMessageId: sent.messageId } });
    return { ok: true, expiresInSec: Math.floor(OTP_TTL_MS / 1000), retryAfterSec: Math.floor(OTP_PHONE_MIN_INTERVAL_MS / 1000) };
  }

  /** Проверить код; при успехе он гасится. Иначе — 400 с одним и тем же текстом. */
  async verify(input: { purpose: OtpPurpose; phone: string; code: string }): Promise<void> {
    const phone = String(input.phone || "").trim();
    const code = String(input.code || "").trim();
    const invalid = () => new BadRequestException({ message: OTP_INVALID_MESSAGE, code: "OTP_INVALID", field: "smsCode" });
    if (!/^\d{6}$/.test(code)) throw invalid();

    const row = await this.prisma.phoneOtp.findFirst({
      where: { phone, purpose: input.purpose, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw invalid();
    const now = new Date();
    if (row.expiresAt.getTime() < now.getTime()) {
      await this.prisma.phoneOtp.update({ where: { id: row.id }, data: { consumedAt: now } });
      throw invalid();
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await this.prisma.phoneOtp.update({ where: { id: row.id }, data: { consumedAt: now } });
      throw invalid();
    }
    const expected = Buffer.from(row.codeHash, "utf8");
    const actual = Buffer.from(hashOtp(row.id, code), "utf8");
    const match = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!match) {
      const attempts = row.attempts + 1;
      await this.prisma.phoneOtp.update({
        where: { id: row.id },
        data: { attempts, ...(attempts >= OTP_MAX_ATTEMPTS ? { consumedAt: now } : {}) },
      });
      throw invalid();
    }
    await this.prisma.phoneOtp.update({ where: { id: row.id }, data: { consumedAt: now, attempts: row.attempts + 1 } });
  }
}
