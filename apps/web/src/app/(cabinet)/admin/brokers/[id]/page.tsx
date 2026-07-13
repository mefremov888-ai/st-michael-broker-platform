'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ArrowLeft, RefreshCw, Save, Shield, Trash2, Phone, Ban, Database } from 'lucide-react';

const categoryLabels: Record<string, { label: string; cls: string }> = {
  COLD: { label: 'COLD', cls: 'bg-info/20 text-info' },
  WARM: { label: 'WARM', cls: 'bg-warning/20 text-warning' },
  HOT: { label: 'HOT', cls: 'bg-error/20 text-error' },
  CONVERTED: { label: 'CONVERTED', cls: 'bg-success/20 text-success' },
  ON_BOT_REVIEW: { label: 'ON_BOT_REVIEW', cls: 'bg-text-muted/20 text-text-muted' },
  BLACKLIST: { label: 'BLACKLIST', cls: 'bg-text/20 text-text' },
};

const callResultLabels: Record<string, string> = {
  NDZ: 'НДЗ', DOUBLE_NDZ: '2 НДЗ', HUNG_UP: 'Бросил трубку',
  INFORMED: 'Проинформирован', ALREADY_KNOWS: 'Уже знал', ONLY_SEND_INFO: 'Только инфо',
  SCHEDULED_TOUR: 'Запись на БТ', IN_PROGRESS: 'В работе', REFUSED_TOUR: 'Отказ от БТ',
  WRONG_NUMBER: 'Некорректный номер', NOT_A_BROKER: 'Не брокер', NOT_BROKER_ANYMORE: 'Уже не брокер',
  REFUSED_COMMUNICATION: 'Отказ от коммуникации', ASKED_NOT_TO_CALL: 'Просил не звонить',
  NEGATIVE: 'Негатив', NOT_RELEVANT: 'Неактуально',
};

const roleOptions = [
  { value: 'BROKER', label: 'Брокер' },
  { value: 'MANAGER', label: 'Менеджер' },
  { value: 'ADMIN', label: 'Админ' },
];
const statusOptions = [
  { value: 'ACTIVE', label: 'Активен' },
  { value: 'PENDING', label: 'Ожидает' },
  { value: 'BLOCKED', label: 'Заблокирован' },
];

