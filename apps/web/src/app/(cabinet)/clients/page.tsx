'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Search, ChevronLeft, ChevronRight, X, AlertTriangle, Mail, Building, User, Phone as PhoneIcon, Calendar, FileText, CheckCircle2, AlertCircle, PhoneCall } from 'lucide-react';

const statusLabels: Record<string, { label: string; cls: string }> = {
  CONDITIONALLY_UNIQUE: { label: 'Уникален', cls: 'bg-success/20 text-success' },
  REJECTED: { label: 'Не уникален', cls: 'bg-error/20 text-error' },
  UNDER_REVIEW: { label: 'На проверке', cls: 'bg-warning/20 text-warning' },
  EXPIRED: { label: 'Истёк', cls: 'bg-text-muted/20 text-text-muted' },
};

// 2026-07-02: если А зафиксировал клиента на Б через «Фиксирую на другого
// брокера», уникальность принадлежит А (создателю). Б просто исполнитель —
// у него в списке НЕ должен светиться «Уникален». Определяем по паре
// (client.broker.id, client.responsibleBroker.id) — исполнитель это тот,
// кто отличается от creator'а и совпадает с responsible.
function isExecutorView(c: any, myBrokerId: string | undefined): boolean {
  if (!myBrokerId) return false;
  if (!c?.broker?.id || !c?.responsibleBroker?.id) return false;
  return c.broker.id !== c.responsibleBroker.id
    && c.broker.id !== myBrokerId
    && c.responsibleBroker.id === myBrokerId;
}

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный бор',
};

