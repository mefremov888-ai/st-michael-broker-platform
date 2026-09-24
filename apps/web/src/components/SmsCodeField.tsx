'use client';

// 2026-09-24: поле «код из СМС» с кнопкой «Получить код» и таймером
// повторной отправки. Используется на входе, регистрации и восстановлении
// пароля. Сам код запрашивает через /api/auth/otp/request.

import { useEffect, useState } from 'react';
import { digitsCode, requestSmsCode, type OtpPurpose, type RequestCodeResult } from '@/lib/sms-options';

interface Props {
  /** Полный номер +7XXXXXXXXXX или null, если ещё не введён. */
  phone: string | null;
  purpose: OtpPurpose;
  value: string;
  onChange: (code: string) => void;
  /** Ошибка запроса кода, которую форма хочет обработать сама (редиректы и т.п.). */
  onRequestError?: (result: Extract<RequestCodeResult, { ok: false }>) => boolean | void;
  onEnter?: () => void;
  error?: string;
  inputClassName?: string;
  autoFocus?: boolean;
}

export function SmsCodeField({ phone, purpose, value, onChange, onRequestError, onEnter, error, inputClassName, autoFocus }: Props) {
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (retryIn <= 0) return;
    const t = setTimeout(() => setRetryIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [retryIn]);

  // Номер поменяли — код к нему уже не относится.
  useEffect(() => {
    if (sentTo && phone !== sentTo) {
      setSentTo(null);
      setRetryIn(0);
      onChange('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  const request = async () => {
    if (!phone) {
      setLocalError('Сначала введите номер телефона');
      return;
    }
    setSending(true);
    setLocalError('');
    const result = await requestSmsCode(phone, purpose);
    setSending(false);
    if (result.ok) {
      setSentTo(phone);
      setRetryIn(result.retryAfterSec);
      return;
    }
    if (onRequestError && onRequestError(result)) return;
    setLocalError(result.message);
    if (result.retryAfterSec) setRetryIn(result.retryAfterSec);
  };

  const canRequest = Boolean(phone) && !sending && retryIn <= 0;
  const shownError = error || localError;

  return (
    <div>
      <label className="label">Код из СМС</label>
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          className={(inputClassName || 'input') + ' flex-1'}
          placeholder="6 цифр"
          value={value}
          maxLength={6}
          autoFocus={autoFocus}
          onChange={(e) => onChange(digitsCode(e.target.value))}
          onKeyDown={(e) => e.key === 'Enter' && onEnter && onEnter()}
          data-testid="sms-code-input"
        />
        <button
          type="button"
          className="btn btn-secondary whitespace-nowrap"
          onClick={request}
          disabled={!canRequest}
          data-testid="sms-code-request"
        >
          {sending ? 'Отправляем…' : retryIn > 0 ? `Повторно через ${retryIn} с` : sentTo ? 'Отправить ещё раз' : 'Получить код'}
        </button>
      </div>
      {sentTo && !shownError && (
        <p className="mt-1 text-xs text-text-muted">Код отправлен на +7 {sentTo.slice(2, 5)} ***-**-{sentTo.slice(-2)}. Действует 10 минут.</p>
      )}
      {shownError && <div className="text-xs text-error mt-1">{shownError}</div>}
    </div>
  );
}
