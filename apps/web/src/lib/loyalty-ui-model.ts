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
  const period = currentMoscowMonth();
  return {
    includeLowSignal: false,
    search: "",
    city: "",
    hasAmo: "",
    archived: "exclude",
    callFrom: period.from,
    callTo: period.to,
    activityFrom: period.from,
    activityTo: period.to,
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
  value === "" ? undefined : value === "true";

export function toCanonicalFilter(
  unsafeState: LoyaltyFilterFormState,
  entityType: LoyaltyEntityType,
  base: LoyaltyBaseKey,
): LoyaltyCanonicalFilter {
  const state = sanitizeLoyaltyFilterState(base, entityType, unsafeState);
  const common: LoyaltyCanonicalFilter = {
    includeLowSignal: state.includeLowSignal,
    callPeriod:
      state.callFrom && state.callTo
        ? { from: state.callFrom, to: state.callTo }
        : undefined,
    activityPeriod:
      state.activityFrom && state.activityTo
        ? { from: state.activityFrom, to: state.activityTo }
        : undefined,
    campaignIds: state.campaignId ? [state.campaignId] : undefined,
    lastCallResults: state.lastCallResult ? [state.lastCallResult] : undefined,
    scenario: state.scenario || undefined,
    assigneeIds: state.assigneeId ? [state.assigneeId] : undefined,
    unassigned: state.unassigned || undefined,
    dealCount:
      state.dealsMin || state.dealsMax
        ? { min: number(state.dealsMin), max: number(state.dealsMax) }
        : undefined,
    dealsInPeriod: boolean(state.dealsInPeriod),
    bt: boolean(state.bt),
    staleDays: number(state.staleDays),
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
  ["BT_DROPPED", "Был на БТ → пропал"],
  ["BT_FIXATION_NO_MEETING", "БТ + фиксация, без встречи"],
  ["BT_MEETING_NO_DEAL", "БТ + встреча, без сделки"],
  ["NEW_NO_BT", "Новый, не был на БТ"],
  ["HAS_DEALS", "Есть сделки / топ"],
  ["UNASSIGNED", "Не назначен"],
  ["BT_VISITED", "Был БТ"],
  ["BT_NOT_VISITED", "Не было БТ"],
  ["HAS_MEETINGS", "Есть встречи"],
  ["NO_MEETINGS", "Нет встреч"],
];

export const AGENCY_SCENARIOS: ReadonlyArray<
  readonly [LoyaltyCallScenario, string]
> = [
  ["NOT_CALLED_IN_PERIOD", "Не звонили в период"],
  ["CALLED_IN_PERIOD", "Звонили в период"],
  ["UNASSIGNED", "Не назначен"],
  ["BT_VISITED", "Был БТ"],
  ["BT_NOT_VISITED", "Не было БТ"],
  ["SITE_PLACED", "Размещены на сайте"],
  ["SITE_NOT_PLACED", "Не размещены на сайте"],
  ["INDIVIDUAL_TERMS", "Индивидуальные условия"],
  ["NO_INDIVIDUAL_TERMS", "Нет индивидуальных условий"],
  ["HAS_MEETINGS", "Есть встречи"],
  ["NO_MEETINGS", "Нет встреч"],
];

export type LoyaltyArchiveMode = LoyaltyFilterFormState["archived"];

export interface LoyaltyFilterCapabilities {
  hasAmo: boolean;
  dataQuality: boolean;
  agencySize: boolean;
  websitePresent: boolean;
  projectsOnSite: boolean;
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
  return {
    hasAmo: !ourAgency,
    dataQuality: !ourAgency,
    agencySize: agencyWithSourceFields,
    websitePresent: agencyWithSourceFields,
    projectsOnSite: agencyWithSourceFields,
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
  const scenarioAllowed =
    state.scenario === "" ||
    capabilities.scenarios.some(([scenario]) => scenario === state.scenario);

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
  const columns = (
    isObjectRecord(ui.columns) ? ui.columns : objectRecord(snapshot.columns)
  ) as LoyaltyColumnFilters;
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
