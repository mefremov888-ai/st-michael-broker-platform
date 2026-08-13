'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import AmoHealthBanner from '@/components/AmoHealthBanner';
import {
  ArrowUpDown,
  BarChart3,
  Building,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  DollarSign,
  Search,
  TrendingUp,
  Trophy,
  Users,
} from 'lucide-react';

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный Бор',
};

const dealStatusLabels: Record<string, string> = {
  PENDING: 'В работе',
  SIGNED: 'Договор подписан',
  PAID: 'Клиент оплатил',
  COMMISSION_PAID: 'Комиссия выплачена',
  CANCELLED: 'Отменена',
};

const stageLabels: Record<string, string> = {
  NEW_BROKER: 'Новый брокер',
  BROKER_TOUR: 'Брокер-тур',
  FIXATION: 'Фиксация',
  MEETING: 'Встреча',
  DEAL: 'Сделка',
};

interface FixationsByBrokerRow {
  brokerId: string;
  fullName: string;
  phone: string;
  total: number;
  conditionallyUnique: number;
  underReview: number;
  rejected: number;
  expired: number;
  fixed: number;
  submittedBySelf?: number;
  selfSubmitted?: number;
  submittedByOthers?: number;
  submitters?: Array<{ brokerId: string; fullName: string; count: number }>;
  brokerTourVisited: boolean;
  brokerTourDate: string | null;
  brokerTourInPeriod: boolean;
  fixationAfterTour: boolean;
}

type FixationSortKey =
  | 'fullName'
  | 'total'
  | 'conditionallyUnique'
  | 'underReview'
  | 'rejected'
  | 'expired'
  | 'fixed'
  | 'submittedBySelf'
  | 'submittedByOthers';

type FixationSort = { key: FixationSortKey; direction: 'asc' | 'desc' };
type FixationStatusFilter = 'total' | 'conditionallyUnique' | 'underReview' | 'rejected' | 'expired' | 'fixed';
type BrokerTourFilter = 'all' | 'visited' | 'converted';

const FIXATION_PAGE_SIZE = 50;
const MOSCOW_TIME_ZONE = 'Europe/Moscow';

interface Overview {
  period: { from: string; to: string };
  brokers: {
    total: number;
    active: number;
    blocked: number;
    newInPeriod: number;
    registrationTrend: Array<{ date: string; count: number }>;
    funnelByStage: Array<{ stage: string; count: number }>;
  };
  fixations: {
    total: number;
    fixed: number;
    conditionallyUnique: number;
    rejected: number;
    underReview: number;
    expired: number;
    uniqueRatio: number;
  };
  deals: { funnel: Array<{ status: string; count: number; totalAmount: number; totalCommission: number }> };
  topBrokers: Array<{ brokerId: string; fullName: string; phone: string; dealsCount: number; totalAmount: number; totalCommission: number }>;
  brokerTourFunnel: {
    tourVisited: number;
    withAnyFixation?: number;
    withFixation?: number;
    withDeal: number;
    toAnyFixationPct?: number;
    toFixationPct?: number;
    toDealPct: number;
  };
  fixationsByBroker?: FixationsByBrokerRow[];
  topFixationBrokers: Array<{ brokerId: string; fullName: string; phone: string; uniqueFixations: number }>;
  bySource: Array<{ source: string; count: number }>;
  projects: Array<{ project: string; totalDeals: number; paidDeals: number; totalAmount: number; totalCommission: number; totalSqm: number }>;
}

// 2026-07-08: подписи источников для нового блока «Аналитика по источникам».
const sourceLabels: Record<string, string> = {
  CRM_MANUAL: 'Внесён вручную',
  BROKER_CABINET: 'Регистрация через кабинет',
  PHONE_CALL: 'Позвонил на линию',
  LANDING_BROKER_TOUR: 'Лендинг: брокер-тур',
  LANDING_FORM: 'Лендинг: форма',
  CLOSED_AS_BROKER: 'Закрыт как брокер',
};

function fmtRub(n: number) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

