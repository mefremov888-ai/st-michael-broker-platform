import type {
  LoyaltyAgencyStatus,
  LoyaltyBrokerStatus,
  LoyaltyCallResult,
  LoyaltyCallScenario,
  LoyaltyCanonicalFilter,
  LoyaltyDataQuality,
  LoyaltyEntityType,
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
  state: LoyaltyFilterFormState,
  entityType: LoyaltyEntityType,
): LoyaltyCanonicalFilter {
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
