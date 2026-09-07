'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Calendar, Plus, Trash2 } from 'lucide-react';

const typeLabels: Record<string, string> = {
  OFFICE_VISIT: 'В офисе',
  ONLINE: 'Онлайн',
  BROKER_TOUR: 'Брокер-тур',
};

interface Slot {
  id: string;
  startsAt: string;
  durationMin: number;
  capacity: number;
  type: string | null;
  isActive: boolean;
  booked: number;
}

export default function AdminMeetingSlotsPage() {
  const { broker } = useAuth();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });

  // Bulk-create form
  const [bulkDays, setBulkDays] = useState<string[]>([]);
  const [bulkTimes, setBulkTimes] = useState<string[]>(['10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00']);
  const [bulkCapacity, setBulkCapacity] = useState(1);
  const [bulkDuration, setBulkDuration] = useState(60);
  const [bulkType, setBulkType] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState('');

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  const load = () => {
    setLoading(true);
    apiGet(`/meetings/slots?from=${from}T00:00:00.000Z&to=${to}T23:59:59.999Z`)
      .then((d: any) => setSlots(Array.isArray(d) ? d : []))
      .catch(() => setSlots([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [from, to]);

  const generateNextWeekdays = (count: number) => {
    const list: string[] = [];
    const d = new Date();
    while (list.length < count) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) list.push(d.toISOString().slice(0, 10));
    }
    return list;
  };

  const handleBulkCreate = async () => {
    if (!bulkDays.length || !bulkTimes.length) {
      setMsg('Выберите дни и время');
      return;
    }
    setCreating(true); setMsg('');
    try {
      const r: any = await apiPost('/meetings/slots', {
        days: bulkDays,
        times: bulkTimes,
        capacity: bulkCapacity,
        durationMin: bulkDuration,
        type: bulkType || undefined,
      });
      setMsg(`Создано слотов: ${r.created}`);
      load();
      setTimeout(() => setMsg(''), 3000);
    } catch (e: any) { setMsg(e.message || 'Ошибка'); }
    setCreating(false);
  };

  const toggleSlot = async (id: string, isActive: boolean) => {
    await api(`/meetings/slots/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !isActive }),
    }).then(load).catch((e) => setMsg(e.message || 'Ошибка'));
  };

  const deleteSlot = async (id: string) => {
    if (!confirm('Удалить слот? Если в нём есть встречи — удаление будет заблокировано.')) return;
    await api(`/meetings/slots/${id}`, { method: 'DELETE' })
      .then(load)
      .catch((e) => setMsg(e.message || 'Ошибка'));
  };

  // Group slots by date (в МСК — чтобы слот "02:00 22 мая МСК" не падал в группу "21 мая UTC")
  const groups: Record<string, Slot[]> = {};
  for (const s of slots) {
    // ru-RU 'sv-SE'-style yyyy-MM-dd в Europe/Moscow
    const d = new Date(s.startsAt);
    const day = `${d.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })}`; // en-CA даёт ISO yyyy-MM-dd
    if (!groups[day]) groups[day] = [];
    groups[day].push(s);
  }

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6 flex items-center gap-2">
        <Calendar className="w-7 h-7 text-accent" /> Расписание встреч
      </h1>

      {msg && <div className="mb-4 p-3 bg-info/20 text-info rounded text-sm">{msg}</div>}

      {/* Bulk-create */}
      <div className="card mb-6">
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Plus className="w-5 h-5" /> Массовое создание слотов
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Даты (по одной на строку)</label>
            <textarea
              className="input"
              rows={4}
              placeholder="2026-05-01&#10;2026-05-02&#10;..."
              value={bulkDays.join('\n')}
              onChange={(e) => setBulkDays(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
            />
            <div className="flex gap-2 mt-2 text-xs">
              <button className="text-accent hover:underline" onClick={() => setBulkDays(generateNextWeekdays(5))}>+ 5 будних дней</button>
              <button className="text-accent hover:underline" onClick={() => setBulkDays(generateNextWeekdays(10))}>+ 10 будних</button>
              <button className="text-accent hover:underline" onClick={() => setBulkDays([])}>Очистить</button>
            </div>
          </div>
          <div>
            <label className="label">Время (по одному на строку)</label>
            <textarea
              className="input"
              rows={4}
              value={bulkTimes.join('\n')}
              onChange={(e) => setBulkTimes(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
            />
          </div>
          <div>
            <label className="label">Длительность (мин)</label>
            <input className="input" type="number" min={15} step={15} value={bulkDuration} onChange={(e) => setBulkDuration(+e.target.value)} />
          </div>
          <div>
            <label className="label">Вместимость (встреч в слот)</label>
            <input className="input" type="number" min={1} value={bulkCapacity} onChange={(e) => setBulkCapacity(+e.target.value)} />
          </div>
          <div>
            <label className="label">Тип (необязательно)</label>
            <select className="input" value={bulkType} onChange={(e) => setBulkType(e.target.value)}>
              <option value="">Любой</option>
              {Object.entries(typeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-4">
          <button className="btn btn-primary" onClick={handleBulkCreate} disabled={creating || !bulkDays.length || !bulkTimes.length}>
            {creating ? 'Создание...' : `Создать слоты (${bulkDays.length} × ${bulkTimes.length})`}
          </button>
        </div>
      </div>

      {/* Filter / list */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <label className="text-sm">с</label>
          <input className="input w-auto" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label className="text-sm">по</label>
          <input className="input w-auto" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>

        {loading ? (
          <div className="text-text-muted">Загрузка…</div>
        ) : slots.length === 0 ? (
          <div className="text-text-muted">В этом диапазоне нет слотов</div>
        ) : (
          <div className="space-y-4">
            {Object.entries(groups).sort().map(([day, daySlots]) => (
              <div key={day}>
                <h3 className="font-semibold text-sm mb-2">
                  {new Date(day + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })}
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                  {daySlots.map((s) => {
                    const time = new Date(s.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
                    return (
                      <div key={s.id} className={`border rounded-lg p-2 text-sm ${s.isActive ? 'border-border' : 'border-border opacity-50 bg-surface-secondary'}`}>
                        <div className="flex justify-between items-center">
                          <div className="font-medium">{time}</div>
                          <button className="text-error hover:opacity-70" onClick={() => deleteSlot(s.id)} title="Удалить">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        <div className="text-xs text-text-muted mt-1">
                          {s.durationMin} мин · {s.booked}/{s.capacity}
                          {s.type ? ` · ${typeLabels[s.type] || s.type}` : ''}
                        </div>
                        <button
                          className="text-xs text-accent hover:underline mt-1"
                          onClick={() => toggleSlot(s.id, s.isActive)}
                        >
                          {s.isActive ? 'Отключить' : 'Включить'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