function moscowDateOnly(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value ?? '';
  return value('year') + '-' + value('month') + '-' + value('day');
}

function shiftDateOnly(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function formatBrokerTourDate(value: string | null) {
  if (!value) return '\u2014';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '\u2014';
  return date.toLocaleDateString('ru-RU', { timeZone: MOSCOW_TIME_ZONE });
}

export default function AdminAnalyticsPage() {
  const { broker } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(() => shiftDateOnly(moscowDateOnly(), -89));
  const [to, setTo] = useState(() => moscowDateOnly());
  const [brokerSearch, setBrokerSearch] = useState('');
  const [submitterSearch, setSubmitterSearch] = useState('');
  const [fixationStatusFilter, setFixationStatusFilter] = useState<FixationStatusFilter>('total');
  const [brokerTourFilter, setBrokerTourFilter] = useState<BrokerTourFilter>('all');
  const [fixationSort, setFixationSort] = useState<FixationSort>({ key: 'total', direction: 'desc' });
  const [fixationPage, setFixationPage] = useState(1);
  const requestIdRef = useRef(0);
  const invalidDateRange = !from || !to || from > to;

  const applyPreset = (preset: 'today' | 'week' | 'month' | 'quarter' | 'year' | 'ytd' | 'all') => {
    const toStr = moscowDateOnly();
    const back = (days: number) => shiftDateOnly(toStr, -days);
    if (preset === 'today') { setFrom(toStr); setTo(toStr); }
    else if (preset === 'week') { setFrom(back(6)); setTo(toStr); }
    else if (preset === 'month') { setFrom(back(29)); setTo(toStr); }
    else if (preset === 'quarter') { setFrom(back(89)); setTo(toStr); }
    else if (preset === 'year') { setFrom(back(364)); setTo(toStr); }
    else if (preset === 'ytd') {
      setFrom(toStr.slice(0, 4) + '-01-01');
      setTo(toStr);
    } else if (preset === 'all') {
      setFrom('2020-01-01'); setTo(toStr);
    }
  };

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setFixationPage(1);

    if (invalidDateRange) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setData(null);
    apiGet<Overview>('/analytics/admin/overview?startDate=' + encodeURIComponent(from) + '&endDate=' + encodeURIComponent(to))
      .then((nextData) => {
        if (requestId === requestIdRef.current) setData(nextData);
      })
      .catch(() => {
        if (requestId === requestIdRef.current) setData(null);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });

    return () => {
      if (requestId === requestIdRef.current) requestIdRef.current += 1;
    };
  }, [from, invalidDateRange, to]);
  const tourWithAnyFixation = data
    ? data.brokerTourFunnel.withAnyFixation ?? data.brokerTourFunnel.withFixation ?? 0
    : 0;
  const tourToAnyFixationPct = data
    ? data.brokerTourFunnel.toAnyFixationPct
      ?? data.brokerTourFunnel.toFixationPct
      ?? (data.brokerTourFunnel.tourVisited > 0
        ? Math.round((tourWithAnyFixation / data.brokerTourFunnel.tourVisited) * 100)
        : 0)
    : 0;

  const fixationRows = useMemo(() => (data?.fixationsByBroker ?? []).map((row) => ({
    ...row,
    submittedBySelf: row.submittedBySelf ?? row.selfSubmitted ?? 0,
    submittedByOthers: row.submittedByOthers ?? 0,
    submitters: row.submitters ?? [],
  })), [data?.fixationsByBroker]);
  const visibleFixationRows = useMemo(() => {
    const normalizedBrokerSearch = brokerSearch.trim().toLocaleLowerCase('ru-RU');
    const normalizedSubmitterSearch = submitterSearch.trim().toLocaleLowerCase('ru-RU');

    return fixationRows
      .filter((row) => {
        if (normalizedBrokerSearch && !(row.fullName + ' ' + (row.phone || ''))
          .toLocaleLowerCase('ru-RU')
          .includes(normalizedBrokerSearch)) return false;
        if (normalizedSubmitterSearch && !(row.submitters ?? []).some((submitter) => submitter.fullName
          .toLocaleLowerCase('ru-RU')
          .includes(normalizedSubmitterSearch))) return false;
        if (fixationStatusFilter !== 'total' && Number(row[fixationStatusFilter]) <= 0) return false;
        if (brokerTourFilter === 'visited' && !row.brokerTourInPeriod) return false;
        if (brokerTourFilter === 'converted' && !row.fixationAfterTour) return false;
        return true;
      })
      .sort((a, b) => {
        const aValue = a[fixationSort.key];
        const bValue = b[fixationSort.key];
        const direction = fixationSort.direction === 'asc' ? 1 : -1;
        const compared = typeof aValue === 'string' && typeof bValue === 'string'
          ? aValue.localeCompare(bValue, 'ru-RU')
          : Number(aValue) - Number(bValue);
        return compared !== 0 ? compared * direction : a.fullName.localeCompare(b.fullName, 'ru-RU');
      });
  }, [brokerSearch, brokerTourFilter, fixationRows, fixationSort, fixationStatusFilter, submitterSearch]);
  const fixationTotalPages = Math.max(1, Math.ceil(visibleFixationRows.length / FIXATION_PAGE_SIZE));
  const safeFixationPage = Math.min(fixationPage, fixationTotalPages);
  const fixationPageStart = (safeFixationPage - 1) * FIXATION_PAGE_SIZE;
  const pagedFixationRows = visibleFixationRows.slice(fixationPageStart, fixationPageStart + FIXATION_PAGE_SIZE);

  const toggleFixationSort = (key: FixationSortKey) => {
    setFixationSort((current) => ({
      key,
      direction: current.key === key
        ? current.direction === 'desc' ? 'asc' : 'desc'
        : key === 'fullName' ? 'asc' : 'desc',
    }));
    setFixationPage(1);
  };

  const selectFixationStatus = (status: FixationStatusFilter) => {
    setFixationStatusFilter((current) => current === status && status !== 'total' ? 'total' : status);
    setFixationPage(1);
  };

  const selectBrokerTour = (filter: BrokerTourFilter) => {
    setBrokerTourFilter(filter);
    setFixationPage(1);
  };

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  return (
    <div>
      <div className="flex flex-col gap-3 mb-2 lg:flex-row lg:items-end lg:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <BarChart3 className="w-7 h-7 text-accent" /> Аналитика платформы
        </h1>
        <fieldset className="min-w-0">
          <legend className="mb-1 text-xs font-medium text-text-muted">
            Дата фиксации (amo: дата создания карточки; кабинет: дата подачи)
          </legend>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="analytics-date-from" className="sr-only">Дата фиксации с</label>
            <input
              id="analytics-date-from"
              className="input w-auto text-sm"
              type="date"
              required
              max={to || undefined}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span className="text-text-muted">—</span>
            <label htmlFor="analytics-date-to" className="sr-only">Дата фиксации по</label>
            <input
              id="analytics-date-to"
              className="input w-auto text-sm"
              type="date"
              required
              min={from || undefined}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </fieldset>
      </div>
      <div className="flex flex-wrap gap-2 mb-4 text-sm">
        <button type="button" className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('today')}>Сегодня</button>
        <button type="button" className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('week')}>Неделя</button>
        <button type="button" className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('month')}>Месяц</button>
        <button type="button" className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('quarter')}>Квартал</button>
        <button type="button" className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('year')}>Год</button>
        <button type="button" className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('ytd')}>С начала года</button>
        <button type="button" className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('all')}>За всё время</button>
      </div>

      <div className="mb-4 rounded border border-border bg-surface-secondary p-3 text-sm text-text-muted">
        Источник отчёта — локальная БД: заявки из кабинета и только уже синхронизированные данные amoCRM.
        Это не live-представление полного amoCRM.
      </div>
      <AmoHealthBanner />

      {invalidDateRange && (
        <div className="mb-4 text-sm text-error" role="alert">
          Укажите обе даты и убедитесь, что начальная дата не позже конечной.
        </div>
      )}
      {!invalidDateRange && loading && <div className="text-text-muted">Загрузка…</div>}
      {!invalidDateRange && !loading && !data && <div className="text-error">Не удалось загрузить</div>}

      {data && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <KpiCard icon={Users} label="Всего брокеров" value={data.brokers.total} hint={`${data.brokers.active} активных, ${data.brokers.blocked} заблок.`} />
            <KpiCard icon={TrendingUp} label="Новых за период" value={data.brokers.newInPeriod} hint="регистрации" />
            <KpiCard icon={Building} label="Фиксаций" value={data.fixations.total} hint={`${data.fixations.uniqueRatio}% уникальных`} />
            <KpiCard
              icon={DollarSign}
              label="Комиссия выплачена"
              value={fmtRub(data.deals.funnel.find((d) => d.status === 'COMMISSION_PAID')?.totalCommission || 0)}
              hint="за выбранный период"
              isString
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Fixations */}
            <div className="card">
              <h2 className="text-lg font-semibold mb-4">Фиксации: уникальные vs не уникальные</h2>
              <div className="mb-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => selectFixationStatus('total')} className={`px-3 py-1 rounded border text-xs ${fixationStatusFilter === 'total' ? 'border-accent bg-accent/10 text-accent' : 'border-border'}`}>
                  Все статусы · {data.fixations.total}
                </button>
                <button type="button" onClick={() => selectFixationStatus('fixed')} className={`px-3 py-1 rounded border text-xs ${fixationStatusFilter === 'fixed' ? 'border-accent bg-accent/10 text-accent' : 'border-border'}`}>
                  Окончательно зафиксированы · {data.fixations.fixed}
                </button>
              </div>
              <div className="space-y-2">
                <FixationRow label="✅ Уникальные" count={data.fixations.conditionallyUnique} total={data.fixations.total} color="bg-success" active={fixationStatusFilter === 'conditionallyUnique'} onClick={() => selectFixationStatus('conditionallyUnique')} />
                <FixationRow label="⚠️ На проверке" count={data.fixations.underReview} total={data.fixations.total} color="bg-warning" active={fixationStatusFilter === 'underReview'} onClick={() => selectFixationStatus('underReview')} />
                <FixationRow label="❌ Отклонены" count={data.fixations.rejected} total={data.fixations.total} color="bg-error" active={fixationStatusFilter === 'rejected'} onClick={() => selectFixationStatus('rejected')} />
                <FixationRow label="⏰ Истекли" count={data.fixations.expired} total={data.fixations.total} color="bg-text-muted" active={fixationStatusFilter === 'expired'} onClick={() => selectFixationStatus('expired')} />
              </div>
              <div className="mt-3 text-xs text-text-muted">
                Нажмите на статус, чтобы увидеть соответствующих брокеров в таблице ниже.
              </div>
            </div>

            {/* Deals funnel */}
            <div className="card">
              <h2 className="text-lg font-semibold mb-4">Воронка сделок</h2>
              <div className="space-y-3">
                {data.deals.funnel.map((d) => {
                  const total = data.deals.funnel.reduce((s, x) => s + x.count, 0);
                  const pct = total > 0 ? Math.round((d.count / total) * 100) : 0;
                  return (
                    <div key={d.status}>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{dealStatusLabels[d.status] || d.status}</span>
                        <span className="text-text-muted">{d.count} · {pct}%</span>
                      </div>
                      <div className="bg-surface-secondary rounded-full h-2">
                        <div className="bg-accent h-full rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-accent" /> Брокер-тур → фиксация → сделка
            </h2>
            <div className="text-xs text-text-muted mb-4">
              Когорта — брокеры с отметкой amoCRM «Был на брокер-туре» и датой тура в выбранном периоде. Фиксация и оплаченная сделка учитываются только строго после даты тура. Нажмите карточку, чтобы увидеть брокеров в таблице.
            </div>
            {data.brokerTourFunnel.tourVisited === 0 ? (
              <div className="text-text-muted text-sm">В выбранном периоде нет синхронизированных посещений брокер-тура</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <button
                  type="button"
                  onClick={() => selectBrokerTour('visited')}
                  aria-pressed={brokerTourFilter === 'visited'}
                  className={`rounded-lg bg-surface-secondary p-4 text-left transition hover:ring-2 hover:ring-accent/50 ${brokerTourFilter === 'visited' ? 'ring-2 ring-accent' : ''}`}
                >
                  <div className="text-sm text-text-muted mb-1">Посетили брокер-тур</div>
                  <div className="text-3xl font-bold">{data.brokerTourFunnel.tourVisited}</div>
                  <div className="text-xs text-accent mt-1">показать список</div>
                </button>
                <button
                  type="button"
                  onClick={() => selectBrokerTour('converted')}
                  aria-pressed={brokerTourFilter === 'converted'}
                  className={`rounded-lg bg-surface-secondary p-4 text-left transition hover:ring-2 hover:ring-accent/50 ${brokerTourFilter === 'converted' ? 'ring-2 ring-accent' : ''}`}
                >
                  <div className="text-sm text-text-muted mb-1">Сделали фиксацию после тура</div>
                  <div className="text-3xl font-bold">{tourWithAnyFixation}</div>
                  <div className="text-xs text-accent mt-1">{tourToAnyFixationPct}% · показать список</div>
                </button>
                <div className="rounded-lg bg-surface-secondary p-4">
                  <div className="text-sm text-text-muted mb-1">Довели до оплаченной сделки после тура</div>
                  <div className="text-3xl font-bold">{data.brokerTourFunnel.withDeal}</div>
                  <div className="text-xs text-accent mt-1">{data.brokerTourFunnel.toDealPct}% от посетивших</div>
                </div>
              </div>
            )}
          </div>
          {/* Full fixation report by the broker who owns the application. */}
          <div className='card mb-6'>
            <div className='mb-4 space-y-3'>
              <div>
                <h2 className='text-lg font-semibold'>Фиксации по брокерам</h2>
                <div className='text-xs text-text-muted mt-1'>
                  Все заявки за выбранный период. Брокер — фактический ответственный; автор подачи показан отдельно.
                </div>
              </div>
              <div className='grid grid-cols-1 gap-3 lg:grid-cols-3'>
                <label className='text-xs text-text-muted'>
                  Брокер
                  <span className='relative mt-1 block'>
                    <Search className='absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted' />
                    <input className='input pl-9' placeholder='ФИО или телефон брокера' value={brokerSearch} onChange={(e) => { setBrokerSearch(e.target.value); setFixationPage(1); }} />
                  </span>
                </label>
                <label className='text-xs text-text-muted'>
                  Автор подачи
                  <span className='relative mt-1 block'>
                    <Search className='absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted' />
                    <input className='input pl-9' placeholder='ФИО автора подачи' value={submitterSearch} onChange={(e) => { setSubmitterSearch(e.target.value); setFixationPage(1); }} />
                  </span>
                </label>
                <label className='text-xs text-text-muted'>
                  Брокер-тур
                  <select className='input mt-1' value={brokerTourFilter} onChange={(e) => selectBrokerTour(e.target.value as BrokerTourFilter)}>
                    <option value='all'>Все брокеры</option>
                    <option value='visited'>Были на брокер-туре в периоде</option>
                    <option value='converted'>Были на туре и сделали фиксацию после</option>
                  </select>
                </label>
              </div>
            </div>
            {fixationRows.length === 0 ? (
              <div className='text-text-muted text-sm'>Нет фиксаций в выбранном периоде</div>
            ) : visibleFixationRows.length === 0 ? (
              <div className='text-text-muted text-sm'>Поиск не дал результатов</div>
            ) : (
              <>
                <div className='text-xs text-text-muted mb-2'>
                  Найдено: {visibleFixationRows.length} из {fixationRows.length}
                </div>
                <div className='overflow-x-auto'>
                  <table className='w-full min-w-[1600px] text-sm'>
                    <thead>
                      <tr className='border-b border-border text-text-muted'>
                        <SortableFixationHeader label='Брокер' sortKey='fullName' sort={fixationSort} onSort={toggleFixationSort} align='left' />
                        <th className='py-2 px-2 text-left font-medium'>Был на туре</th>
                        <th className='py-2 px-2 text-left font-medium'>Дата тура</th>
                        <th className='py-2 px-2 text-left font-medium'>Фиксация после тура</th>
                        <SortableFixationHeader label='Всего' sortKey='total' sort={fixationSort} onSort={toggleFixationSort} />
                        <SortableFixationHeader label='Уникальные' sortKey='conditionallyUnique' sort={fixationSort} onSort={toggleFixationSort} />
                        <SortableFixationHeader label='На проверке' sortKey='underReview' sort={fixationSort} onSort={toggleFixationSort} />
                        <SortableFixationHeader label='Отклонены' sortKey='rejected' sort={fixationSort} onSort={toggleFixationSort} />
                        <SortableFixationHeader label='Истекли' sortKey='expired' sort={fixationSort} onSort={toggleFixationSort} />
                        <SortableFixationHeader label='Зафиксировано' sortKey='fixed' sort={fixationSort} onSort={toggleFixationSort} />
                        <SortableFixationHeader label='Подал сам' sortKey='submittedBySelf' sort={fixationSort} onSort={toggleFixationSort} />
                        <SortableFixationHeader label='Подали другие' sortKey='submittedByOthers' sort={fixationSort} onSort={toggleFixationSort} />
                        <th className='py-2 pl-3 text-left font-medium'>Авторы подачи</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedFixationRows.map((row) => (
                        <tr key={row.brokerId} className='border-b border-border last:border-0 align-top hover:bg-surface-secondary/50'>
                          <td className='py-3 pr-3'>
                            <div className='font-medium'>{row.fullName}</div>
                            <div className='text-xs text-text-muted'>{row.phone || '—'}</div>
                          </td>
                          <td className='py-3 px-2'>
                            <span className={row.brokerTourVisited ? 'text-success font-medium' : 'text-text-muted'}>
                              {row.brokerTourVisited ? 'Да' : 'Нет'}
                            </span>
                          </td>
                          <td className='py-3 px-2 whitespace-nowrap'>{formatBrokerTourDate(row.brokerTourDate)}</td>
                          <td className='py-3 px-2'>
                            <span className={row.fixationAfterTour ? 'text-success font-medium' : 'text-text-muted'}>
                              {row.fixationAfterTour ? 'Да' : '—'}
                            </span>
                          </td>
                          <td className='py-3 px-2 text-right font-bold text-accent'>{row.total}</td>
                          <td className='py-3 px-2 text-right text-success'>{row.conditionallyUnique}</td>
                          <td className='py-3 px-2 text-right text-warning'>{row.underReview}</td>
                          <td className='py-3 px-2 text-right text-error'>{row.rejected}</td>
                          <td className='py-3 px-2 text-right text-text-muted'>{row.expired}</td>
                          <td className='py-3 px-2 text-right'>{row.fixed}</td>
                          <td className='py-3 px-2 text-right'>{row.submittedBySelf}</td>
                          <td className='py-3 px-2 text-right'>{row.submittedByOthers}</td>
                          <td className='py-3 pl-3 min-w-[16rem]'>
                            {(row.submitters ?? []).length === 0 ? (
                              <span className='text-text-muted'>—</span>
                            ) : (
                              <div className='space-y-1'>
                                {row.submitters.map((submitter) => (
                                  <div key={submitter.brokerId} className='flex items-center justify-between gap-3 text-xs'>
                                    <span className='truncate' title={submitter.fullName}>{submitter.fullName}</span>
                                    <span className='font-semibold text-accent tabular-nums'>{submitter.count}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {fixationTotalPages > 1 && (
                  <div className='flex items-center justify-between mt-4 pt-4 border-t border-border'>
                    <span className='text-sm text-text-muted'>
                      Стр. {safeFixationPage} из {fixationTotalPages} · показаны {fixationPageStart + 1}–{fixationPageStart + pagedFixationRows.length}
                    </span>
                    <div className='flex gap-2'>
                      <button
                        type='button'
                        className='btn btn-secondary'
                        onClick={() => setFixationPage(Math.max(1, safeFixationPage - 1))}
                        disabled={safeFixationPage === 1}
                        aria-label='Предыдущая страница отчёта по фиксациям'
                      >
                        <ChevronLeft className='w-4 h-4' />
                      </button>
                      <button
                        type='button'
                        className='btn btn-secondary'
                        onClick={() => setFixationPage(Math.min(fixationTotalPages, safeFixationPage + 1))}
                        disabled={safeFixationPage === fixationTotalPages}
                        aria-label='Следующая страница отчёта по фиксациям'
                      >
                        <ChevronRight className='w-4 h-4' />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          {/* Broker funnel */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4">Воронка брокеров (этапы)</h2>
            <div className="space-y-2">
              {data.brokers.funnelByStage.map((f) => {
                const total = data.brokers.funnelByStage.reduce((s, x) => s + x.count, 0);
                const pct = total > 0 ? Math.round((f.count / total) * 100) : 0;
                return (
                  <div key={f.stage}>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{stageLabels[f.stage] || f.stage}</span>
                      <span className="text-text-muted">{f.count}</span>
                    </div>
                    <div className="bg-surface-secondary rounded-full h-2">
                      <div className="bg-info h-full rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2026-07-08: Аналитика по источникам брокеров.
              Broker.source в БД был, но в UI не показывался. Показывает
              эффективность каналов привлечения — лендинг vs холодный
              обзвон vs брокер-туры. */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Users className="w-5 h-5 text-accent" /> Новые брокеры по источникам
            </h2>
            {(!data.bySource || data.bySource.length === 0) ? (
              <div className="text-text-muted text-sm">В выбранном периоде нет новых брокеров с указанным источником</div>
            ) : (
              <div className="space-y-2">
                {(() => {
                  const maxCount = Math.max(...data.bySource.map((s) => s.count), 1);
                  return data.bySource.map((s) => (
                    <div key={s.source}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span>{sourceLabels[s.source] || s.source}</span>
                        <span className="font-bold text-accent">{s.count}</span>
                      </div>
                      <div className="w-full bg-surface-secondary rounded-full h-2">
                        <div
                          className="bg-accent rounded-full h-2"
                          style={{ width: `${Math.round((s.count / maxCount) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>

          {/* 2026-07-07: Топ-10 по уникальным фиксациям — параллельно
              с топом по комиссии. Показывает, кто приносит фиксации,
              даже если сделки ещё не закрыты. */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Trophy className="w-5 h-5 text-accent" /> Топ-10 брокеров по уникальным фиксациям
            </h2>
            {data.topFixationBrokers.length === 0 ? (
              <div className="text-text-muted text-sm">Нет уникальных фиксаций в периоде</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-text-muted">
                      <th className="py-2 pr-2">#</th>
                      <th className="py-2 pr-2">Брокер</th>
                      <th className="py-2 pl-2 text-right">Уникальных фиксаций</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topFixationBrokers.map((b, i) => (
                      <tr key={b.brokerId} className="border-b border-border last:border-0">
                        <td className="py-2 pr-2 text-text-muted">{i + 1}</td>
                        <td className="py-2 pr-2">
                          <div className="font-medium">{b.fullName}</div>
                          <div className="text-xs text-text-muted">{b.phone}</div>
                        </td>
                        <td className="py-2 pl-2 text-right text-accent font-bold">{b.uniqueFixations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Top brokers */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Trophy className="w-5 h-5 text-accent" /> Топ-10 брокеров (по комиссии)
            </h2>
            {data.topBrokers.length === 0 ? (
              <div className="text-text-muted text-sm">Нет оплаченных сделок в периоде</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-text-muted">
                      <th className="py-2 pr-2">#</th>
                      <th className="py-2 pr-2">Брокер</th>
                      <th className="py-2 px-2 text-right">Сделок</th>
                      <th className="py-2 px-2 text-right">Сумма сделок</th>
                      <th className="py-2 pl-2 text-right">Комиссия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topBrokers.map((b, i) => (
                      <tr key={b.brokerId} className="border-b border-border last:border-0">
                        <td className="py-2 pr-2 text-text-muted">{i + 1}</td>
                        <td className="py-2 pr-2">
                          <div className="font-medium">{b.fullName}</div>
                          <div className="text-xs text-text-muted">{b.phone}</div>
                        </td>
                        <td className="py-2 px-2 text-right">{b.dealsCount}</td>
                        <td className="py-2 px-2 text-right">{fmtRub(b.totalAmount)}</td>
                        <td className="py-2 pl-2 text-right text-accent font-bold">{fmtRub(b.totalCommission)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Per-project */}
          <div className="card">
            <h2 className="text-lg font-semibold mb-4">Статистика по проектам</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.projects.map((p) => (
                <div key={p.project} className="p-4 bg-surface-secondary rounded-lg">
                  <h3 className="font-semibold mb-3">{projectLabels[p.project] || p.project}</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <Stat label="Всего сделок" value={p.totalDeals} />
                    <Stat label="Оплачено" value={p.paidDeals} />
                    <Stat label="Метраж продан" value={`${Math.round(p.totalSqm)} м²`} />
                    <Stat label="Сумма продаж" value={fmtRub(p.totalAmount)} />
                    <Stat label="Комиссия" value={fmtRub(p.totalCommission)} highlight />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, hint, isString }: { icon: any; label: string; value: any; hint?: string; isString?: boolean }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span className="text-text-muted text-sm">{label}</span>
        <Icon className="w-5 h-5 text-accent" />
      </div>
      <div className={`font-bold ${isString ? 'text-xl' : 'text-2xl'}`}>{value}</div>
      {hint && <div className="text-xs text-text-muted mt-1">{hint}</div>}
    </div>
  );
}

function FixationRow({ label, count, total, color, active, onClick }: {
  label: string;
  count: number;
  total: number;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`w-full rounded p-2 text-left transition hover:bg-surface-secondary ${active ? 'ring-2 ring-accent bg-accent/5' : ''}`}
    >
      <div className="flex justify-between text-sm mb-1">
        <span>{label}</span>
        <span className="text-text-muted">{count} · {pct}%</span>
      </div>
      <div className="bg-surface-secondary rounded-full h-2">
        <div className={`${color} h-full rounded-full`} style={{ width: `${pct}%` }} />
      </div>
    </button>
  );
}
function Stat({ label, value, highlight }: { label: string; value: any; highlight?: boolean }) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`font-medium ${highlight ? 'text-accent text-lg' : ''}`}>{value}</div>
    </div>
  );
}

function SortableFixationHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'right',
}: {
  label: string;
  sortKey: FixationSortKey;
  sort: FixationSort;
  onSort: (key: FixationSortKey) => void;
  align?: 'left' | 'right';
}) {
  const isActive = sort.key === sortKey;
  const Icon = !isActive ? ArrowUpDown : sort.direction === 'asc' ? ChevronUp : ChevronDown;
  const ariaSort: 'ascending' | 'descending' | 'none' = isActive
    ? sort.direction === 'asc' ? 'ascending' : 'descending'
    : 'none';

  return (
    <th
      className={`py-2 px-2 font-medium whitespace-nowrap ${align === 'left' ? 'text-left' : 'text-right'}`}
      aria-sort={ariaSort}
    >
      <button
        type="button"
        className={`inline-flex w-full items-center gap-1 hover:text-text ${align === 'left' ? 'justify-start' : 'justify-end'}`}
        onClick={() => onSort(sortKey)}
        aria-label={`Сортировать по столбцу «${label}»`}
      >
        <span>{label}</span>
        <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-accent' : ''}`} />
      </button>
    </th>
  );
}
