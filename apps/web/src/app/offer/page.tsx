// 2026-06-19: server component — рендерим оферту на сервере, чтобы клиенту
// сразу приходил готовый HTML. Раньше клиентский useEffect+fetch иногда
// показывал «не удалось загрузить» если API тормозил/не отвечал, плюс
// клик по ссылке из модалки регистрации мог не успеть инициализировать
// fetch.
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

interface Offer {
  version: string;
  title: string;
  body: string;
  updatedAt: string;
}

async function loadOffer(): Promise<Offer | null> {
  try {
    // На сервере используем internal API_URL (контейнер api). Браузер сюда
    // не ходит — этот fetch исполняется только на стороне Next.js.
    const apiUrl = process.env.API_URL || 'http://api:4000';
    const res = await fetch(`${apiUrl}/api/offer/current`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as Offer;
  } catch {
    return null;
  }
}

const FALLBACK: Offer = {
  version: '—',
  title: 'Договор-оферта о сотрудничестве с партнёрами по продаже недвижимости',
  body: 'Текст оферты временно недоступен. Пожалуйста, обратитесь к менеджеру: info@zorge9.com',
  updatedAt: new Date().toISOString(),
};

export default async function PublicOfferPage() {
  const offer = (await loadOffer()) || FALLBACK;
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
          <h1 className="text-2xl md:text-3xl font-bold mb-2">{offer.title}</h1>
          <p className="text-sm text-text-muted mb-6">
            Версия {offer.version} · обновлено {new Date(offer.updatedAt).toLocaleDateString('ru-RU')}
          </p>
          <div className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed text-text">
            {offer.body}
          </div>
        </article>
      </main>
    </div>
  );
}
