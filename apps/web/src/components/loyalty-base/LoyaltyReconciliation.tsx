'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, ChevronLeft, ChevronRight, Link2, RefreshCcw, Search, Unlink2, X } from 'lucide-react';
import {
  decideReconciliationCase,
  getReconciliationCases,
  type ReconciliationCase,
  type ReconciliationDecisionAction,
  type ReconciliationResponse,
  type ReconciliationSide,
} from '@/lib/loyalty-base-api';
import { LoyaltyActiveLinks } from './LoyaltyActiveLinks';

const decisionLabels: Record<string, string> = {
  LINK: 'Связаны',
  KEEP_SEPARATE: 'Оставлены раздельно',
  REJECT_MATCH: 'Совпадение отклонено',
  UNLINK: 'Связь отменена',
};

function SideCard({ title, side }: { title: string; side: ReconciliationSide | null }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 min-w-0">
      <div className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">{title}</div>
      {side ? (
        <div className="space-y-1 text-sm">
          <div className="font-semibold truncate" title={side.name}>{side.name}</div>
          <div className="text-text-muted truncate">{side.company || (side.entityType === 'AGENCY' ? 'Агентство' : 'Без агентства')}</div>
          <div className="font-mono text-xs">{side.phone || 'Телефон не указан'}</div>
        </div>
      ) : <div className="text-sm text-text-muted">Карточка не найдена</div>}
    </div>
  );
}

function ReconciliationCard({ item, busy, onDecision }: {
  item: ReconciliationCase;
  busy: boolean;
  onDecision: (item: ReconciliationCase, decision: ReconciliationDecisionAction) => void;
}) {
  const decided = Boolean(item.decision);
  const canUnlink = item.decision === 'LINK';
  const canDecide = item.status === 'OPEN' && !decided;
  return (
    <article className="rounded-xl border border-border bg-background p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold">Кандидат на связь</div>
          <div className="text-xs text-text-muted mt-1">
            {[item.matchReason, ...item.matchCodes].filter(Boolean).join(' · ') || 'Причина совпадения не указана'}
            {item.score > 0 ? ` · сходство ${Math.round(item.score <= 1 ? item.score * 100 : item.score)}%` : ''}
          </div>
        </div>
        {decided && <span className="text-xs rounded-full bg-success/10 text-success px-2.5 py-1">{decisionLabels[item.decision] || item.decision}</span>}
      </div>

      <div className="grid md:grid-cols-[1fr_auto_1fr] gap-2 items-center">
        <SideCard title="База Анны Скибицкой" side={item.anna} />
        <Link2 className="w-5 h-5 text-text-muted mx-auto rotate-90 md:rotate-0" aria-hidden="true" />
        <SideCard title="Наша база" side={item.ours} />
      </div>

      <div className="flex flex-wrap gap-2">
        {canDecide && (
          <>
            <button disabled={busy} className="btn btn-primary inline-flex items-center gap-2" onClick={() => onDecision(item, 'LINK')}>
              <Check className="w-4 h-4" /> Подтвердить связь
            </button>
            <button disabled={busy} className="btn btn-secondary inline-flex items-center gap-2" onClick={() => onDecision(item, 'KEEP_SEPARATE')}>
              <Unlink2 className="w-4 h-4" /> Разные карточки
            </button>
            <button disabled={busy} className="btn btn-secondary inline-flex items-center gap-2" onClick={() => onDecision(item, 'REJECT_MATCH')}>
              <X className="w-4 h-4" /> Отклонить совпадение
            </button>
          </>
        )}
        {canUnlink && (
          <button disabled={busy} className="btn btn-secondary inline-flex items-center gap-2 ml-auto" onClick={() => onDecision(item, 'UNLINK')}>
            <RefreshCcw className="w-4 h-4" /> Отменить связь
          </button>
        )}
      </div>
    </article>
  );
}

export function LoyaltyReconciliation() {
  const [view, setView] = useState<'candidates' | 'links'>('candidates');
  const [data, setData] = useState<ReconciliationResponse | null>(null);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('OPEN');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getReconciliationCases({ page, pageSize, status, search }));
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить сверку');
    } finally {
      setLoading(false);
    }
  }, [page, search, status]);

  useEffect(() => { void load(); }, [load]);
  const decide = async (item: ReconciliationCase, decision: ReconciliationDecisionAction) => {
    const destructiveText = decision === 'UNLINK'
      ? 'Отменить текущее решение? История сохранится.'
      : 'Сохранить это решение по сверке?';
    if (!window.confirm(destructiveText)) return;
    setBusyId(item.id);
    setError('');
    try {
      await decideReconciliationCase(item.id, decision, item.version);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось сохранить решение');
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="reconciliation-title">
      <div className="rounded-xl border border-info/25 bg-info/5 p-4 flex gap-3">
        <AlertCircle className="w-5 h-5 text-info shrink-0 mt-0.5" />
        <div>
          <h2 id="reconciliation-title" className="font-semibold">Сверка: База Анны Скибицкой ↔ Наша база</h2>
          <p className="text-sm text-text-muted mt-1">Записи двух баз показаны раздельно. Решение создаёт связь или отклоняет кандидата, но не сливает и не удаляет исходные карточки.</p>
        </div>
      </div>

      <nav className="inline-flex rounded-xl bg-surface-secondary p-1" aria-label="Раздел сверки">
        <button type="button" aria-pressed={view === 'candidates'} className={`px-4 py-2 rounded-lg text-sm font-medium ${view === 'candidates' ? 'bg-surface text-accent shadow-sm' : 'text-text-muted'}`} onClick={() => setView('candidates')}>Кандидаты</button>
        <button type="button" aria-pressed={view === 'links'} className={`px-4 py-2 rounded-lg text-sm font-medium ${view === 'links' ? 'bg-surface text-accent shadow-sm' : 'text-text-muted'}`} onClick={() => setView('links')}>Активные связи</button>
      </nav>

      {view === 'links' ? <LoyaltyActiveLinks /> : <>

      <div className="card p-4 flex flex-col md:flex-row gap-3">
        <form className="relative flex-1" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(searchInput.trim()); }}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input className="input pl-10" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Поиск по имени, телефону или агентству" />
        </form>
        <select className="input md:w-56" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} aria-label="Статус сверки">
          <option value="OPEN">Ожидают решения</option>
          <option value="RESOLVED">Решение принято</option>
          <option value="DISMISSED">Сняты со сверки</option>
          <option value="">Все</option>
        </select>
        <button className="btn btn-secondary" type="button" onClick={() => void load()}><RefreshCcw className="w-4 h-4" /></button>
      </div>

      {error && <div className="rounded-lg bg-error/10 text-error p-4">{error}</div>}
      {error && !data ? null : loading ? <div className="card py-16 text-center text-text-muted">Загружаем кандидатов…</div>
        : !data?.items.length ? <div className="card py-16 text-center"><div className="font-semibold">Кандидатов нет</div><div className="text-sm text-text-muted mt-1">Измените фильтры или запустите сверку на backend.</div></div>
          : <div className="space-y-3">{data.items.map((item) => <ReconciliationCard key={item.id} item={item} busy={busyId === item.id} onDecision={decide} />)}</div>}

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-muted">Страница {data.page} из {data.totalPages} · {data.total} кандидатов</span>
          <div className="flex gap-2">
            <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft className="w-4 h-4" /></button>
            <button className="btn btn-secondary" disabled={page >= data.totalPages} onClick={() => setPage((value) => Math.min(data.totalPages, value + 1))}><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>
      )}
      </>}
    </section>
  );
}
