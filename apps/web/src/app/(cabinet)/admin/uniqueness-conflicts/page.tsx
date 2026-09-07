'use client';

// A3 (2026-05-24): UI для менеджеров — решение конфликтов уникальности.
// Когда броkер пытается зафиксировать клиента с уже занятым телефоном,
// клиент уходит в статус UNDER_REVIEW. Здесь менеджер видит: кто пытается
// зафиксировать, у кого уже есть активная фиксация/сделка/встреча,
// и решает — одобрить (CONDITIONALLY_UNIQUE) или отклонить (REJECTED).

import { useEffect, useState } from 'react';
import { apiGet, apiPatch } from '@/lib/api';
import AmoHealthBanner from '@/components/AmoHealthBanner';
import { useAuth } from '@/lib/auth';
import { AlertTriangle, CheckCircle2, XCircle, User, Phone, Calendar, Building } from 'lucide-react';

type ExistingClaim = {
  id: string;
  broker: { id: string; fullName: string; phone: string } | null;
  uniquenessStatus: string;
  uniquenessExpiresAt: string | null;
  fixationStatus: string | null;
  project: string | null;
  createdAt: string;
  meetingsCount: number;
  dealsCount: number;
  hasActiveDeal: boolean;
};

type Conflict = {
  conflictingClient: {
    id: string;
    fullName: string;
    phone: string;
    project: string | null;
    uniquenessReason: string | null;
    createdAt: string;
    broker: { id: string; fullName: string; phone: string } | null;
    dealsCount: number;
  };
  existingClaims: ExistingClaim[];
};

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  return new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
};

export default function UniquenessConflictsPage() {
  const { broker } = useAuth();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  const load = () => {
    setLoading(true);
    apiGet<Conflict[]>('/admin/uniqueness-conflicts')
      .then((d) => setConflicts(Array.isArray(d) ? d : []))
      .catch((e) => setMsg(e.message || 'Ошибка загрузки'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const resolve = async (clientId: string, status: 'CONDITIONALLY_UNIQUE' | 'REJECTED') => {
    const reason = (reasons[clientId] || '').trim();
    if (!reason) {
      setMsg('Укажите причину решения');
      return;
    }
    setResolving(clientId);
    setMsg('');
    try {
      await apiPatch(`/clients/${clientId}/resolve`, { status, reason });
      setMsg(status === 'CONDITIONALLY_UNIQUE' ? 'Одобрено — фиксация подтверждена' : 'Отклонено');
      setReasons((r) => { const n = { ...r }; delete n[clientId]; return n; });
      load();
      setTimeout(() => setMsg(''), 3000);
    } catch (e: any) {
      setMsg(e.message || 'Ошибка');
    } finally {
      setResolving(null);
    }
  };

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-2">
        <AlertTriangle className="w-7 h-7 text-warning" /> Конфликты уникальности
      </h1>
      <p className="text-sm text-text-muted mb-6">
        Клиенты со статусом UNDER_REVIEW. Сравните брокера-инициатора и того, у кого уже есть
        активная заявка/встреча/сделка по тому же телефону, и примите решение.
      </p>

      <AmoHealthBanner />

      {msg && (
        <div className="mb-4 p-3 bg-info/20 text-info rounded text-sm">{msg}</div>
      )}

      {loading && <div className="card">Загрузка…</div>}

      {!loading && conflicts.length === 0 && (
        <div className="card text-text-muted">Конфликтов нет.</div>
      )}

      <div className="space-y-6">
        {conflicts.map((c) => {
          const cl = c.conflictingClient;
          return (
            <div key={cl.id} className="card border-l-4 border-warning">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-4">
                <div>
                  <div className="font-semibold text-lg flex items-center gap-2">
                    <User className="w-5 h-5 text-accent" /> {cl.fullName}
                  </div>
                  <div className="text-sm text-text-muted flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                    <span className="flex items-center gap-1"><Phone className="w-4 h-4" /> {cl.phone}</span>
                    {cl.project && <span className="flex items-center gap-1"><Building className="w-4 h-4" /> {cl.project}</span>}
                    <span className="flex items-center gap-1"><Calendar className="w-4 h-4" /> {fmtDate(cl.createdAt)}</span>
                  </div>
                  {cl.uniquenessReason && (
                    <div className="text-xs text-warning mt-2">Причина системы: {cl.uniquenessReason}</div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div className="bg-surface-secondary p-3 rounded">
                  <div className="text-xs uppercase text-text-muted mb-2">Брокер-инициатор (новая фиксация)</div>
                  <div className="font-medium">{cl.broker?.fullName || '—'}</div>
                  <div className="text-sm text-text-muted">{cl.broker?.phone || ''}</div>
                  <div className="text-xs text-text-muted mt-2">Сделок у этого клиента: {cl.dealsCount}</div>
                </div>

                <div className="bg-surface-secondary p-3 rounded">
                  <div className="text-xs uppercase text-text-muted mb-2">
                    Конкурирующие записи ({c.existingClaims.length})
                  </div>
                  {c.existingClaims.length === 0 && (
                    <div className="text-sm text-text-muted">Других записей нет — проверьте причину UNDER_REVIEW.</div>
                  )}
                  <div className="space-y-2">
                    {c.existingClaims.map((ex) => (
                      <div key={ex.id} className="text-sm border-t border-border pt-2 first:border-t-0 first:pt-0">
                        <div className="font-medium">{ex.broker?.fullName || '—'}</div>
                        <div className="text-xs text-text-muted">{ex.broker?.phone || ''}</div>
                        <div className="text-xs text-text-muted mt-1 flex flex-wrap gap-x-3">
                          <span>Статус: {ex.uniquenessStatus}</span>
                          {ex.fixationStatus && <span>Фиксация: {ex.fixationStatus}</span>}
                          {ex.uniquenessExpiresAt && <span>До: {fmtDate(ex.uniquenessExpiresAt)}</span>}
                          <span>Встреч: {ex.meetingsCount}</span>
                          <span>Сделок: {ex.dealsCount}</span>
                        </div>
                        {ex.hasActiveDeal && (
                          <div className="text-xs text-warning mt-1">⚠ есть активная сделка</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <label className="block text-sm mb-2">Причина решения (видна брокерам и в истории)</label>
                <textarea
                  className="input w-full"
                  rows={2}
                  value={reasons[cl.id] || ''}
                  onChange={(e) => setReasons((r) => ({ ...r, [cl.id]: e.target.value }))}
                  placeholder="Например: первичная фиксация подтверждена у брокера N, новая — отклонена"
                />
                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    className="btn btn-primary inline-flex items-center gap-2"
                    disabled={resolving === cl.id}
                    onClick={() => resolve(cl.id, 'CONDITIONALLY_UNIQUE')}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Одобрить нового брокера
                  </button>
                  <button
                    className="btn btn-secondary inline-flex items-center gap-2"
                    disabled={resolving === cl.id}
                    onClick={() => resolve(cl.id, 'REJECTED')}
                  >
                    <XCircle className="w-4 h-4" />
                    Отклонить (оставить у другого)
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
