// 2026-05-27 SSR root для лендинга. Раньше root был client-component,
// fetch CMS делал useEffect → пользователь видел DEFAULT_ при загрузке,
// потом моргание на свежий текст. Теперь fetch здесь, на сервере,
// HTML отдаётся уже с актуальными данными. Без скачка.
//
// `dynamic = 'force-dynamic'` гарантирует что Next.js НЕ кеширует HTML
// и не пытается ISR-revalidation. На каждый запрос делает свежий fetch.
//
// 2026-06-24: добавлен disk-snapshot fallback. После успешного fetch
// пишем initialData в JSON-файл на shared volume. Если на следующем
// запросе API лёг (content === null), читаем последний слепок и
// отдаём его — посетитель видит актуальные правки админки, а не
// зашитые в JS-бандле DEFAULT_* (как было до правки, см. инцидент
// 2026-06-24 — упала БД, лендинг показал «Доходность до 25%»).

import { promises as fs } from 'fs';
import path from 'path';
import LandingClient, { type LandingInitialData } from './LandingClient';

export const dynamic = 'force-dynamic';

// Путь к слепку CMS. На проде монтируется shared docker volume
// (см. docker-compose.yml → web → volumes: web-data:/app/data).
// Если папка не существует или нет прав на запись — fallback просто
// не работает (как раньше), без падений.
const SNAPSHOT_PATH = process.env.CMS_SNAPSHOT_PATH || '/app/data/cms-snapshot.json';

// API хост для server-side fetch. В docker-compose web получает
// API_URL=http://api:4000 (см. docker-compose.yml). NEXT_PUBLIC_API_URL=/api
// — это относительный URL для клиента, server-fetch с ним не работает.
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

// Атомарная запись: сначала во временный файл, потом rename. Так
// параллельный читатель никогда не поймает половину записи. Ошибки
// глотаем — снэпшот опциональный, основная страница важнее.
async function saveSnapshot(data: LandingInitialData): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const tmp = SNAPSHOT_PATH + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.rename(tmp, SNAPSHOT_PATH);
  } catch {
    // ignore — disk snapshot best-effort
  }
}

async function loadSnapshot(): Promise<LandingInitialData | null> {
  try {
    const raw = await fs.readFile(SNAPSHOT_PATH, 'utf8');
    return JSON.parse(raw) as LandingInitialData;
  } catch {
    return null;
  }
}

export default async function Page() {
  const base = getApiBase();
  const [
    content,
    events,
    projects,
    promos,
    cooperationDocs,
    analyticsDocs,
    marketingDocs,
    materialsDocs,
    news,
    activePolicies,
  ] = await Promise.all([
    safeFetch<any>(`${base}/api/public/cms/content`),
    safeFetch<any[]>(`${base}/api/public/cms/events`),
    safeFetch<any[]>(`${base}/api/public/cms/projects`),
    safeFetch<any[]>(`${base}/api/public/cms/promos`),
    safeFetch<any>(`${base}/api/public/documents?category=cooperation`),
    safeFetch<any>(`${base}/api/public/documents?category=analytics`),
    safeFetch<any>(`${base}/api/public/documents?category=marketing`),
    safeFetch<any>(`${base}/api/public/documents?category=materials`),
    safeFetch<any[]>(`${base}/api/public/cms/news`),
    safeFetch<any[]>(`${base}/api/public/cms/commission-policies/active`),
  ]);

  // Документы приходят в формате { documents: [...] } — разворачиваем.
  const unwrapDocs = (d: any): any[] =>
    Array.isArray(d?.documents) ? d.documents : Array.isArray(d) ? d : [];

  const fresh: LandingInitialData = {
    content: content || undefined,
    events: Array.isArray(events) ? events : [],
    projects: Array.isArray(projects) ? projects : [],
    promos: Array.isArray(promos) ? promos : [],
    cooperationDocs: unwrapDocs(cooperationDocs),
    analyticsDocs: unwrapDocs(analyticsDocs),
    marketingDocs: unwrapDocs(marketingDocs),
    materialsDocs: unwrapDocs(materialsDocs),
    news: Array.isArray(news) ? news : [],
    activePolicies: Array.isArray(activePolicies) ? activePolicies : [],
  };

  // content — основной блок текстов админки. Если он пришёл — API живой,
  // считаем выдачу "хорошей" и обновляем слепок на диске.
  if (fresh.content) {
    await saveSnapshot(fresh);
    return <LandingClient initialData={fresh} />;
  }

  // API упал. Тянем последний хороший слепок. Для блоков, у которых
  // на этом запросе всё-таки пришли данные (частичный сбой) —
  // приоритет у свежих, иначе берём из слепка.
  const snapshot = await loadSnapshot();
  if (snapshot) {
    const pick = (freshArr: any[] | undefined, snapArr: any[] | undefined): any[] => {
      if (Array.isArray(freshArr) && freshArr.length) return freshArr;
      if (Array.isArray(snapArr)) return snapArr;
      return [];
    };
    const merged: LandingInitialData = {
      content: snapshot.content,
      events: pick(fresh.events, snapshot.events),
      projects: pick(fresh.projects, snapshot.projects),
      promos: pick(fresh.promos, snapshot.promos),
      cooperationDocs: pick(fresh.cooperationDocs, snapshot.cooperationDocs),
      analyticsDocs: pick(fresh.analyticsDocs, snapshot.analyticsDocs),
      marketingDocs: pick(fresh.marketingDocs, snapshot.marketingDocs),
      materialsDocs: pick(fresh.materialsDocs, snapshot.materialsDocs),
      news: pick(fresh.news, snapshot.news),
      activePolicies: pick(fresh.activePolicies, snapshot.activePolicies),
    };
    return <LandingClient initialData={merged} />;
  }

  return <LandingClient initialData={fresh} />;
}
