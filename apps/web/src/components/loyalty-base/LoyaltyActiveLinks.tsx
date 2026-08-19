'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, RefreshCcw, Unlink2 } from 'lucide-react';
import {
  getActiveLoyaltyLinks,
  unlinkActiveLoyaltyLink,
  type LoyaltyActiveLink,
  type LoyaltyActiveLinksResponse,
} from '@/lib/loyalty-base-api';

const entityLabels: Record<string, string> = {
  BROKER: 'Брокер',
  AGENCY: 'Агентство',
};

const formatDate = (value: string) => {
  if (!value) return 'Дата решения не указана';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
};

function ActiveLinkCard({ item, busy, onUnlink }: {
  item: LoyaltyActiveLink;
  busy: boolean;
  onUnlink: (item: LoyaltyActiveLink) => void;
}) {
  return (
    <article className="rounded-xl border border-border bg-background p-4 space-y-3">
      <div className="grid md:grid-cols-[1fr_auto_1fr] gap-3 items-stretch">
        <div className="rounded-lg border border-border bg-surface p-3 min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">База Анны · {entityLabels[item.ownerType] || item.ownerType}</div>
          <div className="font-semibold mt-2 truncate" title={item.ownerName}>{item.ownerName}</div>
          {!item.presentInActiveSnapshot && (
            <span className="inline-flex items-center gap-1 mt-2 rounded-full bg-warning/10 px-2 py-1 text-xs text-warning">
              <AlertTriangle className="w-3 h-3" /> Нет в активном snapshot
            </span>
          )}
        </div>

        <ArrowRight className="w-5 h-5 text-text-muted self-center mx-auto rotate-90 md:rotate-0" aria-hidden="true" />

        <div className="rounded-lg border border-border bg-surface p-3 min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Наша база · {entityLabels[item.targetType] || item.targetType}</div>
          <div className="font-semibold mt-2 truncate" title={item.targetName}>{item.targetName}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
        <span>{formatDate(item.decidedAt)}{item.ruleVersion ? ` · правило ${item.ruleVersion}` : ''}</span>
        <button type="button" disabled={busy} className="btn btn-secondary inline-flex items-center gap-2 text-error" onClick={() => onUnlink(item)}>
          <Unlink2 className="w-4 h-4" /> Отменить связь
        </button>
      </div>
    </article>
  );
}

export function LoyaltyActiveLinks() {
  const [data, setData] = useState<LoyaltyActiveLinksResponse | null>(null);
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState<'' | 'BROKER' | 'AGENCY'>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const pageSize = 20;

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      setData(await getActiveLoyaltyLinks({ page, pageSize, entityType }));
    } catch (reason) {
      if (!silent) setData(null);
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить активные связи');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [entityType, page]);

  useEffect(() => { void load(); }, [load]);

  const unlink = async (item: LoyaltyActiveLink) => {
    if (busyId) return;
    if (!window.confirm(`Отменить связь «${item.ownerName}» → «${item.targetName}»? Исходные карточки не удаляются.`)) return;
    const previous = data;
    if (!previous) return;

    const nextTotal = Math.max(0, previous.total - 1);
    const nextItems = previous.items.filter((link) => link.id !== item.id);
    setBusyId(item.id);
    setError('');
    setData({
      ...previous,
      items: nextItems,
      total: nextTotal,
      totalPages: nextTotal === 0 ? 0 : Math.ceil(nextTotal / previous.pageSize),
    });

    try {
      await unlinkActiveLoyaltyLink(item.id, item.version);
      if (nextItems.length === 0 && page > 1) setPage((value) => Math.max(1, value - 1));
      else void load(true);
    } catch (reason) {
      setData(previous);
      setError(reason instanceof Error ? reason.message : 'Не удалось отменить связь. Список восстановлен.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="active-links-title">
      <div className="card p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h3 id="active-links-title" className="font-semibold">Активные связи</h3>
          <p className="text-sm text-text-muted mt-1">Подтверждённые соответствия Базы Анны и Нашей базы. Отмена сохраняет историю связи.</p>
        </div>
        <div className="flex gap-2">
          <select className="input md:w-48" value={entityType} disabled={Boolean(busyId)} onChange={(event) => { setEntityType(event.target.value as typeof entityType); setPage(1); }} aria-label="Тип активной связи">
            <option value="">Все типы</option>
            <option value="BROKER">Брокеры</option>
            <option value="AGENCY">Агентства</option>
          </select>
          <button type="button" className="btn btn-secondary" disabled={loading || Boolean(busyId)} onClick={() => void load()} aria-label="Обновить активные связи">
            <RefreshCcw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg bg-error/10 text-error p-4">{error}</div>}
      {error && !data ? null : loading ? <div className="card py-16 text-center text-text-muted">Загружаем активные связи…</div>
        : !data?.items.length ? <div className="card py-16 text-center"><div className="font-semibold">Активных связей нет</div><div className="text-sm text-text-muted mt-1">Подтверждённые связи появятся здесь после сверки.</div></div>
          : <div className="space-y-3" aria-live="polite">{data.items.map((item) => <ActiveLinkCard key={item.id} item={item} busy={Boolean(busyId)} onUnlink={unlink} />)}</div>}

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-muted">Страница {data.page} из {data.totalPages} · {data.total} связей</span>
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" disabled={page <= 1 || Boolean(busyId)} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft className="w-4 h-4" /></button>
            <button type="button" className="btn btn-secondary" disabled={page >= data.totalPages || Boolean(busyId)} onClick={() => setPage((value) => Math.min(data.totalPages, value + 1))}><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>
      )}
    </section>
  );
}
