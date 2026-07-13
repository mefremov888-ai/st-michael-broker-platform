'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserCheck, Users, CalendarPlus, Building, Calculator } from 'lucide-react';

// Compact set of essential navigation items for mobile bottom bar (TZ §16 — мобильная навигация)
const items = [
  { name: 'Уникальность', href: '/fixation', icon: UserCheck },
  { name: 'Клиенты', href: '/clients', icon: Users },
  { name: 'Встречи', href: '/meetings', icon: CalendarPlus },
  { name: 'Каталог', href: '/catalog', icon: Building },
  { name: 'Комиссия', href: '/commission', icon: Calculator },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-surface border-t border-border"
      aria-label="Нижняя навигация"
    >
      <ul className="grid grid-cols-5">
        {items.map((it) => {
          const active = pathname === it.href;
          return (
            <li key={it.href}>
              <Link
                href={it.href}
                className={`flex flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium transition ${
                  active ? 'text-accent' : 'text-text-muted hover:text-text'
                }`}
              >
                <it.icon className={`w-5 h-5 ${active ? 'text-accent' : ''}`} />
                <span>{it.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
