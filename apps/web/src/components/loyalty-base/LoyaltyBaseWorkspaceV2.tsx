"use client";
/* eslint-disable react-hooks/set-state-in-effect, @typescript-eslint/no-unused-expressions */

import RegistrySeriesPanel from "@/components/registry/RegistrySeriesPanel";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Building2,
  Cake,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  FileJson,
  Info,
  KeyRound,
  ListChecks,
  Loader2,
  Megaphone,
  ScanSearch,
  Plus,
  PhoneCall,
  PhoneOff,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  downloadBlob,
  exportLoyaltyList,
  formatRubles,
  getLoyaltyDetail,
  getLoyaltyList,
  getLoyaltyOverview,
  hasLoyaltyActivityEvidence,
  loyaltyLeaderMode,
  loyaltyMetricsForDisplay,
  type LoyaltyActivitySummary,
  type LoyaltyBaseKey,
  type LoyaltyColumnFilters,
  type LoyaltyEntityType,
  type LoyaltyLeader,
  type LoyaltyListResponse,
  type LoyaltyOverview,
  type LoyaltyRecord,
  type LoyaltySegment,
  type LoyaltySortField,
} from "@/lib/loyalty-base-api";
import {
  emptyLoyaltyFilters,
  formatLoyaltyMetricExplanation,
  loyaltyMetricPeriodLabel,
  restoreLoyaltySavedView,
  sanitizeLoyaltyFilterState,
  toCanonicalFilter,
  type LoyaltyFilterFormState,
  type LoyaltyMetricExplanation,
} from "@/lib/loyalty-ui-model";
import {
  addLoyaltyContact,
  getLoyaltyEffectivePermissions,
  getLoyaltyCampaigns,
  getLoyaltyOperators,
  type LoyaltyEffectivePermissions,
  type LoyaltyPermission,
  type LoyaltyCampaign,
  type LoyaltyOperator,
} from "@/lib/loyalty-workflow-api";
import {
  ANNA_AGENCY_PARTNERSHIP_OPTIONS,
  ANNA_BROKER_STATUS_OPTIONS,
  ANNA_COLUMN_ARIA_LABELS,
  ANNA_EMPTY_OPTIONS,
  ANNA_ENTITY_TAB_LABELS,
  ANNA_KPI_CHIP_LABELS,
  ANNA_RANKING_PERIOD_OPTIONS,
  ANNA_SHOW_ALL_LABEL,
} from "@/lib/loyalty-anna-filter-contract";
import { AnnaImportPanel } from "./AnnaImportPanel";
import { LoyaltyCallResultBadge } from "./LoyaltyCallResultBadge";
import { LoyaltyCampaignDashboard } from "./LoyaltyCampaignDashboard";
import { LoyaltyCampaignModal } from "./LoyaltyCampaignModal";
import { LoyaltyFilterPanel } from "./LoyaltyFilterPanel";
import { LoyaltyGrantsPanel } from "./LoyaltyGrantsPanel";
import { LoyaltyQueuePanel } from "./LoyaltyQueuePanel";
import { LoyaltyReconciliationV2 } from "./LoyaltyReconciliationV2";
import { LoyaltyRecordDrawer } from "./LoyaltyRecordDetailV2";
import { LoyaltySavedViews } from "./LoyaltySavedViews";
import { LoyaltyStatusLegend } from "./LoyaltyStatusLegend";
import {
  BrokerFunnelModal,
  BrokerFunnelPanel,
  type FunnelDrillStep,
} from "./BrokerFunnel";
import { LoyaltyStatusBadges } from "./LoyaltyStatusBadges";
import { LoyaltySyncPanel } from "./LoyaltySyncPanel";

type ContextKey = `${LoyaltyBaseKey}:${LoyaltyEntityType}`;
type PeriodPreset = "month" | "quarter" | "custom";
const baseLabels = { anna: "База Анны Скибицкой", ours: "Наша база" } as const;
const entityLabels = { brokers: "Брокеры", agencies: "Агентства" } as const;
const SEGMENT_LABELS: Record<LoyaltySegment, string> = {
  NOT_CALLED_CURRENT_MONTH: ANNA_KPI_CHIP_LABELS[0],
  NEW_BROKER: ANNA_KPI_CHIP_LABELS[1],
  BT_WITHOUT_FIXATION: ANNA_KPI_CHIP_LABELS[2],
  BIRTHDAY_TODAY: ANNA_KPI_CHIP_LABELS[3],
};
const contextKey = (
  base: LoyaltyBaseKey,
  entity: LoyaltyEntityType,
): ContextKey => `${base}:${entity}`;
const contexts = (): Record<ContextKey, LoyaltyFilterFormState> => ({
  "anna:brokers": emptyLoyaltyFilters(),
  "anna:agencies": emptyLoyaltyFilters(),
  "ours:brokers": emptyLoyaltyFilters(),
  "ours:agencies": emptyLoyaltyFilters(),
});
const segments = (): Record<ContextKey, LoyaltySegment | ""> => ({
  "anna:brokers": "",
  "anna:agencies": "",
  "ours:brokers": "",
  "ours:agencies": "",
});
const columnContexts = (): Record<ContextKey, LoyaltyColumnFilters> => ({
  "anna:brokers": {},
  "anna:agencies": {},
  "ours:brokers": {},
  "ours:agencies": {},
});
const moscowParts = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const number = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: number("year"), month: number("month") };
};
const iso = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
const periodRange = (preset: Exclude<PeriodPreset, "custom">) => {
  const now = moscowParts();
  const start =
    preset === "quarter" ? Math.floor((now.month - 1) / 3) * 3 : now.month - 1;
  const length = preset === "quarter" ? 3 : 1;
  return {
    from: iso(now.year, start, 1),
    to: iso(now.year, start + length, 0),
  };
};
const date = (text: string) => {
  if (!text) return "Нет данных";
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? text
    : parsed.toLocaleDateString("ru-RU");
};
const number = (value: number | null) =>
  value === null ? "Нет данных" : value.toLocaleString("ru-RU");
const money = (value: string | null) =>
  formatRubles(value).replace("—", "Нет данных");

function KpiCard({
  title,
  value,
  detail,
  formula,
  period,
  source,
  exactness,
  includedSemantics,
  excludedSemantics,
  icon: Icon,
  onClick,
  loading,
}: {
  title: string;
  value: ReactNode;
  detail: string;
  formula: string;
  period: string;
  source: string;
  exactness: string;
  includedSemantics?: string;
  excludedSemantics?: string;
  icon: typeof Users;
  onClick?: () => void;
  loading: boolean;
}) {
  const tooltip = formatLoyaltyMetricExplanation({
    formula,
    period,
    source,
    exactness,
    includedSemantics,
    excludedSemantics,
  });
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      aria-label={`${title}. ${tooltip}`}
      className="group relative flex min-h-[4.5rem] flex-col rounded-xl border border-border bg-surface px-4 py-2 text-left transition hover:border-accent/50 hover:shadow-sm disabled:cursor-default"
    >
      <div className="flex w-full items-start justify-between gap-2">
        <h3 className="text-sm text-text-muted">{title}</h3>
        <span className="flex items-center gap-1">
          <Info className="h-4 w-4 text-text-muted" />
          <span className="rounded-lg bg-accent/10 p-1 text-accent">
            <Icon className="h-4 w-4" />
          </span>
        </span>
      </div>
      {loading ? (
        <span className="mt-1 h-6 w-24 animate-pulse rounded bg-surface-secondary" />
      ) : (
        <strong className="mt-1 text-xl leading-tight">{value}</strong>
      )}
      <small className="mt-auto truncate pt-0.5 text-xs leading-tight text-text-muted">
        {detail}
      </small>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute left-2 right-2 top-[calc(100%-0.5rem)] z-40 whitespace-pre-line rounded-lg bg-text p-3 text-xs font-normal leading-relaxed text-surface opacity-0 shadow-xl group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100"
      >
        {tooltip}
      </span>
    </button>
  );
}

