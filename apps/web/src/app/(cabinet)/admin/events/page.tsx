'use client';

import { useEffect, useState } from 'react';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Calendar, Plus, Trash2, Save } from 'lucide-react';

type EventItem = {
  id: string;
  date: string;
  title: string;
  location: string | null;
  isOnline: boolean;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

export default function AdminEventsPage() {
  const { broker } = useAuth();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  // Дефолтное значение — ближайший круглый час МСК (минуты :00).
  // Раньше при первом фокусе на input datetime-local подставлялось
  // текущее время с минутами (например 11:23), что было неудобно.
  const defaultEventDate = () => {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  };
  const [draft, setDraft] = useState({ date: defaultEventDate(), title: '', location: '', isOnline: false, description: '' });

  // Конвертация ISO-даты из БД (UTC) в строку для datetime-local в МСК.
  // Раньше использовали ev.date.slice(0,16) — это бралo UTC-строку как
  // была, и админ видел не своё локальное время. Теперь явный МСК.
  const toLocalInputValue = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const moscow = new Date(d.getTime() + (180 + d.getTimezoneOffset()) * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${moscow.getFullYear()}-${pad(moscow.getMonth() + 1)}-${pad(moscow.getDate())}T${pad(moscow.getHours())}:${pad(moscow.getMinutes())}`;
  };

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = broker?.role === 'ADMIN';

  const load = () => {
    setLoading(true);
    apiGet('/admin/cms/events?all=1')
      .then((d) => setEvents(d || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleCreate = async () => {
    if (!draft.date || !draft.title) return;
    setCreating(true); setMessage('');
    try {
      await api('/admin/cms/events', { method: 'POST', body: JSON.stringify(draft) });
      setDraft({ date: defaultEventDate(), title: '', location: '', isOnline: false, description: '' });
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
    setCreating(false);
  };

  const handleSave = async (ev: EventItem) => {
    setMessage('');
    try {
      await api(`/admin/cms/events/${ev.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          date: ev.date,
          title: ev.title,
          location: ev.location,
          isOnline: ev.isOnline,
          description: ev.description,
          isActive: ev.isActive,
        }),
      });
      setMessage('Сохранено');
      setTimeout(() => setMessage(''), 1500);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить событие?')) return;
    try {
      await api(`/admin/cms/events/${id}`, { method: 'DELETE' });
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка удаления'); }
  };

  const handleDuplicate = async (ev: EventItem) => {
    const d = new Date(ev.date);
    d.setDate(d.getDate() + 7);
    const pad = (n: number) => String(n).padStart(2, '0');
    const nextDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    try {
      await api('/admin/cms/events', { method: 'POST', body: JSON.stringify({ date: nextDate, title: ev.title, location: ev.location, isOnline: ev.isOnline, description: ev.description }) });
      load();
      setMessage('Дублировано на след. неделю');
      setTimeout(() => setMessage(''), 2000);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const handleDeletePast = async () => {
    const past = events.filter(ev => new Date(ev.date) < new Date());
    if (past.length === 0) return setMessage('Прошедших событий нет');
    if (!confirm(`Удалить ${past.length} прошедших событий?`)) return;
    await Promise.all(past.map(ev => api(`/admin/cms/events/${ev.id}`, { method: 'DELETE' }).catch(() => {})));
    load();
    setMessage(`Удалено ${past.length} событий`);
    setTimeout(() => setMessage(''), 2000);
  };

  const updateLocal = (idx: number, patch: Partial<EventItem>) => {
    const next = [...events];
    next[idx] = { ...next[idx], ...patch };
    setEvents(next);
  };

  return (
    <div data-tour={'cms-events-page'}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <Calendar className="w-7 h-7 text-accent" />События лендинга
          </h1>
          <span className="text-text-muted text-sm">Брокер-туры, вебинары, обучение</span>
        </div>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      {isAdmin && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-3">Добавить событие</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="label">Дата и время</label>
              <input type="datetime-local" className="input" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} step="3600" />
            </div>
            <div>
              <label className="label">Заголовок</label>
              <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div>
              <label className="label">Локация (или пусто, если онлайн)</label>
              <input className="input" value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={draft.isOnline} onChange={(e) => setDraft({ ...draft, isOnline: e.target.checked })} />
                Онлайн
              </label>
            </div>
          </div>
          <div className="mb-3">
            <label className="label">Описание (необязательно)</label>
            <textarea className="input" rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
          <button className="btn btn-primary flex items-center gap-2" onClick={handleCreate} disabled={creating || !draft.date || !draft.title}>
            <Plus className="w-4 h-4" /> {creating ? 'Создание...' : 'Создать'}
          </button>
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Все события ({events.length})</h2>
          {isAdmin && (
            <button className="btn btn-secondary text-error text-sm flex items-center gap-1" onClick={handleDeletePast}>
              <Trash2 className="w-4 h-4" /> Удалить прошедшие
            </button>
          )}
        </div>
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : events.length === 0 ? (
          <div className="text-text-muted text-center py-6">Нет событий</div>
        ) : (
          <div className="space-y-2">
            {events.map((ev, idx) => (
              <div key={ev.id} className="border border-border rounded p-3">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start">
                  <input type="datetime-local" className="input md:col-span-3" value={toLocalInputValue(ev.date)} onChange={(e) => updateLocal(idx, { date: e.target.value })} step="3600" disabled={!isAdmin} />
                  <input className="input md:col-span-3" value={ev.title} onChange={(e) => updateLocal(idx, { title: e.target.value })} disabled={!isAdmin} />
                  <input className="input md:col-span-2" placeholder="Локация" value={ev.location || ''} onChange={(e) => updateLocal(idx, { location: e.target.value })} disabled={!isAdmin} />
                  <label className="flex items-center gap-1 text-xs md:col-span-1">
                    <input type="checkbox" checked={ev.isOnline} onChange={(e) => updateLocal(idx, { isOnline: e.target.checked })} disabled={!isAdmin} /> Онлайн
                  </label>
                  <label className="flex items-center gap-1 text-xs md:col-span-1">
                    <input type="checkbox" checked={ev.isActive} onChange={(e) => updateLocal(idx, { isActive: e.target.checked })} disabled={!isAdmin} /> Активно
                  </label>
                  <div className="md:col-span-2 flex gap-1 justify-end flex-wrap">
                    {isAdmin && (
                      <>
                        <button className="btn btn-primary text-sm" onClick={() => handleSave(ev)} title="Сохранить"><Save className="w-4 h-4" /></button>
                        <button className="btn btn-secondary text-sm" onClick={() => handleDuplicate(ev)} title="Дублировать на след. неделю"><Plus className="w-4 h-4" /></button>
                        <button className="btn btn-secondary text-error text-sm" onClick={() => handleDelete(ev.id)} title="Удалить"><Trash2 className="w-4 h-4" /></button>
                      </>
                    )}
                  </div>
                </div>
                <textarea className="input mt-2 text-sm" rows={1} placeholder="Описание" value={ev.description || ''} onChange={(e) => updateLocal(idx, { description: e.target.value })} disabled={!isAdmin} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
