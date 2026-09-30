// 2026-09-28: новый лендинг кабинета брокера по макету Figma (Ринат Габитов).
// Живёт на /v2 для предпросмотра; текущая главная не тронута. Данные — те же
// публичные API, что и у старого лендинга: контакты, проекты, события, новости,
// документы условий; счётчики материалов — /public/documents/summary.

import type { Metadata } from 'next';
import LandingV2, { type LandingV2Data } from './LandingV2';
import './v2.css';

// 30.09.2026: новый лендинг живёт на «/» (см. app/page.tsx), «/v2» оставлен
// как синоним, чтобы старые ссылки не ломались.

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Кабинет брокера — St Michael',
  description: 'Партнёрская программа St Michael: Зорге 9 и Квартал Серебряный Бор. Фиксация клиентов, брокер-туры, материалы для продвижения.',
};

function getApiBase(): string {
  return process.env.API_URL || process.env.INTERNAL_API_URL || 'http://api:4000';
}

async function safeFetch<T = any>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

const unwrapDocs = (d: any): any[] => (Array.isArray(d?.documents) ? d.documents : Array.isArray(d) ? d : []);

export default async function Page() {
  const base = getApiBase();
  // 2026-09-28 (обновление макета от Рината): сверху карусель «Акции» из
  // CMS-акций (LandingPromo); блок «Новости» вернулся в макет (версия 7004) —
  // те же карточки из /public/cms/news, что и на старом лендинге.
  const [content, projects, events, promos, news, cooperationDocs, summary] = await Promise.all([
    safeFetch<any>(`${base}/api/public/cms/content`),
    safeFetch<any[]>(`${base}/api/public/cms/projects`),
    safeFetch<any[]>(`${base}/api/public/cms/events`),
    safeFetch<any[]>(`${base}/api/public/cms/promos`),
    safeFetch<any[]>(`${base}/api/public/cms/news?limit=20`), // 30.09: карусель новостей, API отдаёт до 20
    safeFetch<any>(`${base}/api/public/documents?category=cooperation`),
    safeFetch<any>(`${base}/api/public/documents/summary`),
  ]);

  const data: LandingV2Data = {
    content: content || {},
    projects: Array.isArray(projects) ? projects : [],
    events: Array.isArray(events) ? events : [],
    promos: Array.isArray(promos) ? promos : [],
    news: Array.isArray(news) ? news : [],
    cooperationDocs: unwrapDocs(cooperationDocs),
    materials: summary?.groups || {},
  };
  return <LandingV2 data={data} />;
}
