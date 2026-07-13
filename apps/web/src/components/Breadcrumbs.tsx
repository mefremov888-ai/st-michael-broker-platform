'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, ChevronRight } from 'lucide-react';

const labels: Record<string, string> = {
  fixation: 'Проверка на уникальность',
  clients: 'Мои клиенты',
  meetings: 'Встречи',
  catalog: 'Подбор квартир',
  favorites: 'Избранное',
  deals: 'Мои сделки',
  commission: 'Комиссия',
  materials: 'Материалы для работы',
  documents: 'Документы',
  offer: 'Договор оферты',
  profile: 'Профиль',
  analytics: 'Аналитика',
  admin: 'Админка',
  brokers: 'Брокеры',
  events: 'События',
  projects: 'Проекты',
  content: 'Контент',
  mailings: 'Рассылки',
  'meeting-slots': 'Расписание встреч',
};

export function Breadcrumbs() {
  const pathname = usePathname();
  if (!pathname || pathname === '/') return null;

  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const crumbs = parts.map((p, i) => {
    const href = '/' + parts.slice(0, i + 1).join('/');
    const label = labels[p] || decodeURIComponent(p);
    return { href, label };
  });

  return (
    <nav aria-label="breadcrumbs" className="text-sm mb-4 flex items-center flex-wrap gap-1 text-text-muted">
      <Link href="/fixation" className="flex items-center gap-1 hover:text-text">
        <Home className="w-3.5 h-3.5" /> Кабинет
      </Link>
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={c.href} className="flex items-center gap-1">
            <ChevronRight className="w-3.5 h-3.5" />
            {isLast ? (
              <span className="text-text font-medium">{c.label}</span>
            ) : (
              <Link href={c.href} className="hover:text-text">{c.label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
