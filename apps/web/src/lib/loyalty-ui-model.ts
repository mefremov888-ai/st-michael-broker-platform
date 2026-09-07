import { getLoyaltyCallResultOptions } from "./loyalty-base-api";
import type {
  LoyaltyAgencyStatus,
  LoyaltyBaseKey,
  LoyaltyBrokerStatus,
  LoyaltyCallResult,
  LoyaltyCallScenario,
  LoyaltyCanonicalFilter,
  LoyaltyColumnFilters,
  LoyaltyDataQuality,
  LoyaltyEntityType,
  LoyaltySegment,
  LoyaltySortField,
} from "./loyalty-base-api";

export interface LoyaltyMetricExplanation {
  formula: string;
  period: string;
  source: string;
  exactness: string;
  includedSemantics?: string;
  excludedSemantics?: string;
}

export function formatLoyaltyMetricExplanation(
  explanation: LoyaltyMetricExplanation,
) {
  return [
    `Формула: ${explanation.formula}`,
    `Период: ${explanation.period}`,
    `Источник: ${explanation.source}`,
    `Точность: ${explanation.exactness}`,
    explanation.includedSemantics
      ? `Включено: ${explanation.includedSemantics}`
      : "",
    explanation.excludedSemantics
      ? `Не включено: ${explanation.excludedSemantics}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function loyaltyMetricPeriodLabel(
  selectedPeriod: string,
  periodFilterApplied: boolean | null | undefined,
) {
  return periodFilterApplied === false
    ? "снимок / весь период источника; выбранный период не применяется"
    : selectedPeriod;
}

export type TriState = "" | "true" | "false";

export interface LoyaltyFilterFormState {
  includeLowSignal: boolean;
  search: string;
  city: string;
  hasAmo: TriState;
  archived: "exclude" | "include" | "only";
  callFrom: string;
  callTo: string;
  activityFrom: string;
  activityTo: string;
  campaignId: string;
  lastCallResult: LoyaltyCallResult | "";
  scenario: LoyaltyCallScenario | "";
  assigneeId: string;
  unassigned: boolean;
  specialization: string;
  geography: "" | "MOSCOW" | "REGION";
  workFormat: "" | "Агентство" | "Частный брокер" | "Координатор";
  relationshipStage: string;
  status: LoyaltyBrokerStatus | LoyaltyAgencyStatus | "";
  dataQuality: LoyaltyDataQuality | "";
  dealsMin: string;
  dealsMax: string;
  dealsInPeriod: TriState;
  bt: TriState;
  meetings: TriState;
  meetingsMin: string;
  meetingsMax: string;
  partnershipStatus: string;
  agencySize: "" | "Крупное" | "Среднее" | "Небольшое";
  websitePresent: TriState;
  projectsOnSite: "" | "YES" | "NO" | "IN_PROGRESS";
  individualTerms: TriState;
  specialTermsProposed: TriState;
  staleDays: string;
  rewardPresent: TriState;
  // «Не звонить»: "" — показать всех (по умолчанию), exclude — без
  // «не звонить», only — только «не звонить». Наша база / брокеры.
  doNotCall: "" | "exclude" | "only";
  // Источник фиксаций: "" — оба кабинета, old — только старый кабинет,
  // new — только новый. Только «Наша база».
  cabinetSource: "" | "old" | "new";
  sortBy: LoyaltySortField;
  sortOrder: "asc" | "desc";
}

const dateInMoscow = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

export function currentMoscowMonth() {
  const today = dateInMoscow();
  const [year, month] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${String(month).padStart(2, "0")}-01`,
    to: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

export function emptyLoyaltyFilters(): LoyaltyFilterFormState {
  // Пустой период = «за всё время». Период больше не навязывается по умолчанию.
  return {
    includeLowSignal: false,
    search: "",
    city: "",
    hasAmo: "",
    archived: "exclude",
    callFrom: "",
    callTo: "",
    activityFrom: "",
    activityTo: "",
    campaignId: "",
    lastCallResult: "",
    scenario: "",
    assigneeId: "",
    unassigned: false,
    specialization: "",
    geography: "",
    workFormat: "",
    relationshipStage: "",
    status: "",
    dataQuality: "",
    dealsMin: "",
    dealsMax: "",
    dealsInPeriod: "",
    bt: "",
    meetings: "",
    meetingsMin: "",
    meetingsMax: "",
    partnershipStatus: "",
    agencySize: "",
    websitePresent: "",
    projectsOnSite: "",
    individualTerms: "",
    specialTermsProposed: "",
    staleDays: "",
    rewardPresent: "",
    doNotCall: "",
    cabinetSource: "",
    sortBy: "name",
    sortOrder: "asc",
  };
}

const number = (value: string) => {
  const parsed = Number(value);
  return value !== "" && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
};
const boolean = (value: TriState) =>
  value === "true" ? true : value === "false" ? false : undefined;

export function toCanonicalFilter(
  unsafeState: LoyaltyFilterFormState,
  entityType: LoyaltyEntityType,
  base: LoyaltyBaseKey,
): LoyaltyCanonicalFilter {
  const state = sanitizeLoyaltyFilterState(base, entityType, unsafeState);
  // 2026-09-04 (задача D): «период звонков» больше НЕ подменяет период
  // активности для базы Анны при dealsInPeriod — сделки фильтруются только
  // по явно выбранному периоду активности.
  const activityPeriod =
    state.activityFrom && state.activityTo
      ? { from: state.activityFrom, to: state.activityTo }
      : undefined;
  // Пустой период = «за всё время»: без периода «сделки в периоде» становится
  // lifetime-предикатом по количеству сделок, а не ошибкой fail-closed API.
  const dealsInPeriod = activityPeriod
    ? boolean(state.dealsInPeriod)
    : undefined;
  const dealCount =
    state.dealsMin || state.dealsMax
      ? { min: number(state.dealsMin), max: number(state.dealsMax) }
      : !activityPeriod && state.dealsInPeriod === "true"
        ? { min: 1 }
        : !activityPeriod && state.dealsInPeriod === "false"
          ? { min: 0, max: 0 }
          : undefined;
  const common: LoyaltyCanonicalFilter = {
    includeLowSignal: state.includeLowSignal,
    callPeriod:
      state.callFrom && state.callTo
        ? { from: state.callFrom, to: state.callTo }
        : undefined,
    activityPeriod,
    campaignIds: state.campaignId ? [state.campaignId] : undefined,
    lastCallResults: state.lastCallResult ? [state.lastCallResult] : undefined,
    scenario: state.scenario || undefined,
    assigneeIds: state.assigneeId ? [state.assigneeId] : undefined,
    unassigned: state.unassigned || undefined,
    dealCount,
    dealsInPeriod,
    bt: boolean(state.bt),
    staleDays: number(state.staleDays),
    cabinetSource: state.cabinetSource || undefined,
  };

  if (state.meetingsMin || state.meetingsMax) {
    common.meetings = {
      min: number(state.meetingsMin),
      max: number(state.meetingsMax),
    };
  } else if (state.meetings !== "") {
    common.meetings =
      state.meetings === "true" ? { min: 1 } : { min: 0, max: 0 };
  }

  if (entityType === "brokers") {
    return {
      ...common,
      doNotCall: state.doNotCall || undefined,
      specializations: state.specialization
        ? [state.specialization]
        : undefined,
      geography: state.geography ? [state.geography] : undefined,
      workFormats: state.workFormat ? [state.workFormat] : undefined,
      relationshipStages: state.relationshipStage
        ? [state.relationshipStage]
        : undefined,
      brokerStatuses: state.status
        ? [state.status as LoyaltyBrokerStatus]
        : undefined,
      dataQuality: state.dataQuality ? [state.dataQuality] : undefined,
    };
  }

  return {
    ...common,
    partnershipStatuses: state.partnershipStatus
      ? [state.partnershipStatus]
      : undefined,
    specializations: state.specialization
      ? [state.specialization]
      : undefined,
    brokerStatuses: state.status
      ? [state.status as LoyaltyAgencyStatus]
      : undefined,
    agencySizes: state.agencySize ? [state.agencySize] : undefined,
    websitePresent: boolean(state.websitePresent),
    projectsOnSite: state.projectsOnSite ? [state.projectsOnSite] : undefined,
    individualTerms: boolean(state.individualTerms),
    specialTermsProposed: boolean(state.specialTermsProposed),
    rewardPresent: boolean(state.rewardPresent),
    dataQuality: state.dataQuality ? [state.dataQuality] : undefined,
  };
}

export const BROKER_SCENARIOS: ReadonlyArray<
  readonly [LoyaltyCallScenario, string]
> = [
  ["NOT_CALLED_IN_PERIOD", "Не звонили в период"],
  ["CALLED_IN_PERIOD", "Звонили в период"],
  ["BT_VISITED", "Был БТ"],
  ["BT_NOT_VISITED", "Не было БТ"],
  ["HAS_MEETINGS", "Есть встречи"],
  ["NO_MEETINGS", "Нет встреч"],
  ["BT_DROPPED", "Был на БТ → пропал"],
  ["BT_FIXATION_NO_MEETING", "БТ + фиксация, без встречи"],
  ["BT_MEETING_NO_DEAL", "БТ + встреча, без сделки"],
  ["NEW_NO_BT", "Новый, не был на БТ"],
  ["HAS_DEALS", "Есть сделки / топ"],
  ["UNASSIGNED", "Не назначен"],
];

export const AGENCY_SCENARIOS: ReadonlyArray<
  readonly [LoyaltyCallScenario, string]
> = [
  ["NOT_CALLED_IN_PERIOD", "Не звонили в период"],
  ["CALLED_IN_PERIOD", "Звонили в период"],
  ["BT_VISITED", "Был БТ"],
  ["BT_NOT_VISITED", "Не было БТ"],
  ["HAS_MEETINGS", "Есть встречи"],
  ["NO_MEETINGS", "Нет встреч"],
  ["SITE_PLACED", "Размещены на сайте"],
  ["SITE_NOT_PLACED", "Не размещены на сайте"],
  ["INDIVIDUAL_TERMS", "Индивидуальные условия"],
  ["NO_INDIVIDUAL_TERMS", "Нет индивидуальных условий"],
  ["HAS_DEALS", "Есть сделки / топ"],
  ["UNASSIGNED", "Не назначен"],
];

export type LoyaltyArchiveMode = LoyaltyFilterFormState["archived"];

export interface LoyaltyFilterCapabilities {
  hasAmo: boolean;
  dataQuality: boolean;
  agencySize: boolean;
  websitePresent: boolean;
  projectsOnSite: boolean;
  // «Не звонить» и «Действующая фиксация»: только «Наша база» / брокеры.
  doNotCall: boolean;
  activeFixation: boolean;
  // Источник «старый / новый кабинет»: только «Наша база» (брокеры и агентства).
  cabinetSource: boolean;
  archivedModes: ReadonlyArray<LoyaltyArchiveMode>;
  scenarios: ReadonlyArray<readonly [LoyaltyCallScenario, string]>;
  segments: ReadonlyArray<LoyaltySegment>;
}

const ALL_ARCHIVE_MODES: ReadonlyArray<LoyaltyArchiveMode> = [
  "exclude",
  "only",
  "include",
];
const OUR_AGENCY_ARCHIVE_MODES: ReadonlyArray<LoyaltyArchiveMode> = [
  "exclude",
  "include",
];
const BROKER_SEGMENTS: ReadonlyArray<LoyaltySegment> = [
  "NOT_CALLED_CURRENT_MONTH",
  "NEW_BROKER",
  "BT_WITHOUT_FIXATION",
  "BIRTHDAY_TODAY",
];
const OUR_AGENCY_SCENARIOS = AGENCY_SCENARIOS.filter(
  ([scenario]) => scenario !== "SITE_PLACED" && scenario !== "SITE_NOT_PLACED",
);
const TRI_STATES: ReadonlyArray<TriState> = ["", "true", "false"];
const DATA_QUALITY_VALUES: ReadonlyArray<
  LoyaltyFilterFormState["dataQuality"]
> = ["", "FULL", "NEEDS_COMPLETION", "NOT_FOUND_IN_CRM", "CONFLICT"];
const BROKER_STATUS_VALUES: ReadonlyArray<LoyaltyBrokerStatus | ""> = [
  "",
  "TOP_SELLER",
  "SELLER",
  "OFFERING",
  "FIXATING",
  "BROKER_TOUR",
  "DORMANT",
  "NEW",
];
const AGENCY_STATUS_VALUES: ReadonlyArray<LoyaltyAgencyStatus | ""> = [
  "",
  "VIP_PARTNER",
  "SELLING_PARTNER",
  "ACTIVE_PARTNER",
  "FIXATING_PARTNER",
  "WARM_PARTNER",
  "STARTING_PARTNER",
  "DORMANT_PARTNER",
  "NEW_AGENCY",
];
const GEOGRAPHY_VALUES: ReadonlyArray<LoyaltyFilterFormState["geography"]> = [
  "",
  "MOSCOW",
  "REGION",
];
const WORK_FORMAT_VALUES: ReadonlyArray<LoyaltyFilterFormState["workFormat"]> =
  ["", "Агентство", "Частный брокер", "Координатор"];
const AGENCY_SIZE_VALUES: ReadonlyArray<LoyaltyFilterFormState["agencySize"]> =
  ["", "Крупное", "Среднее", "Небольшое"];
const PROJECTS_ON_SITE_VALUES: ReadonlyArray<
  LoyaltyFilterFormState["projectsOnSite"]
> = ["", "YES", "NO", "IN_PROGRESS"];
const SORT_VALUES: ReadonlyArray<LoyaltySortField> = [
  "name",
  "city",
  "lastCallAt",
  "fixations",
  "meetings",
  "deals",
  "dealAmount",
  "brokerTours",
  "brokerCount",
  "rating",
  "updatedAt",
];
const SORT_ORDER_VALUES: ReadonlyArray<LoyaltyFilterFormState["sortOrder"]> = [
  "asc",
  "desc",
];
const DO_NOT_CALL_VALUES: ReadonlyArray<LoyaltyFilterFormState["doNotCall"]> = [
  "",
  "exclude",
  "only",
];
const DATE_ONLY_INPUT = /^\d{4}-\d{2}-\d{2}$/;
const NON_NEGATIVE_INTEGER_INPUT = /^\d+$/;

function isValidDateOnlyInput(value: string): boolean {
  if (value === "") return true;
  if (!DATE_ONLY_INPUT.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isValidNonNegativeIntegerInput(value: string): boolean {
  if (value === "") return true;
  if (!NON_NEGATIVE_INTEGER_INPUT.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

/**
 * UI capability contract for one concrete base/entity pair. The API remains
 * fail-closed; this matrix prevents the UI from constructing predicates which
 * the selected authoritative model cannot answer.
 */
export function loyaltyFilterCapabilities(
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
): LoyaltyFilterCapabilities {
  const ourAgency = base === "ours" && entityType === "agencies";
  const agencyWithSourceFields = entityType === "agencies" && !ourAgency;
  const ourBroker = base === "ours" && entityType === "brokers";
  return {
    hasAmo: !ourAgency,
    dataQuality: !ourAgency,
    agencySize: agencyWithSourceFields,
    websitePresent: agencyWithSourceFields,
    projectsOnSite: agencyWithSourceFields,
    doNotCall: ourBroker,
    activeFixation: ourBroker,
    cabinetSource: base === "ours",
    archivedModes: ourAgency ? OUR_AGENCY_ARCHIVE_MODES : ALL_ARCHIVE_MODES,
    scenarios:
      entityType === "brokers"
        ? BROKER_SCENARIOS
        : ourAgency
          ? OUR_AGENCY_SCENARIOS
          : AGENCY_SCENARIOS,
    segments: entityType === "brokers" ? BROKER_SEGMENTS : [],
  };
}

/**
 * Sanitizes both live UI state and untrusted saved-view state. Unsupported or
 * unknown values are cleared rather than converted into a negative predicate.
 * The original object is retained when no change is required.
 */
export function sanitizeLoyaltyFilterState(
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
  state: LoyaltyFilterFormState,
): LoyaltyFilterFormState {
  const capabilities = loyaltyFilterCapabilities(base, entityType);
  const patch: Partial<LoyaltyFilterFormState> = {};
  const clear = (key: keyof LoyaltyFilterFormState) => {
    Object.assign(patch, { [key]: "" });
  };
  const scenarioAllowed =
    state.scenario === "" ||
    capabilities.scenarios.some(([scenario]) => scenario === state.scenario);

  for (const key of [
    "hasAmo",
    "dealsInPeriod",
    "bt",
    "meetings",
    "websitePresent",
    "individualTerms",
    "specialTermsProposed",
    "rewardPresent",
  ] as const) {
    if (!TRI_STATES.includes(state[key])) clear(key);
  }
  for (const key of [
    "callFrom",
    "callTo",
    "activityFrom",
    "activityTo",
  ] as const) {
    if (!isValidDateOnlyInput(state[key])) clear(key);
  }
  for (const key of [
    "dealsMin",
    "dealsMax",
    "meetingsMin",
    "meetingsMax",
    "staleDays",
  ] as const) {
    if (!isValidNonNegativeIntegerInput(state[key])) clear(key);
  }

  const statusValues =
    entityType === "brokers" ? BROKER_STATUS_VALUES : AGENCY_STATUS_VALUES;
  if (!statusValues.includes(state.status as never)) patch.status = "";
  if (!GEOGRAPHY_VALUES.includes(state.geography)) patch.geography = "";
  if (!WORK_FORMAT_VALUES.includes(state.workFormat)) patch.workFormat = "";
  if (!AGENCY_SIZE_VALUES.includes(state.agencySize)) patch.agencySize = "";
  if (!PROJECTS_ON_SITE_VALUES.includes(state.projectsOnSite)) {
    patch.projectsOnSite = "";
  }
  if (!SORT_VALUES.includes(state.sortBy)) patch.sortBy = "name";
  if (!SORT_ORDER_VALUES.includes(state.sortOrder)) patch.sortOrder = "asc";
  if (
    state.lastCallResult !== "" &&
    !getLoyaltyCallResultOptions(entityType).some(
      ({ code }) => code === state.lastCallResult,
    )
  ) {
    patch.lastCallResult = "";
  }

  if (
    (!capabilities.hasAmo && state.hasAmo !== "") ||
    (capabilities.hasAmo && !TRI_STATES.includes(state.hasAmo))
  ) {
    patch.hasAmo = "";
  }
  if (
    (!capabilities.dataQuality && state.dataQuality !== "") ||
    (capabilities.dataQuality &&
      !DATA_QUALITY_VALUES.includes(state.dataQuality))
  ) {
    patch.dataQuality = "";
  }
  if (!capabilities.archivedModes.includes(state.archived)) {
    patch.archived = "exclude";
  }
  if (!scenarioAllowed) patch.scenario = "";
  if (!capabilities.agencySize && state.agencySize !== "") {
    patch.agencySize = "";
  }
  if (!capabilities.websitePresent && state.websitePresent !== "") {
    patch.websitePresent = "";
  }
  if (!capabilities.projectsOnSite && state.projectsOnSite !== "") {
    patch.projectsOnSite = "";
  }
  if (
    (!capabilities.doNotCall && state.doNotCall !== "") ||
    !DO_NOT_CALL_VALUES.includes(state.doNotCall)
  ) {
    patch.doNotCall = "";
  }
  if (
    (!capabilities.cabinetSource && state.cabinetSource !== "") ||
    !["", "old", "new"].includes(state.cabinetSource)
  ) {
    patch.cabinetSource = "";
  }

  return Object.keys(patch).length ? { ...state, ...patch } : state;
}

export function sanitizeLoyaltySegment(
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
  segment: LoyaltySegment | "",
): LoyaltySegment | "" {
  const allowed = loyaltyFilterCapabilities(base, entityType).segments;
  return allowed.includes(segment as LoyaltySegment) ? segment : "";
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const objectRecord = (value: unknown): Record<string, unknown> =>
  isObjectRecord(value) ? value : {};

function sanitizeLoyaltyColumnFilters(
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
  value: unknown,
): LoyaltyColumnFilters {
  const candidate = objectRecord(value);
  const output: LoyaltyColumnFilters = {};
  const statusValues =
    entityType === "brokers" ? BROKER_STATUS_VALUES : AGENCY_STATUS_VALUES;
  if (["HAS_PHONE", "NO_PHONE"].includes(String(candidate.contact || ""))) {
    output.contact = candidate.contact as LoyaltyColumnFilters["contact"];
  }
  if (
    typeof candidate.statusStage === "string" &&
    candidate.statusStage !== "" &&
    statusValues.includes(candidate.statusStage as never)
  ) {
    output.statusStage =
      candidate.statusStage as LoyaltyColumnFilters["statusStage"];
  }
  if (
    [
      "BT_VISITED",
      "BT_NOT_VISITED",
      "HAS_FIXATIONS",
      "NO_FIXATIONS",
      "HAS_MEETINGS",
      "NO_MEETINGS",
      // «Действующая фиксация» — только «Наша база» / брокеры (сроки
      // фиксаций есть только у локальных клиентов).
      ...(loyaltyFilterCapabilities(base, entityType).activeFixation
        ? ["HAS_ACTIVE_FIXATIONS"]
        : []),
    ].includes(String(candidate.activity || ""))
  ) {
    output.activity = candidate.activity as LoyaltyColumnFilters["activity"];
  }
  if (
    ["CALLED_IN_PERIOD", "NOT_CALLED_IN_PERIOD"].includes(
      String(candidate.calls || ""),
    )
  ) {
    output.calls = candidate.calls as LoyaltyColumnFilters["calls"];
  }
  if (typeof candidate.assignee === "string" && candidate.assignee.trim()) {
    output.assignee = candidate.assignee.trim();
  }
  const dealValues =
    entityType === "brokers"
      ? ["HAS_DEALS", "NO_DEALS", "ONE_TO_TWO", "THREE_PLUS"]
      : ["HAS_DEALS", "NO_DEALS", "ONE_TO_FOUR", "FIVE_PLUS"];
  if (dealValues.includes(String(candidate.deals || ""))) {
    output.deals = candidate.deals as LoyaltyColumnFilters["deals"];
  }
  return output;
}

const formStateFromSavedView = (
  value: Record<string, unknown>,
): LoyaltyFilterFormState => {
  const defaults = emptyLoyaltyFilters();
  const candidate = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(defaults) as Array<
    keyof LoyaltyFilterFormState
  >) {
    const saved = value[key];
    if (
      (typeof defaults[key] === "string" && typeof saved === "string") ||
      (typeof defaults[key] === "boolean" && typeof saved === "boolean")
    ) {
      candidate[key] = saved;
    }
  }

  // Search terms may contain phone numbers, emails or names and are
  // intentionally never restored from a personal or shared saved view.
  candidate.search = "";
  return candidate as unknown as LoyaltyFilterFormState;
};

export interface RestoredLoyaltySavedView {
  filters: LoyaltyFilterFormState;
  columns: LoyaltyColumnFilters;
  segment: LoyaltySegment | "";
}

/**
 * Restores the UI envelope used by current saved views and the legacy flat
 * shape. Values are treated as untrusted JSON: wrong primitive types fall
 * back to defaults, PII-bearing search is discarded, and unsupported filters
 * are removed through the same capability matrix as live form state.
 */
export function restoreLoyaltySavedView(
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
  snapshot: Record<string, unknown>,
): RestoredLoyaltySavedView {
  const ui = objectRecord(snapshot.ui);
  const savedFilters = isObjectRecord(ui.filters) ? ui.filters : snapshot;
  const filters = sanitizeLoyaltyFilterState(
    base,
    entityType,
    formStateFromSavedView(savedFilters),
  );
  const columns = sanitizeLoyaltyColumnFilters(
    base,
    entityType,
    isObjectRecord(ui.columns) ? ui.columns : snapshot.columns,
  );
  const segment = sanitizeLoyaltySegment(
    base,
    entityType,
    typeof ui.segment === "string"
      ? (ui.segment as LoyaltySegment | "")
      : typeof snapshot.segment === "string"
        ? (snapshot.segment as LoyaltySegment | "")
        : "",
  );

  return { filters, columns, segment };
}
