'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  Phone, Search, ChevronLeft, ChevronRight, ChevronDown, Ban, CheckCircle2,
  AlertCircle, Clock, Users, PhoneCall, PhoneOff, Calendar,
} from 'lucide-react';

const categoryLabels: Record<string, { label: string; cls: string }> = {
  COLD: { label: 'COLD', cls: 'bg-info/20 text-info' },
  WARM: { label: 'WARM', cls: 'bg-warning/20 text-warning' },
  HOT: { label: 'HOT', cls: 'bg-error/20 text-error' },
  CONVERTED: { label: 'CONVERTED', cls: 'bg-success/20 text-success' },
  ON_BOT_REVIEW: { label: 'ON_BOT_REVIEW', cls: 'bg-text-muted/20 text-text-muted' },
  BLACKLIST: { label: 'BLACKLIST', cls: 'bg-text/20 text-text' },
};

const resultLabels: Record<string, string> = {
  NDZ: 'НДЗ — не дозвонились',
  DOUBLE_NDZ: '2 НДЗ — второй раз не дозвонились',
  HUNG_UP: 'Бросил трубку',
  INFORMED: 'Проинформирован о новых условиях',
  ALREADY_KNOWS: 'Уже был / на ТГ подписан',
  ONLY_SEND_INFO: 'Только отправить инфо',
  SCHEDULED_TOUR: 'Запись на брокер-тур',
  IN_PROGRESS: 'В работе',
  REFUSED_TOUR: 'Отказ от БТ',
  WRONG_NUMBER: 'Некорректный номер',
  NOT_A_BROKER: 'Не брокер',
  NOT_BROKER_ANYMORE: 'Уже не брокер',
  REFUSED_COMMUNICATION: 'Отказ от коммуникации',
  ASKED_NOT_TO_CALL: 'Просил не звонить',
  NEGATIVE: 'Негатив на звонок',
  NOT_RELEVANT: 'Неактуально / не интересно',
};

// Группировка для UI
const resultGroups: Array<{ title: string; cls: string; items: string[] }> = [
  {
    title: 'Не дозвонились',
    cls: 'border-info/30 bg-info/5',
    items: ['NDZ', 'DOUBLE_NDZ', 'HUNG_UP'],
  },
  {
    title: 'Информирование',
    cls: 'border-warning/30 bg-warning/5',
    items: ['INFORMED', 'ALREADY_KNOWS', 'ONLY_SEND_INFO'],
  },
  {
    title: 'Конверсия',
    cls: 'border-success/30 bg-success/5',
    items: ['SCHEDULED_TOUR', 'IN_PROGRESS', 'REFUSED_TOUR'],
  },
  {
    title: 'Удаление из базы',
    cls: 'border-error/30 bg-error/5',
    items: ['WRONG_NUMBER', 'NOT_A_BROKER', 'NOT_BROKER_ANYMORE'],
  },
  {
    title: 'Отказы',
    cls: 'border-text-muted/30 bg-text-muted/5',
    items: ['REFUSED_COMMUNICATION', 'ASKED_NOT_TO_CALL', 'NEGATIVE', 'NOT_RELEVANT'],
  },
];

interface QueueBroker {
  id: string;
  fullName: string;
  phone: string;
  category: string;
  doNotCall: boolean;
  isCoordinator: boolean;
  coordinatorAgency: string | null;
  lastCallAt: string | null;
  nextCallAt: string | null;
  baseSource: string | null;
  createdAt: string;
  // 2026-06-03: распределение по менеджерам КЦ.
  assignedManagerId: string | null;
  assignedAt: string | null;
  assignedManager: { id: string; fullName: string } | null;
  callLogs: Array<{ id: string; result: string; comment: string | null; campaign: string | null; createdAt: string }>;
}

interface KcManager {
  id: string;
  fullName: string;
  assignedCount: number;
}

type AssignmentFilter = 'mine' | 'unassigned' | 'all';

