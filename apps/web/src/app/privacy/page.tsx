// 2026-06-19: server component — рендерим согласие на ПД на сервере.
// См. комментарий в /offer/page.tsx — та же причина.
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

interface Privacy {
  version: string;
  title: string;
  body: string;
  updatedAt: string;
}

async function loadPrivacy(): Promise<Privacy | null> {
  try {
    const apiUrl = process.env.API_URL || 'http://api:4000';
    const res = await fetch(`${apiUrl}/api/privacy/current`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as Privacy;
  } catch {
    return null;
  }
}

const FALLBACK: Privacy = {
  version: '—',
  title: 'Согласие на обработку персональных данных',
  body: 'Текст согласия временно недоступен. Пожалуйста, обратитесь к менеджеру: info@zorge9.com',
  updatedAt: new Date().toISOString(),
};

export default async function PublicPrivacyPage() {
  const privacy = (await loadPrivacy()) || FALLBACK;
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/" className="text-text-muted hover:text-text flex items-center gap-1 text-sm">
            <ArrowLeft className="w-4 h-4" /> На главную
          </Link>
          <span className="text-xs text-text-muted">ST Michael · Кабинет брокера</span>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-8">
        <article className="card">
          <h1 className="text-2xl md:text-3xl font-bold mb-2">{privacy.title}</h1>
          <p className="text-sm text-text-muted mb-6">
            Версия {privacy.version} · обновлено {new Date(privacy.updatedAt).toLocaleDateString('ru-RU')}
          </p>
          <div className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed text-text">
            {privacy.body}
          </div>
        </article>
      </main>
    </div>
  );
}