function Metric({
  label,
  children,
  onClick,
  explanation,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  explanation?: LoyaltyMetricExplanation;
}) {
  const tooltip = explanation
    ? formatLoyaltyMetricExplanation(explanation)
    : "";
  const content = (
    <>
      <span className="flex items-start justify-between gap-2 text-xs text-text-muted">
        <span>{label}</span>
        {tooltip && (
          <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
      </span>
      <span className="mt-1 block font-semibold break-words">{children}</span>
      {tooltip && (
        <span
          role="tooltip"
          className="pointer-events-none invisible absolute left-2 right-2 top-[calc(100%-0.25rem)] z-40 whitespace-pre-line rounded-lg bg-text p-3 text-xs font-normal leading-relaxed text-surface opacity-0 shadow-xl group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100"
        >
          {tooltip}
        </span>
      )}
    </>
  );
  if (onClick)
    return (
      <button
        type="button"
        className="group relative rounded-xl border border-border p-3 text-left transition hover:border-accent/50 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={onClick}
        title={tooltip || undefined}
        aria-label={`${label}: открыть детализацию${tooltip ? `. ${tooltip}` : ""}`}
      >
        {content}
      </button>
    );
  return (
    <div
      className="group relative rounded-xl border border-border p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      title={tooltip || undefined}
      tabIndex={tooltip ? 0 : undefined}
      aria-label={tooltip ? `${label}. ${tooltip}` : undefined}
    >
      {content}
    </div>
  );
}

const availabilityLabels: Record<string, string> = {
  localPreliminary: "Локальные предварительные данные",
  exactness: "Точность",
  defaultVisibilityApplied: "Базовое правило видимости",
  visibilityRule: "Правило видимости",
  unavailableFilters: "Фильтры без данных в Нашей базе",
  methodology: "Методика",
  exactActivities: "Событийные активности",
  sourceReportedAggregates: "Агрегаты исходной таблицы",
  callPeriod: "Период звонков",
  activityPeriod: "Период встреч и сделок",
  unknownValuesRemainNull: "Неизвестные значения",
};

const availabilityValue = (key: string, value: unknown) => {
  if (key === "unknownValuesRemainNull")
    return value === true
      ? "показываются как «Нет данных»"
      : "правило не подтверждено";
  if (typeof value === "boolean") return value ? "доступны" : "недоступны";
  const labels: Record<string, string> = {
    LOCAL_PRELIMINARY: "локальные предварительные данные",
    LOCAL_PRELIMINARY_RELATION_ROWS:
      "предварительно по текущим связям брокеров и агентств",
    LOCAL_PRELIMINARY_LEGACY_CALL_LOGS:
      "предварительно по локальным логам звонков",
    APPROXIMATE: "предварительная",
    EXACT: "доступен по точным датам",
    PARTIAL_DATE_OR_MONTH: "частично: точная дата или месяц",
    SOURCE_REPORTED_MONTH_OR_LAST_DATE:
      "месяц из источника или последняя известная дата",
    UNAVAILABLE_FOR_AGENCY: "недоступен для агентств",
    EXACT_DEALS_ONLY: "точны только подтверждённые сделки",
    SOURCE_DECLARED: "заявлено в исходном срезе, не подтверждено событиями",
    UNKNOWN: "точность источником не подтверждена",
    UNAVAILABLE: "недоступен",
  };
  return labels[String(value)] || String(value || "Нет данных");
};

function DataAvailabilityNotice({
  values,
}: {
  values: Record<string, unknown>;
}) {
  const entries = Object.entries(values);
  if (!entries.length) return null;
  return (
    <aside
      className="mb-3 rounded-xl border border-border bg-surface-secondary p-3"
      aria-label="Доступность данных"
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div>
          <b className="text-sm">Доступность данных</b>
          <p className="text-xs text-text-muted">
            Это характеристика источника и периода, а не подтверждение наличия
            событий. Нулевые значения не объявляются точными без событийного
            основания.
          </p>
        </div>
      </div>
      <dl className="mt-2 flex flex-wrap gap-2">
        {entries.map(([key, value]) => (
          <div
            className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs"
            key={key}
          >
            <dt className="inline text-text-muted">
              {availabilityLabels[key] || key}:{" "}
            </dt>
            <dd className="inline font-medium">
              {availabilityValue(key, value)}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function LoyaltyTable({
  data,
  entityType,
  selected,
  onSelected,
  allFilterSelected,
  excluded,
  onExcluded,
  onOpen,
  operators,
  columnDraft,
  onColumnDraft,
  sortBy,
  sortOrder,
  onSort,
}: {
  data: LoyaltyListResponse;
  entityType: LoyaltyEntityType;
  selected: Set<string>;
  onSelected: (next: Set<string>) => void;
  allFilterSelected: boolean;
  excluded: Set<string>;
  onExcluded: (next: Set<string>) => void;
  onOpen: (id: string) => void;
  operators: LoyaltyOperator[];
  columnDraft: LoyaltyColumnFilters;
  onColumnDraft: (next: LoyaltyColumnFilters) => void;
  // 2026-09-08 (просьба владельца): сортировка кликом по заголовку столбца.
  sortBy: LoyaltySortField;
  sortOrder: "asc" | "desc";
  onSort: (field: LoyaltySortField) => void;
}) {
  // Заголовок-кнопка: клик — сортировать по полю, повторный — сменить направление.
  const SortHeader = ({ field, children, align = "left" }: { field: LoyaltySortField; children: ReactNode; align?: "left" | "right" }) => {
    const active = sortBy === field;
    return (
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`inline-flex items-center gap-1 font-medium hover:text-text ${active ? "text-text" : ""} ${align === "right" ? "justify-end w-full" : ""}`}
        title={active ? (sortOrder === "asc" ? "По возрастанию · нажмите для убывания" : "По убыванию · нажмите для возрастания") : "Сортировать"}
        aria-sort={active ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
      >
        {children}
        <span aria-hidden="true" className={active ? "" : "opacity-30"}>{active && sortOrder === "asc" ? "▲" : "▼"}</span>
      </button>
    );
  };
  // «Не звонить» (задача A): в «Нашей базе» такие брокеры видны в списке,
  // но недоступны для ручного выбора — кампании обзвона их всегда исключают.
  const selectable = (item: LoyaltyRecord) =>
    !(
      data.base === "ours" &&
      entityType === "brokers" &&
      item.doNotCall === true
    );
  const isChecked = (id: string) =>
    allFilterSelected ? !excluded.has(id) : selected.has(id);
  const selectableItems = data.items.filter((item) => selectable(item));
  const allPage =
    selectableItems.length > 0 &&
    selectableItems.every((item) => isChecked(item.id));
  const toggleAll = () => {
    if (allFilterSelected) {
      const next = new Set(excluded);
      selectableItems.forEach((item) => {
        if (allPage) next.add(item.id);
        else next.delete(item.id);
      });
      onExcluded(next);
      return;
    }
    const next = new Set(selected);
    selectableItems.forEach((item) => {
      if (allPage) next.delete(item.id);
      else next.add(item.id);
    });
    onSelected(next);
  };
  const setColumn = (key: keyof LoyaltyColumnFilters, value: string) =>
    onColumnDraft({ ...columnDraft, [key]: value || undefined });
  const selectClass = "input h-8 min-w-28 px-2 text-xs";
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1160px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="pb-2 pr-2">
              <input
                type="checkbox"
                checked={allPage}
                onChange={toggleAll}
                aria-label="Выбрать текущую страницу"
              />
            </th>
            <th className="pb-2 pr-3">
              <SortHeader field="name">{entityType === "brokers" ? "Брокер" : "Агентство"}</SortHeader>
            </th>
            <th className="pb-2 pr-3">
              {entityType === "brokers"
                ? "Статус и стадия"
                : "Уровень партнёрства"}
            </th>
            <th className="pb-2 pr-3">
              <span className="inline-flex items-center gap-2">
                <SortHeader field="fixations">Активность</SortHeader>
                <span className="text-xs text-text-muted">·</span>
                <SortHeader field="meetings"><span className="text-xs">встречи</span></SortHeader>
              </span>
            </th>
            <th className="pb-2 pr-3"><SortHeader field="lastCallAt">Прошлые обзвоны</SortHeader></th>
            <th className="pb-2 pr-3">Ответственный</th>
            <th className="pb-2 text-right">
              <span className="inline-flex items-center justify-end gap-2">
                <SortHeader field="deals" align="right">Сделки</SortHeader>
                <span className="text-xs text-text-muted">·</span>
                <SortHeader field="dealAmount" align="right"><span className="text-xs">сумма</span></SortHeader>
              </span>
            </th>
          </tr>
          <tr className="border-b border-border align-top">
            <th />
            <th className="pb-2 pr-3">
              <select
                className={selectClass}
                aria-label={ANNA_COLUMN_ARIA_LABELS.contact}
                value={columnDraft.contact || ""}
                onChange={(event) => setColumn("contact", event.target.value)}
              >
                <option value="">Все контакты</option>
                <option value="HAS_PHONE">С телефоном</option>
                <option value="NO_PHONE">Без телефона</option>
              </select>
            </th>
            <th className="pb-2 pr-3">
              <select
                className={selectClass}
                aria-label={ANNA_COLUMN_ARIA_LABELS.status}
                value={columnDraft.statusStage || ""}
                onChange={(event) =>
                  setColumn("statusStage", event.target.value)
                }
              >
                <option value="">Все статусы</option>
                {(entityType === "brokers"
                  ? ANNA_BROKER_STATUS_OPTIONS
                  : ANNA_AGENCY_PARTNERSHIP_OPTIONS
                ).map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </th>
            <th className="pb-2 pr-3">
              <select
                className={selectClass}
                aria-label={ANNA_COLUMN_ARIA_LABELS.activity}
                value={columnDraft.activity || ""}
                onChange={(event) => setColumn("activity", event.target.value)}
              >
                <option value="">Вся активность</option>
                <option value="BT_VISITED">Был БТ</option>
                <option value="BT_NOT_VISITED">Не было БТ</option>
                <option value="HAS_FIXATIONS">Есть фиксации</option>
                {data.base === "ours" && entityType === "brokers" && (
                  <option value="HAS_ACTIVE_FIXATIONS">
                    Действующая фиксация
                  </option>
                )}
                <option value="NO_FIXATIONS">Нет фиксаций</option>
                <option value="HAS_MEETINGS">Есть встречи</option>
                <option value="NO_MEETINGS">Нет встреч</option>
              </select>
            </th>
            <th className="pb-2 pr-3">
              <select
                className={selectClass}
                aria-label={ANNA_COLUMN_ARIA_LABELS.calls}
                value={columnDraft.calls || ""}
                onChange={(event) => setColumn("calls", event.target.value)}
              >
                <option value="">Все звонки</option>
                <option value="CALLED_IN_PERIOD">Звонили в период</option>
                <option value="NOT_CALLED_IN_PERIOD">
                  Не звонили в период
                </option>
              </select>
            </th>
            <th className="pb-2 pr-3">
              <select
                className={selectClass}
                aria-label={ANNA_COLUMN_ARIA_LABELS.assignee}
                value={columnDraft.assignee || ""}
                onChange={(event) => setColumn("assignee", event.target.value)}
              >
                <option value="">{ANNA_EMPTY_OPTIONS.columnAssignees}</option>
                <option value="UNASSIGNED">{ANNA_EMPTY_OPTIONS.unassigned}</option>
                {operators.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
                {data.facets.assignees
                  .filter(
                    (facet) =>
                      !operators.some(
                        (person) =>
                          person.id === facet.value ||
                          person.name === facet.value,
                      ),
                  )
                  .map((facet) => (
                    <option key={facet.value} value={facet.value}>
                      {facet.value} ({facet.matches})
                    </option>
                  ))}
              </select>
            </th>
            <th className="pb-2">
              <select
                className={selectClass}
                aria-label={ANNA_COLUMN_ARIA_LABELS.deals}
                value={columnDraft.deals || ""}
                onChange={(event) => setColumn("deals", event.target.value)}
              >
                <option value="">Все сделки</option>
                <option value="HAS_DEALS">Есть сделки</option>
                <option value="NO_DEALS">Нет сделок</option>
                {entityType === "brokers" ? (
                  <>
                    <option value="ONE_TO_TWO">1–2 сделки</option>
                    <option value="THREE_PLUS">3+ сделки</option>
                  </>
                ) : (
                  <>
                    <option value="ONE_TO_FOUR">1–4 сделки</option>
                    <option value="FIVE_PLUS">5+ сделок</option>
                  </>
                )}
              </select>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => {
            const displayedMetrics = loyaltyMetricsForDisplay(item);
            const linkedMetrics = item.linkedOurRecord
              ? loyaltyMetricsForDisplay(item.linkedOurRecord)
              : null;
            const sourceMetrics = item.sourceReportedMetrics;
            const hasSourceMetrics = Boolean(
              sourceMetrics &&
              [
                sourceMetrics.fixations,
                sourceMetrics.meetings,
                sourceMetrics.deals,
                sourceMetrics.dealAmount,
              ].some((value) => value !== null),
            );
            return (
              <tr
                key={item.id}
                className="border-b border-border last:border-0 hover:bg-surface-secondary/70"
              >
                <td className="py-3 pr-2">
                  <input
                    type="checkbox"
                    checked={selectable(item) && isChecked(item.id)}
                    disabled={!selectable(item)}
                    title={
                      selectable(item)
                        ? undefined
                        : "В списке «не звонить» — недоступен для обзвона"
                    }
                    onChange={() => {
                      if (allFilterSelected) {
                        const next = new Set(excluded);
                        next.has(item.id)
                          ? next.delete(item.id)
                          : next.add(item.id);
                        onExcluded(next);
                        return;
                      }
                      const next = new Set(selected);
                      next.has(item.id)
                        ? next.delete(item.id)
                        : next.add(item.id);
                      onSelected(next);
                    }}
                    aria-label={`Выбрать ${item.name}`}
                  />
                </td>
                <td className="py-3 pr-3">
                  <button
                    className="max-w-64 text-left hover:text-accent"
                    onClick={() => onOpen(item.id)}
                  >
                    <b className="block truncate">{item.name}</b>
                    {/* 2026-09-08: сцепка база Анны ↔ кабинет в обе стороны. */}
                    {data.base === "anna" &&
                      (item.linkedOurs ? (
                        <span className="mt-0.5 inline-block rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent">
                          в кабинете
                        </span>
                      ) : (
                        <span className="mt-0.5 inline-block rounded bg-surface-secondary px-1.5 py-0.5 text-[11px] text-text-muted">
                          нет в кабинете
                        </span>
                      ))}
                    {data.base === "ours" && item.linkedAnna && (
                      <span className="mt-0.5 inline-block rounded bg-warning/15 px-1.5 py-0.5 text-[11px] font-semibold text-warning">
                        в базе Анны
                      </span>
                    )}
                    {/* 2026-09-07: у брокера «Нашей базы» с исправленным
                        «именем для работы» серым показываем самоназвание
                        из кабинета — КЦ видит, что брокер называет себя
                        иначе. */}
                    {item.cabinetFullName && (
                      <span className="block truncate text-xs text-text-muted">
                        в кабинете: {item.cabinetFullName}
                      </span>
                    )}
                    {item.doNotCall === true && (
                      <span className="mt-0.5 inline-block rounded bg-error/10 px-1.5 py-0.5 text-[11px] font-semibold text-error">
                        не звонить
                      </span>
                    )}
                    <span className="block truncate text-xs text-text-muted">
                      {item.company || item.phone || "Нет контактных данных"}
                    </span>
                  </button>
                </td>
                <td className="py-3 pr-3">
                  <LoyaltyStatusBadges record={item} />
                  <span className="mt-1 block text-xs text-text-muted">
                    {item.stage || "Нет данных"}
                  </span>
                </td>
                <td className="py-3 pr-3">
                  <span>
                    {number(displayedMetrics.fixations)} фикс. ·{" "}
                    {number(displayedMetrics.meetings)} встр.
                  </span>
                  <small className="block text-text-muted">
                    {displayedMetrics.label}
                  </small>
                  {hasSourceMetrics && sourceMetrics && (
                    <small className="mt-1 block text-warning">
                      Срез источника · не подтверждено:{" "}
                      {number(sourceMetrics.fixations)} фикс. ·{" "}
                      {number(sourceMetrics.meetings)} встр.
                    </small>
                  )}
                  {data.base === "anna" && linkedMetrics && (
                    <small className="mt-1 block text-accent">
                      Кабинет: {number(linkedMetrics.fixations)} фикс. ·{" "}
                      {number(linkedMetrics.meetings)} встр.
                    </small>
                  )}
                </td>
                <td className="py-3 pr-3">
                  {date(item.lastCallAt)}
                  <div className="mt-1">
                    <LoyaltyCallResultBadge
                      result={item.lastCallResult}
                      entityType={item.entityType}
                      emptyLabel="Результат не указан"
                    />
                  </div>
                </td>
                <td className="py-3 pr-3">{item.assignee || "Не назначен"}</td>
                <td className="py-3 text-right">
                  <b>{number(displayedMetrics.deals)}</b>
                  {/* 2026-09-08 (просьба владельца): сумма тем же размером, что соседние столбцы */}
                  <span className="block whitespace-nowrap text-sm text-text-muted">
                    {money(displayedMetrics.dealAmount)}
                  </span>
                  {hasSourceMetrics && sourceMetrics && (
                    <small className="mt-1 block whitespace-nowrap text-warning">
                      Срез · не подтверждено: {number(sourceMetrics.deals)} ·{" "}
                      {money(sourceMetrics.dealAmount)}
                    </small>
                  )}
                  {data.base === "anna" && linkedMetrics && (
                    <small className="mt-1 block whitespace-nowrap text-accent">
                      Кабинет: {number(linkedMetrics.deals)} ·{" "}
                      {money(linkedMetrics.dealAmount)}
                    </small>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AddContactModal({
  base,
  entityType,
  onClose,
  onDone,
}: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    city: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!form.name.trim()) return setError("Укажите имя или название.");
    setBusy(true);
    try {
      await addLoyaltyContact({
        base,
        entityType,
        name: form.name.trim(),
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        city: form.city.trim() || undefined,
      });
      onDone();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось добавить контакт",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg space-y-3 rounded-2xl bg-surface p-5">
        <div className="flex justify-between">
          <h2 className="text-lg font-semibold">
            Добавить {entityType === "brokers" ? "брокера" : "агентство"}
          </h2>
          <button onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {(["name", "phone", "email", "city"] as const).map((key) => (
          <label className="block text-sm" key={key}>
            {key === "name"
              ? "Имя / название *"
              : key === "phone"
                ? "Телефон"
                : key === "email"
                  ? "Email"
                  : "Город"}
            <input
              className="input mt-1"
              value={form[key]}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  [key]: event.target.value,
                }))
              }
            />
          </label>
        ))}
        {error && (
          <p className="rounded-lg bg-error/10 p-2 text-sm text-error">
            {error}
          </p>
        )}
        <button
          className="btn btn-primary w-full"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}Добавить
        </button>
      </div>
    </div>
  );
}

export function LoyaltyBaseWorkspaceV2() {
  const { broker: me } = useAuth();
  const [base, setBase] = useState<LoyaltyBaseKey>("anna");
  const [entityType, setEntityType] = useState<LoyaltyEntityType>("brokers");
  const key = contextKey(base, entityType);
  const [drafts, setDrafts] = useState(contexts);
  const [applied, setApplied] = useState(contexts);
  const [segmentState, setSegmentState] = useState(segments);
  const [listBanner, setListBanner] = useState("");
  const [columnDrafts, setColumnDrafts] = useState(columnContexts);
  const [columnApplied, setColumnApplied] = useState(columnContexts);
  const draft = drafts[key];
  const filters = applied[key];
  const segment = segmentState[key];
  const columnDraft = columnDrafts[key];
  const columns = columnApplied[key];
  const [mode, setMode] = useState<"base" | "reconciliation">("base");
  const [importOpen, setImportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("month");
  const [ratingRange, setRatingRange] = useState(periodRange("month"));
  const [overview, setOverview] = useState<LoyaltyOverview | null>(null);
  // 2026-09-08: окно воронки брокера.
  const [funnelOpen, setFunnelOpen] = useState(false);
  // 2026-09-08: «Контрольные показатели активности» по текущим фильтрам списка.
  const [activitySummary, setActivitySummary] =
    useState<LoyaltyActivitySummary | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState("");
  const [list, setList] = useState<LoyaltyListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set<string>());
  const [allFilterSelected, setAllFilterSelected] = useState(false);
  const [excluded, setExcluded] = useState(new Set<string>());
  const [operators, setOperators] = useState<LoyaltyOperator[]>([]);
  const [campaigns, setCampaigns] = useState<LoyaltyCampaign[]>([]);
  const [operatorsError, setOperatorsError] = useState("");
  const [campaignsError, setCampaignsError] = useState("");
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [campaignsOpen, setCampaignsOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [detailId, setDetailId] = useState("");
  const [detail, setDetail] = useState<LoyaltyRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [effective, setEffective] =
    useState<LoyaltyEffectivePermissions | null>(null);
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [permissionsError, setPermissionsError] = useState("");
  const overviewRequest = useRef(0);
  const listRequest = useRef(0);
  const pageSize = 30;
  const currentUserId = me?.id;
  const currentUserRole = me?.role;
  const isAdmin = currentUserRole === "ADMIN";
  const hasAccess = isAdmin || currentUserRole === "MANAGER";
  const hasPermission = (permission: LoyaltyPermission) =>
    Boolean(effective?.permissions.includes(permission));
  const canReadAll = hasPermission("READ_ALL");
  const canUseQueue =
    hasPermission("READ_OWN_QUEUE") || hasPermission("CALL_EXECUTE");
  const canAssign = hasPermission("CALL_ASSIGN");
  const canExport = hasPermission("EXPORT");
  const canEdit = hasPermission("ENTITY_EDIT");
  const canImport = hasPermission("IMPORT");
  const canReconcile = hasPermission("RECONCILE");
  const canSync = hasPermission("ANALYTICS_SYNC");
  const canManageReferences = hasPermission("REFERENCE_MANAGE");

  useEffect(() => {
    if (!currentUserId || !currentUserRole || !hasAccess) {
      setPermissionsLoading(false);
      setEffective(null);
      return;
    }
    let active = true;
    setPermissionsLoading(true);
    setPermissionsError("");
    getLoyaltyEffectivePermissions()
      .then((value) => {
        if (active) setEffective(value);
      })
      .catch((reason) => {
        if (active) {
          setEffective(null);
          setPermissionsError(
            reason instanceof Error
              ? reason.message
              : "Не удалось проверить права доступа",
          );
        }
      })
      .finally(() => {
        if (active) setPermissionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentUserId, currentUserRole, hasAccess]);
  const setDraft = (next: LoyaltyFilterFormState) =>
    setDrafts((current) => ({
      ...current,
      [key]: sanitizeLoyaltyFilterState(base, entityType, next),
    }));
  const resetContext = useCallback(
    (
      nextBase: LoyaltyBaseKey,
      nextEntity: LoyaltyEntityType,
      includeLowSignal = false,
    ) => {
      const nextKey = contextKey(nextBase, nextEntity);
      const empty = { ...emptyLoyaltyFilters(), includeLowSignal };
      setDrafts((current) => ({ ...current, [nextKey]: empty }));
      setApplied((current) => ({ ...current, [nextKey]: empty }));
      setSegmentState((current) => ({ ...current, [nextKey]: "" }));
      setColumnDrafts((current) => ({ ...current, [nextKey]: {} }));
      setColumnApplied((current) => ({ ...current, [nextKey]: {} }));
      setListBanner("");
      setBase(nextBase);
      setEntityType(nextEntity);
      setPage(1);
      setSelected(new Set());
      setAllFilterSelected(false);
      setExcluded(new Set());
      setDetailId("");
    },
    [],
  );
  const loadOverview = useCallback(async () => {
    if (!canReadAll) {
      setOverviewLoading(false);
      return;
    }
    const request = ++overviewRequest.current;
    setOverviewLoading(true);
    setOverviewError("");
    try {
      // 2026-09-07: обзор следует за фильтром источника «старый / новый кабинет».
      const next = await getLoyaltyOverview(base, ratingRange, {
        cabinetSource: filters.cabinetSource || undefined,
      });
      if (request === overviewRequest.current) setOverview(next);
    } catch (reason) {
      if (request === overviewRequest.current) {
        setOverview(null);
        setOverviewError(
          reason instanceof Error ? reason.message : "Не удалось загрузить KPI",
        );
      }
    } finally {
      if (request === overviewRequest.current) setOverviewLoading(false);
    }
  }, [base, canReadAll, ratingRange, filters.cabinetSource]);
  const loadList = useCallback(async () => {
    if (!canReadAll) {
      setListLoading(false);
      return;
    }
    const request = ++listRequest.current;
    setListLoading(true);
    setListError("");
    try {
      const next = await getLoyaltyList(base, entityType, {
        page,
        pageSize,
        search: filters.search,
        city: filters.city || undefined,
        hasAmo: filters.hasAmo,
        archived: filters.archived,
        segment,
        sortBy: filters.sortBy,
        sortOrder: filters.sortOrder,
        filter: toCanonicalFilter(filters, entityType, base),
        columns,
        // 2026-09-08: «Контрольные показатели» приходят вместе со списком
        // (одним проходом по базе) — отдельный запрос убран.
        withActivitySummary: base === "ours",
        summaryPeriod: ratingRange,
      });
      if (request === listRequest.current) {
        setList(next);
        setActivitySummary(next.activitySummary ?? null);
      }
    } catch (reason) {
      if (request === listRequest.current) {
        setList(null);
        setListError(
          reason instanceof Error
            ? reason.message
            : "Не удалось загрузить список",
        );
      }
    } finally {
      if (request === listRequest.current) setListLoading(false);
    }
  }, [base, canReadAll, columns, entityType, filters, page, segment, ratingRange]);
  useEffect(() => {
    if (mode === "base") void loadOverview();
  }, [loadOverview, mode]);
  useEffect(() => {
    if (mode === "base") void loadList();
  }, [loadList, mode]);
  useEffect(() => {
    setSelected(new Set());
    setAllFilterSelected(false);
    setExcluded(new Set());
  }, [columns, key, filters, segment]);
  useEffect(() => {
    if (!allFilterSelected) setSelected(new Set());
  }, [allFilterSelected, page]);
  const loadOperators = useCallback(async () => {
    if (!canReadAll) {
      setOperators([]);
      setOperatorsError("");
      return;
    }
    setOperatorsError("");
    try {
      setOperators(await getLoyaltyOperators());
    } catch (reason) {
      setOperators([]);
      setOperatorsError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить сотрудников для назначения",
      );
    }
  }, [canReadAll]);
  const loadCampaignCatalog = useCallback(async () => {
    if (!canReadAll) {
      setCampaigns([]);
      setCampaignsError("");
      return;
    }
    setCampaignsError("");
    try {
      setCampaigns(await getLoyaltyCampaigns({ base, entityType, limit: 200 }));
    } catch (reason) {
      setCampaigns([]);
      setCampaignsError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить кампании",
      );
    }
  }, [base, canReadAll, entityType]);
  useEffect(() => {
    void loadOperators();
  }, [loadOperators]);
  useEffect(() => {
    void loadCampaignCatalog();
  }, [loadCampaignCatalog]);
  useEffect(() => {
    if (!detailId || !canReadAll) return;
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    // 2026-09-07: выбранный «Период встреч и сделок» уезжает в карточку —
    // бэкенд применяет его к периодным метрикам (и снимает плашку
    // «период не применён»).
    getLoyaltyDetail(base, entityType, detailId, {
      activityPeriod: toCanonicalFilter(filters, entityType, base)
        .activityPeriod,
      cabinetSource: filters.cabinetSource || undefined,
    })
      .then((record) => {
        const row = list?.items.find((item) => item.id === detailId);
        if (active)
          setDetail({
            ...record,
            // Периодные метрики: приоритет — применённые бэкендом в карточке;
            // иначе строка списка (например, точные метрики Анны за период).
            periodMetrics:
              record.periodMetrics &&
              record.periodMetrics.availability !== "UNAVAILABLE"
                ? record.periodMetrics
                : row?.periodMetrics || record.periodMetrics,
          });
      })
      .catch((reason) => {
        if (active)
          setDetailError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить карточку",
          );
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [base, canReadAll, detailId, entityType, filters, list]);
  // Задача A: «выбрано всё по фильтру» для обзвона в «Нашей базе» требует
  // фильтр «Без “не звонить”» — иначе счётчик фронта включал бы брокеров,
  // которых бэкенд из обзвона всегда исключает (несовпадение выборки).
  const campaignNeedsDoNotCallFilter =
    base === "ours" &&
    entityType === "brokers" &&
    allFilterSelected &&
    filters.doNotCall !== "exclude";
  const scrollToList = () =>
    window.setTimeout(
      () =>
        document
          .getElementById("loyalty-list")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  const applyFilters = (
    explicit?: LoyaltyFilterFormState,
    options?: { scroll?: boolean },
  ) => {
    const next = sanitizeLoyaltyFilterState(base, entityType, explicit ?? draft);
    setDrafts((current) => ({ ...current, [key]: next }));
    setApplied((current) => ({ ...current, [key]: next }));
    setSegmentState((current) => ({ ...current, [key]: "" }));
    setListBanner("");
    setPage(1);
    setSelected(new Set());
    setAllFilterSelected(false);
    setExcluded(new Set());
    if (options?.scroll !== false) scrollToList();
  };
  // 2026-09-08: есть ли в панели введённые, но не применённые изменения.
  const filtersDirty = JSON.stringify(draft) !== JSON.stringify(filters);
  const applyBrokerPatch = (
    patch: Partial<LoyaltyFilterFormState>,
    nextSegment: LoyaltySegment | "" = "",
  ) => applyEntityPatch("brokers", patch, nextSegment);
  // 2026-09-08: клик по ступени воронки → список брокеров «был на туре» с
  // соответствующим фильтром активности (за всё время; строгий порядок
  // «после тура» списком не выражается — об этом сказано в баннере).
  const openFunnelDrill = (step: FunnelDrillStep, mode: "strict" | "all") => {
    const nextKey = contextKey(base, "brokers");
    const next = { ...emptyLoyaltyFilters(), bt: "true" as const };
    const nextColumns: LoyaltyColumnFilters =
      step === "fixation"
        ? { activity: "HAS_FIXATIONS" }
        : step === "meeting"
          ? { activity: "HAS_MEETINGS" }
          : step === "deal" || step === "paidBooking"
            ? { deals: "HAS_DEALS" }
            : {};
    setDrafts((current) => ({ ...current, [nextKey]: next }));
    setApplied((current) => ({ ...current, [nextKey]: next }));
    setSegmentState((current) => ({ ...current, [nextKey]: "" }));
    setColumnDrafts((current) => ({ ...current, [nextKey]: nextColumns }));
    setColumnApplied((current) => ({ ...current, [nextKey]: nextColumns }));
    setListBanner(
      `Воронка: брокеры с туром${step === "fixation" ? " и фиксациями" : step === "meeting" ? " и встречами" : step === "deal" ? " и сделками" : step === "paidBooking" ? " и сделками (брони отдельно не фильтруются)" : ""} — за всё время${mode === "strict" ? "; в воронке считались только события после даты тура" : ""}`,
    );
    setEntityType("brokers");
    setFunnelOpen(false);
    setPage(1);
    scrollToList();
  };
  const applyEntityPatch = (
    nextEntity: LoyaltyEntityType,
    patch: Partial<LoyaltyFilterFormState>,
    nextSegment: LoyaltySegment | "" = "",
  ) => {
    const nextKey = contextKey(base, nextEntity);
    const next = { ...emptyLoyaltyFilters(), ...patch };
    setDrafts((current) => ({ ...current, [nextKey]: next }));
    setApplied((current) => ({ ...current, [nextKey]: next }));
    setSegmentState((current) => ({ ...current, [nextKey]: nextSegment }));
    setColumnDrafts((current) => ({ ...current, [nextKey]: {} }));
    setColumnApplied((current) => ({ ...current, [nextKey]: {} }));
    setListBanner(
      nextSegment
        ? SEGMENT_LABELS[nextSegment]
        : patch.search
          ? nextEntity === "brokers"
            ? `Топ-брокер за ${ratingLabel}`
            : `Топ-агентство за ${ratingLabel}`
          : "",
    );
    setEntityType(nextEntity);
    setPage(1);
    scrollToList();
  };
  const openPeriodRanking = (nextEntity: LoyaltyEntityType) => {
    const nextKey = contextKey(base, nextEntity);
    const next = {
      ...emptyLoyaltyFilters(),
      activityFrom: ratingRange.from,
      activityTo: ratingRange.to,
      dealsInPeriod: "true" as const,
      sortBy: "deals" as const,
      sortOrder: "desc" as const,
    };
    setDrafts((current) => ({ ...current, [nextKey]: next }));
    setApplied((current) => ({ ...current, [nextKey]: next }));
    setSegmentState((current) => ({ ...current, [nextKey]: "" }));
    setColumnDrafts((current) => ({ ...current, [nextKey]: {} }));
    setColumnApplied((current) => ({ ...current, [nextKey]: {} }));
    setListBanner("");
    setEntityType(nextEntity);
    setPage(1);
    scrollToList();
  };
  const openActivityDrilldown = (
    metric: "fixations" | "meetings" | "deals" | "dealAmount",
  ) => {
    const next = {
      ...emptyLoyaltyFilters(),
      activityFrom: ratingRange.from,
      activityTo: ratingRange.to,
      meetings: metric === "meetings" ? ("true" as const) : ("" as const),
      dealsInPeriod:
        metric === "deals" || metric === "dealAmount"
          ? ("true" as const)
          : ("" as const),
      sortBy:
        metric === "dealAmount"
          ? ("dealAmount" as const)
          : metric === "meetings"
            ? ("meetings" as const)
            : metric === "deals"
              ? ("deals" as const)
              : ("updatedAt" as const),
      sortOrder: "desc" as const,
    };
    const nextColumns: LoyaltyColumnFilters =
      metric === "fixations" ? { activity: "HAS_FIXATIONS" } : {};
    setDrafts((current) => ({ ...current, [key]: next }));
    setApplied((current) => ({ ...current, [key]: next }));
    setSegmentState((current) => ({ ...current, [key]: "" }));
    setColumnDrafts((current) => ({ ...current, [key]: nextColumns }));
    setColumnApplied((current) => ({ ...current, [key]: nextColumns }));
    setPage(1);
    scrollToList();
  };
  const metricSource = overview?.metricSource;
  const sourceReported = overview?.sourceReportedSummary;
  const source =
    metricSource?.label ||
    (overview?.snapshot
      ? `${baseLabels[base]}, snapshot ${date(overview.snapshot.publishedAt)}`
      : baseLabels[base]);
  const hasActivityEvidence = hasLoyaltyActivityEvidence(metricSource);
  const exactness = `${hasActivityEvidence ? metricSource?.exactness || "Не указана" : "Нет событий для подтверждения точности"}${metricSource?.periodFilterApplied === false ? "; период не применён" : ""}`;
  const ratingLabel =
    periodPreset === "month"
      ? "текущий месяц"
      : periodPreset === "quarter"
        ? "текущий квартал"
        : `${ratingRange.from} — ${ratingRange.to}`;
  const exactLeaders =
    metricSource?.kind === "EXACT_ACTIVITIES" && hasActivityEvidence;
  const leaderMode = loyaltyLeaderMode(base, metricSource?.kind || "");
  const preliminaryLeaders =
    leaderMode === "LOCAL_PRELIMINARY" && hasActivityEvidence;
  const visibleLeaders = exactLeaders || preliminaryLeaders;
  const leader = (value: LoyaltyLeader | null) =>
    visibleLeaders && value ? value.name : "Нет данных";
  const leaderDetail = (value: LoyaltyLeader | null) =>
    visibleLeaders && value
      ? `${preliminaryLeaders ? "Предварительно по локальным данным · " : ""}${value.deals} сделок · ${money(value.dealAmount)}`
      : "Нет подтверждённых сделок за период";
  const kpis = [
    {
      methodKey: "brokers.notCalledCurrentMonth",
      title: ANNA_KPI_CHIP_LABELS[0],
      value: number(overview?.notCalledCurrentMonth ?? null),
      detail: "Активные брокеры без звонка",
      formula:
        "active = true AND call_event от 1-го числа по сегодня отсутствует",
      period: "текущий месяц, Europe/Moscow",
      icon: PhoneOff,
      onClick: () => applyBrokerPatch({}, "NOT_CALLED_CURRENT_MONTH"),
    },
    {
      methodKey: "brokers.newCount",
      title: ANNA_KPI_CHIP_LABELS[1],
      value: number(overview?.newBrokers ?? null),
      detail: "Стадия «Новый», без достигнутой активности",
      formula: "stage = Новый AND нет БТ, фиксаций, встреч и сделок",
      period: "на дату последнего обновления",
      icon: UserPlus,
      onClick: () => applyBrokerPatch({}, "NEW_BROKER"),
    },
    {
      methodKey: "brokers.btWithoutFixation",
      title: ANNA_KPI_CHIP_LABELS[2],
      value: number(overview?.btWithoutFixation ?? null),
      detail: "Только подтверждённый флаг/дата БТ",
      formula: "bt_attended = true AND fixation_count = 0",
      period: "на дату последнего обновления",
      icon: Sparkles,
      onClick: () => applyBrokerPatch({}, "BT_WITHOUT_FIXATION"),
    },
    {
      methodKey: "brokers.birthdaysToday",
      title: ANNA_KPI_CHIP_LABELS[3],
      value: number(overview?.birthdaysToday ?? null),
      detail: "Сегодня · открыть список →",
      formula: "day(birthday) = day(today) AND month(birthday) = month(today)",
      period: "сегодня, Europe/Moscow",
      icon: Cake,
      onClick: () => applyBrokerPatch({}, "BIRTHDAY_TODAY"),
    },
    {
      methodKey: "brokers.top",
      title: `Топ-брокер за ${ratingLabel}${preliminaryLeaders ? " · предварительно" : ""}`,
      value: leader(overview?.topBroker || null),
      detail: leaderDetail(overview?.topBroker || null),
      formula:
        "подтверждённые сделки ↓, сумма ДДУ ↓, дата договора ↓, стабильный ID",
      period: ratingLabel,
      icon: Trophy,
      onClick: () => {
        const name = overview?.topBroker?.name;
        if (name) applyEntityPatch("brokers", { search: name });
        else if (base === "anna") applyEntityPatch("brokers", {});
        else openPeriodRanking("brokers");
      },
    },
    {
      methodKey: "agencies.top",
      title: `Топ-агентство за ${ratingLabel}${preliminaryLeaders ? " · предварительно" : ""}`,
      value: leader(overview?.topAgency || null),
      detail: leaderDetail(overview?.topAgency || null),
      formula:
        "подтверждённые сделки ↓, сумма ДДУ ↓, дата договора ↓, стабильный ID",
      period: ratingLabel,
      icon: Building2,
      onClick: () => {
        const name = overview?.topAgency?.name;
        if (name) applyEntityPatch("agencies", { search: name });
        else if (base === "anna") applyEntityPatch("agencies", {});
        else openPeriodRanking("agencies");
      },
    },
  ];
  // 2026-09-08: блок «Контрольные показатели» берёт цифры по текущей выборке
  // списка (activitySummary); если её нет (база Анны, ошибка) — цифры обзора.
  const kpiActivities = activitySummary?.supported
    ? activitySummary.activities
    : (overview?.activities ?? null);
  const kpiDealAmount = activitySummary?.supported
    ? activitySummary.dealAmount
    : (overview?.dealAmount ?? null);
  const withSelectionNote = (text: string) =>
    activitySummary?.supported
      ? `${text}. Считаем только по ${entityType === "brokers" ? "брокерам" : "агентствам (их брокерам и строкам реестра с их названием)"}, попавшим под текущие фильтры списка`
      : text;
  const metricExplanation = (
    key: string,
    fallbackFormula: string,
    options: {
      period?: string;
      periodFilterApplied?: boolean | null;
      source?: string;
      exactness?: string;
    } = {},
  ): LoyaltyMetricExplanation => {
    const methodology = overview?.kpiMetadata[key];
    const technicalFormula = methodology?.formula.trim();
    const rawExactness =
      methodology?.exactness || options.exactness || exactness;
    return {
      formula:
        technicalFormula && technicalFormula !== fallbackFormula
          ? `${fallbackFormula}\nТехническое правило: ${technicalFormula}`
          : fallbackFormula,
      period: loyaltyMetricPeriodLabel(
        options.period || ratingLabel,
        methodology?.periodFilterApplied ?? options.periodFilterApplied,
      ),
      source: methodology?.source || options.source || source,
      exactness: availabilityValue("exactness", rawExactness),
      includedSemantics: methodology?.includedSemantics || undefined,
      excludedSemantics: methodology?.excludedSemantics || undefined,
    };
  };
  const sourceReportedExplanation = (key: string, fallbackFormula: string) =>
    metricExplanation(key, fallbackFormula, {
      periodFilterApplied: false,
      source: sourceReported?.label || "Срез Анны",
      exactness:
        sourceReported?.exactness.join(", ") ||
        sourceReported?.confirmationStatus ||
        "Не подтверждено событиями",
    });
  const exportCsv = async () => {
    setExporting(true);
    setActionError("");
    try {
      const result = await exportLoyaltyList(base, entityType, {
        search: filters.search,
        city: filters.city || undefined,
        hasAmo: filters.hasAmo === "" ? undefined : filters.hasAmo === "true",
        archived: filters.archived,
        segment: segment || undefined,
        sortBy: filters.sortBy,
        sortOrder: filters.sortOrder,
        filter: toCanonicalFilter(filters, entityType, base),
        columns,
      });
      downloadBlob(result.blob, result.filename);
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "Не удалось выгрузить CSV",
      );
    } finally {
      setExporting(false);
    }
  };
  const savedFiltersWithoutSearch = Object.fromEntries(
    Object.entries(filters).filter(([name]) => name !== "search"),
  );
  const savedViewSnapshot: Record<string, unknown> = {
    archived: filters.archived,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
    filter: toCanonicalFilter(filters, entityType, base),
    columns,
    segment: segment || undefined,
    ui: {
      filters: savedFiltersWithoutSearch,
      columns,
      segment: segment || "",
    },
  };
  const applySavedView = (snapshot: Record<string, unknown>) => {
    const restored = restoreLoyaltySavedView(base, entityType, snapshot);
    const nextFilters = restored.filters;
    const savedColumns = restored.columns;
    const savedSegment = restored.segment;
    setDrafts((current) => ({ ...current, [key]: nextFilters }));
    setApplied((current) => ({ ...current, [key]: nextFilters }));
    setColumnDrafts((current) => ({ ...current, [key]: savedColumns }));
    setColumnApplied((current) => ({ ...current, [key]: savedColumns }));
    setSegmentState((current) => ({ ...current, [key]: savedSegment }));
    setPage(1);
    setSelected(new Set());
    setAllFilterSelected(false);
    setExcluded(new Set());
  };
  if (me && !hasAccess)
    return (
      <div className="card">
        Доступ к базе лояльности разрешён администраторам и менеджерам.
      </div>
    );
  if (hasAccess && permissionsLoading)
    return (
      <div className="card flex items-center gap-2 py-12 text-text-muted">
        <Loader2 className="h-5 w-5 animate-spin" /> Проверяем права доступа…
      </div>
    );
  if (hasAccess && !canReadAll)
    return (
      <div className="space-y-4">
        <div className="card">
          <h1 className="text-xl font-bold">База лояльности</h1>
          <p className="mt-2 text-sm text-text-muted">
            Полный список недоступен для ваших текущих прав. Собственная очередь
            звонков работает отдельно.
          </p>
          {permissionsError && (
            <p className="mt-2 text-sm text-error">{permissionsError}</p>
          )}
          {canUseQueue && (
            <button
              className="btn btn-primary mt-4"
              onClick={() => setQueueOpen(true)}
            >
              <PhoneCall className="h-4 w-4" /> Моя очередь
            </button>
          )}
        </div>
        {queueOpen && (
          <LoyaltyQueuePanel
            isAdmin={false}
            canViewAllQueues={false}
            currentUserId={me?.id || ""}
            operators={[]}
            onClose={() => setQueueOpen(false)}
          />
        )}
      </div>
    );
  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold md:text-3xl">
              <ShieldCheck className="h-7 w-7 text-accent" /> База лояльности
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              Базы Анны и кабинета независимы. Метрики и фильтры не смешиваются.
            </p>
          </div>
          <div className="text-right text-sm">
            <b>{me?.fullName || "Текущий сотрудник"}</b>
            <p className="text-text-muted">
              {me?.role === "ADMIN"
                ? "Руководитель направления"
                : "Сотрудник колл-центра"}
            </p>
            <p className="text-xs text-text-muted">
              Обновлено:{" "}
              {overview?.snapshot?.publishedAt
                ? date(overview.snapshot.publishedAt)
                : "Нет данных"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canUseQueue && (
            <button
              className="btn btn-secondary"
              onClick={() => setQueueOpen(true)}
            >
              <PhoneCall className="h-4 w-4" /> Моя очередь
            </button>
          )}
          <button
            className="btn btn-secondary"
            onClick={() => setCampaignsOpen(true)}
          >
            <Megaphone className="h-4 w-4" /> Кампании
          </button>
          <button
            className="btn btn-secondary"
            disabled={
              !canAssign ||
              campaignNeedsDoNotCallFilter ||
              (!selected.size &&
                (!allFilterSelected ||
                  !list ||
                  list.selectionCount <= excluded.size))
            }
            onClick={() => setCampaignOpen(true)}
            title={
              !canAssign
                ? "Нет права назначать обзвон"
                : campaignNeedsDoNotCallFilter
                  ? "Для выбора всей базы в обзвон включите фильтр «Без “не звонить”» — брокеры из списка «не звонить» не обзваниваются"
                  : "Выберите контакты"
            }
          >
            <ListChecks className="h-4 w-4" /> Сформировать список
          </button>
          {canExport && (
            <button
              className="btn btn-secondary"
              onClick={() => void exportCsv()}
              disabled={exporting}
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}{" "}
              Экспорт
            </button>
          )}
          {canSync && mode === "base" && (
            <button
              className={`btn ${syncOpen ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setSyncOpen((current) => !current)}
            >
              <ScanSearch className="h-4 w-4" /> Проверка источников
            </button>
          )}
          {isAdmin && canManageReferences && mode === "base" && (
            <button
              className={`btn ${grantsOpen ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setGrantsOpen((current) => !current)}
            >
              <KeyRound className="h-4 w-4" /> Права сотрудников
            </button>
          )}
          <button
            className="btn btn-secondary"
            disabled={base !== "anna" || !canEdit}
            onClick={() => setAddOpen(true)}
            title={
              base === "anna" && canEdit
                ? "Добавить запись в ручное дополнение базы Анны"
                : base === "anna"
                  ? "Доступно руководителю"
                  : "Добавление выполняется через штатную Админка — Брокеры/Агентства"
            }
          >
            <Plus className="h-4 w-4" /> Добавить
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => resetContext(base, "brokers")}
          >
            Все брокеры
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => resetContext(base, "agencies", base === "ours")}
            title="Показать все агентства, включая записи без телефона, сделок и недавних встреч"
          >
            Все агентства
          </button>
          {canReconcile && (
            <button
              className={`btn ${mode === "reconciliation" ? "btn-primary" : "btn-secondary"}`}
              onClick={() =>
                setMode((current) =>
                  current === "base" ? "reconciliation" : "base",
                )
              }
            >
              <Database className="h-4 w-4" />{" "}
              {mode === "base" ? "Сверка" : "Вернуться"}
            </button>
          )}
          {canImport && base === "anna" && mode === "base" && (
            <button
              className={`btn ${importOpen ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setImportOpen((current) => !current)}
            >
              <FileJson className="h-4 w-4" /> JSON-импорт
            </button>
          )}
        </div>
      </header>
      {actionError && (
        <div className="rounded-lg bg-error/10 p-3 text-error">
          {actionError}
        </div>
      )}
      {(operatorsError || campaignsError) && (
        <div className="rounded-lg bg-error/10 p-3 text-sm text-error">
          {operatorsError || campaignsError}
          <button
            className="btn btn-secondary ml-3"
            onClick={() => {
              void loadOperators();
              void loadCampaignCatalog();
            }}
          >
            Повторить
          </button>
        </div>
      )}
      {mode === "base" && canReadAll && base !== "anna" && (
        <LoyaltySavedViews
          base={base}
          entityType={entityType}
          currentSnapshot={savedViewSnapshot}
          currentUserId={me?.id || ""}
          canManageShared={canManageReferences}
          isAdmin={Boolean(isAdmin)}
          onApply={applySavedView}
        />
      )}
      {mode === "reconciliation" && canReconcile ? (
        <LoyaltyReconciliationV2
          canDecide={Boolean(isAdmin)}
          canExport={canExport}
        />
      ) : (
        <>
          <nav className="grid gap-2 md:grid-cols-2">
            {(["anna", "ours"] as const).map((item) => (
              <button
                key={item}
                className={`rounded-xl border p-4 text-left ${base === item ? "border-accent bg-accent text-white" : "border-border bg-surface"}`}
                onClick={() => {
                  setBase(item);
                  setPage(1);
                }}
              >
                <b>{baseLabels[item]}</b>
                <small
                  className={`block ${base === item ? "text-white/75" : "text-text-muted"}`}
                >
                  {item === "anna"
                    ? "Отдельный очищенный snapshot"
                    : "Контакты текущего кабинета"}
                </small>
              </button>
            ))}
          </nav>
          {importOpen && canImport && base === "anna" && (
            <AnnaImportPanel
              canPublish={Boolean(isAdmin)}
              onPublished={() => {
                void loadOverview();
                void loadList();
              }}
            />
          )}
          {syncOpen && canSync && (
            <LoyaltySyncPanel onClose={() => setSyncOpen(false)} />
          )}
          {grantsOpen && isAdmin && canManageReferences && (
            <LoyaltyGrantsPanel onClose={() => setGrantsOpen(false)} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav className="inline-flex rounded-xl bg-surface-secondary p-1">
              {(["brokers", "agencies"] as const).map((entity) => (
                <button
                  key={entity}
                  className={`rounded-lg px-4 py-2 text-sm font-medium ${entityType === entity ? "bg-surface text-accent shadow-sm" : "text-text-muted"}`}
                  onClick={() => {
                    if (base === "anna") {
                      resetContext(base, entity);
                      return;
                    }
                    setEntityType(entity);
                    setPage(1);
                  }}
                >
                  {base === "anna"
                    ? ANNA_ENTITY_TAB_LABELS[entity]
                    : entityLabels[entity]}{" "}
                  <span className="ml-1">
                    {entity === "brokers"
                      ? (overview?.brokersTotal ?? "—")
                      : (overview?.agenciesTotal ?? "—")}
                  </span>
                </button>
              ))}
            </nav>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-text-muted">Период рейтинга</span>
              {base === "anna" ? (
                <select
                  className="input w-auto"
                  aria-label="Период рейтинга"
                  value={periodPreset}
                  onChange={(event) => {
                    const preset = event.target.value as PeriodPreset;
                    setPeriodPreset(preset);
                    if (preset !== "custom")
                      setRatingRange(periodRange(preset));
                  }}
                >
                  {ANNA_RANKING_PERIOD_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              ) : (
                (["month", "quarter", "custom"] as const).map((preset) => (
                  <button
                    key={preset}
                    className={`rounded-lg border px-3 py-2 ${periodPreset === preset ? "border-accent bg-accent text-white" : "border-border"}`}
                    onClick={() => {
                      setPeriodPreset(preset);
                      if (preset !== "custom")
                        setRatingRange(periodRange(preset));
                    }}
                  >
                    {preset === "month"
                      ? "Текущий месяц"
                      : preset === "quarter"
                        ? "Текущий квартал"
                        : "Произвольные даты"}
                  </button>
                ))
              )}
              {periodPreset === "custom" && (
                <>
                  <input
                    className="input w-auto"
                    type="date"
                    aria-label="Рейтинг с"
                    value={ratingRange.from}
                    max={ratingRange.to}
                    onChange={(event) =>
                      setRatingRange((current) => ({
                        ...current,
                        from: event.target.value,
                      }))
                    }
                  />
                  <input
                    className="input w-auto"
                    type="date"
                    aria-label="Рейтинг по"
                    value={ratingRange.to}
                    min={ratingRange.from}
                    onChange={(event) =>
                      setRatingRange((current) => ({
                        ...current,
                        to: event.target.value,
                      }))
                    }
                  />
                </>
              )}
            </div>
          </div>
          {overviewError && (
            <div className="flex justify-between rounded-lg bg-error/10 p-3 text-error">
              <span>
                <AlertCircle className="mr-2 inline h-4 w-4" />
                {overviewError}
              </span>
              <button onClick={() => void loadOverview()}>
                <RefreshCcw className="h-4 w-4" />
              </button>
            </div>
          )}
          <section
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
            aria-label="Ровно шесть ключевых показателей"
          >
            {kpis.map((kpi) => {
              const methodology = overview?.kpiMetadata[kpi.methodKey];
              return (
                <KpiCard
                  key={kpi.title}
                  {...kpi}
                  formula={methodology?.formula || kpi.formula}
                  source={methodology?.source || source}
                  exactness={
                    !hasActivityEvidence && /top/i.test(kpi.methodKey)
                      ? "Нет событий для подтверждения точности"
                      : methodology?.exactness || exactness
                  }
                  includedSemantics={methodology?.includedSemantics}
                  excludedSemantics={methodology?.excludedSemantics}
                  loading={overviewLoading}
                />
              );
            })}
          </section>
          {base !== "anna" && (
          <section className="card">
            <div className="flex flex-wrap justify-between gap-3">
              <div>
                <h2 className="font-semibold">
                  Контрольные показатели активности
                </h2>
                <p className="text-xs text-text-muted">
                  {activitySummary?.supported
                    ? `По текущим фильтрам списка: ${entityType === "brokers" ? "брокеров" : "агентств"} ${activitySummary.selectionCount.toLocaleString("ru-RU")}${entityType === "agencies" ? `, их брокеров ${activitySummary.brokers.toLocaleString("ru-RU")}` : ""} · период: ${ratingLabel}. Нажмите число, чтобы открыть карточки-основания.`
                    : "Не входят в шесть KPI. Нажмите число для детализации в карточках-основаниях."}
                </p>
              </div>
              <span className="rounded-full bg-accent/10 px-3 py-1 text-xs text-accent">
                {exactness}
              </span>
            </div>
            <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              <Metric
                label="Фиксации"
                onClick={() => openActivityDrilldown("fixations")}
                explanation={metricExplanation(
                  "activities.fixations",
                  withSelectionNote("Количество подтверждённых фиксаций за выбранный период"),
                )}
              >
                {number(kpiActivities?.fixations ?? null)}
              </Metric>
              <Metric
                label="Встречи"
                onClick={() => openActivityDrilldown("meetings")}
                explanation={metricExplanation(
                  "activities.meetings",
                  withSelectionNote("Количество подтверждённых встреч с клиентами за выбранный период (брокер-туры не считаются)"),
                )}
              >
                {number(kpiActivities?.meetings ?? null)}
              </Metric>
              <Metric
                label="Платные брони"
                explanation={metricExplanation(
                  "activities.paidBookings",
                  withSelectionNote("Оплаченные ДВОУ из «Реестра сделок» за выбранный период (по дате оплаты ДВОУ)"),
                )}
              >
                {number(kpiActivities?.paidBookings ?? null)}
              </Metric>
              <Metric
                label="Сделки"
                onClick={() => openActivityDrilldown("deals")}
                explanation={metricExplanation(
                  "activities.deals",
                  withSelectionNote("Оплаченные ДДУ за выбранный период (по «Дате оплаты ДДУ»)"),
                )}
              >
                {number(kpiActivities?.deals ?? null)}
              </Metric>
              <Metric
                label="Сумма ДДУ"
                onClick={() => openActivityDrilldown("dealAmount")}
                explanation={metricExplanation(
                  "dealAmount",
                  withSelectionNote("Сумма подтверждённых ДДУ за выбранный период"),
                )}
              >
                {money(kpiDealAmount)}
              </Metric>
            </dl>
          </section>
          )}
          {base === "anna" && overview?.cabinetLinks && (
            <section className="card">
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Сцепка с кабинетом</h2>
                  <p className="text-xs text-text-muted">
                    Записи базы Анны, подтверждённо сцепленные с нашими
                    карточками, и что эти карточки сделали в кабинете за
                    выбранный период. Цифры среза Анны сюда не добавляются.
                  </p>
                </div>
                <span className="rounded-full bg-accent/10 px-3 py-1 text-xs text-accent">
                  Данные кабинета · проверено
                </span>
              </div>
              <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
                <Metric
                  label="Брокеров сцеплено"
                  explanation={metricExplanation(
                    "cabinetLinks.brokersLinked",
                    "Брокеры базы Анны, у которых есть подтверждённая сцепка с нашей карточкой",
                  )}
                >
                  {number(overview.cabinetLinks.brokersLinked)}
                </Metric>
                <Metric
                  label="Из них активны в кабинете"
                  explanation={metricExplanation(
                    "cabinetLinks.brokersActive",
                    "Сцепленные брокеры со статусом «Активен» в кабинете",
                  )}
                >
                  {number(overview.cabinetLinks.brokersActive)}
                </Metric>
                <Metric
                  label="С фиксациями"
                  explanation={metricExplanation(
                    "cabinetLinks.brokersWithFixations",
                    "Сцепленные брокеры, у которых в кабинете есть хотя бы одна фиксация (за всё время)",
                  )}
                >
                  {number(overview.cabinetLinks.brokersWithFixations)}
                </Metric>
                <Metric
                  label="Со сделками"
                  explanation={metricExplanation(
                    "cabinetLinks.brokersWithDeals",
                    "Сцепленные брокеры с хотя бы одной оплаченной сделкой (за всё время)",
                  )}
                >
                  {number(overview.cabinetLinks.brokersWithDeals)}
                </Metric>
                <Metric
                  label="Агентств сцеплено"
                  explanation={metricExplanation(
                    "cabinetLinks.agenciesLinked",
                    "Агентства базы Анны, сцепленные с нашим агентством",
                  )}
                >
                  {number(overview.cabinetLinks.agenciesLinked)}
                </Metric>
                <Metric
                  label="Фиксации за период"
                  explanation={metricExplanation(
                    "cabinetLinks.fixations",
                    "Фиксации клиентов сцепленных брокеров за выбранный период",
                  )}
                >
                  {number(overview.cabinetLinks.fixations)}
                </Metric>
                <Metric
                  label="Встречи за период"
                  explanation={metricExplanation(
                    "cabinetLinks.meetings",
                    "Подтверждённые и состоявшиеся встречи сцепленных брокеров за период",
                  )}
                >
                  {number(overview.cabinetLinks.meetings)}
                </Metric>
                <Metric
                  label="Платные брони"
                  explanation={metricExplanation(
                    "cabinetLinks.paidBookings",
                    "Оплаченные ДВОУ из реестра у сцепленных брокеров за период",
                  )}
                >
                  {number(overview.cabinetLinks.paidBookings)}
                </Metric>
                <Metric
                  label="Сделки за период"
                  explanation={metricExplanation(
                    "cabinetLinks.deals",
                    "Оплаченные ДДУ реестра и подтверждённые сделки кабинета у сцепленных брокеров за период",
                  )}
                >
                  {number(overview.cabinetLinks.deals)}
                </Metric>
                <Metric
                  label="Сумма ДДУ за период"
                  explanation={metricExplanation(
                    "cabinetLinks.dealAmount",
                    "Сумма по тем же сделкам (стоимость по ДДУ)",
                  )}
                >
                  {money(overview.cabinetLinks.dealAmount)}
                </Metric>
              </dl>
            </section>
          )}
          {base === "ours" && canReadAll && (
            <BrokerFunnelPanel
              cabinetSource={filters.cabinetSource}
              onOpen={() => setFunnelOpen(true)}
            />
          )}
          {base === "ours" && canReadAll && (
            <RegistrySeriesPanel
              compact
              title="Динамика по дням, неделям и месяцам"
              initialFrom={ratingRange.from?.slice(0, 10)}
              initialTo={ratingRange.to?.slice(0, 10)}
              initialGranularity="day"
            />
          )}
          {base === "anna" && sourceReported && (
            <section className="card border-warning/40 bg-warning/5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Срез Анны — НЕ ПОДТВЕРЖДЕНО</h2>
                  <p className="mt-1 text-xs text-text-muted">
                    {sourceReported.label || "Агрегаты исходного файла"}. Эти
                    числа показаны отдельно и не входят в шесть точных KPI.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-warning/15 px-3 py-1 text-warning">
                    {sourceReported.confirmationStatus || "NOT_CONFIRMED"}
                  </span>
                  <span className="rounded-full bg-surface-secondary px-3 py-1">
                    {sourceReported.periodFilterApplied === true
                      ? "Период применён"
                      : "Период не применён"}
                  </span>
                </div>
              </div>
              {sourceReported.warning && (
                <p className="mt-3 rounded-lg bg-warning/10 p-3 text-xs text-warning">
                  {sourceReported.warning}
                </p>
              )}
              <div className="mt-3 grid gap-3 xl:grid-cols-2">
                {(
                  [
                    ["Брокеры", "brokers", sourceReported.brokers],
                    ["Агентства", "agencies", sourceReported.agencies],
                  ] as const
                ).map(([label, groupKey, group]) => (
                  <article
                    className="rounded-xl border border-border bg-surface p-3"
                    key={label}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-medium">{label}</h3>
                      <span className="text-xs text-text-muted">
                        записей: {group.records.toLocaleString("ru-RU")}
                      </span>
                    </div>
                    <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <Metric
                        label={`Фиксации · известно у ${group.fixationKnownRecords}`}
                        explanation={sourceReportedExplanation(
                          `sourceReportedSummary.${groupKey}.fixations`,
                          `Сумма заявленных фиксаций по ${label.toLowerCase()}, у которых значение известно`,
                        )}
                      >
                        {number(group.fixations)}
                      </Metric>
                      <Metric
                        label={`Встречи · известно у ${group.meetingKnownRecords}`}
                        explanation={sourceReportedExplanation(
                          `sourceReportedSummary.${groupKey}.meetings`,
                          `Сумма заявленных встреч по ${label.toLowerCase()}, у которых значение известно`,
                        )}
                      >
                        {number(group.meetings)}
                      </Metric>
                      <Metric
                        label={`Сделки · известно у ${group.dealKnownRecords}`}
                        explanation={sourceReportedExplanation(
                          `sourceReportedSummary.${groupKey}.deals`,
                          `Сумма заявленных сделок по ${label.toLowerCase()}, у которых значение известно`,
                        )}
                      >
                        {number(group.deals)}
                      </Metric>
                      <Metric
                        label={`БТ · известно у ${group.brokerTourKnownRecords}`}
                        explanation={sourceReportedExplanation(
                          `sourceReportedSummary.${groupKey}.brokerTours`,
                          `Сумма заявленных посещений БТ по ${label.toLowerCase()}, у которых значение известно`,
                        )}
                      >
                        {number(group.brokerTours)}
                      </Metric>
                      <Metric
                        label={`Звонки · известно у ${group.callKnownRecords}`}
                        explanation={sourceReportedExplanation(
                          `sourceReportedSummary.${groupKey}.calls`,
                          `Сумма заявленных звонков по ${label.toLowerCase()}, у которых значение известно`,
                        )}
                      >
                        {number(group.calls)}
                      </Metric>
                      <Metric
                        label={`Сумма ДДУ · известно у ${group.dealAmountKnownRecords}`}
                        explanation={sourceReportedExplanation(
                          `sourceReportedSummary.${groupKey}.dealAmount`,
                          `Сумма заявленных ДДУ по ${label.toLowerCase()}, у которых значение известно`,
                        )}
                      >
                        {money(group.dealAmount)}
                      </Metric>
                    </dl>
                    {label === "Брокеры" && (
                      <dl className="mt-2 grid gap-2 sm:grid-cols-3">
                        <Metric
                          label={`Не звонили · известно у ${sourceReported.brokers.notCalledKnownCount}`}
                          explanation={sourceReportedExplanation(
                            "sourceReportedSummary.brokers.notCalledCurrentMonth",
                            "Количество брокеров с известной датой последнего звонка раньше текущего московского месяца",
                          )}
                        >
                          {number(sourceReported.brokers.notCalledCurrentMonth)}
                        </Metric>
                        <Metric
                          label="Новые брокеры"
                          explanation={sourceReportedExplanation(
                            "sourceReportedSummary.brokers.newCount",
                            "Количество брокеров на явной стадии «Новый» с явно нулевыми БТ, фиксациями, встречами и сделками",
                          )}
                        >
                          {number(sourceReported.brokers.newCount)}
                        </Metric>
                        <Metric
                          label="БТ без фиксации"
                          explanation={sourceReportedExplanation(
                            "sourceReportedSummary.brokers.btWithoutFixation",
                            "Количество брокеров с явно подтверждённым БТ и явно нулевым числом фиксаций",
                          )}
                        >
                          {number(sourceReported.brokers.btWithoutFixation)}
                        </Metric>
                      </dl>
                    )}
                    <div className="mt-2">
                      <Metric
                        label="Лидер исходного среза"
                        explanation={sourceReportedExplanation(
                          `sourceReportedSummary.${groupKey}.top`,
                          `Лидер среди ${label.toLowerCase()}: сначала по заявленным сделкам, затем по заявленной сумме`,
                        )}
                      >
                        <span className="block">
                          {group.top?.name || "Нет данных"}
                        </span>
                        {group.top && (
                          <span className="block text-xs font-normal text-text-muted">
                            {group.top.deals.toLocaleString("ru-RU")} сделок ·{" "}
                            {money(group.top.dealAmount)}
                          </span>
                        )}
                      </Metric>
                    </div>
                  </article>
                ))}
              </div>
              <p className="mt-3 text-xs text-text-muted">
                Точность: {sourceReported.exactness.join(", ") || "не указана"}.
                Источники:{" "}
                {sourceReported.sourceVersions.join(", ") || "не указаны"}.
              </p>
            </section>
          )}
          {(listBanner || segment) && (
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/20 bg-accent/5 p-4">
              <div>
                <b>{listBanner || (segment ? SEGMENT_LABELS[segment] : "")}</b>
                <span className="mt-1 block text-sm text-text-muted">
                  Показано контактов:{" "}
                  {list ? list.total.toLocaleString("ru-RU") : "…"}
                </span>
              </div>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => resetContext(base, entityType)}
              >
                {ANNA_SHOW_ALL_LABEL}
              </button>
            </section>
          )}
          <LoyaltyFilterPanel
            base={base}
            entityType={entityType}
            draft={draft}
            onChange={setDraft}
            onApply={() => applyFilters()}
            onApplyDraft={(next) => applyFilters(next, { scroll: false })}
            dirty={filtersDirty}
            onReset={() => resetContext(base, entityType)}
            campaigns={campaigns}
            operators={operators}
            facets={list?.facets || null}
            loading={listLoading}
          />
          <LoyaltyStatusLegend
            entityType={entityType}
            facets={list?.facets || null}
            active={filters.status}
            sourceStatusesUnconfirmed={!hasActivityEvidence}
            onSelect={(status) => applyEntityPatch("brokers", { status })}
            onOpenFunnel={base === "ours" ? () => setFunnelOpen(true) : undefined}
          />
          {funnelOpen && base === "ours" && (
            <BrokerFunnelModal
              initialCabinetSource={filters.cabinetSource}
              onClose={() => setFunnelOpen(false)}
              onDrill={openFunnelDrill}
            />
          )}
          <section className="card scroll-mt-4" id="loyalty-list">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">
                  {entityLabels[entityType]} · {baseLabels[base]}
                </h2>
                <p className="text-xs text-text-muted">
                  {list
                    ? `${list.total.toLocaleString("ru-RU")} записей`
                    : "Количество уточняется"}
                  {list?.filterHash
                    ? ` · фильтр ${list.filterHash.slice(0, 8)}`
                    : ""}
                </p>
              </div>
              <button
                className="btn btn-secondary"
                disabled={listLoading}
                onClick={() => void loadList()}
              >
                <RefreshCcw
                  className={`h-4 w-4 ${listLoading ? "animate-spin" : ""}`}
                />{" "}
                Обновить
              </button>
            </div>
            {list && (selected.size > 0 || allFilterSelected) && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-accent/10 p-3 text-sm">
                <span>
                  {allFilterSelected
                    ? `Выбрано ${(list.selectionCount - excluded.size).toLocaleString("ru-RU")} записей по фильтру${excluded.size ? ` · исключено вручную: ${excluded.size}` : ""}`
                    : `Выбрано на текущей странице: ${selected.size}`}
                </span>
                <div className="flex gap-2">
                  {!allFilterSelected &&
                    list.selectionCount > selected.size && (
                      <button
                        className="underline"
                        onClick={() => {
                          setAllFilterSelected(true);
                          setSelected(new Set());
                          setExcluded(new Set());
                        }}
                      >
                        Выбрать всех по фильтру (
                        {list.selectionCount.toLocaleString("ru-RU")})
                      </button>
                    )}
                  <button
                    className="underline"
                    onClick={() => {
                      setAllFilterSelected(false);
                      setSelected(new Set());
                      setExcluded(new Set());
                    }}
                  >
                    Снять выбор
                  </button>
                </div>
              </div>
            )}
            {list && <DataAvailabilityNotice values={list.dataAvailability} />}
            {listError ? (
              <div className="rounded-lg bg-error/10 p-4 text-error">
                {listError}
              </div>
            ) : listLoading ? (
              <div className="flex justify-center gap-2 py-16 text-text-muted">
                <Loader2 className="h-5 w-5 animate-spin" /> Загружаем список…
              </div>
            ) : !list?.items.length ? (
              <div className="py-16 text-center">
                <Users className="mx-auto h-10 w-10 text-text-muted" />
                <b className="mt-2 block">Записи не найдены</b>
                <p className="text-sm text-text-muted">
                  Проверьте применённые фильтры. Неизвестные значения не
                  превращаются в нули.
                </p>
              </div>
            ) : (
              <LoyaltyTable
                data={list}
                entityType={entityType}
                selected={selected}
                onSelected={setSelected}
                allFilterSelected={allFilterSelected}
                excluded={excluded}
                onExcluded={setExcluded}
                onOpen={setDetailId}
                operators={operators}
                columnDraft={columnDraft}
                onColumnDraft={(next) => {
                  setColumnDrafts((current) => ({ ...current, [key]: next }));
                  setColumnApplied((current) => ({ ...current, [key]: next }));
                  setPage(1);
                }}
                sortBy={filters.sortBy}
                sortOrder={filters.sortOrder}
                onSort={(field) => {
                  // Повторный клик по активному столбцу меняет направление;
                  // числовые поля по умолчанию по убыванию, имя — по возрастанию.
                  const nextOrder =
                    filters.sortBy === field
                      ? filters.sortOrder === "asc" ? "desc" : "asc"
                      : field === "name" || field === "city" ? "asc" : "desc";
                  const next = { ...filters, sortBy: field, sortOrder: nextOrder as "asc" | "desc" };
                  setDrafts((current) => ({ ...current, [key]: next }));
                  setApplied((current) => ({ ...current, [key]: next }));
                  setPage(1);
                }}
              />
            )}
            {list && list.totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
                <span className="text-sm text-text-muted">
                  Страница {list.page} из {list.totalPages}
                </span>
                <div className="flex gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={page <= 1}
                    onClick={() =>
                      setPage((current) => Math.max(1, current - 1))
                    }
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={page >= list.totalPages}
                    onClick={() =>
                      setPage((current) =>
                        Math.min(list.totalPages, current + 1),
                      )
                    }
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}
      {detailId && (
        <LoyaltyRecordDrawer
          record={detail}
          base={base}
          loading={detailLoading}
          error={detailError}
          onClose={() => {
            setDetailId("");
            setDetail(null);
            setDetailError("");
          }}
        />
      )}
      {queueOpen && (
        <LoyaltyQueuePanel
          isAdmin={isAdmin}
          canViewAllQueues={canReadAll}
          currentUserId={me?.id || ""}
          operators={operators}
          onClose={() => setQueueOpen(false)}
        />
      )}
      {campaignsOpen && (
        <LoyaltyCampaignDashboard
          base={base}
          entityType={entityType}
          canAssign={canAssign}
          canExport={canExport}
          operators={operators}
          onClose={() => setCampaignsOpen(false)}
          onChanged={() => {
            void loadCampaignCatalog();
            void loadList();
          }}
        />
      )}
      {campaignOpen && list && (
        <LoyaltyCampaignModal
          base={base}
          entityType={entityType}
          selection={
            allFilterSelected
              ? {
                  mode: "FILTER",
                  filterHash: list.filterHash,
                  expectedCount: list.selectionCount - excluded.size,
                  excludedIds: Array.from(excluded),
                }
              : { mode: "IDS", ids: Array.from(selected) }
          }
          selectedCount={
            allFilterSelected
              ? list.selectionCount - excluded.size
              : selected.size
          }
          operators={operators}
          filterSnapshot={{
            search: filters.search,
            city: filters.city || undefined,
            hasAmo:
              filters.hasAmo === "" ? undefined : filters.hasAmo === "true",
            archived: filters.archived,
            sortBy: filters.sortBy,
            sortOrder: filters.sortOrder,
            filter: toCanonicalFilter(filters, entityType, base),
            columns,
            segment: segment || undefined,
          }}
          filterHash={list.filterHash}
          snapshotId={list.snapshotId}
          onClose={() => setCampaignOpen(false)}
          onDone={() => {
            setCampaignOpen(false);
            setSelected(new Set());
            setAllFilterSelected(false);
            setExcluded(new Set());
            void loadCampaignCatalog();
            void loadList();
          }}
        />
      )}
      {addOpen && base === "anna" && canEdit && (
        <AddContactModal
          base={base}
          entityType={entityType}
          onClose={() => setAddOpen(false)}
          onDone={() => {
            setAddOpen(false);
            void loadList();
          }}
        />
      )}
    </div>
  );
}
