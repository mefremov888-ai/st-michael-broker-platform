'use client';

// 2026-06-11: отдельная страница «забыли пароль». Раньше форма была только
// модалкой на лендинге (apps/web/src/app/LandingClient.tsx) — с /login туда
// не было прямого перехода. Если брокер не помнит даже свой email,
// SupportContacts ниже подскажет как написать в поддержку.

import { useState } from 'react';
import Link from 'next/link';
import { parseApiError } from '@/lib/api';
import { SupportContacts } from '@/components/SupportContacts';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

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

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="card w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-2">Восстановление пароля</h1>
        <p className="text-sm text-text-muted text-center mb-6">
          Введите email, который указали при регистрации — пришлём ссылку для сброса пароля.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-error/20 text-error rounded-lg text-sm">
            {error}
          </div>
        )}

        {sent ? (
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

        <SupportContacts title="Не помните даже email?" />
      </div>
    </div>
  );
}
