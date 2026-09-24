// 2026-09-24: коды по СМС (СМС Центр). Формы входа/регистрации/восстановления
// показывают СМС-вариант только если он включён в админке «Интеграции».

export interface SmsOptions {
  login: boolean;
  register: boolean;
  passwordReset: boolean;
}

export type OtpPurpose = 'LOGIN' | 'REGISTER' | 'PASSWORD_RESET';

const OFF: SmsOptions = { login: false, register: false, passwordReset: false };

export async function fetchSmsOptions(): Promise<SmsOptions> {
  try {
    const res = await fetch('/api/auth/sms-options');
    if (!res.ok) return OFF;
    const data = await res.json();
    return {
      login: Boolean(data?.login),
      register: Boolean(data?.register),
      passwordReset: Boolean(data?.passwordReset),
    };
  } catch {
    return OFF;
  }
}

export type RequestCodeResult =
  | { ok: true; retryAfterSec: number; expiresInSec: number }
  | { ok: false; message: string; code?: string; retryAfterSec?: number; recovery?: string };

/** Запросить код. Ошибки бэка (лимиты, «нет такого аккаунта») отдаём как есть. */
export async function requestSmsCode(phone: string, purpose: OtpPurpose): Promise<RequestCodeResult> {
  try {
    const res = await fetch('/api/auth/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, purpose }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      return {
        ok: true,
        retryAfterSec: Number(body?.retryAfterSec) || 60,
        expiresInSec: Number(body?.expiresInSec) || 600,
      };
    }
    return {
      ok: false,
      message: body?.message || 'Не удалось отправить код. Попробуйте позже.',
      code: body?.code,
      retryAfterSec: body?.retryAfterSec ? Number(body.retryAfterSec) : undefined,
      recovery: body?.recovery,
    };
  } catch {
    return { ok: false, message: 'Ошибка соединения с сервером' };
  }
}

/** Оставить только 6 цифр — из поля кода. */
export function digitsCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}
