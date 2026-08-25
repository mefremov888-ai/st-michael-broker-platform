import { apiDownload, apiGet, apiPatch, apiPost, apiUpload } from "./api";

export type LoyaltyBaseKey = "anna" | "ours";
export type LoyaltyEntityType = "brokers" | "agencies";
export type LoyaltySegment =
  | "NOT_CALLED_CURRENT_MONTH"
  | "NEW_BROKER"
  | "BT_WITHOUT_FIXATION"
  | "BIRTHDAY_TODAY";

export type LoyaltyCallResult =
  | "INFORMED"
  | "DO_NOT_CALL"
  | "NOT_INTERESTED"
  | "NO_ANSWER"
  | "SEND_INFORMATION"
  | "BROKER_TOUR_BOOKED"
  | "BROKER_TOUR_DECLINED"
  | "INVALID_PHONE"
  | "NOT_A_BROKER"
  | "COOPERATION_DECLINED"
  | "BROKER_TOUR_SCHEDULED"
  | "CALLBACK"
  | "AGREEMENTS_EXIST"
  | "COOPERATION_AGREED";

export const BROKER_CALL_RESULTS = [
  ["INFORMED", "Проинформирован"],
  ["DO_NOT_CALL", "Просил не звонить"],
  ["NOT_INTERESTED", "Неинтересно"],
  ["NO_ANSWER", "НДЗ"],
  ["SEND_INFORMATION", "Просил отправить информацию"],
  ["BROKER_TOUR_BOOKED", "Запись на БТ"],
  ["BROKER_TOUR_DECLINED", "Отказ от БТ"],
  ["INVALID_PHONE", "Некорректный номер"],
  ["NOT_A_BROKER", "Уже не брокер"],
] as const satisfies ReadonlyArray<readonly [LoyaltyCallResult, string]>;

export const AGENCY_CALL_RESULTS = [
  ["NO_ANSWER", "НДЗ"],
  ["COOPERATION_DECLINED", "Отказ от сотрудничества"],
  ["BROKER_TOUR_SCHEDULED", "Назначен БТ"],
  ["CALLBACK", "Перезвонить"],
  ["SEND_INFORMATION", "Отправить информацию"],
  ["AGREEMENTS_EXIST", "Есть договорённости"],
  ["COOPERATION_AGREED", "Договорились о сотрудничестве"],
] as const satisfies ReadonlyArray<readonly [LoyaltyCallResult, string]>;

export type LoyaltyCallScenario =
  | "NOT_CALLED_IN_PERIOD"
  | "CALLED_IN_PERIOD"
  | "BT_DROPPED"
  | "BT_FIXATION_NO_MEETING"
  | "BT_MEETING_NO_DEAL"
  | "NEW_NO_BT"
  | "HAS_DEALS"
  | "UNASSIGNED"
  | "BT_VISITED"
  | "BT_NOT_VISITED"
  | "SITE_PLACED"
  | "SITE_NOT_PLACED"
  | "INDIVIDUAL_TERMS"
  | "NO_INDIVIDUAL_TERMS"
  | "HAS_MEETINGS"
  | "NO_MEETINGS";

export type LoyaltyBrokerStatus =
  | "TOP_SELLER"
  | "SELLER"
  | "OFFERING"
  | "FIXATING"
  | "BROKER_TOUR"
  | "DORMANT"
  | "NEW";

export type LoyaltyAgencyStatus =
  | "VIP_PARTNER"
  | "SELLING_PARTNER"
  | "ACTIVE_PARTNER"
  | "FIXATING_PARTNER"
  | "WARM_PARTNER"
  | "STARTING_PARTNER"
  | "DORMANT_PARTNER"
  | "NEW_AGENCY";

/**
 * Status codes are supplied by the loyalty backend. The named variants keep
 * the current contract discoverable while the open string member lets the
 * frontend retain a newer backend code instead of silently dropping it.
 */
export type LoyaltyComputedStatus =
  | LoyaltyBrokerStatus
  | LoyaltyAgencyStatus
  | (string & Record<never, never>);

export type LoyaltyDataQuality =
  | "FULL"
  | "NEEDS_COMPLETION"
  | "NOT_FOUND_IN_CRM"
  | "CONFLICT";

export type LoyaltySortField =
  | "name"
  | "city"
  | "lastCallAt"
  | "fixations"
  | "meetings"
  | "deals"
  | "dealAmount"
  | "brokerTours"
  | "brokerCount"
  | "rating"
  | "updatedAt";

export interface LoyaltyCanonicalFilter {
  includeLowSignal?: boolean;
  callPeriod?: { from: string; to: string };
  activityPeriod?: { from: string; to: string };
  campaignIds?: string[];
  lastCallResults?: LoyaltyCallResult[];
  scenario?: LoyaltyCallScenario;
  assigneeIds?: string[];
  unassigned?: boolean;
  specializations?: string[];
  geography?: Array<"MOSCOW" | "REGION">;
  workFormats?: Array<"Агентство" | "Частный брокер" | "Координатор">;
  relationshipStages?: string[];
  brokerStatuses?: Array<LoyaltyBrokerStatus | LoyaltyAgencyStatus>;
  dataQuality?: LoyaltyDataQuality[];
  dealCount?: { min?: number; max?: number };
  dealsInPeriod?: boolean;
  bt?: boolean;
  meetings?: { min?: number; max?: number };
  partnershipStatuses?: string[];
  agencySizes?: Array<"Крупное" | "Среднее" | "Небольшое">;
  websitePresent?: boolean;
  projectsOnSite?: Array<"YES" | "NO" | "IN_PROGRESS">;
  individualTerms?: boolean;
  specialTermsProposed?: boolean;
  rewardPresent?: boolean;
  staleDays?: number;
}

export interface LoyaltyColumnFilters {
  contact?: "HAS_PHONE" | "NO_PHONE";
  statusStage?: LoyaltyBrokerStatus | LoyaltyAgencyStatus;
  activity?:
    | "BT_VISITED"
    | "BT_NOT_VISITED"
    | "HAS_FIXATIONS"
    | "NO_FIXATIONS"
    | "HAS_MEETINGS"
    | "NO_MEETINGS";
  calls?: "CALLED_IN_PERIOD" | "NOT_CALLED_IN_PERIOD";
  assignee?: string;
  deals?:
    | "HAS_DEALS"
    | "NO_DEALS"
    | "ONE_TO_TWO"
    | "ONE_TO_FOUR"
    | "THREE_PLUS"
    | "FIVE_PLUS";
}

export interface LoyaltyListRequest {
  page: number;
  pageSize: number;
  search: string;
  city?: string;
  hasAmo?: boolean;
  archived: "exclude" | "include" | "only";
  segment?: LoyaltySegment;
  sortBy?: LoyaltySortField;
  sortOrder?: "asc" | "desc";
  filter: LoyaltyCanonicalFilter;
  columns?: LoyaltyColumnFilters;
}

export interface LoyaltyFacetValue {
  value: string;
  matches: number;
}

export interface LoyaltyFacets {
  cities: LoyaltyFacetValue[];
  assignees: LoyaltyFacetValue[];
  specializations: LoyaltyFacetValue[];
  stages: LoyaltyFacetValue[];
  statuses: LoyaltyFacetValue[];
  dataQuality: LoyaltyFacetValue[];
  agencySizes: LoyaltyFacetValue[];
}

export interface LoyaltyLeader {
  id: string;
  name: string;
  deals: number;
  dealAmount: string | null;
}

export type LoyaltyLeaderMode = "EXACT" | "LOCAL_PRELIMINARY" | "UNAVAILABLE";

/**
 * Anna leaders remain fail-closed unless event-level activity data is exact.
 * OUR leaders may be shown from the explicitly labelled local preliminary
 * operational rollup; this never upgrades Anna source rollups to exact data.
 */
export function loyaltyLeaderMode(
  base: LoyaltyBaseKey,
  metricSourceKind: string,
): LoyaltyLeaderMode {
  if (base === "anna")
    return metricSourceKind === "EXACT_ACTIVITIES" ? "EXACT" : "UNAVAILABLE";
  if (metricSourceKind === "EXACT_ACTIVITIES") return "EXACT";
  if (metricSourceKind === "LOCAL_PRELIMINARY") return "LOCAL_PRELIMINARY";
  return "UNAVAILABLE";
}

export function selectLoyaltyLeader(
  exactLeader: LoyaltyLeader | null,
  sourceLeader: LoyaltyLeader | null,
  metricSourceKind: string,
): { leader: LoyaltyLeader | null; usesSource: boolean } {
  if (exactLeader) return { leader: exactLeader, usesSource: false };
  const sourceRollupSelected = ["SOURCE_AGGREGATE", "UNAVAILABLE"].includes(
    metricSourceKind,
  );
  return sourceRollupSelected && sourceLeader
    ? { leader: sourceLeader, usesSource: true }
    : { leader: null, usesSource: false };
}

export interface LoyaltyMetricSource {
  kind: string;
  label: string;
  quality: string;
  exactness: string;
  ruleVersion: string;
  periodFilterApplied: boolean | null;
  contributingRecords: number | null;
  sourceVersions: string[];
}

export function hasLoyaltyActivityEvidence(
  source: LoyaltyMetricSource | null | undefined,
): boolean {
  if (source?.kind === "EXACT_ACTIVITIES") return true;
  return (
    source?.kind === "LOCAL_PRELIMINARY" &&
    (source.contributingRecords ?? 0) > 0
  );
}

export interface LoyaltyKpiMethodology {
  source: string;
  ruleVersion: string;
  exactness: string;
  formula: string;
  includedSemantics: string;
  excludedSemantics: string;
  periodFilterApplied: boolean | null;
}

