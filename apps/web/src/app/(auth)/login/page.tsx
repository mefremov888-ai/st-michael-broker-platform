'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { parseApiError } from '@/lib/api';
import { SupportContacts } from '@/components/SupportContacts';

export default function LoginPage() {
  const [phoneDigits, setPhoneDigits] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();
  const router = useRouter();

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhoneDigits(e.target.value.replace(/\D/g, '').slice(0, 10));
  };

  const handleLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+7' + phoneDigits, password }),
      });
      if (res.ok) {
        const data = await res.json();
        login(data.accessToken, data.refreshToken);
      } else {
        // 2026-06-30: бэк может вернуть код NEEDS_REGISTRATION (телефона нет
        // в БД) или NEEDS_ACTIVATION (есть, но пароля нет — импортированный
        // брокер). В обоих случаях редиректим на /register с предзаполненным
        // телефоном — пользователь там введёт ФИО, email, пароль и завершит
        // регистрацию/активацию.
        const body = await res.json().catch(() => null);
        const code = body?.code;
        if (code === 'NEEDS_REGISTRATION' || code === 'NEEDS_ACTIVATION') {
          router.push(`/register?phone=${phoneDigits}`);
          return;
        }
        setError(body?.message || await parseApiError(res, 'Неверный телефон или пароль'));
      }
    } catch {
      setError('Ошибка соединения с сервером');
    }
    setLoading(false);
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
                maxLength={10}
              />
            </div>
          </div>

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

          <button
            className="btn btn-primary w-full"
            onClick={handleLogin}
            disabled={loading || phoneDigits.length !== 10 || !password}
          >
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </div>

        <div className="mt-6 text-center space-y-2">
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
