import { redirect } from 'next/navigation';

/** 2026-08-28: страница скрыта из кабинета, прямой URL тоже не открываем. */
export default function AnalyticsPage() {
  redirect('/');
}