interface QueueResponse {
  brokers: QueueBroker[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface CallCenterStats {
  operator: { today: number; week: number; month: number };
  team: { today: number };
  queueWaiting: number;
  totalInBase: number;
}

export default function AdminCallCenterPage() {
  const { broker: me } = useAuth();

  if (me && me.role !== 'ADMIN' && me.role !== 'MANAGER') {
    return <div className="card">Доступ только для администраторов и менеджеров</div>;
  }

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  // 2026-07-06: фильтр по специализации — коммерция / жилая / обе / не указана.
  const [specializationFilter, setSpecializationFilter] = useState('');
  const [includeAll, setIncludeAll] = useState(false);
  const [coordinatorsFilter, setCoordinatorsFilter] = useState<'' | 'only' | 'exclude'>('');
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [stats, setStats] = useState<CallCenterStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // 2026-06-03: распределение брокеров на менеджеров КЦ. Менеджер по дефолту
  // видит только своих; админ — всех. Можно переключить вручную.
  const [assignmentFilter, setAssignmentFilter] = useState<AssignmentFilter>(
    me?.role === 'MANAGER' ? 'mine' : 'all',
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [managers, setManagers] = useState<KcManager[]>([]);
  const [batchManagerId, setBatchManagerId] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);

  const loadQueue = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '20' });
    if (search) p.set('search', search);
    if (categoryFilter) p.set('category', categoryFilter);
    if (specializationFilter) p.set('specialization', specializationFilter);
    if (includeAll) p.set('includeAll', 'true');
    if (coordinatorsFilter) p.set('coordinators', coordinatorsFilter);
    if (assignmentFilter && assignmentFilter !== 'all') p.set('assignment', assignmentFilter);
    apiGet<QueueResponse>(`/admin/call-center/queue?${p}`)
      .then(setQueue)
      .catch(() => setQueue({ brokers: [], total: 0, page: 1, limit: 20, totalPages: 1 }))
      .finally(() => setLoading(false));
  }, [page, search, categoryFilter, specializationFilter, includeAll, coordinatorsFilter, assignmentFilter]);

  const loadStats = useCallback(() => {
    apiGet<CallCenterStats>('/admin/call-center/stats').then(setStats).catch(() => {});
  }, []);

  const loadManagers = useCallback(() => {
    // ADMIN видит список менеджеров для назначения; для MANAGER он не нужен.
    if (me?.role !== 'ADMIN') return;
    apiGet<KcManager[]>('/admin/call-center/managers').then(setManagers).catch(() => setManagers([]));
  }, [me?.role]);

  useEffect(() => { loadQueue(); }, [loadQueue]);
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadManagers(); }, [loadManagers]);

  // При смене страницы или фильтра — сбрасываем выбор (не путаем менеджера).
  useEffect(() => { setSelected(new Set()); }, [page, search, categoryFilter, specializationFilter, includeAll, coordinatorsFilter, assignmentFilter]);

  const toggleSelected = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const selectAllVisible = () => {
    if (!queue) return;
    const visibleIds = queue.brokers.map((b) => b.id);
    const allSelected = visibleIds.every((id) => selected.has(id));
    if (allSelected) {
      const next = new Set(selected);
      for (const id of visibleIds) next.delete(id);
      setSelected(next);
    } else {
      setSelected(new Set([...selected, ...visibleIds]));
    }
  };
  const clearSelected = () => setSelected(new Set());

  const handleAssign = async () => {
    if (!batchManagerId || selected.size === 0) return;
    setBatchBusy(true);
    try {
      const res: any = await apiPost('/admin/call-center/assign', {
        brokerIds: Array.from(selected),
        managerId: batchManagerId,
      });
      setMessage(`Назначено ${res?.assigned} брокеров на ${res?.managerName}`);
      setTimeout(() => setMessage(''), 3000);
      clearSelected();
      loadQueue();
      loadManagers();
    } catch (e: any) {
      setMessage(`Ошибка: ${e?.message || 'не удалось назначить'}`);
      setTimeout(() => setMessage(''), 4000);
    } finally {
      setBatchBusy(false);
    }
  };
  const handleUnassign = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Снять назначение менеджера с ${selected.size} брокеров?`)) return;
    setBatchBusy(true);
    try {
      const res: any = await apiPost('/admin/call-center/unassign', {
        brokerIds: Array.from(selected),
      });
      setMessage(`Снято назначение с ${res?.unassigned}`);
      setTimeout(() => setMessage(''), 3000);
      clearSelected();
      loadQueue();
      loadManagers();
    } catch (e: any) {
      setMessage(`Ошибка: ${e?.message || 'не удалось'}`);
      setTimeout(() => setMessage(''), 4000);
    } finally {
      setBatchBusy(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const onCallLogged = (advanceTo: string | null) => {
    setMessage('Звонок сохранён');
    setTimeout(() => setMessage(''), 2000);
    setExpandedId(advanceTo);
    loadQueue();
    loadStats();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <PhoneCall className="w-7 h-7 text-accent" />
          Колл-центр
        </h1>
        {message && <div className="px-3 py-1 rounded bg-success/20 text-success text-sm">{message}</div>}
      </div>

      {/* KPI */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard icon={<Phone className="w-5 h-5" />} title="Моих сегодня" value={stats.operator.today} cls="bg-accent/10 text-accent" />
          <KpiCard icon={<Phone className="w-5 h-5" />} title="Моих за неделю" value={stats.operator.week} cls="bg-info/10 text-info" />
          <KpiCard icon={<Phone className="w-5 h-5" />} title="Моих за месяц" value={stats.operator.month} cls="bg-success/10 text-success" />
          <KpiCard icon={<Users className="w-5 h-5" />} title="Команда сегодня" value={stats.team.today} cls="bg-warning/10 text-warning" />
          <KpiCard icon={<Clock className="w-5 h-5" />} title="В очереди" value={stats.queueWaiting} cls="bg-error/10 text-error" subtitle={`из ${stats.totalInBase} в базе`} />
        </div>
      )}

      {/* Фильтры */}
      <div className="card">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={handleSearch} className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              className="input pl-10"
              placeholder="Поиск по ФИО / телефону / агентству…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </form>
          <select className="input w-auto" value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}>
            <option value="">Все категории</option>
            {Object.entries(categoryLabels).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          {/* 2026-07-06: фильтр специализации — можно собрать очередь только по
              коммерческим брокерам (или наоборот). COMM ставится автоматически
              при импорте из Google по маркерам в комментарии. */}
          <select className="input w-auto" value={specializationFilter} onChange={(e) => { setSpecializationFilter(e.target.value); setPage(1); }}>
            <option value="">Все специализации</option>
            <option value="COMM">Коммерция</option>
            <option value="RESIDENTIAL">Жилая</option>
            <option value="BOTH">Обе</option>
            <option value="REGIONAL">Региональный</option>
            <option value="UNSET">Не указана</option>
          </select>
          <select className="input w-auto" value={coordinatorsFilter} onChange={(e) => { setCoordinatorsFilter(e.target.value as any); setPage(1); }}>
            <option value="">Брокеры + координаторы</option>
            <option value="only">Только координаторы</option>
            <option value="exclude">Только брокеры (без координаторов)</option>
          </select>
          {/* 2026-06-03: фильтр распределения. Менеджер по дефолту видит «мои». */}
          <select
            className="input w-auto"
            value={assignmentFilter}
            onChange={(e) => { setAssignmentFilter(e.target.value as AssignmentFilter); setPage(1); }}
            title="Фильтр распределения по менеджерам КЦ"
          >
            <option value="mine">{me?.role === 'MANAGER' ? 'Только мои' : 'Назначенные на меня'}</option>
            <option value="unassigned">Без назначения</option>
            <option value="all">Все</option>
          </select>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={includeAll} onChange={(e) => { setIncludeAll(e.target.checked); setPage(1); }} />
            Показать также «не звонить»
          </label>
        </div>
      </div>

      {/* 2026-06-03: батч-панель назначения. Видна только админу,
          когда выбрано хотя бы 1. */}
      {me?.role === 'ADMIN' && selected.size > 0 && (
        <div className="card border-accent bg-accent/5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="font-medium">Выбрано: {selected.size}</div>
            <select
              className="input w-auto"
              value={batchManagerId}
              onChange={(e) => setBatchManagerId(e.target.value)}
            >
              <option value="">— менеджер КЦ —</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.fullName} ({m.assignedCount})</option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              disabled={!batchManagerId || batchBusy}
              onClick={handleAssign}
            >
              {batchBusy ? '…' : 'Назначить'}
            </button>
            <button
              className="btn btn-secondary"
              disabled={batchBusy}
              onClick={handleUnassign}
              title="Снять назначение менеджера у выбранных"
            >
              Снять назначение
            </button>
            <button
              className="btn btn-secondary"
              onClick={clearSelected}
              title="Сбросить выбор"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Очередь */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Очередь обзвона</h2>
          <div className="flex items-center gap-3 text-sm">
            {me?.role === 'ADMIN' && queue && queue.brokers.length > 0 && (
              <button className="text-accent hover:underline" onClick={selectAllVisible}>
                {queue.brokers.every((b) => selected.has(b.id)) ? 'Снять выбор страницы' : 'Выбрать всю страницу'}
              </button>
            )}
            <span className="text-text-muted">Всего: {queue?.total ?? 0}</span>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка…</div>
        ) : !queue || queue.brokers.length === 0 ? (
          <div className="text-center py-8 text-text-muted">Пусто. Все обзвонены или нет брокеров под фильтр.</div>
        ) : (
          <div className="space-y-2">
            {queue.brokers.map((b) => (
              <BrokerRow
                key={b.id}
                broker={b}
                expanded={expandedId === b.id}
                onToggle={() => setExpandedId(expandedId === b.id ? null : b.id)}
                onLogged={() => {
                  const idx = queue.brokers.findIndex((x) => x.id === b.id);
                  const nextBroker = queue.brokers[idx + 1];
                  onCallLogged(nextBroker?.id || null);
                }}
                showCheckbox={me?.role === 'ADMIN'}
                selected={selected.has(b.id)}
                onSelectToggle={() => toggleSelected(b.id)}
              />
            ))}
          </div>
        )}

        {queue && queue.totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
            <span className="text-sm text-text-muted">Стр. {queue.page} из {queue.totalPages}</span>
            <div className="flex gap-2">
              <button className="btn btn-secondary" onClick={() => setPage(Math.max(1, page - 1))} disabled={queue.page === 1}>
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button className="btn btn-secondary" onClick={() => setPage(Math.min(queue.totalPages, page + 1))} disabled={queue.page === queue.totalPages}>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({ icon, title, value, cls, subtitle }: { icon: React.ReactNode; title: string; value: number; cls: string; subtitle?: string }) {
  return (
    <div className={`p-3 rounded-lg ${cls}`}>
      <div className="flex items-center gap-2 text-xs opacity-80">{icon}{title}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {subtitle && <div className="text-[10px] opacity-70 mt-0.5">{subtitle}</div>}
    </div>
  );
}

function BrokerRow({
  broker,
  expanded,
  onToggle,
  onLogged,
  showCheckbox = false,
  selected = false,
  onSelectToggle,
}: {
  broker: QueueBroker;
  expanded: boolean;
  onToggle: () => void;
  onLogged: () => void;
  showCheckbox?: boolean;
  selected?: boolean;
  onSelectToggle?: () => void;
}) {
  const cat = categoryLabels[broker.category];
  const lastResult = broker.callLogs[0];

  return (
    <div className={`border rounded-lg flex items-center ${expanded ? 'border-accent bg-accent/5' : selected ? 'border-accent bg-accent/10' : 'border-border'}`}>
      {showCheckbox && (
        <label
          className="pl-3 py-3 cursor-pointer flex items-center"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onSelectToggle}
            className="w-4 h-4 cursor-pointer"
            title="Выбрать для батч-назначения"
          />
        </label>
      )}
      <button
        onClick={onToggle}
        className="w-full p-3 flex items-center gap-3 text-left hover:bg-surface-secondary/50 transition rounded-lg"
      >
        <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-[1.5fr_1fr_1.5fr_auto_1fr] gap-3 items-center">
          <div className="min-w-0">
            <div className="font-medium text-sm truncate flex items-center gap-1">
              {broker.doNotCall && <Ban className="w-3 h-3 text-error flex-shrink-0" />}
              {broker.isCoordinator && <span className="text-[10px] px-1 rounded bg-accent/20 text-accent">КООРД</span>}
              {broker.fullName}
            </div>
            {broker.assignedManager && (
              <div className="text-[10px] text-text-muted truncate">
                👤 {broker.assignedManager.fullName}
              </div>
            )}
          </div>
          <div className="text-sm font-mono">{broker.phone}</div>
          <div className="text-xs text-text-muted truncate">{broker.coordinatorAgency || '—'}</div>
          <span className={`text-xs px-2 py-1 rounded whitespace-nowrap ${cat?.cls || ''}`}>{cat?.label || broker.category}</span>
          {/* Bug fix 2026-06-02: в превью показываем ВСЮ историю звонков
              (до 2 последних), а не только последний результат. Раньше
              менеджеру приходилось раскрывать карточку, чтобы увидеть
              предыдущие звонки. */}
          <div className="text-xs text-text-muted space-y-0.5">
            {broker.callLogs.length === 0 ? (
              <span className="italic">не звонили</span>
            ) : (
              broker.callLogs.slice(0, 2).map((c) => (
                <div key={c.id} className="leading-tight">
                  <div className="truncate">
                    {resultLabels[c.result] || c.result}
                    {c.campaign && <span className="ml-1 text-[10px] px-1 rounded bg-surface-secondary">{c.campaign}</span>}
                  </div>
                  <div className="text-[10px] opacity-70">{new Date(c.createdAt).toLocaleDateString('ru-RU')}</div>
                </div>
              ))
            )}
          </div>
        </div>
        <ChevronDown className={`w-5 h-5 text-text-muted transition ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && <CallPanel broker={broker} onLogged={onLogged} />}
    </div>
  );
}

