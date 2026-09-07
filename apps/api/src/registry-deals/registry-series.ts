// 2026-09-07: ряды «по дням / неделям / месяцам» для сделок, платных броней
// и фиксаций (требование владельца: ряды обязательны, с разрезом по проекту).
// Чистые функции без Prisma — считаются в памяти по уже выбранным строкам.
//
// Календарь — Europe/Moscow (UTC+3, без перехода на летнее время): «день»
// = московские сутки, «неделя» — с понедельника, «месяц» — календарный.

export type SeriesGranularity = 'day' | 'week' | 'month';
export const SERIES_GRANULARITIES: SeriesGranularity[] = ['day', 'week', 'month'];
export const SERIES_PROJECTS = ['ZORGE9', 'SILVER_BOR'] as const;
export type SeriesProject = (typeof SERIES_PROJECTS)[number];

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Защита от «день за 10 лет»: больше корзин не отдаём. */
export const SERIES_MAX_BUCKETS = 1200;

const pad = (n: number) => String(n).padStart(2, '0');

/** Московская дата (YYYY-MM-DD) момента времени. */
export function moscowDateKey(date: Date): string {
  const shifted = new Date(date.getTime() + MSK_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Начало московских суток (UTC-момент) для YYYY-MM-DD. */
export function moscowDayStart(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - MSK_OFFSET_MS);
}

/** Ключ корзины: день YYYY-MM-DD, неделя — YYYY-MM-DD понедельника, месяц YYYY-MM. */
export function bucketKey(date: Date, granularity: SeriesGranularity): string {
  const shifted = new Date(date.getTime() + MSK_OFFSET_MS);
  if (granularity === 'month') {
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
  }
  if (granularity === 'week') {
    const dow = (shifted.getUTCDay() + 6) % 7; // 0 = понедельник
    const monday = new Date(shifted.getTime() - dow * DAY_MS);
    return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
  }
  return moscowDateKey(date);
}

/** Границы корзины [from, to) в UTC-моментах. */
export function bucketRange(key: string, granularity: SeriesGranularity): { from: Date; to: Date } {
  if (granularity === 'month') {
    const [y, m] = key.split('-').map(Number);
    return {
      from: new Date(Date.UTC(y, m - 1, 1) - MSK_OFFSET_MS),
      to: new Date(Date.UTC(y, m, 1) - MSK_OFFSET_MS),
    };
  }
  const from = moscowDayStart(key);
  return { from, to: new Date(from.getTime() + (granularity === 'week' ? 7 : 1) * DAY_MS) };
}

/** Следующий ключ корзины. */
export function nextBucketKey(key: string, granularity: SeriesGranularity): string {
  const { to } = bucketRange(key, granularity);
  return bucketKey(to, granularity);
}

/** Все ключи корзин, покрывающие [from, to] (включительно), по порядку. */
export function enumerateBuckets(from: Date, to: Date, granularity: SeriesGranularity): string[] {
  const keys: string[] = [];
  if (!(from instanceof Date) || !(to instanceof Date) || to.getTime() < from.getTime()) return keys;
  let key = bucketKey(from, granularity);
  const last = bucketKey(to, granularity);
  for (let guard = 0; guard <= SERIES_MAX_BUCKETS; guard++) {
    keys.push(key);
    if (key === last) break;
    key = nextBucketKey(key, granularity);
  }
  return keys;
}

const MONTHS_RU = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

/** Подпись корзины по-русски. */
export function bucketLabel(key: string, granularity: SeriesGranularity): string {
  if (granularity === 'month') {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS_RU[m - 1] || key} ${y}`;
  }
  const [y, m, d] = key.split('-');
  if (granularity === 'week') return `нед. с ${d}.${m}.${y}`;
  return `${d}.${m}.${y}`;
}

/** Копейки из Decimal-строки/числа (14,2) — без плавающей точки в сумме. */
export function toCents(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const s = String(value).trim().replace(',', '.');
  const negative = s.startsWith('-');
  const [intPart, fracPart = ''] = s.replace('-', '').split('.');
  const cents = Number(intPart || '0') * 100 + Number((fracPart + '00').slice(0, 2));
  if (!Number.isFinite(cents)) return 0;
  return negative ? -cents : cents;
}

export function centsToMoneyString(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${pad(abs % 100)}`;
}

export interface SeriesCounts {
  deals: number;
  dealAmount: string;
  paidBookings: number;
  paidBookingAmount: string;
  fixations: number;
}

export interface SeriesBucket extends SeriesCounts {
  key: string;
  label: string;
  from: string;
  to: string;
  byProject: Record<string, SeriesCounts>;
}

type Acc = { deals: number; dealCents: number; bookings: number; bookingCents: number; fixations: number };
const emptyAcc = (): Acc => ({ deals: 0, dealCents: 0, bookings: 0, bookingCents: 0, fixations: 0 });
const accToCounts = (a: Acc): SeriesCounts => ({
  deals: a.deals,
  dealAmount: centsToMoneyString(a.dealCents),
  paidBookings: a.bookings,
  paidBookingAmount: centsToMoneyString(a.bookingCents),
  fixations: a.fixations,
});

export interface SeriesInputRow {
  date: Date | string | null | undefined;
  project?: string | null;
  amount?: unknown;
}

/**
 * Собирает ряд из трёх наборов событий. Корзины перечисляются по всему
 * периоду (нулевые тоже возвращаются — иначе график «сжимается»).
 */
export function buildSeries(
  params: { from: Date; to: Date; granularity: SeriesGranularity },
  events: { deals: SeriesInputRow[]; paidBookings: SeriesInputRow[]; fixations: SeriesInputRow[] },
): { buckets: SeriesBucket[]; totals: SeriesCounts; totalsByProject: Record<string, SeriesCounts> } {
  const { from, to, granularity } = params;
  const keys = enumerateBuckets(from, to, granularity);
  const acc = new Map<string, { all: Acc; byProject: Map<string, Acc> }>();
  for (const key of keys) acc.set(key, { all: emptyAcc(), byProject: new Map() });
  const totalAll = emptyAcc();
  const totalByProject = new Map<string, Acc>();

  const apply = (row: SeriesInputRow, fn: (a: Acc) => void) => {
    if (!row.date) return;
    const date = row.date instanceof Date ? row.date : new Date(row.date);
    if (Number.isNaN(date.getTime())) return;
    if (date.getTime() < from.getTime() || date.getTime() > to.getTime()) return;
    const bucket = acc.get(bucketKey(date, granularity));
    if (!bucket) return;
    const project = row.project || 'UNKNOWN';
    fn(bucket.all);
    fn(totalAll);
    if (!bucket.byProject.has(project)) bucket.byProject.set(project, emptyAcc());
    fn(bucket.byProject.get(project)!);
    if (!totalByProject.has(project)) totalByProject.set(project, emptyAcc());
    fn(totalByProject.get(project)!);
  };

  for (const row of events.deals) {
    const cents = toCents(row.amount);
    apply(row, (a) => { a.deals += 1; a.dealCents += cents; });
  }
  for (const row of events.paidBookings) {
    const cents = toCents(row.amount);
    apply(row, (a) => { a.bookings += 1; a.bookingCents += cents; });
  }
  for (const row of events.fixations) {
    apply(row, (a) => { a.fixations += 1; });
  }

  const toRecord = (m: Map<string, Acc>) => {
    const out: Record<string, SeriesCounts> = {};
    for (const [k, v] of [...m.entries()].sort((x, y) => x[0].localeCompare(y[0]))) out[k] = accToCounts(v);
    return out;
  };

  const buckets: SeriesBucket[] = keys.map((key) => {
    const range = bucketRange(key, granularity);
    const entry = acc.get(key)!;
    return {
      key,
      label: bucketLabel(key, granularity),
      from: range.from.toISOString(),
      to: new Date(range.to.getTime() - 1).toISOString(),
      ...accToCounts(entry.all),
      byProject: toRecord(entry.byProject),
    };
  });
  return { buckets, totals: accToCounts(totalAll), totalsByProject: toRecord(totalByProject) };
}