export interface LoyaltySourceReportedGroup {
  records: number;
  fixations: number | null;
  fixationKnownRecords: number;
  meetings: number | null;
  meetingKnownRecords: number;
  deals: number | null;
  dealKnownRecords: number;
  brokerTours: number | null;
  brokerTourKnownRecords: number;
  calls: number | null;
  callKnownRecords: number;
  dealAmount: string | null;
  dealAmountKnownRecords: number;
  top: LoyaltyLeader | null;
}

export interface LoyaltySourceReportedSummary {
  kind: string;
  label: string;
  confirmationStatus: string;
  quality: string;
  exactness: string[];
  sourceVersions: string[];
  periodFilterApplied: boolean | null;
  warning: string;
  brokers: LoyaltySourceReportedGroup & {
    notCalledCurrentMonth: number | null;
    notCalledKnownCount: number;
    newCount: number | null;
    btWithoutFixation: number | null;
  };
  agencies: LoyaltySourceReportedGroup;
}

export interface LoyaltyOverview {
  base: LoyaltyBaseKey;
  snapshot: {
    id: string;
    status: string;
    publishedAt: string;
  } | null;
  brokersTotal: number;
  agenciesTotal: number;
  notCalledCurrentMonth: number | null;
  newBrokers: number | null;
  btWithoutFixation: number | null;
  birthdaysToday: number | null;
  birthdayKnownCount: number;
  topBroker: LoyaltyLeader | null;
  topAgency: LoyaltyLeader | null;
  activities: {
    fixations: number | null;
    meetings: number | null;
    deals: number | null;
  };
  dealAmount: string | null;
  period: { from: string; to: string } | null;
  metricSource: LoyaltyMetricSource | null;
  kpiMetadata: Record<string, LoyaltyKpiMethodology>;
  sourceReportedSummary: LoyaltySourceReportedSummary | null;
}

export interface LoyaltyRecord {
  id: string;
  entityType: LoyaltyEntityType;
  name: string;
  company: string;
  phone: string;
  email: string;
  city: string;
  geography: string;
  role: string;
  computedStatuses: LoyaltyComputedStatus[];
  status: string;
  stage: string;
  assignee: string;
  dataQuality: string;
  hasAmo: boolean | null;
  amoContactUrl: string;
  archived: boolean;
  updatedAt: string;
  fixations: number | null;
  meetings: number | null;
  deals: number | null;
  dealAmount: string | null;
  lastCallAt: string;
  lastCallResult: string;
  lastActivityAt: string;
  daysWithoutContact: number | null;
  nextTask: string;
  nextTaskAt: string;
  taskAssignee: string;
  birthday: string;
  workFormat: string;
  specialization: string;
  sourceIds: string[];
  aliases: string[];
  memberships: string[];
  agencies: Array<{
    id: string;
    name: string;
    role: string;
    isPrimary: boolean | null;
  }>;
  comment: string;
  contactPoints: Array<{
    id: string;
    type: string;
    label: string;
    value: string;
    isPrimary: boolean | null;
  }>;
  contacts: Array<{
    id: string;
    name: string;
    role: string;
    phone: string;
    email: string;
    status: string;
    contactPoints: Array<{
      id: string;
      type: string;
      label: string;
      value: string;
      isPrimary: boolean | null;
    }>;
  }>;
  history: Array<{
    id: string;
    type: string;
    occurredAt: string;
    title: string;
    description: string;
    assignmentId?: string;
    campaignId?: string;
    campaignName?: string;
    employeeId?: string;
    employeeName?: string;
    result?: string;
    comment?: string;
    nextStep?: string;
    nextActionAt?: string;
    correctionReason?: string;
    isCorrection?: boolean;
    effective?: boolean;
    superseded?: boolean;
  }>;
  recognitions: Array<{
    id: string;
    date: string;
    type: string;
    note: string;
    employee: string;
    amount: string;
    validUntil: string;
    hasAttachment: boolean;
  }>;
  annaDetails: {
    agencySize: string;
    brokerCount: number | null;
    website: string;
    projectsOnSite: string;
    sitePlacementRequirements: string;
    lastAgencyMeetingDate: string;
    agencyBtFormat: string;
    agencyBtDate: string;
    activeBrokers: number | null;
    lastContractDate: string;
    partnershipStatus: string;
    legalName: string;
    nextAgreement: string;
    specialTerms: string;
    specialTermsStatus: string;
    specialTermsValidUntil: string;
    rating: number | null;
    crmSource: string;
    paymentControl: number | null;
    successfulDeals: number | null;
    zorgeDeals: number | null;
    berzarinaDeals: number | null;
    activeCrmCards: number | null;
    crmScore: number | null;
    dealsWithAmount: number | null;
    verifiedDealIdsCount: number | null;
  } | null;
  provenance: Array<{ field: string; source: string; updatedAt: string }>;
  metricSource: {
    kind: string;
    label: string;
    exactness: string;
    quality: string;
    periodFilterApplied: boolean | null;
  } | null;
  sourceReportedMetrics: {
    fixations: number | null;
    meetings: number | null;
    deals: number | null;
    brokerTours: number | null;
    calls: number | null;
    dealAmount: string | null;
    sourceLabel: string;
    quality: string;
    exactness: string;
    lastFixationAt: string;
    lastMeetingAt: string;
    lastDealAt: string;
    lastCallAt: string;
    brokerTourVisited: boolean | null;
    brokerTourAt: string;
    dealsByMonth: Record<string, number>;
  } | null;
  periodMetrics: {
    period: { from: string; to: string } | null;
    availability: "EXACT" | "LOCAL_PRELIMINARY" | "UNAVAILABLE";
    fixations: number | null;
    meetings: number | null;
    deals: number | null;
    dealAmount: string | null;
    lastFixationAt: string;
    lastMeetingAt: string;
    lastDealAt: string;
  } | null;
}

export interface LoyaltyDisplayMetrics {
  fixations: number | null;
  meetings: number | null;
  deals: number | null;
  dealAmount: string | null;
  selectedPeriod: boolean;
  availability: "EXACT" | "LOCAL_PRELIMINARY" | "UNAVAILABLE";
  label: string;
}

/** Keep lifetime and selected-period metrics separate and never fill a
 * selected-period unknown from a lifetime value. */
export function loyaltyMetricsForDisplay(
  record: LoyaltyRecord,
): LoyaltyDisplayMetrics {
  const period = record.periodMetrics;
  if (period && period.availability !== "UNAVAILABLE") {
    return {
      fixations: period.fixations,
      meetings: period.meetings,
      deals: period.deals,
      dealAmount: period.dealAmount,
      selectedPeriod: true,
      availability: period.availability,
      label:
        period.availability === "EXACT"
          ? "За выбранный период · точно"
          : "За выбранный период · предварительно",
    };
  }
  return {
    fixations: record.fixations,
    meetings: record.meetings,
    deals: record.deals,
    dealAmount: record.dealAmount,
    selectedPeriod: false,
    availability: "UNAVAILABLE",
    label:
      record.metricSource?.kind === "EXACT_ACTIVITIES"
        ? "За всё время · точно"
        : "Точные метрики недоступны",
  };
}

export interface LoyaltyListResponse {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  items: LoyaltyRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  selectionCount: number;
  filterHash: string;
  snapshotId: string | null;
  facets: LoyaltyFacets;
  dataAvailability: Record<string, unknown>;
}

export interface LoyaltyListFilters {
  page: number;
  pageSize: number;
  search?: string;
  archived?: "exclude" | "include" | "only";
  city?: string;
  hasAmo?: "" | "true" | "false";
  segment?: LoyaltySegment | "";
  sortBy?: LoyaltySortField;
  sortOrder?: "asc" | "desc";
  filter?: LoyaltyCanonicalFilter;
  columns?: LoyaltyColumnFilters;
}

export type ReconciliationDecision =
  | "LINK"
  | "KEEP_SEPARATE"
  | "REJECT_MATCH"
  | "UNLINK"
  | "";
export type ReconciliationDecisionAction = Exclude<ReconciliationDecision, "">;

export interface ReconciliationSide {
  id: string;
  entityType: string;
  name: string;
  phone: string;
  company: string;
  source: string;
}

export interface ReconciliationCase {
  id: string;
  version: number;
  status: string;
  matchReason: string;
  matchCodes: string[];
  score: number;
  anna: ReconciliationSide | null;
  ours: ReconciliationSide | null;
  decision: ReconciliationDecision | "";
}

