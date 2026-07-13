'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Send, Megaphone, History } from 'lucide-react';

// 2026-07-02: работают только Email + Push. SMS/Telegram убраны.
const channelLabels: Record<string, string> = {
  EMAIL: 'Email', PUSH: 'Push',
};

const projectLabels: Record<string, string> = { ZORGE9: 'Зорге 9', SILVER_BOR: 'Серебряный Бор' };
const stageLabels: Record<string, string> = {
  NEW_BROKER: 'Новый брокер', BROKER_TOUR: 'Брокер-тур',
  FIXATION: 'Фиксация', MEETING: 'Встреча', DEAL: 'Сделка',
};
const levelLabels: Record<string, string> = {
  START: 'Старт', BASIC: 'Базовый', STRONG: 'Продвинутый',
  PREMIUM: 'Премиум', ELITE: 'Элит', CHAMPION: 'Чемпион', LEGEND: 'Легенда',
};

export default function AdminMailingsPage() {
  const { broker } = useAuth();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [channels, setChannels] = useState<string[]>(['EMAIL', 'PUSH']);
  const [filters, setFilters] = useState<any>({});
  const [preview, setPreview] = useState<{ count: number; sample: any[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  const loadHistory = () => {
    setHistoryLoading(true);
    apiGet('/admin/mailings?page=1&limit=20')
      .then((d: any) => setHistory(d.items || []))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  };

  useEffect(loadHistory, []);

  const cleanFilters = () => {
    const out: any = {};
    for (const [k, v] of Object.entries(filters)) {
      if (v) out[k] = v;
    }
    return out;
  };

  const doPreview = async () => {
    setPreviewing(true); setErr('');
    try {
      const r: any = await apiPost('/admin/mailings/preview', { filters: cleanFilters() });
      setPreview(r);
    } catch (e: any) { setErr(e.message || 'Ошибка'); }
    setPreviewing(false);
  };

  const doSend = async () => {
    setErr(''); setMsg('');
    if (!body.trim()) return setErr('Введите текст');
    if (channels.length === 0) return setErr('Выберите хотя бы один канал');
    if (!confirm(`Отправить рассылку на ${preview?.count || '?'} брокеров через каналы: ${channels.join(', ')}?`)) return;

    setSending(true);
    try {
      const r: any = await apiPost('/admin/mailings/send', {
        subject: subject || undefined,
        body,
        channels,
        filters: cleanFilters(),
      });
      setMsg(`Очередь: ${r.queued} уведомлений на ${r.recipientsCount} брокеров`);
      setSubject(''); setBody('');
      setPreview(null);
      loadHistory();
      setTimeout(() => setMsg(''), 4000);
    } catch (e: any) { setErr(e.message || 'Ошибка'); }
    setSending(false);
  };

  const toggleChannel = (ch: string) => {
    setChannels((p) => p.includes(ch) ? p.filter((c) => c !== ch) : [...p, ch]);
  };

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6 flex items-center gap-2">
        <Megaphone className="w-7 h-7 text-accent" /> Рассылки
      </h1>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6">
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2"><Send className="w-5 h-5" /> Новая рассылка</h2>

          {err && <div className="mb-3 p-3 bg-error/20 text-error rounded text-sm">{err}</div>}
          {msg && <div className="mb-3 p-3 bg-success/20 text-success rounded text-sm">{msg}</div>}

          <div className="space-y-3">
            <div>
              <label className="label">Заголовок (необязательно)</label>
              <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Заголовок уведомления" />
            </div>
            <div>
              <label className="label">Текст сообщения *</label>
              <textarea className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Текст для отправки брокерам..." />
            </div>

            <div>
              <label className="label">Каналы доставки</label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(channelLabels).map(([k, v]) => (
                  <label key={k} className={`cursor-pointer px-3 py-1.5 rounded-lg border text-sm ${channels.includes(k) ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:bg-surface-secondary'}`}>
                    <input type="checkbox" checked={channels.includes(k)} onChange={() => toggleChannel(k)} className="hidden" />
                    {v}
                  </label>
                ))}
              </div>
            </div>

            <div className="border-t border-border pt-3 mt-3">
              <h3 className="font-semibold text-sm mb-3">Сегментация</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Проект</label>
                  <select className="input" value={filters.project || ''} onChange={(e) => setFilters({ ...filters, project: e.target.value })}>
                    <option value="">Все проекты</option>
                    {Object.entries(projectLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Этап воронки</label>
                  <select className="input" value={filters.funnelStage || ''} onChange={(e) => setFilters({ ...filters, funnelStage: e.target.value })}>
                    <option value="">Все этапы</option>
                    {Object.entries(stageLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Уровень комиссии</label>
                  <select className="input" value={filters.commissionLevel || ''} onChange={(e) => setFilters({ ...filters, commissionLevel: e.target.value })}>
                    <option value="">Любой уровень</option>
                    {Object.entries(levelLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Статус</label>
                  <select className="input" value={filters.status || ''} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                    <option value="">Активные (по умолчанию)</option>
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="PENDING">PENDING</option>
                    <option value="BLOCKED">BLOCKED</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button className="btn btn-secondary" onClick={doPreview} disabled={previewing}>
                {previewing ? '...' : 'Подсчитать получателей'}
              </button>
              {preview && (
                <button className="btn btn-primary flex-1" onClick={doSend} disabled={sending || !body.trim() || channels.length === 0}>
                  {sending ? 'Отправка...' : `Отправить (${preview.count})`}
                </button>
              )}
            </div>

            {preview && (
              <div className="mt-3 p-3 bg-surface-secondary rounded text-sm">
                <div className="font-medium mb-2">Получателей: <span className="text-accent">{preview.count}</span></div>
                {preview.sample.length > 0 && (
                  <div className="text-xs text-text-muted">
                    <div className="mb-1">Примеры:</div>
                    {preview.sample.map((s: any) => (
                      <div key={s.id}>{s.fullName} · {s.phone}</div>
                    ))}
                    {preview.count > preview.sample.length && <div className="mt-1">… и ещё {preview.count - preview.sample.length}</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2"><History className="w-5 h-5" /> История</h2>
          {historyLoading ? (
            <div className="text-text-muted">Загрузка…</div>
          ) : history.length === 0 ? (
            <div className="text-text-muted">Рассылок пока не было</div>
          ) : (
            <div className="space-y-3">
              {history.map((m: any) => (
                <div key={m.id} className="border-b border-border last:border-0 pb-3 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {m.subject && <div className="font-medium text-sm">{m.subject}</div>}
                      <div className="text-xs text-text-muted truncate">{m.body}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-sm font-bold text-accent">{m.recipientsCount}</div>
                      <div className="text-[10px] text-text-muted">{(m.channels as string[])?.join(', ')}</div>
                    </div>
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">{new Date(m.sentAt).toLocaleString('ru-RU')}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
