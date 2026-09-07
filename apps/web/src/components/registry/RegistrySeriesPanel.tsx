'use client';

// 2026-09-07: ряды «по дням / неделям / месяцам» для сделок (по дате оплаты
// ДДУ), платных броней (по дате оплаты ДВОУ) и фиксаций (по дате подачи), с
// разрезом по проекту. Данные — GET /admin/registry-deals/series (только
// чтение). Используется на странице «Реестр сделок» и в «Нашей базе».

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiGet } from '@/lib/api';

type Granularity = 'day' | 'week' | 'month';
type ProjectFilter = '' | 'ZORGE9' | 'SILVER_BOR';

type SeriesCounts = {
  deals: number;
  dealAmount: string;
  paidBookings: number;
  paidBookingAmount: string;
  fixations: number;
};

type SeriesBucket = SeriesCounts & {
  key: string;
  label: string;
  from: string;
  to: string;
  byProject: Record<string, SeriesCounts>;
};

type SeriesResponse = {
  granularity: Granularity;
  period: { from: string; to: string };
  project: string | null;
  buckets: SeriesBucket[];
  totals: SeriesCounts;
  totalsByProject: Record<string, SeriesCounts>;
  methodology: { deals: string; paidBookings: string; fixations: string; calendar: string };
};

const PROJECT_LABELS: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный Бор',
  UNKNOWN: 'Проект не указан',
};

