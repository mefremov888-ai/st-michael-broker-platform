'use client';

// 2026-07-17: страница ручного слияния дублей брокеров. Аудит нашёл 839 групп
// совпадающих ФИО (4562 записи). Решение: никакого автослияния — админ смотрит
// группу, выбирает основную карточку и жмёт «Слить» (телефоны и история
// переезжают, дубль скрывается но НЕ удаляется) или «Это разные люди»
// (группа больше не показывается). Доступ: только ADMIN.

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  Users, Search, ChevronLeft, ChevronRight, Merge, UserX,
  Phone as PhoneIcon, KeyRound, Link2, RefreshCw,
} from 'lucide-react';

type DedupBroker = {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  category: string;
  status: string;
  hasCabinet: boolean;
  hasAmo: boolean;
  isCoordinator: boolean;
  coordinatorAgency: string | null;
  specialization: string | null;
  doNotCall: boolean;
  baseSource: string | null;
  createdAt: string;
  lastCallAt: string | null;
  callCount: number;
  clientCount: number;
  dealCount: number;
};

type DedupGroup = { nameKey: string; count: number; brokers: DedupBroker[] };

type Response = {
  groups: DedupGroup[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

const catLabels: Record<string, { label: string; cls: string }> = {
  CONVERTED: { label: 'Конверсия', cls: 'bg-success/15 text-success' },
  HOT: { label: 'Горячий', cls: 'bg-danger/15 text-danger' },
  WARM: { label: 'Тёплый', cls: 'bg-warning/15 text-warning' },
  COLD: { label: 'Холодный', cls: 'bg-info/15 text-info' },
  ON_BOT_REVIEW: { label: 'На проверке', cls: 'bg-surface-secondary text-text-muted' },
  BLACKLIST: { label: 'Чёрный список', cls: 'bg-surface-secondary text-text-muted' },
};

const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString('ru-RU') : '—';

const formatPhone = (phone: string | null | undefined): string => {
  if (!phone) return '—';
  let d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  if (d.length === 11 && d.startsWith('7')) {
    return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  }
  return phone;
};

function GroupCard({ group, onDone }: { group: DedupGroup; onDone: () => void }) {
  const [primaryId, setPrimaryId] = useState<string>(() => {
    // Дефолт основной: зарегистрированный в кабинете, иначе связанный с amo,
    // иначе с наибольшей историей звонков.
    const withCabinet = group.brokers.find((b) => b.hasCabinet);
    if (withCabinet) return withCabinet.id;
    const withAmo = group.brokers.find((b) => b.hasAmo);
    if (withAmo) return withAmo.id;
    return [...group.brokers].sort((a, b) => b.callCount - a.callCount)[0]?.id || '';
  });
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(group.brokers.map((b) => b.id)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const duplicateIds = [...selected].filter((id) => id !== primaryId);

  const merge = async () => {
    if (!primaryId || duplicateIds.length === 0) return;
    if (!confirm(`Слить ${duplicateIds.length} карточек в «${group.brokers.find((b) => b.id === primaryId)?.fullName}»? Записи не удаляются, но из очереди КЦ пропадут.`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost('/admin/broker-dedup/merge', { primaryId, duplicateIds });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Не удалось слить');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/admin/broker-dedup/dismiss', { nameKey: group.nameKey });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Не удалось пометить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold capitalize flex items-center gap-2">
          <Users className="w-4 h-4 text-accent" />
          {group.nameKey}
          <span className="text-text-muted font-normal">— {group.count} записи(ей)</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={merge}
            disabled={busy || duplicateIds.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40 hover:opacity-90"
          >
            <Merge className="w-4 h-4" />
            Слить {duplicateIds.length > 0 ? `(${duplicateIds.length})` : ''}
          </button>
          <button
            onClick={dismiss}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-surface-secondary disabled:opacity-40"
            title="Группа больше не будет показываться как дубли"
          >
            <UserX className="w-4 h-4" />
            Это разные люди
          </button>
        </div>
      </div>
      {error && <div className="mb-3 text-sm text-danger">{error}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-muted border-b border-border">
              <th className="py-1.5 pr-2">Основная</th>
              <th className="py-1.5 pr-2">В слияние</th>
              <th className="py-1.5 pr-2">ФИО</th>
              <th className="py-1.5 pr-2">Телефон</th>
              <th className="py-1.5 pr-2">Категория</th>
              <th className="py-1.5 pr-2">Звонки</th>
              <th className="py-1.5 pr-2">Клиенты/сделки</th>
              <th className="py-1.5 pr-2">Метки</th>
              <th className="py-1.5">Создан</th>
            </tr>
          </thead>
          <tbody>
            {group.brokers.map((b) => {
              const cat = catLabels[b.category] || { label: b.category, cls: 'bg-surface-secondary' };
              return (
                <tr key={b.id} className={`border-b border-border/50 ${b.id === primaryId ? 'bg-accent/5' : ''}`}>
                  <td className="py-2 pr-2">
                    <input
                      type="radio"
                      name={`primary-${group.nameKey}`}
                      checked={primaryId === b.id}
                      onChange={() => setPrimaryId(b.id)}
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={selected.has(b.id)}
                      onChange={() => toggle(b.id)}
                      disabled={b.id === primaryId}
                    />
                  </td>
                  <td className="py-2 pr-2">{b.fullName}</td>
                  <td className="py-2 pr-2 whitespace-nowrap">
                    <span className="flex items-center gap-1">
                      <PhoneIcon className="w-3.5 h-3.5 text-text-muted" />
                      {formatPhone(b.phone)}
                    </span>
                  </td>
                  <td className="py-2 pr-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${cat.cls}`}>{cat.label}</span>
                  </td>
                  <td className="py-2 pr-2">
                    {b.callCount}
                    {b.lastCallAt ? <span className="text-text-muted"> (посл. {fmtDate(b.lastCallAt)})</span> : null}
                  </td>
                  <td className="py-2 pr-2">{b.clientCount} / {b.dealCount}</td>
                  <td className="py-2 pr-2">
                    <span className="flex items-center gap-1.5">
                      {b.hasCabinet && (
                        <span title="Зарегистрирован в кабинете"><KeyRound className="w-4 h-4 text-success" /></span>
                      )}
                      {b.hasAmo && (
                        <span title="Связан с amoCRM"><Link2 className="w-4 h-4 text-info" /></span>
                      )}
                      {b.isCoordinator && <span className="text-xs text-accent">КООРД</span>}
                      {b.doNotCall && <span className="text-xs text-danger">Не звонить</span>}
                    </span>
                  </td>
                  <td className="py-2 text-text-muted whitespace-nowrap">{fmtDate(b.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function BrokerDedupPage() {
  const { broker: me } = useAuth();
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (search) params.set('search', search);
    apiGet<Response>(`/admin/broker-dedup/groups?${params}`)
      .then(setData)
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, search]);

  if (me && me.role !== 'ADMIN') {
    return <div className="p-8 text-text-muted">Доступ только для администраторов</div>;
  }

  return (
    <div className="p-4 lg:p-8 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6 text-accent" />
            Дубли брокеров
          </h1>
          <p className="text-text-muted text-sm mt-1">
            Одинаковые ФИО с разными телефонами. Выберите основную карточку и слейте дубли —
            записи не удаляются, телефоны и история звонков собираются в одну карточку.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-surface-secondary"
        >
          <RefreshCw className="w-4 h-4" />
          Обновить
        </button>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(searchInput.trim()); }}
        className="flex gap-2 max-w-md"
      >
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Поиск по ФИО..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-surface border border-border text-sm"
          />
        </div>
        <button type="submit" className="px-4 py-2 rounded-lg bg-accent text-white text-sm">Найти</button>
      </form>

      {loading && <div className="text-text-muted py-8 text-center">Загрузка...</div>}

      {!loading && data && data.groups.length === 0 && (
        <div className="text-text-muted py-8 text-center">
          {search ? 'По запросу дублей не найдено' : 'Дублей больше нет — база чистая 🎉'}
        </div>
      )}

      {!loading && data && data.groups.map((g) => (
        <GroupCard key={g.nameKey} group={g} onDone={load} />
      ))}

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="p-2 rounded-lg border border-border disabled:opacity-40"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-text-muted">
            Стр. {data.page} из {data.totalPages} — всего групп: {data.total}
          </span>
          <button
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="p-2 rounded-lg border border-border disabled:opacity-40"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
