'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Info, RefreshCcw } from 'lucide-react';
import {
  getUnmatchedCabinetEntities,
  type UnmatchedCabinetEntity,
  type UnmatchedCabinetResponse,
} from '@/lib/loyalty-base-api';

const entityLabels: Record<string, string> = {
  BROKER: 'Брокер',
  AGENCY: 'Агентство',
};

function UnmatchedCabinetCard({ item }: { item: UnmatchedCabinetEntity }) {
  return (
    <article className="rounded-xl border border-border bg-background p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">{entityLabels[item.entityType] || item.entityType}</div>
        <div className="font-semibold mt-1 truncate" title={item.name}>{item.name}</div>
        <div className="text-sm text-text-muted mt-0.5 font-mono">{item.phone || (item.taxId ? `ИНН ${item.taxId}` : 'Без телефона')}</div>
      </div>
      {item.amoContactId && <span className="text-xs text-text-muted shrink-0">amoCRM #{item.amoContactId}</span>}
    </article>
  );
}

export function LoyaltyUnmatchedCabinet() {
  const [data, setData] = useState<UnmatchedCabinetResponse | null>(null);
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState<'' | 'BROKER' | 'AGENCY'>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getUnmatchedCabinetEntities({ page, pageSize, entityType }));
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, [entityType, page]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-4" aria-labelledby="unmatched-cabinet-title">
      <div className="rounded-xl border border-info/25 bg-info/5 p-4 flex gap-3">
        <Info className="w-5 h-5 text-info shrink-0 mt-0.5" />
        <div>
          <h3 id="unmatched-cabinet-title" className="font-semibold">Есть только в нашей базе</h3>
          <p className="text-sm text-text-muted mt-1">Брокеры и агентства кабинета, на которых не сослалась ни одна запись Анны Скибицкой в активном снимке — по телефону, amoCRM ID или ИНН совпадений не найдено.</p>
        </div>
      </div>

      <div className="card p-4 flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
        <select className="input md:w-56" value={entityType} onChange={(event) => { setEntityType(event.target.value as typeof entityType); setPage(1); }} aria-label="Тип записи">
          <option value="">Все типы</option>
          <option value="BROKER">Брокеры</option>
          <option value="AGENCY">Агентства</option>
        </select>
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void load()} aria-label="Обновить список">
          <RefreshCcw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <div className="rounded-lg bg-error/10 text-error p-4">{error}</div>}
      {error && !data ? null : loading ? <div className="card py-16 text-center text-text-muted">Загружаем список…</div>
        : !data?.items.length ? <div className="card py-16 text-center"><div className="font-semibold">Таких записей нет</div><div className="text-sm text-text-muted mt-1">Вся наша база нашла хотя бы одно совпадение у Анны.</div></div>
          : <div className="space-y-3" aria-live="polite">{data.items.map((item) => <UnmatchedCabinetCard key={`${item.entityType}:${item.id}`} item={item} />)}</div>}

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-muted">Страница {data.page} из {data.totalPages} · {data.total} записей</span>
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft className="w-4 h-4" /></button>
            <button type="button" className="btn btn-secondary" disabled={page >= data.totalPages} onClick={() => setPage((value) => Math.min(data.totalPages, value + 1))}><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>
      )}
    </section>
  );
}
