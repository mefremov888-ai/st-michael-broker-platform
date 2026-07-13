'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  UserCheck,
  Users,
  CalendarPlus,
  Building,
  Heart,
  HeartHandshake,
  Calculator,
  BookOpen,
  FileText,
  Shield,
  Calendar,
  Sparkles,
  BarChart3,
  Megaphone,
  PhoneCall,
  AlertTriangle,
  Plug,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';

const navigation = [
  { name: 'Проверить клиента на уникальность', href: '/fixation', icon: UserCheck },
  { name: 'Мои клиенты / заявки', href: '/clients', icon: Users },
  { name: 'Записаться на встречу', href: '/meetings', icon: CalendarPlus },
  { name: 'Подбор квартир', href: '/catalog', icon: Building },
  { name: 'Избранное', href: '/favorites', icon: Heart },
  { name: 'Мои сделки', href: '/deals', icon: HeartHandshake },
  { name: 'Комиссия', href: '/commission', icon: Calculator },
  { name: 'Материалы для работы', href: '/materials', icon: BookOpen },
  { name: 'Документы', href: '/documents', icon: FileText },
];

const adminNavigation = [
  { name: 'Аналитика платформы', href: '/admin/analytics', icon: BarChart3 },
  { name: 'Колл-центр', href: '/admin/call-center', icon: PhoneCall },
  { name: 'Конфликты уникальности', href: '/admin/uniqueness-conflicts', icon: AlertTriangle },
  // 2026-07-09: заменяет «Заявки без amoCRM» — теперь тут все типы
  // заявок брокеров (фиксации + встречи + звонки + акцепты) с фильтром
  // по статусу amo. См. /admin/broker-applications.
  { name: 'Все заявки от брокеров', href: '/admin/broker-applications', icon: AlertTriangle },
  { name: 'Админка — Брокеры', href: '/admin/brokers', icon: Shield },
  { name: 'Комиссия — политики', href: '/admin/commission-policies', icon: Calculator },
  { name: 'Управление встречами', href: '/admin/meetings', icon: CalendarPlus },
  { name: 'Расписание встреч', href: '/admin/meeting-slots', icon: Calendar },
  { name: 'Рассылки', href: '/admin/mailings', icon: Megaphone },
  { name: 'Лендинг — Контент', href: '/admin/content', icon: Sparkles },
  { name: 'Лендинг — Акции', href: '/admin/promos', icon: Megaphone },
  { name: 'Лендинг — События', href: '/admin/events', icon: Calendar },
  { name: 'Лендинг — Проекты', href: '/admin/projects', icon: Building },
  { name: 'Лендинг — Новости', href: '/admin/news', icon: FileText },
  { name: 'Файлы и документы', href: '/admin/documents', icon: FileText },
  { name: 'Интеграции', href: '/admin/integrations', icon: Plug },
];

export function Sidebar({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const { broker } = useAuth();
  const isAdmin = broker?.role === 'ADMIN' || broker?.role === 'MANAGER';
  // 2026-07-01: временно скрываем «Мои сделки» для роли BROKER — раздел
  // дорабатывается. Для ADMIN/MANAGER оставляем видимым, чтобы можно было
  // смотреть сделки других брокеров.
  const baseNav = broker?.role === 'BROKER'
    ? navigation.filter((n) => n.href !== '/deals')
    : navigation;
  const items = isAdmin ? [...baseNav, ...adminNavigation] : baseNav;

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <div
        className={cn(
          'fixed top-0 left-0 z-50 h-full w-64 bg-surface border-r border-border transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 lg:z-auto',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="p-6 flex items-center justify-between">
          {/* 2026-05-27: лого кликабельно → возвращает на лендинг (/) */}
          <Link href="/" className="block hover:opacity-80 transition" title="Вернуться на главную">
            <h2 className="text-xl font-bold text-accent">ST Michael</h2>
            <p className="text-sm text-text-muted">Кабинет брокера</p>
          </Link>
          {onClose && (
            <button
              onClick={onClose}
              className="lg:hidden p-2 hover:bg-surface-secondary rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <nav className="px-4">
          <ul className="space-y-2">
            {items.map((item) => {
              const isActive = pathname === item.href;
              return (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    onClick={onClose}
                    className={cn(
                      'flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors',
                      isActive
                        ? 'bg-accent text-white'
                        : 'text-text hover:bg-surface-secondary'
                    )}
                  >
                    <item.icon className="w-5 h-5 mr-3" />
                    {item.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </>
  );
}