export interface ReconciliationResponse {
  items: ReconciliationCase[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface UnmatchedAnnaRecord {
  id: string;
  entityType: string;
  name: string;
  city: string;
  hasValidPhone: boolean;
  phone: string;
}

export interface UnmatchedAnnaResponse {
  items: UnmatchedAnnaRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface UnmatchedCabinetEntity {
  id: string;
  entityType: string;
  name: string;
  phone: string;
  taxId: string;
  amoContactId: string;
}

export interface UnmatchedCabinetResponse {
  items: UnmatchedCabinetEntity[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface LoyaltyActiveLink {
  id: string;
  version: number;
  ownerType: string;
  ownerId: string;
  ownerName: string;
  targetType: string;
  targetId: string;
  targetName: string;
  reconciliationCaseId: string;
  decidedAt: string;
  ruleVersion: string;
  presentInActiveSnapshot: boolean;
}

export interface LoyaltyActiveLinksResponse {
  items: LoyaltyActiveLink[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ImportSummary {
  records: number;
  brokers: number;
  agencies: number;
  contactPoints: number;
  uniqueNormalizedPhones: number;
  externalIdentities: number;
  activities: number;
  organizationRoles: number;
  duplicateSourceKeys: number;
  invalidContactPoints: number;
  issueCount: number;
  candidateCount: number;
  ambiguousRecords: number;
  includedActivities: number | null;
  includedFixations: number | null;
  includedMeetings: number | null;
  includedDeals: number | null;
  includedBrokerTours: number | null;
  includedCalls: number | null;
  includedDealAmount: string | null;
  excludedActivities: number | null;
  unknownActivities: number | null;
  currentPublishedRecords: number | null;
  coverageDropRequiresConfirmation: boolean | null;
  coverageDropConfirmed: boolean | null;
  coverageDrops: Array<{
    dimension: string;
    current: number | string;
    staged: number | string;
  }>;
}

export interface ImportIssue {
  row: number | null;
  code: string;
}

export interface ImportStepResult {
  id: string;
  snapshotId: string;
  status: string;
  contentHash: string;
  publishable: boolean | null;
  expectedActiveSnapshotId: string | null;
  hasExpectedActiveSnapshotBinding: boolean;
  summary: ImportSummary;
  issues: ImportIssue[];
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};

const nonEmptyRecord = (value: unknown) => {
  const record = asRecord(value);
  return Object.keys(record).length ? record : null;
};

const pick = (record: UnknownRecord, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
};

const stringValue = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return fallback;
};

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nullableNumberValue = (value: unknown): number | null =>
  value === undefined || value === null || value === ""
    ? null
    : numberValue(value);

const decimalValue = (value: unknown, fallback = "0"): string => {
  const candidate =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  return /^\d+(?:\.\d+)?$/.test(candidate) ? candidate : fallback;
};

const nullableDecimalValue = (value: unknown): string | null =>
  value === undefined || value === null || value === ""
    ? null
    : decimalValue(value);

/** Format a non-negative Decimal string without converting it to JS Number. */
export function formatRubles(value: string | null): string {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return "—";
  const [integer, rawFraction = ""] = value.split(".");
  const fraction = rawFraction.padEnd(2, "0").slice(0, 2);
  const grouped = BigInt(integer).toLocaleString("ru-RU");
  return `${grouped}${fraction === "00" ? "" : `,${fraction}`} ₽`;
}

const booleanValue = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
};

const arrayValue = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const combinedArrays = (...values: unknown[]): unknown[] =>
  values.flatMap(arrayValue);

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.map((item) => stringValue(item)).filter(Boolean);
  const text = stringValue(value);
  return text
    ? text
        .split(/[;,\n]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
};

const uniqueTrimmedStrings = (value: unknown): string[] => {
  const seen = new Set<string>();
  return stringArray(value).flatMap((item) => {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
};

const latestDateValue = (...values: unknown[]): string => {
  let latest = "";
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const candidate = stringValue(value);
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (!Number.isFinite(timestamp) || timestamp <= latestTime) continue;
    latest = candidate;
    latestTime = timestamp;
  }
  return latest;
};

function responseRoot(value: unknown): UnknownRecord {
  const outer = asRecord(value);
  const nested = nonEmptyRecord(outer.data);
  if (!nested) return outer;
  const hasEnvelope = [
    "items",
    "results",
    "brokers",
    "agencies",
    "item",
    "overview",
    "metrics",
    "summary",
    "contentHash",
    "snapshotId",
  ].some((key) => nested[key] !== undefined);
  return hasEnvelope ? nested : outer;
}

function normalizeLeader(value: unknown): LoyaltyLeader | null {
  const firstValue = Array.isArray(value) ? value[0] : value;
  const item = asRecord(firstValue);
  const id = stringValue(
    pick(item, "id", "brokerId", "agencyId", "externalId"),
  );
  const name = stringValue(
    pick(item, "name", "displayName", "fullName", "title", "companyName"),
  );
  if (!id && !name) return null;
  return {
    id,
    name: name || "—",
    deals: numberValue(pick(item, "deals", "dealCount", "dealsCount", "count")),
    dealAmount: nullableDecimalValue(
      pick(item, "dealAmount", "dealAmountRub", "amount", "sales"),
    ),
  };
}

function normalizeMetricSource(value: unknown): LoyaltyMetricSource | null {
  const item = nonEmptyRecord(value);
  if (!item) return null;
  return {
    kind: stringValue(pick(item, "kind", "source")),
    label: stringValue(pick(item, "label", "sourceLabel")),
    quality: stringValue(item.quality),
    exactness: stringValue(item.exactness),
    ruleVersion: stringValue(item.ruleVersion),
    periodFilterApplied: booleanValue(item.periodFilterApplied),
    contributingRecords: nullableNumberValue(item.contributingRecords),
    sourceVersions: stringArray(item.sourceVersions),
  };
}

function normalizeKpiMetadata(
  value: unknown,
): Record<string, LoyaltyKpiMethodology> {
  const metadata = asRecord(value);
  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, raw]) => {
      const item = nonEmptyRecord(raw);
      if (!item) return [];
      return [
        [
          key,
          {
            source: stringValue(item.source),
            ruleVersion: stringValue(item.ruleVersion),
            exactness: stringValue(item.exactness),
            formula: stringValue(item.formula),
            includedSemantics: stringValue(item.includedSemantics),
            excludedSemantics: stringValue(item.excludedSemantics),
            periodFilterApplied: booleanValue(item.periodFilterApplied),
          } satisfies LoyaltyKpiMethodology,
        ],
      ];
    }),
  );
}

function normalizeSourceReportedGroup(
  value: unknown,
): LoyaltySourceReportedGroup {
  const item = asRecord(value);
  return {
    records: numberValue(item.records),
    fixations: nullableNumberValue(item.fixations),
    fixationKnownRecords: numberValue(item.fixationKnownRecords),
    meetings: nullableNumberValue(item.meetings),
    meetingKnownRecords: numberValue(item.meetingKnownRecords),
    deals: nullableNumberValue(item.deals),
    dealKnownRecords: numberValue(item.dealKnownRecords),
    brokerTours: nullableNumberValue(item.brokerTours),
    brokerTourKnownRecords: numberValue(item.brokerTourKnownRecords),
    calls: nullableNumberValue(item.calls),
    callKnownRecords: numberValue(item.callKnownRecords),
    dealAmount: nullableDecimalValue(item.dealAmount),
    dealAmountKnownRecords: numberValue(item.dealAmountKnownRecords),
    top: normalizeLeader(item.top),
  };
}

function normalizeSourceReportedSummary(
  value: unknown,
): LoyaltySourceReportedSummary | null {
  const item = nonEmptyRecord(value);
  if (!item) return null;
  const brokerRaw = asRecord(item.brokers);
  return {
    kind: stringValue(item.kind),
    label: stringValue(item.label),
    confirmationStatus: stringValue(item.confirmationStatus),
    quality: stringValue(item.quality),
    exactness: stringArray(item.exactness),
    sourceVersions: stringArray(item.sourceVersions),
    periodFilterApplied: booleanValue(item.periodFilterApplied),
    warning: stringValue(item.warning),
    brokers: {
      ...normalizeSourceReportedGroup(brokerRaw),
      notCalledCurrentMonth: nullableNumberValue(
        brokerRaw.notCalledCurrentMonth,
      ),
      notCalledKnownCount: numberValue(brokerRaw.notCalledKnownCount),
      newCount: nullableNumberValue(brokerRaw.newCount),
      btWithoutFixation: nullableNumberValue(brokerRaw.btWithoutFixation),
    },
    agencies: normalizeSourceReportedGroup(item.agencies),
  };
}

export function normalizeLoyaltyOverview(
  value: unknown,
  base: LoyaltyBaseKey,
): LoyaltyOverview {
  const root = responseRoot(value);
  const overview = nonEmptyRecord(root.overview) || root;
  const metrics =
    nonEmptyRecord(overview.metrics) || nonEmptyRecord(overview.kpis) || {};
  const brokers = nonEmptyRecord(overview.brokers) || {};
  const agencies = nonEmptyRecord(overview.agencies) || {};
  const activities = nonEmptyRecord(overview.activities) || {};
  const period = nonEmptyRecord(overview.period);
  const snapshotRaw = nonEmptyRecord(overview.snapshot);
  const metric = (...keys: string[]) => numberValue(pick(metrics, ...keys));
  const brokerMetric = (...keys: string[]) =>
    numberValue(pick(brokers, ...keys), metric(...keys));
  const nullableBrokerMetric = (...keys: string[]): number | null => {
    for (const source of [brokers, metrics]) {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        return source[key] === null ? null : numberValue(source[key]);
      }
    }
    return null;
  };

  return {
    base:
      stringValue(overview.base) === "ours"
        ? "ours"
        : stringValue(overview.base) === "anna"
          ? "anna"
          : base,
    snapshot: snapshotRaw
      ? {
          id: stringValue(pick(snapshotRaw, "id", "snapshotId")),
          status: stringValue(pick(snapshotRaw, "status", "state")),
          publishedAt: stringValue(
            pick(
              snapshotRaw,
              "publishedAt",
              "published_at",
              "updatedAt",
              "createdAt",
            ),
          ),
        }
      : null,
    brokersTotal: numberValue(
      pick(brokers, "total", "count", "brokersTotal"),
      numberValue(pick(overview, "brokersTotal")),
    ),
    agenciesTotal: numberValue(
      pick(agencies, "total", "count", "agenciesTotal"),
      numberValue(pick(overview, "agenciesTotal")),
    ),
    notCalledCurrentMonth: nullableBrokerMetric(
      "notCalledCurrentMonth",
      "notCalledThisMonth",
      "not_called_current_month",
      "notCalled",
    ),
    newBrokers: nullableBrokerMetric(
      "newBrokers",
      "newCount",
      "new_brokers",
      "new",
    ),
    btWithoutFixation: nullableBrokerMetric(
      "btWithoutFixation",
      "btAttendedNoFixation",
      "bt_no_fixation",
    ),
    birthdaysToday: nullableBrokerMetric(
      "birthdaysToday",
      "birthdayToday",
      "birthdays_today",
    ),
    birthdayKnownCount: brokerMetric(
      "birthdayKnownCount",
      "birthdaysKnownCount",
      "birthday_known_count",
    ),
    topBroker: normalizeLeader(
      pick(brokers, "top", "topBroker", "leader") ??
        pick(metrics, "topBroker", "top_broker"),
    ),
    topAgency: normalizeLeader(
      pick(agencies, "top", "topAgency", "leader") ??
        pick(metrics, "topAgency", "top_agency"),
    ),
    activities: {
      fixations: nullableNumberValue(
        pick(activities, "fixations", "fixationCount"),
      ),
      meetings: nullableNumberValue(
        pick(activities, "meetings", "meetingCount"),
      ),
      deals: nullableNumberValue(pick(activities, "deals", "dealCount")),
    },
    dealAmount: nullableDecimalValue(
      pick(overview, "dealAmount", "dealAmountRub", "amount"),
    ),
    period: period
      ? {
          from: stringValue(pick(period, "from", "dateFrom")),
          to: stringValue(pick(period, "to", "dateTo")),
        }
      : null,
    metricSource: normalizeMetricSource(
      pick(overview, "metricSource", "sourceMetadata"),
    ),
    kpiMetadata: normalizeKpiMetadata(
      pick(overview, "kpiMetadata", "methodology"),
    ),
    sourceReportedSummary: normalizeSourceReportedSummary(
      pick(overview, "sourceReportedSummary", "sourceRollups"),
    ),
  };
}

function normalizeContact(value: unknown) {
  const item = asRecord(value);
  const current = booleanValue(pick(item, "isCurrent", "actual"));
  const rawPoints = arrayValue(item.contactPoints).map(asRecord);
  const points = rawPoints
    .map((point) => ({
      id: stringValue(pick(point, "id", "externalId")),
      type: stringValue(point.type).toUpperCase(),
      label: stringValue(point.label),
      value: stringValue(pick(point, "value", "maskedValue")),
      isPrimary: booleanValue(point.isPrimary),
    }))
    .filter((point) => point.type && point.value);
  const fallbackValues = [
    ...stringArray(pick(item, "phones", "phoneNumbers")),
    stringValue(pick(item, "phone", "primaryPhone")),
  ]
    .filter(Boolean)
    .map((entry, index) => ({
      id: "",
      type: "PHONE",
      label: "",
      value: entry,
      isPrimary: index === 0,
    }))
    .concat(
      [
        ...stringArray(pick(item, "emails", "emailAddresses")),
        stringValue(pick(item, "email", "primaryEmail")),
      ]
        .filter(Boolean)
        .map((entry, index) => ({
          id: "",
          type: "EMAIL",
          label: "",
          value: entry,
          isPrimary: index === 0,
        })),
    );
  const seenPoints = new Set<string>();
  const contactPoints = [...points, ...fallbackValues].filter((point) => {
    const key = `${point.type}:${point.value.trim().toLocaleLowerCase("ru-RU")}`;
    if (seenPoints.has(key)) return false;
    seenPoints.add(key);
    return true;
  });
  const pointValue = (type: string) => {
    const point =
      contactPoints.find(
        (candidate) => candidate.type === type && candidate.isPrimary === true,
      ) || contactPoints.find((candidate) => candidate.type === type);
    return point?.value || "";
  };
  const rawStatus = stringValue(pick(item, "status", "actualityStatus"));
  const status =
    rawStatus === "CURRENT"
      ? "Актуален"
      : rawStatus === "FORMER"
        ? "Бывший сотрудник"
        : rawStatus === "UNKNOWN"
          ? "Неизвестно"
          : rawStatus;
  return {
    id: stringValue(pick(item, "id", "externalId")),
    name: stringValue(pick(item, "name", "displayName", "fullName")),
    role: stringValue(pick(item, "role", "position")),
    phone: stringValue(
      pick(item, "phone", "primaryPhone"),
      pointValue("PHONE"),
    ),
    email: stringValue(
      pick(item, "email", "primaryEmail"),
      pointValue("EMAIL"),
    ),
    status: stringValue(
      status,
      current === null ? "" : current ? "Актуален" : "Неактуален",
    ),
    contactPoints,
  };
}

function normalizeHistory(value: unknown) {
  if (Array.isArray(value)) {
    const label = stringValue(value[0], "Запись источника");
    const rawValue = stringValue(value[1]);
    const normalizedResult = stringValue(value[2]);
    const campaignMonth = stringValue(value[3]);
    return {
      id: "",
      type: "SOURCE_HISTORY",
      occurredAt: "",
      title: label,
      description: [
        rawValue && `Исходное значение: ${rawValue}`,
        normalizedResult && `Нормализованный результат: ${normalizedResult}`,
        campaignMonth && `Месяц кампании: ${campaignMonth}`,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  const item = asRecord(value);
  const title = stringValue(
    pick(
      item,
      "title",
      "normalizedResult",
      "result",
      "label",
      "name",
      "reasonCode",
      "verdict",
    ),
    "Запись источника",
  );
  const explicitDescription = stringValue(
    pick(item, "description", "comment", "note"),
  );
  const details = [
    stringValue(item.rawValue) &&
      `Исходное значение: ${stringValue(item.rawValue)}`,
    stringValue(item.normalizedResult) &&
    stringValue(item.normalizedResult) !== title
      ? `Нормализованный результат: ${stringValue(item.normalizedResult)}`
      : "",
    stringValue(item.campaignMonth) &&
      `Месяц кампании: ${stringValue(item.campaignMonth)}`,
    stringValue(item.campaign) && `Кампания: ${stringValue(item.campaign)}`,
    stringValue(item.employee) && `Сотрудник: ${stringValue(item.employee)}`,
    explicitDescription && `Комментарий: ${explicitDescription}`,
    stringValue(item.agreement) &&
      `Договорённость: ${stringValue(item.agreement)}`,
    stringValue(item.nextAt) &&
      `Следующий контакт: ${stringValue(item.nextAt)}`,
    stringValue(item.nextStep) &&
      `Следующий шаг: ${stringValue(item.nextStep)}`,
    stringValue(item.nextActionAt) &&
      `Следующее действие: ${stringValue(item.nextActionAt)}`,
    stringValue(item.correctionReason) &&
      `Причина исправления: ${stringValue(item.correctionReason)}`,
  ].filter(Boolean);
  const isCall = Boolean(
    stringValue(item.assignmentId) ||
    stringValue(item.resultCode) ||
    stringValue(item.nextStep) ||
    stringValue(item.nextActionAt),
  );
  const effective = booleanValue(item.effective);
  const superseded = booleanValue(item.superseded);
  return {
    id: stringValue(pick(item, "id", "externalId")),
    type: stringValue(
      pick(item, "type", "eventType", "kind"),
      isCall ? "CALL" : "SOURCE_HISTORY",
    ),
    occurredAt: stringValue(pick(item, "occurredAt", "date", "createdAt")),
    title,
    description: details.join(" · "),
    assignmentId: stringValue(item.assignmentId),
    campaignId: stringValue(item.campaignId),
    campaignName: stringValue(item.campaignName),
    employeeId: stringValue(item.employeeId),
    employeeName: stringValue(item.employeeName),
    result: stringValue(pick(item, "resultCode", "result")),
    comment: explicitDescription,
    nextStep: stringValue(item.nextStep),
    nextActionAt: stringValue(item.nextActionAt),
    correctionReason: stringValue(item.correctionReason),
    isCorrection: booleanValue(item.isCorrection) === true,
    effective: effective === null ? undefined : effective,
    superseded: superseded === null ? undefined : superseded,
  };
}

function safeAmoContactUrl(identities: UnknownRecord[]): string {
  const identity = identities.find(
    (candidate) =>
      stringValue(candidate.system).toUpperCase() === "AMOCRM" &&
      stringValue(candidate.entityType).toUpperCase() === "CONTACT" &&
      /^\d+$/.test(stringValue(candidate.externalId)),
  );
  if (!identity) return "";

  const externalId = stringValue(identity.externalId);
  const suppliedUrl = stringValue(identity.url);
  if (suppliedUrl) {
    try {
      const parsed = new URL(suppliedUrl);
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "stmichael.amocrm.ru" &&
        parsed.port === "" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        parsed.pathname === `/contacts/detail/${externalId}`
      )
        return parsed.toString();
    } catch {
      // Fall through to the canonical tenant URL derived from the numeric ID.
    }
  }
  return `https://stmichael.amocrm.ru/contacts/detail/${encodeURIComponent(externalId)}`;
}

function normalizeRecognition(value: unknown) {
  const item = asRecord(value);
  return {
    id: stringValue(item.id),
    date: stringValue(item.date),
    type: stringValue(item.type),
    note: stringValue(item.note),
    employee: stringValue(item.employee),
    amount: stringValue(item.amount),
    validUntil: stringValue(item.validUntil),
    hasAttachment: Boolean(stringValue(item.attachment)),
  };
}

function normalizeProvenance(value: unknown) {
  const item = asRecord(value);
  return {
    field: stringValue(pick(item, "field", "fieldName")),
    source: stringValue(pick(item, "source", "sourceName", "sourceSystem")),
    updatedAt: stringValue(
      pick(item, "updatedAt", "observedAt", "readAt", "createdAt"),
    ),
  };
}

export function normalizeLoyaltyRecord(
  value: unknown,
  entityType: LoyaltyEntityType,
): LoyaltyRecord {
  const item = asRecord(value);
  const metrics = nonEmptyRecord(item.metrics) || {};
  const activitySummary = nonEmptyRecord(item.activities) || {};
  const metricSourceRaw = nonEmptyRecord(item.metricSource);
  const sourceReportedRaw = nonEmptyRecord(item.sourceReportedMetrics);
  const periodMetricsRaw = nonEmptyRecord(
    pick(item, "periodMetrics", "activityPeriodMetrics", "filteredMetrics"),
  );
  const activityItems = arrayValue(item.activities);
  const attributes = nonEmptyRecord(item.attributes) || {};
  const attributeCrm = nonEmptyRecord(attributes.crm) || {};
  const crm = nonEmptyRecord(item.crm) || {};
  const phones = stringArray(pick(item, "phones", "phoneNumbers"));
  const emails = stringArray(pick(item, "emails", "emailAddresses"));
  const contactPoints = arrayValue(item.contactPoints).map(asRecord);
  const primaryPoint = (type: string) =>
    contactPoints.find(
      (point) =>
        stringValue(point.type).toUpperCase() === type &&
        booleanValue(point.isPrimary) === true,
    ) ||
    contactPoints.find(
      (point) => stringValue(point.type).toUpperCase() === type,
    );
  const phonePoint = primaryPoint("PHONE");
  const emailPoint = primaryPoint("EMAIL");
  const externalIdentities = arrayValue(item.externalIdentities).map(asRecord);
  const agencies = arrayValue(item.agencies).map(asRecord);
  const hasAmoRaw =
    pick(item, "hasAmo", "hasAmoCrm", "amoLinked") ??
    pick(crm, "linked", "found");
  const hasAmoIdentity =
    externalIdentities.length > 0
      ? externalIdentities.some(
          (identity) => stringValue(identity.system).toUpperCase() === "AMOCRM",
        )
      : null;
  const firstActivityAt = stringValue(
    pick(asRecord(activityItems[0]), "occurredAt", "date", "createdAt"),
  );
  const lastCallAt = stringValue(
    pick(
      activityItems
        .map(asRecord)
        .find(
          (activity) => stringValue(activity.type).toUpperCase() === "CALL",
        ) || {},
      "occurredAt",
      "date",
      "createdAt",
    ),
  );
  const normalizedContactPoints = contactPoints
    .map((point) => ({
      id: stringValue(pick(point, "id", "externalId")),
      type: stringValue(point.type).toUpperCase(),
      label: stringValue(point.label),
      value: stringValue(pick(point, "value", "maskedValue")),
      isPrimary: booleanValue(point.isPrimary),
    }))
    .filter((point) => point.value);
  const attributeCalls = arrayValue(attributes.calls);
  const sourceLastActivityAt = latestDateValue(
    sourceReportedRaw?.lastFixationAt,
    sourceReportedRaw?.lastMeetingAt,
    sourceReportedRaw?.lastDealAt,
    sourceReportedRaw?.lastCallAt,
    sourceReportedRaw?.brokerTourAt,
  );
  const annaDetails = {
    agencySize: stringValue(
      pick(item, "agencySize"),
      stringValue(attributes.agencySize),
    ),
    brokerCount: nullableNumberValue(
      pick(item, "brokerCount") ?? attributes.brokerCount,
    ),
    website: stringValue(
      pick(item, "website"),
      stringValue(attributes.website),
    ),
    projectsOnSite: stringValue(
      pick(item, "projectsOnSite"),
      stringValue(attributes.projectsOnSite),
    ),
    sitePlacementRequirements: stringValue(
      pick(attributes, "sitePlacementRequirements", "requirements"),
    ),
    lastAgencyMeetingDate: stringValue(
      pick(item, "lastAgencyMeetingDate", "lastMeetingAt"),
      stringValue(attributes.lastAgencyMeetingDate),
    ),
    agencyBtFormat: stringValue(
      pick(item, "agencyBtFormat", "brokerTourFormat"),
      stringValue(attributes.agencyBtFormat),
    ),
    agencyBtDate: stringValue(
      pick(item, "agencyBtDate", "brokerTourAt"),
      stringValue(
        pick(attributes, "agencyBtDate", "brokerTourAt", "outboundBtDate"),
        stringValue(sourceReportedRaw?.brokerTourAt),
      ),
    ),
    activeBrokers: nullableNumberValue(
      pick(item, "activeBrokers", "activeBrokerCount") ??
        pick(attributes, "activeBrokers", "activeBrokerCount"),
    ),
    lastContractDate: stringValue(
      pick(item, "lastContractDate", "lastAgreement"),
      stringValue(pick(attributes, "lastContractDate", "lastAgreement")),
    ),
    partnershipStatus: stringValue(
      pick(item, "partnershipStatus", "partnershipLevel"),
      stringValue(pick(attributes, "partnershipStatus", "partnershipLevel")),
    ),
    legalName: stringValue(
      pick(item, "legalName"),
      stringValue(attributes.legalName),
    ),
    nextAgreement: stringValue(
      pick(item, "nextAgreement"),
      stringValue(attributes.nextAgreement),
    ),
    specialTerms: stringValue(
      pick(item, "specialTerms"),
      stringValue(attributes.specialTerms),
    ),
    specialTermsStatus: stringValue(
      pick(item, "specialTermsStatus"),
      stringValue(attributes.specialTermsStatus),
    ),
    specialTermsValidUntil: stringValue(
      pick(item, "specialTermsValidUntil"),
      stringValue(attributes.specialTermsValidUntil),
    ),
    rating: nullableNumberValue(attributes.rating),
    crmSource: stringValue(attributes.crmSource),
    paymentControl: nullableNumberValue(attributes.paymentControl),
    successfulDeals: nullableNumberValue(attributes.successfulDeals),
    zorgeDeals: nullableNumberValue(attributes.zorgeDeals),
    berzarinaDeals: nullableNumberValue(attributes.berzarinaDeals),
    activeCrmCards: nullableNumberValue(attributes.activeCrmCards),
    crmScore: nullableNumberValue(attributes.crmScore),
    dealsWithAmount: nullableNumberValue(attributes.dealsWithAmount),
    verifiedDealIdsCount: Object.prototype.hasOwnProperty.call(
      attributes,
      "verifiedDealIds",
    )
      ? arrayValue(attributes.verifiedDealIds).length
      : null,
  };
  const hasAnnaDetails = Object.values(annaDetails).some(
    (detailValue) => detailValue !== null && detailValue !== "",
  );
  const legacyStatus = stringValue(
    pick(
      item,
      "computedStatus",
      "loyaltyStatus",
      "partnershipLevel",
      "status",
      "category",
    ),
    stringValue(
      pick(
        attributes,
        "computedStatus",
        "loyaltyStatus",
        "partnershipLevel",
        "status",
        "category",
      ),
      "",
    ),
  ).trim();
  const backendComputedStatuses = uniqueTrimmedStrings(item.computedStatuses);
  const computedStatuses = (
    backendComputedStatuses.length
      ? backendComputedStatuses
      : legacyStatus
        ? [legacyStatus]
        : []
  ) as LoyaltyComputedStatus[];

  return {
    id: stringValue(pick(item, "id", "externalId", "contactId", "uuid")),
    entityType,
    name: stringValue(
      pick(item, "name", "displayName", "fullName", "title", "legalName"),
      "Без названия",
    ),
    company: stringValue(
      pick(item, "company", "agencyName", "organization", "legalName"),
      stringValue(
        pick(agencies[0] || {}, "displayName", "name"),
        stringValue(
          pick(
            attributes,
            "company",
            "agencyName",
            "organization",
            "legalName",
          ),
        ),
      ),
    ),
    phone: stringValue(
      pick(item, "phone", "primaryPhone"),
      stringValue(
        pick(phonePoint || {}, "value", "maskedValue"),
        phones[0] || "",
      ),
    ),
    email: stringValue(
      pick(item, "email", "primaryEmail"),
      stringValue(
        pick(emailPoint || {}, "value", "maskedValue"),
        emails[0] || "",
      ),
    ),
    city: stringValue(
      pick(item, "city", "region", "geography"),
      stringValue(pick(attributes, "city", "region", "geography")),
    ),
    geography: stringValue(
      pick(item, "geography", "regionType"),
      stringValue(
        pick(attributes, "geography", "regionType"),
        booleanValue(item.isRegional) === true
          ? "REGION"
          : booleanValue(item.isRegional) === false
            ? "MOSCOW"
            : "",
      ),
    ),
    role: stringValue(
      pick(item, "role", "brokerRole", "position"),
      stringValue(
        pick(attributes, "role", "brokerRole", "position"),
        booleanValue(item.isCoordinator) === true ? "Координатор" : "",
      ),
    ),
    computedStatuses,
    status: computedStatuses[0] || legacyStatus,
    stage: stringValue(
      pick(
        item,
        "relationshipStage",
        "partnershipStage",
        "normalizedStage",
        "funnelStage",
        "stage",
      ),
      stringValue(
        pick(attributes, "relationshipStage", "partnershipStage", "stage"),
      ),
    ),
    assignee: stringValue(
      pick(item, "assigneeName", "assignedTo", "assignee", "responsibleName"),
      stringValue(
        pick(
          attributes,
          "assigneeName",
          "assignedTo",
          "assignee",
          "responsibleName",
        ),
        stringValue(
          pick(asRecord(item.assignee), "name", "fullName", "displayName"),
        ),
      ),
    ),
    dataQuality: stringValue(
      pick(item, "dataQuality", "qualityStatus", "verification"),
      stringValue(
        pick(attributes, "dataQuality", "qualityStatus", "verification"),
        stringArray(item.dataQualityCodes)[0] || "",
      ),
    ),
    hasAmo: hasAmoRaw !== undefined ? booleanValue(hasAmoRaw) : hasAmoIdentity,
    amoContactUrl: safeAmoContactUrl(externalIdentities),
    archived:
      Boolean(pick(item, "archivedAt")) ||
      booleanValue(pick(item, "archived", "isArchived")) === true,
    updatedAt: stringValue(pick(item, "updatedAt", "publishedAt", "createdAt")),
    fixations: nullableNumberValue(
      pick(item, "fixations", "fixationCount") ??
        pick(metrics, "fixations", "fixationCount") ??
        pick(activitySummary, "fixations"),
    ),
    meetings: nullableNumberValue(
      pick(item, "meetings", "meetingCount") ??
        pick(metrics, "meetings", "meetingCount") ??
        pick(activitySummary, "meetings"),
    ),
    deals: nullableNumberValue(
      pick(item, "deals", "dealCount") ??
        pick(metrics, "deals", "dealCount") ??
        pick(activitySummary, "deals"),
    ),
    dealAmount: nullableDecimalValue(
      pick(item, "dealAmount", "dealAmountRub", "sales", "amount") ??
        pick(metrics, "dealAmount", "dealAmountRub", "sales", "amount"),
    ),
    lastCallAt: stringValue(
      pick(item, "lastCallAt", "lastCallDate"),
      stringValue(
        pick(attributes, "lastCallAt", "lastCallDate"),
        stringValue(pick(sourceReportedRaw || {}, "lastCallAt"), lastCallAt),
      ),
    ),
    lastCallResult: stringValue(
      pick(item, "lastCallResult", "callResult"),
      stringValue(pick(attributes, "lastCallResult", "callResult")),
    ),
    lastActivityAt: stringValue(
      pick(item, "lastActivityAt", "lastActivityDate"),
      stringValue(
        pick(attributes, "lastActivityAt", "lastActivityDate"),
        firstActivityAt || sourceLastActivityAt,
      ),
    ),
    daysWithoutContact: nullableNumberValue(
      pick(item, "daysWithoutContact", "staleDays") ??
        pick(attributes, "daysWithoutContact", "staleDays"),
    ),
    nextTask: stringValue(
      pick(item, "nextTask", "nextStep", "nextAgreement"),
      stringValue(pick(attributes, "nextTask", "nextStep", "nextAgreement")),
    ),
    nextTaskAt: stringValue(
      pick(item, "nextTaskAt", "nextTaskDate", "nextStepAt"),
      stringValue(pick(attributes, "nextTaskAt", "nextTaskDate", "nextStepAt")),
    ),
    taskAssignee: stringValue(
      pick(item, "taskAssignee", "nextTaskAssignee"),
      stringValue(pick(attributes, "taskAssignee", "nextTaskAssignee")),
    ),
    birthday: stringValue(
      pick(item, "birthday", "birthDate"),
      stringValue(
        pick(attributes, "birthday", "birthDate"),
        stringValue(pick(attributeCrm, "birthday", "birthDate")),
      ),
    ),
    workFormat: stringValue(
      pick(item, "workFormat", "normalizedWorkFormat", "format"),
      stringValue(
        pick(attributes, "workFormat", "format"),
        booleanValue(item.isCoordinator) === true ? "Координатор" : "",
      ),
    ),
    specialization: stringArray(
      pick(
        item,
        "specializations",
        "normalizedSpecializations",
        "specialization",
      ) ?? pick(attributes, "specializations", "specialization"),
    ).join(", "),
    sourceIds: stringArray(
      pick(item, "sourceIds", "crmIds", "externalIds"),
    ).concat(
      externalIdentities
        .map((identity) =>
          [stringValue(identity.system), stringValue(identity.externalId)]
            .filter(Boolean)
            .join(":"),
        )
        .filter(Boolean),
    ),
    aliases: stringArray(
      pick(item, "aliases") ??
        pick(attributes, "aliases") ??
        pick(attributeCrm, "names", "aliases"),
    ),
    memberships: stringArray(
      pick(item, "memberships", "sources") ??
        pick(attributes, "memberships", "sources"),
    ),
    agencies: agencies.map((agency) => ({
      id: stringValue(pick(agency, "id", "externalId", "uuid")),
      name: stringValue(pick(agency, "displayName", "name", "legalName")),
      role: stringValue(pick(agency, "role", "brokerRole", "position")),
      isPrimary: booleanValue(pick(agency, "isPrimary", "primary")),
    })),
    comment: stringValue(
      pick(item, "comment", "note"),
      stringValue(pick(attributes, "comment", "note")),
    ),
    contactPoints: normalizedContactPoints,
    contacts: (entityType === "agencies" &&
    arrayValue(item.agencyContactPeople).length
      ? arrayValue(item.agencyContactPeople)
      : combinedArrays(
          pick(attributes, "contacts", "contactPersons", "agencyContacts"),
          pick(item, "contacts", "contactPersons", "agencyContacts"),
          entityType === "agencies" ? item.brokers : undefined,
        )
    ).map(normalizeContact),
    history: combinedArrays(
      activityItems,
      pick(attributes, "history", "sourceHistory", "callHistory"),
      attributeCalls.length ? attributeCalls : sourceReportedRaw?.callBreakdown,
    ).map(normalizeHistory),
    recognitions: arrayValue(attributes.recognitions).map(normalizeRecognition),
    annaDetails: hasAnnaDetails ? annaDetails : null,
    provenance: arrayValue(
      pick(item, "provenance", "fieldSources", "sources"),
    ).map(normalizeProvenance),
    metricSource: metricSourceRaw
      ? {
          kind: stringValue(metricSourceRaw.kind),
          label: stringValue(metricSourceRaw.label),
          exactness: stringValue(metricSourceRaw.exactness),
          quality: stringValue(metricSourceRaw.quality),
          periodFilterApplied: booleanValue(
            metricSourceRaw.periodFilterApplied,
          ),
        }
      : null,
    sourceReportedMetrics: sourceReportedRaw
      ? {
          fixations: nullableNumberValue(sourceReportedRaw.fixations),
          meetings: nullableNumberValue(sourceReportedRaw.meetings),
          deals: nullableNumberValue(sourceReportedRaw.deals),
          brokerTours: nullableNumberValue(sourceReportedRaw.brokerTours),
          calls: nullableNumberValue(sourceReportedRaw.calls),
          dealAmount: nullableDecimalValue(sourceReportedRaw.dealAmount),
          sourceLabel: stringValue(sourceReportedRaw.sourceLabel),
          quality: stringValue(sourceReportedRaw.quality),
          exactness: stringValue(sourceReportedRaw.exactness),
          lastFixationAt: stringValue(sourceReportedRaw.lastFixationAt),
          lastMeetingAt: stringValue(sourceReportedRaw.lastMeetingAt),
          lastDealAt: stringValue(sourceReportedRaw.lastDealAt),
          lastCallAt: stringValue(sourceReportedRaw.lastCallAt),
          brokerTourVisited: booleanValue(sourceReportedRaw.brokerTourVisited),
          brokerTourAt: stringValue(sourceReportedRaw.brokerTourAt),
          dealsByMonth: Object.fromEntries(
            Object.entries(asRecord(sourceReportedRaw.dealsByMonth)).flatMap(
              ([month, count]) => {
                const numeric = nullableNumberValue(count);
                return numeric === null ? [] : [[month, numeric]];
              },
            ),
          ),
        }
      : null,
    periodMetrics: periodMetricsRaw
      ? {
          period: (() => {
            const raw = nonEmptyRecord(periodMetricsRaw.period);
            const from = stringValue(raw?.from);
            const to = stringValue(raw?.to);
            return from && to ? { from, to } : null;
          })(),
          availability:
            stringValue(periodMetricsRaw.availability) === "EXACT"
              ? "EXACT"
              : stringValue(periodMetricsRaw.availability) ===
                  "LOCAL_PRELIMINARY"
                ? "LOCAL_PRELIMINARY"
                : "UNAVAILABLE",
          fixations: nullableNumberValue(periodMetricsRaw.fixations),
          meetings: nullableNumberValue(periodMetricsRaw.meetings),
          deals: nullableNumberValue(periodMetricsRaw.deals),
          dealAmount: nullableDecimalValue(periodMetricsRaw.dealAmount),
          lastFixationAt: stringValue(periodMetricsRaw.lastFixationAt),
          lastMeetingAt: stringValue(periodMetricsRaw.lastMeetingAt),
          lastDealAt: stringValue(periodMetricsRaw.lastDealAt),
        }
      : null,
  };
}

export function normalizeLoyaltyList(
  value: unknown,
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
  fallbackPage: number,
  fallbackPageSize: number,
): LoyaltyListResponse {
  const root = responseRoot(value);
  const nestedData = Array.isArray(root.data) ? root.data : null;
  const candidates = pick(root, "items", "results", entityType);
  const items = arrayValue(candidates ?? nestedData);
  const pagination =
    nonEmptyRecord(root.pagination) || nonEmptyRecord(root.meta) || {};
  const page = numberValue(
    pick(root, "page") ?? pick(pagination, "page", "currentPage"),
    fallbackPage,
  );
  const pageSize = numberValue(
    pick(root, "pageSize", "limit") ??
      pick(pagination, "pageSize", "limit", "perPage"),
    fallbackPageSize,
  );
  const total = numberValue(
    pick(root, "total", "totalCount") ??
      pick(pagination, "total", "totalCount"),
    items.length,
  );
  const totalPages = numberValue(
    pick(root, "totalPages") ?? pick(pagination, "totalPages", "pages"),
    Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
  );
  const rawFacets = asRecord(root.facets);
  const facet = (key: string): LoyaltyFacetValue[] =>
    arrayValue(rawFacets[key])
      .map((raw) => {
        const item = asRecord(raw);
        return {
          value: stringValue(pick(item, "value", "id", "label")),
          matches: numberValue(pick(item, "matches", "count")),
        };
      })
      .filter((item) => item.value);
  return {
    base:
      stringValue(root.base) === "ours"
        ? "ours"
        : stringValue(root.base) === "anna"
          ? "anna"
          : base,
    entityType: ["agencies", "AGENCY"].includes(stringValue(root.entityType))
      ? "agencies"
      : ["brokers", "BROKER"].includes(stringValue(root.entityType))
        ? "brokers"
        : entityType,
    items: items.map((item) => normalizeLoyaltyRecord(item, entityType)),
    page,
    pageSize,
    total,
    totalPages,
    selectionCount: numberValue(root.selectionCount, total),
    filterHash: stringValue(root.filterHash),
    snapshotId:
      root.snapshotId === null || root.snapshotId === undefined
        ? null
        : stringValue(root.snapshotId) || null,
    facets: {
      cities: facet("cities"),
      assignees: facet("assignees"),
      specializations: facet("specializations"),
      stages: facet("stages"),
      statuses: facet("statuses"),
      dataQuality: facet("dataQuality"),
      agencySizes: facet("agencySizes"),
    },
    dataAvailability: asRecord(root.dataAvailability),
  };
}

export function normalizeLoyaltyDetail(
  value: unknown,
  entityType: LoyaltyEntityType,
): LoyaltyRecord {
  const root = responseRoot(value);
  const item =
    pick(root, "item", entityType === "brokers" ? "broker" : "agency") ?? root;
  return normalizeLoyaltyRecord(item, entityType);
}

function normalizeReconciliationSide(
  value: unknown,
): ReconciliationSide | null {
  const side = nonEmptyRecord(value);
  if (!side) return null;
  const contacts = arrayValue(side.contacts).map(asRecord);
  const contact =
    contacts.find((item) => stringValue(item.type).toUpperCase() === "PHONE") ||
    contacts[0] ||
    {};
  return {
    id: stringValue(pick(side, "id", "externalId")),
    entityType: stringValue(pick(side, "entityType", "type")),
    name: stringValue(
      pick(side, "name", "displayName", "fullName", "title"),
      "—",
    ),
    phone: stringValue(
      pick(side, "phone", "primaryPhone", "contact"),
      stringValue(pick(contact, "maskedValue", "value")),
    ),
    company: stringValue(pick(side, "company", "agencyName", "organization")),
    source: stringValue(pick(side, "source", "base")),
  };
}

function normalizeReconciliationCase(value: unknown): ReconciliationCase {
  const item = asRecord(value);
  const decision = stringValue(
    pick(item, "decision", "resolution"),
  ).toUpperCase();
  return {
    id: stringValue(pick(item, "id", "caseId")),
    version: numberValue(pick(item, "version", "rowVersion")),
    status: stringValue(pick(item, "status", "state")),
    matchReason: stringValue(pick(item, "matchReason", "reason", "reasonCode")),
    matchCodes: stringArray(pick(item, "matchCodes", "reasonCodes", "matches")),
    score: numberValue(pick(item, "score", "confidence")),
    anna: normalizeReconciliationSide(
      pick(item, "anna", "annaRecord", "source"),
    ),
    ours: normalizeReconciliationSide(
      pick(item, "ours", "ourRecord", "target"),
    ),
    decision: ["LINK", "KEEP_SEPARATE", "REJECT_MATCH", "UNLINK"].includes(
      decision,
    )
      ? (decision as ReconciliationDecision)
      : "",
  };
}

export function normalizeReconciliation(
  value: unknown,
  fallbackPage: number,
  fallbackPageSize: number,
): ReconciliationResponse {
  const root = responseRoot(value);
  const items = arrayValue(
    pick(root, "items", "cases", "results") ??
      (Array.isArray(root.data) ? root.data : []),
  );
  const pagination =
    nonEmptyRecord(root.pagination) || nonEmptyRecord(root.meta) || {};
  const page = numberValue(
    pick(root, "page") ?? pick(pagination, "page"),
    fallbackPage,
  );
  const pageSize = numberValue(
    pick(root, "pageSize", "limit") ?? pick(pagination, "pageSize", "limit"),
    fallbackPageSize,
  );
  const total = numberValue(
    pick(root, "total") ?? pick(pagination, "total"),
    items.length,
  );
  return {
    items: items.map(normalizeReconciliationCase),
    page,
    pageSize,
    total,
    totalPages: numberValue(
      pick(root, "totalPages") ?? pick(pagination, "totalPages"),
      Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
    ),
  };
}

function normalizeActiveLink(value: unknown): LoyaltyActiveLink {
  const item = asRecord(value);
  return {
    id: stringValue(pick(item, "id", "linkId")),
    version: numberValue(pick(item, "version", "rowVersion")),
    ownerType: stringValue(pick(item, "ownerType", "sourceType")),
    ownerId: stringValue(pick(item, "ownerId", "sourceId")),
    ownerName: stringValue(
      pick(item, "ownerName", "sourceName", "displayName"),
      "Нет в активном снимке",
    ),
    targetType: stringValue(pick(item, "targetType")),
    targetId: stringValue(pick(item, "targetId")),
    targetName: stringValue(pick(item, "targetName"), "Удалено из нашей базы"),
    reconciliationCaseId: stringValue(
      pick(item, "reconciliationCaseId", "caseId"),
    ),
    decidedAt: stringValue(pick(item, "decidedAt", "createdAt")),
    ruleVersion: stringValue(pick(item, "ruleVersion")),
    presentInActiveSnapshot:
      booleanValue(pick(item, "presentInActiveSnapshot")) === true,
  };
}

export function normalizeActiveLinks(
  value: unknown,
  fallbackPage: number,
  fallbackPageSize: number,
): LoyaltyActiveLinksResponse {
  const root = responseRoot(value);
  const items = arrayValue(
    pick(root, "items", "links", "results") ??
      (Array.isArray(root.data) ? root.data : []),
  );
  const pagination =
    nonEmptyRecord(root.pagination) || nonEmptyRecord(root.meta) || {};
  const page = numberValue(
    pick(root, "page") ?? pick(pagination, "page"),
    fallbackPage,
  );
  const pageSize = numberValue(
    pick(root, "pageSize", "limit") ?? pick(pagination, "pageSize", "limit"),
    fallbackPageSize,
  );
  const total = numberValue(
    pick(root, "total") ?? pick(pagination, "total"),
    items.length,
  );
  return {
    items: items.map(normalizeActiveLink),
    page,
    pageSize,
    total,
    totalPages: numberValue(
      pick(root, "totalPages") ?? pick(pagination, "totalPages"),
      total === 0 ? 0 : Math.ceil(total / Math.max(1, pageSize)),
    ),
  };
}

function normalizeUnmatchedAnna(value: unknown): UnmatchedAnnaRecord {
  const item = asRecord(value);
  const contacts = arrayValue(item.contacts).map(asRecord);
  const phone =
    contacts.find(
      (entry) => stringValue(entry.type).toUpperCase() === "PHONE",
    ) ||
    contacts[0] ||
    {};
  return {
    id: stringValue(pick(item, "id")),
    entityType: stringValue(pick(item, "entityType", "type")),
    name: stringValue(pick(item, "displayName", "name"), "—"),
    city: stringValue(pick(item, "city")),
    hasValidPhone: booleanValue(pick(item, "hasValidPhone")) === true,
    phone: stringValue(pick(phone, "maskedValue", "value")),
  };
}

export function normalizeUnmatchedAnnaResponse(
  value: unknown,
  fallbackPage: number,
  fallbackPageSize: number,
): UnmatchedAnnaResponse {
  const root = responseRoot(value);
  const items = arrayValue(
    pick(root, "items", "results") ??
      (Array.isArray(root.data) ? root.data : []),
  );
  const page = numberValue(pick(root, "page"), fallbackPage);
  const pageSize = numberValue(
    pick(root, "pageSize", "limit"),
    fallbackPageSize,
  );
  const total = numberValue(pick(root, "total"), items.length);
  return {
    items: items.map(normalizeUnmatchedAnna),
    page,
    pageSize,
    total,
    totalPages: numberValue(
      pick(root, "totalPages"),
      total === 0 ? 0 : Math.ceil(total / Math.max(1, pageSize)),
    ),
  };
}

function normalizeUnmatchedCabinet(value: unknown): UnmatchedCabinetEntity {
  const item = asRecord(value);
  return {
    id: stringValue(pick(item, "id")),
    entityType: stringValue(pick(item, "entityType", "type")),
    name: stringValue(pick(item, "displayName", "name"), "—"),
    phone: stringValue(pick(item, "contact", "phone")),
    taxId: stringValue(pick(item, "taxId", "inn")),
    amoContactId: stringValue(pick(item, "amoContactId")),
  };
}

export function normalizeUnmatchedCabinetResponse(
  value: unknown,
  fallbackPage: number,
  fallbackPageSize: number,
): UnmatchedCabinetResponse {
  const root = responseRoot(value);
  const items = arrayValue(
    pick(root, "items", "results") ??
      (Array.isArray(root.data) ? root.data : []),
  );
  const page = numberValue(pick(root, "page"), fallbackPage);
  const pageSize = numberValue(
    pick(root, "pageSize", "limit"),
    fallbackPageSize,
  );
  const total = numberValue(pick(root, "total"), items.length);
  return {
    items: items.map(normalizeUnmatchedCabinet),
    page,
    pageSize,
    total,
    totalPages: numberValue(
      pick(root, "totalPages"),
      total === 0 ? 0 : Math.ceil(total / Math.max(1, pageSize)),
    ),
  };
}

function normalizeImportSummary(value: unknown): ImportSummary {
  const summary = asRecord(value);
  const nullableCount = (key: string) =>
    Object.prototype.hasOwnProperty.call(summary, key)
      ? summary[key] === null
        ? null
        : numberValue(summary[key])
      : null;
  return {
    records: numberValue(pick(summary, "records")),
    brokers: numberValue(pick(summary, "brokers")),
    agencies: numberValue(pick(summary, "agencies")),
    contactPoints: numberValue(pick(summary, "contactPoints")),
    uniqueNormalizedPhones: numberValue(
      pick(summary, "uniqueNormalizedPhones"),
    ),
    externalIdentities: numberValue(pick(summary, "externalIdentities")),
    activities: numberValue(pick(summary, "activities")),
    organizationRoles: numberValue(pick(summary, "organizationRoles")),
    duplicateSourceKeys: numberValue(pick(summary, "duplicateSourceKeys")),
    invalidContactPoints: numberValue(pick(summary, "invalidContactPoints")),
    issueCount: numberValue(pick(summary, "issueCount")),
    candidateCount: numberValue(pick(summary, "candidateCount")),
    ambiguousRecords: numberValue(pick(summary, "ambiguousRecords")),
    includedActivities: nullableCount("includedActivities"),
    includedFixations: nullableCount("includedFixations"),
    includedMeetings: nullableCount("includedMeetings"),
    includedDeals: nullableCount("includedDeals"),
    includedBrokerTours: nullableCount("includedBrokerTours"),
    includedCalls: nullableCount("includedCalls"),
    includedDealAmount: Object.prototype.hasOwnProperty.call(
      summary,
      "includedDealAmount",
    )
      ? stringValue(summary.includedDealAmount)
      : null,
    excludedActivities: nullableCount("excludedActivities"),
    unknownActivities: nullableCount("unknownActivities"),
    currentPublishedRecords: nullableCount("currentPublishedRecords"),
    coverageDropRequiresConfirmation: Object.prototype.hasOwnProperty.call(
      summary,
      "coverageDropRequiresConfirmation",
    )
      ? booleanValue(summary.coverageDropRequiresConfirmation)
      : null,
    coverageDropConfirmed: Object.prototype.hasOwnProperty.call(
      summary,
      "coverageDropConfirmed",
    )
      ? booleanValue(summary.coverageDropConfirmed)
      : null,
    coverageDrops: arrayValue(summary.coverageDrops)
      .map((value) => {
        const drop = asRecord(value);
        const exactValue = (item: unknown): number | string =>
          typeof item === "number" || typeof item === "string"
            ? item
            : numberValue(item);
        return {
          dimension: stringValue(drop.dimension),
          current: exactValue(drop.current),
          staged: exactValue(drop.staged),
        };
      })
      .filter((drop) => Boolean(drop.dimension)),
  };
}

export function normalizeImportResult(value: unknown): ImportStepResult {
  const root = responseRoot(value);
  const result = nonEmptyRecord(root.result) || root;
  return {
    id: stringValue(pick(result, "id", "dryRunId", "stageId", "jobId")),
    snapshotId: stringValue(pick(result, "snapshotId", "snapshot_id")),
    status: stringValue(pick(result, "status", "state")),
    contentHash: stringValue(
      pick(result, "contentHash", "content_hash", "hash"),
    ),
    publishable:
      pick(result, "publishable") === undefined
        ? null
        : booleanValue(pick(result, "publishable")),
    expectedActiveSnapshotId:
      result.expectedActiveSnapshotId === null
        ? null
        : stringValue(result.expectedActiveSnapshotId) || null,
    hasExpectedActiveSnapshotBinding: Object.prototype.hasOwnProperty.call(
      result,
      "expectedActiveSnapshotId",
    ),
    summary: normalizeImportSummary(pick(result, "summary", "counts")),
    issues: arrayValue(pick(result, "issues", "warnings", "errors"))
      .map((item): ImportIssue => {
        const record = asRecord(item);
        const rowValue = pick(record, "row", "rowNumber");
        return {
          row: rowValue === undefined ? null : numberValue(rowValue),
          code: stringValue(
            pick(record, "code", "message", "reason"),
            stringValue(item),
          ),
        };
      })
      .filter((issue) => Boolean(issue.code)),
  };
}

const queryString = (entries: object) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
};

export async function getLoyaltyOverview(
  base: LoyaltyBaseKey,
  range?: { from: string; to: string },
) {
  const value = await apiGet<unknown>(
    `/loyalty-base/${base}/overview${queryString(range || {})}`,
  );
  return normalizeLoyaltyOverview(value, base);
}

export async function getLoyaltyList(
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
  filters: LoyaltyListFilters,
) {
  const search = filters.search?.trim() || "";
  const hasAmoValue =
    filters.hasAmo === "" || filters.hasAmo === undefined
      ? undefined
      : filters.hasAmo === "true";
  // Search text and the full canonical filter live in the POST body so names,
  // phones and emails never leak into proxy/access-log URLs.
  const value = await apiPost<unknown>(
    `/loyalty-base/${base}/${entityType}/search`,
    {
      search,
      page: filters.page,
      pageSize: filters.pageSize,
      archived: filters.archived,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      city: filters.city || undefined,
      hasAmo: hasAmoValue,
      segment: filters.segment || undefined,
      filter: filters.filter || {},
      columns: filters.columns,
    },
  );
  return normalizeLoyaltyList(
    value,
    base,
    entityType,
    filters.page,
    filters.pageSize,
  );
}

export async function exportLoyaltyList(
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
  request: Omit<LoyaltyListRequest, "page" | "pageSize">,
) {
  return apiDownload(`/loyalty-base/${base}/${entityType}/export`, request);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function getLoyaltyDetail(
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
  id: string,
) {
  const value = await apiGet<unknown>(
    `/loyalty-base/${base}/${entityType}/${encodeURIComponent(id)}`,
  );
  return normalizeLoyaltyDetail(value, entityType);
}

export async function updateAnnaLoyaltyRecord(
  entityType: LoyaltyEntityType,
  id: string,
  body: {
    expectedUpdatedAt: string;
    displayName?: string;
    city?: string;
    attributes?: Record<string, unknown>;
    archived?: boolean;
  },
) {
  const value = await apiPatch<unknown>(
    `/loyalty-base/anna/${entityType}/${encodeURIComponent(id)}`,
    body,
  );
  return normalizeLoyaltyDetail(value, entityType);
}

export interface LoyaltyChangeEntry {
  id: string;
  action: string;
  actor: string;
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export async function getAnnaLoyaltyChanges(
  entityType: LoyaltyEntityType,
  id: string,
) {
  const value = asRecord(
    await apiGet<unknown>(
      `/loyalty-base/anna/${entityType}/${encodeURIComponent(id)}/changes?page=1&pageSize=100`,
    ),
  );
  return arrayValue(value.items ?? value.data).map(
    (raw): LoyaltyChangeEntry => {
      const item = asRecord(raw);
      return {
        id: stringValue(item.id),
        action: stringValue(item.action),
        actor: stringValue(item.actorName ?? item.actorId),
        occurredAt: stringValue(item.occurredAt ?? item.createdAt),
        before: nonEmptyRecord(item.before),
        after: nonEmptyRecord(item.after),
      };
    },
  );
}

export async function getReconciliationCases(filters: {
  page: number;
  pageSize: number;
  status?: string;
  search?: string;
}) {
  const { search = "", ...nonSensitiveFilters } = filters;
  const value = search
    ? await apiPost<unknown>("/loyalty-base/reconciliation/search", {
        search,
        page: filters.page,
        pageSize: filters.pageSize,
        status: filters.status || undefined,
      })
    : await apiGet<unknown>(
        `/loyalty-base/reconciliation${queryString(nonSensitiveFilters)}`,
      );
  return normalizeReconciliation(value, filters.page, filters.pageSize);
}

export async function decideReconciliationCase(
  caseId: string,
  decision: ReconciliationDecisionAction,
  expectedVersion: number,
) {
  return apiPost<unknown>("/loyalty-base/reconciliation", {
    caseId,
    decision,
    expectedVersion,
  });
}

export async function getActiveLoyaltyLinks(filters: {
  page: number;
  pageSize: number;
  entityType?: "BROKER" | "AGENCY" | "";
}) {
  const value = await apiGet<unknown>(
    `/loyalty-base/reconciliation/links${queryString(filters)}`,
  );
  return normalizeActiveLinks(value, filters.page, filters.pageSize);
}

export async function unlinkActiveLoyaltyLink(
  linkId: string,
  expectedVersion: number,
) {
  return apiPost<unknown>("/loyalty-base/reconciliation/links/unlink", {
    linkId,
    expectedVersion,
  });
}

export async function getUnmatchedAnnaRecords(filters: {
  page: number;
  pageSize: number;
  entityType?: "BROKER" | "AGENCY" | "";
}) {
  const value = await apiGet<unknown>(
    `/loyalty-base/reconciliation/anna-only${queryString(filters)}`,
  );
  return normalizeUnmatchedAnnaResponse(value, filters.page, filters.pageSize);
}

export async function getUnmatchedCabinetEntities(filters: {
  page: number;
  pageSize: number;
  entityType?: "BROKER" | "AGENCY" | "";
}) {
  const value = await apiGet<unknown>(
    `/loyalty-base/reconciliation/cabinet-only${queryString(filters)}`,
  );
  return normalizeUnmatchedCabinetResponse(
    value,
    filters.page,
    filters.pageSize,
  );
}

export async function dryRunAnnaImport(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return normalizeImportResult(
    await apiUpload<unknown>("/loyalty-base/anna/import/dry-run", formData),
  );
}

export async function stageAnnaImport(
  file: File,
  expectedContentHash: string,
  expectedActiveSnapshotId: string | null,
  confirmCoverageDrop = false,
) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("expectedContentHash", expectedContentHash);
  formData.append("expectedActiveSnapshotId", expectedActiveSnapshotId ?? "");
  if (confirmCoverageDrop) formData.append("confirmCoverageDrop", "true");
  return normalizeImportResult(
    await apiUpload<unknown>("/loyalty-base/anna/import/stage", formData),
  );
}

export async function publishAnnaImport(
  snapshotId: string,
  expectedContentHash: string,
  expectedActiveSnapshotId: string | null,
  confirmCoverageDrop = false,
) {
  return normalizeImportResult(
    await apiPost<unknown>(
      `/loyalty-base/anna/import/${encodeURIComponent(snapshotId)}/publish`,
      {
        expectedContentHash,
        expectedActiveSnapshotId,
        ...(confirmCoverageDrop ? { confirmCoverageDrop: true } : {}),
        confirmed: true,
      },
    ),
  );
}
