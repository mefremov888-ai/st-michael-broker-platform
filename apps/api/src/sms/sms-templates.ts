/**
 * 2026-09-24: тексты СМС, согласованные владельцем (24.09). Каждый — в одну
 * часть, до 70 знаков кириллицей (вторая часть удваивает цену). Отправитель
 * виден в шапке, поэтому «ST Michael:» внутри текста не нужен. Телефоны
 * клиентов в СМС не попадают; клиент — фамилия и инициал.
 *
 * Пока отправляем ТОЛЬКО эти четыре текста (решение владельца 24.09).
 */

export const SMS_MAX_CHARS = 70;

/** Виды СМС, которые кабинет вообще имеет право отправить. */
export const SMS_KINDS = ["LOGIN_CODE", "REGISTER_CODE", "PASSWORD_RESET_CODE", "FIXATION_EXPIRY", "TEST"] as const;
export type SmsKind = (typeof SMS_KINDS)[number];

export type OtpPurpose = "LOGIN" | "REGISTER" | "PASSWORD_RESET";

export const OTP_KIND_BY_PURPOSE: Record<OtpPurpose, SmsKind> = {
  LOGIN: "LOGIN_CODE",
  REGISTER: "REGISTER_CODE",
  PASSWORD_RESET: "PASSWORD_RESET_CODE",
};

export function loginCodeText(code: string): string {
  return `Код входа в кабинет брокера: ${code}. Никому не сообщайте.`;
}

export function registerCodeText(code: string): string {
  return `Код подтверждения номера: ${code}. Действует 10 минут.`;
}

export function passwordResetCodeText(code: string): string {
  return `Код для смены пароля: ${code}. Если это не вы — не вводите его.`;
}

export function otpText(purpose: OtpPurpose, code: string): string {
  switch (purpose) {
    case "LOGIN":
      return loginCodeText(code);
    case "REGISTER":
      return registerCodeText(code);
    case "PASSWORD_RESET":
      return passwordResetCodeText(code);
  }
}

/** «Иванов Александр Петрович» → «Иванов А.»; одно слово — как есть. */
export function shortClientName(fullName: string | null | undefined): string {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "клиента";
  const [family, first] = parts;
  return first ? `${family} ${first[0].toUpperCase()}.` : family;
}

/** «20.10» из даты (московское время). */
export function shortDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit" }).formatToParts(date);
  const day = parts.find((p) => p.type === "day")?.value || "";
  const month = parts.find((p) => p.type === "month")?.value || "";
  return `${day}.${month}`;
}

/**
 * «Закрепление клиента Иванов А. истекает 20.10. Продлить — в кабинете.»
 * Если длинная фамилия выбивает за 70 знаков — оставляем только фамилию,
 * затем режем её.
 */
export function fixationExpiryText(clientFullName: string | null | undefined, expiresAt: Date): string {
  const date = shortDate(expiresAt);
  const build = (name: string) => `Закрепление клиента ${name} истекает ${date}. Продлить — в кабинете.`;
  let text = build(shortClientName(clientFullName));
  if (text.length <= SMS_MAX_CHARS) return text;
  const family = String(clientFullName || "").trim().split(/\s+/)[0] || "";
  text = build(family);
  if (text.length <= SMS_MAX_CHARS) return text;
  const overflow = text.length - SMS_MAX_CHARS;
  return build(family.slice(0, Math.max(1, family.length - overflow - 1)) + "…");
}

/** Код в журнале не храним: «: 482913.» → «: ••••••.» */
export function maskCodeInText(text: string): string {
  return text.replace(/\b\d{6}\b/g, "••••••");
}
