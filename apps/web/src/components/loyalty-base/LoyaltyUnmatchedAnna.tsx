'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, PhoneOff, RefreshCcw } from 'lucide-react';
import {
  getUnmatchedAnnaRecords,
  type UnmatchedAnnaRecord,
  type UnmatchedAnnaResponse,
} from '@/lib/loyalty-base-api';

const entityLabels: Record<string, string> = {
  BROKER: 'Брокер',
  AGENCY: 'Агентство',
};

function UnmatchedAnnaCard({ item }: { item: UnmatchedAnnaRecord }) {
  return (
    <article className="rounded-xl border border-border bg-background p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">{entityLabels[item.entityType] || item.entityType}</div>
        <div className="font-semibold mt-1 truncate" title={item.name}>{item.name}</div>
        <div className="text-sm text-text-muted mt-0.5">{item.city || 'Город не указан'} · {item.phone || 'Без телефона'}</div>
      </div>
      {!item.hasValidPhone && (
        <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-warning/10 px-2.5 py-1 text-xs text-warning">
          <PhoneOff className="w-3 h-3" /> Нет валидного телефона
        </span>
      )}
    </article>
  );
}

export function LoyaltyUnmatchedAnna() {
  const [data, setData] = useState<UnmatchedAnnaResponse | null>(null);
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState<'' | 'BROKER' | 'AGENCY'>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getUnmatchedAnnaRecords({ page, pageSize, entityType }));
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, [entityType, page]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-4" aria-labelledby="unmatched-anna-title">
      <div className="rounded-xl border border-warning/25 bg-warning/5 p-4 flex gap-3">
        <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
        <div>
          <h3 id="unmatched-anna-title" className="font-semibold">Есть только у Анны Скибицкой</h3>
          <p className="text-sm text-text-muted mt-1">Записи активного снимка, для которых не нашлось ни одного кандидата в нашей базе — ни по телефону, ни по ID amoCRM, ни по ИНН. Требуют либо ручного поиска, либо признания, что это новый контакт.</p>
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
        : !data?.items.length ? <div className="card py-16 text-center"><div className="font-semibold">Таких записей нет</div><div className="text-sm text-text-muted mt-1">Все записи Анны нашли хотя бы одного кандидата в нашей базе.</div></div>
          : <div className="space-y-3" aria-live="polite">{data.items.map((item) => <UnmatchedAnnaCard key={`${item.entityType}:${item.id}`} item={item} />)}</div>}

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