// Форматирование телефона в формат +7 (XXX) XXX-XX-XX.
// Правка 2026-05-13: нормализуем перед форматированием (раньше `09251234567`
// показывался как «+0 (925)...» — теперь всегда +7).
function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  let d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && !d.startsWith('7')) d = '7' + d.slice(1);
  if (d.length !== 11) return phone;
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`;
}

function daysUntilExpiry(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

// 2026-06-02: кнопка callback через Mango. Mango сначала наберёт телефон
// брокера (из его профиля), брокер берёт трубку — Mango соединяет с клиентом.
function CallButton({ clientId, variant = 'icon' }: { clientId: string; variant?: 'icon' | 'full' }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res: any = await apiPost('/broker-calls/initiate', { clientId });
      setMsg({ ok: true, text: res?.message || 'Mango сейчас наберёт вас.' });
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Не удалось инициировать звонок' });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 6000);
    }
  };

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={handle}
        disabled={busy}
        title="Позвонить клиенту через Mango (callback на ваш телефон)"
        className="p-1.5 rounded hover:bg-accent/10 text-accent disabled:opacity-50"
      >
        <PhoneCall className="w-4 h-4" />
      </button>
    );
  }

  return (
    <div className="inline-block">
      <button
        type="button"
        onClick={handle}
        disabled={busy}
        className="btn btn-primary flex items-center gap-2 text-sm"
      >
        <PhoneCall className="w-4 h-4" /> {busy ? 'Соединяю…' : 'Позвонить'}
      </button>
      {msg && (
        <div className={`mt-2 text-xs ${msg.ok ? 'text-success' : 'text-error'}`}>{msg.text}</div>
      )}
    </div>
  );
}

function CallHistory({ clientId }: { clientId: string }) {
  const [calls, setCalls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    apiGet(`/broker-calls?clientId=${clientId}&limit=20`)
      .then((d: any) => setCalls(d?.calls || []))
      .catch(() => setCalls([]))
      .finally(() => setLoading(false));
  }, [clientId]);

  if (loading) return <div className="text-xs text-text-muted">Загрузка истории…</div>;
  if (calls.length === 0) return <div className="text-xs text-text-muted italic">Звонков пока не было</div>;

  const statusLabel: Record<string, { label: string; cls: string }> = {
    INITIATED: { label: 'Соединяем…', cls: 'text-warning' },
    COMPLETED: { label: 'Завершён', cls: 'text-success' },
    NO_ANSWER: { label: 'Не ответил', cls: 'text-text-muted' },
    BUSY: { label: 'Занято', cls: 'text-text-muted' },
    UNAVAILABLE: { label: 'Недоступен', cls: 'text-text-muted' },
    FAILED: { label: 'Ошибка', cls: 'text-error' },
  };

  return (
    <div className="space-y-1.5">
      {calls.map((c) => (
        <div key={c.id} className="bg-surface-secondary rounded p-2 text-xs flex items-center justify-between">
          <div>
            <span className={statusLabel[c.status]?.cls || ''}>{statusLabel[c.status]?.label || c.status}</span>
            {c.durationSec ? <span className="text-text-muted ml-2">{Math.round(c.durationSec)} сек</span> : null}
          </div>
          <div className="flex items-center gap-2">
            {c.recordingUrl && (
              <a href={c.recordingUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">запись</a>
            )}
            <span className="text-text-muted">{new Date(c.initiatedAt || c.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// КБ6 (2026-05-25): расширенная карточка клиента.
// Грузим полные данные через GET /clients/:id (с deals, meetings, broker),
// показываем максимум информации из БД.
function ClientDetail({ client: shallowClient, onClose }: { client: any; onClose: () => void }) {
  const { broker } = useAuth();
  // 2026-06-09: разделение видимости карточки клиента по ролям.
  // Брокер НЕ видит: кнопку «Позвонить», поле «Статус клиента (NEW)»,
  // «Обновлено», «Агентство фиксации», «amoCRM Lead ID», блок ошибки
  // amoCRM, «История звонков», «История» (audit). Это техническая инфа
  // для КЦ/менеджеров, брокеру она только мешает.
  const isStaff = broker?.role === 'ADMIN' || broker?.role === 'MANAGER';
  const [client, setClient] = useState<any>(shallowClient);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet(`/clients/${shallowClient.id}`)
      .then((d: any) => setClient(d || shallowClient))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shallowClient.id]);

  const daysLeft = daysUntilExpiry(client.uniquenessExpiresAt);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-xl max-w-2xl w-full max-h-[92vh] overflow-y-auto p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={onClose}>
          <X className="w-5 h-5" />
        </button>

        <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
          <User className="w-5 h-5 text-accent" /> {client.fullName}
        </h2>
        <p className="text-text-muted text-sm mb-4 flex items-center gap-2">
          <PhoneIcon className="w-4 h-4" /> {formatPhone(client.phone)}
          {client.email && (
            <>
              <span className="mx-1">·</span>
              <Mail className="w-4 h-4" /> {client.email}
            </>
          )}
        </p>

        {/* 2026-06-02: callback через Mango — кнопка прямо в шапке карточки.
            2026-06-09: только для КЦ/менеджеров. Брокер не звонит клиенту через Mango. */}
        {isStaff && (
          <div className="mb-4">
            <CallButton clientId={client.id} variant="full" />
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {/* 2026-07-02: если брокер только исполнитель по фиксации (А зафиксировал
              на него) — не показываем «Уникален», показываем «Исполнитель»:
              уникальность принадлежит создателю (А). */}
          {isExecutorView(client, broker?.id) ? (
            <span className="text-xs px-2 py-1 rounded bg-info/20 text-info">
              Исполнитель по фиксации
            </span>
          ) : (
            <span className={`text-xs px-2 py-1 rounded ${statusLabels[client.uniquenessStatus]?.cls || 'bg-text-muted/20'}`}>
              {statusLabels[client.uniquenessStatus]?.label || client.uniquenessStatus}
            </span>
          )}
          {client.fixationStatus && client.fixationStatus !== 'NOT_FIXED' && (
            <span className="text-xs px-2 py-1 rounded bg-info/20 text-info">{client.fixationStatus}</span>
          )}
          {client.inspectionActSigned && (
            <span className="text-xs px-2 py-1 rounded bg-success/20 text-success inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Акт осмотра подписан
            </span>
          )}
          {isStaff && client.amoSyncStatus === 'FAILED' && (
            <span className="text-xs px-2 py-1 rounded bg-error/20 text-error inline-flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> Не передан в amoCRM
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm mb-4">
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Проект</span>
            <span className="font-medium flex items-center gap-1">
              <Building className="w-4 h-4" /> {projectLabels[client.project] || client.project}
            </span>
          </div>
          {isStaff && (
            <div className="bg-surface-secondary rounded-lg p-3">
              <span className="text-text-muted block text-xs">Статус клиента</span>
              <span className="font-medium">{client.status}</span>
            </div>
          )}
          {/* 2026-07-02: срок уникальности показываем только владельцу (creator).
              Исполнитель не имеет уникальности, ему таймер неактуален. */}
          {!isExecutorView(client, broker?.id) && (
            <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
              <span className="text-text-muted block text-xs flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Статус до
              </span>
              <span className="font-medium">
                {client.uniquenessExpiresAt ? new Date(client.uniquenessExpiresAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
              </span>
              {daysLeft !== null && (
                <div className={`text-xs mt-1 ${daysLeft < 0 ? 'text-error' : daysLeft <= 1 ? 'text-error' : daysLeft <= 7 ? 'text-warning' : 'text-text-muted'}`}>
                  {daysLeft < 0
                    ? `⚠ истекла ${-daysLeft} дн. назад`
                    : daysLeft === 0
                      ? '⚠ истекает сегодня'
                      : `осталось ${daysLeft} ${daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'} (можно продлить)`}
                </div>
              )}
            </div>
          )}
          {/* 2026-07-02: фиксация А → на Б.
              - У А (creator): «Зафиксирован мной на: {Б}» — уникальность у меня.
              - У Б (designated): «Зафиксирован на меня брокером: {А}» — вижу что мне отдали клиента.
              - Иначе (self-fix / staff): обычный «Брокер: {broker}». */}
          {client.broker && (() => {
            const iAmCreator = broker?.id && client.broker.id === broker.id;
            const iAmDesignated = broker?.id && client.responsibleBroker?.id === broker.id;
            const hasDelegation = client.responsibleBroker && client.responsibleBroker.id !== client.broker.id;
            if (hasDelegation && iAmCreator) {
              return (
                <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
                  <span className="text-text-muted block text-xs">Зафиксирован мной на</span>
                  <span className="font-medium">{client.responsibleBroker.fullName}</span>
                  <span className="text-xs text-text-muted ml-2">{formatPhone(client.responsibleBroker.phone)}</span>
                </div>
              );
            }
            if (hasDelegation && iAmDesignated) {
              return (
                <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
                  <span className="text-text-muted block text-xs">Зафиксирован на меня брокером</span>
                  <span className="font-medium">{client.broker.fullName}</span>
                  <span className="text-xs text-text-muted ml-2">{formatPhone(client.broker.phone)}</span>
                </div>
              );
            }
            // Staff (admin/manager) или обычная фиксация на себя — показываем обоих если они разные.
            if (hasDelegation) {
              return (
                <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
                  <span className="text-text-muted block text-xs">Зафиксировал → на</span>
                  <div className="font-medium">
                    {client.broker.fullName} <span className="text-text-muted">→</span> {client.responsibleBroker.fullName}
                  </div>
                  <div className="text-xs text-text-muted">
                    {formatPhone(client.broker.phone)} <span className="mx-1">·</span> {formatPhone(client.responsibleBroker.phone)}
                  </div>
                </div>
              );
            }
            return (
              <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
                <span className="text-text-muted block text-xs">Брокер</span>
                <span className="font-medium">{client.broker.fullName}</span>
                <span className="text-xs text-text-muted ml-2">{formatPhone(client.broker.phone)}</span>
              </div>
            );
          })()}
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Создано</span>
            <span className="font-medium">{new Date(client.createdAt).toLocaleDateString('ru-RU')}</span>
          </div>
          {isStaff && (
            <div className="bg-surface-secondary rounded-lg p-3">
              <span className="text-text-muted block text-xs">Обновлено</span>
              <span className="font-medium">{new Date(client.updatedAt || client.amoUpdatedAt || client.createdAt).toLocaleDateString('ru-RU')}</span>
            </div>
          )}
          {isStaff && client.fixationAgency && (
            <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
              <span className="text-text-muted block text-xs">Агентство фиксации</span>
              <span className="font-medium">{client.fixationAgency.name}</span>
              <span className="text-xs text-text-muted ml-2">ИНН {client.fixationAgency.inn}</span>
              {client.fixationAgency.phone && <span className="text-xs text-text-muted ml-2">{client.fixationAgency.phone}</span>}
            </div>
          )}
          {isStaff && client.amoLeadId && (
            <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
              <span className="text-text-muted block text-xs">amoCRM Lead ID</span>
              <span className="font-medium font-mono text-xs">{String(client.amoLeadId)}</span>
            </div>
          )}
        </div>

        {/* 2026-06-09: данные с формы фиксации — то, что брокер сам заполнил.
            Видно всем, включая брокера, чтобы он сам видел детали по своему клиенту. */}
        {(client.propertyType || client.roomsCount || client.amount || client.sqm ||
          client.clientRegion || client.purchaseTiming || client.readinessLevel) && (
          <div className="bg-surface-secondary rounded-lg p-3 mb-4">
            <span className="text-text-muted block text-xs mb-2 flex items-center gap-1">
              <FileText className="w-3 h-3" /> Данные заявки от брокера
            </span>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {client.propertyType && (
                <div>
                  <span className="text-text-muted text-xs block">Тип объекта</span>
                  <span className="font-medium">{client.propertyType}</span>
                </div>
              )}
              {client.roomsCount && (
                <div>
                  <span className="text-text-muted text-xs block">Кол-во комнат</span>
                  <span className="font-medium">{client.roomsCount}</span>
                </div>
              )}
              {client.sqm && (
                <div>
                  <span className="text-text-muted text-xs block">Метраж</span>
                  <span className="font-medium">{Number(client.sqm)} м²</span>
                </div>
              )}
              {client.amount && (
                <div>
                  <span className="text-text-muted text-xs block">Бюджет покупки</span>
                  <span className="font-medium">{Math.round(Number(client.amount)).toLocaleString('ru-RU')} ₽</span>
                </div>
              )}
              {client.clientRegion && (
                <div>
                  <span className="text-text-muted text-xs block">Регион клиента</span>
                  <span className="font-medium">{client.clientRegion}</span>
                </div>
              )}
              {client.purchaseTiming && (
                <div>
                  <span className="text-text-muted text-xs block">Планирует покупку</span>
                  <span className="font-medium">{client.purchaseTiming}</span>
                </div>
              )}
              {client.readinessLevel && (
                <div>
                  <span className="text-text-muted text-xs block">Готовность к сделке</span>
                  <span className="font-medium">{client.readinessLevel}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {client.comment && (
          <div className="bg-surface-secondary rounded-lg p-3 mb-4">
            <span className="text-text-muted block text-xs mb-1 flex items-center gap-1">
              <FileText className="w-3 h-3" /> Комментарий брокера
            </span>
            <span className="text-sm whitespace-pre-wrap">{client.comment}</span>
          </div>
        )}

        {isStaff && client.amoSyncStatus === 'FAILED' && client.amoSyncError && (
          <div className="bg-error/10 border border-error/30 rounded-lg p-3 mb-4">
            <span className="text-text-muted block text-xs mb-1 text-error">amoCRM ошибка</span>
            <span className="text-xs font-mono break-all">{client.amoSyncError}</span>
            <div className="text-xs text-text-muted mt-1">Попыток: {client.amoSyncAttempts || 0}</div>
          </div>
        )}

        {/* 2026-06-02: история звонков по клиенту — из broker-calls.
            2026-06-09: только для КЦ/менеджеров. */}
        {isStaff && (
          <div className="mb-4">
            <h3 className="text-sm font-medium mb-2 flex items-center gap-1">
              <PhoneCall className="w-4 h-4" /> История звонков
            </h3>
            <CallHistory clientId={client.id} />
          </div>
        )}

        {Array.isArray(client.meetings) && client.meetings.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-medium mb-2 flex items-center gap-1">
              <Calendar className="w-4 h-4" /> Встречи ({client.meetings.length})
            </h3>
            <div className="space-y-2">
              {client.meetings.map((m: any) => (
                <div key={m.id} className="bg-surface-secondary rounded-lg p-3 flex justify-between text-sm">
                  <span>{new Date(m.date).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
                  <span className="text-text-muted">{m.status}{m.type ? ` · ${m.type}` : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {Array.isArray(client.deals) && client.deals.length > 0 && (
          <div>
            <h3 className="text-sm font-medium mb-2">Сделки ({client.deals.length})</h3>
            <div className="space-y-2">
              {client.deals.map((deal: any) => (
                <div key={deal.id} className="bg-surface-secondary rounded-lg p-3 text-sm">
                  <div className="flex justify-between">
                    <span>{deal.status}{deal.contractType ? ` · ${deal.contractType}` : ''}</span>
                    {deal.amount && <span className="font-medium">{Math.round(Number(deal.amount)).toLocaleString('ru-RU')} ₽</span>}
                  </div>
                  <div className="flex justify-between text-xs text-text-muted mt-1">
                    {deal.lot && <span>{deal.lot.building || ''} {deal.lot.floor ? `${deal.lot.floor} эт.` : ''} {deal.lot.sqm ? `${deal.lot.sqm} м²` : ''}</span>}
                    {deal.commissionAmount && <span>Комиссия: {Math.round(Number(deal.commissionAmount)).toLocaleString('ru-RU')} ₽</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {isStaff && Array.isArray(client.uniquenessHistory) && client.uniquenessHistory.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium mb-2">История</h3>
            <div className="space-y-1.5">
              {client.uniquenessHistory.map((h: any) => {
                const labels: Record<string, string> = {
                  CLIENT_FIXATION: '🆕 Создана фиксация',
                  CLIENT_FIXATION_CONFLICT: '⚠ Конфликт фиксации',
                  UNIQUENESS_EXTENDED: '⏰ Продление уникальности',
                  UNIQUENESS_RESOLVED: '✅ Конфликт разрешён',
                  CLIENT_FIXED: '📌 Закреплён',
                  AMO_SYNC_FAILED: '❌ Не передан в amoCRM',
                };
                return (
                  <div key={h.id} className="bg-surface-secondary rounded p-2 text-xs">
                    <div className="flex justify-between">
                      <span>{labels[h.action] || h.action}</span>
                      <span className="text-text-muted">{new Date(h.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
                    </div>
                    {h.payload?.reason && <div className="text-text-muted mt-1">Причина: {h.payload.reason}</div>}
                    {h.payload?.scenario && <div className="text-text-muted mt-1">Сценарий: {h.payload.scenario}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {loading && <div className="text-xs text-text-muted mt-3">Догружаю детали…</div>}
      </div>
    </div>
  );
}

export default function ClientsPage() {
  const { broker } = useAuth();
  // 2026-06-09: брокер не видит иконку звонка в строках таблицы — звонок
  // через Mango только для КЦ/менеджеров.
  const isStaff = broker?.role === 'ADMIN' || broker?.role === 'MANAGER';
  const [clients, setClients] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedClient, setSelectedClient] = useState<any>(null);

  const fetchClients = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '15' });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (projectFilter) params.set('project', projectFilter);
      const data = await apiGet(`/clients?${params}`);
      setClients(data.clients || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
    } catch {
      setClients([]);
    }
    setLoading(false);
  };

  useEffect(() => { fetchClients(); }, [page, statusFilter, projectFilter]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchClients();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Клиенты</h1>
        <span className="text-text-muted text-sm">Всего: {total}</span>
      </div>

      {/* Expiring fixations banner */}
      {(() => {
        const expiring = clients.filter((c) => {
          // 2026-07-02: исполнителя по фиксации не тревожим — уникальность
          // и её срок принадлежат создателю (А), не Б.
          if (isExecutorView(c, broker?.id)) return false;
          if (c.uniquenessStatus !== 'CONDITIONALLY_UNIQUE') return false;
          const d = daysUntilExpiry(c.uniquenessExpiresAt);
          return d !== null && d >= 0 && d <= 7;
        });
        if (expiring.length === 0) return null;
        return (
          <div className="mb-6 p-4 rounded-lg bg-warning/10 border border-warning/40 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-warning">
                У {expiring.length} {expiring.length === 1 ? 'клиента' : 'клиентов'} скоро истекает фиксация
              </div>
              <div className="text-sm text-text-muted mt-1">
                {expiring.slice(0, 3).map((c) => `${c.fullName} — ${daysUntilExpiry(c.uniquenessExpiresAt)} дн.`).join(' · ')}
                {expiring.length > 3 && ` · и ещё ${expiring.length - 3}`}
              </div>
            </div>
          </div>
        );
      })()}

      <div className="card mb-6">
        {/* КБ6 #46: на моб фильтры в столбик, на десктопе — в строку */}
        <div className="flex flex-col md:flex-row md:flex-wrap gap-2 md:gap-4">
          <form onSubmit={handleSearch} className="flex-1 min-w-0 md:min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              className="input pl-10"
              placeholder="Поиск по имени или телефону..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
          <select
            className="input w-auto"
            value={projectFilter}
            onChange={(e) => { setProjectFilter(e.target.value); setPage(1); }}
          >
            <option value="">Все проекты</option>
            <option value="ZORGE9">Зорге 9</option>
            <option value="SILVER_BOR">Серебряный бор</option>
          </select>
          <select
            className="input w-auto"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          >
            <option value="">Все статусы</option>
            <option value="CONDITIONALLY_UNIQUE">Уникален</option>
            <option value="UNDER_REVIEW">На проверке</option>
            <option value="REJECTED">Не уникален</option>
            <option value="EXPIRED">Истёк</option>
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : clients.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            Клиенты появятся после синхронизации с amoCRM
          </div>
        ) : (
          <>
            {/* КБ6 #46: явная min-w для таблицы — на моб горизонтальный скролл */}
            <div className="overflow-x-auto -mx-2 sm:mx-0">
              <table className="w-full text-sm min-w-[700px]">
                <thead>
                  <tr className="text-text-muted text-left border-b border-border">
                    <th className="pb-3 font-medium">ФИО</th>
                    <th className="pb-3 font-medium">Телефон</th>
                    <th className="pb-3 font-medium">Проект</th>
                    <th className="pb-3 font-medium">Статус</th>
                    <th className="pb-3 font-medium">Статус до</th>
                    <th className="pb-3 font-medium" title="Дата создания заявки в amoCRM">Дата</th>
                    <th className="pb-3 font-medium w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c: any) => (
                    <tr
                      key={c.id}
                      className="border-b border-border last:border-0 hover:bg-surface-secondary cursor-pointer transition"
                      onClick={() => setSelectedClient(c)}
                    >
                      <td className="py-3 font-medium">{c.fullName}</td>
                      <td className="py-3 text-text-muted">{formatPhone(c.phone)}</td>
                      <td className="py-3">{projectLabels[c.project] || c.project}</td>
                      <td className="py-3">
                        {/* 2026-07-02: исполнитель по фиксации не видит «Уникален» —
                            уникальность принадлежит создателю (А). */}
                        {isExecutorView(c, broker?.id) ? (
                          <span className="text-xs px-2 py-1 rounded bg-info/20 text-info">
                            Исполнитель по фиксации
                          </span>
                        ) : (
                          <>
                            <span className={`text-xs px-2 py-1 rounded ${statusLabels[c.uniquenessStatus]?.cls || ''}`}>
                              {statusLabels[c.uniquenessStatus]?.label || c.uniquenessStatus}
                            </span>
                            {(() => {
                              if (c.uniquenessStatus !== 'CONDITIONALLY_UNIQUE') return null;
                              const d = daysUntilExpiry(c.uniquenessExpiresAt);
                              if (d === null || d > 7 || d < 0) return null;
                              return (
                                <div className={`text-[10px] mt-1 ${d <= 1 ? 'text-error' : 'text-warning'}`}>
                                  ⚠ истекает через {d} дн.
                                </div>
                              );
                            })()}
                          </>
                        )}
                      </td>
                      <td className="py-3 text-text-muted">
                        {/* КБ6: колонка «Уникален до» — дата окончания 30-дн уникальности.
                            Подсветка: ≤1 дн — красный, ≤7 дн — оранжевый.
                            2026-07-02: исполнителю таймер уникальности не показываем. */}
                        {isExecutorView(c, broker?.id)
                          ? '—'
                          : (c.uniquenessExpiresAt ? (() => {
                              const d = daysUntilExpiry(c.uniquenessExpiresAt);
                              const dateStr = new Date(c.uniquenessExpiresAt).toLocaleDateString('ru-RU');
                              const cls = d === null ? '' : d < 0 ? 'text-error' : d <= 1 ? 'text-error' : d <= 7 ? 'text-warning' : '';
                              return <span className={cls}>{dateStr}</span>;
                            })() : '—')}
                      </td>
                      <td className="py-3 text-text-muted" title="Дата создания заявки в amoCRM">
                        {new Date(c.amoCreatedAt || c.createdAt).toLocaleDateString('ru-RU')}
                      </td>
                      <td className="py-3">
                        {isStaff && <CallButton clientId={c.id} variant="icon" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
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
          </>
        )}
      </div>

      {selectedClient && <ClientDetail client={selectedClient} onClose={() => setSelectedClient(null)} />}
    </div>
  );
}
