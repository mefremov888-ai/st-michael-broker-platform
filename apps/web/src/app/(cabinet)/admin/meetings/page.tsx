'use client';

import { useEffect, useState } from 'react';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { meetingAmoMark, meetingAmoMarkLabel, stripMeetingAmoMarks } from '@/lib/meeting-amo-marks';
import { Calendar, Check, X, Clock, ChevronLeft, ChevronRight } from 'lucide-react';

const statusLabels: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'Ожидает', cls: 'bg-warning/20 text-warning' },
  CONFIRMED: { label: 'Подтверждена', cls: 'bg-info/20 text-info' },
  COMPLETED: { label: 'Завершена', cls: 'bg-success/20 text-success' },
  CANCELLED: { label: 'Отменена', cls: 'bg-error/20 text-error' },
};

const typeLabels: Record<string, string> = {
  OFFICE_VISIT: 'В офисе', ONLINE: 'Онлайн', BROKER_TOUR: 'Брокер-тур',
};

export default function AdminMeetingsPage() {
  const { broker } = useAuth();
  const [meetings, setMeetings] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter) params.set('status', statusFilter);
    if (from) params.set('from', `${from}T00:00:00.000Z`);
    if (to) params.set('to', `${to}T23:59:59.999Z`);
    apiGet(`/admin/meetings?${params}`)
      .then((d: any) => {
        setMeetings(d.meetings || []);
        setTotal(d.total || 0);
        setTotalPages(d.totalPages || 1);
      })
      .catch(() => setMeetings([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [page, statusFilter, from, to]);

  const updateStatus = async (id: string, status: string) => {
    setMsg('');
    try {
      await api(`/admin/meetings/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setMsg(status === 'CONFIRMED' ? 'Подтверждено' : status === 'CANCELLED' ? 'Отменено' : 'Сохранено');
      load();
      setTimeout(() => setMsg(''), 2500);
    } catch (e: any) { setMsg(e.message || 'Ошибка'); }
  };

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6 flex items-center gap-2">
        <Calendar className="w-7 h-7 text-accent" /> Управление встречами
      </h1>

      {msg && <div className="mb-4 p-3 bg-info/20 text-info rounded text-sm">{msg}</div>}

      <div className="card mb-6 flex flex-wrap items-center gap-3">
        <select className="input w-auto" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="">Все статусы</option>
          <option value="PENDING">Ожидает</option>
          <option value="CONFIRMED">Подтверждена</option>
          <option value="COMPLETED">Завершена</option>
          <option value="CANCELLED">Отменена</option>
        </select>
        <input className="input w-auto" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-text-muted text-sm">—</span>
        <input className="input w-auto" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="text-sm text-text-muted ml-auto">Всего: {total}</span>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-text-muted">Загрузка…</div>
        ) : meetings.length === 0 ? (
          <div className="text-text-muted text-center py-8">Встречи не найдены</div>
        ) : (
          <div className="space-y-3">
            {meetings.map((m: any) => (
              <div key={m.id} className="flex items-center gap-3 py-3 border-b border-border last:border-0">
                <div className="w-14 h-14 bg-surface-secondary rounded-lg flex flex-col items-center justify-center flex-shrink-0">
                  <span className="font-bold text-sm">{new Date(m.date).toLocaleDateString('ru-RU', { day: '2-digit', timeZone: 'Europe/Moscow' })}</span>
                  <span className="text-text-muted text-xs">{new Date(m.date).toLocaleDateString('ru-RU', { month: 'short', timeZone: 'Europe/Moscow' })}</span>
                  <span className="text-text-muted text-[10px]">{new Date(m.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}</span>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{m.client?.fullName} <span className="text-text-muted">·</span> {typeLabels[m.type] || m.type}</div>
                  <div className="text-xs text-text-muted">
                    {m.client?.phone} → брокер: <span className="text-text">{m.broker?.fullName}</span> ({m.broker?.phone})
                  </div>
                  {stripMeetingAmoMarks(m.comment) && <div className="text-xs text-text-muted mt-1 whitespace-pre-wrap break-words">{stripMeetingAmoMarks(m.comment)}</div>}
                  {/* 2026-09-07: встреча PENDING с меткой backfill-а «[amo:...]» —
                      статус из amoCRM вернуть не удалось. Явный оранжевый бейдж,
                      чтобы не сливалась с обычным «Ожидает». */}
                  {meetingAmoMark(m.comment, m.status) && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-900">
                      <span className="h-1.5 w-1.5 rounded-full bg-orange-600" aria-hidden />
                      {meetingAmoMarkLabel(meetingAmoMark(m.comment, m.status)!)}
                    </span>
                  )}
                </div>

                <span className={`text-xs px-2 py-1 rounded whitespace-nowrap ${statusLabels[m.status]?.cls || ''}`}>
                  {statusLabels[m.status]?.label || m.status}
                </span>

                <div className="flex gap-1">
                  {m.status === 'PENDING' && (
                    <button className="btn btn-secondary text-success p-2" title="Подтвердить" onClick={() => updateStatus(m.id, 'CONFIRMED')}>
                      <Check className="w-4 h-4" />
                    </button>
                  )}
                  {m.status === 'CONFIRMED' && (
                    <button className="btn btn-secondary p-2" title="Отметить проведённой" onClick={() => updateStatus(m.id, 'COMPLETED')}>
                      <Clock className="w-4 h-4" />
                    </button>
                  )}
                  {m.status !== 'CANCELLED' && m.status !== 'COMPLETED' && (
                    <button className="btn btn-secondary text-error p-2" title="Отменить" onClick={() => updateStatus(m.id, 'CANCELLED')}>
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex justify-between items-center mt-4 pt-4 border-t border-border">
            <span className="text-sm text-text-muted">Стр. {page} из {totalPages}</span>
            <div className="flex gap-2">
              <button className="btn btn-secondary" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button className="btn btn-secondary" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