export default function AdminBrokerDetailPage() {
  const { broker: currentUser } = useAuth();
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [broker, setBroker] = useState<any>(null);
  const [deals, setDeals] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'profile' | 'clients' | 'deals' | 'meetings' | 'calls'>('profile');

  const [form, setForm] = useState({ fullName: '', email: '', phone: '', role: 'BROKER', status: 'ACTIVE' });
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');

  if (currentUser && currentUser.role !== 'ADMIN' && currentUser.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = currentUser?.role === 'ADMIN';

  const load = async () => {
    setLoading(true);
    try {
      const [b, d, c, m] = await Promise.all([
        apiGet(`/admin/brokers/${id}`),
        apiGet(`/admin/brokers/${id}/deals?limit=10`),
        apiGet(`/admin/brokers/${id}/clients?limit=10`),
        apiGet(`/admin/brokers/${id}/meetings?limit=10`),
      ]);
      setBroker(b);
      setForm({
        fullName: b.fullName || '',
        email: b.email || '',
        phone: b.phone || '',
        role: b.role || 'BROKER',
        status: b.status || 'ACTIVE',
      });
      setDeals(d.deals || []);
      setClients(c.clients || []);
      setMeetings(m.meetings || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { if (id) load(); }, [id]);

  const handleSave = async () => {
    setSaving(true); setMessage('');
    try {
      await api(`/admin/brokers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fullName: form.fullName, email: form.email, phone: form.phone }),
      });
      if (form.role !== broker.role && isAdmin) {
        await api(`/admin/brokers/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role: form.role }) });
      }
      if (form.status !== broker.status && isAdmin) {
        await api(`/admin/brokers/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: form.status }) });
      }
      setMessage('Сохранено');
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка сохранения'); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm(`Удалить брокера "${broker.fullName}" со всеми его клиентами, сделками и встречами? Это действие необратимо.`)) return;
    setSaving(true); setMessage('');
    try {
      await api(`/admin/brokers/${id}`, { method: 'DELETE' });
      router.push('/admin/brokers');
    } catch (e: any) {
      setMessage(e.message || 'Ошибка удаления');
      setSaving(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true); setMessage('');
    try {
      const r: any = await api(`/admin/brokers/${id}/sync-amo`, { method: 'PATCH' });
      setMessage(`Синхронизация: +${r.dealsCreated || 0} сделок, +${r.clientsCreated || 0} клиентов`);
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка синхронизации'); }
    setSyncing(false);
  };

  if (loading) return <div className="text-center py-8 text-text-muted">Загрузка...</div>;
  if (!broker) return <div className="card">Брокер не найден</div>;

  return (
    <div>
      <button onClick={() => router.push('/admin/brokers')} className="btn btn-secondary flex items-center gap-2 mb-4">
        <ArrowLeft className="w-4 h-4" /> К списку
      </button>

      <div className="flex items-start justify-between mb-6 gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2 flex-wrap">
            <Shield className="w-7 h-7 text-accent flex-shrink-0" />
            {broker.fullName}
            {broker.category && categoryLabels[broker.category] && (
              <span className={`text-xs px-2 py-1 rounded ${categoryLabels[broker.category].cls}`}>
                {categoryLabels[broker.category].label}
              </span>
            )}
            {broker.doNotCall && (
              <span className="text-xs px-2 py-1 rounded bg-error/20 text-error inline-flex items-center gap-1">
                <Ban className="w-3 h-3" /> не звонить
              </span>
            )}
            {broker.isInBase && (
              <span className="text-xs px-2 py-1 rounded bg-accent/20 text-accent inline-flex items-center gap-1">
                <Database className="w-3 h-3" /> в базе КЦ
              </span>
            )}
            {/* 2026-06-29 (refactor): флаг координатора убран. */}
          </h1>
          <div className="text-text-muted text-sm mt-1">
            {broker.phone} · amoCRM ID: {broker.amoContactId ? broker.amoContactId.toString() : '—'}
          </div>
          {(broker.lastCallAt || broker.nextCallAt) && (
            <div className="text-xs text-text-muted mt-1 flex gap-4">
              {broker.lastCallAt && <span>Последний звонок: {new Date(broker.lastCallAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</span>}
              {broker.nextCallAt && <span>Перезвонить: {new Date(broker.nextCallAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</span>}
            </div>
          )}
        </div>
        <button onClick={handleSync} disabled={syncing} className="btn btn-secondary flex items-center gap-2 flex-shrink-0">
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Синхр…' : 'Синхр. amoCRM'}
        </button>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      <div className="flex gap-2 mb-4 border-b border-border overflow-x-auto">
        {(['profile', 'clients', 'deals', 'meetings', 'calls'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition whitespace-nowrap ${tab === t ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text'}`}
          >
            {t === 'profile' ? 'Профиль' :
             t === 'clients' ? `Клиенты (${broker._count?.clients ?? 0})` :
             t === 'deals' ? `Сделки (${broker._count?.deals ?? 0})` :
             t === 'meetings' ? `Встречи (${broker._count?.meetings ?? 0})` :
             `Звонки (${broker._count?.callLogs ?? 0})`}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div className="card">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="label">ФИО</label>
              <input className="input" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </div>
            <div>
              <label className="label">Телефон</label>
              <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="label">Роль</label>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} disabled={!isAdmin}>
                {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {!isAdmin && <div className="text-xs text-text-muted mt-1">Только админ может менять роль</div>}
            </div>
            <div>
              <label className="label">Статус</label>
              <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} disabled={!isAdmin}>
                {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Этап воронки</label>
              <input className="input bg-surface-secondary" value={broker.funnelStage} readOnly />
            </div>
          </div>

          <div className="text-sm text-text-muted mb-4">
            Зарегистрирован: {new Date(broker.createdAt).toLocaleDateString('ru-RU')}
            {broker.brokerAgencies?.length > 0 && <> · Агентств: {broker.brokerAgencies.length}</>}
          </div>

          {/* КБ6 (2026-05-25): статус договора-оферты. */}
          <div className="mb-4 p-3 rounded-lg border border-border bg-surface-secondary">
            <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Договор-оферта о сотрудничестве</div>
            {Array.isArray(broker.offerAcceptances) && broker.offerAcceptances.length > 0 ? (
              <>
                <div className="text-sm font-medium text-success">
                  ✓ Подписан · версия {broker.offerAcceptances[0].offerVersion} · {new Date(broker.offerAcceptances[0].acceptedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                </div>
                {broker.offerAcceptances[0].ip && (
                  <div className="text-xs text-text-muted mt-1">IP: {broker.offerAcceptances[0].ip}</div>
                )}
                {broker.offerAcceptances[0].signedPdfUrl && (
                  <a href={broker.offerAcceptances[0].signedPdfUrl} target="_blank" rel="noreferrer" className="text-xs text-accent underline mt-1 inline-block">Скачать PDF</a>
                )}
                {broker.offerAcceptances.length > 1 && (
                  <div className="text-xs text-text-muted mt-1">+ {broker.offerAcceptances.length - 1} ранее подписанных версий</div>
                )}
              </>
            ) : (
              <div className="text-sm text-warning">⚠ Не подписан</div>
            )}
          </div>

          <div className="flex gap-2">
            <button className="btn btn-primary flex items-center gap-2" onClick={handleSave} disabled={saving}>
              <Save className="w-4 h-4" /> {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            {isAdmin && (
              <button className="btn btn-secondary flex items-center gap-2 text-error ml-auto" onClick={handleDelete} disabled={saving} title="Удалить брокера со всеми данными">
                <Trash2 className="w-4 h-4" /> Удалить
              </button>
            )}
          </div>
        </div>
      )}

      {tab === 'clients' && (
        <div className="card">
          {clients.length === 0 ? (
            <div className="text-text-muted text-center py-6">Нет клиентов</div>
          ) : (
            <div className="space-y-2">
              {clients.map((c: any) => (
                <ClientRowWithStatus
                  key={c.id}
                  client={c}
                  isAdmin={isAdmin}
                  onUpdated={(newStatus) => {
                    setClients((prev) => prev.map((x: any) => x.id === c.id ? { ...x, uniquenessStatus: newStatus } : x));
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'deals' && (
        <div className="card">
          {deals.length === 0 ? (
            <div className="text-text-muted text-center py-6">Нет сделок</div>
          ) : (
            <div className="space-y-2">
              {deals.map((d: any) => (
                <div key={d.id} className="flex justify-between items-center py-2 border-b border-border last:border-0 text-sm">
                  <div>
                    <div className="font-medium">{d.client?.fullName}</div>
                    <div className="text-text-muted text-xs">{d.project} · {d.status}</div>
                  </div>
                  <div className="font-bold text-accent">{Math.round(Number(d.amount)).toLocaleString('ru-RU')} ₽</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'meetings' && (
        <div className="card">
          {meetings.length === 0 ? (
            <div className="text-text-muted text-center py-6">Нет встреч</div>
          ) : (
            <div className="space-y-2">
              {meetings.map((m: any) => (
                <div key={m.id} className="flex justify-between items-center py-2 border-b border-border last:border-0 text-sm">
                  <div>
                    <div className="font-medium">{m.client?.fullName}</div>
                    <div className="text-text-muted text-xs">{m.type} · {new Date(m.date).toLocaleString('ru-RU')}</div>
                  </div>
                  <div className="text-text-muted text-xs">{m.status}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'calls' && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm flex items-center gap-2"><Phone className="w-4 h-4" /> История звонков колл-центра</h3>
            <a href="/admin/call-center" className="text-xs text-accent hover:underline">→ открыть в колл-центре</a>
          </div>
          {(!broker.callLogs || broker.callLogs.length === 0) ? (
            <div className="text-text-muted text-center py-6">Звонков не было</div>
          ) : (
            <div className="space-y-3">
              {broker.callLogs.map((c: any) => (
                <div key={c.id} className="border-l-2 border-accent/30 pl-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{callResultLabels[c.result] || c.result}</span>
                    {c.campaign && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent">{c.campaign}</span>
                    )}
                    <span className="text-xs text-text-muted ml-auto">
                      {new Date(c.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
                    </span>
                  </div>
                  {c.comment && <div className="text-xs text-text-muted mt-1 italic whitespace-pre-wrap">{c.comment}</div>}
                  <div className="text-[10px] text-text-muted mt-1 flex gap-3">
                    {c.duration && <span>длительность: {c.duration} сек</span>}
                    {c.nextCallAt && <span>перезвонить: {new Date(c.nextCallAt).toLocaleDateString('ru-RU')}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 2026-06-17: ручная смена uniquenessStatus админом из вкладки «Клиенты»
// на странице брокера. Только для критических случаев — если автоматика
// не довела клиента до правильного статуса (баг, race condition,
// ручная правка в amoCRM).
const STATUS_LABELS: Record<string, string> = {
  CONDITIONALLY_UNIQUE: 'Условно уникален',
  UNDER_REVIEW: 'На проверке',
  REJECTED: 'Отклонён',
};
function ClientRowWithStatus({ client, isAdmin, onUpdated }: { client: any; isAdmin: boolean; onUpdated: (newStatus: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [newStatus, setNewStatus] = useState<string>(client.uniquenessStatus);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (reason.trim().length < 3) { setError('Нужна причина (минимум 3 символа)'); return; }
    setSaving(true); setError('');
    try {
      await api(`/admin/clients/${client.id}/uniqueness-status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus, reason: reason.trim() }),
      });
      onUpdated(newStatus);
      setEditing(false);
      setReason('');
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-2 border-b border-border last:border-0 text-sm">
      <div className="flex justify-between items-center">
        <div>
          <div className="font-medium">{client.fullName}</div>
          <div className="text-text-muted text-xs">{client.phone}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-1 rounded bg-text-muted/20">
            {STATUS_LABELS[client.uniquenessStatus] || client.uniquenessStatus}
          </span>
          {isAdmin && !editing && (
            <button
              className="text-xs text-accent hover:underline"
              onClick={() => { setEditing(true); setNewStatus(client.uniquenessStatus); }}
            >
              Сменить
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 p-3 bg-surface-secondary rounded-lg space-y-2">
          <div className="text-xs text-warning">⚠️ Только для критических случаев. Изменение пишется в audit log.</div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-muted">Новый статус</label>
            <select
              className="input text-sm"
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value)}
            >
              {Object.entries(STATUS_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-muted">Причина (обязательно)</label>
            <textarea
              className="input text-sm"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: webhook от amo не пришёл, выставил вручную"
            />
          </div>
          {error && <div className="text-xs text-error">{error}</div>}
          <div className="flex gap-2 justify-end">
            <button
              className="text-xs px-3 py-1 rounded border border-border"
              onClick={() => { setEditing(false); setReason(''); setError(''); }}
              disabled={saving}
            >
              Отмена
            </button>
            <button
              className="text-xs px-3 py-1 rounded bg-accent text-white"
              onClick={save}
              disabled={saving}
            >
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
