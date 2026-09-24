'use client';

// 2026-06-11: отдельная страница «забыли пароль». Раньше форма была только
// модалкой на лендинге (apps/web/src/app/LandingClient.tsx) — с /login туда
// не было прямого перехода. Если брокер не помнит даже свой email,
// SupportContacts ниже подскажет как написать в поддержку.
// 2026-09-24: добавлен путь «по СМС» (код на номер → новый пароль) — для тех,
// у кого нет email или письма не доходят. Показывается, только если включён
// в админке «Интеграции» (СМС Центр).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { parseApiError } from '@/lib/api';
import { SupportContacts } from '@/components/SupportContacts';
import { SmsCodeField } from '@/components/SmsCodeField';
import { fetchSmsOptions } from '@/lib/sms-options';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const [smsAvailable, setSmsAvailable] = useState(false);
  const [mode, setMode] = useState<'email' | 'sms'>('email');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    fetchSmsOptions().then((o) => {
      setSmsAvailable(o.passwordReset);
      if (o.passwordReset) setMode('sms');
    });
  }, []);

  const handleSubmit = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setSent(true);
      } else {
        setError(await parseApiError(res, 'Не удалось отправить письмо. Попробуйте ещё раз.'));
      }
    } catch {
      setError('Ошибка соединения с сервером');
    }
    setLoading(false);
  };

  const handleSmsReset = async () => {
    if (phoneDigits.length !== 10) { setError('Введите номер телефона — 10 цифр после +7'); return; }
    if (smsCode.length !== 6) { setError('Введите код из СМС — 6 цифр'); return; }
    if (password.length < 8) { setError('Пароль должен быть не менее 8 символов'); return; }
    if (password !== confirm) { setError('Пароли не совпадают'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/otp/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+7' + phoneDigits, code: smsCode, password }),
      });
      if (res.ok) {
        setChanged(true);
      } else {
        setError(await parseApiError(res, 'Код неверный или истёк'));
      }
    } catch {
      setError('Ошибка соединения с сервером');
    }
    setLoading(false);
  };

  const switchMode = (next: 'email' | 'sms') => {
    setMode(next);
    setError('');
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="card w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-2">Восстановление пароля</h1>
        <p className="text-sm text-text-muted text-center mb-6">
          {mode === 'sms'
            ? 'Введите номер телефона из вашей учётной записи — пришлём код по СМС и вы зададите новый пароль.'
            : 'Введите email, который указали при регистрации — пришлём ссылку для сброса пароля.'}
        </p>

        {smsAvailable && !sent && !changed && (
          <div className="flex gap-2 mb-4" role="tablist">
            <button
              type="button"
              className={`btn flex-1 ${mode === 'sms' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => switchMode('sms')}
              data-testid="forgot-mode-sms"
            >
              По СМС
            </button>
            <button
              type="button"
              className={`btn flex-1 ${mode === 'email' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => switchMode('email')}
              data-testid="forgot-mode-email"
            >
              По email
            </button>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-error/20 text-error rounded-lg text-sm">
            {error}
          </div>
        )}

        {mode === 'sms' ? (
          changed ? (
            <div className="p-4 bg-success/20 text-success rounded-lg text-sm">
              Пароль изменён. Теперь можно войти с новым паролем.
            </div>
          ) : (
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
                    onChange={(e) => setPhoneDigits(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    maxLength={10}
                  />
                </div>
              </div>

              <SmsCodeField
                phone={phoneDigits.length === 10 ? '+7' + phoneDigits : null}
                purpose="PASSWORD_RESET"
                value={smsCode}
                onChange={setSmsCode}
              />

              <div>
                <label className="label">Новый пароль</label>
                <input
                  type="password"
                  className="input"
                  placeholder="Минимум 8 символов"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Повторите пароль</label>
                <input
                  type="password"
                  className="input"
                  placeholder="Введите пароль ещё раз"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSmsReset()}
                />
              </div>

              <button
                className="btn btn-primary w-full"
                onClick={handleSmsReset}
                disabled={loading}
              >
                {loading ? 'Сохраняем...' : 'Сохранить новый пароль'}
              </button>
            </div>
          )
        ) : sent ? (
          <div className="p-4 bg-success/20 text-success rounded-lg text-sm">
            Если такой email зарегистрирован — на него отправлена ссылка для восстановления. Проверьте почту (включая «Спам»).
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                className="input"
                placeholder="example@mail.ru"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && email && handleSubmit()}
              />
            </div>

            <button
              className="btn btn-primary w-full"
              onClick={handleSubmit}
              disabled={loading || !email}
            >
              {loading ? 'Отправляем...' : 'Прислать ссылку'}
            </button>
          </div>
        )}

        <div className="mt-6 text-center">
          <Link href="/login" className="text-accent hover:text-accent-hover">
            Вспомнили? Войти
          </Link>
        </div>

        <SupportContacts title={mode === 'sms' ? 'Номер недоступен?' : 'Не помните даже email?'} />
      </div>
    </div>
  );
}
