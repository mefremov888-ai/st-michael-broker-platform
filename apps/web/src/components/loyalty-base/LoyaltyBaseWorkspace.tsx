"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Building2,
  Cake,
  ChevronLeft,
  ChevronRight,
  Database,
  FileJson,
  Info,
  Loader2,
  PhoneOff,
  RefreshCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserPlus,
  Users,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  getLoyaltyDetail,
  getLoyaltyList,
  getLoyaltyOverview,
  formatRubles,
  selectLoyaltyLeader,
  type LoyaltyBaseKey,
  type LoyaltyEntityType,
  type LoyaltyLeader,
  type LoyaltyListResponse,
  type LoyaltyOverview,
  type LoyaltyRecord,
  type LoyaltySegment,
} from "@/lib/loyalty-base-api";
import { AnnaImportPanel } from "./AnnaImportPanel";
import { LoyaltyReconciliation } from "./LoyaltyReconciliation";
import { LoyaltyRecordDrawer } from "./LoyaltyRecordDetail";

const baseLabels: Record<LoyaltyBaseKey, string> = {
  anna: "База Анны Скибицкой",
  ours: "Наша база",
};

const entityLabels: Record<LoyaltyEntityType, string> = {
  brokers: "Брокеры",
  agencies: "Агентства",
};

const segmentLabels: Record<LoyaltySegment, string> = {
  NOT_CALLED_CURRENT_MONTH: "Не звонили в текущем месяце",
  NEW_BROKER: "Новые брокеры",
  BT_WITHOUT_FIXATION: "Были на БТ без фиксации",
  BIRTHDAY_TODAY: "Дни рождения сегодня",
};

type PeriodPreset = "month" | "quarter" | "custom";

function moscowDateParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: value("year"), month: value("month"), day: value("day") };
}

const isoDate = (year: number, monthIndex: number, day: number) =>
  new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);

function periodRange(preset: Exclude<PeriodPreset, "custom">) {
  const now = moscowDateParts();
  if (preset === "quarter") {
    const startMonth = Math.floor((now.month - 1) / 3) * 3;
    return {
      from: isoDate(now.year, startMonth, 1),
      to: isoDate(now.year, startMonth + 3, 0),
    };
  }
  return {
    from: isoDate(now.year, now.month - 1, 1),
    to: isoDate(now.year, now.month, 0),
  };
}

const initialPeriod = periodRange("month");

const formatDate = (value: string) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("ru-RU");
};

const formatCount = (value: number | null) =>
  value === null ? "—" : String(value);

