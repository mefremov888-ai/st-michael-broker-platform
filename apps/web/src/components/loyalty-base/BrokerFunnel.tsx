"use client";

// 2026-09-08 (владелец): воронка брокера «Был на брокер-туре → фиксация →
// встреча → платная бронь → сделка». Карточка в обзоре + окно с режимами
// «строго после тура / за всё время», периодом по дате тура, источником
// фиксаций, когортами по месяцам, разрезом по агентствам и обратной воронкой.
// Графики — чистый CSS/SVG, без библиотек. Данные — GET /loyalty-base/ours/funnel.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, RefreshCcw, X } from "lucide-react";
import {
  getLoyaltyFunnel,
  type LoyaltyFunnelResponse,
  type LoyaltyFunnelStep,
} from "@/lib/loyalty-base-api";

type Mode = "strict" | "all";
type CabinetSource = "" | "old" | "new";
type PeriodPreset = "all" | "year" | "quarter" | "custom";

const pad = (n: number) => String(n).padStart(2, "0");
const moscowToday = () => {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
};
const dayStartIso = (key: string) => new Date(`${key}T00:00:00+03:00`).toISOString();
const dayEndIso = (key: string) => new Date(`${key}T23:59:59.999+03:00`).toISOString();
const fmt = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("ru-RU");
const pct = (value: number | null) =>
  value === null || value === undefined ? "—" : `${value.toLocaleString("ru-RU")}%`;
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
};

function presetRange(preset: PeriodPreset): { from: string; to: string } | null {
  const today = moscowToday();
  const [y, m] = today.split("-").map(Number);
  if (preset === "year") return { from: `${y}-01-01`, to: today };
  if (preset === "quarter") {
    const start = Math.floor((m - 1) / 3) * 3 + 1;
    return { from: `${y}-${pad(start)}-01`, to: today };
  }
  return null;
}

export type FunnelDrillStep = LoyaltyFunnelStep["key"];

