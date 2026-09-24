'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { parseApiError } from '@/lib/api';
import { SupportContacts } from '@/components/SupportContacts';
import { SmsCodeField } from '@/components/SmsCodeField';
import { fetchSmsOptions } from '@/lib/sms-options';

export default function LoginPage() {
  const [phoneDigits, setPhoneDigits] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // 2026-09-24: вход по коду из СМС — альтернатива паролю, показывается
  // только если включён в админке «Интеграции» (СМС Центр).
  const [smsLoginAvailable, setSmsLoginAvailable] = useState(false);
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [smsCode, setSmsCode] = useState('');
  const { login } = useAuth();
  const router = useRouter();

  useEffect(() => {
    fetchSmsOptions().then((o) => setSmsLoginAvailable(o.login));
  }, []);

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhoneDigits(e.target.value.replace(/\D/g, '').slice(0, 10));
  };

  // 2026-09-11 (владелец): если введено слишком мало символов — человек должен
  // понимать, чего не хватает, а не смотреть на неактивную кнопку.
  const digitsLeft = 10 - phoneDigits.length;
  const phoneHint =
    phoneDigits.length > 0 && phoneDigits.length < 10
      ? `Введено ${phoneDigits.length} из 10 цифр — не хватает ${digitsLeft}`
      : '';

  const phoneError = () =>
    phoneDigits.length === 0
      ? 'Введите номер телефона — 10 цифр после +7'
      : `Номер введён не полностью: ${phoneDigits.length} из 10 цифр, не хватает ${digitsLeft}`;

  // 2026-06-30: бэк может вернуть код NEEDS_REGISTRATION (телефона нет
  // в БД) или NEEDS_ACTIVATION (есть, но пароля нет — импортированный
  // брокер). В обоих случаях редиректим на /register с предзаполненным
  // телефоном — пользователь там введёт ФИО, email, пароль и завершит
  // регистрацию/активацию.
  const redirectIfNeeded = (code: string | undefined) => {
    if (code === 'NEEDS_REGISTRATION' || code === 'NEEDS_ACTIVATION') {
      router.push(`/register?phone=${phoneDigits}`);
      return true;
    }
    return false;
  };

  const handleLogin = async () => {
    if (phoneDigits.length !== 10) {
      setError(phoneError());
      return;
    }
    if (mode === 'password' && !password) {
      setError('Введите пароль');
      return;
    }
    if (mode === 'code' && smsCode.length !== 6) {
      setError('Введите код из СМС — 6 цифр');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = mode === 'password'
        ? await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: '+7' + phoneDigits, password }),
          })
        : await fetch('/api/auth/otp/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: '+7' + phoneDigits, code: smsCode }),
          });
      if (res.ok) {
        const data = await res.json();
        login(data.accessToken, data.refreshToken);
      } else {
        const body = await res.json().catch(() => null);
        if (redirectIfNeeded(body?.code)) return;
        setError(body?.message || await parseApiError(res, mode === 'password' ? 'Неверный телефон или пароль' : 'Код неверный или истёк'));
      }
    } catch {
      setError('Ошибка соединения с сервером');
    }
    setLoading(false);
  };

  const switchMode = (next: 'password' | 'code') => {
    setMode(next);
    setError('');
    setSmsCode('');
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="card w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">Вход в кабинет</h1>

        {error && (
          <div className="mb-4 p-3 bg-error/20 text-error rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="label">Номер телефона</label>
            <div className="flex">
              <span className="inline-flex items-center px-3 bg-surface-secondary border border-r-0 border-border rounded-l text-text-muted text-sm">+7</span>
              <input
                type="tel"
                className="input rounded-l-none"
                placeholder="9991234567"
                value={phoneDigits}
                onChange={handlePhoneChange}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                maxLength={10}
              />
            </div>
            {phoneHint && (
              <p className="mt-1 text-xs text-text-muted">{phoneHint}</p>
            )}
          </div>

          {mode === 'password' ? (
            <div>
              <label className="label">Пароль</label>
              <input
                type="password"
                className="input"
                placeholder="Введите пароль"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              />
            </div>
          ) : (
            <SmsCodeField
              phone={phoneDigits.length === 10 ? '+7' + phoneDigits : null}
              purpose="LOGIN"
              value={smsCode}
              onChange={setSmsCode}
              onEnter={handleLogin}
              onRequestError={(r) => redirectIfNeeded(r.code)}
            />
          )}

          <button
            className="btn btn-primary w-full"
            onClick={handleLogin}
            disabled={loading}
          >
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </div>

        <div className="mt-6 text-center space-y-2">
          {smsLoginAvailable && (
            <div>
              <button
                type="button"
                className="text-accent hover:text-accent-hover text-sm"
                onClick={() => switchMode(mode === 'password' ? 'code' : 'password')}
                data-testid="login-mode-toggle"
              >
                {mode === 'password' ? 'Войти по коду из СМС' : 'Войти по паролю'}
              </button>
            </div>
          )}
          <div>
            <Link href="/forgot-password" className="text-accent hover:text-accent-hover text-sm">
              Забыли пароль?
            </Link>
          </div>
          <div>
            <Link href="/register" className="text-accent hover:text-accent-hover">
              Нет аккаунта? Зарегистрироваться
            </Link>
          </div>
        </div>

        <SupportContacts />
      </div>
    </div>
  );
}
