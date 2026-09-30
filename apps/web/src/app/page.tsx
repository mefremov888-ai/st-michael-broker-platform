// 30.09.2026: главная страница — новый лендинг по макету Figma (решение
// владельца после согласования всех правок на /v2). Прежний лендинг — на /v1,
// /v2 остаётся синонимом главной.
import type { Metadata } from 'next';
import V2Page, { metadata as v2Metadata } from './v2/page';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = v2Metadata;

export default function Page() {
  return <V2Page />;
}