function FunnelBars({
  steps,
  onDrill,
}: {
  steps: LoyaltyFunnelStep[];
  onDrill?: (step: FunnelDrillStep) => void;
}) {
  const max = Math.max(1, ...steps.map((s) => s.count));
  const colors = ["bg-accent", "bg-accent/80", "bg-accent/65", "bg-accent/50", "bg-accent/40"];
  return (
    <ol className="space-y-2" aria-label="Ступени воронки">
      {steps.map((step, index) => {
        const width = Math.max(2, Math.round((step.count / max) * 100));
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">{step.label}</span>
              <span className="whitespace-nowrap">
                <b>{fmt(step.count)}</b>
                {index > 0 && (
                  <span className="ml-2 text-xs text-text-muted">
                    {pct(step.fromPrevious)} от предыдущей · {pct(step.fromStart)} от тура
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 h-6 w-full rounded-lg bg-surface-secondary">
              <div
                className={`h-6 rounded-lg ${colors[index] || "bg-accent/40"} transition-all`}
                style={{ width: `${width}%` }}
                role="img"
                aria-label={`${step.label}: ${step.count}`}
              />
            </div>
          </>
        );
        return (
          <li key={step.key}>
            {onDrill ? (
              <button
                type="button"
                className="block w-full rounded-xl p-2 text-left hover:bg-surface-secondary/70"
                onClick={() => onDrill(step.key)}
                title="Открыть список брокеров этой ступени"
              >
                {body}
              </button>
            ) : (
              <div className="p-2">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function BrokerFunnelPanel({
  cabinetSource,
  onOpen,
}: {
  cabinetSource: "" | "old" | "new";
  onOpen: () => void;
}) {
  const [data, setData] = useState<LoyaltyFunnelResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(
        await getLoyaltyFunnel("ours", {
          mode: "strict",
          cabinetSource: cabinetSource || undefined,
        }),
      );
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить воронку");
    } finally {
      setLoading(false);
    }
  }, [cabinetSource]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Воронка брокера: тур → фиксация → встреча → бронь → сделка</h2>
          <p className="text-xs text-text-muted">
            Уникальные брокеры, строго после даты тура, за всё время наблюдений.
            {data ? ` В когорте ${fmt(data.totals.cohort)} брокеров с датой тура; ещё ${fmt(data.totals.withoutTourDate)} с отметкой без даты.` : ""}
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onOpen}>
          Подробнее: режимы, когорты, агентства →
        </button>
      </div>
      {error && (
        <div className="mt-3 flex justify-between rounded-lg bg-error/10 p-3 text-sm text-error">
          <span>
            <AlertCircle className="mr-2 inline h-4 w-4" />
            {error}
          </span>
          <button type="button" onClick={() => void load()}>
            <RefreshCcw className="h-4 w-4" />
          </button>
        </div>
      )}
      {loading && !data && (
        <p className="mt-3 text-sm text-text-muted">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Считаем воронку…
        </p>
      )}
      {data && (
        <div className="mt-3">
          <FunnelBars steps={data.funnel.steps} />
          <p className="mt-2 text-xs text-text-muted">
            Медиана: тур → фиксация {fmt(data.funnel.medianDays.tourToFixation)} дн. · фиксация → сделка{" "}
            {fmt(data.funnel.medianDays.fixationToDeal)} дн. Без отметки тура: {fmt(data.noTourFunnel.brokers)} брокеров,
            из них с фиксациями {fmt(data.noTourFunnel.withFixation)}, со сделками {fmt(data.noTourFunnel.withDeal)}.
          </p>
        </div>
      )}
    </section>
  );
}

export function BrokerFunnelModal({
  initialCabinetSource,
  onClose,
  onDrill,
}: {
  initialCabinetSource: "" | "old" | "new";
  onClose: () => void;
  onDrill?: (step: FunnelDrillStep, mode: Mode) => void;
}) {
  const [mode, setMode] = useState<Mode>("strict");
  const [preset, setPreset] = useState<PeriodPreset>("all");
  const today = useMemo(() => moscowToday(), []);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(today);
  const [cabinetSource, setCabinetSource] = useState<CabinetSource>(initialCabinetSource);
  const [data, setData] = useState<LoyaltyFunnelResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const range = useMemo(() => {
    if (preset === "custom") return from && to ? { from, to } : null;
    return presetRange(preset);
  }, [preset, from, to]);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(
        await getLoyaltyFunnel("ours", {
          mode,
          from: range ? dayStartIso(range.from) : undefined,
          to: range ? dayEndIso(range.to) : undefined,
          cabinetSource: cabinetSource || undefined,
        }),
      );
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить воронку");
    } finally {
      setLoading(false);
    }
  }, [mode, range, cabinetSource]);
  useEffect(() => {
    void load();
  }, [load]);
  const years = data ? Object.entries(data.totals.tourYears).sort(([a], [b]) => a.localeCompare(b)) : [];
  return (
    <div className="fixed inset-0 z-[75] flex items-stretch justify-end bg-black/50" role="dialog" aria-modal="true" aria-label="Воронка брокера">
      <div className="h-full w-full max-w-4xl overflow-y-auto bg-surface p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Воронка брокера</h2>
            <p className="text-xs text-text-muted">
              Был на брокер-туре → сделал фиксацию → провёл встречу с клиентом → платная бронь → сделка. Уникальные брокеры, правила те же, что в KPI «Нашей базы».
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onClose} aria-label="Закрыть">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="block text-sm">
            <span className="text-xs text-text-muted">Режим</span>
            <select className="input mt-1" value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
              <option value="strict">Строго после тура</option>
              <option value="all">За всё время</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-text-muted">Период по дате тура</span>
            <select className="input mt-1" value={preset} onChange={(event) => setPreset(event.target.value as PeriodPreset)}>
              <option value="all">За всё время</option>
              <option value="year">Текущий год</option>
              <option value="quarter">Текущий квартал</option>
              <option value="custom">Произвольные даты</option>
            </select>
          </label>
          {preset === "custom" && (
            <>
              <label className="block text-sm">
                <span className="text-xs text-text-muted">Тур с</span>
                <input className="input mt-1" type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <label className="block text-sm">
                <span className="text-xs text-text-muted">Тур по</span>
                <input className="input mt-1" type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
              </label>
            </>
          )}
          <label className="block text-sm">
            <span className="text-xs text-text-muted">Источник фиксаций</span>
            <select className="input mt-1" value={cabinetSource} onChange={(event) => setCabinetSource(event.target.value as CabinetSource)}>
              <option value="">Оба кабинета</option>
              <option value="new">Только новый кабинет</option>
              <option value="old">Только старый кабинет</option>
            </select>
          </label>
        </div>

        {error && (
          <div className="mt-4 flex justify-between rounded-lg bg-error/10 p-3 text-sm text-error">
            <span>
              <AlertCircle className="mr-2 inline h-4 w-4" />
              {error}
            </span>
            <button type="button" onClick={() => void load()}>
              <RefreshCcw className="h-4 w-4" />
            </button>
          </div>
        )}
        {loading && (
          <p className="mt-4 text-sm text-text-muted">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Считаем…
          </p>
        )}

        {data && (
          <div className="mt-4 space-y-6">
            <section className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">
                  Когорта: {fmt(data.totals.cohort)} брокеров
                  {data.mode === "strict" ? " с датой тура" : " с отметкой тура"}
                </h3>
                <span className="text-xs text-text-muted">
                  Всего с отметкой тура {fmt(data.totals.withTourMark)}, с датой {fmt(data.totals.withTourDate)}, без даты {fmt(data.totals.withoutTourDate)}
                  {years.length ? ` · туры по годам: ${years.map(([y, n]) => `${y} — ${fmt(n)}`).join(", ")}` : ""}
                </span>
              </div>
              <div className="mt-3">
                <FunnelBars steps={data.funnel.steps} onDrill={onDrill ? (step) => onDrill(step, data.mode) : undefined} />
              </div>
              <dl className="mt-3 grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg bg-surface-secondary p-2 text-sm">
                  <dt className="text-xs text-text-muted">Тур → первая фиксация</dt>
                  <dd className="font-semibold">{fmt(data.funnel.medianDays.tourToFixation)} дн. (медиана)</dd>
                </div>
                <div className="rounded-lg bg-surface-secondary p-2 text-sm">
                  <dt className="text-xs text-text-muted">Фиксация → встреча</dt>
                  <dd className="font-semibold">{fmt(data.funnel.medianDays.fixationToMeeting)} дн. (медиана)</dd>
                </div>
                <div className="rounded-lg bg-surface-secondary p-2 text-sm">
                  <dt className="text-xs text-text-muted">Фиксация → сделка</dt>
                  <dd className="font-semibold">{fmt(data.funnel.medianDays.fixationToDeal)} дн. (медиана)</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-text-muted">
                {data.mode === "strict" ? data.methodology.strict : data.methodology.all} {data.methodology.cohort}
              </p>
            </section>

            <section className="rounded-xl border border-border p-3">
              <h3 className="font-semibold">Когорты по месяцу тура</h3>
              <p className="text-xs text-text-muted">Сколько брокеров пришло на тур в месяце и какая доля сделала фиксацию за 30 и 90 дней, дошла до встречи и сделки.</p>
              {data.byMonth.length === 0 ? (
                <p className="mt-2 text-sm text-text-muted">Нет брокеров с датой тура в выбранном периоде.</p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-text-muted">
                        <th className="py-1 pr-3">Месяц тура</th>
                        <th className="py-1 pr-3 text-right">Брокеров</th>
                        <th className="py-1 pr-3 text-right">Фиксация за 30 дн.</th>
                        <th className="py-1 pr-3 text-right">Фиксация за 90 дн.</th>
                        <th className="py-1 pr-3 text-right">Фиксация всего</th>
                        <th className="py-1 pr-3 text-right">Встреча</th>
                        <th className="py-1 text-right">Сделка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byMonth.map((row) => {
                        const share = (n: number) => (row.brokers ? ` (${Math.round((n / row.brokers) * 100)}%)` : "");
                        return (
                          <tr key={row.month} className="border-b border-border last:border-0">
                            <td className="py-1 pr-3">{monthLabel(row.month)}</td>
                            <td className="py-1 pr-3 text-right">{fmt(row.brokers)}</td>
                            <td className="py-1 pr-3 text-right">{fmt(row.fixation30)}{share(row.fixation30)}</td>
                            <td className="py-1 pr-3 text-right">{fmt(row.fixation90)}{share(row.fixation90)}</td>
                            <td className="py-1 pr-3 text-right">{fmt(row.fixationAny)}{share(row.fixationAny)}</td>
                            <td className="py-1 pr-3 text-right">{fmt(row.meetingAny)}{share(row.meetingAny)}</td>
                            <td className="py-1 text-right">{fmt(row.dealAny)}{share(row.dealAny)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-border p-3">
              <h3 className="font-semibold">По агентствам (основное агентство брокера)</h3>
              <p className="text-xs text-text-muted">Топ агентств по числу брокеров в когорте и что они сделали после тура.</p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-text-muted">
                      <th className="py-1 pr-3">Агентство</th>
                      <th className="py-1 pr-3 text-right">На туре</th>
                      <th className="py-1 pr-3 text-right">Фиксации</th>
                      <th className="py-1 pr-3 text-right">Встречи</th>
                      <th className="py-1 text-right">Сделки</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byAgency.map((row) => (
                      <tr key={row.agencyId || "none"} className="border-b border-border last:border-0">
                        <td className="py-1 pr-3">{row.name}</td>
                        <td className="py-1 pr-3 text-right">{fmt(row.brokers)}</td>
                        <td className="py-1 pr-3 text-right">{fmt(row.withFixation)}</td>
                        <td className="py-1 pr-3 text-right">{fmt(row.withMeeting)}</td>
                        <td className="py-1 text-right">{fmt(row.withDeal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-xl border border-dashed border-border p-3">
              <h3 className="font-semibold">Без брокер-тура</h3>
              <p className="text-xs text-text-muted">{data.methodology.noTour}</p>
              <dl className="mt-2 grid gap-2 sm:grid-cols-5 text-sm">
                {[
                  ["Брокеров", data.noTourFunnel.brokers],
                  ["С фиксациями", data.noTourFunnel.withFixation],
                  ["Со встречами", data.noTourFunnel.withMeeting],
                  ["С платной бронью", data.noTourFunnel.withPaidBooking],
                  ["Со сделками", data.noTourFunnel.withDeal],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg bg-surface-secondary p-2">
                    <dt className="text-xs text-text-muted">{label}</dt>
                    <dd className="font-semibold">{fmt(Number(value))}</dd>
                  </div>
                ))}
              </dl>
              {data.totals.annaTourUnconfirmed > 0 && (
                <p className="mt-2 text-xs text-warning">
                  Ещё у {fmt(data.totals.annaTourUnconfirmed)} наших брокеров тур отмечен только в файле Анны (не подтверждено), в когорту они не входят.
                </p>
              )}
            </section>

            <details className="rounded-xl border border-border p-3 text-sm">
              <summary className="cursor-pointer font-medium">Как считаем</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-text-muted">
                <li>{data.methodology.steps}</li>
                <li>{data.methodology.strict}</li>
                <li>{data.methodology.all}</li>
                <li>{data.methodology.medians}</li>
                <li>{data.methodology.cohort}</li>
              </ul>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