const GRANULARITY_LABELS: Record<Granularity, string> = {
  day: 'По дням',
  week: 'По неделям',
  month: 'По месяцам',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Сегодняшняя московская дата YYYY-MM-DD. */
function moscowToday(): string {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function shiftDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function monthStartMonthsAgo(key: string, months: number): string {
  const [y, m] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 - months, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01`;
}

/** Локальная дата (МСК) → ISO-границы суток в UTC. */
const dayStartIso = (key: string) => new Date(`${key}T00:00:00+03:00`).toISOString();
const dayEndIso = (key: string) => new Date(`${key}T23:59:59.999+03:00`).toISOString();

const fmtInt = (value: number) => (Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—');
const fmtMoney = (value: string) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '—';
  return `${Math.round(n).toLocaleString('ru-RU')} ₽`;
};

export type RegistrySeriesPanelProps = {
  /** Заголовок блока. */
  title?: string;
  /** Начальные значения периода (YYYY-MM-DD, МСК). */
  initialFrom?: string;
  initialTo?: string;
  initialGranularity?: Granularity;
  /** Компактный режим (в «Нашей базе»): без методологии, свёрнут по умолчанию. */
  compact?: boolean;
};

export default function RegistrySeriesPanel({
  title = 'Динамика: фиксации, платные брони, сделки',
  initialFrom,
  initialTo,
  initialGranularity = 'month',
  compact = false,
}: RegistrySeriesPanelProps) {
  const today = useMemo(() => moscowToday(), []);
  const [granularity, setGranularity] = useState<Granularity>(initialGranularity);
  const [from, setFrom] = useState(initialFrom || monthStartMonthsAgo(today, 11));
  const [to, setTo] = useState(initialTo || today);
  const [project, setProject] = useState<ProjectFilter>('');
  const [byProject, setByProject] = useState(false);
  const [collapsed, setCollapsed] = useState(compact);
  const [data, setData] = useState<SeriesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        from: dayStartIso(from),
        to: dayEndIso(to),
        granularity,
      });
      if (project) params.set('project', project);
      const next = await apiGet<SeriesResponse>(`/admin/registry-deals/series?${params.toString()}`);
      setData(next && Array.isArray(next.buckets) ? next : null);
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить динамику');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, granularity, project]);

  useEffect(() => {
    if (collapsed) return;
    void load();
  }, [load, collapsed]);

  const applyPreset = (preset: '30d' | '12w' | '12m') => {
    if (preset === '30d') {
      setGranularity('day');
      setFrom(shiftDays(today, -29));
    } else if (preset === '12w') {
      setGranularity('week');
      setFrom(shiftDays(today, -7 * 12 + 1));
    } else {
      setGranularity('month');
      setFrom(monthStartMonthsAgo(today, 11));
    }
    setTo(today);
  };

  const maxima = useMemo(() => {
    const buckets = data?.buckets || [];
    return {
      fixations: Math.max(1, ...buckets.map((b) => b.fixations)),
      paidBookings: Math.max(1, ...buckets.map((b) => b.paidBookings)),
      deals: Math.max(1, ...buckets.map((b) => b.deals)),
    };
  }, [data]);

  const projectKeys = useMemo(() => {
    if (!data) return [] as string[];
    const keys = new Set<string>(Object.keys(data.totalsByProject || {}));
    return [...keys].sort();
  }, [data]);

  const bar = (value: number, max: number, tone: string) => (
    <span className="flex items-center gap-2 justify-end">
      <span
        className={`inline-block h-2 rounded ${tone}`}
        style={{ width: `${Math.max(value > 0 ? 6 : 0, Math.round((value / max) * 72))}px` }}
        aria-hidden="true"
      />
      <span className="tabular-nums">{fmtInt(value)}</span>
    </span>
  );

  return (
    <section className="card" data-testid="registry-series-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-lg">{title}</h2>
          <p className="text-xs text-text-muted mt-1">
            Сделки — по «Дате оплаты ДДУ» (неоплаченные не считаются), платные брони — по дате
            оплаты ДВОУ, фиксации — по дате подачи заявки. Календарь московский.
          </p>
        </div>
        {compact && (
          <button
            type="button"
            className="text-sm text-accent underline-offset-2 hover:underline"
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? 'Показать динамику' : 'Скрыть'}
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
            <div className="flex rounded-lg border border-border overflow-hidden">
              {(Object.keys(GRANULARITY_LABELS) as Granularity[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`px-3 py-1.5 ${granularity === key ? 'bg-accent text-white' : 'bg-surface hover:bg-surface-secondary'}`}
                  onClick={() => setGranularity(key)}
                  aria-pressed={granularity === key}
                >
                  {GRANULARITY_LABELS[key]}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">С</span>
              <input
                type="date"
                className="input !py-1.5"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">По</span>
              <input
                type="date"
                className="input !py-1.5"
                value={to}
                min={from}
                max={today}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">Проект</span>
              <select
                className="input !py-1.5"
                value={project}
                onChange={(e) => setProject(e.target.value as ProjectFilter)}
              >
                <option value="">Все проекты</option>
                <option value="ZORGE9">Зорге 9</option>
                <option value="SILVER_BOR">Серебряный Бор</option>
              </select>
            </label>
            <div className="flex gap-1">
              <button type="button" className="btn-secondary !py-1.5 !px-2.5 text-xs" onClick={() => applyPreset('30d')}>
                30 дней
              </button>
              <button type="button" className="btn-secondary !py-1.5 !px-2.5 text-xs" onClick={() => applyPreset('12w')}>
                12 недель
              </button>
              <button type="button" className="btn-secondary !py-1.5 !px-2.5 text-xs" onClick={() => applyPreset('12m')}>
                12 месяцев
              </button>
            </div>
            {!project && (
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input type="checkbox" checked={byProject} onChange={(e) => setByProject(e.target.checked)} />
                Разрез по проектам
              </label>
            )}
          </div>

          {error && <div className="mt-3 p-3 bg-error/20 text-error rounded text-sm">{error}</div>}
          {loading && <div className="mt-3 text-sm text-text-muted">Загрузка…</div>}

          {!loading && data && (
            <>
              <dl className="mt-4 grid gap-2 grid-cols-2 md:grid-cols-5 text-sm">
                <div className="rounded-lg bg-surface-secondary p-3">
                  <dt className="text-xs text-text-muted">Фиксации</dt>
                  <dd className="font-semibold text-lg tabular-nums">{fmtInt(data.totals.fixations)}</dd>
                </div>
                <div className="rounded-lg bg-surface-secondary p-3">
                  <dt className="text-xs text-text-muted">Платные брони</dt>
                  <dd className="font-semibold text-lg tabular-nums">{fmtInt(data.totals.paidBookings)}</dd>
                </div>
                <div className="rounded-lg bg-surface-secondary p-3">
                  <dt className="text-xs text-text-muted">Сумма ДВОУ</dt>
                  <dd className="font-semibold text-lg tabular-nums">{fmtMoney(data.totals.paidBookingAmount)}</dd>
                </div>
                <div className="rounded-lg bg-surface-secondary p-3">
                  <dt className="text-xs text-text-muted">Сделки (оплаченные ДДУ)</dt>
                  <dd className="font-semibold text-lg tabular-nums">{fmtInt(data.totals.deals)}</dd>
                </div>
                <div className="rounded-lg bg-surface-secondary p-3">
                  <dt className="text-xs text-text-muted">Сумма ДДУ</dt>
                  <dd className="font-semibold text-lg tabular-nums">{fmtMoney(data.totals.dealAmount)}</dd>
                </div>
              </dl>

              {byProject && projectKeys.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-text-muted">
                  {projectKeys.map((key) => {
                    const t = data.totalsByProject[key];
                    return (
                      <span key={key}>
                        <b className="text-text">{PROJECT_LABELS[key] || key}</b>: фиксации {fmtInt(t.fixations)},
                        брони {fmtInt(t.paidBookings)}, сделки {fmtInt(t.deals)} на {fmtMoney(t.dealAmount)}
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="mt-4 overflow-x-auto max-h-[520px] overflow-y-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-text-muted border-b border-border">
                      <th className="pb-2 text-left font-medium">Период</th>
                      <th className="pb-2 text-right font-medium">Фиксации</th>
                      <th className="pb-2 text-right font-medium">Платные брони</th>
                      <th className="pb-2 text-right font-medium">Сделки</th>
                      <th className="pb-2 text-right font-medium">Сумма ДДУ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.buckets.map((bucket) => (
                      <RowGroup
                        key={bucket.key}
                        bucket={bucket}
                        byProject={byProject && !project}
                        projectKeys={projectKeys}
                        maxima={maxima}
                        bar={bar}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {!compact && (
                <details className="mt-3 text-xs text-text-muted">
                  <summary className="cursor-pointer">Как считается</summary>
                  <ul className="mt-2 list-disc pl-5 space-y-1">
                    <li>{data.methodology.deals}</li>
                    <li>{data.methodology.paidBookings}</li>
                    <li>{data.methodology.fixations}</li>
                    <li>{data.methodology.calendar}</li>
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function RowGroup({
  bucket,
  byProject,
  projectKeys,
  maxima,
  bar,
}: {
  bucket: SeriesBucket;
  byProject: boolean;
  projectKeys: string[];
  maxima: { fixations: number; paidBookings: number; deals: number };
  bar: (value: number, max: number, tone: string) => ReactNode;
}) {
  const empty = bucket.fixations === 0 && bucket.paidBookings === 0 && bucket.deals === 0;
  return (
    <>
      <tr className={`border-b border-border last:border-0 ${empty ? 'text-text-muted' : ''}`}>
        <td className="py-2 whitespace-nowrap">{bucket.label}</td>
        <td className="py-2">{bar(bucket.fixations, maxima.fixations, 'bg-sky-400/70')}</td>
        <td className="py-2">{bar(bucket.paidBookings, maxima.paidBookings, 'bg-amber-400/70')}</td>
        <td className="py-2">{bar(bucket.deals, maxima.deals, 'bg-emerald-500/70')}</td>
        <td className="py-2 text-right whitespace-nowrap tabular-nums">{fmtMoney(bucket.dealAmount)}</td>
      </tr>
      {byProject &&
        projectKeys.map((key) => {
          const counts = bucket.byProject[key];
          if (!counts) return null;
          return (
            <tr key={`${bucket.key}:${key}`} className="text-xs text-text-muted border-b border-border/60">
              <td className="py-1 pl-4 whitespace-nowrap">↳ {PROJECT_LABELS[key] || key}</td>
              <td className="py-1 text-right tabular-nums">{fmtInt(counts.fixations)}</td>
              <td className="py-1 text-right tabular-nums">{fmtInt(counts.paidBookings)}</td>
              <td className="py-1 text-right tabular-nums">{fmtInt(counts.deals)}</td>
              <td className="py-1 text-right tabular-nums whitespace-nowrap">{fmtMoney(counts.dealAmount)}</td>
            </tr>
          );
        })}
    </>
  );
}