function KpiCard({
  title,
  value,
  detail,
  methodology,
  icon: Icon,
  loading,
  onClick,
}: {
  title: string;
  value: string | number;
  detail: string;
  methodology: string;
  icon: typeof Users;
  loading: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      title={methodology}
      aria-label={`${title}. ${methodology}`}
      className={`group relative rounded-xl border border-border bg-surface p-4 min-h-[136px] flex flex-col text-left transition hover:border-accent/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:hover:border-border disabled:hover:shadow-none ${onClick ? "cursor-pointer" : "cursor-help"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm text-text-muted leading-snug">{title}</h3>
        <span className="flex items-center gap-1.5">
          <span
            className="relative rounded-full p-1 text-text-muted"
            aria-hidden="true"
          >
            <Info className="w-4 h-4" />
          </span>
          <span className="rounded-lg bg-accent/10 p-2 text-accent">
            <Icon className="w-4 h-4" />
          </span>
        </span>
      </div>
      {loading ? (
        <div className="h-8 w-20 rounded bg-surface-secondary animate-pulse mt-4" />
      ) : (
        <strong className="text-2xl leading-tight mt-3 break-words">
          {value}
        </strong>
      )}
      <small className="text-text-muted mt-auto pt-2">
        {loading ? "Загрузка…" : detail}
      </small>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute left-3 right-3 top-[calc(100%-0.5rem)] z-30 rounded-lg bg-text px-3 py-2 text-xs font-normal leading-relaxed text-surface opacity-0 shadow-xl transition-opacity group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100"
      >
        {methodology}
      </span>
    </button>
  );
}

function leaderValue(leader: LoyaltyLeader | null) {
  return leader?.name || "—";
}

function leaderDetail(
  leader: LoyaltyLeader | null,
  periodLabel: string,
  sourceReported = false,
) {
  if (!leader)
    return sourceReported
      ? "В срезе нет заявленных сделок"
      : `Нет подтверждённых сделок за ${periodLabel}`;
  return `${leader.deals} ${sourceReported ? "сделок по данным источника" : "подтверждённых сделок"} · ${formatRubles(leader.dealAmount)}`;
}

function ActivityTotals({
  fixations,
  meetings,
  deals,
  dealAmount,
}: {
  fixations: number | null;
  meetings: number | null;
  deals: number | null;
  dealAmount: string | null;
}) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        ["Фиксации", formatCount(fixations)],
        ["Встречи", formatCount(meetings)],
        ["Сделки", formatCount(deals)],
        ["Сумма ДДУ", formatRubles(dealAmount)],
      ].map(([label, value]) => (
        <div
          key={String(label)}
          className="rounded-lg border border-border bg-background p-3"
        >
          <dt className="text-xs text-text-muted">{label}</dt>
          <dd className="mt-1 text-lg font-semibold break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LoyaltyTable({
  data,
  entityType,
  onOpen,
}: {
  data: LoyaltyListResponse;
  entityType: LoyaltyEntityType;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[980px]">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="pb-3 pr-4 font-medium">
              {entityType === "brokers" ? "Брокер" : "Агентство"}
            </th>
            <th className="pb-3 pr-4 font-medium">Контакт / география</th>
            <th className="pb-3 pr-4 font-medium">Статус / стадия</th>
            <th className="pb-3 pr-4 font-medium">Активность</th>
            <th className="pb-3 pr-4 font-medium">Последний контакт</th>
            <th className="pb-3 pr-4 font-medium text-right">Сделки</th>
            <th className="pb-3 font-medium">Ответственный</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr
              key={item.id}
              className="border-b border-border last:border-0 hover:bg-surface-secondary/70"
            >
              <td className="py-3 pr-4 max-w-[240px]">
                <button
                  type="button"
                  className="text-left hover:text-accent"
                  onClick={() => onOpen(item.id)}
                >
                  <span
                    className="font-semibold block truncate"
                    title={item.name}
                  >
                    {item.name}
                  </span>
                  <span className="text-xs text-text-muted block truncate">
                    {item.company ||
                      (entityType === "brokers"
                        ? "Частный брокер"
                        : "Без юр. названия")}
                  </span>
                </button>
              </td>
              <td className="py-3 pr-4">
                <div>{item.phone || "—"}</div>
                <small className="text-text-muted">
                  {item.city || "Не указано"}
                </small>
              </td>
              <td className="py-3 pr-4">
                <span className="inline-block text-xs rounded-full bg-accent/10 text-accent px-2 py-1">
                  {item.status || "Без статуса"}
                </span>
                <small className="text-text-muted block mt-1">
                  {item.stage || "Стадия не указана"}
                </small>
              </td>
              <td className="py-3 pr-4">
                <span>
                  {formatCount(item.fixations)} фикс. ·{" "}
                  {formatCount(item.meetings)} встр.
                </span>
                {item.sourceReportedMetrics &&
                  item.metricSource?.kind !== "EXACT_ACTIVITIES" && (
                    <small
                      className="block text-warning"
                      title="Агрегаты исходного снимка без отдельных идентификаторов событий"
                    >
                      Данные среза, не event-level
                    </small>
                  )}
                <small className="text-text-muted block">
                  {item.hasAmo === true
                    ? "amoCRM связана"
                    : item.hasAmo === false
                      ? "Нет связи amoCRM"
                      : "Связь amoCRM не проверена"}
                </small>
              </td>
              <td className="py-3 pr-4">
                {formatDate(item.lastCallAt || item.lastActivityAt)}
              </td>
              <td className="py-3 pr-4 text-right">
                <b>{formatCount(item.deals)}</b>
                <small className="text-text-muted block whitespace-nowrap">
                  {formatRubles(item.dealAmount)}
                </small>
              </td>
              <td className="py-3">
                {item.assignee || (
                  <span className="text-text-muted">Не назначен</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LoyaltyBaseWorkspace() {
  const router = useRouter();
  const { broker: me } = useAuth();
  const [base, setBase] = useState<LoyaltyBaseKey>("anna");
  const [entityType, setEntityType] = useState<LoyaltyEntityType>("brokers");
  const [mode, setMode] = useState<"base" | "reconciliation">("base");
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("month");
  const [range, setRange] = useState(initialPeriod);
  const [overview, setOverview] = useState<LoyaltyOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState("");
  const [list, setList] = useState<LoyaltyListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState<"exclude" | "include" | "only">(
    "exclude",
  );
  const [city, setCity] = useState("");
  const [hasAmo, setHasAmo] = useState<"" | "true" | "false">("");
  const [segment, setSegment] = useState<LoyaltySegment | "">("");
  const [detailId, setDetailId] = useState("");
  const [detail, setDetail] = useState<LoyaltyRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const overviewRequest = useRef(0);
  const listRequest = useRef(0);
  const pageSize = 25;
  const isAdmin = me?.role === "ADMIN";
  const hasAccess = isAdmin || me?.role === "MANAGER";

  const loadOverview = useCallback(async () => {
    const requestId = ++overviewRequest.current;
    setOverviewLoading(true);
    setOverviewError("");
    try {
      const next = await getLoyaltyOverview(base, range);
      if (overviewRequest.current === requestId)
        setOverview(next.base === base ? next : null);
    } catch (reason) {
      if (overviewRequest.current === requestId) {
        setOverview(null);
        setOverviewError(
          reason instanceof Error ? reason.message : "Не удалось загрузить KPI",
        );
      }
    } finally {
      if (overviewRequest.current === requestId) setOverviewLoading(false);
    }
  }, [base, range]);

  const loadList = useCallback(async () => {
    const requestId = ++listRequest.current;
    setListLoading(true);
    setListError("");
    try {
      const next = await getLoyaltyList(base, entityType, {
        page,
        pageSize,
        search,
        archived,
        city,
        hasAmo,
        segment,
      });
      if (listRequest.current === requestId)
        setList(
          next.base === base && next.entityType === entityType ? next : null,
        );
    } catch (reason) {
      if (listRequest.current === requestId) {
        setList(null);
        setListError(
          reason instanceof Error
            ? reason.message
            : "Не удалось загрузить список",
        );
      }
    } finally {
      if (listRequest.current === requestId) setListLoading(false);
    }
  }, [archived, base, city, entityType, hasAmo, page, search, segment]);

  useEffect(() => {
    if (mode === "base") void loadOverview();
  }, [loadOverview, mode]);
  useEffect(() => {
    if (mode === "base") void loadList();
  }, [loadList, mode]);

  useEffect(() => {
    setOverview(null);
    setPage(1);
    setSearchInput("");
    setSearch("");
    setArchived("exclude");
    setCity("");
    setHasAmo("");
    setSegment("");
    setList(null);
    setDetailId("");
    setDetail(null);
    setImportOpen(false);
  }, [base]);

  useEffect(() => {
    setPage(1);
    setSearchInput("");
    setSearch("");
    setArchived("exclude");
    setCity("");
    setHasAmo("");
    setList(null);
    setDetailId("");
    setDetail(null);
  }, [entityType]);

  useEffect(() => {
    if (!detailId) return;
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    setDetail(null);
    getLoyaltyDetail(base, entityType, detailId)
      .then((value) => {
        if (active) setDetail(value);
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
  }, [base, detailId, entityType]);

  const periodLabel =
    periodPreset === "month"
      ? "текущий месяц"
      : periodPreset === "quarter"
        ? "текущий квартал"
        : "выбранный период";

  const openSegment = useCallback((nextSegment: LoyaltySegment) => {
    setEntityType("brokers");
    setSearchInput("");
    setSearch("");
    setArchived("exclude");
    setCity("");
    setHasAmo("");
    setSegment(nextSegment);
    setPage(1);
    setDetailId("");
    setDetail(null);
  }, []);

  const openLeader = useCallback(
    (nextEntityType: LoyaltyEntityType, leader: LoyaltyLeader | null) => {
      if (!leader?.id) return;
      router.push(
        `/admin/loyalty-base/${base}/${nextEntityType}/${encodeURIComponent(leader.id)}`,
      );
    },
    [base, router],
  );

  const sourceReported =
    base === "anna" ? overview?.sourceReportedSummary || null : null;
  const usesSourceRollup = Boolean(
    sourceReported &&
    ["SOURCE_AGGREGATE", "UNAVAILABLE"].includes(
      overview?.metricSource?.kind || "",
    ),
  );
  const brokerLeader = selectLoyaltyLeader(
    overview?.topBroker || null,
    sourceReported?.brokers.top || null,
    overview?.metricSource?.kind || "",
  );
  const agencyLeader = selectLoyaltyLeader(
    overview?.topAgency || null,
    sourceReported?.agencies.top || null,
    overview?.metricSource?.kind || "",
  );
  const topBrokerUsesSource = brokerLeader.usesSource;
  const topAgencyUsesSource = agencyLeader.usesSource;
  const displayedTopBroker = brokerLeader.leader;
  const displayedTopAgency = agencyLeader.leader;
  const methodologySource =
    base === "anna"
      ? usesSourceRollup
        ? `Источник: ${sourceReported?.label || "срез Анны"}. Это агрегаты источника без отдельных ID событий; выбранный период к ним не применяется.`
        : `Источник: опубликованный снимок очищенной базы Анны${overview?.snapshot?.status ? ` (${overview.snapshot.status})` : ""}.`
      : "Источник: рабочая база кабинета; архивные и объединённые дубли не учитываются.";

  const kpis = useMemo(
    () => [
      {
        title: "Не звонили в текущем месяце",
        value: usesSourceRollup
          ? (sourceReported?.brokers.notCalledCurrentMonth ?? "—")
          : (overview?.notCalledCurrentMonth ?? "—"),
        detail: usesSourceRollup
          ? `Данные среза; звонок известен у ${sourceReported?.brokers.notCalledKnownCount ?? 0} записей`
          : "Активные брокеры без звонка",
        methodology: usesSourceRollup
          ? `${methodologySource} Предварительно считаются только брокеры, у которых в срезе известна дата последнего звонка и она раньше первого дня текущего месяца по московскому времени. Записи без даты не считаются нулём.`
          : `${methodologySource} Считаются активные брокеры, у которых нет подтверждённого звонка с первого дня текущего месяца по московскому времени до текущего момента.`,
        icon: PhoneOff,
        onClick: overview
          ? () => openSegment("NOT_CALLED_CURRENT_MONTH")
          : undefined,
      },
      {
        title: "Новые брокеры",
        value: usesSourceRollup
          ? (sourceReported?.brokers.newCount ?? "—")
          : (overview?.newBrokers ?? "—"),
        detail: usesSourceRollup
          ? "Стадия «Новый», а не список «НОВАЯ»"
          : "Без БТ, фиксаций, встреч и сделок",
        methodology: `${methodologySource} Пометка источника «НОВАЯ» означает принадлежность к списку и не равна стадии «Новый». По согласованному правилу все переданные Анной контакты считаются как минимум «Звонили», поэтому одна пометка «НОВАЯ» не включает запись в этот KPI. Брокер попадает сюда только при вычисленной стадии «Новый» и отсутствии БТ, фиксаций, встреч и сделок.`,
        icon: UserPlus,
        onClick: overview ? () => openSegment("NEW_BROKER") : undefined,
      },
      {
        title: "Были на БТ и нет фиксации",
        value: usesSourceRollup
          ? (sourceReported?.brokers.btWithoutFixation ?? "—")
          : (overview?.btWithoutFixation ?? "—"),
        detail: usesSourceRollup
          ? "Флаг БТ и ноль фиксаций в срезе"
          : "Подтверждённое посещение БТ",
        methodology: usesSourceRollup
          ? `${methodologySource} Считаются строки, где в срезе Анны указан признак посещения БТ, а число фиксаций явно равно нулю. Это заявленные источником показатели, они не считаются подтверждёнными event-level событиями.`
          : `${methodologySource} Считаются брокеры с подтверждённым посещением брокер-тура и нулём подтверждённых фиксаций.`,
        icon: Sparkles,
        onClick: overview
          ? () => openSegment("BT_WITHOUT_FIXATION")
          : undefined,
      },
      {
        title: "Дни рождения сегодня",
        value: overview?.birthdaysToday ?? "—",
        detail:
          overview?.birthdaysToday === null
            ? "В базе нет известных дат рождения"
            : `День и месяц по Europe/Moscow${overview?.birthdayKnownCount ? ` · дат известно: ${overview.birthdayKnownCount}` : ""}`,
        methodology: `${methodologySource} Сравниваются только известные день и месяц рождения с сегодняшней датой в часовом поясе Europe/Moscow; год рождения не требуется.`,
        icon: Cake,
        onClick: overview ? () => openSegment("BIRTHDAY_TODAY") : undefined,
      },
      {
        title: topBrokerUsesSource
          ? "Топ-брокер по данным снимка"
          : `Топ-брокер за ${periodLabel}`,
        value: leaderValue(displayedTopBroker),
        detail: leaderDetail(
          displayedTopBroker,
          periodLabel,
          topBrokerUsesSource,
        ),
        methodology: topBrokerUsesSource
          ? `${methodologySource} Ранжирование выполняется по заявленному общему числу сделок, затем по общей сумме ДДУ; это не лидер выбранного месяца или квартала.`
          : `${methodologySource} Лидер определяется за выбранный период: сначала по числу подтверждённых сделок, затем по сумме ДДУ, дате последней сделки и стабильному идентификатору.`,
        icon: Trophy,
        onClick: displayedTopBroker
          ? () => openLeader("brokers", displayedTopBroker)
          : undefined,
      },
      {
        title: topAgencyUsesSource
          ? "Топ-агентство по данным снимка"
          : `Топ-агентство за ${periodLabel}`,
        value: leaderValue(displayedTopAgency),
        detail: leaderDetail(
          displayedTopAgency,
          periodLabel,
          topAgencyUsesSource,
        ),
        methodology: topAgencyUsesSource
          ? `${methodologySource} Ранжирование выполняется по заявленному общему числу сделок, затем по общей сумме ДДУ; брокерские и агентские агрегаты не складываются.`
          : `${methodologySource} Лидер определяется за выбранный период: сначала по числу подтверждённых сделок, затем по сумме ДДУ, дате последней сделки и стабильному идентификатору.`,
        icon: Building2,
        onClick: displayedTopAgency
          ? () => openLeader("agencies", displayedTopAgency)
          : undefined,
      },
    ],
    [
      displayedTopAgency,
      displayedTopBroker,
      methodologySource,
      openLeader,
      openSegment,
      overview,
      periodLabel,
      sourceReported,
      topAgencyUsesSource,
      topBrokerUsesSource,
      usesSourceRollup,
    ],
  );

  const changePeriod = (preset: PeriodPreset) => {
    setPeriodPreset(preset);
    if (preset !== "custom") setRange(periodRange(preset));
  };

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  const resetFilters = () => {
    setSearchInput("");
    setSearch("");
    setArchived("exclude");
    setCity("");
    setHasAmo("");
    setSegment("");
    setPage(1);
  };

  if (me && !hasAccess)
    return (
      <div className="card">
        Доступ к базе лояльности разрешён администраторам и менеджерам.
      </div>
    );

  return (
    <div className="space-y-5">
      <header className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <ShieldCheck className="w-7 h-7 text-accent" />
            База лояльности
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Две независимые базы. Общего списка и смешанных метрик нет.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isAdmin && (
            <button
              type="button"
              className={`btn ${mode === "reconciliation" ? "btn-primary" : "btn-secondary"} inline-flex items-center gap-2`}
              onClick={() =>
                setMode((value) =>
                  value === "base" ? "reconciliation" : "base",
                )
              }
            >
              <Database className="w-4 h-4" />
              {mode === "base" ? "Режим сверки" : "Вернуться к базе"}
            </button>
          )}
          {isAdmin && base === "anna" && mode === "base" && (
            <button
              type="button"
              className={`btn ${importOpen ? "btn-primary" : "btn-secondary"} inline-flex items-center gap-2`}
              onClick={() => setImportOpen((value) => !value)}
            >
              <FileJson className="w-4 h-4" />
              JSON-импорт
            </button>
          )}
        </div>
      </header>

      {mode === "base" && (
        <nav className="grid md:grid-cols-2 gap-2" aria-label="Выбор базы">
          {(["anna", "ours"] as const).map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={base === item}
              className={`rounded-xl border px-4 py-4 text-left transition ${base === item ? "border-accent bg-accent text-white shadow-sm" : "border-border bg-surface hover:bg-surface-secondary"}`}
              onClick={() => setBase(item)}
            >
              <span className="font-semibold block">{baseLabels[item]}</span>
              <small
                className={base === item ? "text-white/75" : "text-text-muted"}
              >
                {item === "anna"
                  ? "Отдельный импорт и snapshot"
                  : "Контакты текущего кабинета"}
              </small>
            </button>
          ))}
        </nav>
      )}

      {mode === "reconciliation" && isAdmin ? (
        <LoyaltyReconciliation />
      ) : (
        <>
          {importOpen && isAdmin && base === "anna" && (
            <AnnaImportPanel
              canPublish={Boolean(isAdmin)}
              onPublished={() => {
                void loadOverview();
                void loadList();
              }}
            />
          )}

          {base === "anna" &&
            !overviewLoading &&
            overview &&
            !overview.snapshot && (
              <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                  <div>
                    <div className="font-semibold">
                      Снимок базы Анны ещё не опубликован
                    </div>
                    <p className="mt-1 text-text-muted">
                      Пустой список и нулевые показатели означают отсутствие
                      загруженного снимка, а не реальные нулевые результаты
                      брокеров.
                    </p>
                  </div>
                </div>
              </div>
            )}

          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <nav
              className="inline-flex rounded-xl bg-surface-secondary p-1 self-start"
              aria-label="Тип записей"
            >
              {(["brokers", "agencies"] as const).map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={entityType === item}
                  className={`px-4 py-2 rounded-lg text-sm font-medium ${entityType === item ? "bg-surface text-accent shadow-sm" : "text-text-muted"}`}
                  onClick={() => {
                    setEntityType(item);
                    setSegment("");
                  }}
                >
                  {entityLabels[item]}{" "}
                  <span className="ml-1">
                    {item === "brokers"
                      ? (overview?.brokersTotal ?? "—")
                      : (overview?.agenciesTotal ?? "—")}
                  </span>
                </button>
              ))}
            </nav>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-text-muted mr-1">Период лидеров:</span>
              {(["month", "quarter", "custom"] as const).map((preset) => (
                <button
                  type="button"
                  key={preset}
                  className={`px-3 py-2 rounded-lg border ${periodPreset === preset ? "bg-accent text-white border-accent" : "bg-surface border-border"}`}
                  onClick={() => changePeriod(preset)}
                >
                  {preset === "month"
                    ? "Месяц"
                    : preset === "quarter"
                      ? "Квартал"
                      : "Даты"}
                </button>
              ))}
              {periodPreset === "custom" && (
                <>
                  <input
                    className="input w-auto"
                    type="date"
                    value={range.from}
                    max={range.to}
                    onChange={(event) =>
                      setRange((value) => ({
                        ...value,
                        from: event.target.value,
                      }))
                    }
                    aria-label="Период с"
                  />
                  <input
                    className="input w-auto"
                    type="date"
                    value={range.to}
                    min={range.from}
                    onChange={(event) =>
                      setRange((value) => ({
                        ...value,
                        to: event.target.value,
                      }))
                    }
                    aria-label="Период по"
                  />
                </>
              )}
            </div>
          </div>

          {overviewError && (
            <div className="rounded-lg bg-error/10 text-error p-3 flex items-center justify-between gap-3">
              <span className="flex gap-2">
                <AlertCircle className="w-5 h-5 shrink-0" />
                {overviewError}
              </span>
              <button
                className="btn btn-secondary"
                onClick={() => void loadOverview()}
              >
                <RefreshCcw className="w-4 h-4" />
              </button>
            </div>
          )}

          <section
            className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3"
            aria-label="Ключевые показатели"
          >
            {kpis.map((kpi) => (
              <KpiCard key={kpi.title} {...kpi} loading={overviewLoading} />
            ))}
          </section>

          <section className="card p-4" aria-label="Итоги активности и сделок">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">
                  {usesSourceRollup
                    ? "Данные среза Анны"
                    : "Подтверждённые активности и сделки"}
                </h2>
                <p className="mt-1 text-xs text-text-muted">
                  {usesSourceRollup
                    ? "Исторические агрегаты сохранены как данные источника: без выдуманных событий, без смешивания брокеров и агентств и без применения выбранного периода."
                    : base === "anna"
                      ? "Только подтверждённые записи с отдельными идентификаторами событий из опубликованного снимка Анны."
                      : "Подтверждённые записи рабочей базы кабинета за выбранный период."}
                </p>
              </div>
              <span
                className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs text-accent"
                title="Наведите на KPI выше, чтобы увидеть формулу расчёта"
              >
                <Info className="h-3.5 w-3.5" /> Формулы доступны по наведению
              </span>
            </div>
            {!usesSourceRollup && (
              <div className="mt-4">
                <ActivityTotals
                  fixations={
                    base === "anna" && !overview?.snapshot
                      ? null
                      : (overview?.activities.fixations ?? null)
                  }
                  meetings={
                    base === "anna" && !overview?.snapshot
                      ? null
                      : (overview?.activities.meetings ?? null)
                  }
                  deals={
                    base === "anna" && !overview?.snapshot
                      ? null
                      : (overview?.activities.deals ?? null)
                  }
                  dealAmount={
                    base === "anna" && !overview?.snapshot
                      ? null
                      : (overview?.dealAmount ?? null)
                  }
                />
              </div>
            )}
            {sourceReported && (
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                {!usesSourceRollup && (
                  <div className="xl:col-span-2 border-t border-border pt-4">
                    <h3 className="text-sm font-semibold">
                      Отдельно: исторические данные среза Анны
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      Эти значения сохраняются для контекста, но не заменяют
                      подтверждённые показатели выше.
                    </p>
                  </div>
                )}
                <div className="rounded-xl border border-border p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">
                      Брокерские карточки
                    </h3>
                    <span className="text-xs text-text-muted">
                      {sourceReported.brokers.records} источников
                    </span>
                  </div>
                  <ActivityTotals
                    fixations={sourceReported.brokers.fixations}
                    meetings={sourceReported.brokers.meetings}
                    deals={sourceReported.brokers.deals}
                    dealAmount={sourceReported.brokers.dealAmount}
                  />
                </div>
                <div className="rounded-xl border border-border p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">
                      Агентские карточки
                    </h3>
                    <span className="text-xs text-text-muted">
                      {sourceReported.agencies.records} источников
                    </span>
                  </div>
                  <ActivityTotals
                    fixations={sourceReported.agencies.fixations}
                    meetings={sourceReported.agencies.meetings}
                    deals={sourceReported.agencies.deals}
                    dealAmount={sourceReported.agencies.dealAmount}
                  />
                </div>
                <p className="text-xs text-text-muted xl:col-span-2">
                  Эти две группы могут описывать одни и те же CRM‑активности,
                  поэтому они намеренно не складываются. Для точных периодных
                  KPI нужны отдельные идентификаторы и даты событий.
                </p>
              </div>
            )}
          </section>

          <section className="card p-4">
            {segment && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">
                <span>
                  Сегмент KPI: <b>{segmentLabels[segment]}</b>
                </span>
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => {
                    setSegment("");
                    setPage(1);
                  }}
                >
                  Показать всех
                </button>
              </div>
            )}
            <form
              className="flex flex-col xl:flex-row gap-3"
              onSubmit={applySearch}
            >
              <label className="relative flex-1 min-w-[240px]">
                <span className="sr-only">Поиск</span>
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                <input
                  className="input pl-10"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder={
                    entityType === "brokers"
                      ? "Имя или телефон"
                      : "Название, ИНН или телефон"
                  }
                />
              </label>
              {!(base === "ours" && entityType === "agencies") && (
                <>
                  <select
                    className="input xl:w-48"
                    value={archived}
                    onChange={(event) => {
                      setArchived(event.target.value as typeof archived);
                      setPage(1);
                    }}
                    aria-label="Архив"
                  >
                    <option value="exclude">Только активные</option>
                    <option value="only">Только архив</option>
                    <option value="include">Активные и архив</option>
                  </select>
                  {base === "ours" ? (
                    <select
                      className="input xl:w-44"
                      value={city}
                      onChange={(event) => {
                        setCity(event.target.value);
                        setPage(1);
                      }}
                      aria-label="Регион"
                    >
                      <option value="">Все регионы</option>
                      <option value="MSK">Москва</option>
                      <option value="SPB">Санкт-Петербург</option>
                      <option value="OTHER">Другой регион</option>
                    </select>
                  ) : (
                    <input
                      className="input xl:w-44"
                      value={city}
                      onChange={(event) => {
                        setCity(event.target.value);
                        setPage(1);
                      }}
                      placeholder="Город"
                      aria-label="Город"
                    />
                  )}
                  <select
                    className="input xl:w-48"
                    value={hasAmo}
                    onChange={(event) => {
                      setHasAmo(event.target.value as typeof hasAmo);
                      setPage(1);
                    }}
                    aria-label="Связь с amoCRM"
                  >
                    <option value="">Любая связь amoCRM</option>
                    <option value="true">Найдены в amoCRM</option>
                    <option value="false">Не найдены в amoCRM</option>
                  </select>
                </>
              )}
              <button className="btn btn-primary" type="submit">
                Найти
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={resetFilters}
              >
                Сбросить
              </button>
            </form>
          </section>

          <section className="card" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="font-semibold">
                  {entityLabels[entityType]} · {baseLabels[base]}
                </h2>
                <p className="text-xs text-text-muted mt-1">
                  {list ? `${list.total} записей` : "Количество уточняется"}
                  {overview?.snapshot?.publishedAt
                    ? ` · snapshot от ${formatDate(overview.snapshot.publishedAt)}`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary inline-flex items-center gap-2"
                disabled={listLoading}
                onClick={() => void loadList()}
              >
                <RefreshCcw
                  className={`w-4 h-4 ${listLoading ? "animate-spin" : ""}`}
                />
                Обновить
              </button>
            </div>

            {listError ? (
              <div className="rounded-lg bg-error/10 text-error p-4">
                {listError}
              </div>
            ) : listLoading ? (
              <div className="py-16 flex justify-center items-center gap-2 text-text-muted">
                <Loader2 className="w-5 h-5 animate-spin" />
                Загружаем {entityLabels[entityType].toLowerCase()}…
              </div>
            ) : !list?.items.length ? (
              <div className="py-16 text-center">
                <Users className="w-10 h-10 text-text-muted mx-auto mb-3" />
                <div className="font-semibold">Записи не найдены</div>
                <p className="text-sm text-text-muted mt-1">
                  В этой базе нет записей по выбранным фильтрам.
                </p>
              </div>
            ) : (
              <LoyaltyTable
                data={list}
                entityType={entityType}
                onOpen={setDetailId}
              />
            )}

            {list && list.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-sm text-text-muted">
                  Страница {list.page} из {list.totalPages}
                </span>
                <div className="flex gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={page <= 1}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={page >= list.totalPages}
                    onClick={() =>
                      setPage((value) => Math.min(list.totalPages, value + 1))
                    }
                  >
                    <ChevronRight className="w-4 h-4" />
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
    </div>
  );
}