function CallPanel({ broker, onLogged }: { broker: QueueBroker; onLogged: () => void }) {
  const [result, setResult] = useState<string>('');
  const [comment, setComment] = useState('');
  const [campaign, setCampaign] = useState('');
  const [nextCallAt, setNextCallAt] = useState('');
  const [brokerTourDate, setBrokerTourDate] = useState('');
  const [doNotCallOverride, setDoNotCallOverride] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const handleSave = async () => {
    if (!result) { setErr('Выбери результат звонка'); return; }
    if (result === 'SCHEDULED_TOUR' && !brokerTourDate) {
      setErr('Укажи дату брокер-тура');
      return;
    }
    setSaving(true); setErr('');
    try {
      await apiPost('/admin/call-center/log-call', {
        brokerId: broker.id,
        result,
        comment: comment || null,
        campaign: campaign || null,
        nextCallAtOverride: nextCallAt ? new Date(nextCallAt).toISOString() : null,
        doNotCallOverride,
        brokerTourDate: brokerTourDate ? new Date(brokerTourDate).toISOString() : null,
      });
      onLogged();
    } catch (e: any) {
      setErr(e?.message || 'Ошибка');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-accent/30 p-4 space-y-4">
      {/* История звонков */}
      <div>
        <h4 className="text-xs font-medium text-text-muted mb-2 flex items-center gap-1">
          <Phone className="w-3 h-3" /> История звонков ({broker.callLogs.length} последних)
        </h4>
        {broker.callLogs.length === 0 ? (
          <div className="text-xs text-text-muted italic">Звонков ещё не было</div>
        ) : (
          <div className="space-y-1 text-xs">
            {broker.callLogs.map((c) => (
              <div key={c.id} className="border-l-2 border-border pl-2 py-0.5">
                <div className="font-medium">
                  {resultLabels[c.result] || c.result}
                  {c.campaign && <span className="ml-2 text-[10px] px-1 rounded bg-surface-secondary">{c.campaign}</span>}
                </div>
                <div className="text-text-muted">
                  {new Date(c.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
                </div>
                {c.comment && <div className="text-text-muted italic">{c.comment}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Результат — группами */}
      <div>
        <h4 className="text-xs font-medium text-text-muted mb-2">Результат звонка *</h4>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          {resultGroups.map((g) => (
            <div key={g.title} className={`border rounded-lg p-2 ${g.cls}`}>
              <div className="text-[10px] font-semibold mb-1 uppercase opacity-70">{g.title}</div>
              <div className="space-y-1">
                {g.items.map((code) => (
                  <label key={code} className={`flex items-start gap-1.5 cursor-pointer text-xs py-1 px-1.5 rounded hover:bg-white/30 ${result === code ? 'bg-white/50' : ''}`}>
                    <input
                      type="radio"
                      name="result"
                      value={code}
                      checked={result === code}
                      onChange={() => setResult(code)}
                      className="mt-0.5"
                    />
                    <span>{resultLabels[code]}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Доп. поля */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Кампания</label>
          <select className="input" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value="">Без кампании</option>
            <option value="Зорге 9">Зорге 9</option>
            <option value="Серебряный Бор">Серебряный Бор</option>
            <option value="Новые условия">Новые условия</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Перезвонить (опционально)</label>
          <input type="date" className="input" value={nextCallAt} onChange={(e) => setNextCallAt(e.target.value)} />
          <p className="text-[10px] text-text-muted mt-1">Если пусто — рассчитается по правилу: НДЗ → +3 дня, В работе → +7 дней</p>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Перезаписать «не звонить»</label>
          <select className="input" value={String(doNotCallOverride)} onChange={(e) => {
            const v = e.target.value;
            setDoNotCallOverride(v === 'true' ? true : v === 'false' ? false : null);
          }}>
            <option value="null">Не менять (по правилу результата)</option>
            <option value="true">Включить (не звонить)</option>
            <option value="false">Снять</option>
          </select>
        </div>
      </div>

      {result === 'SCHEDULED_TOUR' && (
        <div className="bg-success/10 p-3 rounded border border-success/30">
          <label className="block text-xs font-semibold mb-1">Дата брокер-тура *</label>
          <input
            type="datetime-local"
            className="input"
            value={brokerTourDate}
            onChange={(e) => setBrokerTourDate(e.target.value)}
            step="3600"
            required
          />
          <p className="text-[10px] text-text-muted mt-1">
            После сохранения дата запишется в карточку брокера. Менеджер увидит запись в /admin/brokers/&lt;id&gt;.
          </p>
        </div>
      )}

      <div>
        <label className="block text-xs text-text-muted mb-1">Комментарий</label>
        <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Заметка к звонку…" />
      </div>

      {err && (
        <div className="p-2 bg-error/10 text-error rounded text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {err}
        </div>
      )}

      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <button className="btn btn-primary flex items-center gap-2" onClick={handleSave} disabled={saving}>
          <CheckCircle2 className="w-4 h-4" /> {saving ? 'Сохранение…' : 'Сохранить и следующий'}
        </button>
        <span className="text-xs text-text-muted">
          После сохранения карточка закроется, и автоматически раскроется следующий брокер.
        </span>
      </div>
    </div>
  );
}
