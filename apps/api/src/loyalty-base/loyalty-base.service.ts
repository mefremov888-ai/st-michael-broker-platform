import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { Readable } from "stream";
import { Prisma, PrismaClient } from "@st-michael/database";
import {
  LoyaltyCanonicalFilterDto,
  LoyaltyChangesQueryDto,
  LoyaltyEntityUpdateDto,
  LoyaltyExportDto,
  LoyaltyImportDto,
  LoyaltyImportRecordDto,
  LoyaltyLinkUnlinkDto,
  LoyaltyListQueryDto,
  LoyaltyOverviewQueryDto,
  LoyaltyPublishDto,
  LoyaltyReconciliationDecisionDto,
  LoyaltyReconciliationQueryDto,
  LoyaltySearchDto,
} from "./loyalty-base.dto";
import { withLoyaltyFullScanSlot } from "./loyalty-full-scan-coordinator";
import { buildPhoneSearchConditions } from "../admin/brokers-import.helper";

export {
  LOYALTY_FULL_SCAN_RETRY_AFTER_SECONDS,
  LoyaltyFullScanBusyException,
  MAX_CONCURRENT_LOYALTY_FULL_SCANS,
} from "./loyalty-full-scan-coordinator";

const ANNA_DATASET_CODE = "ANNA";
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_LOYALTY_CLI_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_ISSUES_RETURNED = 200;
const MAX_POSTGRES_BIGINT = 9223372036854775807n;
const MAX_DECIMAL_18_2_CENTS = 999999999999999999n;
const CANDIDATE_QUERY_BATCH_SIZE = 500;
export const MAX_LOYALTY_EXPORT_ROWS = 50000;
const OUR_ACTIVITY_EVIDENCE_LIMIT = 200;

const REQUIRED_ACTIVITY_COVERAGE_TYPES = [
  "FIXATION",
  "MEETING",
  "DEAL",
  "BROKER_TOUR",
  "CALL",
] as const;

type EntityType = "BROKER" | "AGENCY";
type BaseSlug = "anna" | "ours";

interface LoyaltyFilterPeriod {
  from: Date;
  to: Date;
  fromIso: string;
  toIso: string;
}

interface CanonicalLoyaltyFilter {
  archived: "exclude" | "include" | "only";
  includeLowSignal: boolean;
  city?: string;
  hasAmo?: boolean;
  activityType?: string;
  segment?: string;
  callPeriod?: LoyaltyFilterPeriod;
  activityPeriod?: LoyaltyFilterPeriod;
  campaignIds: string[];
  lastCallResults: string[];
  scenario?: string;
  assigneeIds: string[];
  unassigned?: boolean;
  specializations: string[];
  geography: string[];
  workFormats: string[];
  relationshipStages: string[];
  brokerStatuses: string[];
  dataQuality: string[];
  dealCount: { min?: number; max?: number };
  dealsInPeriod?: boolean;
  called?: boolean;
  bt?: boolean;
  meetings: { min?: number; max?: number };
  partnershipStatuses: string[];
  agencySizes: string[];
  websitePresent?: boolean;
  projectsOnSite: string[];
  individualTerms?: boolean;
  specialTermsProposed?: boolean;
  rewardPresent?: boolean;
  staleDays?: number;
  doNotCall?: "exclude" | "only";
  columns: {
    contact?: string;
    statusStage?: string;
    activity?: string;
    calls?: string;
    assignee?: string;
    deals?: string;
  };
  sortBy: string;
  sortOrder: "asc" | "desc";
}

interface LoyaltyCallView {
  type?: "CALL";
  id?: string | null;
  assignmentId?: string | null;
  date?: string | null;
  occurredAt?: string | null;
  period?: string | null;
  campaign?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  employee?: string | null;
  employeeId?: string | null;
  employeeName?: string | null;
  result?: string | null;
  resultCode?: string | null;
  agreement?: string | null;
  comment?: string | null;
  nextStep?: string | null;
  nextActionAt?: string | null;
  source?: string | null;
  correctsAttemptId?: string | null;
  correctionReason?: string | null;
  isCorrection?: boolean;
  effective?: boolean;
  superseded?: boolean;
  correctedAt?: string | null;
}

interface LoyaltyWorkflowCallReadModel {
  effective: LoyaltyCallView[];
  history: LoyaltyCallView[];
}

interface LoyaltyEngagementView {
  id: string;
  type: string;
  occurredAt: string | null;
  comment: string | null;
  amount: string | null;
  value: string | null;
  validUntil: string | null;
  attachmentUrl: string | null;
  basisUrl: string | null;
  createdById: string | null;
  createdByName: string | null;
  correctsEventId: string | null;
  correctionReason: string | null;
  archivedAt: string | null;
  effective: boolean;
  superseded: boolean;
}

interface LoyaltyEngagementReadModel {
  effective: LoyaltyEngagementView[];
  history: LoyaltyEngagementView[];
}

export interface LoyaltyResolvedSelection {
  ids: string[];
  total: number;
  filterHash: string;
  snapshotId: string | null;
  // Сколько брокеров «не звонить» исключено (только при excludeDoNotCall).
  excludedDoNotCall?: number;
}

const BROKER_CALL_RESULT_ALIASES: Record<string, string[]> = {
  INFORMED: ["Проинформирован", "INFORMED", "ALREADY_KNOWS"],
  DO_NOT_CALL: [
    "Просил не звонить",
    "REFUSED_COMMUNICATION",
    "ASKED_NOT_TO_CALL",
  ],
  NOT_INTERESTED: ["Неинтересно", "NOT_INTERESTED", "NOT_RELEVANT", "NEGATIVE"],
  NO_ANSWER: ["НДЗ", "NDZ", "DOUBLE_NDZ", "NO_ANSWER"],
  SEND_INFORMATION: [
    "Просил отправить информацию",
    "ONLY_SEND_INFO",
    "SEND_INFO",
  ],
  BROKER_TOUR_BOOKED: ["Запись на БТ", "SCHEDULED_TOUR"],
  BROKER_TOUR_DECLINED: ["Отказ от БТ", "REFUSED_TOUR"],
  INVALID_PHONE: ["Некорректный номер", "WRONG_NUMBER", "INVALID_NUMBER"],
  NOT_A_BROKER: ["Уже не брокер", "NOT_BROKER", "NOT_BROKER_ANYMORE"],
};

const AGENCY_CALL_RESULT_ALIASES: Record<string, string[]> = {
  NO_ANSWER: ["НДЗ"],
  COOPERATION_DECLINED: ["Отказ от сотрудничества", "REFUSED_COOPERATION"],
  BROKER_TOUR_SCHEDULED: ["Назначен БТ", "SCHEDULED_TOUR"],
  CALLBACK: ["Перезвонить"],
  SEND_INFORMATION: ["Отправить информацию", "SEND_INFO"],
  AGREEMENTS_EXIST: ["Есть договорённости", "AGREEMENTS"],
  COOPERATION_AGREED: ["Договорились о сотрудничестве"],
};

const BROKER_LOYALTY_STATUSES = [
  "TOP_SELLER",
  "SELLER",
  "OFFERING",
  "FIXATING",
  "BROKER_TOUR",
  "DORMANT",
  "NEW",
];
const AGENCY_LOYALTY_STATUSES = [
  "VIP_PARTNER",
  "SELLING_PARTNER",
  "ACTIVE_PARTNER",
  "FIXATING_PARTNER",
  "WARM_PARTNER",
  "STARTING_PARTNER",
  "DORMANT_PARTNER",
  "NEW_AGENCY",
];
const BROKER_LOYALTY_SCENARIOS = [
  "NOT_CALLED_IN_PERIOD",
  "CALLED_IN_PERIOD",
  "BT_DROPPED",
  "BT_FIXATION_NO_MEETING",
  "BT_MEETING_NO_DEAL",
  "NEW_NO_BT",
  "HAS_DEALS",
  "UNASSIGNED",
  "BT_VISITED",
  "BT_NOT_VISITED",
  "HAS_MEETINGS",
  "NO_MEETINGS",
];
const AGENCY_LOYALTY_SCENARIOS = [
  "NOT_CALLED_IN_PERIOD",
  "CALLED_IN_PERIOD",
  "HAS_DEALS",
  "UNASSIGNED",
  "BT_VISITED",
  "BT_NOT_VISITED",
  "SITE_PLACED",
  "SITE_NOT_PLACED",
  "INDIVIDUAL_TERMS",
  "NO_INDIVIDUAL_TERMS",
  "HAS_MEETINGS",
  "NO_MEETINGS",
];

export interface ImportPreparationOptions {
  // Internal callers only. HTTP controllers never pass this option and keep
  // the 10 MiB in-memory upload boundary.
  maxImportBytes?: number;
}

interface ImportIssue {
  row: number;
  code: string;
}

interface PreparedRecord {
  row: number;
  externalKey: string;
  entityType: EntityType;
  displayName: string;
  sourceRowNumber?: number;
  sourceExternalId?: string;
  city?: string;
  taxId?: string;
  archived: boolean;
  attributes?: Record<string, unknown>;
  contactPoints: Array<{
    type: string;
    value: string;
    normalizedValue: string;
    label?: string;
    isPrimary: boolean;
  }>;
  externalIdentities: Array<{
    system: string;
    entityType: string;
    externalId: string;
    url?: string;
    isPrimary: boolean;
  }>;
  activities: Array<{
    sourceSystem: string;
    externalId: string;
    type: string;
    occurredAt: string;
    amount?: string;
    currency: string;
    contractType?: string;
    verdict: string;
    reasonCode?: string;
    externalIdentityId?: string;
    metadata?: Record<string, unknown>;
  }>;
  organizationRoles: Array<{
    organizationExternalKey: string;
    role: string;
    isPrimary: boolean;
    validFrom?: string;
    validTo?: string;
    evidence?: Record<string, unknown>;
  }>;
  sourceAggregate?: {
    sourceKind: string;
    sourceVersion: string;
    sourceLabel?: string;
    quality: "SOURCE_REPORTED" | "PARTIAL" | "UNVERIFIED";
    exactness: "EXACT" | "APPROXIMATE" | "UNKNOWN";
    periodKind: "LIFETIME" | "DATE_RANGE" | "MONTHLY_BREAKDOWN" | "UNKNOWN";
    periodFrom?: string;
    periodTo?: string;
    contributesToSourceSummary: boolean;
    fixationCount?: number;
    meetingCount?: number;
    dealCount?: number;
    brokerTourCount?: number;
    callCount?: number;
    dealAmount?: string;
    currency?: "RUB";
    lastFixationAt?: string;
    lastMeetingAt?: string;
    lastDealAt?: string;
    lastCallAt?: string;
    brokerTourVisited?: boolean;
    brokerTourAt?: string;
    dealsByMonth?: Record<string, number>;
    callBreakdown?: Array<Record<string, unknown>>;
    provenance?: Record<string, unknown>;
    reportedAt?: string;
  };
  rowFingerprint: string;
}

interface MatchCandidate {
  recordExternalKey: string;
  targetType: EntityType;
  targetId: string;
  matchCodes: string[];
  score: string;
}

export interface SourceReportedGroupSummary {
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
}

export interface SourceReportedImportSummary {
  brokers: SourceReportedGroupSummary;
  agencies: SourceReportedGroupSummary;
}

interface PreparedImport {
  records: PreparedRecord[];
  contentHash: string;
  issueCount: number;
  issues: ImportIssue[];
  summary: {
    records: number;
    brokers: number;
    agencies: number;
    contactPoints: number;
    uniqueNormalizedPhones: number;
    externalIdentities: number;
    activities: number;
    activityCoverage: {
      mode: "PARTIAL" | "FULL_SNAPSHOT";
      coveredRecords: number;
      activityTypes: string[];
      sourceRunId: string;
      sourceContentHash: string;
      observedThrough: string;
      verifiedBySyncRun?: boolean;
      syncCompletedAt?: string;
    } | null;
    sourceAggregates: number;
    sourceSummaryAggregates: number;
    sourceReportedSummary: SourceReportedImportSummary;
    includedActivities: number;
    includedFixations: number;
    includedMeetings: number;
    includedDeals: number;
    includedBrokerTours: number;
    includedCalls: number;
    includedDealAmount: string;
    excludedActivities: number;
    unknownActivities: number;
    organizationRoles: number;
    duplicateSourceKeys: number;
    invalidContactPoints: number;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(",")}}`;
}

export function loyaltyContentHash(value: unknown): string {
  return sha256(stableJson(value));
}

function sanitizeJson(value: unknown, depth = 0): any {
  if (depth > 7) throw new BadRequestException("Metadata nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new BadRequestException("Metadata contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000)
      throw new BadRequestException("Metadata array is too large");
    return value.map((item) => sanitizeJson(item, depth + 1));
  }
  if (!value || typeof value !== "object")
    throw new BadRequestException("Unsupported metadata value");
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 300)
    throw new BadRequestException("Metadata object has too many fields");
  for (const [key, item] of entries) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new BadRequestException("Unsafe metadata key");
    }
    output[key] = sanitizeJson(item, depth + 1);
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_METADATA_BYTES) {
    throw new BadRequestException("Metadata object is too large");
  }
  return output;
}

export function normalizeLoyaltyContactPoint(
  type: string,
  value: string,
): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  if (type === "PHONE") {
    let digits = trimmed.replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("77")) {
      digits = digits.slice(1);
    } else if (digits.length === 11 && digits.startsWith("77")) {
      return null;
    } else if (digits.length === 11 && digits.startsWith("8")) {
      digits = `7${digits.slice(1)}`;
    } else if (digits.length === 10) {
      digits = `7${digits}`;
    } else if (digits.length < 10) {
      return null;
    }
    return `+${digits}`;
  }
  if (type === "EMAIL") {
    const normalized = trimmed.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
  }
  return trimmed.toLowerCase();
}

function moneyToCents(value?: string): bigint {
  if (!value) return 0n;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

export function positivePostgresBigIntOrNull(value: string): bigint | null {
  const trimmed = String(value || "").trim();
  if (!/^\d{1,19}$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed >= 1n && parsed <= MAX_POSTGRES_BIGINT ? parsed : null;
}

function chunks<T>(values: T[], size = CANDIDATE_QUERY_BATCH_SIZE): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function centsToMoney(value: bigint): string {
  const whole = value / 100n;
  const fraction = String(value % 100n).padStart(2, "0");
  return `${whole}.${fraction}`;
}

function moscowDateParts(value = new Date()) {
  const shifted = new Date(value.getTime() + 3 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    dayMonth: `${String(shifted.getUTCDate()).padStart(2, "0")}.${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`,
  };
}

function moscowCurrentMonthRange(value = new Date()) {
  const parts = moscowDateParts(value);
  const offset = 3 * 60 * 60 * 1000;
  return {
    from: new Date(Date.UTC(parts.year, parts.month, 1) - offset),
    to: new Date(Date.UTC(parts.year, parts.month + 1, 1) - offset - 1),
  };
}

export function moscowCurrentMonthFilterPeriod(
  value = new Date(),
): LoyaltyFilterPeriod {
  const parts = moscowDateParts(value);
  const month = String(parts.month + 1).padStart(2, "0");
  const lastDay = new Date(
    Date.UTC(parts.year, parts.month + 1, 0),
  ).getUTCDate();
  return {
    ...moscowCurrentMonthRange(value),
    fromIso: `${parts.year}-${month}-01`,
    toIso: `${parts.year}-${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

export function explicitGeography(
  values: unknown[],
  isRegional?: boolean | null,
): "MOSCOW" | "REGION" | null {
  if (isRegional === true) return "REGION";
  const known = values
    .map((value) => String(value ?? "").trim())
    .filter(
      (value) =>
        value.length > 0 &&
        !/^(?:-|—|unknown|неизвестно|не указано|нет данных|null)$/i.test(value),
    );
  if (known.some((value) => /^(?:москва|moscow|msk)$/i.test(value)))
    return "MOSCOW";
  if (known.length > 0) return "REGION";
  return isRegional === false ? "MOSCOW" : null;
}

export function isLoyaltyAcquisitionPhone(value: unknown): boolean {
  const normalized = normalizeLoyaltyContactPoint("PHONE", String(value ?? ""));
  return Boolean(normalized && !/^\+?7(?:495|499)/.test(normalized));
}

function hasLoyaltyAcquisitionPhone(points: unknown[]): boolean {
  return points.some((point: any) =>
    isLoyaltyAcquisitionPhone(
      point?.normalizedValue || point?.value || point?.phone || point,
    ),
  );
}

function parseMoscowBoundary(value: string, endOfDay: boolean): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date(value);
  const startUtc =
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) -
    3 * 60 * 60 * 1000;
  return new Date(endOfDay ? startUtc + 24 * 60 * 60 * 1000 - 1 : startUtc);
}

function annaBirthday(attributes: unknown): string | null {
  if (
    !attributes ||
    typeof attributes !== "object" ||
    Array.isArray(attributes)
  )
    return null;
  const object = attributes as Record<string, any>;
  const value = object.birthday ?? object.crm?.birthday;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const dayFirst = trimmed.match(/^(\d{2})\.(\d{2})(?:\.|$)/);
  if (dayFirst) return `${dayFirst[1]}.${dayFirst[2]}`;
  const iso = trimmed.match(/^\d{4}-(\d{2})-(\d{2})(?:T|$)/);
  return iso ? `${iso[2]}.${iso[1]}` : null;
}

function maskContact(type: string, value: string): string {
  if (type === "PHONE") {
    const normalized = normalizeLoyaltyContactPoint(type, value) || value;
    return normalized.length > 4
      ? `${normalized.slice(0, 2)}***${normalized.slice(-2)}`
      : "***";
  }
  if (type === "EMAIL") {
    const [name, domain] = value.split("@");
    return domain ? `${name?.slice(0, 1) || "*"}***@${domain}` : "***";
  }
  return value.length > 3 ? `${value.slice(0, 1)}***${value.slice(-1)}` : "***";
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => String(value || "").trim()).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right, "ru"));
}

function lower(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru");
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function truthyText(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "да", "есть", "размещены"].includes(lower(value));
}

function dateOnly(value: unknown): string | null {
  if (!value) return null;
  const text = String(value).trim();
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : null;
}

function moscowDateOnly(value: unknown): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value).trim());
  if (!Number.isFinite(parsed.getTime())) return null;
  const parts = moscowDateParts(parsed);
  return `${parts.year}-${String(parts.month + 1).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function timestampInPeriod(
  value: unknown,
  period: LoyaltyFilterPeriod,
): boolean {
  if (!value) return false;
  const parsed = value instanceof Date ? value : new Date(String(value).trim());
  const timestamp = parsed.getTime();
  return (
    Number.isFinite(timestamp) &&
    timestamp >= period.from.getTime() &&
    timestamp <= period.to.getTime()
  );
}

function daysSinceDate(value: unknown, now = new Date()): number | null {
  const normalized = dateOnly(value);
  if (!normalized) return null;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Math.max(
    0,
    Math.floor((now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000)),
  );
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  // Excel also evaluates formulas inside a quoted RFC 4180 field and can skip
  // leading whitespace/control characters before the formula marker. Prefix
  // the entire original value so its displayed whitespace/content is kept.
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

export function loyaltyFilterHash(value: unknown): string {
  return loyaltyContentHash(value);
}

// 2026-09-04: «фиксация» в метриках = закреплённый клиент. Заявка на
// уникальность создаёт uniquenessStatus=CONDITIONALLY_UNIQUE (массовый
// случай), а fixationStatus=FIXED ставится только редкой ручной кнопкой
// «отметить зафиксированным» после акта осмотра. Раньше метрики считали
// только FIXED — и «Фиксации: 0» у всех (жалоба пользователя).
// 2026-09-07: «за всё время» включает и ИСТЁКШИЕ фиксации (решение владельца
// 04.09, вариант В: lifetime отдельно от «Действующая фиксация»). Без этого
// перенесённые фиксации старого кабинета 2020–2026 (все истёкшие) не
// попадали бы ни в счётчики, ни в фильтр «Есть фиксации». REJECTED и
// UNDER_REVIEW фиксациями не считаются.
const FIXATION_CLIENT_WHERE = {
  OR: [
    { fixationStatus: { in: ["FIXED", "EXPIRED"] as Array<"FIXED" | "EXPIRED"> } },
    { uniquenessStatus: { in: ["CONDITIONALLY_UNIQUE", "EXPIRED"] as Array<"CONDITIONALLY_UNIQUE" | "EXPIRED"> } },
  ],
};

// 2026-09-04 (решение владельца, вариант В): «Действующая фиксация» —
// отдельный фильтр рядом с «Есть фиксации» (который остаётся lifetime и
// НЕ меняется). Клиент считается действующей фиксацией, если он проходит
// FIXATION_CLIENT_WHERE И срок соответствующей ветки не истёк:
//   - fixationStatus=FIXED → смотрим fixationExpiresAt (ручная фиксация
//     после акта осмотра живёт по своему сроку);
//   - uniquenessStatus=CONDITIONALLY_UNIQUE → смотрим uniquenessExpiresAt
//     (массовый случай: заявка на уникальность).
// null-срок в обеих ветках = бессрочно (считается действующей).
export function activeFixationClientWhere(now: Date = new Date()) {
  return {
    OR: [
      {
        fixationStatus: "FIXED" as const,
        OR: [{ fixationExpiresAt: null }, { fixationExpiresAt: { gt: now } }],
      },
      {
        uniquenessStatus: "CONDITIONALLY_UNIQUE" as const,
        OR: [
          { uniquenessExpiresAt: null },
          { uniquenessExpiresAt: { gt: now } },
        ],
      },
    ],
  };
}

// 2026-09-04 (реестр → агентства по названию): в кодовой базе нет готового
// нормализатора названий (registry_deals.agency_canonical готовится офлайн
// при заливке), поэтому обе стороны — Agency.name/legalName и
// RegistryDeal.agencyCanonical/agencyNameRaw — приводятся к одному ключу:
// NFKC + нижний регистр, без кавычек, организационно-правовых форм
// (ООО/АО/ЗАО/ИП/…), слов «агентство недвижимости»/«АН» и всех разделителей.
// Стоп-слова отбрасываются токенами (JS \b не работает с кириллицей); если
// название состоит из одних стоп-слов («АН»), ключ строится из полного
// набора токенов, чтобы разные вырожденные названия не схлопывались в пустоту.
const AGENCY_NAME_STOP_TOKENS = new Set([
  "ооо",
  "оао",
  "зао",
  "пао",
  "ао",
  "ип",
  "ан",
  "агентство",
  "недвижимости",
  "llc",
  "ltd",
]);

export function normalizeAgencyMatchKey(value: unknown): string | null {
  const tokens = String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!tokens.length) return null;
  const meaningful = tokens.filter(
    (token) => !AGENCY_NAME_STOP_TOKENS.has(token),
  );
  return (meaningful.length ? meaningful : tokens).join("") || null;
}

// 2026-09-07: сделки реестра приходят с «историческими» названиями агентств,
// которые не совпадают с карточкой в нашей базе даже после нормализации
// (registry: «trend agent», карточка: «ООО «Онлайн Недвижимость»»). Алиасы
// склеивают такие ключи в канонический ключ карточки, чтобы атрибуция
// реестр↔агентство (топ, карточка) не показывала 0. Ключ и значение — уже
// нормализованные normalizeAgencyMatchKey ключи.
export const AGENCY_KEY_ALIASES: Record<string, string> = {
  // registry_deals.agencyCanonical «trend agent» → карточка «ООО «Онлайн Недвижимость»»
  trendagent: normalizeAgencyMatchKey("ООО «Онлайн Недвижимость»")!,
  // registry_deals.agencyCanonical «нмаркет.про» → карточка «Нмаркет»
  нмаркетпро: normalizeAgencyMatchKey("Нмаркет")!,
};

// Канонический ключ мэтчинга: нормализация + алиас. Использовать во ВСЕХ
// местах сопоставления реестр↔агентство (обе стороны), чтобы алиас работал
// независимо от того, с какой стороны пришло «историческое» название.
export function canonicalAgencyMatchKey(value: unknown): string | null {
  const key = normalizeAgencyMatchKey(value);
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(AGENCY_KEY_ALIASES, key)
    ? AGENCY_KEY_ALIASES[key]
    : key;
}

@Injectable()
export class LoyaltyBaseService {
  constructor(@Inject("PrismaClient") private readonly prisma: PrismaClient) {}

  private parseBase(base: string): BaseSlug {
    const normalized = String(base || "").toLowerCase();
    if (normalized !== "anna" && normalized !== "ours") {
      throw new BadRequestException("base must be anna or ours");
    }
    return normalized;
  }

  private parsePeriod(query: LoyaltyOverviewQueryDto): {
    from: Date;
    to: Date;
  } {
    const currentMonth = { ...moscowCurrentMonthRange(), to: new Date() };
    const from = query.from
      ? parseMoscowBoundary(query.from, false)
      : currentMonth.from;
    const to = query.to ? parseMoscowBoundary(query.to, true) : currentMonth.to;
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      from > to
    ) {
      throw new BadRequestException("Invalid overview period");
    }
    if (to.getTime() - from.getTime() > 5 * 366 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException("Overview period is too large");
    }
    return { from, to };
  }

  private parseOptionalFilterPeriod(
    value: { from?: string; to?: string } | undefined,
    label: string,
  ): LoyaltyFilterPeriod | undefined {
    if (!value?.from && !value?.to) return undefined;
    if (!value.from || !value.to) {
      throw new BadRequestException(`${label} requires both from and to`);
    }
    const from = parseMoscowBoundary(value.from, false);
    const to = parseMoscowBoundary(value.to, true);
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      from > to
    ) {
      throw new BadRequestException(`Invalid ${label}`);
    }
    if (to.getTime() - from.getTime() > 5 * 366 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException(`${label} is too large`);
    }
    return {
      from,
      to,
      fromIso: value.from,
      toIso: value.to,
    };
  }

  private normalizeListFilter(
    query: LoyaltyListQueryDto | LoyaltyExportDto,
    canonical?: LoyaltyCanonicalFilterDto,
  ): CanonicalLoyaltyFilter {
    const flatPeriod =
      query.from || query.to ? { from: query.from, to: query.to } : undefined;
    const callPeriod = this.parseOptionalFilterPeriod(
      canonical?.callPeriod || flatPeriod,
      "callPeriod",
    );
    // «Период звонков» влияет только на звонки: canonical.callPeriod больше не
    // подменяет период активности. Легаси flat from/to остаётся общим периодом.
    const activityPeriod = this.parseOptionalFilterPeriod(
      canonical?.activityPeriod || flatPeriod,
      "activityPeriod",
    );
    const range = (
      nested: { min?: number; max?: number } | undefined,
      flatMin?: number,
      flatMax?: number,
      label = "range",
    ) => {
      const result = {
        min: nested?.min ?? flatMin,
        max: nested?.max ?? flatMax,
      };
      if (
        result.min !== undefined &&
        result.max !== undefined &&
        result.min > result.max
      ) {
        throw new BadRequestException(`${label}.min must not exceed max`);
      }
      return result;
    };
    const assigneeIds = uniqueSorted([
      ...(canonical?.assigneeIds || []),
      query.assignee && query.assignee !== "UNASSIGNED"
        ? query.assignee
        : undefined,
    ]);
    const columnInput = (query as any).columns || {};
    const result: CanonicalLoyaltyFilter = {
      archived: query.archived || "exclude",
      includeLowSignal:
        canonical?.includeLowSignal ?? query.includeLowSignal ?? false,
      city: query.city?.trim(),
      hasAmo: query.hasAmo,
      activityType: query.activityType,
      segment: query.segment,
      callPeriod,
      activityPeriod,
      campaignIds: uniqueSorted([
        ...(canonical?.campaignIds || []),
        query.callCampaign,
      ]),
      lastCallResults: uniqueSorted([
        ...(canonical?.lastCallResults || []),
        query.callResult,
      ]),
      scenario: canonical?.scenario || query.callScenario,
      assigneeIds,
      unassigned:
        canonical?.unassigned === true || query.assignee === "UNASSIGNED"
          ? true
          : canonical?.unassigned,
      specializations: uniqueSorted([
        ...(canonical?.specializations || []),
        query.specialization,
      ]),
      geography: uniqueSorted([
        ...(canonical?.geography || []),
        query.geography,
      ]),
      workFormats: uniqueSorted([
        ...(canonical?.workFormats || []),
        query.workFormat,
      ]),
      relationshipStages: uniqueSorted([
        ...(canonical?.relationshipStages || []),
        query.stage,
      ]),
      brokerStatuses: uniqueSorted([
        ...(canonical?.brokerStatuses || []),
        query.status,
      ]),
      dataQuality: uniqueSorted([
        ...(canonical?.dataQuality || []),
        query.dataQuality,
      ]),
      dealCount: range(
        canonical?.dealCount,
        query.dealsMin,
        query.dealsMax,
        "dealCount",
      ),
      dealsInPeriod:
        canonical?.dealsInPeriod ??
        query.dealsInPeriod ??
        (query.noDeals === true ? false : undefined),
      called: query.called,
      bt: canonical?.bt ?? query.brokerTourVisited,
      meetings: range(
        canonical?.meetings,
        query.meetingsMin,
        query.meetingsMax,
        "meetings",
      ),
      partnershipStatuses: uniqueSorted([
        ...(canonical?.partnershipStatuses || []),
        query.partnershipStatus,
      ]),
      agencySizes: uniqueSorted([
        ...(canonical?.agencySizes || []),
        query.agencySize,
      ]),
      websitePresent: canonical?.websitePresent ?? query.websitePresent,
      projectsOnSite: uniqueSorted([
        ...(canonical?.projectsOnSite || []),
        query.projectsOnSite,
      ]),
      individualTerms: canonical?.individualTerms ?? query.individualTerms,
      specialTermsProposed:
        canonical?.specialTermsProposed ?? query.specialTermsProposed,
      rewardPresent: canonical?.rewardPresent ?? query.rewardPresent,
      staleDays: canonical?.staleDays ?? query.staleDays,
      doNotCall: canonical?.doNotCall ?? query.doNotCall,
      columns: {
        contact: columnInput.contact,
        statusStage: columnInput.statusStage,
        activity: columnInput.activity,
        calls: columnInput.calls,
        assignee: hasText(columnInput.assignee)
          ? String(columnInput.assignee).trim()
          : undefined,
        deals: columnInput.deals,
      },
      sortBy: query.sortBy || "name",
      sortOrder: query.sortOrder || "asc",
    };
    if (
      (result.dealsInPeriod !== undefined ||
        ["HAS_DEALS"].includes(result.scenario || "")) &&
      !result.activityPeriod &&
      result.dealsInPeriod !== undefined
    ) {
      throw new BadRequestException(
        "dealsInPeriod requires activityPeriod (or flat from/to)",
      );
    }
    // 2026-09-04: отсутствие callPeriod у звонковых предикатов (called,
    // сценарии CALLED_IN_PERIOD/NOT_CALLED_IN_PERIOD, колонка «Звонки») — не
    // ошибка, а «за всё время»: звонили хоть раз / не звонили ни разу.
    // Раньше здесь был BadRequestException, и фронт получал 400.
    return result;
  }

  private serializableFilter(filter: CanonicalLoyaltyFilter) {
    return {
      ...filter,
      callPeriod: filter.callPeriod
        ? {
            from: filter.callPeriod.fromIso,
            to: filter.callPeriod.toIso,
          }
        : undefined,
      activityPeriod: filter.activityPeriod
        ? {
            from: filter.activityPeriod.fromIso,
            to: filter.activityPeriod.toIso,
          }
        : undefined,
    };
  }

  private campaignAliases(ids: string[]): string[] {
    if (!ids.length) return [];
    let configured: Record<string, unknown> = {};
    const raw = process.env.LOYALTY_CAMPAIGN_MAP_JSON;
    if (raw && Buffer.byteLength(raw, "utf8") <= 32 * 1024) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          configured = parsed;
        }
      } catch {
        configured = {};
      }
    }
    return uniqueSorted(
      ids.flatMap((id) => {
        const mapped = configured[id];
        if (mapped && typeof mapped === "object" && !Array.isArray(mapped)) {
          const config = mapped as Record<string, unknown>;
          return [
            id,
            ...(typeof config.name === "string" ? [config.name] : []),
            ...(Array.isArray(config.aliases)
              ? config.aliases.filter(
                  (item): item is string => typeof item === "string",
                )
              : []),
          ];
        }
        return Array.isArray(mapped)
          ? [id, ...mapped.filter((item) => typeof item === "string")]
          : typeof mapped === "string"
            ? [id, mapped]
            : [id];
      }),
    );
  }

  private resultAliases(entityType: EntityType, codes: string[]): string[] {
    const dictionary =
      entityType === "BROKER"
        ? BROKER_CALL_RESULT_ALIASES
        : AGENCY_CALL_RESULT_ALIASES;
    return uniqueSorted(
      codes.flatMap((code) => [code, ...(dictionary[code] || [])]),
    );
  }

  private sourceReportedImportSummary(
    records: PreparedRecord[],
  ): SourceReportedImportSummary {
    const summarize = (entityType: EntityType): SourceReportedGroupSummary => {
      const aggregates = records
        .filter(
          (record) =>
            record.entityType === entityType &&
            record.sourceAggregate?.quality === "SOURCE_REPORTED" &&
            record.sourceAggregate.contributesToSourceSummary === true,
        )
        .map((record) => record.sourceAggregate!);
      const numeric = (
        field:
          | "fixationCount"
          | "meetingCount"
          | "dealCount"
          | "brokerTourCount"
          | "callCount",
      ): { sum: number | null; known: number } => {
        const values = aggregates
          .map((aggregate) => aggregate[field])
          .filter((value): value is number => value !== undefined);
        return {
          sum: values.length
            ? values.reduce((total, value) => total + value, 0)
            : null,
          known: values.length,
        };
      };
      const fixations = numeric("fixationCount");
      const meetings = numeric("meetingCount");
      const deals = numeric("dealCount");
      const brokerTours = numeric("brokerTourCount");
      const calls = numeric("callCount");
      const amountValues = aggregates
        .map((aggregate) => aggregate.dealAmount)
        .filter((value): value is string => value !== undefined)
        .map((value) => moneyToCents(value));
      return {
        records: aggregates.length,
        fixations: fixations.sum,
        fixationKnownRecords: fixations.known,
        meetings: meetings.sum,
        meetingKnownRecords: meetings.known,
        deals: deals.sum,
        dealKnownRecords: deals.known,
        brokerTours: brokerTours.sum,
        brokerTourKnownRecords: brokerTours.known,
        calls: calls.sum,
        callKnownRecords: calls.known,
        dealAmount: amountValues.length
          ? centsToMoney(
              amountValues.reduce((total, value) => total + value, 0n),
            )
          : null,
        dealAmountKnownRecords: amountValues.length,
      };
    };
    return {
      brokers: summarize("BROKER"),
      agencies: summarize("AGENCY"),
    };
  }

  private compareSourceReportedManifest(
    actual: SourceReportedImportSummary,
    expected: LoyaltyImportDto["expectedSourceReportedSummary"],
    addIssue: (row: number, code: string) => void,
  ) {
    if (!expected) return;
    const numericFields: Array<
      Exclude<keyof SourceReportedGroupSummary, "dealAmount">
    > = [
      "records",
      "fixations",
      "fixationKnownRecords",
      "meetings",
      "meetingKnownRecords",
      "deals",
      "dealKnownRecords",
      "brokerTours",
      "brokerTourKnownRecords",
      "calls",
      "callKnownRecords",
      "dealAmountKnownRecords",
    ];
    for (const [groupName, expectedGroup] of [
      ["BROKER", expected.brokers],
      ["AGENCY", expected.agencies],
    ] as const) {
      const actualGroup =
        groupName === "BROKER" ? actual.brokers : actual.agencies;
      for (const field of numericFields) {
        if (expectedGroup[field] !== actualGroup[field]) {
          addIssue(0, `EXPECTED_SOURCE_${groupName}_${field}_MISMATCH`);
        }
      }
      const expectedAmount =
        expectedGroup.dealAmount === null
          ? null
          : centsToMoney(moneyToCents(expectedGroup.dealAmount));
      if (expectedAmount !== actualGroup.dealAmount) {
        addIssue(0, `EXPECTED_SOURCE_${groupName}_dealAmount_MISMATCH`);
      }
    }
  }

  private prepareImport(
    dto: LoyaltyImportDto,
    options: ImportPreparationOptions = {},
  ): PreparedImport {
    const maxImportBytes = options.maxImportBytes ?? MAX_IMPORT_BYTES;
    if (
      !Number.isSafeInteger(maxImportBytes) ||
      maxImportBytes < 1 ||
      maxImportBytes > MAX_LOYALTY_CLI_IMPORT_BYTES
    ) {
      throw new BadRequestException("Invalid import byte limit");
    }
    if (Buffer.byteLength(JSON.stringify(dto), "utf8") > maxImportBytes) {
      throw new BadRequestException(
        `Import document exceeds ${Math.floor(maxImportBytes / (1024 * 1024))} MB`,
      );
    }

    let issueCount = 0;
    const issues: ImportIssue[] = [];
    const addIssue = (row: number, code: string) => {
      issueCount++;
      if (issues.length < MAX_ISSUES_RETURNED) issues.push({ row, code });
    };

    const seenKeys = new Set<string>();
    const globalActivityKeys = new Set<string>();
    let duplicateSourceKeys = 0;
    let invalidContactPoints = 0;
    const prepared: PreparedRecord[] = [];

    for (let index = 0; index < dto.records.length; index++) {
      const input: LoyaltyImportRecordDto = dto.records[index];
      const row = input.sourceRowNumber || index + 1;
      const externalKey = input.externalKey.trim();
      if (!externalKey) addIssue(row, "EMPTY_SOURCE_KEY");
      if (!input.displayName.trim()) addIssue(row, "EMPTY_DISPLAY_NAME");
      if (
        input.sourceExternalId !== undefined &&
        !input.sourceExternalId.trim()
      )
        addIssue(row, "EMPTY_SOURCE_EXTERNAL_ID");
      if (seenKeys.has(externalKey)) {
        duplicateSourceKeys++;
        addIssue(row, "DUPLICATE_SOURCE_KEY");
      }
      seenKeys.add(externalKey);

      const contacts: PreparedRecord["contactPoints"] = [];
      const seenContacts = new Set<string>();
      for (const point of input.contactPoints || []) {
        const normalizedValue = normalizeLoyaltyContactPoint(
          point.type,
          point.value,
        );
        if (!normalizedValue) {
          invalidContactPoints++;
          addIssue(row, "INVALID_CONTACT_POINT");
          continue;
        }
        const key = `${point.type}:${normalizedValue}`;
        if (seenContacts.has(key)) {
          addIssue(row, "DUPLICATE_CONTACT_POINT");
          continue;
        }
        seenContacts.add(key);
        contacts.push({
          type: point.type,
          value: point.value.trim(),
          normalizedValue,
          label: point.label?.trim(),
          isPrimary: point.isPrimary === true,
        });
      }

      const identityKeys = new Set<string>();
      const identities: PreparedRecord["externalIdentities"] = [];
      for (const identity of input.externalIdentities || []) {
        const trimmedExternalId = identity.externalId.trim();
        if (!trimmedExternalId) addIssue(row, "EMPTY_EXTERNAL_IDENTITY");
        if (
          identity.system === "AMOCRM" &&
          identity.entityType === "CONTACT" &&
          /^\d+$/.test(trimmedExternalId) &&
          positivePostgresBigIntOrNull(trimmedExternalId) === null
        ) {
          addIssue(row, "AMO_CONTACT_ID_OUT_OF_RANGE");
        }
        const key = `${identity.system}:${identity.entityType}:${trimmedExternalId}`;
        if (identityKeys.has(key)) {
          addIssue(row, "DUPLICATE_EXTERNAL_IDENTITY");
          continue;
        }
        identityKeys.add(key);
        identities.push({
          system: identity.system,
          entityType: identity.entityType,
          externalId: trimmedExternalId,
          url: identity.url,
          isPrimary: identity.isPrimary === true,
        });
      }

      const activities: PreparedRecord["activities"] = [];
      for (const activity of input.activities || []) {
        const trimmedActivityId = activity.externalId.trim();
        if (!trimmedActivityId) addIssue(row, "EMPTY_ACTIVITY_EXTERNAL_ID");
        const key = `${activity.sourceSystem}:${activity.type}:${trimmedActivityId}:${dto.ruleVersion}`;
        if (globalActivityKeys.has(key)) {
          addIssue(row, "DUPLICATE_ACTIVITY_GLOBAL");
          continue;
        }
        globalActivityKeys.add(key);
        if (activity.externalIdentityId) {
          const referenced = identities.filter(
            (identity) =>
              identity.externalId === activity.externalIdentityId &&
              identity.system === activity.sourceSystem,
          );
          if (referenced.length !== 1)
            addIssue(row, "UNKNOWN_EXTERNAL_IDENTITY_REFERENCE");
        }
        if (
          activity.type === "DEAL" &&
          activity.verdict === "INCLUDED" &&
          (!activity.amount ||
            moneyToCents(activity.amount) <= 0n ||
            (activity.currency && activity.currency !== "RUB") ||
            activity.contractType !== "DDU")
        ) {
          addIssue(row, "INCLUDED_DEAL_REQUIRES_POSITIVE_RUB_DDU");
        }
        activities.push({
          sourceSystem: activity.sourceSystem,
          externalId: trimmedActivityId,
          type: activity.type,
          occurredAt: activity.occurredAt,
          amount: activity.amount,
          currency: activity.currency || "RUB",
          contractType: activity.contractType,
          verdict: activity.verdict || "UNKNOWN",
          reasonCode: activity.reasonCode,
          externalIdentityId: activity.externalIdentityId,
          metadata: activity.metadata
            ? sanitizeJson(activity.metadata)
            : undefined,
        });
      }
      const includedDealCents = activities
        .filter(
          (activity) =>
            activity.type === "DEAL" && activity.verdict === "INCLUDED",
        )
        .reduce((sum, activity) => sum + moneyToCents(activity.amount), 0n);
      if (includedDealCents > MAX_DECIMAL_18_2_CENTS)
        addIssue(row, "DEAL_AMOUNT_AGGREGATE_OVERFLOW");

      const roles: PreparedRecord["organizationRoles"] = [];
      const roleKeys = new Set<string>();
      let primaryRoles = 0;
      for (const role of input.organizationRoles || []) {
        const organizationExternalKey = role.organizationExternalKey.trim();
        const normalizedRole = role.role.trim();
        if (input.entityType !== "BROKER")
          addIssue(row, "ROLE_REQUIRES_BROKER");
        if (!organizationExternalKey)
          addIssue(row, "EMPTY_ORGANIZATION_REFERENCE");
        if (!normalizedRole) addIssue(row, "EMPTY_ORGANIZATION_ROLE");
        const roleKey = JSON.stringify([
          organizationExternalKey,
          normalizedRole,
        ]);
        if (roleKeys.has(roleKey)) {
          addIssue(row, "DUPLICATE_ORGANIZATION_ROLE");
          continue;
        }
        roleKeys.add(roleKey);
        if (role.isPrimary) primaryRoles++;
        if (
          role.validFrom &&
          role.validTo &&
          new Date(role.validFrom) >= new Date(role.validTo)
        ) {
          addIssue(row, "INVALID_ROLE_PERIOD");
        }
        roles.push({
          organizationExternalKey,
          role: normalizedRole,
          isPrimary: role.isPrimary === true,
          validFrom: role.validFrom,
          validTo: role.validTo,
          evidence: role.evidence ? sanitizeJson(role.evidence) : undefined,
        });
      }
      if (primaryRoles > 1) addIssue(row, "MULTIPLE_PRIMARY_ORGANIZATIONS");

      let sourceAggregate: PreparedRecord["sourceAggregate"];
      if (input.sourceAggregate) {
        const aggregate = input.sourceAggregate;
        const sourceKind = aggregate.sourceKind.trim();
        const sourceVersion = aggregate.sourceVersion.trim();
        if (!sourceKind) addIssue(row, "EMPTY_AGGREGATE_SOURCE_KIND");
        if (!sourceVersion) addIssue(row, "EMPTY_AGGREGATE_SOURCE_VERSION");
        if (
          aggregate.contributesToSourceSummary &&
          aggregate.quality !== "SOURCE_REPORTED"
        ) {
          addIssue(row, "SOURCE_SUMMARY_AGGREGATE_MUST_BE_SOURCE_REPORTED");
        }
        if (
          aggregate.periodKind === "DATE_RANGE" &&
          (!aggregate.periodFrom || !aggregate.periodTo)
        ) {
          addIssue(row, "AGGREGATE_DATE_RANGE_REQUIRED");
        }
        if (
          aggregate.periodFrom &&
          aggregate.periodTo &&
          new Date(aggregate.periodFrom) > new Date(aggregate.periodTo)
        ) {
          addIssue(row, "INVALID_AGGREGATE_PERIOD");
        }
        if (
          aggregate.dealAmount !== undefined &&
          aggregate.dealAmount !== null &&
          moneyToCents(aggregate.dealAmount) > MAX_DECIMAL_18_2_CENTS
        ) {
          addIssue(row, "AGGREGATE_DEAL_AMOUNT_OVERFLOW");
        }
        if (
          (aggregate.dealAmount === undefined ||
            aggregate.dealAmount === null) !==
          (aggregate.currency === undefined || aggregate.currency === null)
        ) {
          addIssue(row, "AGGREGATE_AMOUNT_CURRENCY_PAIR_REQUIRED");
        }
        let dealsByMonth: Record<string, number> | undefined;
        if (aggregate.dealsByMonth) {
          dealsByMonth = {};
          for (const [month, count] of Object.entries(aggregate.dealsByMonth)) {
            if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
              addIssue(row, "INVALID_AGGREGATE_MONTH_KEY");
              continue;
            }
            if (
              !Number.isSafeInteger(count) ||
              count < 0 ||
              count > 20_000_000
            ) {
              addIssue(row, "INVALID_AGGREGATE_MONTH_COUNT");
              continue;
            }
            dealsByMonth[month] = count;
          }
        }
        sourceAggregate = {
          sourceKind,
          sourceVersion,
          sourceLabel: aggregate.sourceLabel?.trim(),
          quality: aggregate.quality,
          exactness: aggregate.exactness,
          periodKind: aggregate.periodKind,
          periodFrom: aggregate.periodFrom || undefined,
          periodTo: aggregate.periodTo || undefined,
          contributesToSourceSummary:
            aggregate.contributesToSourceSummary === true,
          fixationCount: aggregate.fixationCount ?? undefined,
          meetingCount: aggregate.meetingCount ?? undefined,
          dealCount: aggregate.dealCount ?? undefined,
          brokerTourCount: aggregate.brokerTourCount ?? undefined,
          callCount: aggregate.callCount ?? undefined,
          dealAmount:
            aggregate.dealAmount === undefined || aggregate.dealAmount === null
              ? undefined
              : centsToMoney(moneyToCents(aggregate.dealAmount)),
          currency: aggregate.currency || undefined,
          lastFixationAt: aggregate.lastFixationAt || undefined,
          lastMeetingAt: aggregate.lastMeetingAt || undefined,
          lastDealAt: aggregate.lastDealAt || undefined,
          lastCallAt: aggregate.lastCallAt || undefined,
          brokerTourVisited: aggregate.brokerTourVisited ?? undefined,
          brokerTourAt: aggregate.brokerTourAt || undefined,
          dealsByMonth,
          callBreakdown: aggregate.callBreakdown
            ? (sanitizeJson(aggregate.callBreakdown) as Array<
                Record<string, unknown>
              >)
            : undefined,
          provenance: aggregate.provenance
            ? sanitizeJson(aggregate.provenance)
            : undefined,
          reportedAt: aggregate.reportedAt || undefined,
        };
      }

      const attributes = input.attributes
        ? sanitizeJson(input.attributes)
        : undefined;
      const recordWithoutFingerprint = {
        row,
        externalKey,
        entityType: input.entityType,
        displayName: input.displayName.trim(),
        sourceRowNumber: input.sourceRowNumber,
        sourceExternalId: input.sourceExternalId?.trim(),
        city: input.city?.trim(),
        taxId: input.taxId?.trim(),
        archived: input.archived === true,
        attributes,
        contactPoints: contacts,
        externalIdentities: identities,
        activities,
        organizationRoles: roles,
        sourceAggregate,
      };
      prepared.push({
        ...recordWithoutFingerprint,
        rowFingerprint: loyaltyContentHash(recordWithoutFingerprint),
      });
    }

    const organizationKeys = new Set(
      prepared
        .filter((record) => record.entityType === "AGENCY")
        .map((record) => record.externalKey),
    );
    for (const record of prepared) {
      for (const role of record.organizationRoles) {
        if (!organizationKeys.has(role.organizationExternalKey)) {
          addIssue(record.row, "UNKNOWN_ORGANIZATION_REFERENCE");
        }
      }
    }

    if (dto.expectedRecords === undefined) {
      addIssue(0, "EXPECTED_RECORD_COUNT_REQUIRED");
    } else if (dto.expectedRecords !== prepared.length) {
      addIssue(0, "EXPECTED_RECORD_COUNT_MISMATCH");
    }

    const preparedActivityCount = prepared.reduce(
      (sum, record) => sum + record.activities.length,
      0,
    );
    let activityCoverage: PreparedImport["summary"]["activityCoverage"] = null;
    if (dto.activityCoverage) {
      const observedThrough = new Date(dto.activityCoverage.observedThrough);
      const activityTypes = Array.from(
        new Set(dto.activityCoverage.activityTypes || []),
      ).sort();
      activityCoverage = {
        mode: dto.activityCoverage.mode,
        coveredRecords: Number(dto.activityCoverage.coveredRecords),
        activityTypes,
        sourceRunId: String(dto.activityCoverage.sourceRunId || "").trim(),
        sourceContentHash: String(
          dto.activityCoverage.sourceContentHash || "",
        ).toLowerCase(),
        observedThrough: Number.isNaN(observedThrough.getTime())
          ? String(dto.activityCoverage.observedThrough || "")
          : observedThrough.toISOString(),
      };
      if (!["PARTIAL", "FULL_SNAPSHOT"].includes(activityCoverage.mode)) {
        addIssue(0, "INVALID_ACTIVITY_COVERAGE_MODE");
      }
      if (
        activityTypes.length === 0 ||
        activityTypes.some(
          (type) => !REQUIRED_ACTIVITY_COVERAGE_TYPES.includes(type as any),
        )
      ) {
        addIssue(0, "INVALID_ACTIVITY_COVERAGE_TYPES");
      }
      if (
        !/^[A-Za-z0-9._:-]{1,100}$/.test(activityCoverage.sourceRunId) ||
        !/^[a-f0-9]{64}$/.test(activityCoverage.sourceContentHash) ||
        Number.isNaN(observedThrough.getTime())
      ) {
        addIssue(0, "INVALID_ACTIVITY_COVERAGE_PROVENANCE");
      }
      if (
        !Number.isSafeInteger(activityCoverage.coveredRecords) ||
        activityCoverage.coveredRecords < 0 ||
        activityCoverage.coveredRecords > prepared.length
      ) {
        addIssue(0, "INVALID_ACTIVITY_COVERED_RECORD_COUNT");
      }
      if (preparedActivityCount > 0 && activityCoverage.coveredRecords === 0) {
        addIssue(0, "ACTIVITY_COVERAGE_EMPTY_WITH_EVENTS");
      }
      if (activityCoverage.mode === "FULL_SNAPSHOT") {
        if (activityCoverage.coveredRecords !== prepared.length) {
          addIssue(0, "FULL_ACTIVITY_COVERAGE_RECORD_COUNT_MISMATCH");
        }
        const missingTypes = REQUIRED_ACTIVITY_COVERAGE_TYPES.filter(
          (type) => !activityTypes.includes(type),
        );
        if (missingTypes.length) {
          addIssue(0, "FULL_ACTIVITY_COVERAGE_TYPES_INCOMPLETE");
        }
      }
      if (!Number.isNaN(observedThrough.getTime())) {
        for (const record of prepared) {
          if (
            record.activities.some(
              (activity) =>
                new Date(activity.occurredAt).getTime() >
                observedThrough.getTime(),
            )
          ) {
            addIssue(record.row, "ACTIVITY_AFTER_OBSERVED_THROUGH");
          }
        }
      }
    } else if (preparedActivityCount > 0) {
      addIssue(0, "ACTIVITY_COVERAGE_REQUIRED");
    }

    const sourceReportedSummary = this.sourceReportedImportSummary(prepared);
    const hasCompleteSourceReportedManifest = Boolean(
      dto.expectedSourceReportedSummary?.brokers &&
      dto.expectedSourceReportedSummary?.agencies,
    );
    if (
      dto.expectedSourceReportedSummary &&
      !hasCompleteSourceReportedManifest
    ) {
      addIssue(0, "EXPECTED_SOURCE_REPORTED_SUMMARY_GROUPS_REQUIRED");
    }
    const expectedSourceReportedSummary = hasCompleteSourceReportedManifest
      ? {
          brokers: {
            ...dto.expectedSourceReportedSummary.brokers,
            dealAmount:
              dto.expectedSourceReportedSummary.brokers.dealAmount === null
                ? null
                : centsToMoney(
                    moneyToCents(
                      dto.expectedSourceReportedSummary.brokers.dealAmount,
                    ),
                  ),
          },
          agencies: {
            ...dto.expectedSourceReportedSummary.agencies,
            dealAmount:
              dto.expectedSourceReportedSummary.agencies.dealAmount === null
                ? null
                : centsToMoney(
                    moneyToCents(
                      dto.expectedSourceReportedSummary.agencies.dealAmount,
                    ),
                  ),
          },
        }
      : null;

    const hashDocument = {
      ruleVersion: dto.ruleVersion,
      expectedRecords: dto.expectedRecords ?? null,
      expectedUniquePhones: dto.expectedUniquePhones ?? null,
      expectedActivities: dto.expectedActivities ?? null,
      expectedSourceAggregates: dto.expectedSourceAggregates ?? null,
      expectedSourceReportedSummary,
      expectedExternalIdentities: dto.expectedExternalIdentities ?? null,
      expectedIncludedFixations: dto.expectedIncludedFixations ?? null,
      expectedIncludedMeetings: dto.expectedIncludedMeetings ?? null,
      expectedIncludedDeals: dto.expectedIncludedDeals ?? null,
      expectedIncludedBrokerTours: dto.expectedIncludedBrokerTours ?? null,
      expectedIncludedCalls: dto.expectedIncludedCalls ?? null,
      expectedIncludedDealAmount:
        dto.expectedIncludedDealAmount === undefined
          ? null
          : centsToMoney(moneyToCents(dto.expectedIncludedDealAmount)),
      ...(activityCoverage ? { activityCoverage } : {}),
      records: prepared.map(
        ({ rowFingerprint: _fingerprint, ...record }) => record,
      ),
    };
    const contentHash = loyaltyContentHash(hashDocument);
    const summary = {
      records: prepared.length,
      brokers: prepared.filter((record) => record.entityType === "BROKER")
        .length,
      agencies: prepared.filter((record) => record.entityType === "AGENCY")
        .length,
      contactPoints: prepared.reduce(
        (sum, record) => sum + record.contactPoints.length,
        0,
      ),
      uniqueNormalizedPhones: new Set(
        prepared.flatMap((record) =>
          record.contactPoints
            .filter((point) => point.type === "PHONE")
            .map((point) => point.normalizedValue),
        ),
      ).size,
      externalIdentities: prepared.reduce(
        (sum, record) => sum + record.externalIdentities.length,
        0,
      ),
      activities: preparedActivityCount,
      activityCoverage,
      sourceAggregates: prepared.filter((record) => record.sourceAggregate)
        .length,
      sourceSummaryAggregates: prepared.filter(
        (record) => record.sourceAggregate?.contributesToSourceSummary,
      ).length,
      sourceReportedSummary,
      includedActivities: prepared.reduce(
        (sum, record) =>
          sum +
          record.activities.filter(
            (activity) => activity.verdict === "INCLUDED",
          ).length,
        0,
      ),
      includedFixations: prepared.reduce(
        (sum, record) =>
          sum +
          record.activities.filter(
            (activity) =>
              activity.verdict === "INCLUDED" && activity.type === "FIXATION",
          ).length,
        0,
      ),
      includedMeetings: prepared.reduce(
        (sum, record) =>
          sum +
          record.activities.filter(
            (activity) =>
              activity.verdict === "INCLUDED" && activity.type === "MEETING",
          ).length,
        0,
      ),
      includedDeals: prepared.reduce(
        (sum, record) =>
          sum +
          record.activities.filter(
            (activity) =>
              activity.verdict === "INCLUDED" && activity.type === "DEAL",
          ).length,
        0,
      ),
      includedBrokerTours: prepared.reduce(
        (sum, record) =>
          sum +
          record.activities.filter(
            (activity) =>
              activity.verdict === "INCLUDED" &&
              activity.type === "BROKER_TOUR",
          ).length,
        0,
      ),
      includedCalls: prepared.reduce(
        (sum, record) =>
          sum +
          record.activities.filter(
            (activity) =>
              activity.verdict === "INCLUDED" && activity.type === "CALL",
          ).length,
        0,
      ),
      includedDealAmount: centsToMoney(
        prepared.reduce(
          (sum, record) =>
            sum +
            record.activities
              .filter(
                (activity) =>
                  activity.verdict === "INCLUDED" && activity.type === "DEAL",
              )
              .reduce(
                (recordSum, activity) =>
                  recordSum + moneyToCents(activity.amount),
                0n,
              ),
          0n,
        ),
      ),
      excludedActivities: prepared.reduce(
        (sum, record) =>
          sum +
          record.activities.filter(
            (activity) => activity.verdict === "EXCLUDED",
          ).length,
        0,
      ),
      unknownActivities: prepared.reduce(
        (sum, record) =>
          sum +
          record.activities.filter((activity) => activity.verdict === "UNKNOWN")
            .length,
        0,
      ),
      organizationRoles: prepared.reduce(
        (sum, record) => sum + record.organizationRoles.length,
        0,
      ),
      duplicateSourceKeys,
      invalidContactPoints,
    };
    if (dto.expectedUniquePhones === undefined)
      addIssue(0, "EXPECTED_UNIQUE_PHONES_REQUIRED");
    else if (dto.expectedUniquePhones !== summary.uniqueNormalizedPhones)
      addIssue(0, "EXPECTED_UNIQUE_PHONES_MISMATCH");
    if (dto.expectedActivities === undefined)
      addIssue(0, "EXPECTED_ACTIVITY_COUNT_REQUIRED");
    else if (dto.expectedActivities !== summary.activities)
      addIssue(0, "EXPECTED_ACTIVITY_COUNT_MISMATCH");
    if (
      summary.sourceAggregates > 0 &&
      dto.expectedSourceAggregates === undefined
    ) {
      addIssue(0, "EXPECTED_SOURCE_AGGREGATE_COUNT_REQUIRED");
    } else if (
      dto.expectedSourceAggregates !== undefined &&
      dto.expectedSourceAggregates !== summary.sourceAggregates
    ) {
      addIssue(0, "EXPECTED_SOURCE_AGGREGATE_COUNT_MISMATCH");
    }
    if (
      summary.sourceAggregates > 0 &&
      dto.expectedSourceReportedSummary === undefined
    ) {
      addIssue(0, "EXPECTED_SOURCE_REPORTED_SUMMARY_REQUIRED");
    } else if (
      dto.expectedSourceReportedSummary &&
      hasCompleteSourceReportedManifest
    ) {
      this.compareSourceReportedManifest(
        summary.sourceReportedSummary,
        dto.expectedSourceReportedSummary,
        addIssue,
      );
    }
    if (dto.expectedExternalIdentities === undefined)
      addIssue(0, "EXPECTED_EXTERNAL_IDENTITY_COUNT_REQUIRED");
    else if (dto.expectedExternalIdentities !== summary.externalIdentities)
      addIssue(0, "EXPECTED_EXTERNAL_IDENTITY_COUNT_MISMATCH");
    const includedManifest: Array<
      [keyof LoyaltyImportDto, keyof typeof summary, string]
    > = [
      [
        "expectedIncludedFixations",
        "includedFixations",
        "INCLUDED_FIXATION_COUNT",
      ],
      [
        "expectedIncludedMeetings",
        "includedMeetings",
        "INCLUDED_MEETING_COUNT",
      ],
      ["expectedIncludedDeals", "includedDeals", "INCLUDED_DEAL_COUNT"],
      [
        "expectedIncludedBrokerTours",
        "includedBrokerTours",
        "INCLUDED_BROKER_TOUR_COUNT",
      ],
      ["expectedIncludedCalls", "includedCalls", "INCLUDED_CALL_COUNT"],
    ];
    for (const [expectedField, summaryField, code] of includedManifest) {
      const expected = dto[expectedField];
      if (expected === undefined) addIssue(0, `EXPECTED_${code}_REQUIRED`);
      else if (Number(expected) !== Number(summary[summaryField]))
        addIssue(0, `EXPECTED_${code}_MISMATCH`);
    }
    if (dto.expectedIncludedDealAmount === undefined) {
      addIssue(0, "EXPECTED_INCLUDED_DEAL_AMOUNT_REQUIRED");
    } else if (
      moneyToCents(dto.expectedIncludedDealAmount) !==
      moneyToCents(summary.includedDealAmount)
    ) {
      addIssue(0, "EXPECTED_INCLUDED_DEAL_AMOUNT_MISMATCH");
    }
    return { records: prepared, contentHash, issueCount, issues, summary };
  }

  private async findCandidates(
    records: PreparedRecord[],
  ): Promise<MatchCandidate[]> {
    const eligibleRecords = records.filter((record) => !record.archived);
    const brokerPhones = Array.from(
      new Set(
        eligibleRecords
          .filter((record) => record.entityType === "BROKER")
          .flatMap((record) =>
            record.contactPoints
              .filter((point) => point.type === "PHONE")
              .map((point) => point.normalizedValue),
          ),
      ),
    );
    const amoIds = Array.from(
      new Set(
        eligibleRecords
          .flatMap((record) => record.externalIdentities)
          .filter(
            (identity) =>
              identity.system === "AMOCRM" &&
              identity.entityType === "CONTACT" &&
              positivePostgresBigIntOrNull(identity.externalId) !== null,
          )
          .map((identity) => identity.externalId),
      ),
    );
    const taxIds = Array.from(
      new Set(
        eligibleRecords
          .filter((record) => record.entityType === "AGENCY" && record.taxId)
          .map((record) => record.taxId!),
      ),
    );

    const brokerById = new Map<string, any>();
    const rememberBrokers = (rows: any[] | undefined | null) => {
      for (const broker of rows || []) brokerById.set(broker.id, broker);
    };
    for (const phoneBatch of chunks(brokerPhones)) {
      rememberBrokers(
        await this.prisma.broker.findMany({
          where: {
            mergedIntoId: null,
            OR: [
              { phone: { in: phoneBatch } },
              { phones: { some: { phone: { in: phoneBatch } } } },
            ],
          },
          select: {
            id: true,
            phone: true,
            amoContactId: true,
            phones: { select: { phone: true } },
          },
        }),
      );
    }
    for (const amoBatch of chunks(amoIds)) {
      rememberBrokers(
        await this.prisma.broker.findMany({
          where: {
            mergedIntoId: null,
            amoContactId: {
              in: amoBatch.map((id) => positivePostgresBigIntOrNull(id)!),
            },
          },
          select: {
            id: true,
            phone: true,
            amoContactId: true,
            phones: { select: { phone: true } },
          },
        }),
      );
    }

    const agencyById = new Map<string, any>();
    for (const taxIdBatch of chunks(taxIds)) {
      const rows = await this.prisma.agency.findMany({
        where: { inn: { in: taxIdBatch } },
        select: { id: true, inn: true },
      });
      for (const agency of (rows || []) as any[])
        agencyById.set(agency.id, agency);
    }
    const brokers = Array.from(brokerById.values());
    const agencies = Array.from(agencyById.values());

    const byPhone = new Map<string, Set<string>>();
    const byAmo = new Map<string, Set<string>>();
    for (const broker of brokers as any[]) {
      for (const phone of [
        broker.phone,
        ...(broker.phones || []).map((item: any) => item.phone),
      ]) {
        const normalized = normalizeLoyaltyContactPoint("PHONE", phone);
        if (!normalized) continue;
        const ids = byPhone.get(normalized) || new Set<string>();
        ids.add(broker.id);
        byPhone.set(normalized, ids);
      }
      if (broker.amoContactId) {
        const key = String(broker.amoContactId);
        const ids = byAmo.get(key) || new Set<string>();
        ids.add(broker.id);
        byAmo.set(key, ids);
      }
    }
    const byTaxId = new Map(
      (agencies as any[]).map((agency) => [agency.inn, agency.id]),
    );

    const candidates: MatchCandidate[] = [];
    for (const record of eligibleRecords) {
      const matches = new Map<string, Set<string>>();
      const add = (targetType: EntityType, targetId: string, code: string) => {
        const key = `${targetType}:${targetId}`;
        const codes = matches.get(key) || new Set<string>();
        codes.add(code);
        matches.set(key, codes);
      };
      if (record.entityType === "BROKER") {
        for (const point of record.contactPoints.filter(
          (item) => item.type === "PHONE",
        )) {
          for (const brokerId of byPhone.get(point.normalizedValue) || [])
            add("BROKER", brokerId, "PHONE_EXACT");
        }
        for (const identity of record.externalIdentities.filter(
          (item) => item.system === "AMOCRM" && item.entityType === "CONTACT",
        )) {
          for (const brokerId of byAmo.get(identity.externalId) || [])
            add("BROKER", brokerId, "AMO_ID_EXACT");
        }
      } else if (record.taxId && byTaxId.has(record.taxId)) {
        add("AGENCY", byTaxId.get(record.taxId)!, "TAX_ID_EXACT");
      }
      for (const [key, codesSet] of matches) {
        const [targetType, targetId] = key.split(":") as [EntityType, string];
        const matchCodes = Array.from(codesSet).sort();
        candidates.push({
          recordExternalKey: record.externalKey,
          targetType,
          targetId,
          matchCodes,
          score: matchCodes.some(
            (code) => code === "AMO_ID_EXACT" || code === "TAX_ID_EXACT",
          )
            ? "1.0000"
            : "0.9500",
        });
      }
    }
    return candidates;
  }

  async dryRunImport(
    dto: LoyaltyImportDto,
    options: ImportPreparationOptions = {},
  ) {
    const prepared = this.prepareImport(dto, options);
    const coverageIssues =
      prepared.issueCount === 0
        ? await this.activityCoverageSyncIssues(prepared, dto.ruleVersion)
        : [];
    if (
      coverageIssues.length === 0 &&
      prepared.summary.activityCoverage?.mode === "FULL_SNAPSHOT"
    ) {
      prepared.summary.activityCoverage.verifiedBySyncRun = true;
    }
    const issueCount = prepared.issueCount + coverageIssues.length;
    const [candidates, coverage] = await Promise.all([
      issueCount === 0
        ? this.findCandidates(prepared.records)
        : Promise.resolve([]),
      this.coverageRisk(prepared.summary),
    ]);
    const candidateCounts = new Map<string, number>();
    for (const candidate of candidates) {
      candidateCounts.set(
        candidate.recordExternalKey,
        (candidateCounts.get(candidate.recordExternalKey) || 0) + 1,
      );
    }
    return {
      dryRun: true,
      contentHash: prepared.contentHash,
      expectedActiveSnapshotId: coverage.activeSnapshotId,
      publishable: issueCount === 0,
      status: issueCount === 0 ? "VALID" : "INVALID",
      summary: {
        ...prepared.summary,
        issueCount,
        candidateCount: candidates.length,
        ambiguousRecords: Array.from(candidateCounts.values()).filter(
          (count) => count > 1,
        ).length,
        currentPublishedRecords: coverage.currentPublishedRecords,
        coverageDropRequiresConfirmation: coverage.requiresConfirmation,
        coverageDrops: coverage.droppedDimensions,
      },
      issues: [...prepared.issues, ...coverageIssues].slice(
        0,
        MAX_ISSUES_RETURNED,
      ),
    };
  }

  private async activityCoverageSyncIssues(
    prepared: PreparedImport,
    ruleVersion: string,
  ): Promise<ImportIssue[]> {
    const coverage = prepared.summary.activityCoverage;
    if (!coverage || coverage.mode !== "FULL_SNAPSHOT") return [];
    const syncRun = await (this.prisma as any).loyaltySyncRun?.findUnique?.({
      where: { id: coverage.sourceRunId },
      select: {
        id: true,
        source: true,
        status: true,
        contentHash: true,
        counts: true,
        completedAt: true,
      },
    });
    const counts =
      syncRun?.counts && typeof syncRun.counts === "object"
        ? syncRun.counts
        : {};
    const types = new Set(
      Array.isArray(counts.activityTypes) ? counts.activityTypes : [],
    );
    const observedThrough = new Date(coverage.observedThrough);
    const completedAt = new Date(syncRun?.completedAt || "");
    const readAt = new Date(counts.readAt || syncRun?.completedAt || "");
    const trustedTime =
      Number.isFinite(observedThrough.getTime()) &&
      Number.isFinite(completedAt.getTime()) &&
      Number.isFinite(readAt.getTime()) &&
      observedThrough.getTime() === readAt.getTime() &&
      readAt.getTime() <= completedAt.getTime();
    const attested =
      syncRun?.source === "AMOCRM" &&
      syncRun?.status === "SUCCEEDED" &&
      syncRun?.contentHash === coverage.sourceContentHash &&
      trustedTime &&
      counts.complete === true &&
      counts.eventCoverageComplete === true &&
      Number(counts.coveredRecords) === coverage.coveredRecords &&
      counts.activityRuleVersion === ruleVersion &&
      REQUIRED_ACTIVITY_COVERAGE_TYPES.every((type) => types.has(type));
    if (!attested) {
      return [{ row: 0, code: "FULL_ACTIVITY_COVERAGE_SYNC_RUN_NOT_ATTESTED" }];
    }
    coverage.verifiedBySyncRun = true;
    coverage.syncCompletedAt = completedAt.toISOString();
    return [];
  }

  private async coverageRisk(summary: PreparedImport["summary"]) {
    const active = await this.activeAnnaSnapshot();
    const currentPublishedRecords = Number(active?.snapshot.recordCount || 0);
    const stagedDimensions = {
      records: summary.records,
      brokers: summary.brokers,
      agencies: summary.agencies,
      uniqueNormalizedPhones: summary.uniqueNormalizedPhones,
      externalIdentities: summary.externalIdentities,
      activities: summary.activities,
      sourceAggregates: summary.sourceAggregates,
      sourceSummaryAggregates: summary.sourceSummaryAggregates,
      includedActivities: summary.includedActivities,
      includedFixations: summary.includedFixations,
      includedMeetings: summary.includedMeetings,
      includedDeals: summary.includedDeals,
      includedBrokerTours: summary.includedBrokerTours,
      includedCalls: summary.includedCalls,
      includedDealAmount: summary.includedDealAmount,
      ...this.sourceReportedCoverageDimensions(summary.sourceReportedSummary),
    };
    const droppedDimensions = active
      ? this.coverageDrops(
          this.snapshotCoverageDimensions(active.snapshot),
          stagedDimensions,
        )
      : [];
    return {
      activeSnapshotId: active?.snapshot.id || null,
      currentPublishedRecords,
      droppedDimensions,
      requiresConfirmation: droppedDimensions.length > 0,
    };
  }

  private snapshotCoverageDimensions(
    snapshot: any,
  ): Record<string, number | string> {
    const summary =
      snapshot?.summary && typeof snapshot.summary === "object"
        ? (snapshot.summary as any)
        : {};
    return {
      records: Number(snapshot?.recordCount || 0),
      brokers: Number(snapshot?.brokerCount || 0),
      agencies: Number(snapshot?.agencyCount || 0),
      uniqueNormalizedPhones: Number(summary.uniqueNormalizedPhones || 0),
      externalIdentities: Number(summary.externalIdentities || 0),
      activities: Number(snapshot?.activityCount ?? summary.activities ?? 0),
      sourceAggregates: Number(summary.sourceAggregates || 0),
      sourceSummaryAggregates: Number(summary.sourceSummaryAggregates || 0),
      includedActivities: Number(summary.includedActivities || 0),
      includedFixations: Number(summary.includedFixations || 0),
      includedMeetings: Number(summary.includedMeetings || 0),
      includedDeals: Number(summary.includedDeals || 0),
      includedBrokerTours: Number(summary.includedBrokerTours || 0),
      includedCalls: Number(summary.includedCalls || 0),
      includedDealAmount: String(summary.includedDealAmount || "0.00"),
      ...this.sourceReportedCoverageDimensions(summary.sourceReportedSummary),
    };
  }

  private sourceReportedCoverageDimensions(summary: any) {
    const group = (prefix: "Broker" | "Agency", value: any) => ({
      [`source${prefix}Records`]: Number(value?.records || 0),
      [`source${prefix}Fixations`]: Number(value?.fixations || 0),
      [`source${prefix}FixationKnownRecords`]: Number(
        value?.fixationKnownRecords || 0,
      ),
      [`source${prefix}Meetings`]: Number(value?.meetings || 0),
      [`source${prefix}MeetingKnownRecords`]: Number(
        value?.meetingKnownRecords || 0,
      ),
      [`source${prefix}Deals`]: Number(value?.deals || 0),
      [`source${prefix}DealKnownRecords`]: Number(value?.dealKnownRecords || 0),
      [`source${prefix}BrokerTours`]: Number(value?.brokerTours || 0),
      [`source${prefix}BrokerTourKnownRecords`]: Number(
        value?.brokerTourKnownRecords || 0,
      ),
      [`source${prefix}Calls`]: Number(value?.calls || 0),
      [`source${prefix}CallKnownRecords`]: Number(value?.callKnownRecords || 0),
      [`source${prefix}DealAmount`]: String(value?.dealAmount || "0.00"),
      [`source${prefix}DealAmountKnownRecords`]: Number(
        value?.dealAmountKnownRecords || 0,
      ),
    });
    return {
      ...group("Broker", summary?.brokers),
      ...group("Agency", summary?.agencies),
    };
  }

  private coverageDrops(
    current: Record<string, number | string>,
    next: Record<string, number | string>,
  ) {
    const lower = (dimension: string) =>
      dimension.endsWith("DealAmount")
        ? moneyToCents(String(next[dimension])) <
          moneyToCents(String(current[dimension]))
        : Number(next[dimension]) < Number(current[dimension]);
    return Object.keys(current).flatMap((dimension) =>
      lower(dimension)
        ? [{ dimension, current: current[dimension], staged: next[dimension] }]
        : [],
    );
  }

  private async createManyInChunks(
    delegate: any,
    data: any[],
    batchSize = 400,
  ) {
    for (let index = 0; index < data.length; index += batchSize) {
      await delegate.createMany({
        data: data.slice(index, index + batchSize),
        skipDuplicates: true,
      });
    }
  }

  private async assertNoManualOverlayImportConflicts(
    records: PreparedRecord[],
  ): Promise<void> {
    const delegate = (this.prisma as any).loyaltyManualEntity;
    if (!delegate?.findMany) return;
    const overlays =
      (await delegate.findMany({
        where: {
          dataset: { code: ANNA_DATASET_CODE, base: "ANNA" },
          archivedAt: null,
        },
        select: {
          entityType: true,
          phoneNormalized: true,
          emailNormalized: true,
          person: { select: { externalKey: true } },
          organization: { select: { externalKey: true } },
        },
      })) || [];
    if (!overlays.length) return;
    const ownerByContact = new Map<string, string>();
    for (const overlay of overlays) {
      const stableExternalKey =
        overlay.person?.externalKey || overlay.organization?.externalKey;
      for (const value of [
        overlay.phoneNormalized,
        overlay.emailNormalized,
      ].filter(Boolean)) {
        ownerByContact.set(`${overlay.entityType}:${value}`, stableExternalKey);
      }
    }
    for (const record of records) {
      for (const point of record.contactPoints) {
        const stableExternalKey = ownerByContact.get(
          `${record.entityType}:${point.normalizedValue}`,
        );
        if (stableExternalKey && stableExternalKey !== record.externalKey) {
          throw new ConflictException(
            "MANUAL_OVERLAY_CONTACT_REQUIRES_RECONCILIATION",
          );
        }
      }
    }
  }

  async stageImport(
    dto: LoyaltyImportDto,
    actorId?: string,
    options: ImportPreparationOptions = {},
  ) {
    const prepared = this.prepareImport(dto, options);
    const coverageIssues = await this.activityCoverageSyncIssues(
      prepared,
      dto.ruleVersion,
    );
    if (
      coverageIssues.length === 0 &&
      prepared.summary.activityCoverage?.mode === "FULL_SNAPSHOT"
    ) {
      prepared.summary.activityCoverage.verifiedBySyncRun = true;
    }
    if (prepared.issueCount > 0 || coverageIssues.length > 0) {
      throw new BadRequestException({
        message: "Import document has validation issues",
        issueCount: prepared.issueCount + coverageIssues.length,
        issues: [...prepared.issues, ...coverageIssues].slice(
          0,
          MAX_ISSUES_RETURNED,
        ),
      });
    }
    if (
      !dto.expectedContentHash ||
      dto.expectedContentHash !== prepared.contentHash
    ) {
      throw new ConflictException(
        "expectedContentHash does not match the submitted document",
      );
    }
    await this.assertNoManualOverlayImportConflicts(prepared.records);
    const [candidates, coverage] = await Promise.all([
      this.findCandidates(prepared.records),
      this.coverageRisk(prepared.summary),
    ]);
    if (dto.expectedActiveSnapshotId === undefined) {
      throw new BadRequestException(
        "expectedActiveSnapshotId from dry-run is required for stage",
      );
    }
    if (dto.expectedActiveSnapshotId !== coverage.activeSnapshotId) {
      throw new ConflictException(
        "Active snapshot changed since dry-run; repeat dry-run",
      );
    }
    if (coverage.requiresConfirmation && dto.confirmCoverageDrop !== true) {
      throw new ConflictException({
        message:
          "Published-record coverage would decrease; confirmCoverageDrop=true is required",
        currentPublishedRecords: coverage.currentPublishedRecords,
        stagedRecords: prepared.summary.records,
        coverageDrops: coverage.droppedDimensions,
      });
    }
    const snapshotSummary = {
      ...prepared.summary,
      candidateCount: candidates.length,
      stagedAgainstActiveSnapshotId: coverage.activeSnapshotId,
      currentPublishedRecords: coverage.currentPublishedRecords,
      coverageDrops: coverage.droppedDimensions,
      coverageDropConfirmed: coverage.requiresConfirmation
        ? dto.confirmCoverageDrop === true
        : false,
    };

    return this.prisma.$transaction(
      async (tx: any) => {
        const dataset = await tx.loyaltyDataset.upsert({
          where: { code: ANNA_DATASET_CODE },
          update: {},
          create: { code: ANNA_DATASET_CODE, name: "База Анны", base: "ANNA" },
        });
        if ((dataset.activeSnapshotId || null) !== coverage.activeSnapshotId) {
          throw new ConflictException(
            "Active snapshot changed; repeat dry-run and stage",
          );
        }
        const existing = await tx.loyaltySnapshot.findUnique({
          where: {
            datasetId_contentHash: {
              datasetId: dataset.id,
              contentHash: prepared.contentHash,
            },
          },
        });
        if (existing) {
          return {
            snapshotId: existing.id,
            contentHash: existing.contentHash,
            status: existing.status,
            summary: existing.summary,
            expectedActiveSnapshotId: dataset.activeSnapshotId || null,
            idempotent: true,
          };
        }

        const snapshot = await tx.loyaltySnapshot.create({
          data: {
            datasetId: dataset.id,
            status: "STAGED",
            sourceName: dto.sourceName,
            contentHash: prepared.contentHash,
            ruleVersion: dto.ruleVersion,
            expectedRecords: dto.expectedRecords,
            recordCount: prepared.summary.records,
            brokerCount: prepared.summary.brokers,
            agencyCount: prepared.summary.agencies,
            activityCount: prepared.summary.activities,
            errorCount: 0,
            summary: snapshotSummary,
            createdById: actorId || null,
          },
        });

        const personInputs = prepared.records.filter(
          (record) => record.entityType === "BROKER",
        );
        const organizationInputs = prepared.records.filter(
          (record) => record.entityType === "AGENCY",
        );
        await this.createManyInChunks(
          tx.loyaltyPerson,
          personInputs.map((record) => ({
            id: randomUUID(),
            datasetId: dataset.id,
            externalKey: record.externalKey,
          })),
        );
        await this.createManyInChunks(
          tx.loyaltyOrganization,
          organizationInputs.map((record) => ({
            id: randomUUID(),
            datasetId: dataset.id,
            externalKey: record.externalKey,
          })),
        );
        const [persons, organizations] = await Promise.all([
          tx.loyaltyPerson.findMany({
            where: {
              datasetId: dataset.id,
              externalKey: {
                in: personInputs.map((record) => record.externalKey),
              },
            },
            select: {
              id: true,
              externalKey: true,
              manualDisplayName: true,
              manualCity: true,
              manualAttributes: true,
            },
          }),
          tx.loyaltyOrganization.findMany({
            where: {
              datasetId: dataset.id,
              externalKey: {
                in: organizationInputs.map((record) => record.externalKey),
              },
            },
            select: {
              id: true,
              externalKey: true,
              manualDisplayName: true,
              manualCity: true,
              manualAttributes: true,
            },
          }),
        ]);
        const personByKey = new Map(
          persons.map((person: any) => [person.externalKey, person.id]),
        );
        const organizationByKey = new Map(
          organizations.map((organization: any) => [
            organization.externalKey,
            organization.id,
          ]),
        );
        const personEntityByKey = new Map(
          persons.map((person: any) => [person.externalKey, person]),
        );
        const organizationEntityByKey = new Map(
          organizations.map((organization: any) => [
            organization.externalKey,
            organization,
          ]),
        );
        const sourceRecordByKey = new Map<string, string>();
        const sourceRows = prepared.records.map((record) => {
          const id = randomUUID();
          sourceRecordByKey.set(record.externalKey, id);
          return {
            id,
            snapshotId: snapshot.id,
            sourceKey: record.externalKey,
            sourceRowNumber: record.sourceRowNumber || null,
            entityType: record.entityType,
            personId:
              record.entityType === "BROKER"
                ? personByKey.get(record.externalKey)
                : null,
            organizationId:
              record.entityType === "AGENCY"
                ? organizationByKey.get(record.externalKey)
                : null,
            displayName: record.displayName,
            city: record.city || null,
            taxId: record.taxId || null,
            sourceSystem: "ANNA_FILE",
            sourceExternalId: record.sourceExternalId || record.externalKey,
            rowFingerprint: record.rowFingerprint,
            attributes: record.attributes || undefined,
            sourceArchivedAt: record.archived ? new Date() : null,
          };
        });
        await this.createManyInChunks(tx.loyaltySourceRecord, sourceRows);

        const contactRows: any[] = [];
        const identityRows: any[] = [];
        const activityRows: any[] = [];
        const metricRows: any[] = [];
        const sourceAggregateRows: any[] = [];
        const fieldRows: any[] = [];
        const roleRows: any[] = [];
        for (const record of prepared.records) {
          const sourceRecordId = sourceRecordByKey.get(record.externalKey)!;
          const identityIdByExternal = new Map<string, string>();
          for (const point of record.contactPoints) {
            contactRows.push({ id: randomUUID(), sourceRecordId, ...point });
            fieldRows.push(
              this.fieldValueRow(
                sourceRecordId,
                `contact.${point.type.toLowerCase()}`,
                point.value,
                point.normalizedValue,
                "ANNA_FILE",
                record.sourceExternalId,
              ),
            );
          }
          for (const identity of record.externalIdentities) {
            const id = randomUUID();
            identityIdByExternal.set(
              `${identity.system}:${identity.externalId}`,
              id,
            );
            identityRows.push({ id, sourceRecordId, ...identity });
            fieldRows.push(
              this.fieldValueRow(
                sourceRecordId,
                `external.${identity.system.toLowerCase()}.${identity.entityType.toLowerCase()}`,
                identity.externalId,
                identity.externalId,
                identity.system,
                identity.externalId,
              ),
            );
          }
          fieldRows.push(
            this.fieldValueRow(
              sourceRecordId,
              "displayName",
              record.displayName,
              record.displayName.trim().toLowerCase(),
              "ANNA_FILE",
              record.sourceExternalId,
            ),
          );
          if (record.city)
            fieldRows.push(
              this.fieldValueRow(
                sourceRecordId,
                "city",
                record.city,
                record.city.trim().toLowerCase(),
                "ANNA_FILE",
                record.sourceExternalId,
              ),
            );
          if (record.taxId)
            fieldRows.push(
              this.fieldValueRow(
                sourceRecordId,
                "taxId",
                record.taxId,
                record.taxId,
                "ANNA_FILE",
                record.sourceExternalId,
              ),
            );
          if (record.attributes)
            fieldRows.push(
              this.fieldValueRow(
                sourceRecordId,
                "attributes",
                record.attributes,
                null,
                "ANNA_FILE",
                record.sourceExternalId,
              ),
            );
          const stableEntity: any =
            record.entityType === "BROKER"
              ? personEntityByKey.get(record.externalKey)
              : organizationEntityByKey.get(record.externalKey);
          if (stableEntity?.manualDisplayName)
            fieldRows.push(
              this.fieldValueRow(
                sourceRecordId,
                "displayName",
                stableEntity.manualDisplayName,
                stableEntity.manualDisplayName.trim().toLowerCase(),
                "MANUAL",
                `entity:${stableEntity.id}`,
                true,
              ),
            );
          if (stableEntity?.manualCity)
            fieldRows.push(
              this.fieldValueRow(
                sourceRecordId,
                "city",
                stableEntity.manualCity,
                stableEntity.manualCity.trim().toLowerCase(),
                "MANUAL",
                `entity:${stableEntity.id}`,
                true,
              ),
            );
          if (stableEntity?.manualAttributes)
            fieldRows.push(
              this.fieldValueRow(
                sourceRecordId,
                "attributes",
                stableEntity.manualAttributes,
                null,
                "MANUAL",
                `entity:${stableEntity.id}`,
                true,
              ),
            );

          let dealAmountCents = 0n;
          const counts = {
            FIXATION: 0,
            MEETING: 0,
            DEAL: 0,
            BROKER_TOUR: 0,
            CALL: 0,
          };
          for (const activity of record.activities) {
            activityRows.push({
              id: randomUUID(),
              snapshotId: snapshot.id,
              sourceRecordId,
              externalIdentityId: activity.externalIdentityId
                ? identityIdByExternal.get(
                    `${activity.sourceSystem}:${activity.externalIdentityId}`,
                  ) || null
                : null,
              sourceSystem: activity.sourceSystem,
              sourceExternalId: activity.externalId,
              type: activity.type,
              occurredAt: new Date(activity.occurredAt),
              amount: activity.amount || null,
              currency: activity.currency,
              contractType: activity.contractType || null,
              verdict: activity.verdict,
              reasonCode: activity.reasonCode || null,
              ruleVersion: dto.ruleVersion,
              sourcePayloadHash: loyaltyContentHash(activity),
              metadata: activity.metadata || undefined,
            });
            if (activity.verdict === "INCLUDED") {
              counts[activity.type as keyof typeof counts]++;
              if (activity.type === "DEAL")
                dealAmountCents += moneyToCents(activity.amount);
            }
          }
          metricRows.push({
            id: randomUUID(),
            sourceRecordId,
            ruleVersion: dto.ruleVersion,
            fixationCount: counts.FIXATION,
            meetingCount: counts.MEETING,
            dealCount: counts.DEAL,
            brokerTourCount: counts.BROKER_TOUR,
            callCount: counts.CALL,
            activityEvidenceCount: record.activities.length,
            dealAmount: centsToMoney(dealAmountCents),
          });
          if (record.sourceAggregate) {
            const aggregate = record.sourceAggregate;
            sourceAggregateRows.push({
              id: randomUUID(),
              sourceRecordId,
              sourceKind: aggregate.sourceKind,
              sourceVersion: aggregate.sourceVersion,
              sourceLabel: aggregate.sourceLabel || null,
              quality: aggregate.quality,
              exactness: aggregate.exactness,
              periodKind: aggregate.periodKind,
              periodFrom: aggregate.periodFrom
                ? new Date(aggregate.periodFrom)
                : null,
              periodTo: aggregate.periodTo
                ? new Date(aggregate.periodTo)
                : null,
              contributesToSourceSummary: aggregate.contributesToSourceSummary,
              fixationCount: aggregate.fixationCount ?? null,
              meetingCount: aggregate.meetingCount ?? null,
              dealCount: aggregate.dealCount ?? null,
              brokerTourCount: aggregate.brokerTourCount ?? null,
              callCount: aggregate.callCount ?? null,
              dealAmount: aggregate.dealAmount ?? null,
              currency: aggregate.currency ?? null,
              lastFixationAt: aggregate.lastFixationAt
                ? new Date(aggregate.lastFixationAt)
                : null,
              lastMeetingAt: aggregate.lastMeetingAt
                ? new Date(aggregate.lastMeetingAt)
                : null,
              lastDealAt: aggregate.lastDealAt
                ? new Date(aggregate.lastDealAt)
                : null,
              lastCallAt: aggregate.lastCallAt
                ? new Date(aggregate.lastCallAt)
                : null,
              brokerTourVisited: aggregate.brokerTourVisited ?? null,
              brokerTourAt: aggregate.brokerTourAt
                ? new Date(aggregate.brokerTourAt)
                : null,
              dealsByMonth: aggregate.dealsByMonth,
              callBreakdown: aggregate.callBreakdown,
              provenance: aggregate.provenance,
              reportedAt: aggregate.reportedAt
                ? new Date(aggregate.reportedAt)
                : null,
            });
          }
          for (const role of record.organizationRoles) {
            roleRows.push({
              id: randomUUID(),
              personId: personByKey.get(record.externalKey),
              organizationId: organizationByKey.get(
                role.organizationExternalKey,
              ),
              sourceRecordId,
              role: role.role,
              isPrimary: role.isPrimary,
              validFrom: role.validFrom ? new Date(role.validFrom) : new Date(),
              validTo: role.validTo ? new Date(role.validTo) : null,
              sourceSystem: "ANNA_FILE",
              evidence: role.evidence || undefined,
            });
          }
        }
        await this.createManyInChunks(tx.loyaltyContactPoint, contactRows);
        await this.createManyInChunks(tx.loyaltyExternalIdentity, identityRows);
        await this.createManyInChunks(tx.loyaltyActivity, activityRows);
        await this.createManyInChunks(tx.loyaltyMetricSnapshot, metricRows);
        await this.createManyInChunks(
          tx.loyaltySourceAggregate,
          sourceAggregateRows,
        );
        await this.createManyInChunks(tx.loyaltySourceFieldValue, fieldRows);
        await this.createManyInChunks(
          tx.loyaltyPersonOrganizationRole,
          roleRows,
        );

        const caseRows = candidates.map((candidate) => {
          const record = prepared.records.find(
            (item) => item.externalKey === candidate.recordExternalKey,
          )!;
          return {
            id: randomUUID(),
            datasetId: dataset.id,
            snapshotId: snapshot.id,
            personId:
              record.entityType === "BROKER"
                ? personByKey.get(record.externalKey)
                : null,
            organizationId:
              record.entityType === "AGENCY"
                ? organizationByKey.get(record.externalKey)
                : null,
            targetType: candidate.targetType,
            targetId: candidate.targetId,
            matchCodes: candidate.matchCodes,
            evidence: { matchCodes: candidate.matchCodes },
            score: candidate.score,
            ruleVersion: dto.ruleVersion,
          };
        });
        await this.createManyInChunks(tx.loyaltyReconciliationCase, caseRows);
        return {
          snapshotId: snapshot.id,
          contentHash: snapshot.contentHash,
          status: snapshot.status,
          summary: snapshotSummary,
          expectedActiveSnapshotId: dataset.activeSnapshotId || null,
          issues: [],
        };
      },
      {
        isolationLevel: "Serializable" as any,
        maxWait: 10_000,
        timeout: 120_000,
      },
    );
  }

  private fieldValueRow(
    sourceRecordId: string,
    fieldName: string,
    rawValue: unknown,
    normalizedValue: string | null,
    sourceSystem: string,
    sourceExternalId?: string,
    lockedByUser = false,
  ) {
    const safeValue = sanitizeJson(rawValue);
    return {
      id: randomUUID(),
      sourceRecordId,
      fieldName,
      rawValue: safeValue,
      normalizedValue,
      valueHash: loyaltyContentHash(safeValue),
      sourceSystem,
      sourceExternalId: sourceExternalId || null,
      lockedByUser,
    };
  }

  async publishSnapshot(
    snapshotId: string,
    dto: LoyaltyPublishDto,
    actorId?: string,
  ) {
    if (dto.confirmed !== true)
      throw new BadRequestException("confirmed=true is required");
    if (!dto.expectedContentHash)
      throw new BadRequestException("expectedContentHash is required");
    return this.prisma.$transaction(
      async (tx: any) => {
        const snapshot = await tx.loyaltySnapshot.findUnique({
          where: { id: snapshotId },
          include: { dataset: true },
        });
        if (!snapshot || snapshot.dataset.code !== ANNA_DATASET_CODE)
          throw new NotFoundException("Snapshot not found");
        if (snapshot.contentHash !== dto.expectedContentHash)
          throw new ConflictException("Snapshot hash mismatch");
        if (!["STAGED", "SUPERSEDED", "PUBLISHED"].includes(snapshot.status)) {
          throw new ConflictException(
            `Snapshot cannot be published from ${snapshot.status}`,
          );
        }
        if (snapshot.errorCount !== 0)
          throw new ConflictException("Snapshot contains import errors");
        if (
          snapshot.expectedRecords === null ||
          snapshot.expectedRecords === undefined
        ) {
          throw new ConflictException(
            "Snapshot expected record count is missing",
          );
        }
        if (snapshot.expectedRecords !== snapshot.recordCount) {
          throw new ConflictException("Snapshot coverage is incomplete");
        }
        const summary =
          snapshot.summary && typeof snapshot.summary === "object"
            ? (snapshot.summary as any)
            : {};
        const [
          actualRecords,
          actualBrokers,
          actualAgencies,
          actualContactPoints,
          actualExternalIdentities,
          actualActivities,
          actualMetrics,
          actualSourceAggregates,
          actualOrganizationRoles,
          actualReconciliationCases,
        ] = await Promise.all([
          tx.loyaltySourceRecord.count({ where: { snapshotId } }),
          tx.loyaltySourceRecord.count({
            where: { snapshotId, entityType: "BROKER" },
          }),
          tx.loyaltySourceRecord.count({
            where: { snapshotId, entityType: "AGENCY" },
          }),
          tx.loyaltyContactPoint.count({
            where: { sourceRecord: { snapshotId } },
          }),
          tx.loyaltyExternalIdentity.count({
            where: { sourceRecord: { snapshotId } },
          }),
          tx.loyaltyActivity.count({ where: { snapshotId } }),
          tx.loyaltyMetricSnapshot.count({
            where: {
              sourceRecord: { snapshotId },
              ruleVersion: snapshot.ruleVersion,
            },
          }),
          tx.loyaltySourceAggregate.count({
            where: { sourceRecord: { snapshotId } },
          }),
          tx.loyaltyPersonOrganizationRole.count({
            where: { sourceRecord: { snapshotId } },
          }),
          tx.loyaltyReconciliationCase.count({ where: { snapshotId } }),
        ]);
        const expectedCounts: Array<{
          name: string;
          actual: number;
          expected: number;
        }> = [
          {
            name: "records",
            actual: actualRecords,
            expected: snapshot.recordCount,
          },
          {
            name: "brokers",
            actual: actualBrokers,
            expected: snapshot.brokerCount,
          },
          {
            name: "agencies",
            actual: actualAgencies,
            expected: snapshot.agencyCount,
          },
          {
            name: "contact points",
            actual: actualContactPoints,
            expected: Number(summary.contactPoints || 0),
          },
          {
            name: "external identities",
            actual: actualExternalIdentities,
            expected: Number(summary.externalIdentities || 0),
          },
          {
            name: "activities",
            actual: actualActivities,
            expected: snapshot.activityCount,
          },
          {
            name: "metric snapshots",
            actual: actualMetrics,
            expected: snapshot.recordCount,
          },
          {
            name: "source aggregates",
            actual: actualSourceAggregates,
            expected: Number(summary.sourceAggregates || 0),
          },
          {
            name: "organization roles",
            actual: actualOrganizationRoles,
            expected: Number(summary.organizationRoles || 0),
          },
          {
            name: "reconciliation cases",
            actual: actualReconciliationCases,
            expected: Number(summary.candidateCount || 0),
          },
        ];
        const incomplete = expectedCounts.find(
          ({ actual, expected }) => actual !== expected,
        );
        if (incomplete) {
          throw new ConflictException(
            `Snapshot ${incomplete.name} coverage is incomplete`,
          );
        }
        if (
          snapshot.dataset.activeSnapshotId === snapshot.id &&
          snapshot.status === "PUBLISHED"
        ) {
          return {
            snapshotId: snapshot.id,
            status: snapshot.status,
            contentHash: snapshot.contentHash,
            publishedAt: snapshot.publishedAt,
            previousSnapshotId: snapshot.id,
            summary: snapshot.summary,
            issues: [],
            idempotent: true,
          };
        }
        const previousSnapshotId = snapshot.dataset.activeSnapshotId;
        if ((previousSnapshotId || null) !== dto.expectedActiveSnapshotId) {
          throw new ConflictException(
            "Active snapshot changed; repeat stage before publish",
          );
        }
        if (previousSnapshotId && previousSnapshotId !== snapshot.id) {
          const previous = await tx.loyaltySnapshot.findUnique({
            where: { id: previousSnapshotId },
            select: {
              datasetId: true,
              recordCount: true,
              brokerCount: true,
              agencyCount: true,
              activityCount: true,
              summary: true,
            },
          });
          if (!previous || previous.datasetId !== snapshot.datasetId) {
            throw new ConflictException(
              "Dataset active snapshot pointer is invalid",
            );
          }
          const exactCoverageDrops = this.coverageDrops(
            this.snapshotCoverageDimensions(previous),
            this.snapshotCoverageDimensions(snapshot),
          );
          if (exactCoverageDrops.length && dto.confirmCoverageDrop !== true) {
            throw new ConflictException({
              message:
                "Snapshot coverage drop requires confirmation for this exact publish transition",
              currentPublishedRecords: previous.recordCount,
              stagedRecords: snapshot.recordCount,
              coverageDrops: exactCoverageDrops,
            });
          }
          await tx.loyaltySnapshot.update({
            where: { id: previousSnapshotId },
            data: { status: "SUPERSEDED" },
          });
        }
        const publishedAt = new Date();
        await tx.loyaltySnapshot.update({
          where: { id: snapshot.id },
          data: {
            status: "PUBLISHED",
            publishedAt,
            publishedById: actorId || null,
          },
        });
        await tx.loyaltyDataset.update({
          where: { id: snapshot.datasetId },
          data: { activeSnapshotId: snapshot.id },
        });
        await tx.loyaltyPublicationEvent.create({
          data: {
            datasetId: snapshot.datasetId,
            snapshotId: snapshot.id,
            previousSnapshotId: previousSnapshotId || null,
            contentHash: snapshot.contentHash,
            ruleVersion: snapshot.ruleVersion,
            isRollback: snapshot.status === "SUPERSEDED",
            actorId: actorId || null,
          },
        });
        return {
          snapshotId: snapshot.id,
          status: "PUBLISHED",
          contentHash: snapshot.contentHash,
          publishedAt,
          previousSnapshotId,
          summary: snapshot.summary,
          issues: [],
        };
      },
      {
        isolationLevel: "Serializable" as any,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  }

  private async activeAnnaSnapshot() {
    const dataset = await this.prisma.loyaltyDataset.findUnique({
      where: { code: ANNA_DATASET_CODE },
      include: { activeSnapshot: true },
    });
    return dataset?.activeSnapshot &&
      dataset.activeSnapshot.datasetId === dataset.id &&
      dataset.activeSnapshot.status === "PUBLISHED"
      ? { dataset, snapshot: dataset.activeSnapshot }
      : null;
  }

  private trustedFullSnapshotActivityCoverage(snapshot: any): {
    observedThrough: Date;
    observedThroughIso: string;
    syncCompletedAt: Date;
  } | null {
    const coverage = snapshot?.summary?.activityCoverage;
    if (
      !coverage ||
      coverage.mode !== "FULL_SNAPSHOT" ||
      coverage.verifiedBySyncRun !== true
    ) {
      return null;
    }
    if (
      !Number.isSafeInteger(Number(coverage.coveredRecords)) ||
      Number(coverage.coveredRecords) !== Number(snapshot.recordCount)
    ) {
      return null;
    }
    const types = new Set(
      Array.isArray(coverage.activityTypes) ? coverage.activityTypes : [],
    );
    if (!REQUIRED_ACTIVITY_COVERAGE_TYPES.every((type) => types.has(type))) {
      return null;
    }
    if (
      typeof coverage.sourceRunId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,100}$/.test(coverage.sourceRunId) ||
      typeof coverage.sourceContentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(coverage.sourceContentHash) ||
      typeof coverage.observedThrough !== "string" ||
      typeof coverage.syncCompletedAt !== "string"
    ) {
      return null;
    }
    const observedThrough = new Date(coverage.observedThrough);
    const syncCompletedAt = new Date(coverage.syncCompletedAt);
    if (
      !Number.isFinite(observedThrough.getTime()) ||
      !Number.isFinite(syncCompletedAt.getTime()) ||
      observedThrough.getTime() > syncCompletedAt.getTime()
    ) {
      return null;
    }
    return {
      observedThrough,
      observedThroughIso: observedThrough.toISOString(),
      syncCompletedAt,
    };
  }

  private fullSnapshotActivityCoverage(
    snapshot: any,
    requestedThrough?: Date,
  ): boolean {
    const coverage = this.trustedFullSnapshotActivityCoverage(snapshot);
    return Boolean(
      coverage &&
      (!requestedThrough ||
        requestedThrough.getTime() <= coverage.observedThrough.getTime()),
    );
  }

  private snapshotHasSourceAggregates(snapshot: any): boolean {
    return Number(snapshot?.summary?.sourceAggregates || 0) > 0;
  }

  async overview(baseInput: string, query: LoyaltyOverviewQueryDto) {
    const base = this.parseBase(baseInput);
    const period = this.parsePeriod(query);
    return base === "anna"
      ? this.annaOverview(period)
      : this.oursOverview(period);
  }

  private async annaOverview(period: { from: Date; to: Date }) {
    const active = await this.activeAnnaSnapshot();
    const periodDto = {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
    };
    if (!active) return this.emptyOverview("anna", periodDto);
    const manualFilter = this.normalizeListFilter(
      { archived: "exclude" } as LoyaltyListQueryDto,
      undefined,
    );
    const [manualBrokers, manualAgencies] = await Promise.all([
      this.annaManualRecords(
        active.dataset.id,
        active.snapshot.id,
        "BROKER",
        manualFilter,
      ),
      this.annaManualRecords(
        active.dataset.id,
        active.snapshot.id,
        "AGENCY",
        manualFilter,
      ),
    ]);
    const manualRecords = {
      brokers: manualBrokers,
      agencies: manualAgencies,
    };
    const snapshotId = active.snapshot.id;
    const currentWhere = (entityType: EntityType): any => ({
      snapshotId,
      entityType,
      sourceArchivedAt: null,
      ...(entityType === "BROKER"
        ? { person: { is: { archivedAt: null } } }
        : { organization: { is: { archivedAt: null } } }),
    });
    const activityWhere: any = {
      sourceRecord: {
        snapshotId,
        sourceArchivedAt: null,
        OR: [
          { entityType: "BROKER", person: { is: { archivedAt: null } } },
          { entityType: "AGENCY", organization: { is: { archivedAt: null } } },
        ],
      },
      occurredAt: { gte: period.from, lte: period.to },
      archivedAt: null,
      verdict: "INCLUDED",
    };
    const trustedCoverage = this.trustedFullSnapshotActivityCoverage(
      active.snapshot,
    );
    const now = new Date();
    const currentMonthRange = moscowCurrentMonthRange(now);
    // A snapshot is either event-derived or aggregate-derived for headline
    // KPIs. We never add source rollups to exact activities, which prevents
    // double counting. The source-reported rollups remain visible per record in
    // both modes for audit/comparison.
    if (
      !this.fullSnapshotActivityCoverage(active.snapshot, period.to) ||
      !trustedCoverage ||
      trustedCoverage.observedThrough.getTime() <
        currentMonthRange.from.getTime() ||
      manualBrokers.length > 0 ||
      manualAgencies.length > 0
    ) {
      return this.annaSourceAggregateOverview(active, periodDto, manualRecords);
    }
    const [
      brokerTotal,
      agencyTotal,
      fixations,
      meetings,
      deals,
      dealAmount,
      notCalled,
      newRows,
      btWithoutFixation,
      birthdayRows,
      brokerTop,
      agencyTop,
    ] = await Promise.all([
      this.prisma.loyaltySourceRecord.count({ where: currentWhere("BROKER") }),
      this.prisma.loyaltySourceRecord.count({ where: currentWhere("AGENCY") }),
      this.prisma.loyaltyActivity.count({
        where: { ...activityWhere, type: "FIXATION" },
      }),
      this.prisma.loyaltyActivity.count({
        where: { ...activityWhere, type: "MEETING" },
      }),
      this.prisma.loyaltyActivity.count({
        where: { ...activityWhere, type: "DEAL" },
      }),
      this.prisma.loyaltyActivity.aggregate({
        where: { ...activityWhere, type: "DEAL" },
        _sum: { amount: true },
      }),
      this.annaNotCalledCurrentMonthCount(
        active,
        trustedCoverage.observedThroughIso,
      ),
      this.prisma.loyaltySourceRecord.findMany({
        where: {
          ...currentWhere("BROKER"),
          AND: [
            this.annaNewStageFilter(),
            {
              person: {
                is: {
                  callAssignments: { none: { attempts: { some: {} } } },
                },
              },
            },
          ],
          activities: {
            none: {
              type: {
                in: ["CALL", "BROKER_TOUR", "FIXATION", "MEETING", "DEAL"],
              },
              verdict: "INCLUDED",
            },
          },
        },
        select: {
          contactPoints: {
            where: { type: "PHONE" },
            select: { value: true, normalizedValue: true },
          },
        },
      }),
      this.prisma.loyaltySourceRecord.count({
        where: {
          ...currentWhere("BROKER"),
          activities: {
            some: { type: "BROKER_TOUR", verdict: "INCLUDED" },
            none: { type: "FIXATION", verdict: "INCLUDED" },
          },
        },
      }),
      this.prisma.loyaltySourceRecord.findMany({
        where: currentWhere("BROKER"),
        select: { attributes: true },
      }),
      this.annaDealLeaders(snapshotId, "BROKER", period),
      this.annaDealLeaders(snapshotId, "AGENCY", period),
    ]);
    const newCount = (newRows as any[]).filter((row) =>
      hasLoyaltyAcquisitionPhone(row.contactPoints || []),
    ).length;
    const knownBirthdays = (birthdayRows as any[])
      .map((row) => annaBirthday(row.attributes))
      .filter(Boolean) as string[];
    const birthdaysToday = knownBirthdays.length
      ? knownBirthdays.filter(
          (birthday) => birthday === moscowDateParts().dayMonth,
        ).length
      : null;
    const sourceReportedView = await this.annaSourceAggregateOverview(
      active,
      periodDto,
    );
    return {
      base: "anna",
      period: periodDto,
      snapshot: {
        id: active.snapshot.id,
        publishedAt: active.snapshot.publishedAt,
        ruleVersion: active.snapshot.ruleVersion,
      },
      brokers: {
        total: brokerTotal,
        notCalledCurrentMonth: notCalled,
        newCount,
        btWithoutFixation,
        birthdaysToday,
        birthdayKnownCount: knownBirthdays.length,
        top: brokerTop,
      },
      agencies: { total: agencyTotal, top: agencyTop },
      activities: { fixations, meetings, deals },
      dealAmount: String(dealAmount._sum.amount || "0"),
      sourceReportedSummary: sourceReportedView.sourceReportedSummary,
      metricSource: {
        kind: "EXACT_ACTIVITIES",
        label: "Event-level activities",
        exactness: "EXACT",
        ruleVersion: active.snapshot.ruleVersion,
        observedThrough: trustedCoverage.observedThroughIso,
        periodFilterApplied: true,
      },
      kpiMetadata: this.annaKpiMetadata(
        "EXACT_ACTIVITIES",
        active.snapshot.ruleVersion,
        periodDto,
      ),
    };
  }

  private async annaNotCalledCurrentMonthCount(
    active: any,
    activityObservedThrough: string,
  ): Promise<number> {
    const include = this.annaRecordInclude(
      active.snapshot.id,
      active.snapshot.ruleVersion,
      false,
    );
    if (Number(active.snapshot.activityCount) > 0) {
      include.activities = {
        where: { archivedAt: null, verdict: "INCLUDED" },
        select: {
          type: true,
          occurredAt: true,
          amount: true,
          metadata: true,
        },
      };
    }
    const records = (await this.prisma.loyaltySourceRecord.findMany({
      where: {
        snapshotId: active.snapshot.id,
        entityType: "BROKER",
        sourceArchivedAt: null,
        person: { is: { archivedAt: null } },
      },
      include,
    })) as any[];
    const workflowCalls = await this.workflowCallReadModels(
      "anna",
      "BROKER",
      records.map((record) => this.workflowTargetId(record, "BROKER")),
    );
    this.attachWorkflowCallReadModels(records, "BROKER", workflowCalls);
    return records.reduce((total, record) => {
      const item = this.mapAnnaRecord(record, false, activityObservedThrough);
      return total + (this.isAnnaNotCalledCurrentMonth(record, item) ? 1 : 0);
    }, 0);
  }

  private async annaSourceAggregateOverview(
    active: any,
    periodDto: { from: string; to: string },
    manualRecords?: { brokers: any[]; agencies: any[] },
  ) {
    const snapshotId = active.snapshot.id;
    const activeOwner = (entityType: EntityType): any => ({
      snapshotId,
      entityType,
      sourceArchivedAt: null,
      ...(entityType === "BROKER"
        ? { person: { is: { archivedAt: null } } }
        : { organization: { is: { archivedAt: null } } }),
    });
    const [sourceBrokerTotal, sourceAgencyTotal, brokerRows, aggregateRows] =
      await Promise.all([
        this.prisma.loyaltySourceRecord.count({
          where: activeOwner("BROKER"),
        }),
        this.prisma.loyaltySourceRecord.count({
          where: activeOwner("AGENCY"),
        }),
        this.prisma.loyaltySourceRecord.findMany({
          where: activeOwner("BROKER"),
          select: {
            id: true,
            personId: true,
            displayName: true,
            attributes: true,
            contactPoints: {
              where: { type: "PHONE" },
              select: { value: true, normalizedValue: true },
            },
            person: { select: { manualDisplayName: true } },
            sourceAggregate: {
              select: {
                quality: true,
                contributesToSourceSummary: true,
                fixationCount: true,
                meetingCount: true,
                dealCount: true,
                brokerTourCount: true,
                callCount: true,
                lastCallAt: true,
                brokerTourVisited: true,
              },
            },
          },
        }),
        (this.prisma as any).loyaltySourceAggregate.findMany({
          where: {
            quality: "SOURCE_REPORTED",
            sourceRecord: {
              snapshotId,
              sourceArchivedAt: null,
              OR: [
                {
                  entityType: "BROKER",
                  person: { is: { archivedAt: null } },
                },
                {
                  entityType: "AGENCY",
                  organization: { is: { archivedAt: null } },
                },
              ],
            },
          },
          select: {
            sourceKind: true,
            sourceVersion: true,
            sourceLabel: true,
            quality: true,
            exactness: true,
            periodKind: true,
            contributesToSourceSummary: true,
            fixationCount: true,
            meetingCount: true,
            dealCount: true,
            brokerTourCount: true,
            callCount: true,
            dealAmount: true,
            lastDealAt: true,
            sourceRecord: {
              select: {
                entityType: true,
                personId: true,
                organizationId: true,
                displayName: true,
                person: { select: { manualDisplayName: true } },
                organization: { select: { manualDisplayName: true } },
              },
            },
          },
        }),
      ]);
    const rows = (aggregateRows || []) as any[];
    const includedRows = rows.filter(
      (row) => row.contributesToSourceSummary === true,
    );
    const sumNullable = (group: any[], field: string): number | null => {
      const values = group
        .map((row) => row[field])
        .filter((value) => value !== null && value !== undefined)
        .map(Number);
      return values.length
        ? values.reduce((sum, value) => sum + value, 0)
        : null;
    };
    const sumAmount = (group: any[]): string | null => {
      const amountValues = group
        .map((row) => row.dealAmount)
        .filter((value) => value !== null && value !== undefined)
        .map((value) => moneyToCents(String(value)));
      return amountValues.length
        ? centsToMoney(amountValues.reduce((sum, value) => sum + value, 0n))
        : null;
    };
    const manualBrokers = manualRecords?.brokers || [];
    const manualAgencies = manualRecords?.agencies || [];
    const brokers = (brokerRows as any[]) || [];
    const knownBirthdays = [...brokers, ...manualBrokers]
      .map((row) => annaBirthday(row.attributes))
      .filter(Boolean) as string[];
    const birthdaysToday = knownBirthdays.length
      ? knownBirthdays.filter(
          (birthday) => birthday === moscowDateParts().dayMonth,
        ).length
      : null;
    const currentMonth = { ...moscowCurrentMonthRange(), to: new Date() };
    const sourceReportedBrokers = brokers.filter(
      (row) =>
        row.sourceAggregate?.quality === "SOURCE_REPORTED" &&
        row.sourceAggregate?.contributesToSourceSummary === true,
    );
    // A zero callsMayAugust rollup only means that the dated legacy breakdown
    // is empty. It is not evidence that the broker has never been called.
    const sourceReportedCallKnown = sourceReportedBrokers.filter(
      (row) => row.sourceAggregate.lastCallAt != null,
    );
    const notCalledCandidates = sourceReportedCallKnown.filter(
      (row) => new Date(row.sourceAggregate.lastCallAt) < currentMonth.from,
    );
    const newCount = sourceReportedBrokers.filter((row) => {
      const attributes = row.attributes || {};
      const stage =
        attributes.relationshipStage ||
        attributes.stage ||
        attributes.crm?.relationshipStage;
      const aggregate = row.sourceAggregate;
      return (
        ["NEW", "NEW_BROKER", "Новый"].includes(stage) &&
        [
          aggregate.brokerTourCount,
          aggregate.fixationCount,
          aggregate.meetingCount,
          aggregate.dealCount,
        ].every((value) => value === 0) &&
        aggregate.callCount === 0 &&
        aggregate.lastCallAt == null &&
        hasLoyaltyAcquisitionPhone(row.contactPoints || [])
      );
    }).length;
    const btWithoutFixation = sourceReportedBrokers.filter(
      (row) =>
        row.sourceAggregate.brokerTourVisited === true &&
        row.sourceAggregate.fixationCount === 0,
    ).length;
    const rowsFor = (entityType: EntityType) =>
      includedRows.filter((row) => row.sourceRecord?.entityType === entityType);
    const leader = (entityType: EntityType) =>
      rowsFor(entityType)
        .filter((row) => row.dealCount !== null && row.dealCount !== undefined)
        .sort((left, right) => {
          const dealDifference =
            Number(right.dealCount) - Number(left.dealCount);
          if (dealDifference) return dealDifference;
          const rightAmount = moneyToCents(String(right.dealAmount || "0"));
          const leftAmount = moneyToCents(String(left.dealAmount || "0"));
          return rightAmount === leftAmount
            ? 0
            : rightAmount > leftAmount
              ? 1
              : -1;
        })
        .slice(0, 5)
        .map((row) => ({
          id: row.sourceRecord.personId || row.sourceRecord.organizationId,
          name:
            row.sourceRecord.person?.manualDisplayName ||
            row.sourceRecord.organization?.manualDisplayName ||
            row.sourceRecord.displayName ||
            "—",
          entityType,
          deals: Number(row.dealCount),
          dealAmount:
            row.dealAmount === null || row.dealAmount === undefined
              ? null
              : String(row.dealAmount),
          latestDealAt: row.lastDealAt || null,
        }));
    const sourceVersions = Array.from(
      new Set(
        includedRows.map((row) => `${row.sourceKind}:${row.sourceVersion}`),
      ),
    ).sort();
    const sourceGroup = (entityType: EntityType) => {
      const group = rowsFor(entityType);
      const known = (field: string) =>
        group.filter((row) => row[field] !== null && row[field] !== undefined)
          .length;
      return {
        kind: "SOURCE_AGGREGATE",
        label:
          group.find((row) => row.sourceLabel)?.sourceLabel ||
          (entityType === "BROKER"
            ? "Данные среза Анны — брокеры"
            : "Данные среза Анны — агентства"),
        confirmationStatus: "NOT_CONFIRMED",
        quality: "SOURCE_REPORTED",
        exactness: Array.from(
          new Set(group.map((row) => row.exactness)),
        ).sort(),
        periodKinds: Array.from(
          new Set(group.map((row) => row.periodKind)),
        ).sort(),
        sourceVersions: Array.from(
          new Set(group.map((row) => `${row.sourceKind}:${row.sourceVersion}`)),
        ).sort(),
        periodFilterApplied: false,
        records: group.length,
        fixations: sumNullable(group, "fixationCount"),
        fixationKnownRecords: known("fixationCount"),
        meetings: sumNullable(group, "meetingCount"),
        meetingKnownRecords: known("meetingCount"),
        deals: sumNullable(group, "dealCount"),
        dealKnownRecords: known("dealCount"),
        brokerTours: sumNullable(group, "brokerTourCount"),
        brokerTourKnownRecords: known("brokerTourCount"),
        calls: sumNullable(group, "callCount"),
        callKnownRecords: known("callCount"),
        dealAmount: sumAmount(group),
        dealAmountKnownRecords: known("dealAmount"),
        top: leader(entityType),
      };
    };
    return {
      base: "anna",
      period: periodDto,
      snapshot: {
        id: active.snapshot.id,
        publishedAt: active.snapshot.publishedAt,
        ruleVersion: active.snapshot.ruleVersion,
      },
      brokers: {
        total: Number(sourceBrokerTotal) + manualBrokers.length,
        notCalledCurrentMonth: null,
        newCount: null,
        btWithoutFixation: null,
        birthdaysToday,
        birthdayKnownCount: knownBirthdays.length,
        top: [],
      },
      agencies: {
        total: Number(sourceAgencyTotal) + manualAgencies.length,
        top: [],
      },
      activities: {
        fixations: null,
        meetings: null,
        deals: null,
      },
      dealAmount: null,
      metricSource: {
        kind: "UNAVAILABLE",
        label: "Exact event-level KPI is unavailable for this snapshot",
        exactness: "UNKNOWN",
        ruleVersion: active.snapshot.ruleVersion,
        periodFilterApplied: false,
        requestedPeriod: periodDto,
      },
      sourceReportedSummary: {
        kind: "SOURCE_AGGREGATE",
        label: "Данные среза Анны",
        confirmationStatus: "NOT_CONFIRMED",
        quality: "SOURCE_REPORTED",
        exactness: Array.from(
          new Set(includedRows.map((row) => row.exactness)),
        ).sort(),
        sourceVersions,
        periodFilterApplied: false,
        requestedPeriod: periodDto,
        warning:
          "Source snapshot rollups are shown separately; broker and agency groups may overlap and are never added together.",
        brokers: {
          ...sourceGroup("BROKER"),
          notCalledCurrentMonth: sourceReportedCallKnown.length
            ? notCalledCandidates.length
            : null,
          notCalledKnownCount: sourceReportedCallKnown.length,
          newCount,
          btWithoutFixation,
        },
        agencies: sourceGroup("AGENCY"),
      },
      kpiMetadata: this.annaKpiMetadata(
        "UNAVAILABLE",
        active.snapshot.ruleVersion,
        periodDto,
      ),
    };
  }

  private annaKpiMetadata(
    basis: "EXACT_ACTIVITIES" | "UNAVAILABLE",
    ruleVersion: string,
    period: { from: string; to: string },
  ) {
    const exact = basis === "EXACT_ACTIVITIES";
    const shared = {
      source: basis,
      ruleVersion,
      exactness: exact ? "EXACT" : "UNKNOWN",
      requestedPeriod: period,
      periodFilterApplied: exact,
      includedSemantics: exact
        ? "Only event rows with verdict=INCLUDED and archivedAt=null"
        : "No event-level evidence is available",
      excludedSemantics: exact
        ? "EXCLUDED/UNKNOWN and archived event rows are excluded"
        : "Source rollups are not promoted to confirmed activity KPIs",
    };
    const sourceShared = {
      source: "SOURCE_AGGREGATE",
      ruleVersion,
      confirmationStatus: "NOT_CONFIRMED",
      exactness: "SOURCE_DECLARED",
      requestedPeriod: period,
      periodFilterApplied: false,
      includedSemantics:
        "Only quality=SOURCE_REPORTED and contributesToSourceSummary=true, grouped by entity type",
      excludedSemantics:
        "PARTIAL/UNVERIFIED and non-included rollups are excluded; broker and agency groups are never added together",
    };
    return {
      "activities.fixations": {
        ...shared,
        formula: exact
          ? "COUNT(included FIXATION events in requested period)"
          : "Unavailable without identified FIXATION events",
      },
      "activities.meetings": {
        ...shared,
        formula: exact
          ? "COUNT(included MEETING events in requested period)"
          : "Unavailable without identified MEETING events",
      },
      "activities.deals": {
        ...shared,
        formula: exact
          ? "COUNT(included DEAL events in requested period)"
          : "Unavailable without identified DEAL events",
      },
      dealAmount: {
        ...shared,
        formula: exact
          ? "SUM(amount) for included RUB DDU DEAL events in requested period"
          : "Unavailable without identified included RUB DDU DEAL events",
      },
      "brokers.notCalledCurrentMonth": {
        ...shared,
        formula: exact
          ? "No included CALL event in current Moscow month"
          : "Unavailable as a confirmed KPI without identified CALL events",
      },
      "brokers.newCount": {
        ...shared,
        formula: exact
          ? "Relationship stage is NEW/NEW_BROKER and no included BT, fixation, meeting or deal event exists"
          : "Unavailable as a confirmed KPI without identified events",
      },
      "brokers.btWithoutFixation": {
        ...shared,
        formula: exact
          ? "Included BROKER_TOUR exists and no included FIXATION exists"
          : "Unavailable as a confirmed KPI without identified events",
      },
      "brokers.birthdaysToday": {
        source: "ANNA_SOURCE_ATTRIBUTES",
        ruleVersion,
        exactness: "SOURCE_DECLARED",
        requestedPeriod: period,
        periodFilterApplied: false,
        formula: "Exact DD.MM comparison in Europe/Moscow",
        includedSemantics: "Only syntactically valid known birthdays",
        excludedSemantics:
          "Missing or malformed birthdays are unknown, not zero",
      },
      "brokers.top": {
        ...shared,
        formula: exact
          ? "Top five by included DDU deals in requested period, then included amount; no aggregate/event mixing"
          : "Unavailable without identified included DDU deal events",
      },
      "agencies.top": {
        ...shared,
        formula: exact
          ? "Top five agencies by included DDU deals in requested period, then included amount"
          : "Unavailable without identified included DDU deal events",
      },
      "sourceReportedSummary.brokers": {
        ...sourceShared,
        formula:
          "Per-field sums over BROKER source rows only; null remains unknown and is not coerced to zero",
      },
      "sourceReportedSummary.brokers.fixations": {
        ...sourceShared,
        formula:
          "SUM(source-reported fixationCount) for BROKER rows with known values; snapshot/lifetime, requested period not applied",
      },
      "sourceReportedSummary.brokers.meetings": {
        ...sourceShared,
        formula:
          "SUM(source-reported meetingCount) for BROKER rows with known values; snapshot/lifetime, requested period not applied",
      },
      "sourceReportedSummary.brokers.deals": {
        ...sourceShared,
        formula:
          "SUM(source-reported dealCount) for BROKER rows with known values; snapshot/lifetime, requested period not applied",
      },
      "sourceReportedSummary.brokers.brokerTours": {
        ...sourceShared,
        formula:
          "SUM(source-reported brokerTourCount) for BROKER rows with known values; snapshot/lifetime, requested period not applied",
      },
      "sourceReportedSummary.brokers.calls": {
        ...sourceShared,
        formula:
          "SUM(source-reported callCount) for BROKER rows with known values; snapshot/lifetime, requested period not applied",
      },
      "sourceReportedSummary.brokers.dealAmount": {
        ...sourceShared,
        formula:
          "Exact decimal sum in kopecks over source-reported BROKER dealAmount values; lifetime amount, requested period not applied",
      },
      "sourceReportedSummary.brokers.notCalledCurrentMonth": {
        ...sourceShared,
        formula:
          "COUNT(BROKER rows with a known lastCallAt before the current Moscow month); null when no lastCallAt is known",
        includedSemantics:
          "Only an explicit source lastCallAt is evidence for this derived source-snapshot segment",
        excludedSemantics:
          "callCount=0 or an empty callsMayAugust breakdown is not evidence that no call occurred",
      },
      "sourceReportedSummary.brokers.newCount": {
        ...sourceShared,
        formula:
          "COUNT(BROKER rows at explicit Новый/NEW stage with explicit zero BT, fixation, meeting and deal rollups)",
        includedSemantics:
          "Stage and every later-stage source count must be present and explicit",
        excludedSemantics:
          "Unknown counts are not coerced to zero and no stage is inferred from missing data",
      },
      "sourceReportedSummary.brokers.btWithoutFixation": {
        ...sourceShared,
        formula:
          "COUNT(BROKER rows with explicit brokerTourVisited=true and explicit fixationCount=0)",
        includedSemantics:
          "BT is accepted only from the source BT flag/date, never inferred from another rollup",
        excludedSemantics:
          "Unknown BT or fixation values are excluded rather than treated as false/zero",
      },
      "sourceReportedSummary.agencies": {
        ...sourceShared,
        formula:
          "Per-field sums over AGENCY source rows only; never added to broker rollups because source scopes may overlap",
      },
      "sourceReportedSummary.agencies.fixations": {
        ...sourceShared,
        formula:
          "SUM(source-reported fixationCount) for AGENCY rows with known values; kept separate from broker rollups",
      },
      "sourceReportedSummary.agencies.meetings": {
        ...sourceShared,
        formula:
          "SUM(source-reported meetingCount) for AGENCY rows with known values; kept separate from broker rollups",
      },
      "sourceReportedSummary.agencies.deals": {
        ...sourceShared,
        formula:
          "SUM(source-reported dealCount) for AGENCY rows with known values; snapshot/lifetime, requested period not applied",
      },
      "sourceReportedSummary.agencies.brokerTours": {
        ...sourceShared,
        formula:
          "SUM(source-reported brokerTourCount) for AGENCY rows with known values; kept separate from broker rollups",
      },
      "sourceReportedSummary.agencies.calls": {
        ...sourceShared,
        formula:
          "SUM(source-reported callCount) for AGENCY rows with known values; kept separate from broker rollups",
      },
      "sourceReportedSummary.agencies.dealAmount": {
        ...sourceShared,
        formula:
          "Exact decimal sum in kopecks over source-reported AGENCY dealAmount values; never added to broker amounts",
      },
      "sourceReportedSummary.brokers.top": {
        ...sourceShared,
        formula:
          "Source-snapshot/lifetime top five broker rows by reported deal count then reported amount; requested period is not applied",
      },
      "sourceReportedSummary.agencies.top": {
        ...sourceShared,
        formula:
          "Source-snapshot/lifetime top five agency rows by reported deal count then reported amount; requested period is not applied",
      },
    };
  }

  private async annaDealLeaders(
    snapshotId: string,
    entityType: EntityType,
    period: { from: Date; to: Date },
  ) {
    const groups = await (this.prisma.loyaltyActivity as any).groupBy({
      by: ["sourceRecordId"],
      where: {
        sourceRecord: {
          snapshotId,
          entityType,
          sourceArchivedAt: null,
          ...(entityType === "BROKER"
            ? { person: { is: { archivedAt: null } } }
            : { organization: { is: { archivedAt: null } } }),
        },
        type: "DEAL",
        occurredAt: { gte: period.from, lte: period.to },
        archivedAt: null,
        verdict: "INCLUDED",
      },
      _count: { sourceRecordId: true },
      _sum: { amount: true },
      _max: { occurredAt: true },
      orderBy: [
        { _count: { sourceRecordId: "desc" } },
        { _sum: { amount: "desc" } },
        { _max: { occurredAt: "desc" } },
        { sourceRecordId: "asc" },
      ],
      take: 5,
    });
    if (!groups.length) return [];
    const records = await this.prisma.loyaltySourceRecord.findMany({
      where: { id: { in: groups.map((group: any) => group.sourceRecordId) } },
      include: { person: true, organization: true },
    });
    const byId = new Map(
      (records as any[]).map((record) => [record.id, record]),
    );
    return groups.map((group: any) => {
      const record: any = byId.get(group.sourceRecordId);
      return {
        id: record?.personId || record?.organizationId,
        name:
          record?.person?.manualDisplayName ||
          record?.organization?.manualDisplayName ||
          record?.displayName ||
          "—",
        entityType,
        deals: Number(group._count?.sourceRecordId || 0),
        dealAmount: String(group._sum?.amount || "0"),
        latestDealAt: group._max?.occurredAt || null,
      };
    });
  }

  private annaNewStageFilter(): any {
    return {
      OR: [
        { attributes: { path: ["relationshipStage"], equals: "NEW" } },
        { attributes: { path: ["relationshipStage"], equals: "NEW_BROKER" } },
        { attributes: { path: ["stage"], equals: "NEW" } },
        { attributes: { path: ["stage"], equals: "Новый" } },
        { attributes: { path: ["crm", "relationshipStage"], equals: "NEW" } },
      ],
    };
  }

  private async oursOverview(period: { from: Date; to: Date }) {
    const currentMonth = { ...moscowCurrentMonthRange(), to: new Date() };
    const periodDto = {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
    };
    // 2026-09-04: KPI блока брокеров считают только строки, чей владелец —
    // действующий брокер (role=BROKER, mergedIntoId=null) — ровно как список
    // брокеров при клике по плитке (дриллдаун openActivityDrilldown).
    const brokerOwner = { is: { role: "BROKER" as const, mergedIntoId: null } };
    const confirmedDeals = {
      ...this.ourConfirmedDealWhere(period),
      broker: brokerOwner,
    };
    const acceptedMeetings: any = {
      status: { in: ["CONFIRMED", "COMPLETED"] },
      date: { gte: period.from, lte: period.to },
      broker: brokerOwner,
    };
    // Реестровые сделки: в основной KPI попадают только привязанные к
    // действующему брокеру (иначе клик по плитке не найдёт их в списке);
    // остальные показываются отдельно как «+N без брокера» в метаданных.
    const registryAttributedWhere = {
      ...this.registrySignedAtWhere(period),
      brokerId: { not: null },
      broker: brokerOwner,
    };
    const [
      brokerTotal,
      agencyTotal,
      fixations,
      meetings,
      deals,
      registryDeals,
      registryDealsTotal,
      dealAmount,
      registryDealAmount,
      registryDealAmountTotal,
      notCalled,
      newRows,
      btWithoutFixation,
      birthdayRows,
      brokerTop,
      agencyTop,
    ] = await Promise.all([
      this.prisma.broker.count({
        where: { role: "BROKER", mergedIntoId: null },
      }),
      this.prisma.agency.count(),
      this.prisma.client.count({
        where: {
          ...FIXATION_CLIENT_WHERE,
          createdAt: { gte: period.from, lte: period.to },
          broker: brokerOwner,
        },
      }),
      this.prisma.meeting.count({ where: acceptedMeetings }),
      this.prisma.deal.count({ where: confirmedDeals }),
      // «Реестр сделок» — период по дате подписания договора.
      this.registryDealModel
        ? this.registryDealModel.count({ where: registryAttributedWhere })
        : Promise.resolve(0),
      this.registryDealModel
        ? this.registryDealModel.count({
            where: this.registrySignedAtWhere(period),
          })
        : Promise.resolve(0),
      this.prisma.deal.aggregate({
        where: confirmedDeals,
        _sum: { amount: true },
      }),
      // Сумма ₽ «Реестра сделок» за тот же период (только привязанные).
      this.registryDealModel
        ? this.registryDealModel.aggregate({
            where: registryAttributedWhere,
            _sum: { amount: true },
          })
        : Promise.resolve({ _sum: { amount: null } }),
      this.registryDealModel
        ? this.registryDealModel.aggregate({
            where: this.registrySignedAtWhere(period),
            _sum: { amount: true },
          })
        : Promise.resolve({ _sum: { amount: null } }),
      this.prisma.broker.count({
        where: {
          role: "BROKER",
          status: "ACTIVE",
          mergedIntoId: null,
          callLogs: {
            none: {
              createdAt: { gte: currentMonth.from, lte: currentMonth.to },
            },
          },
          loyaltyAssignmentsAsTarget: {
            none: {
              attempts: {
                some: {
                  occurredAt: { gte: currentMonth.from, lte: currentMonth.to },
                },
              },
            },
          },
        },
      }),
      this.prisma.broker.findMany({
        where: {
          role: "BROKER",
          status: "ACTIVE",
          mergedIntoId: null,
          funnelStage: "NEW_BROKER",
          brokerTourVisited: false,
          brokerTourDate: null,
          clients: { none: FIXATION_CLIENT_WHERE },
          meetings: { none: { status: { in: ["CONFIRMED", "COMPLETED"] } } },
          deals: { none: this.ourConfirmedDealWhere() },
          registryDeals: { none: {} },
          callLogs: { none: {} },
          loyaltyAssignmentsAsTarget: {
            none: { attempts: { some: {} } },
          },
          lastCallAt: null,
        },
        select: {
          phone: true,
          phones: { select: { phone: true } },
        },
      }),
      this.prisma.broker.count({
        where: {
          role: "BROKER",
          mergedIntoId: null,
          brokerTourVisited: true,
          clients: { none: FIXATION_CLIENT_WHERE },
        },
      }),
      this.prisma.broker.findMany({
        where: { role: "BROKER", mergedIntoId: null, birthDate: { not: null } },
        select: { birthDate: true },
      }),
      this.oursDealLeaders("BROKER", period),
      this.oursDealLeaders("AGENCY", period),
    ]);
    const newCount = (newRows as any[]).filter((row) =>
      hasLoyaltyAcquisitionPhone([row.phone, ...(row.phones || [])]),
    ).length;
    // Итог KPI «Сделки» = локальные подтверждённые DDU + привязанные к
    // брокеру строки реестра. Строки реестра без действующего брокера в
    // основное число не входят (плитка кликабельна и ведёт в список брокеров,
    // где таких строк нет) — их количество уходит в metadata как «+N».
    const totalDeals = Number(deals || 0) + Number(registryDeals || 0);
    const unattributedRegistryDeals = Math.max(
      0,
      Number(registryDealsTotal || 0) - Number(registryDeals || 0),
    );
    // Сумма ₽: реестр добавляется, только когда его сумма известна — иначе
    // строка Deal-суммы остаётся ровно прежней (без переформатирования).
    const registryAmount = (registryDealAmount as any)?._sum?.amount;
    const totalDealAmount =
      registryAmount === null || registryAmount === undefined
        ? String(dealAmount._sum.amount || "0")
        : centsToMoney(
            moneyToCents(String(dealAmount._sum.amount || "0")) +
              moneyToCents(String(registryAmount)),
          );
    const registryAmountTotal = (registryDealAmountTotal as any)?._sum?.amount;
    const unattributedRegistryAmount =
      registryAmountTotal === null || registryAmountTotal === undefined
        ? null
        : centsToMoney(
            moneyToCents(String(registryAmountTotal)) -
              moneyToCents(
                registryAmount === null || registryAmount === undefined
                  ? "0"
                  : String(registryAmount),
              ),
          );
    const today = moscowDateParts().dayMonth;
    const knownBirthdays = (birthdayRows as any[]).filter(
      (row) => row.birthDate,
    );
    const birthdaysToday = knownBirthdays.length
      ? knownBirthdays.filter((row) => {
          const date = new Date(row.birthDate);
          return (
            `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}` ===
            today
          );
        }).length
      : null;
    return {
      base: "ours",
      period: periodDto,
      snapshot: null,
      brokers: {
        total: brokerTotal,
        notCalledCurrentMonth: notCalled,
        newCount,
        btWithoutFixation,
        birthdaysToday,
        birthdayKnownCount: knownBirthdays.length,
        top: brokerTop,
      },
      agencies: { total: agencyTotal, top: agencyTop },
      activities: { fixations, meetings, deals: totalDeals },
      dealAmount: totalDealAmount,
      dataAvailability: {
        exactActivities: false,
        localPreliminary: true,
        sourceReportedAggregates: false,
        callPeriod: "LOCAL_PRELIMINARY_LEGACY_CALL_LOGS",
        activityPeriod: "LOCAL_PRELIMINARY",
        exactness: "APPROXIMATE",
        unknownValuesRemainNull: true,
      },
      metricSource: {
        kind: "LOCAL_PRELIMINARY",
        label: "Current local operational rows",
        exactness: "APPROXIMATE",
        ruleVersion: "ours-local-preliminary-v1",
        periodFilterApplied: true,
        requestedPeriod: periodDto,
        contributingRecords:
          Number(fixations || 0) + Number(meetings || 0) + totalDeals,
        sourceVersions: ["LOCAL_DB:CURRENT"],
        methodology:
          "Local operational tables with per-KPI definitions below; no amoCRM or Anna snapshot exactness is inferred",
      },
      kpiMetadata: this.oursKpiMetadata(periodDto, {
        unattributedRegistryDeals,
        unattributedRegistryAmount,
      }),
    };
  }

  private oursKpiMetadata(
    period: { from: string; to: string },
    registryGap: {
      unattributedRegistryDeals: number;
      unattributedRegistryAmount: string | null;
    } = { unattributedRegistryDeals: 0, unattributedRegistryAmount: null },
  ) {
    const shared = {
      source: "LOCAL_PRELIMINARY",
      ruleVersion: "ours-local-preliminary-v1",
      exactness: "APPROXIMATE",
      requestedPeriod: period,
      periodFilterApplied: true,
      includedSemantics:
        "Qualifying rows in current local operational tables only",
      excludedSemantics:
        "Anna source rollups, unconfirmed statuses and missing values are excluded; missing evidence is never promoted to exactness",
    };
    return {
      "activities.fixations": {
        ...shared,
        formula:
          "COUNT(Client rows fixed for an active broker (uniquenessStatus=CONDITIONALLY_UNIQUE or fixationStatus=FIXED, owner role=BROKER without merge) with createdAt in requested period)",
        provenance: "Client.id / Client.createdAt / Broker.role",
      },
      "activities.meetings": {
        ...shared,
        formula:
          "COUNT(Meeting rows with status CONFIRMED or COMPLETED, date in requested period and owner role=BROKER without merge)",
        provenance: "Meeting.id / Meeting.date / Meeting.status / Broker.role",
      },
      "activities.deals": {
        ...shared,
        formula: `COUNT(positive DDU Deal rows with status SIGNED, PAID or COMMISSION_PAID, signedAt in requested period and owner role=BROKER without merge) + COUNT(RegistryDeal rows with signedAt in requested period linked to such a broker)${registryGap.unattributedRegistryDeals ? `; excludes ${registryGap.unattributedRegistryDeals} registry deal(s) without an attributable broker (не видны в списке брокеров)` : ""}`,
        provenance: "Deal.id / Deal.signedAt / Deal.status / RegistryDeal.brokerId",
        unattributedRegistryDeals: registryGap.unattributedRegistryDeals,
      },
      dealAmount: {
        ...shared,
        formula: `Exact-decimal SUM(Deal.amount) over the same local qualifying DDU deal rows plus SUM(RegistryDeal.amount) over broker-attributed registry rows signed in the requested period${registryGap.unattributedRegistryDeals ? `; excludes ${registryGap.unattributedRegistryDeals} registry deal(s) without an attributable broker${registryGap.unattributedRegistryAmount ? ` totalling ${registryGap.unattributedRegistryAmount}` : ""}` : ""}`,
        provenance: "Deal.id / Deal.amount / RegistryDeal.brokerId",
        unattributedRegistryDeals: registryGap.unattributedRegistryDeals,
        unattributedRegistryAmount: registryGap.unattributedRegistryAmount,
      },
      "brokers.notCalledCurrentMonth": {
        ...shared,
        periodFilterApplied: false,
        formula:
          "COUNT(active, unmerged BROKER rows with no legacy CallLog.createdAt in the current Europe/Moscow month)",
        includedSemantics:
          "Legacy CallLog rows only; the current Moscow month is used instead of the requested rating period",
        excludedSemantics:
          "Workflow attempts are not part of this overview query, so this is preliminary rather than an exact no-call fact",
        provenance: "Broker.id / CallLog.createdAt",
      },
      "brokers.newCount": {
        ...shared,
        periodFilterApplied: false,
        formula:
          "COUNT(active, unmerged BROKER rows at NEW_BROKER with no BT flag/date and no qualifying local fixation, meeting or deal row)",
        provenance:
          "Broker.funnelStage / Broker.brokerTourVisited / Client / Meeting / Deal",
      },
      "brokers.btWithoutFixation": {
        ...shared,
        periodFilterApplied: false,
        formula:
          "COUNT(active, unmerged BROKER rows with brokerTourVisited=true and no fixed Client row (uniquenessStatus=CONDITIONALLY_UNIQUE or fixationStatus=FIXED))",
        provenance:
          "Broker.brokerTourVisited / Client.uniquenessStatus / Client.fixationStatus",
      },
      "brokers.birthdaysToday": {
        source: "LOCAL_PRELIMINARY",
        ruleVersion: "ours-local-preliminary-v1",
        exactness: "APPROXIMATE",
        requestedPeriod: period,
        periodFilterApplied: false,
        formula:
          "COUNT(known Broker.birthDate values whose UTC day/month equals today's Europe/Moscow day/month)",
        includedSemantics: "Only known local birthDate values",
        excludedSemantics:
          "Missing birthdays remain unknown; birthdaysToday is null when none are known",
        provenance: "Broker.birthDate",
      },
      "brokers.top": {
        ...shared,
        formula:
          "Top five by combined qualifying local DDU deal count plus RegistryDeal rows signed in the period, then amount, latest signedAt and stable broker ID",
        provenance: "Deal.brokerId / Deal.id / Deal.amount / Deal.signedAt",
      },
      "agencies.top": {
        ...shared,
        formula:
          "Top five by the agency-card rule: union of qualifying local DDU deals with an explicit Deal.agencyId, deals owned by current BrokerAgency brokers, and RegistryDeal rows attributed via those brokers or via a normalized agency-name match, deduplicated by row ID",
        provenance:
          "Deal.agencyId / Deal.brokerId / Deal.id / RegistryDeal.brokerId / RegistryDeal.agencyCanonical",
      },
      "brokers.total": {
        ...shared,
        periodFilterApplied: false,
        formula: "COUNT(Broker where role=BROKER and mergedIntoId is null)",
        provenance: "Broker.id / Broker.role / Broker.mergedIntoId",
      },
      "agencies.total": {
        ...shared,
        periodFilterApplied: false,
        formula: "COUNT(current Agency rows)",
        provenance: "Agency.id",
      },
    };
  }

  /**
   * Топ-5 «нашей базы» по сделкам за период: Deal-таблица + «Реестр сделок».
   * Брокер реестра — по registry_deals.brokerId. Агентство — по правилу
   * карточки: Deal с явным agencyId + Deal брокеров агентства + реестр через
   * broker_agencies его брокеров и по нормализованному названию (то же
   * правило, что и в attachOurAgencyRegistryDeals), с дедупом по id строки.
   * Слияние и ранжирование — в памяти, объём ограничен числом строк с
   * продажами за период.
   */
  private async oursDealLeaders(
    entityType: EntityType,
    period: { from: Date; to: Date },
  ) {
    const groupField = entityType === "BROKER" ? "brokerId" : "agencyId";
    const totals = new Map<
      string,
      { deals: number; amountCents: bigint; latestAt: Date | null }
    >();
    const add = (
      id: unknown,
      deals: number,
      amount: unknown,
      latest: unknown,
    ) => {
      const key = String(id || "");
      if (!key || !deals) return;
      const target = totals.get(key) || {
        deals: 0,
        amountCents: 0n,
        latestAt: null,
      };
      target.deals += deals;
      if (amount !== null && amount !== undefined) {
        target.amountCents += moneyToCents(String(amount));
      }
      const latestDate =
        latest instanceof Date
          ? latest
          : latest
            ? new Date(latest as any)
            : null;
      if (
        latestDate &&
        Number.isFinite(latestDate.getTime()) &&
        (!target.latestAt || target.latestAt < latestDate)
      ) {
        target.latestAt = latestDate;
      }
      totals.set(key, target);
    };
    if (entityType === "BROKER") {
      const dealGroups = await (this.prisma.deal as any).groupBy({
        by: [groupField],
        where: {
          ...this.ourConfirmedDealWhere(period),
          broker: { is: { role: "BROKER", mergedIntoId: null } },
        },
        _count: { [groupField]: true },
        _sum: { amount: true },
        _max: { signedAt: true },
      });
      for (const group of dealGroups as any[]) {
        add(
          group[groupField],
          Number(group._count?.[groupField] || 0),
          group._sum?.amount,
          group._max?.signedAt,
        );
      }
      if (this.registryDealModel) {
        const registryGroups = await this.registryDealModel.groupBy({
          by: ["brokerId"],
          where: {
            brokerId: { not: null },
            broker: { is: { role: "BROKER", mergedIntoId: null } },
            ...this.registrySignedAtWhere(period),
          },
          _count: { _all: true },
          _sum: { amount: true },
          _max: { signedAt: true },
        });
        for (const group of registryGroups as any[]) {
          add(
            group.brokerId,
            Number(group._count?._all || 0),
            group._sum?.amount,
            group._max?.signedAt,
          );
        }
      }
    } else {
      // 2026-09-04: KPI «Топ-агентство» считается тем же правилом, что и
      // карточка агентства (ourAgencyRelationMetrics + attachOurAgency-
      // RegistryDeals): union из Deal с явным agencyId, Deal брокеров
      // агентства (broker_agencies) и строк реестра — по brokerId этих
      // брокеров И по нормализованному названию (canonicalAgencyMatchKey =
      // normalizeAgencyMatchKey + AGENCY_KEY_ALIASES).
      // Дедуп по id строки: сделка не считается дважды, если пришла и через
      // agencyId, и через брокера, или через брокера и название.
      const seenByAgency = new Map<string, Set<string>>();
      const addRow = (
        agencyId: unknown,
        rowKey: string,
        amount: unknown,
        signedAt: unknown,
      ) => {
        const id = String(agencyId || "");
        if (!id) return;
        const seen = seenByAgency.get(id) || new Set<string>();
        if (seen.has(rowKey)) return;
        seen.add(rowKey);
        seenByAgency.set(id, seen);
        add(id, 1, amount, signedAt);
      };
      const dealRows = await (this.prisma.deal as any).findMany({
        where: this.ourConfirmedDealWhere(period),
        select: {
          id: true,
          agencyId: true,
          brokerId: true,
          amount: true,
          signedAt: true,
        },
      });
      const registryBrokerRows = this.registryDealModel
        ? await this.registryDealModel.findMany({
            where: {
              brokerId: { not: null },
              broker: { is: { role: "BROKER", mergedIntoId: null } },
              ...this.registrySignedAtWhere(period),
            },
            select: { id: true, brokerId: true, amount: true, signedAt: true },
          })
        : [];
      const registryNamedRows = this.registryDealModel
        ? await this.registryDealModel.findMany({
            where: {
              ...this.registrySignedAtWhere(period),
              OR: [
                { agencyCanonical: { not: null } },
                { agencyNameRaw: { not: null } },
              ],
            },
            select: {
              id: true,
              agencyCanonical: true,
              agencyNameRaw: true,
              amount: true,
              signedAt: true,
            },
          })
        : [];
      const brokerIds = uniqueSorted([
        ...(dealRows as any[]).map((row) => String(row.brokerId || "")),
        ...(registryBrokerRows as any[]).map((row) =>
          String(row.brokerId || ""),
        ),
      ]).filter(Boolean);
      const relations =
        brokerIds.length && (this.prisma as any).brokerAgency
          ? await (this.prisma as any).brokerAgency.findMany({
              where: { brokerId: { in: brokerIds } },
              select: { brokerId: true, agencyId: true },
            })
          : [];
      const agenciesByBroker = new Map<string, string[]>();
      for (const relation of relations as any[]) {
        const brokerId = String(relation.brokerId || "");
        const agencyId = String(relation.agencyId || "");
        if (!brokerId || !agencyId) continue;
        const list = agenciesByBroker.get(brokerId) || [];
        list.push(agencyId);
        agenciesByBroker.set(brokerId, list);
      }
      const nameKeyToAgencies = new Map<string, string[]>();
      if ((registryNamedRows as any[]).length) {
        const agencies = await this.prisma.agency.findMany({
          select: { id: true, name: true, legalName: true },
        });
        for (const agency of agencies as any[]) {
          for (const value of [agency.name, agency.legalName]) {
            const key = canonicalAgencyMatchKey(value);
            if (!key) continue;
            const list = nameKeyToAgencies.get(key) || [];
            if (!list.includes(String(agency.id))) list.push(String(agency.id));
            nameKeyToAgencies.set(key, list);
          }
        }
      }
      for (const row of dealRows as any[]) {
        if (row.agencyId) {
          addRow(row.agencyId, `D:${String(row.id)}`, row.amount, row.signedAt);
        }
        for (const agencyId of agenciesByBroker.get(
          String(row.brokerId || ""),
        ) || []) {
          addRow(agencyId, `D:${String(row.id)}`, row.amount, row.signedAt);
        }
      }
      for (const row of registryBrokerRows as any[]) {
        for (const agencyId of agenciesByBroker.get(
          String(row.brokerId || ""),
        ) || []) {
          addRow(agencyId, `R:${String(row.id)}`, row.amount, row.signedAt);
        }
      }
      for (const row of registryNamedRows as any[]) {
        const key =
          canonicalAgencyMatchKey(row.agencyCanonical) ??
          canonicalAgencyMatchKey(row.agencyNameRaw);
        if (!key) continue;
        for (const agencyId of nameKeyToAgencies.get(key) || []) {
          addRow(agencyId, `R:${String(row.id)}`, row.amount, row.signedAt);
        }
      }
    }
    const ranked = [...totals.entries()]
      .map(([id, value]) => ({ id, ...value }))
      .sort(
        (left, right) =>
          right.deals - left.deals ||
          (left.amountCents === right.amountCents
            ? 0
            : right.amountCents > left.amountCents
              ? 1
              : -1) ||
          (right.latestAt?.getTime() || 0) - (left.latestAt?.getTime() || 0) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, 5);
    if (!ranked.length) return [];
    const ids = ranked.map((entry) => entry.id);
    const entities =
      entityType === "BROKER"
        ? await this.prisma.broker.findMany({
            where: { id: { in: ids } },
            select: { id: true, fullName: true },
          })
        : await this.prisma.agency.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          });
    const names = new Map(
      (entities as any[]).map((entity) => [
        entity.id,
        entity.fullName || entity.name,
      ]),
    );
    return ranked.map((entry) => ({
      id: entry.id,
      name: names.get(entry.id) || "—",
      entityType,
      deals: entry.deals,
      dealAmount: centsToMoney(entry.amountCents),
      latestDealAt: entry.latestAt,
    }));
  }

  private ourConfirmedDealWhere(period?: { from: Date; to: Date }): any {
    return {
      contractType: "DDU",
      amount: { gt: 0 },
      status: { in: ["SIGNED", "PAID", "COMMISSION_PAID"] },
      signedAt: period ? { gte: period.from, lte: period.to } : { not: null },
    };
  }

  /**
   * 2026-09-04: «Реестр сделок» (registry_deals) — второй источник сделок
   * нашей базы. Локальная Deal-таблица фактически пуста (12 строк, не DDU),
   * поэтому итоговое число сделок брокера/агентства = Deal + RegistryDeal;
   * дедупликация между источниками сознательно не делается.
   * В старых тестовых prisma-моках модели registryDeal нет — тогда источник
   * считается пустым (нулевые счётчики), чтобы не менять чужие фикстуры.
   */
  private get registryDealModel(): any {
    return (this.prisma as any).registryDeal ?? null;
  }

  /** Период по дате подписания; без периода — все строки реестра. */
  private registrySignedAtWhere(period?: { from: Date; to: Date }): any {
    return period ? { signedAt: { gte: period.from, lte: period.to } } : {};
  }

  /**
   * Lifetime-счётчики реестровых сделок брокеров списка «наша база».
   * Мутирует record._count.deals (и последнюю дату сделки в record.deals[0]),
   * чтобы все существующие потребители — колонки, статусы SELLER/TOP_SELLER,
   * фильтр «Количество сделок», HAS_DEALS — увидели суммарное число.
   */
  private async attachOurBrokerRegistryDeals(records: any[]) {
    if (!records.length || !this.registryDealModel) return;
    const byId = new Map<string, any>(
      records.map((record) => [String(record.id), record]),
    );
    const ids = uniqueSorted([...byId.keys()]);
    for (
      let offset = 0;
      offset < ids.length;
      offset += CANDIDATE_QUERY_BATCH_SIZE
    ) {
      const batch = ids.slice(offset, offset + CANDIDATE_QUERY_BATCH_SIZE);
      const groups = await this.registryDealModel.groupBy({
        by: ["brokerId"],
        where: { brokerId: { in: batch } },
        _count: { _all: true },
        _max: { signedAt: true },
      });
      for (const group of groups as any[]) {
        const record = byId.get(String(group.brokerId));
        if (!record) continue;
        const count = finiteNumber(group._count?._all) || 0;
        if (!count) continue;
        record._count = {
          ...(record._count || {}),
          deals: Number(record._count?.deals || 0) + count,
        };
        const registryLast = group._max?.signedAt || null;
        const currentLast = record.deals?.[0]?.signedAt || null;
        if (
          registryLast &&
          (!currentLast || new Date(currentLast) < new Date(registryLast))
        ) {
          record.deals = [
            { signedAt: registryLast },
            ...(Array.isArray(record.deals) ? record.deals : []),
          ];
        }
      }
    }
  }

  /**
   * Реестровые сделки агентств нашей базы: у Agency нет прямой связи с
   * registry_deals, поэтому агентские строки собираются по двум каналам:
   * 1) brokerId входит в текущих брокеров агентства (broker_agencies);
   * 2) 2026-09-04: текстовое совпадение названия — canonicalAgencyMatchKey
   *    (Agency.name/legalName) === canonicalAgencyMatchKey
   *    (RegistryDeal.agencyCanonical/agencyNameRaw); 2026-09-07 ключ
   *    пропускается через AGENCY_KEY_ALIASES. Так сделки реестра без
   *    привязанного брокера всё равно попадают в аналитику агентства.
   * Дедуп по id строки реестра: сделка, уже пришедшая через брокера
   * агентства, второй раз по названию не добавляется.
   * Прикрепляются как record.__registryDeals; ourAgencyRelationMetrics
   * вливает их в общий массив сделок (счётчик, сумма, даты и периодные
   * метрики — единообразно), поэтому фильтр «Есть сделки», KPI-топ и
   * карточка агентства сходятся.
   */
  private async attachOurAgencyRegistryDeals(records: any[]) {
    if (!records.length || !this.registryDealModel) return;
    const attachedIds = new Map<any, Set<string>>();
    // 2026-09-07: в карточку уходят также номер договора, проект и лид amo
    // (для ссылки), а attribution говорит, как строка попала к агентству:
    // через брокера (оценка) или по названию агентства в реестре (прямая
    // привязка, считается проверенной).
    const registrySelect = {
      id: true,
      signedAt: true,
      amount: true,
      contractNumber: true,
      project: true,
      amoLeadId: true,
      // 2026-09-07: объект сделки (заполняется из лида amo, поезд №18).
      sqm: true,
      floor: true,
      building: true,
      apartmentNumber: true,
    };
    const pushRow = (
      record: any,
      row: any,
      attribution: "BROKER" | "AGENCY_NAME",
    ) => {
      const rowId = String(row?.id || "");
      if (!rowId) return;
      const seen = attachedIds.get(record) || new Set<string>();
      if (seen.has(rowId)) return;
      seen.add(rowId);
      attachedIds.set(record, seen);
      record.__registryDeals.push({
        id: `REGISTRY:${rowId}`,
        signedAt: row.signedAt || null,
        // Неизвестная сумма считается нулём: сумма остаётся нижней
        // границей вместо схлопывания всей агрегатной суммы в null.
        amount:
          row.amount === null || row.amount === undefined
            ? "0"
            : String(row.amount),
        contractNumber: row.contractNumber ? String(row.contractNumber) : null,
        project: row.project ? String(row.project) : null,
        amoLeadId:
          row.amoLeadId === null || row.amoLeadId === undefined
            ? null
            : String(row.amoLeadId),
        sqm: row.sqm === null || row.sqm === undefined ? null : String(row.sqm),
        floor:
          row.floor === null || row.floor === undefined
            ? null
            : String(row.floor),
        building: row.building ? String(row.building) : null,
        apartmentNumber: row.apartmentNumber
          ? String(row.apartmentNumber)
          : null,
        attribution,
      });
    };
    const brokerToRecords = new Map<string, any[]>();
    const nameToRecords = new Map<string, any[]>();
    for (const record of records) {
      record.__registryDeals = [];
      const relations = Array.isArray(record?.brokerAgencies)
        ? record.brokerAgencies
        : [];
      for (const relation of relations) {
        const brokerId = String(relation?.broker?.id || "");
        if (!brokerId) continue;
        const list = brokerToRecords.get(brokerId) || [];
        list.push(record);
        brokerToRecords.set(brokerId, list);
      }
      for (const value of [record?.name, record?.legalName]) {
        const key = canonicalAgencyMatchKey(value);
        if (!key) continue;
        const list = nameToRecords.get(key) || [];
        if (!list.includes(record)) list.push(record);
        nameToRecords.set(key, list);
      }
    }
    const ids = uniqueSorted([...brokerToRecords.keys()]);
    for (
      let offset = 0;
      offset < ids.length;
      offset += CANDIDATE_QUERY_BATCH_SIZE
    ) {
      const batch = ids.slice(offset, offset + CANDIDATE_QUERY_BATCH_SIZE);
      const rows = await this.registryDealModel.findMany({
        where: { brokerId: { in: batch } },
        select: { ...registrySelect, brokerId: true },
      });
      for (const row of rows as any[]) {
        for (const record of brokerToRecords.get(String(row.brokerId)) || []) {
          pushRow(record, row, "BROKER");
        }
      }
    }
    if (!nameToRecords.size) return;
    // Канал по названию: строк реестра мало (порядок 1-2 тыс.), сопоставление
    // выполняется в памяти — canonical в БД мог быть нормализован иначе.
    const namedRows = await this.registryDealModel.findMany({
      where: {
        OR: [
          { agencyCanonical: { not: null } },
          { agencyNameRaw: { not: null } },
        ],
      },
      select: {
        ...registrySelect,
        agencyCanonical: true,
        agencyNameRaw: true,
      },
    });
    for (const row of namedRows as any[]) {
      const key =
        canonicalAgencyMatchKey(row.agencyCanonical) ??
        canonicalAgencyMatchKey(row.agencyNameRaw);
      if (!key) continue;
      for (const record of nameToRecords.get(key) || []) {
        pushRow(record, row, "AGENCY_NAME");
      }
    }
  }

  private emptyOverview(base: BaseSlug, period: { from: string; to: string }) {
    return {
      base,
      period,
      snapshot: null,
      brokers: {
        total: 0,
        notCalledCurrentMonth: 0,
        newCount: 0,
        btWithoutFixation: 0,
        birthdaysToday: null,
        birthdayKnownCount: 0,
        top: [],
      },
      agencies: { total: 0, top: [] },
      activities: { fixations: 0, meetings: 0, deals: 0 },
      dealAmount: "0",
      dataAvailable: false,
      metricSource: {
        kind: "UNAVAILABLE",
        label: null,
        exactness: "UNKNOWN",
        periodFilterApplied: false,
      },
    };
  }

  async list(
    baseInput: string,
    entityType: EntityType,
    query: LoyaltyListQueryDto,
    search?: string,
    canonicalInput?: LoyaltyCanonicalFilterDto,
    includeSelectionIds = false,
  ) {
    const base = this.parseBase(baseInput);
    const filter = this.normalizeListFilter(query, canonicalInput);
    this.assertFilterForEntity(base, entityType, filter);
    return withLoyaltyFullScanSlot(() =>
      base === "anna"
        ? this.listAnna(entityType, query, filter, search, includeSelectionIds)
        : this.listOurs(entityType, query, filter, search, includeSelectionIds),
    );
  }

  async search(base: string, entityType: EntityType, dto: LoyaltySearchDto) {
    const normalized = Object.assign(
      new LoyaltyListQueryDto(),
      dto,
      dto.filters || {},
    );
    return this.list(
      base,
      entityType,
      normalized,
      dto.search.trim(),
      dto.filter,
    );
  }

  /**
   * Resolves exactly the same canonical predicate used by list/search/export.
   * The method is intentionally service-only: workflow modules receive stable
   * entity IDs and a hash, while search text and record contents never enter
   * workflow or audit logs.
   */
  async resolveSelection(
    base: string,
    entityType: EntityType,
    dto: LoyaltySearchDto | LoyaltyExportDto,
    options?: { excludeDoNotCall?: boolean },
  ): Promise<LoyaltyResolvedSelection> {
    const query = Object.assign(
      new LoyaltyListQueryDto(),
      dto,
      dto.filters || {},
      { page: 1, pageSize: 1 },
    );
    const result: any = await this.list(
      base,
      entityType,
      query,
      dto.search?.trim() || undefined,
      dto.filter,
      true,
    );
    let ids: string[] = Array.isArray(result._selectionIds)
      ? result._selectionIds.map(String)
      : [];
    let excludedDoNotCall = 0;
    // 2026-09-04 (задача A): брокеры с doNotCall=true никогда не попадают в
    // обзвон (как в admin.service call-queue). Исключение выполняется ПОСЛЕ
    // вычисления списка и не меняет filterHash — список в UI по-прежнему
    // показывает всех, а кампании обзвона получают выборку без «не звонить».
    if (
      options?.excludeDoNotCall &&
      base === "ours" &&
      entityType === "BROKER" &&
      ids.length
    ) {
      const blockedIds = new Set<string>();
      for (
        let offset = 0;
        offset < ids.length;
        offset += CANDIDATE_QUERY_BATCH_SIZE
      ) {
        const batch = ids.slice(offset, offset + CANDIDATE_QUERY_BATCH_SIZE);
        const blocked = await this.prisma.broker.findMany({
          where: { id: { in: batch }, doNotCall: true },
          select: { id: true },
        });
        for (const row of blocked) blockedIds.add(String(row.id));
      }
      if (blockedIds.size) {
        ids = ids.filter((id) => !blockedIds.has(id));
        excludedDoNotCall = blockedIds.size;
      }
    }
    return {
      ids,
      total: excludedDoNotCall ? ids.length : Number(result.total || 0),
      filterHash: String(result.filterHash || ""),
      snapshotId:
        typeof result.snapshotId === "string" ? result.snapshotId : null,
      ...(excludedDoNotCall ? { excludedDoNotCall } : {}),
    };
  }

  private assertFilterForEntity(
    base: BaseSlug,
    entityType: EntityType,
    filter: CanonicalLoyaltyFilter,
  ) {
    const deprecatedResults: Record<string, string> = {
      SEND_INFO: "SEND_INFORMATION",
      REFUSED_TOUR: "BROKER_TOUR_DECLINED",
      INVALID_NUMBER: "INVALID_PHONE",
      NOT_BROKER: "NOT_A_BROKER",
      REFUSED_COOPERATION: "COOPERATION_DECLINED",
      AGREEMENTS: "AGREEMENTS_EXIST",
      SCHEDULED_TOUR:
        entityType === "BROKER"
          ? "BROKER_TOUR_BOOKED"
          : "BROKER_TOUR_SCHEDULED",
    };
    filter.lastCallResults = uniqueSorted(
      filter.lastCallResults.map(
        (result) => deprecatedResults[result] || result,
      ),
    );
    const allowedResults = Object.keys(
      entityType === "BROKER"
        ? BROKER_CALL_RESULT_ALIASES
        : AGENCY_CALL_RESULT_ALIASES,
    );
    if (
      filter.lastCallResults.some((result) => !allowedResults.includes(result))
    ) {
      throw new BadRequestException(
        `lastCallResults contains a value unsupported for ${entityType}`,
      );
    }
    const allowedStatuses =
      entityType === "BROKER"
        ? BROKER_LOYALTY_STATUSES
        : AGENCY_LOYALTY_STATUSES;
    if (
      filter.brokerStatuses.some((status) => !allowedStatuses.includes(status))
    ) {
      throw new BadRequestException(
        `brokerStatuses contains a value unsupported for ${entityType}`,
      );
    }
    if (
      filter.columns.statusStage &&
      !allowedStatuses.includes(filter.columns.statusStage)
    ) {
      throw new BadRequestException(
        `columns.statusStage contains a value unsupported for ${entityType}`,
      );
    }
    const allowedScenarios =
      entityType === "BROKER"
        ? BROKER_LOYALTY_SCENARIOS
        : AGENCY_LOYALTY_SCENARIOS;
    if (filter.scenario && !allowedScenarios.includes(filter.scenario)) {
      throw new BadRequestException(
        `scenario contains a value unsupported for ${entityType}`,
      );
    }
    if (filter.assigneeIds.length && filter.unassigned === true) {
      throw new BadRequestException(
        "assigneeIds and unassigned=true are mutually exclusive",
      );
    }
    // «Не звонить» (Broker.doNotCall) и «Действующая фиксация» (сроки
    // Client.fixationExpiresAt/uniquenessExpiresAt) существуют только в
    // «Нашей базе» у брокеров — для остальных моделей фильтр fail-closed.
    const ourBrokerOnlyFields = uniqueSorted(
      base === "ours" && entityType === "BROKER"
        ? []
        : [
            filter.doNotCall !== undefined ? "doNotCall" : undefined,
            filter.columns.activity === "HAS_ACTIVE_FIXATIONS"
              ? "columns.activity"
              : undefined,
          ],
    );
    if (ourBrokerOnlyFields.length) {
      throw new BadRequestException({
        code: "LOYALTY_FILTER_UNAVAILABLE",
        message:
          "The selected filter is only available for OUR brokers (doNotCall / active fixation)",
        base,
        entityType,
        fields: ourBrokerOnlyFields,
        unknownValuesRemainNull: true,
      });
    }
    if (base !== "ours") return;

    const unavailableFields = uniqueSorted(
      entityType === "BROKER"
        ? [
            filter.partnershipStatuses.length
              ? "partnershipStatuses"
              : undefined,
            filter.agencySizes.length ? "agencySizes" : undefined,
            filter.websitePresent !== undefined ? "websitePresent" : undefined,
            filter.projectsOnSite.length ? "projectsOnSite" : undefined,
            filter.individualTerms !== undefined
              ? "individualTerms"
              : undefined,
          ]
        : [
            filter.archived === "only" ? "archived" : undefined,
            filter.hasAmo !== undefined ? "hasAmo" : undefined,
            filter.segment ? "segment" : undefined,
            filter.scenario &&
            ![
              "HAS_DEALS",
              "HAS_MEETINGS",
              "NO_MEETINGS",
              "BT_VISITED",
              "BT_NOT_VISITED",
              "INDIVIDUAL_TERMS",
              "NO_INDIVIDUAL_TERMS",
              "NOT_CALLED_IN_PERIOD",
              "CALLED_IN_PERIOD",
              "UNASSIGNED",
            ].includes(filter.scenario)
              ? "scenario"
              : undefined,
            filter.specializations.length ? "specializations" : undefined,
            filter.geography.length ? "geography" : undefined,
            filter.workFormats.length ? "workFormats" : undefined,
            filter.relationshipStages.length ? "relationshipStages" : undefined,
            filter.dataQuality.length ? "dataQuality" : undefined,
            filter.agencySizes.length ? "agencySizes" : undefined,
            filter.websitePresent !== undefined ? "websitePresent" : undefined,
            filter.projectsOnSite.length ? "projectsOnSite" : undefined,
          ],
    );
    if (unavailableFields.length) {
      throw new BadRequestException({
        code: "LOYALTY_FILTER_UNAVAILABLE",
        message:
          "The selected filter has no authoritative field in the OUR entity model",
        base,
        entityType,
        fields: unavailableFields,
        unknownValuesRemainNull: true,
      });
    }
  }

  private async listAnna(
    entityType: EntityType,
    query: LoyaltyListQueryDto,
    filter: CanonicalLoyaltyFilter,
    search?: string,
    includeSelectionIds = false,
  ) {
    const active = await this.activeAnnaSnapshot();
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    if (!active) {
      const filterHash = this.listFilterHash(
        "anna",
        entityType,
        filter,
        search,
      );
      return {
        base: "anna",
        entityType,
        snapshotId: null,
        items: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
        selectionCount: 0,
        filterHash,
        facets: this.loyaltyFacets([]),
        dataAvailability: {
          exactActivities: false,
          sourceReportedAggregates: false,
          callPeriod: "UNAVAILABLE",
          activityPeriod: "UNAVAILABLE",
          unknownValuesRemainNull: true,
        },
        ...(includeSelectionIds ? { _selectionIds: [] } : {}),
      };
    }
    const relationName = entityType === "BROKER" ? "person" : "organization";
    const where: any = { snapshotId: active.snapshot.id, entityType };
    if (filter.archived === "exclude") {
      where.sourceArchivedAt = null;
      where[relationName] = { is: { archivedAt: null } };
    } else if (filter.archived === "only") {
      where.OR = [
        { sourceArchivedAt: { not: null } },
        { [relationName]: { is: { archivedAt: { not: null } } } },
      ];
    }
    if (filter.hasAmo !== undefined) {
      where.externalIdentities = filter.hasAmo
        ? { some: { system: "AMOCRM" } }
        : { none: { system: "AMOCRM" } };
    }
    // Call predicates are evaluated after the batched workflow-attempt read
    // model is attached. A DB-only source-activity predicate would otherwise
    // drop a freshly completed workflow call before canonical filtering.
    const include = this.annaRecordInclude(
      active.snapshot.id,
      active.snapshot.ruleVersion,
      false,
    );
    if (Number(active.snapshot.activityCount) > 0) {
      include.activities = {
        where: {
          archivedAt: null,
          verdict: "INCLUDED",
        },
        select: {
          type: true,
          occurredAt: true,
          amount: true,
          metadata: true,
        },
      };
    }
    const records = await this.prisma.loyaltySourceRecord.findMany({
      where,
      include,
    });
    const manualRecords = await this.annaManualRecords(
      active.dataset.id,
      active.snapshot.id,
      entityType,
      filter,
    );
    const trustedActivityCoverage = this.trustedFullSnapshotActivityCoverage(
      active.snapshot,
    );
    const activityObservedThrough =
      trustedActivityCoverage?.observedThroughIso || null;
    const allRecords = [...(records as any[]), ...manualRecords];
    const workflowCalls = await this.workflowCallReadModels(
      "anna",
      entityType,
      allRecords.map((record) => this.workflowTargetId(record, entityType)),
    );
    this.attachWorkflowCallReadModels(allRecords, entityType, workflowCalls);
    const engagementEvents = await this.engagementReadModels(
      "anna",
      entityType,
      allRecords.map((record) => this.workflowTargetId(record, entityType)),
    );
    this.attachEngagementReadModels(allRecords, entityType, engagementEvents);
    const candidates = allRecords
      .map((record) => ({
        record,
        item: record.__manualOverlay
          ? this.mapAnnaManualRecord(record, false)
          : this.mapAnnaRecord(record, false, activityObservedThrough),
      }))
      .filter(({ record, item }) =>
        this.matchesAnnaRecord(record, item, entityType, filter, search),
      );
    this.sortLoyaltyCandidates(candidates, filter);
    const total = candidates.length;
    const pageCandidates = candidates.slice(
      (page - 1) * pageSize,
      page * pageSize,
    );
    const fullActivityCoverage = Boolean(trustedActivityCoverage);
    const exactThrough = (period?: LoyaltyFilterPeriod) =>
      Boolean(
        trustedActivityCoverage &&
        (!period ||
          period.to.getTime() <=
            trustedActivityCoverage.observedThrough.getTime()),
      );
    return {
      base: "anna",
      entityType,
      snapshotId: active.snapshot.id,
      items: pageCandidates.map(({ item }) => item),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      selectionCount: total,
      filterHash: this.listFilterHash("anna", entityType, filter, search),
      facets: this.loyaltyFacets(candidates.map(({ item }) => item)),
      dataAvailability: {
        exactActivities: fullActivityCoverage,
        observedThrough: activityObservedThrough,
        sourceReportedAggregates: this.snapshotHasSourceAggregates(
          active.snapshot,
        ),
        callPeriod: exactThrough(filter.callPeriod)
          ? "EXACT"
          : "PARTIAL_DATE_OR_MONTH",
        activityPeriod: exactThrough(filter.activityPeriod)
          ? "EXACT"
          : "SOURCE_REPORTED_MONTH_OR_LAST_DATE",
        unknownValuesRemainNull: true,
      },
      ...(includeSelectionIds
        ? { _selectionIds: candidates.map(({ item }) => item.id) }
        : {}),
    };
  }

  private listFilterHash(
    base: BaseSlug,
    entityType: EntityType,
    filter: CanonicalLoyaltyFilter,
    search?: string,
  ) {
    return loyaltyFilterHash({
      version: 1,
      base,
      entityType,
      filter: this.serializableFilter(filter),
      // The sensitive value never leaves the POST body or enters audit logs.
      // Only its one-way digest participates in deterministic selection state.
      searchDigest: search ? sha256(lower(search)) : null,
    });
  }

  /**
   * Loads the workflow call queue as a separate read model. These rows are
   * deliberately not projected as LoyaltyActivity or amoCRM/CallLog events:
   * they remain auditable call-queue facts while participating in canonical
   * call summaries and filters.
   */
  private async workflowCallReadModels(
    base: BaseSlug,
    entityType: EntityType,
    targetIds: string[],
  ): Promise<Map<string, LoyaltyWorkflowCallReadModel>> {
    const result = new Map<string, LoyaltyWorkflowCallReadModel>();
    const ids = uniqueSorted(targetIds);
    const delegate = (this.prisma as any).loyaltyCallAttempt;
    if (!ids.length || typeof delegate?.findMany !== "function") return result;
    const targetField =
      base === "anna"
        ? entityType === "BROKER"
          ? "annaPersonId"
          : "annaOrganizationId"
        : entityType === "BROKER"
          ? "ourBrokerId"
          : "ourAgencyId";
    const rows = await delegate.findMany({
      where: {
        assignment: {
          [targetField]: { in: ids },
          campaign: {
            base: base === "anna" ? "ANNA" : "OUR",
            entityType,
          },
        },
      },
      select: {
        id: true,
        assignmentId: true,
        operatorId: true,
        result: true,
        comment: true,
        nextStep: true,
        nextActionAt: true,
        source: true,
        correctsAttemptId: true,
        correctionReason: true,
        occurredAt: true,
        createdAt: true,
        operator: { select: { id: true, fullName: true } },
        assignment: {
          select: {
            annaPersonId: true,
            annaOrganizationId: true,
            ourBrokerId: true,
            ourAgencyId: true,
            campaign: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    if (!Array.isArray(rows) || !rows.length) return result;
    const requestedIds = new Set(ids);
    const byTarget = new Map<string, any[]>();
    for (const row of rows) {
      const targetId = row?.assignment?.[targetField];
      if (!targetId || !requestedIds.has(String(targetId))) continue;
      const group = byTarget.get(String(targetId)) || [];
      group.push(row);
      byTarget.set(String(targetId), group);
    }
    for (const [targetId, attempts] of byTarget) {
      const byId = new Map<string, any>(
        attempts.map((attempt) => [String(attempt.id), attempt]),
      );
      const rootId = (attempt: any) => {
        let current = attempt;
        const seen = new Set<string>();
        while (
          current?.correctsAttemptId &&
          byId.has(String(current.correctsAttemptId)) &&
          !seen.has(String(current.correctsAttemptId))
        ) {
          seen.add(String(current.id));
          current = byId.get(String(current.correctsAttemptId));
        }
        return String(current?.id || attempt.id);
      };
      const chains = new Map<string, any[]>();
      for (const attempt of attempts) {
        const key = rootId(attempt);
        const chain = chains.get(key) || [];
        chain.push(attempt);
        chains.set(key, chain);
      }
      const effective: LoyaltyCallView[] = [];
      const history: LoyaltyCallView[] = [];
      for (const [rootAttemptId, chain] of chains) {
        const ordered = [...chain].sort((left, right) =>
          this.workflowAttemptSortKey(left).localeCompare(
            this.workflowAttemptSortKey(right),
          ),
        );
        const root = byId.get(rootAttemptId) || ordered[0];
        const current = ordered[ordered.length - 1];
        effective.push(
          this.workflowCallView(
            current,
            root?.occurredAt || current?.occurredAt,
            true,
            current?.id === root?.id ? null : current?.occurredAt,
          ),
        );
        for (const attempt of ordered) {
          history.push({
            ...this.workflowCallView(
              attempt,
              attempt?.occurredAt,
              attempt?.id === current?.id,
              attempt?.id === root?.id ? null : attempt?.occurredAt,
            ),
            superseded: attempt?.id !== current?.id,
          });
        }
      }
      effective.sort((left, right) =>
        this.callSortKey(right).localeCompare(this.callSortKey(left)),
      );
      history.sort((left, right) =>
        this.callSortKey(right).localeCompare(this.callSortKey(left)),
      );
      result.set(targetId, { effective, history });
    }
    return result;
  }

  private workflowAttemptSortKey(attempt: any): string {
    const createdAt = this.isoDateTime(attempt?.createdAt) || "";
    return `${createdAt}\u0000${String(attempt?.id || "")}`;
  }

  private isoDateTime(value: unknown): string | null {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  private workflowCallView(
    attempt: any,
    effectiveOccurredAt: unknown,
    effective: boolean,
    correctedAt: unknown,
  ): LoyaltyCallView {
    const campaignId = String(attempt?.assignment?.campaign?.id || "") || null;
    const campaignName =
      String(attempt?.assignment?.campaign?.name || "") || null;
    const employeeId =
      String(attempt?.operator?.id || attempt?.operatorId || "") || null;
    const employeeName = String(attempt?.operator?.fullName || "") || null;
    const occurredAt = this.isoDateTime(effectiveOccurredAt);
    const result = String(attempt?.result || "") || null;
    const comment =
      attempt?.comment === null || attempt?.comment === undefined
        ? null
        : String(attempt.comment);
    return {
      type: "CALL",
      id: String(attempt?.id || "") || null,
      assignmentId: String(attempt?.assignmentId || "") || null,
      date: occurredAt,
      occurredAt,
      campaign: campaignName || campaignId,
      campaignId,
      campaignName,
      employee: employeeName || employeeId,
      employeeId,
      employeeName,
      result,
      resultCode: result,
      agreement: comment,
      comment,
      nextStep:
        attempt?.nextStep === null || attempt?.nextStep === undefined
          ? null
          : String(attempt.nextStep),
      nextActionAt: this.isoDateTime(attempt?.nextActionAt),
      source: String(attempt?.source || "LOYALTY_CALL_QUEUE"),
      correctsAttemptId: String(attempt?.correctsAttemptId || "") || null,
      correctionReason:
        attempt?.correctionReason === null ||
        attempt?.correctionReason === undefined
          ? null
          : String(attempt.correctionReason),
      isCorrection: Boolean(attempt?.correctsAttemptId),
      effective,
      superseded: !effective,
      correctedAt: this.isoDateTime(correctedAt),
    };
  }

  private workflowTargetId(record: any, entityType: EntityType): string {
    return String(
      entityType === "BROKER"
        ? record?.personId || record?.person?.id || record?.id || ""
        : record?.organizationId ||
            record?.organization?.id ||
            record?.id ||
            "",
    );
  }

  private attachWorkflowCallReadModels(
    records: any[],
    entityType: EntityType,
    readModels: Map<string, LoyaltyWorkflowCallReadModel>,
  ) {
    for (const record of records) {
      record.__workflowCalls = readModels.get(
        this.workflowTargetId(record, entityType),
      ) || {
        effective: [],
        history: [],
      };
    }
  }

  /** Engagement history is a workflow read model, never an amoCRM activity. */
  private async engagementReadModels(
    base: BaseSlug,
    entityType: EntityType,
    targetIds: string[],
  ): Promise<Map<string, LoyaltyEngagementReadModel>> {
    const result = new Map<string, LoyaltyEngagementReadModel>();
    const ids = uniqueSorted(targetIds);
    const delegate = (this.prisma as any).loyaltyEngagementEvent;
    if (!ids.length || typeof delegate?.findMany !== "function") return result;
    const targetField =
      base === "anna"
        ? entityType === "BROKER"
          ? "annaPersonId"
          : "annaOrganizationId"
        : entityType === "BROKER"
          ? "ourBrokerId"
          : "ourAgencyId";
    const rows = await delegate.findMany({
      where: { [targetField]: { in: ids } },
      select: {
        id: true,
        annaPersonId: true,
        annaOrganizationId: true,
        ourBrokerId: true,
        ourAgencyId: true,
        type: true,
        occurredAt: true,
        comment: true,
        amount: true,
        value: true,
        validUntil: true,
        attachmentUrl: true,
        basisUrl: true,
        createdById: true,
        createdBy: { select: { id: true, fullName: true } },
        correctsEventId: true,
        correctionReason: true,
        archivedAt: true,
        createdAt: true,
      },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    if (!Array.isArray(rows) || !rows.length) return result;
    const requestedIds = new Set(ids);
    const byTarget = new Map<string, any[]>();
    for (const row of rows) {
      const targetId = String(row?.[targetField] || "");
      if (!requestedIds.has(targetId)) continue;
      const group = byTarget.get(targetId) || [];
      group.push(row);
      byTarget.set(targetId, group);
    }
    for (const [targetId, events] of byTarget) {
      const byId = new Map<string, any>(
        events.map((event) => [String(event.id), event]),
      );
      const rootId = (event: any) => {
        let current = event;
        const seen = new Set<string>();
        while (
          current?.correctsEventId &&
          byId.has(String(current.correctsEventId)) &&
          !seen.has(String(current.correctsEventId))
        ) {
          seen.add(String(current.id));
          current = byId.get(String(current.correctsEventId));
        }
        return String(current?.id || event.id);
      };
      const chains = new Map<string, any[]>();
      for (const event of events) {
        const key = rootId(event);
        const chain = chains.get(key) || [];
        chain.push(event);
        chains.set(key, chain);
      }
      const effective: LoyaltyEngagementView[] = [];
      const history: LoyaltyEngagementView[] = [];
      for (const chain of chains.values()) {
        const ordered = [...chain].sort((left, right) =>
          this.engagementSortKey(left).localeCompare(
            this.engagementSortKey(right),
          ),
        );
        const current = ordered[ordered.length - 1];
        if (!current?.archivedAt) {
          effective.push(this.engagementView(current, true));
        }
        for (const event of ordered) {
          history.push(
            this.engagementView(
              event,
              !current?.archivedAt && event.id === current.id,
            ),
          );
        }
      }
      const sort = (
        left: LoyaltyEngagementView,
        right: LoyaltyEngagementView,
      ) =>
        String(right.occurredAt || "").localeCompare(
          String(left.occurredAt || ""),
        );
      effective.sort(sort);
      history.sort(sort);
      result.set(targetId, { effective, history });
    }
    return result;
  }

  private engagementSortKey(event: any) {
    return `${this.isoDateTime(event?.createdAt) || ""}\u0000${String(event?.id || "")}`;
  }

  private engagementView(
    event: any,
    effective: boolean,
  ): LoyaltyEngagementView {
    return {
      id: String(event.id),
      type: String(event.type),
      occurredAt: this.isoDateTime(event.occurredAt),
      comment:
        event.comment === null || event.comment === undefined
          ? null
          : String(event.comment),
      amount:
        event.amount === null || event.amount === undefined
          ? null
          : String(event.amount),
      value:
        event.value === null || event.value === undefined
          ? null
          : String(event.value),
      validUntil: this.isoDateTime(event.validUntil),
      attachmentUrl: event.attachmentUrl || null,
      basisUrl: event.basisUrl || null,
      createdById:
        String(event?.createdBy?.id || event.createdById || "") || null,
      createdByName: String(event?.createdBy?.fullName || "") || null,
      correctsEventId: String(event.correctsEventId || "") || null,
      correctionReason:
        event.correctionReason === null || event.correctionReason === undefined
          ? null
          : String(event.correctionReason),
      archivedAt: this.isoDateTime(event.archivedAt),
      effective,
      superseded: !effective,
    };
  }

  private attachEngagementReadModels(
    records: any[],
    entityType: EntityType,
    readModels: Map<string, LoyaltyEngagementReadModel>,
  ) {
    for (const record of records) {
      record.__workflowEvents = readModels.get(
        this.workflowTargetId(record, entityType),
      ) || {
        effective: [],
        history: [],
      };
    }
  }

  private applyEngagementSummary(item: any, record: any) {
    const events: LoyaltyEngagementView[] = Array.isArray(
      record?.__workflowEvents?.effective,
    )
      ? record.__workflowEvents.effective
      : [];
    item.engagementTypes = uniqueSorted(events.map((event) => event.type));
    item.rewardPresent = events.some((event) => event.type === "AWARD");
    item.specialTermsProposed = events.some(
      (event) => event.type === "INDIVIDUAL_TERMS",
    );
    item.lastEngagementAt = events[0]?.occurredAt || null;
    return events;
  }

  private callCampaignValues(call: LoyaltyCallView): string[] {
    return uniqueSorted([call.campaignId, call.campaignName, call.campaign]);
  }

  private callAssigneeValues(call: LoyaltyCallView): string[] {
    return uniqueSorted([call.employeeId, call.employeeName, call.employee]);
  }

  private applyCallSummary(
    item: any,
    entityType: EntityType,
    calls: LoyaltyCallView[],
  ) {
    const latest = this.lastCall(calls);
    item.lastCallAt = latest
      ? latest.occurredAt || this.callSortKey(latest) || null
      : null;
    item.lastCallResult = latest
      ? this.resultCodeForValue(entityType, latest.result)
      : null;
    item.lastCallCampaign = latest?.campaign || null;
    item.lastCallCampaignId = latest?.campaignId || null;
    item.lastCallCampaignName = latest?.campaignName || null;
    item.lastCallOperator = latest?.employee || null;
    item.lastCallOperatorId = latest?.employeeId || null;
    item.lastCallComment = latest?.comment || latest?.agreement || null;
    item.lastCallNextStep = latest?.nextStep || null;
    item.lastCallNextActionAt = latest?.nextActionAt || null;
    return latest;
  }

  private annaMetricValue(item: any, field: string): number | null {
    const exact = finiteNumber(item.metrics?.[field]);
    if (exact !== null) return exact;
    return finiteNumber(item.sourceReportedMetrics?.[field]);
  }

  private annaCalls(
    item: any,
    record?: any,
    includeWorkflow = true,
  ): LoyaltyCallView[] {
    const attributes = item.attributes || {};
    const calls: LoyaltyCallView[] = [];
    if (Array.isArray(record?.activities)) {
      for (const activity of record.activities) {
        if (activity?.type !== "CALL") continue;
        const metadata =
          activity.metadata && typeof activity.metadata === "object"
            ? activity.metadata
            : {};
        calls.push({
          date: dateOnly(activity.occurredAt),
          campaign: hasText(metadata.campaignId)
            ? String(metadata.campaignId)
            : hasText(metadata.campaign)
              ? String(metadata.campaign)
              : hasText(metadata.campaignName)
                ? String(metadata.campaignName)
                : null,
          employee: hasText(metadata.assigneeId)
            ? String(metadata.assigneeId)
            : hasText(metadata.employee)
              ? String(metadata.employee)
              : null,
          result: hasText(metadata.resultCode)
            ? String(metadata.resultCode)
            : hasText(metadata.callResult)
              ? String(metadata.callResult)
              : hasText(metadata.result)
                ? String(metadata.result)
                : hasText(metadata.status)
                  ? String(metadata.status)
                  : null,
          agreement: hasText(metadata.agreement)
            ? String(metadata.agreement)
            : hasText(metadata.comment)
              ? String(metadata.comment)
              : null,
        });
      }
    }
    if (Array.isArray(attributes.history)) {
      for (const tuple of attributes.history) {
        if (!Array.isArray(tuple)) continue;
        calls.push({
          campaign: hasText(tuple[0]) ? String(tuple[0]) : null,
          result: hasText(tuple[2] ?? tuple[1])
            ? String(tuple[2] ?? tuple[1])
            : null,
          period:
            typeof tuple[3] === "string" && /^\d{4}-\d{2}$/.test(tuple[3])
              ? tuple[3]
              : null,
          agreement: hasText(attributes.comment)
            ? String(attributes.comment)
            : null,
        });
      }
    }
    if (Array.isArray(attributes.calls)) {
      for (const call of attributes.calls) {
        if (!call || typeof call !== "object") continue;
        calls.push({
          date: dateOnly(call.date),
          campaign: hasText(call.campaign) ? call.campaign : null,
          employee: hasText(call.employee) ? call.employee : null,
          result: hasText(call.result) ? call.result : null,
          agreement: hasText(call.agreement) ? call.agreement : null,
        });
      }
    }
    if (Array.isArray(item.sourceReportedMetrics?.callBreakdown)) {
      for (const call of item.sourceReportedMetrics.callBreakdown) {
        if (!call || typeof call !== "object") continue;
        const reportedCount = finiteNumber(call.count);
        if (reportedCount !== null && reportedCount <= 0) continue;
        calls.push({
          date: dateOnly(call.date),
          period:
            typeof call.period === "string" && /^\d{4}-\d{2}$/.test(call.period)
              ? call.period
              : null,
          campaign: hasText(call.campaignId)
            ? String(call.campaignId)
            : hasText(call.campaign)
              ? String(call.campaign)
              : hasText(call.campaignName)
                ? String(call.campaignName)
                : null,
          employee: hasText(call.assigneeId)
            ? String(call.assigneeId)
            : hasText(call.employee)
              ? String(call.employee)
              : null,
          result: hasText(call.result) ? call.result : null,
          agreement: hasText(call.agreement) ? call.agreement : null,
        });
      }
    }
    if (includeWorkflow && Array.isArray(record?.__workflowCalls?.effective)) {
      calls.push(...record.__workflowCalls.effective);
    }
    return calls.map((call) => ({ type: "CALL", ...call }));
  }

  private annaCallHistory(item: any, record?: any): LoyaltyCallView[] {
    const sourceCalls = this.annaCalls(item, record, false);
    const workflowHistory = Array.isArray(record?.__workflowCalls?.history)
      ? record.__workflowCalls.history
      : [];
    return [...sourceCalls, ...workflowHistory].sort((left, right) =>
      this.callSortKey(right).localeCompare(this.callSortKey(left)),
    );
  }

  private callSortKey(call: LoyaltyCallView): string {
    const exact = this.isoDateTime(call.occurredAt || call.date);
    if (exact) return exact;
    return (
      dateOnly(call.date) ||
      (call.period && /^\d{4}-\d{2}$/.test(call.period)
        ? `${call.period}-31`
        : "") ||
      ""
    );
  }

  private lastCall(calls: LoyaltyCallView[]): LoyaltyCallView | null {
    return (
      [...calls]
        .filter((call) => this.callSortKey(call))
        .sort((left, right) =>
          this.callSortKey(right).localeCompare(this.callSortKey(left)),
        )[0] || null
    );
  }

  private calendarMonthBounds(month: string): {
    from: string;
    to: string;
  } | null {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return null;
    const [year, monthNumber] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return {
      from: `${month}-01`,
      to: `${month}-${String(lastDay).padStart(2, "0")}`,
    };
  }

  private exactActivityObservedThrough(item: any): Date | null {
    if (item?.metricSource?.kind !== "EXACT_ACTIVITIES") return null;
    const value = new Date(item.metricSource.observedThrough || "");
    return Number.isFinite(value.getTime()) ? value : null;
  }

  private exactActivityPeriodCovered(
    item: any,
    period: LoyaltyFilterPeriod,
  ): boolean {
    const observedThrough = this.exactActivityObservedThrough(item);
    return Boolean(
      observedThrough && period.to.getTime() <= observedThrough.getTime(),
    );
  }

  private currentMonthThroughObserved(item: any): LoyaltyFilterPeriod | null {
    const observedThrough = this.exactActivityObservedThrough(item);
    if (!observedThrough) return null;
    const now = new Date();
    const range = moscowCurrentMonthRange(now);
    const to = new Date(
      Math.min(now.getTime(), observedThrough.getTime(), range.to.getTime()),
    );
    if (to.getTime() < range.from.getTime()) return null;
    const parts = moscowDateParts(to);
    const month = String(parts.month + 1).padStart(2, "0");
    const day = String(Number(parts.dayMonth.slice(0, 2))).padStart(2, "0");
    return {
      from: range.from,
      to,
      fromIso: `${parts.year}-${month}-01`,
      toIso: `${parts.year}-${month}-${day}`,
    };
  }

  private isAnnaNotCalledCurrentMonth(record: any, item: any): boolean {
    const period = this.currentMonthThroughObserved(item);
    if (!period) return false;
    const exactCallCount =
      item.metricSource?.kind === "EXACT_ACTIVITIES"
        ? this.annaMetricValue(item, "calls")
        : null;
    return (
      this.callPresenceInPeriod(
        this.annaCalls(item, record),
        exactCallCount,
        period,
        this.exactActivityObservedThrough(item),
      ) === false
    );
  }

  private callInPeriod(
    call: LoyaltyCallView,
    period?: LoyaltyFilterPeriod,
  ): boolean | null {
    // Без периода любой известный звонок засчитывается («за всё время»).
    if (!period) return true;
    const date = dateOnly(call.date);
    if (date)
      return (
        date >= period.fromIso.slice(0, 10) && date <= period.toIso.slice(0, 10)
      );
    if (call.period && /^\d{4}-\d{2}$/.test(call.period)) {
      const bounds = this.calendarMonthBounds(call.period);
      if (!bounds) return null;
      const from = period.fromIso.slice(0, 10);
      const to = period.toIso.slice(0, 10);
      if (to < bounds.from || from > bounds.to) return false;
      return from <= bounds.from && to >= bounds.to ? true : null;
    }
    return null;
  }

  private callPresenceInPeriod(
    calls: LoyaltyCallView[],
    knownCallCount: number | null,
    period?: LoyaltyFilterPeriod,
    observedThrough?: Date | null,
  ): boolean | null {
    const states = calls.map((call) => this.callInPeriod(call, period));
    if (states.includes(true)) return true;
    // Lifetime-режим (без периода) опирается на все известные данные:
    // observedThrough ограничивает только периодные утверждения.
    if (
      observedThrough &&
      period &&
      period.to.getTime() > observedThrough.getTime()
    ) {
      return null;
    }
    if (knownCallCount === 0) return false;
    if (
      knownCallCount !== null &&
      states.length &&
      states.every((state) => state !== null)
    )
      return false;
    return null;
  }

  private annaDealsInPeriod(
    record: any,
    item: any,
    period: LoyaltyFilterPeriod,
  ): number | null {
    const metrics = this.annaPeriodMetrics(record, item, period);
    return metrics.availability === "EXACT"
      ? finiteNumber(metrics.deals)
      : null;
  }

  private annaActivityPresence(
    record: any,
    item: any,
    type: string,
    period?: LoyaltyFilterPeriod,
  ): boolean | null {
    if (period) {
      if (
        item.metricSource?.kind !== "EXACT_ACTIVITIES" ||
        !this.exactActivityPeriodCovered(item, period)
      ) {
        return null;
      }
      if (Array.isArray(record?.activities)) {
        return record.activities.some((activity: any) => {
          if (activity.type !== type) return false;
          return timestampInPeriod(activity.occurredAt, period);
        });
      }
      const fields: Record<string, string> = {
        FIXATION: "fixations",
        MEETING: "meetings",
        DEAL: "deals",
        BROKER_TOUR: "brokerTours",
        CALL: "calls",
      };
      const total = fields[type]
        ? this.annaMetricValue(item, fields[type])
        : null;
      return total === 0 ? false : null;
    }
    if (
      Array.isArray(record?.activities) &&
      item.metricSource?.kind === "EXACT_ACTIVITIES"
    ) {
      const present = record.activities.some((activity: any) => {
        if (activity.type !== type) return false;
        return true;
      });
      if (present) return true;
      return false;
    }
    const fields: Record<string, [string, string]> = {
      FIXATION: ["fixations", "lastFixationAt"],
      MEETING: ["meetings", "lastMeetingAt"],
      DEAL: ["deals", "lastDealAt"],
      BROKER_TOUR: ["brokerTours", "brokerTourAt"],
      CALL: ["calls", "lastCallAt"],
    };
    const mapping = fields[type];
    if (!mapping) return null;
    const total = this.annaMetricValue(item, mapping[0]);
    if (total === null) return null;
    if (item.metricSource?.kind === "EXACT_ACTIVITIES") {
      if (total === 0) return false;
      return true;
    }
    return total > 0 ? true : total === 0 ? false : null;
  }

  private unavailablePeriodMetrics(period?: LoyaltyFilterPeriod) {
    return {
      period: period ? { from: period.fromIso, to: period.toIso } : null,
      availability: "UNAVAILABLE",
      fixations: null,
      meetings: null,
      deals: null,
      dealAmount: null,
      lastFixationAt: null,
      lastMeetingAt: null,
      lastDealAt: null,
    };
  }

  private annaPeriodMetrics(
    record: any,
    item: any,
    period?: LoyaltyFilterPeriod,
  ) {
    if (
      !period ||
      item.metricSource?.kind !== "EXACT_ACTIVITIES" ||
      !this.exactActivityPeriodCovered(item, period)
    ) {
      return this.unavailablePeriodMetrics(period);
    }
    if (!Array.isArray(record?.activities)) {
      const fields = ["fixations", "meetings", "deals", "brokerTours", "calls"];
      if (fields.every((field) => this.annaMetricValue(item, field) === 0)) {
        return {
          period: { from: period.fromIso, to: period.toIso },
          availability: "EXACT",
          fixations: 0,
          meetings: 0,
          deals: 0,
          dealAmount: "0.00",
          lastFixationAt: null,
          lastMeetingAt: null,
          lastDealAt: null,
        };
      }
      return this.unavailablePeriodMetrics(period);
    }
    const rows = record.activities.filter((activity: any) => {
      return timestampInPeriod(activity.occurredAt, period);
    });
    const forType = (type: string) =>
      rows.filter((activity: any) => activity.type === type);
    const lastDate = (type: string) => {
      const values = forType(type)
        .map((activity: any) => moscowDateOnly(activity.occurredAt))
        .filter(Boolean) as string[];
      return values.sort().at(-1) || null;
    };
    const dealRows = forType("DEAL");
    const dealAmount = centsToMoney(
      dealRows.reduce(
        (sum: bigint, activity: any) =>
          sum + moneyToCents(String(activity.amount || "0")),
        0n,
      ),
    );
    return {
      period: { from: period.fromIso, to: period.toIso },
      availability: "EXACT",
      fixations: forType("FIXATION").length,
      meetings: forType("MEETING").length,
      deals: dealRows.length,
      dealAmount,
      lastFixationAt: lastDate("FIXATION"),
      lastMeetingAt: lastDate("MEETING"),
      lastDealAt: lastDate("DEAL"),
    };
  }

  private annaSpecializations(attributes: any): string[] {
    const raw = Array.isArray(attributes?.specialization)
      ? attributes.specialization
      : hasText(attributes?.specialization)
        ? String(attributes.specialization).split(/[;,\n]+/)
        : [];
    return uniqueSorted(
      raw.flatMap((entry: unknown) => {
        const value = String(entry || "").trim();
        if (
          [
            "Бизнес-класс",
            "Премиум",
            "Элитная",
            "Региональный брокер",
          ].includes(value)
        ) {
          return ["Бизнес / премиум"];
        }
        if (value === "Вторичка бизнес+") return ["Вторичка"];
        if (["Инвестиции", "Коммерция / офисы", "Коммерция"].includes(value)) {
          return ["Коммерция — аренда", "Коммерция — продажа"];
        }
        return value ? [value] : [];
      }),
    );
  }

  private annaWorkFormat(attributes: any): string | null {
    const role = String(attributes?.role || "").trim();
    const sources = Array.isArray(attributes?.sources)
      ? attributes.sources.map(String)
      : [];
    if (role === "Координатор" || sources.includes("Координаторы")) {
      return "Координатор";
    }
    if (hasText(attributes?.workFormat)) return String(attributes.workFormat);
    if (hasText(attributes?.company)) return "Агентство";
    return role || hasText(attributes?.specialization)
      ? "Частный брокер"
      : null;
  }

  private annaStage(attributes: any, entityType: EntityType): string {
    const raw = String(
      entityType === "AGENCY"
        ? attributes?.partnershipStatus || attributes?.stage || ""
        : attributes?.stage || "",
    ).trim();
    const normalized = lower(raw).replace(/[\s_-]+/g, " ");
    if (entityType === "BROKER") {
      if (["vip", "repeat deals", "repeat deal"].includes(normalized)) {
        return "Повторные сделки / VIP";
      }
      if (["bt", "broker tour", "was at bt"].includes(normalized)) {
        return "Был на БТ";
      }
      if (["contact", "called"].includes(normalized)) return "Звонили";
      if (["new", "new broker"].includes(normalized)) return "Новый";
    }
    return raw;
  }

  private annaBrokerTour(item: any, entityType: EntityType): boolean | null {
    const attributes = item.attributes || {};
    const reported = item.sourceReportedMetrics?.brokerTourVisited;
    // Anna's dashboard: hasBrokerTour = btDate || btAttended || stage «Был на БТ».
    // An explicit false from the source slice must not hide a date/stage.
    if (
      truthyText(attributes.btAttended) ||
      hasText(attributes.btDate) ||
      ["Был на БТ", "БТ проведён"].includes(
        this.annaStage(attributes, entityType),
      )
    ) {
      return true;
    }
    if (reported === true) return true;
    const count = this.annaMetricValue(item, "brokerTours");
    if (count !== null) return count > 0;
    if (reported === false) return false;
    return null;
  }

  private annaProjectStatus(value: unknown): string | null {
    if (typeof value === "boolean") return value ? "YES" : "NO";
    const normalized = lower(value);
    if (["да", "yes", "true", "размещены"].includes(normalized)) return "YES";
    if (["нет", "no", "false", "не размещены"].includes(normalized)) {
      return "NO";
    }
    if (["в процессе", "in progress", "in_progress"].includes(normalized)) {
      return "IN_PROGRESS";
    }
    return null;
  }

  private annaStatusCodes(
    item: any,
    entityType: EntityType,
    record?: any,
  ): string[] {
    const fixations = this.annaMetricValue(item, "fixations");
    const meetings = this.annaMetricValue(item, "meetings");
    const deals = this.annaMetricValue(item, "deals");
    const bt = this.annaBrokerTour(item, entityType);
    const calls = this.annaCalls(item, record);
    const lastCall = this.lastCall(calls);
    const lastActivity = this.annaDormancyLastActivity(item, record);
    const inactiveDays = daysSinceDate(lastActivity);
    const hadActivity =
      [fixations, meetings, deals].some(
        (value) => value !== null && value > 0,
      ) ||
      bt === true ||
      Boolean(lastCall) ||
      (this.annaMetricValue(item, "calls") || 0) > 0;
    let primary: string | null;
    if (hadActivity && inactiveDays !== null && inactiveDays > 90) {
      primary = entityType === "BROKER" ? "DORMANT" : "DORMANT_PARTNER";
    } else if (entityType === "BROKER") {
      primary =
        deals !== null && deals >= 3
          ? "TOP_SELLER"
          : deals !== null && deals >= 1
            ? "SELLER"
            : meetings !== null && meetings > 0
              ? "OFFERING"
              : fixations !== null && fixations > 0
                ? "FIXATING"
                : bt === true
                  ? "BROKER_TOUR"
                  : deals === 0 &&
                      meetings === 0 &&
                      fixations === 0 &&
                      bt === false
                    ? "NEW"
                    : null;
    } else {
      const stage = this.annaStage(item.attributes || {}, entityType);
      const lastResult = String(lastCall?.result || "");
      primary =
        deals !== null && deals >= 5
          ? "VIP_PARTNER"
          : deals !== null && deals >= 1
            ? "SELLING_PARTNER"
            : meetings !== null && meetings > 0
              ? "ACTIVE_PARTNER"
              : fixations !== null && fixations > 0
                ? "FIXATING_PARTNER"
                : bt === true
                  ? "WARM_PARTNER"
                  : [
                        "Установлен контакт",
                        "Назначена встреча",
                        "Согласован БТ",
                      ].includes(stage) ||
                      [
                        "Есть договорённости",
                        "Договорились о сотрудничестве",
                        "Перезвонить",
                        "Отправить информацию",
                      ].includes(lastResult)
                    ? "STARTING_PARTNER"
                    : deals === 0 &&
                        meetings === 0 &&
                        fixations === 0 &&
                        bt === false
                      ? "NEW_AGENCY"
                      : null;
    }
    const result = primary ? [primary] : [];
    if (entityType === "BROKER" && bt === true && primary !== "BROKER_TOUR") {
      result.push("BROKER_TOUR");
    }
    return result;
  }

  private annaDataQualityCodes(item: any, entityType: EntityType): string[] {
    const hasPhone = (item.contactPoints || []).some(
      (point: any) =>
        point.type === "PHONE" &&
        normalizeLoyaltyContactPoint("PHONE", point.value),
    );
    const hasAmo = (item.externalIdentities || []).some(
      (identity: any) => identity.system === "AMOCRM",
    );
    const quality = lower(item.attributes?.dataQuality);
    const conflict =
      /conflict|конфликт|дубл|несколько/.test(quality) ||
      item.attributes?.membership === "ambiguous";
    const nameComplete =
      entityType === "AGENCY" ||
      String(item.displayName || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length >= 2;
    const full = hasPhone && hasAmo && nameComplete && !conflict;
    return uniqueSorted([
      full ? "FULL" : "NEEDS_COMPLETION",
      !hasAmo || /не найден|not found/.test(quality)
        ? "NOT_FOUND_IN_CRM"
        : undefined,
      conflict ? "CONFLICT" : undefined,
    ]);
  }

  private annaLastActivity(item: any, record?: any): string | null {
    const calls = this.annaCalls(item, record);
    const values = [
      this.callSortKey(this.lastCall(calls) || {}),
      ...(Array.isArray(record?.activities)
        ? record.activities.map((activity: any) => activity.occurredAt)
        : []),
      item.sourceReportedMetrics?.brokerTourAt,
      item.sourceReportedMetrics?.lastFixationAt,
      item.sourceReportedMetrics?.lastMeetingAt,
      item.sourceReportedMetrics?.lastDealAt,
      item.attributes?.lastAgencyMeetingDate,
      item.attributes?.lastContractDate,
      ...(Array.isArray(record?.__workflowEvents?.effective)
        ? record.__workflowEvents.effective.map(
            (event: LoyaltyEngagementView) => event.occurredAt,
          )
        : []),
    ]
      .map(dateOnly)
      .filter(Boolean) as string[];
    return values.sort().at(-1) || null;
  }

  private annaDormancyLastActivity(item: any, record?: any): string | null {
    const calls = this.annaCalls(item, record);
    const values = [
      this.callSortKey(this.lastCall(calls) || {}),
      ...(Array.isArray(record?.activities)
        ? record.activities.map((activity: any) => activity.occurredAt)
        : []),
      item.sourceReportedMetrics?.brokerTourAt,
      item.sourceReportedMetrics?.lastFixationAt,
      item.sourceReportedMetrics?.lastMeetingAt,
      item.sourceReportedMetrics?.lastDealAt,
      item.attributes?.lastAgencyMeetingDate,
      item.attributes?.lastContractDate,
    ]
      .map(dateOnly)
      .filter(Boolean) as string[];
    return values.sort().at(-1) || null;
  }

  private matchesAnnaRecord(
    record: any,
    item: any,
    entityType: EntityType,
    filter: CanonicalLoyaltyFilter,
    search?: string,
  ): boolean {
    const attributes = item.attributes || {};
    const calls = this.annaCalls(item, record);
    const callCount = this.annaMetricValue(item, "calls");
    const exactCallCount =
      item.metricSource?.kind === "EXACT_ACTIVITIES" ? callCount : null;
    const exactObservedThrough = this.exactActivityObservedThrough(item);
    const lifetimeFixations = this.annaMetricValue(item, "fixations");
    const lifetimeMeetings = this.annaMetricValue(item, "meetings");
    const lifetimeDeals = this.annaMetricValue(item, "deals");
    const brokerTours = this.annaMetricValue(item, "brokerTours");
    const bt = this.annaBrokerTour(item, entityType);
    const assignee = String(attributes.assignee || "").trim();
    const stage = this.annaStage(attributes, entityType);
    const specializations = this.annaSpecializations(attributes);
    const workFormat = this.annaWorkFormat(attributes);
    const projectStatus = this.annaProjectStatus(attributes.projectsOnSite);
    const statusCodes = this.annaStatusCodes(item, entityType, record);
    const dataQualityCodes = this.annaDataQualityCodes(item, entityType);
    const latestCall = this.lastCall(calls);
    const callAssignees = uniqueSorted(
      calls.flatMap((call) => this.callAssigneeValues(call)),
    );
    const assignees = uniqueSorted([
      assignee,
      attributes.assigneeId,
      ...callAssignees,
    ]);
    item.computedStatuses = statusCodes;
    item.dataQualityCodes = dataQualityCodes;
    item.lastActivityAt = this.annaLastActivity(item, record);
    item.periodMetrics = this.annaPeriodMetrics(
      record,
      item,
      filter.activityPeriod,
    );
    // Aggregate-only снапшоты (без точных активностей) не умеют считать
    // метрики за период: periodMetrics приходит UNAVAILABLE (все значения
    // null). Раньше такие записи всегда отбрасывались фильтрами по сделкам /
    // встречам / фиксациям, хотя итоговые (lifetime) числа известны из
    // sourceReportedMetrics — те же числа, что показывает KPI «известно у…».
    // Поэтому при недоступных периодных данных используем lifetime-значения;
    // если и их нет (null) — запись остаётся «неизвестной» и отбрасывается
    // только заданным фильтром. Для EXACT_ACTIVITIES-записей, чей период
    // наблюдения просто не покрывает запрошенный, ответ остаётся «неизвестно».
    const periodMetricsUnavailable =
      item.periodMetrics?.availability === "UNAVAILABLE" &&
      item.metricSource?.kind !== "EXACT_ACTIVITIES";
    const filteredFixations =
      filter.activityPeriod && !periodMetricsUnavailable
        ? finiteNumber(item.periodMetrics.fixations)
        : lifetimeFixations;
    const filteredMeetings =
      filter.activityPeriod && !periodMetricsUnavailable
        ? finiteNumber(item.periodMetrics.meetings)
        : lifetimeMeetings;
    const filteredDeals =
      filter.activityPeriod && !periodMetricsUnavailable
        ? finiteNumber(item.periodMetrics.deals)
        : lifetimeDeals;
    item.lastCallAt = latestCall
      ? latestCall.occurredAt || this.callSortKey(latestCall) || null
      : null;
    item.lastCallResult = latestCall
      ? this.resultCodeForValue(entityType, latestCall.result)
      : null;
    item.lastCallCampaign = latestCall?.campaign || null;
    item.lastCallCampaignId = latestCall?.campaignId || null;
    item.lastCallCampaignName = latestCall?.campaignName || null;
    item.lastCallOperator = latestCall?.employee || null;
    item.lastCallOperatorId = latestCall?.employeeId || null;
    item.lastCallComment = latestCall?.comment || latestCall?.agreement || null;
    item.lastCallNextStep = latestCall?.nextStep || null;
    item.lastCallNextActionAt = latestCall?.nextActionAt || null;
    if (latestCall?.employee || latestCall?.employeeId) {
      item.assignee = {
        id: latestCall.employeeId || null,
        name: latestCall.employeeName || latestCall.employee || null,
      };
    }
    item.normalizedSpecializations = specializations;
    item.normalizedWorkFormat = workFormat;
    item.normalizedStage = stage;

    if (filter.city && lower(item.city) !== lower(filter.city)) return false;
    if (search) {
      const normalizedPhone = normalizeLoyaltyContactPoint("PHONE", search);
      const haystack = [
        item.displayName,
        item.city,
        item.taxId,
        attributes.company,
        ...(Array.isArray(attributes.aliases) ? attributes.aliases : []),
        ...(Array.isArray(attributes.companyAliases)
          ? attributes.companyAliases
          : []),
        ...(item.agencies || []).map((agency: any) => agency.displayName),
        ...(item.brokers || []).map((broker: any) => broker.displayName),
        ...(attributes.agencyContacts || []).flatMap((contact: any) => [
          contact?.name,
          contact?.email,
          contact?.phone,
        ]),
        ...(item.contactPoints || []).flatMap((point: any) => [
          point.value,
          point.maskedValue,
        ]),
      ]
        .map(lower)
        .join(" ");
      const phoneMatch =
        normalizedPhone &&
        (item.contactPoints || []).some(
          (point: any) =>
            point.type === "PHONE" &&
            normalizeLoyaltyContactPoint("PHONE", point.value) ===
              normalizedPhone,
        );
      if (!phoneMatch && !haystack.includes(lower(search))) return false;
    }
    if (filter.activityType) {
      if (
        this.annaActivityPresence(
          record,
          item,
          filter.activityType,
          filter.activityPeriod,
        ) !== true
      )
        return false;
    }
    if (entityType === "BROKER" && filter.segment) {
      if (filter.segment === "NOT_CALLED_CURRENT_MONTH") {
        if (!this.isAnnaNotCalledCurrentMonth(record, item)) return false;
      }
      if (
        filter.segment === "NEW_BROKER" &&
        (!statusCodes.includes("NEW") ||
          !hasLoyaltyAcquisitionPhone(item.contactPoints || []))
      )
        return false;
      if (
        filter.segment === "BT_WITHOUT_FIXATION" &&
        !(bt === true && lifetimeFixations === 0)
      )
        return false;
      if (
        filter.segment === "BIRTHDAY_TODAY" &&
        annaBirthday(attributes) !== moscowDateParts().dayMonth
      )
        return false;
    }
    if (filter.campaignIds.length) {
      const aliases = this.campaignAliases(filter.campaignIds).map(lower);
      const matchingCalls = filter.callPeriod
        ? calls.filter(
            (call) => this.callInPeriod(call, filter.callPeriod!) === true,
          )
        : calls;
      if (
        !matchingCalls.some((call) =>
          this.callCampaignValues(call).some((value) =>
            aliases.includes(lower(value)),
          ),
        )
      )
        return false;
    }
    if (filter.lastCallResults.length) {
      const aliases = this.resultAliases(
        entityType,
        filter.lastCallResults,
      ).map(lower);
      const campaignAliases = this.campaignAliases(filter.campaignIds).map(
        lower,
      );
      const eligibleCalls = calls.filter(
        (call) =>
          (!filter.callPeriod ||
            this.callInPeriod(call, filter.callPeriod) === true) &&
          (!campaignAliases.length ||
            this.callCampaignValues(call).some((value) =>
              campaignAliases.includes(lower(value)),
            )),
      );
      const latest = this.lastCall(eligibleCalls);
      if (!latest || !aliases.includes(lower(latest.result))) return false;
    }
    if (filter.called !== undefined) {
      const presence = this.callPresenceInPeriod(
        calls,
        exactCallCount,
        filter.callPeriod!,
        exactObservedThrough,
      );
      if (presence === null || presence !== filter.called) return false;
    }
    if (
      filter.assigneeIds.length &&
      !filter.assigneeIds.some((value) => assignees.includes(value))
    )
      return false;
    if (filter.unassigned === true && assignees.length) return false;
    if (
      filter.specializations.length &&
      !filter.specializations.some((value) => specializations.includes(value))
    )
      return false;
    if (filter.geography.length) {
      const geography = explicitGeography([item.city, attributes.region]);
      if (!geography || !filter.geography.includes(geography)) return false;
    }
    if (
      filter.workFormats.length &&
      !filter.workFormats.includes(String(workFormat || ""))
    )
      return false;
    if (
      filter.relationshipStages.length &&
      !filter.relationshipStages.includes(stage)
    )
      return false;
    if (
      filter.brokerStatuses.length &&
      !filter.brokerStatuses.some((value) => statusCodes.includes(value))
    )
      return false;
    if (
      filter.dataQuality.length &&
      !filter.dataQuality.some((value) => dataQualityCodes.includes(value))
    )
      return false;
    if (
      filter.dealCount.min !== undefined &&
      (filteredDeals === null || filteredDeals < filter.dealCount.min)
    )
      return false;
    if (
      filter.dealCount.max !== undefined &&
      (filteredDeals === null || filteredDeals > filter.dealCount.max)
    )
      return false;
    if (filter.dealsInPeriod !== undefined) {
      if (filteredDeals === null || filteredDeals > 0 !== filter.dealsInPeriod)
        return false;
    }
    if (filter.bt !== undefined && (bt === null || bt !== filter.bt))
      return false;
    if (
      filter.meetings.min !== undefined &&
      (filteredMeetings === null || filteredMeetings < filter.meetings.min)
    )
      return false;
    if (
      filter.meetings.max !== undefined &&
      (filteredMeetings === null || filteredMeetings > filter.meetings.max)
    )
      return false;
    if (
      filter.partnershipStatuses.length &&
      !filter.partnershipStatuses.includes(stage)
    )
      return false;
    if (
      filter.agencySizes.length &&
      !filter.agencySizes.includes(String(attributes.agencySize || ""))
    )
      return false;
    if (
      filter.websitePresent !== undefined &&
      hasText(attributes.website) !== filter.websitePresent
    )
      return false;
    if (filter.projectsOnSite.length) {
      if (!projectStatus || !filter.projectsOnSite.includes(projectStatus)) {
        return false;
      }
    }
    const workflowEvents: LoyaltyEngagementView[] = Array.isArray(
      record?.__workflowEvents?.effective,
    )
      ? record.__workflowEvents.effective
      : [];
    const sourceHasIndividualTerms =
      hasText(attributes.specialTerms) ||
      ["Предложены", "Согласованы", "Действуют"].includes(
        String(attributes.specialTermsStatus || ""),
      );
    const hasIndividualTerms =
      sourceHasIndividualTerms ||
      workflowEvents.some((event) => event.type === "INDIVIDUAL_TERMS");
    const sourceSpecialTermsProposed =
      String(attributes.specialTermsStatus || "") === "Предложены" ||
      (Array.isArray(attributes.recognitions) &&
        attributes.recognitions.some((recognition: any) =>
          /индивидуальн.*услов|спец.*услов/i.test(
            String(recognition?.type || recognition?.name || ""),
          ),
        ));
    const specialTermsProposed =
      sourceSpecialTermsProposed ||
      workflowEvents.some((event) => event.type === "INDIVIDUAL_TERMS");
    if (
      filter.individualTerms !== undefined &&
      hasIndividualTerms !== filter.individualTerms
    )
      return false;
    if (
      filter.specialTermsProposed !== undefined &&
      specialTermsProposed !== filter.specialTermsProposed
    )
      return false;
    const sourceHasReward =
      Array.isArray(attributes.recognitions) &&
      attributes.recognitions.length > 0;
    const hasReward =
      sourceHasReward || workflowEvents.some((event) => event.type === "AWARD");
    if (
      filter.rewardPresent !== undefined &&
      hasReward !== filter.rewardPresent
    )
      return false;
    if (filter.staleDays !== undefined) {
      const days = daysSinceDate(item.lastActivityAt);
      if (days === null || days < filter.staleDays) return false;
    }
    if (
      !this.matchesColumnFilters(filter, {
        hasPhone: (item.contactPoints || []).some(
          (point: any) =>
            point.type === "PHONE" &&
            normalizeLoyaltyContactPoint("PHONE", point.value) !== null,
        ),
        statuses: statusCodes,
        bt,
        fixations: filteredFixations,
        meetings: filteredMeetings,
        callPresence: this.callPresenceInPeriod(
          calls,
          exactCallCount,
          filter.callPeriod,
          exactObservedThrough,
        ),
        assignees,
        deals: filteredDeals,
      })
    )
      return false;
    if (
      filter.scenario &&
      !this.matchesScenario(filter.scenario, {
        callPresence: this.callPresenceInPeriod(
          calls,
          exactCallCount,
          filter.callPeriod,
          exactObservedThrough,
        ),
        bt,
        fixations: filteredFixations,
        meetings: filteredMeetings,
        deals: filteredDeals,
        assignee: assignees[0] || "",
        stage,
        projectsOnSite: projectStatus,
        hasIndividualTerms,
      })
    )
      return false;
    return true;
  }

  private matchesScenario(scenario: string, value: any): boolean {
    if (scenario === "NOT_CALLED_IN_PERIOD")
      return value.callPresence === false;
    if (scenario === "CALLED_IN_PERIOD") return value.callPresence === true;
    if (scenario === "BT_DROPPED")
      return (
        value.bt === true &&
        value.fixations === 0 &&
        value.meetings === 0 &&
        value.deals === 0
      );
    if (scenario === "BT_FIXATION_NO_MEETING")
      return value.bt === true && value.fixations > 0 && value.meetings === 0;
    if (scenario === "BT_MEETING_NO_DEAL")
      return value.bt === true && value.meetings > 0 && value.deals === 0;
    if (scenario === "NEW_NO_BT")
      // Anna's dashboard: exclude only those who already attended BT.
      return value.bt !== true;
    if (scenario === "HAS_DEALS")
      return value.deals !== null && value.deals > 0;
    if (scenario === "UNASSIGNED") return !value.assignee;
    if (scenario === "BT_VISITED") return value.bt === true;
    if (scenario === "BT_NOT_VISITED") return value.bt !== true;
    if (scenario === "SITE_PLACED") return value.projectsOnSite === "YES";
    if (scenario === "SITE_NOT_PLACED") return value.projectsOnSite !== "YES";
    if (scenario === "INDIVIDUAL_TERMS")
      return value.hasIndividualTerms === true;
    if (scenario === "NO_INDIVIDUAL_TERMS")
      return value.hasIndividualTerms === false;
    if (scenario === "HAS_MEETINGS")
      return value.meetings !== null && value.meetings > 0;
    if (scenario === "NO_MEETINGS") return value.meetings === 0;
    return false;
  }

  private matchesColumnFilters(
    filter: CanonicalLoyaltyFilter,
    value: {
      hasPhone: boolean | null;
      statuses: string[];
      bt: boolean | null;
      fixations: number | null;
      meetings: number | null;
      callPresence: boolean | null;
      assignees: string[] | null;
      deals: number | null;
    },
  ): boolean {
    const columns = filter.columns;
    if (columns.contact === "HAS_PHONE" && value.hasPhone !== true)
      return false;
    if (columns.contact === "NO_PHONE" && value.hasPhone !== false)
      return false;
    if (columns.statusStage && !value.statuses.includes(columns.statusStage))
      return false;
    if (columns.activity === "BT_VISITED" && value.bt !== true) return false;
    if (columns.activity === "BT_NOT_VISITED" && value.bt === true)
      return false;
    if (
      columns.activity === "HAS_FIXATIONS" &&
      !(value.fixations !== null && value.fixations > 0)
    )
      return false;
    if (columns.activity === "NO_FIXATIONS" && value.fixations !== 0)
      return false;
    if (
      columns.activity === "HAS_MEETINGS" &&
      !(value.meetings !== null && value.meetings > 0)
    )
      return false;
    if (columns.activity === "NO_MEETINGS" && value.meetings !== 0)
      return false;
    if (columns.calls === "CALLED_IN_PERIOD" && value.callPresence !== true)
      return false;
    if (
      columns.calls === "NOT_CALLED_IN_PERIOD" &&
      value.callPresence !== false
    )
      return false;
    if (
      columns.assignee === "UNASSIGNED" &&
      (value.assignees === null || value.assignees.length > 0)
    )
      return false;
    if (
      columns.assignee &&
      columns.assignee !== "UNASSIGNED" &&
      (value.assignees === null || !value.assignees.includes(columns.assignee))
    )
      return false;
    if (
      columns.deals === "HAS_DEALS" &&
      !(value.deals !== null && value.deals > 0)
    )
      return false;
    if (columns.deals === "NO_DEALS" && value.deals !== 0) return false;
    if (
      columns.deals === "ONE_TO_TWO" &&
      !(value.deals !== null && value.deals >= 1 && value.deals <= 2)
    )
      return false;
    if (
      columns.deals === "ONE_TO_FOUR" &&
      !(value.deals !== null && value.deals >= 1 && value.deals <= 4)
    )
      return false;
    if (
      columns.deals === "THREE_PLUS" &&
      !(value.deals !== null && value.deals >= 3)
    )
      return false;
    if (
      columns.deals === "FIVE_PLUS" &&
      !(value.deals !== null && value.deals >= 5)
    )
      return false;
    return true;
  }

  private sortLoyaltyCandidates(
    candidates: any[],
    filter: CanonicalLoyaltyFilter,
  ) {
    const activityMetric = (item: any, field: string) =>
      filter.activityPeriod
        ? finiteNumber(item.periodMetrics?.[field])
        : finiteNumber(
            item.metrics?.[field] ?? item.sourceReportedMetrics?.[field],
          );
    const value = (item: any): string | number | null => {
      if (filter.sortBy === "name") return item.displayName || null;
      if (filter.sortBy === "city") return item.city || null;
      if (filter.sortBy === "lastCallAt")
        return (
          item.lastCallAt || item.sourceReportedMetrics?.lastCallAt || null
        );
      if (filter.sortBy === "updatedAt") return item.updatedAt || null;
      if (filter.sortBy === "brokerCount")
        return finiteNumber(
          item.attributes?.brokerCount ?? item.metrics?.brokers,
        );
      if (filter.sortBy === "rating")
        return finiteNumber(item.attributes?.rating);
      if (filter.sortBy === "dealAmount")
        return activityMetric(item, "dealAmount");
      const key: Record<string, string> = {
        fixations: "fixations",
        meetings: "meetings",
        deals: "deals",
        brokerTours: "brokerTours",
      };
      const field = key[filter.sortBy];
      return field ? activityMetric(item, field) : null;
    };
    candidates.sort((leftCandidate, rightCandidate) => {
      const left = value(leftCandidate.item);
      const right = value(rightCandidate.item);
      if (left === null && right === null)
        return String(leftCandidate.item.id).localeCompare(
          String(rightCandidate.item.id),
        );
      if (left === null) return 1;
      if (right === null) return -1;
      const comparison =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), "ru", {
              numeric: true,
              sensitivity: "base",
            });
      return filter.sortOrder === "desc" ? -comparison : comparison;
    });
  }

  private loyaltyFacets(items: any[]) {
    const count = (values: Array<string | null | undefined>) => {
      const result = new Map<string, number>();
      for (const value of values) {
        const normalized = String(value || "").trim();
        if (!normalized) continue;
        result.set(normalized, (result.get(normalized) || 0) + 1);
      }
      return [...result.entries()]
        .sort(([left], [right]) => left.localeCompare(right, "ru"))
        .slice(0, 200)
        .map(([value, matches]) => ({ value, matches }));
    };
    return {
      cities: count(items.map((item) => item.city)),
      assignees: count(
        items.map((item) => item.attributes?.assignee ?? item.assignee?.name),
      ),
      specializations: count(
        items.flatMap((item) =>
          Array.isArray(item.normalizedSpecializations)
            ? item.normalizedSpecializations
            : Array.isArray(item.attributes?.specialization)
              ? item.attributes.specialization
              : item.specialization
                ? [item.specialization]
                : [],
        ),
      ),
      stages: count(
        items.map(
          (item) =>
            item.normalizedStage ||
            item.attributes?.partnershipStatus ||
            item.attributes?.stage ||
            item.funnelStage,
        ),
      ),
      workFormats: count(
        items.map(
          (item) => item.normalizedWorkFormat || item.attributes?.workFormat,
        ),
      ),
      statuses: count(items.flatMap((item) => item.computedStatuses || [])),
      dataQuality: count(items.flatMap((item) => item.dataQualityCodes || [])),
      agencySizes: count(items.map((item) => item.attributes?.agencySize)),
      campaigns: count(items.map((item) => item.lastCallCampaign)),
      lastCallResults: count(items.map((item) => item.lastCallResult)),
      engagementTypes: count(
        items.flatMap((item) => item.engagementTypes || []),
      ),
    };
  }

  private annaRecordInclude(
    snapshotId: string,
    ruleVersion: string,
    detailed: boolean,
  ): any {
    return {
      person: {
        include: {
          contactOverrides: {
            where: { archivedAt: null },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          },
          links: {
            where: { status: "CONFIRMED", revokedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
      organization: {
        include: {
          contactOverrides: {
            where: { archivedAt: null },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          },
          links: {
            where: { status: "CONFIRMED", revokedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          contactPeople: {
            where: { archivedAt: null },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
          personRoles: {
            where: { validTo: null, sourceRecord: { snapshotId } },
            include: {
              person: {
                include: { sourceRecords: { where: { snapshotId }, take: 1 } },
              },
            },
          },
        },
      },
      contactPoints: { orderBy: [{ isPrimary: "desc" }, { type: "asc" }] },
      externalIdentities: {
        orderBy: [{ system: "asc" }, { isPrimary: "desc" }],
      },
      metrics: {
        where: { ruleVersion },
        orderBy: { calculatedAt: "desc" },
        take: 1,
      },
      sourceAggregate: true,
      organizationRoles: {
        where: { validTo: null, sourceRecord: { snapshotId } },
        include: {
          organization: {
            include: { sourceRecords: { where: { snapshotId }, take: 1 } },
          },
        },
      },
      ...(detailed
        ? {
            activities: { orderBy: { occurredAt: "desc" }, take: 1000 },
            fieldValues: { orderBy: { observedAt: "desc" }, take: 500 },
          }
        : {}),
    };
  }

  private annaManualEntityInclude(): any {
    const confirmedLinks = {
      where: { status: "CONFIRMED", revokedAt: null },
      orderBy: { createdAt: "desc" },
      take: 1,
    };
    return {
      person: {
        include: {
          links: confirmedLinks,
          contactOverrides: {
            where: { archivedAt: null },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          },
        },
      },
      organization: {
        include: {
          links: confirmedLinks,
          contactOverrides: {
            where: { archivedAt: null },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          },
          contactPeople: {
            where: { archivedAt: null },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      },
    };
  }

  /**
   * Manual contacts are an overlay, never rows in an immutable snapshot. A
   * stable entity that has since appeared in the active import is intentionally
   * omitted here: the authoritative source row wins without double counting.
   */
  private async annaManualRecords(
    datasetId: string,
    snapshotId: string,
    entityType: EntityType,
    filter: CanonicalLoyaltyFilter,
  ): Promise<any[]> {
    if (filter.hasAmo === true) return [];
    const delegate = (this.prisma as any).loyaltyManualEntity;
    if (!delegate?.findMany) return [];
    const relationName = entityType === "BROKER" ? "person" : "organization";
    const relationWhere: any = {
      sourceRecords: { none: { snapshotId } },
    };
    const where: any = { datasetId, entityType };
    if (filter.archived === "exclude") {
      where.archivedAt = null;
      relationWhere.archivedAt = null;
    } else if (filter.archived === "only") {
      where.OR = [
        { archivedAt: { not: null } },
        { [relationName]: { is: { archivedAt: { not: null } } } },
      ];
    }
    where[relationName] = { is: relationWhere };
    const overlays =
      (await delegate.findMany({
        where,
        include: this.annaManualEntityInclude(),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })) || [];
    return overlays.map((overlay: any) =>
      this.manualOverlayAsAnnaRecord(overlay),
    );
  }

  private manualOverlayAsAnnaRecord(overlay: any): any {
    const contactPoints = Array.isArray(overlay.contactPoints)
      ? overlay.contactPoints
      : [];
    const attributes =
      overlay.attributes && typeof overlay.attributes === "object"
        ? overlay.attributes
        : {};
    return {
      __manualOverlay: true,
      id: overlay.id,
      entityType: overlay.entityType,
      displayName: overlay.displayName,
      city: overlay.city,
      taxId: null,
      attributes: {
        ...attributes,
        source: "MANUAL",
        dataQuality: "NEEDS_COMPLETION",
        manualOverlay: true,
      },
      sourceArchivedAt: overlay.archivedAt,
      person: overlay.person,
      organization: overlay.organization
        ? { ...overlay.organization, personRoles: [] }
        : null,
      contactPoints,
      externalIdentities: [],
      metrics: [],
      sourceAggregate: null,
      organizationRoles: [],
      activities: [],
      fieldValues: [],
      manualOverlayId: overlay.id,
      manualVersion: overlay.version,
      manualCreatedAt: overlay.createdAt,
      manualUpdatedAt: overlay.updatedAt,
    };
  }

  private mapAnnaManualRecord(record: any, detailed: boolean): any {
    const item = this.mapAnnaRecord(record, detailed);
    item.sourceRecordId = null;
    item.manualOverlay = true;
    item.manualOverlayId = record.manualOverlayId;
    item.version = record.manualVersion;
    item.updatedAt = record.manualUpdatedAt || item.updatedAt;
    if (detailed) {
      item.provenance = [
        {
          fieldName: "manualOverlay",
          sourceSystem: "MANUAL",
          observedAt: record.manualCreatedAt,
          lockedByUser: true,
        },
      ];
    }
    return item;
  }

  private annaContactPoints(record: any, entity: any) {
    const byValue = new Map<string, any>();
    for (const point of [
      ...(Array.isArray(record.contactPoints) ? record.contactPoints : []),
      ...(Array.isArray(entity?.contactOverrides)
        ? entity.contactOverrides
        : []),
    ]) {
      const normalized =
        point.normalizedValue || point.normalized || point.value || "";
      const key = `${point.type || "OTHER"}:${normalized}`;
      byValue.set(key, {
        id: point.id,
        type: point.type,
        value: point.value,
        normalizedValue: normalized,
        maskedValue: maskContact(point.type, point.value),
        label: point.label,
        isPrimary: point.isPrimary,
        ...(point.version
          ? {
              version: point.version,
              source: "MANUAL_OVERRIDE",
              archivedAt: point.archivedAt || null,
            }
          : { source: "SNAPSHOT" }),
      });
    }
    return [...byValue.values()].sort(
      (left, right) =>
        Number(Boolean(right.isPrimary)) - Number(Boolean(left.isPrimary)) ||
        String(left.type).localeCompare(String(right.type), "ru"),
    );
  }

  private annaAgencyContactPeople(record: any, attributes: any) {
    const normalizePoints = (value: unknown) => {
      const raw = Array.isArray(value) ? value : [];
      return raw
        .filter((point) => point && typeof point === "object")
        .map((point: any) => ({
          type: String(point.type || "OTHER"),
          value: point.value === undefined ? null : String(point.value),
          label: point.label === undefined ? null : String(point.label),
          isPrimary: Boolean(point.isPrimary),
        }));
    };
    const source = Array.isArray(attributes?.agencyContacts)
      ? attributes.agencyContacts.map((contact: any, index: number) => {
          const points = normalizePoints(contact?.contactPoints);
          if (hasText(contact?.phone)) {
            points.push({
              type: "PHONE",
              value: String(contact.phone),
              label: null,
              isPrimary: !points.some((point) => point.type === "PHONE"),
            });
          }
          if (hasText(contact?.email)) {
            points.push({
              type: "EMAIL",
              value: String(contact.email),
              label: null,
              isPrimary: !points.some((point) => point.type === "EMAIL"),
            });
          }
          return {
            id: contact?.id ? String(contact.id) : `source-contact-${index}`,
            displayName:
              String(contact?.displayName || contact?.name || "").trim() ||
              null,
            role: String(contact?.role || "").trim() || null,
            actualityStatus:
              String(contact?.actualityStatus || "SOURCE_REPORTED") ||
              "SOURCE_REPORTED",
            contactPoints: points,
            source: "SNAPSHOT_ATTRIBUTE",
          };
        })
      : [];
    const manual = Array.isArray(record?.organization?.contactPeople)
      ? record.organization.contactPeople.map((contact: any) => ({
          id: String(contact.id),
          displayName: String(contact.displayName || "").trim() || null,
          role: String(contact.role || "").trim() || null,
          actualityStatus: String(contact.actualityStatus || "CURRENT"),
          contactPoints: normalizePoints(contact.contactPoints),
          source: "MANUAL_OVERLAY",
          version: contact.version,
          createdAt: contact.createdAt,
          updatedAt: contact.updatedAt,
        }))
      : [];
    const byIdentity = new Map<string, any>();
    for (const contact of [...source, ...manual]) {
      const normalizedContacts = contact.contactPoints
        .map((point: any) =>
          normalizeLoyaltyContactPoint(point.type, point.value || ""),
        )
        .filter(Boolean)
        .sort()
        .join("|");
      const key = `${lower(contact.displayName)}:${normalizedContacts}`;
      // Manual overlays intentionally win over imported source attributes.
      if (!byIdentity.has(key) || contact.source === "MANUAL_OVERLAY") {
        byIdentity.set(key, contact);
      }
    }
    return [...byIdentity.values()];
  }

  private mapAnnaRecord(
    record: any,
    detailed: boolean,
    activityObservedThrough: string | null = null,
  ) {
    const entity = record.person || record.organization;
    const metricView = this.annaMetricView(record, activityObservedThrough);
    const result: any = {
      id: entity?.id,
      sourceRecordId: record.id,
      entityType: record.entityType,
      displayName: entity?.manualDisplayName || record.displayName,
      city: entity?.manualCity || record.city,
      taxId: record.taxId,
      attributes: {
        ...(record.attributes || {}),
        ...(entity?.manualAttributes || {}),
      },
      updatedAt: entity?.updatedAt || null,
      archivedAt: entity?.archivedAt || record.sourceArchivedAt,
      contactPoints: this.annaContactPoints(record, entity),
      externalIdentities: record.externalIdentities || [],
      metrics: metricView.metrics,
      metricSource: metricView.source,
      sourceReportedMetrics: metricView.sourceReported,
      periodMetrics: this.unavailablePeriodMetrics(),
      linkedOurs: entity?.links?.[0]
        ? {
            type: entity.links[0].targetType,
            id: entity.links[0].targetId,
            linkId: entity.links[0].id,
          }
        : null,
      agencies: (record.organizationRoles || []).map((role: any) => ({
        id: role.organizationId,
        displayName:
          role.organization?.manualDisplayName ||
          role.organization?.sourceRecords?.[0]?.displayName ||
          null,
        role: role.role,
        isPrimary: role.isPrimary,
        validFrom: role.validFrom,
        validTo: role.validTo,
      })),
      brokers: (record.organization?.personRoles || []).map((role: any) => ({
        id: role.personId,
        displayName:
          role.person?.manualDisplayName ||
          role.person?.sourceRecords?.[0]?.displayName ||
          null,
        role: role.role,
        isPrimary: role.isPrimary,
        validFrom: role.validFrom,
        validTo: role.validTo,
      })),
    };
    const canonicalCalls = this.annaCalls(result, record);
    this.applyCallSummary(result, record.entityType, canonicalCalls);
    this.applyEngagementSummary(result, record);
    if (detailed) {
      result.activities = record.activities || [];
      const fullCallHistory = this.annaCallHistory(result, record);
      result.calls = fullCallHistory;
      result.callHistory = fullCallHistory;
      result.attributes = {
        ...result.attributes,
        calls: fullCallHistory,
      };
      const engagementHistory = Array.isArray(record?.__workflowEvents?.history)
        ? record.__workflowEvents.history
        : [];
      result.engagementEvents = engagementHistory;
      result.loyaltyHistory = engagementHistory;
      if (record.entityType === "AGENCY") {
        result.agencyContactPeople = this.annaAgencyContactPeople(
          record,
          result.attributes,
        );
      }
      result.provenance = (record.fieldValues || []).map((field: any) => ({
        id: field.id,
        fieldName: field.fieldName,
        sourceSystem: field.sourceSystem,
        sourceExternalId: field.sourceExternalId,
        lockedByUser: field.lockedByUser,
        observedAt: field.observedAt,
        valueHash: field.valueHash,
      }));
    }
    return result;
  }

  private annaMetricView(
    record: any,
    activityObservedThrough: string | null = null,
  ) {
    const exact = record.metrics?.[0] || null;
    const aggregate = record.sourceAggregate || null;
    const exactEvidenceCount = Number(exact?.activityEvidenceCount || 0);
    // A metric row is materialized for every imported record. Under a trusted
    // full-snapshot attestation, a row with zero event evidence is therefore
    // an exact zero rather than missing data. Conversely, one event in a
    // partial import never makes the remaining metrics exact.
    const exactAvailable = Boolean(exact && activityObservedThrough);
    const sourceReported = aggregate
      ? {
          fixations:
            aggregate.fixationCount === null ||
            aggregate.fixationCount === undefined
              ? null
              : Number(aggregate.fixationCount),
          meetings:
            aggregate.meetingCount === null ||
            aggregate.meetingCount === undefined
              ? null
              : Number(aggregate.meetingCount),
          deals:
            aggregate.dealCount === null || aggregate.dealCount === undefined
              ? null
              : Number(aggregate.dealCount),
          brokerTours:
            aggregate.brokerTourCount === null ||
            aggregate.brokerTourCount === undefined
              ? null
              : Number(aggregate.brokerTourCount),
          calls:
            aggregate.callCount === null || aggregate.callCount === undefined
              ? null
              : Number(aggregate.callCount),
          dealAmount:
            aggregate.dealAmount === null || aggregate.dealAmount === undefined
              ? null
              : String(aggregate.dealAmount),
          currency: aggregate.currency || null,
          lastFixationAt: aggregate.lastFixationAt || null,
          lastMeetingAt: aggregate.lastMeetingAt || null,
          lastDealAt: aggregate.lastDealAt || null,
          lastCallAt: aggregate.lastCallAt || null,
          brokerTourVisited: aggregate.brokerTourVisited ?? null,
          brokerTourAt: aggregate.brokerTourAt || null,
          dealsByMonth: aggregate.dealsByMonth || null,
          callBreakdown: aggregate.callBreakdown || null,
          contributesToSourceSummary:
            aggregate.contributesToSourceSummary === true,
          sourceKind: aggregate.sourceKind,
          sourceVersion: aggregate.sourceVersion,
          sourceLabel: aggregate.sourceLabel || null,
          quality: aggregate.quality,
          exactness: aggregate.exactness,
          periodKind: aggregate.periodKind,
          periodFrom: aggregate.periodFrom || null,
          periodTo: aggregate.periodTo || null,
          reportedAt: aggregate.reportedAt || null,
          provenance: aggregate.provenance || null,
        }
      : null;
    if (exactAvailable) {
      return {
        metrics: {
          fixations: Number(exact.fixationCount || 0),
          meetings: Number(exact.meetingCount || 0),
          deals: Number(exact.dealCount || 0),
          brokerTours: Number(exact.brokerTourCount || 0),
          calls: Number(exact.callCount || 0),
          dealAmount: String(exact.dealAmount || "0"),
          ruleVersion: exact.ruleVersion || null,
        },
        source: {
          kind: "EXACT_ACTIVITIES",
          label: "Event-level activities",
          available: true,
          exactness: "EXACT",
          activityEvidenceCount: exactEvidenceCount,
          observedThrough: activityObservedThrough,
          periodKind: "SNAPSHOT_LIFETIME",
          periodFilterApplied: false,
        },
        sourceReported,
      };
    }
    return {
      metrics: {
        fixations: null,
        meetings: null,
        deals: null,
        brokerTours: null,
        calls: null,
        dealAmount: null,
        ruleVersion: null,
      },
      source: {
        kind: "UNAVAILABLE",
        label: aggregate
          ? "Exact event-level KPI is unavailable; source rollup is separate"
          : null,
        available: false,
        periodFilterApplied: false,
      },
      sourceReported,
    };
  }

  private async listOurs(
    entityType: EntityType,
    query: LoyaltyListQueryDto,
    filter: CanonicalLoyaltyFilter,
    search?: string,
    includeSelectionIds = false,
  ) {
    return entityType === "BROKER"
      ? this.listOurBrokers(query, filter, search, includeSelectionIds)
      : this.listOurAgencies(query, filter, search, includeSelectionIds);
  }

  private async listOurBrokers(
    query: LoyaltyListQueryDto,
    filter: CanonicalLoyaltyFilter,
    search?: string,
    includeSelectionIds = false,
  ) {
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    const where: any = { role: "BROKER" };
    const and: any[] = [];
    if (filter.archived === "exclude") where.mergedIntoId = null;
    if (filter.archived === "only") where.mergedIntoId = { not: null };
    if (filter.city) {
      const city = lower(filter.city);
      if (city === "москва" || city === "msk") where.region = "MSK";
      else if (["санкт-петербург", "спб", "spb"].includes(city))
        where.region = "SPB";
      else if (city === "регион") where.isRegional = true;
      else where.region = { equals: filter.city, mode: "insensitive" };
    }
    if (filter.hasAmo !== undefined)
      where.amoContactId = filter.hasAmo ? { not: null } : null;
    // «Не звонить»: по умолчанию список показывает всех (фильтр не
    // применяется); кампании обзвона исключают doNotCall отдельно и всегда
    // (см. resolveSelection excludeDoNotCall).
    if (filter.doNotCall === "exclude") where.doNotCall = false;
    if (filter.doNotCall === "only") where.doNotCall = true;
    // «Действующая фиксация» (вариант В): lifetime-фильтр «Есть фиксации»
    // не меняется, действующая проверяет ещё и срок (см. комментарий у
    // activeFixationClientWhere).
    if (filter.columns.activity === "HAS_ACTIVE_FIXATIONS")
      and.push({ clients: { some: activeFixationClientWhere() } });
    if (filter.activityType)
      and.push(
        this.ourBrokerActivityFilter(
          filter.activityType,
          filter.activityPeriod,
        ),
      );
    if (filter.segment === "NOT_CALLED_CURRENT_MONTH") {
      // KPI «Не звонили в этом месяце» считает только активных брокеров
      // (status=ACTIVE) — сегмент-дриллдаун обязан давать то же число.
      // Сам факт «не звонили» проверяется в matchesOurBroker по единой
      // модели звонков (легаси CallLog + workflow-попытки).
      and.push({ status: "ACTIVE" });
    } else if (filter.segment === "NEW_BROKER") {
      and.push({
        status: "ACTIVE",
        funnelStage: "NEW_BROKER",
        brokerTourVisited: false,
        brokerTourDate: null,
        clients: { none: FIXATION_CLIENT_WHERE },
        meetings: { none: { status: { in: ["CONFIRMED", "COMPLETED"] } } },
        deals: { none: this.ourConfirmedDealWhere() },
        registryDeals: { none: {} },
        callLogs: { none: {} },
        loyaltyAssignmentsAsTarget: { none: { attempts: { some: {} } } },
        lastCallAt: null,
      });
    } else if (filter.segment === "BT_WITHOUT_FIXATION") {
      and.push({
        brokerTourVisited: true,
        clients: { none: FIXATION_CLIENT_WHERE },
      });
    } else if (filter.segment === "BIRTHDAY_TODAY") {
      and.push({ id: { in: await this.ourBirthdayBrokerIds() } });
    }
    if (search) {
      // 2026-09-04 (аудит фильтров): поиск по телефону — через общий
      // buildPhoneSearchConditions (как admin.service.listBrokers), чтобы
      // частичный номер («5724188», «8912…») находил брокера. Условия
      // дублируются и на дополнительные телефоны (BrokerPhone.phone).
      const phoneConditions = buildPhoneSearchConditions(search);
      and.push({
        OR: [
          { fullName: { contains: search, mode: "insensitive" } },
          // «Имя для работы» тоже ищется: КЦ ищет по исправленному имени.
          { displayName: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          {
            brokerAgencies: {
              some: {
                agency: { name: { contains: search, mode: "insensitive" } },
              },
            },
          },
          ...phoneConditions,
          ...phoneConditions.map((condition) => ({
            phones: { some: condition },
          })),
        ],
      });
    }
    // Campaign/called predicates are evaluated after workflow attempts and
    // legacy call logs have been combined into one call read model.
    if (filter.dealsInPeriod !== undefined) {
      // Сделка за период — из любого источника: локальная Deal-таблица или
      // «Реестр сделок» (registry_deals, период по signedAt).
      const dealWhere = this.ourConfirmedDealWhere(filter.activityPeriod);
      const registryWhere = this.registrySignedAtWhere(filter.activityPeriod);
      and.push(
        filter.dealsInPeriod
          ? {
              OR: [
                { deals: { some: dealWhere } },
                { registryDeals: { some: registryWhere } },
              ],
            }
          : {
              deals: { none: dealWhere },
              registryDeals: { none: registryWhere },
            },
      );
    }
    if (and.length) where.AND = and;
    const callLogWhere = {
      ...(filter.callPeriod
        ? {
            createdAt: {
              gte: filter.callPeriod.from,
              lte: filter.callPeriod.to,
            },
          }
        : {}),
      ...(filter.campaignIds.length
        ? { campaign: { in: this.campaignAliases(filter.campaignIds) } }
        : {}),
    };
    const records = await this.prisma.broker.findMany({
      where,
      select: {
        id: true,
        fullName: true,
        displayName: true,
        displayNameSource: true,
        phone: true,
        email: true,
        status: true,
        funnelStage: true,
        region: true,
        isRegional: true,
        isCoordinator: true,
        specialization: true,
        category: true,
        amoContactId: true,
        mergedIntoId: true,
        doNotCall: true,
        brokerTourVisited: true,
        brokerTourDate: true,
        lastCallAt: true,
        updatedAt: true,
        assignedManagerId: true,
        assignedManager: { select: { id: true, fullName: true } },
        phones: true,
        brokerAgencies: { include: { agency: true } },
        callLogs: {
          where: callLogWhere,
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            createdAt: true,
            campaign: true,
            result: true,
            operatorId: true,
            comment: true,
            nextCallAt: true,
          },
        },
        clients: {
          where: FIXATION_CLIENT_WHERE,
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true },
        },
        meetings: {
          where: { status: { in: ["CONFIRMED", "COMPLETED"] } },
          orderBy: { date: "desc" },
          take: 1,
          select: { date: true },
        },
        deals: {
          where: this.ourConfirmedDealWhere(),
          orderBy: { signedAt: "desc" },
          take: 1,
          select: { signedAt: true },
        },
        _count: {
          select: {
            clients: { where: FIXATION_CLIENT_WHERE },
            deals: { where: this.ourConfirmedDealWhere() },
            meetings: {
              where: { status: { in: ["CONFIRMED", "COMPLETED"] } },
            },
            callLogs: true,
          },
        },
      },
    });
    await this.attachOurBrokerRegistryDeals(records as any[]);
    // 2026-09-04 (задача D): callLogWhere сузил загруженные callLogs под
    // «период звонков»/кампанию, но статус DORMANT, lastActivity и staleDays
    // считаются по последнему звонку ЗА ВСЁ ВРЕМЯ — подгружаем его отдельно.
    await this.attachOurBrokerLifetimeLastCall(
      records as any[],
      Boolean(filter.callPeriod || filter.campaignIds.length),
    );
    const workflowCalls = await this.workflowCallReadModels(
      "ours",
      "BROKER",
      (records as any[]).map((record) => String(record.id)),
    );
    this.attachWorkflowCallReadModels(
      records as any[],
      "BROKER",
      workflowCalls,
    );
    const engagementEvents = await this.engagementReadModels(
      "ours",
      "BROKER",
      (records as any[]).map((record) => String(record.id)),
    );
    this.attachEngagementReadModels(
      records as any[],
      "BROKER",
      engagementEvents,
    );
    const periodMetrics = await this.ourBrokerPeriodMetrics(
      (records as any[]).map((record) => String(record.id)),
      filter.activityPeriod,
    );
    const candidates = (records as any[])
      .map((record) => {
        const item = this.mapOurBroker(record, null);
        item.periodMetrics =
          periodMetrics.get(String(record.id)) ||
          this.unavailablePeriodMetrics(filter.activityPeriod);
        return { record, item };
      })
      .filter(({ record, item }) =>
        this.matchesOurBroker(record, item, filter),
      );
    await this.attachOurDealAmounts(
      candidates,
      "brokerId",
      filter.sortBy === "dealAmount" && !filter.activityPeriod,
    );
    this.sortLoyaltyCandidates(candidates, filter);
    const total = candidates.length;
    const pageCandidates = candidates.slice(
      (page - 1) * pageSize,
      page * pageSize,
    );
    if (filter.sortBy !== "dealAmount" || Boolean(filter.activityPeriod)) {
      await this.attachOurDealAmounts(pageCandidates, "brokerId", true);
    }
    return this.oursListEnvelope(
      "BROKER",
      query,
      filter,
      search,
      candidates,
      pageCandidates,
      total,
      {
        callPeriod: "EXACT",
        activityPeriod: filter.activityPeriod
          ? "LOCAL_PRELIMINARY"
          : "UNAVAILABLE",
      },
      includeSelectionIds,
    );
  }

  /**
   * Selected-period broker metrics are aggregated in bounded SQL batches.
   * This avoids an N+1 query per broker and avoids loading every matching
   * Client/Meeting/Deal row into application memory. A successful aggregate
   * query makes an absent group a known zero; missing dates stay null.
   */
  private async ourBrokerPeriodMetrics(
    brokerIds: string[],
    period?: LoyaltyFilterPeriod,
  ): Promise<Map<string, any>> {
    const ids = uniqueSorted(brokerIds);
    const result = new Map<string, any>();
    if (!period) return result;

    // 2026-09-07: exactness VERIFIED — агрегаты считаются напрямую из таблиц
    // кабинета (clients/meetings/deals/registry_deals) по выверенным правилам;
    // методика по-русски, потому что показывается в карточке как есть.
    const empty = () => ({
      period: { from: period.fromIso, to: period.toIso },
      availability: "LOCAL_PRELIMINARY",
      exactness: "VERIFIED",
      source: "LOCAL_OPERATIONAL_ROWS",
      methodology:
        "Считается по таблицам кабинета за выбранный период: фиксации клиентов (по правилам фиксации), подтверждённые и состоявшиеся встречи, подтверждённые сделки ДДУ и сделки из реестра.",
      fixations: 0,
      meetings: 0,
      deals: 0,
      dealAmount: "0",
      lastFixationAt: null,
      lastMeetingAt: null,
      lastDealAt: null,
    });
    for (const id of ids) result.set(id, empty());

    for (
      let offset = 0;
      offset < ids.length;
      offset += CANDIDATE_QUERY_BATCH_SIZE
    ) {
      const batch = ids.slice(offset, offset + CANDIDATE_QUERY_BATCH_SIZE);
      const [fixationGroups, meetingGroups, dealGroups, registryGroups] =
        await Promise.all([
          (this.prisma.client as any).groupBy({
          by: ["brokerId"],
          where: {
            brokerId: { in: batch },
            ...FIXATION_CLIENT_WHERE,
            createdAt: { gte: period.from, lte: period.to },
          },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
        (this.prisma.meeting as any).groupBy({
          by: ["brokerId"],
          where: {
            brokerId: { in: batch },
            status: { in: ["CONFIRMED", "COMPLETED"] },
            date: { gte: period.from, lte: period.to },
          },
          _count: { _all: true },
          _max: { date: true },
        }),
        (this.prisma.deal as any).groupBy({
          by: ["brokerId"],
          where: {
            brokerId: { in: batch },
            ...this.ourConfirmedDealWhere({ from: period.from, to: period.to }),
          },
          _count: { _all: true },
          _sum: { amount: true },
          _max: { signedAt: true },
        }),
        this.registryDealModel
          ? this.registryDealModel.groupBy({
              by: ["brokerId"],
              where: {
                brokerId: { in: batch },
                ...this.registrySignedAtWhere({
                  from: period.from,
                  to: period.to,
                }),
              },
              _count: { _all: true },
              _sum: { amount: true },
              _max: { signedAt: true },
            })
          : Promise.resolve([]),
      ]);

      for (const group of fixationGroups as any[]) {
        const target = result.get(String(group.brokerId));
        if (!target) continue;
        target.fixations = finiteNumber(
          group._count?._all ?? group._count?.brokerId,
        );
        target.lastFixationAt = dateOnly(group._max?.createdAt);
      }
      for (const group of meetingGroups as any[]) {
        const target = result.get(String(group.brokerId));
        if (!target) continue;
        target.meetings = finiteNumber(
          group._count?._all ?? group._count?.brokerId,
        );
        target.lastMeetingAt = dateOnly(group._max?.date);
      }
      for (const group of dealGroups as any[]) {
        const target = result.get(String(group.brokerId));
        if (!target) continue;
        target.deals = finiteNumber(
          group._count?._all ?? group._count?.brokerId,
        );
        target.dealAmount =
          group._sum?.amount === null || group._sum?.amount === undefined
            ? null
            : String(group._sum.amount);
        target.lastDealAt = dateOnly(group._max?.signedAt);
      }
      // «Реестр сделок»: добавляется к Deal-счётчику (после цикла выше,
      // который перезаписывает target.deals значением из Deal-таблицы).
      for (const group of registryGroups as any[]) {
        const target = result.get(String(group.brokerId));
        if (!target) continue;
        const count = finiteNumber(group._count?._all) || 0;
        if (!count) continue;
        target.deals = (finiteNumber(target.deals) || 0) + count;
        if (group._sum?.amount !== null && group._sum?.amount !== undefined) {
          target.dealAmount = centsToMoney(
            moneyToCents(String(target.dealAmount ?? "0")) +
              moneyToCents(String(group._sum.amount)),
          );
        }
        const registryLast = dateOnly(group._max?.signedAt);
        if (
          registryLast &&
          (!target.lastDealAt || target.lastDealAt < registryLast)
        ) {
          target.lastDealAt = registryLast;
        }
      }
    }

    return result;
  }

  private async listOurAgencies(
    query: LoyaltyListQueryDto,
    filter: CanonicalLoyaltyFilter,
    search?: string,
    includeSelectionIds = false,
  ) {
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    const unavailableFields = uniqueSorted([
      filter.agencySizes.length ? "agencySizes" : undefined,
      filter.websitePresent !== undefined ? "websitePresent" : undefined,
      filter.projectsOnSite.length ? "projectsOnSite" : undefined,
      ["SITE_PLACED", "SITE_NOT_PLACED"].includes(filter.scenario || "")
        ? "scenario.sitePlacement"
        : undefined,
    ]);
    if (unavailableFields.length) {
      throw new BadRequestException({
        code: "LOYALTY_FILTER_UNAVAILABLE",
        message:
          "The selected filter has no authoritative field in the OUR agency model",
        base: "ours",
        entityType: "AGENCY",
        fields: unavailableFields,
        unknownValuesRemainNull: true,
      });
    }
    const where: any = {};
    if (filter.archived === "only" || filter.hasAmo !== undefined)
      where.id = { in: [] };
    const and: any[] = [];
    if (filter.city)
      and.push({
        OR: [
          { address: { contains: filter.city, mode: "insensitive" } },
          { legalAddress: { contains: filter.city, mode: "insensitive" } },
        ],
      });
    // Agency activity predicates are evaluated after loading the complete
    // selected BrokerAgency relation rows. A direct Agency.deals predicate
    // would incorrectly discard relation-derived local activity.
    if (search) {
      // 2026-09-04 (задача C): Agency.phone хранится в свободном формате
      // («+7 (912) 45-67», «8912…»), поэтому и ввод, и хранимое значение
      // сравниваются по одним цифрам (см. ourAgencyIdsByPhoneDigits);
      // ИНН ищется тоже по цифрам из ввода.
      const digits = search.replace(/\D/g, "");
      const phoneAgencyIds = await this.ourAgencyIdsByPhoneDigits(digits);
      and.push({
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { legalName: { contains: search, mode: "insensitive" } },
          ...(digits.length ? [{ inn: { contains: digits } }] : []),
          ...(phoneAgencyIds.length ? [{ id: { in: phoneAgencyIds } }] : []),
          { email: { contains: search, mode: "insensitive" } },
        ],
      });
    }
    if (and.length) where.AND = and;
    const records = await this.prisma.agency.findMany({
      where,
      include: this.ourAgencyReadInclude(),
    });
    await this.attachOurAgencyRegistryDeals(records as any[]);
    const workflowCalls = await this.workflowCallReadModels(
      "ours",
      "AGENCY",
      (records as any[]).map((record) => String(record.id)),
    );
    this.attachWorkflowCallReadModels(
      records as any[],
      "AGENCY",
      workflowCalls,
    );
    const relatedBrokers = (records as any[]).flatMap((record) =>
      Array.isArray(record?.brokerAgencies)
        ? record.brokerAgencies
            .map((relation: any) => relation?.broker)
            .filter(Boolean)
        : [],
    );
    const relatedBrokerCalls = await this.workflowCallReadModels(
      "ours",
      "BROKER",
      relatedBrokers.map((broker: any) => String(broker.id)),
    );
    this.attachWorkflowCallReadModels(
      relatedBrokers,
      "BROKER",
      relatedBrokerCalls,
    );
    const engagementEvents = await this.engagementReadModels(
      "ours",
      "AGENCY",
      (records as any[]).map((record) => String(record.id)),
    );
    this.attachEngagementReadModels(
      records as any[],
      "AGENCY",
      engagementEvents,
    );
    const candidates = (records as any[])
      .map((record) => ({ record, item: this.mapOurAgency(record, null) }))
      .filter(({ record, item }) =>
        this.matchesOurAgency(record, item, filter),
      );
    this.sortLoyaltyCandidates(candidates, filter);
    const total = candidates.length;
    const pageCandidates = candidates.slice(
      (page - 1) * pageSize,
      page * pageSize,
    );
    return this.oursListEnvelope(
      "AGENCY",
      query,
      filter,
      search,
      candidates,
      pageCandidates,
      total,
      {
        callPeriod: "LOCAL_PRELIMINARY_RELATION_ROWS",
        activityPeriod: "LOCAL_PRELIMINARY_RELATION_ROWS",
      },
      includeSelectionIds,
    );
  }

  /**
   * Задача C (аудит 04.09): поиск агентства по телефону. Из ввода и из
   * Agency.phone удаляются все не-цифры, затем частичное совпадение
   * (минимум 4 цифры — как в buildPhoneSearchConditions). Префиксы 8/7
   * взаимозаменяемы: «8912…» находит «+7 912 …» и наоборот.
   */
  private async ourAgencyIdsByPhoneDigits(digits: string): Promise<string[]> {
    if (digits.length < 4) return [];
    const variants = uniqueSorted([
      digits,
      digits.startsWith("8") && digits.length < 12
        ? `7${digits.slice(1)}`
        : undefined,
      digits.startsWith("7") && digits.length < 12
        ? `8${digits.slice(1)}`
        : undefined,
    ]);
    const conditions = variants.map(
      (variant) =>
        Prisma.sql`regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') LIKE ${`%${variant}%`}`,
    );
    try {
      const rows: Array<{ id: string }> = await (this.prisma as any).$queryRaw(
        Prisma.sql`SELECT id FROM agencies WHERE ${Prisma.join(conditions, " OR ")}`,
      );
      return Array.isArray(rows) ? rows.map((row) => String(row.id)) : [];
    } catch {
      // In-memory/тестовые окружения без $queryRaw: телефонный поиск просто
      // не сужает выборку (имя/ИНН/email продолжают работать).
      return [];
    }
  }

  private ourAgencyReadInclude(): any {
    const confirmedDeals = this.ourConfirmedDealWhere();
    // 2026-09-07: у сделки агентства в карточке нужны те же поля, что у
    // брокера (клиент, проект, лид amo) плюс объект: площадь, этаж, корпус,
    // номер квартиры — из Deal.sqm и Lot. Lot загружается только для
    // подтверждённых сделок (их немного), на список это не влияет.
    const dealSelect = {
      id: true,
      signedAt: true,
      amount: true,
      agencyId: true,
      status: true,
      amoDealId: true,
      project: true,
      sqm: true,
      client: { select: { amoLeadId: true, fullName: true, project: true } },
      lot: {
        select: {
          number: true,
          building: true,
          floor: true,
          buildingSection: true,
          sqm: true,
        },
      },
    };
    return {
      brokerAgencies: {
        include: {
          broker: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
              lastCallAt: true,
              brokerTourVisited: true,
              brokerTourDate: true,
              clients: {
                where: FIXATION_CLIENT_WHERE,
                select: {
                  id: true,
                  createdAt: true,
                  fixationStatus: true,
                  amoLeadId: true,
                  // 2026-09-07: имя клиента и проект — как у брокера, чтобы
                  // событие читалось «Фиксация клиента — Иванов Иван».
                  fullName: true,
                  project: true,
                  // Прямая привязка фиксации к агентству: такая строка
                  // считается проверенной, а не выведенной через брокера.
                  fixationAgencyId: true,
                },
              },
              meetings: {
                where: { status: { in: ["CONFIRMED", "COMPLETED"] } },
                select: {
                  id: true,
                  date: true,
                  status: true,
                  type: true,
                  client: {
                    select: { amoLeadId: true, fullName: true, project: true },
                  },
                },
              },
              deals: {
                where: confirmedDeals,
                select: dealSelect,
              },
              callLogs: {
                select: {
                  id: true,
                  createdAt: true,
                  campaign: true,
                  result: true,
                  operatorId: true,
                  comment: true,
                  nextCallAt: true,
                },
              },
            },
          },
        },
      },
      deals: {
        where: confirmedDeals,
        select: dealSelect,
      },
      _count: { select: { brokerAgencies: true } },
    };
  }

  private async attachOurDealAmounts(
    candidates: any[],
    groupField: "brokerId" | "agencyId",
    attach: boolean,
  ) {
    if (!attach || !candidates.length) return;
    const ids = candidates.map(({ item }) => item.id);
    const groups = await (this.prisma.deal as any).groupBy({
      by: [groupField],
      where: {
        ...this.ourConfirmedDealWhere(),
        [groupField]: { in: ids },
      },
      _sum: { amount: true },
    });
    const amounts = new Map<string, string>(
      groups.map((group: any) => [
        group[groupField],
        String(group._sum?.amount || "0"),
      ]),
    );
    // Суммы «Реестра сделок» брокеров добавляются к Deal-суммам, чтобы
    // колонка «Сумма сделок» соответствовала комбинированному счётчику.
    if (groupField === "brokerId" && this.registryDealModel) {
      const registryGroups = await this.registryDealModel.groupBy({
        by: ["brokerId"],
        where: { brokerId: { in: ids } },
        _sum: { amount: true },
      });
      for (const group of registryGroups as any[]) {
        if (group._sum?.amount === null || group._sum?.amount === undefined)
          continue;
        const current = amounts.get(group.brokerId) || "0";
        amounts.set(
          group.brokerId,
          centsToMoney(
            moneyToCents(current) + moneyToCents(String(group._sum.amount)),
          ),
        );
      }
    }
    for (const candidate of candidates) {
      candidate.item.metrics.dealAmount = amounts.get(candidate.item.id) || "0";
    }
  }

  private oursListEnvelope(
    entityType: EntityType,
    query: LoyaltyListQueryDto,
    filter: CanonicalLoyaltyFilter,
    search: string | undefined,
    candidates: any[],
    pageCandidates: any[],
    total: number,
    availability: { callPeriod: string; activityPeriod: string },
    includeSelectionIds = false,
  ) {
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    return {
      base: "ours",
      entityType,
      snapshotId: null,
      items: pageCandidates.map(({ item }) => item),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      selectionCount: total,
      filterHash: this.listFilterHash("ours", entityType, filter, search),
      facets: this.loyaltyFacets(candidates.map(({ item }) => item)),
      dataAvailability: {
        exactActivities: false,
        localPreliminary: true,
        exactness: "APPROXIMATE",
        methodology:
          entityType === "AGENCY"
            ? "Активность агентства собрана по брокерам, которые сейчас к нему привязаны (без повторов). История привязок не хранится, поэтому при смене агентства прошлые события брокера показываются у нового."
            : "Текущие записи кабинета по брокеру; определения предварительные до сверки с источником",
        sourceReportedAggregates: false,
        ...availability,
        unknownValuesRemainNull: true,
        defaultVisibilityApplied:
          entityType === "AGENCY" &&
          !filter.includeLowSignal &&
          !(filter.columns?.activity || filter.activityType),
        visibilityRule:
          entityType === "AGENCY" && !filter.includeLowSignal
            ? filter.columns?.activity || filter.activityType
              ? "Выбран фильтр по активности — скрытие малозначимых агентств не применяется"
              : "Скрыты агентства без телефона, без сделок, без фиксаций и без подтверждённых встреч за последние три месяца"
            : null,
        unavailableFilters:
          entityType === "AGENCY"
            ? ["agencySizes", "websitePresent", "projectsOnSite"]
            : [],
      },
      ...(includeSelectionIds
        ? { _selectionIds: candidates.map(({ item }) => item.id) }
        : {}),
    };
  }

  /**
   * Последний звонок «за всё время» (задача D, аудит 04.09): максимум из
   * объединённой модели звонков (легаси CallLog + workflow), отдельно
   * подгруженного lifetime-максимума CallLog (__lifetimeLastCallAt — он
   * есть, когда callLogs загружены с фильтром периода/кампании) и
   * денормализованного Broker.lastCallAt. «Период звонков» на это значение
   * не влияет — оно питает статус DORMANT, lastActivity и staleDays.
   */
  private ourLastCallLifetime(record: any): string | null {
    const values = [
      this.callSortKey(this.lastCall(this.ourCalls(record)) || {}),
      record.__lifetimeLastCallAt,
      record.lastCallAt,
    ]
      .map(dateOnly)
      .filter(Boolean) as string[];
    return values.sort().at(-1) || null;
  }

  /**
   * Задача D (аудит 04.09): когда callLogs загружены с where по периоду /
   * кампании, последний звонок за всё время подгружается отдельным groupBy
   * и прикрепляется как record.__lifetimeLastCallAt.
   */
  private async attachOurBrokerLifetimeLastCall(
    records: any[],
    callLogsAreFiltered: boolean,
  ): Promise<void> {
    if (!callLogsAreFiltered || !records.length) return;
    const delegate = (this.prisma as any).callLog;
    if (typeof delegate?.groupBy !== "function") return;
    const ids = uniqueSorted(records.map((record) => String(record.id)));
    const lastByBroker = new Map<string, unknown>();
    for (
      let offset = 0;
      offset < ids.length;
      offset += CANDIDATE_QUERY_BATCH_SIZE
    ) {
      const batch = ids.slice(offset, offset + CANDIDATE_QUERY_BATCH_SIZE);
      const groups = await delegate.groupBy({
        by: ["brokerId"],
        where: { brokerId: { in: batch } },
        _max: { createdAt: true },
      });
      for (const group of groups as any[]) {
        if (group?._max?.createdAt) {
          lastByBroker.set(String(group.brokerId), group._max.createdAt);
        }
      }
    }
    for (const record of records) {
      record.__lifetimeLastCallAt =
        lastByBroker.get(String(record.id)) || null;
    }
  }

  private ourBrokerStatusCodes(record: any): string[] {
    const fixations = Number(record._count?.clients || 0);
    const meetings = Number(record._count?.meetings || 0);
    const deals = Number(record._count?.deals || 0);
    const bt = record.brokerTourVisited === true;
    // Задача D: DORMANT определяется по последнему звонку за всё время,
    // а не по callLogs, суженным «периодом звонков».
    const lastCallAt = this.ourLastCallLifetime(record);
    const lastDates = [
      lastCallAt,
      record.brokerTourDate,
      record.clients?.[0]?.createdAt,
      record.meetings?.[0]?.date,
      record.deals?.[0]?.signedAt,
    ]
      .map(dateOnly)
      .filter(Boolean) as string[];
    const inactiveDays = daysSinceDate(lastDates.sort().at(-1));
    const hadActivity =
      fixations > 0 || meetings > 0 || deals > 0 || bt || Boolean(lastCallAt);
    const primary =
      hadActivity && inactiveDays !== null && inactiveDays > 90
        ? "DORMANT"
        : deals >= 3
          ? "TOP_SELLER"
          : deals >= 1
            ? "SELLER"
            : meetings > 0
              ? "OFFERING"
              : fixations > 0
                ? "FIXATING"
                : bt
                  ? "BROKER_TOUR"
                  : "NEW";
    return bt && primary !== "BROKER_TOUR"
      ? [primary, "BROKER_TOUR"]
      : [primary];
  }

  private ourBrokerRelationshipStage(record: any): string | null {
    const deals = Number(record._count?.deals || 0);
    const meetings = Number(record._count?.meetings || 0);
    const fixations = Number(record._count?.clients || 0);
    const raw = String(record.funnelStage || "");
    if (deals >= 2) return "Повторные сделки / VIP";
    if (deals > 0 || raw === "DEAL") return "Сделка";
    if (meetings > 0 || raw === "MEETING") return "Встреча";
    if (fixations > 0 || raw === "FIXATION") return "Фиксация";
    if (record.brokerTourVisited === true || raw === "BROKER_TOUR")
      return "Был на БТ";
    const hasCall =
      Boolean(record.lastCallAt) ||
      this.ourCalls(record).length > 0 ||
      Number(record._count?.callLogs ?? record._count?.calls ?? 0) > 0;
    if (hasCall) return "Звонили";
    return raw === "NEW_BROKER" ? "Новый" : null;
  }

  private ourDataQualityCodes(record: any): string[] {
    const hasPhone = Boolean(
      normalizeLoyaltyContactPoint("PHONE", record.phone || ""),
    );
    const hasAmo =
      record.amoContactId !== null && record.amoContactId !== undefined;
    const completeName =
      String(record.fullName || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length >= 2;
    const full = hasPhone && hasAmo && completeName;
    return uniqueSorted([
      full ? "FULL" : "NEEDS_COMPLETION",
      !hasAmo ? "NOT_FOUND_IN_CRM" : undefined,
    ]);
  }

  private ourCalls(record: any, includeWorkflow = true): LoyaltyCallView[] {
    const legacy = Array.isArray(record?.callLogs)
      ? record.callLogs.map((call: any): LoyaltyCallView => {
          const occurredAt = this.isoDateTime(call.createdAt);
          return {
            type: "CALL",
            id: String(call.id || "") || null,
            date: occurredAt,
            occurredAt,
            campaign: call.campaign ? String(call.campaign) : null,
            employee: call.operatorId ? String(call.operatorId) : null,
            employeeId: call.operatorId ? String(call.operatorId) : null,
            result: call.result ? String(call.result) : null,
            resultCode: call.result ? String(call.result) : null,
            agreement:
              call.comment === null || call.comment === undefined
                ? null
                : String(call.comment),
            comment:
              call.comment === null || call.comment === undefined
                ? null
                : String(call.comment),
            nextActionAt: this.isoDateTime(call.nextCallAt),
            source: "LEGACY_CALL_LOG",
            effective: true,
            superseded: false,
          };
        })
      : [];
    const workflow =
      includeWorkflow && Array.isArray(record?.__workflowCalls?.effective)
        ? record.__workflowCalls.effective
        : [];
    return [...legacy, ...workflow];
  }

  private ourCallHistory(record: any): LoyaltyCallView[] {
    const legacy = this.ourCalls(record, false);
    const workflowHistory = Array.isArray(record?.__workflowCalls?.history)
      ? record.__workflowCalls.history
      : [];
    return [...legacy, ...workflowHistory].sort((left, right) =>
      this.callSortKey(right).localeCompare(this.callSortKey(left)),
    );
  }

  private ourLastActivity(record: any): string | null {
    const values = [
      // Задача D: последний звонок — lifetime, без влияния «периода звонков».
      this.ourLastCallLifetime(record),
      record.brokerTourDate,
      record.clients?.[0]?.createdAt,
      record.meetings?.[0]?.date,
      record.deals?.[0]?.signedAt,
    ]
      .map(dateOnly)
      .filter(Boolean) as string[];
    return values.sort().at(-1) || null;
  }

  /**
   * OUR agencies do not own fixation/meeting/call rows directly. The best
   * available local projection is therefore the current BrokerAgency graph.
   * It is deliberately labelled preliminary: membership is current-state,
   * not a historically effective agency attribution.
   */
  private ourAgencyRelationMetrics(record: any) {
    const relationsLoaded = Array.isArray(record?.brokerAgencies);
    const relations = relationsLoaded ? record.brokerAgencies : [];
    const brokers = relations
      .map((relation: any) => relation?.broker)
      .filter((broker: any) => broker && broker.id);
    const uniqueById = (rows: any[]) => {
      const result = new Map<string, any>();
      for (const row of rows) {
        const id = String(row?.id || "");
        if (id && !result.has(id)) result.set(id, row);
      }
      return [...result.values()];
    };
    const relationRows = (field: string) =>
      brokers.flatMap((broker: any) =>
        Array.isArray(broker?.[field]) ? broker[field] : [],
      );
    const fieldKnown = (field: string) =>
      relationsLoaded &&
      brokers.every((broker: any) => Array.isArray(broker?.[field]));

    const fixations = fieldKnown("clients")
      ? uniqueById(relationRows("clients"))
      : null;
    const meetings = fieldKnown("meetings")
      ? uniqueById(relationRows("meetings"))
      : null;
    const directDealsKnown = Array.isArray(record?.deals);
    const relationDealsKnown = fieldKnown("deals");
    // Реестровые сделки брокеров агентства (см. attachOurAgencyRegistryDeals):
    // вливаются в общий массив — id уникален (REGISTRY:<id>), поэтому
    // uniqueById не схлопнет их с Deal-строками.
    const registryRows = Array.isArray(record?.__registryDeals)
      ? record.__registryDeals
      : [];
    const deals =
      directDealsKnown && relationDealsKnown
        ? uniqueById([
            ...record.deals,
            ...relationRows("deals"),
            ...registryRows,
          ])
        : null;
    const directCallsKnown = Array.isArray(record?.__workflowCalls?.effective);
    const relationCallsKnown =
      fieldKnown("callLogs") &&
      brokers.every((broker: any) =>
        Array.isArray(broker?.__workflowCalls?.effective),
      );
    const calls =
      directCallsKnown && relationCallsKnown
        ? (() => {
            const result = new Map<string, LoyaltyCallView>();
            for (const call of [
              ...this.ourCalls(record),
              ...brokers.flatMap((broker: any) => this.ourCalls(broker)),
            ]) {
              const id = String(call?.id || "");
              const key = `${String(call?.source || "CALL")}:${id}`;
              if (id && !result.has(key)) result.set(key, call);
            }
            return [...result.values()];
          })()
        : null;
    const brokerToursKnown =
      relationsLoaded &&
      brokers.every(
        (broker: any) =>
          typeof broker?.brokerTourVisited === "boolean" &&
          Object.prototype.hasOwnProperty.call(broker, "brokerTourDate"),
      );
    const brokerTours = brokerToursKnown
      ? uniqueById(
          brokers
            .filter(
              (broker: any) =>
                broker.brokerTourVisited === true ||
                Boolean(broker.brokerTourDate),
            )
            .map((broker: any) => ({
              id: `BROKER_TOUR:${String(broker.id)}`,
              occurredAt: broker.brokerTourDate || null,
            })),
        )
      : null;
    const dealAmount =
      deals === null
        ? null
        : deals.every(
              (deal: any) =>
                deal?.amount !== null && deal?.amount !== undefined,
            )
          ? centsToMoney(
              deals.reduce(
                (sum: bigint, deal: any) =>
                  sum + moneyToCents(String(deal.amount)),
                0n,
              ),
            )
          : null;
    const lastDate = (rows: any[] | null, field: string) =>
      rows === null
        ? null
        : (
            rows
              .map((row: any) => dateOnly(row?.[field]))
              .filter(Boolean) as string[]
          )
            .sort()
            .at(-1) || null;
    const lastCallAt =
      calls === null
        ? null
        : (
            calls
              .map((call: LoyaltyCallView) => this.callSortKey(call))
              .filter(Boolean) as string[]
          )
            .sort()
            .at(-1) || null;
    const lastFixationAt = lastDate(fixations, "createdAt");
    const lastMeetingAt = lastDate(meetings, "date");
    const lastDealAt = lastDate(deals, "signedAt");
    const lastBrokerTourAt = lastDate(brokerTours, "occurredAt");
    const lastActivityAt =
      (
        [
          lastFixationAt,
          lastMeetingAt,
          lastDealAt,
          lastCallAt,
          lastBrokerTourAt,
        ].filter(Boolean) as string[]
      )
        .sort()
        .at(-1) || null;
    return {
      relationsLoaded,
      brokers: relationsLoaded ? uniqueById(brokers) : null,
      fixations,
      meetings,
      deals,
      calls,
      brokerTours,
      dealAmount,
      lastFixationAt,
      lastMeetingAt,
      lastDealAt,
      lastCallAt,
      lastBrokerTourAt,
      lastActivityAt,
    };
  }

  private ourAgencyCallHistory(record: any): LoyaltyCallView[] {
    const brokers = Array.isArray(record?.brokerAgencies)
      ? record.brokerAgencies
          .map((relation: any) => relation?.broker)
          .filter(Boolean)
      : [];
    const rows = [
      ...this.ourCallHistory(record),
      ...brokers.flatMap((broker: any) => this.ourCallHistory(broker)),
    ];
    const byId = new Map<string, LoyaltyCallView>();
    for (const row of rows) {
      const id = String(row?.id || "");
      const key = `${String(row?.source || "CALL")}:${id}`;
      if (id && !byId.has(key)) byId.set(key, row);
    }
    return [...byId.values()].sort((left, right) =>
      this.callSortKey(right).localeCompare(this.callSortKey(left)),
    );
  }

  private ourAgencyStatusCodes(
    relationMetrics: ReturnType<LoyaltyBaseService["ourAgencyRelationMetrics"]>,
  ): string[] {
    const brokers = relationMetrics.brokers?.length ?? null;
    const fixations = relationMetrics.fixations?.length ?? null;
    const meetings = relationMetrics.meetings?.length ?? null;
    const deals = relationMetrics.deals?.length ?? null;
    const calls = relationMetrics.calls?.length ?? null;
    const brokerTours = relationMetrics.brokerTours?.length ?? null;
    const values = [brokers, fixations, meetings, deals, calls, brokerTours];
    const allKnown = values.every((value) => value !== null);
    const hadActivity = values.some((value) => value !== null && value > 0);
    const inactiveDays = daysSinceDate(relationMetrics.lastActivityAt);
    const primary =
      hadActivity && inactiveDays !== null && inactiveDays > 90
        ? "DORMANT_PARTNER"
        : deals !== null && deals >= 5
          ? "VIP_PARTNER"
          : deals !== null && deals >= 1
            ? "SELLING_PARTNER"
            : meetings !== null && meetings > 0
              ? "ACTIVE_PARTNER"
              : fixations !== null && fixations > 0
                ? "FIXATING_PARTNER"
                : brokerTours !== null && brokerTours > 0
                  ? "WARM_PARTNER"
                  : (calls !== null && calls > 0) ||
                      (brokers !== null && brokers > 0)
                    ? "STARTING_PARTNER"
                    : allKnown && values.every((value) => value === 0)
                      ? "NEW_AGENCY"
                      : null;
    return primary ? [primary] : [];
  }

  private ourAgencyPartnershipStage(statusCodes: string[]): string | null {
    const primary = statusCodes[0];
    if (primary === "VIP_PARTNER") return "VIP партнёр";
    if (["SELLING_PARTNER", "DORMANT_PARTNER"].includes(primary))
      return "Активный партнёр";
    if (primary === "ACTIVE_PARTNER") return "Назначена встреча";
    if (primary === "FIXATING_PARTNER") return "Активный партнёр";
    if (primary === "WARM_PARTNER") return "БТ проведён";
    if (primary === "STARTING_PARTNER") return "Установлен контакт";
    if (primary === "NEW_AGENCY") return "Новое";
    return null;
  }

  private ourAgencyPeriodMetrics(
    relationMetrics: ReturnType<LoyaltyBaseService["ourAgencyRelationMetrics"]>,
    period?: LoyaltyFilterPeriod,
  ) {
    if (!period) return this.unavailablePeriodMetrics(period);
    const inPeriod = (row: any, field: string) => {
      const value = dateOnly(row?.[field]);
      return Boolean(
        value &&
        value >= period.fromIso.slice(0, 10) &&
        value <= period.toIso.slice(0, 10),
      );
    };
    const select = (rows: any[] | null, field: string) =>
      rows === null ? null : rows.filter((row) => inPeriod(row, field));
    const fixations = select(relationMetrics.fixations, "createdAt");
    const meetings = select(relationMetrics.meetings, "date");
    const deals = select(relationMetrics.deals, "signedAt");
    const amount =
      deals === null
        ? null
        : deals.every(
              (deal: any) =>
                deal?.amount !== null && deal?.amount !== undefined,
            )
          ? centsToMoney(
              deals.reduce(
                (sum: bigint, deal: any) =>
                  sum + moneyToCents(String(deal.amount)),
                0n,
              ),
            )
          : null;
    const latest = (rows: any[] | null, field: string) =>
      rows === null
        ? null
        : (
            rows
              .map((row) => dateOnly(row?.[field]))
              .filter(Boolean) as string[]
          )
            .sort()
            .at(-1) || null;
    return {
      period: { from: period.fromIso, to: period.toIso },
      availability: "LOCAL_PRELIMINARY",
      exactness: "APPROXIMATE",
      source: "CURRENT_BROKER_AGENCY_RELATIONS",
      methodology:
        "Current BrokerAgency memberships; qualifying local rows deduplicated by stable row ID. Membership history is unavailable, so agency attribution is approximate.",
      fixations: fixations === null ? null : fixations.length,
      meetings: meetings === null ? null : meetings.length,
      deals: deals === null ? null : deals.length,
      dealAmount: amount,
      lastFixationAt: latest(fixations, "createdAt"),
      lastMeetingAt: latest(meetings, "date"),
      lastDealAt: latest(deals, "signedAt"),
    };
  }

  private ourAgencyEvidence(
    relationMetrics: ReturnType<LoyaltyBaseService["ourAgencyRelationMetrics"]>,
    agencyId: string | null = null,
  ) {
    const limit = OUR_ACTIVITY_EVIDENCE_LIMIT;
    const categoriesKnown = [
      relationMetrics.fixations,
      relationMetrics.meetings,
      relationMetrics.deals,
      relationMetrics.calls,
    ].every(Array.isArray);
    // 2026-09-07: строки-основания агентства обогащены как у брокера
    // (клиент, проект, лид amo) плюс объект сделки (площадь, этаж, корпус,
    // квартира, номер договора). Точность теперь по строке: если запись
    // привязана к агентству напрямую (Client.fixationAgencyId, Deal.agencyId,
    // строка реестра по названию агентства) — «проверено»; если выведена
    // через текущую связь брокер↔агентство — «оценка».
    const str = (value: unknown) =>
      value === null || value === undefined || value === ""
        ? null
        : String(value);
    const directFixation = (row: any) =>
      Boolean(agencyId) && str(row.fixationAgencyId) === agencyId;
    const directDeal = (row: any) =>
      (Boolean(agencyId) && str(row.agencyId) === agencyId) ||
      row.attribution === "AGENCY_NAME";
    const rows: any[] = [
      ...(relationMetrics.fixations || []).map((row: any) => ({
        id: `LOCAL_CLIENT:${String(row.id)}`,
        sourceId: String(row.id),
        type: "FIXATION",
        date: this.isoDateTime(row.createdAt),
        occurredAt: this.isoDateTime(row.createdAt),
        status: row.fixationStatus ? String(row.fixationStatus) : null,
        clientName: str(row.fullName),
        project: str(row.project),
        amoLeadId: str(row.amoLeadId),
        amoDealId: null,
        amount: null,
        source: "LOCAL_CLIENT",
        exactness: directFixation(row) ? "VERIFIED" : "APPROXIMATE",
        provenance: directFixation(row)
          ? "Фиксация оформлена на это агентство"
          : "Фиксация брокера, который сейчас привязан к агентству",
      })),
      ...(relationMetrics.meetings || []).map((row: any) => ({
        id: `LOCAL_MEETING:${String(row.id)}`,
        sourceId: String(row.id),
        type: "MEETING",
        date: this.isoDateTime(row.date),
        occurredAt: this.isoDateTime(row.date),
        status: row.status ? String(row.status) : null,
        meetingType: row.type ? String(row.type) : null,
        clientName: str(row.client?.fullName),
        project: str(row.client?.project),
        amoLeadId: str(row.client?.amoLeadId),
        amoDealId: null,
        amount: null,
        source: "LOCAL_MEETING",
        exactness: "APPROXIMATE",
        provenance: "Встреча брокера, который сейчас привязан к агентству",
      })),
      ...(relationMetrics.deals || []).map((row: any) => ({
        id: `LOCAL_DEAL:${String(row.id)}`,
        sourceId: String(row.id),
        type: "DEAL",
        date: this.isoDateTime(row.signedAt),
        occurredAt: this.isoDateTime(row.signedAt),
        status: row.status ? String(row.status) : null,
        clientName: str(row.client?.fullName),
        project: str(row.project) ?? str(row.client?.project),
        amoLeadId: str(row.amoLeadId) ?? str(row.client?.amoLeadId),
        amoDealId: str(row.amoDealId),
        amount: str(row.amount),
        contractNumber: str(row.contractNumber),
        // Площадь: из сделки/строки реестра, иначе из лота. Этаж/корпус/
        // квартира — из строки реестра (объект из amo) или из лота.
        sqm: str(row.sqm) ?? str(row.lot?.sqm),
        floor: str(row.floor) ?? str(row.lot?.floor),
        building: str(row.building) ?? str(row.lot?.building),
        buildingSection: str(row.lot?.buildingSection),
        apartmentNumber: str(row.apartmentNumber) ?? str(row.lot?.number),
        source: String(row.id).startsWith("REGISTRY:")
          ? "REGISTRY_DEAL"
          : "LOCAL_DEAL",
        exactness: directDeal(row) ? "VERIFIED" : "APPROXIMATE",
        provenance: directDeal(row)
          ? row.attribution === "AGENCY_NAME"
            ? "Сделка из реестра ДДУ с названием этого агентства"
            : "Сделка оформлена на это агентство"
          : "Сделка брокера, который сейчас привязан к агентству",
      })),
      ...(relationMetrics.calls || []).map((row: LoyaltyCallView) => ({
        id: `${String(row.source || "LOCAL_CALL")}:${String(row.id)}`,
        sourceId: String(row.id),
        type: "CALL",
        date: row.occurredAt || row.date || null,
        occurredAt: row.occurredAt || row.date || null,
        status: row.resultCode || row.result || null,
        result: row.result || null,
        resultCode: row.resultCode || null,
        campaignId: row.campaignId || null,
        campaignName: row.campaignName || row.campaign || null,
        amoDealId: null,
        amount: null,
        source: row.source || "LOCAL_CALL",
        exactness: "APPROXIMATE",
        provenance:
          "Звонок агентству или брокеру, который сейчас привязан к агентству",
      })),
    ].sort((left, right) =>
      String(right.occurredAt || "").localeCompare(
        String(left.occurredAt || ""),
      ),
    );
    const items = rows.slice(0, limit);
    const count = categoriesKnown ? rows.length : null;
    const allVerified =
      rows.length > 0 && rows.every((row) => row.exactness === "VERIFIED");
    return {
      items,
      count,
      truncated: count === null ? null : count > items.length,
      limit,
      availability: categoriesKnown ? "LOCAL_PRELIMINARY" : "UNAVAILABLE",
      exactness: !categoriesKnown
        ? "UNKNOWN"
        : allVerified
          ? "VERIFIED"
          : "APPROXIMATE",
      methodology:
        "События собраны из данных кабинета: фиксации, подтверждённые и состоявшиеся встречи, подтверждённые сделки и сделки из реестра ДДУ. Запись считается проверенной, если она оформлена на само агентство (фиксация с указанием агентства, сделка агентства, строка реестра с его названием). Остальные записи взяты у брокеров, которые сейчас привязаны к агентству; история привязок не хранится, поэтому такие записи — оценка: если брокер сменил агентство, его прошлые события показываются у нового.",
    };
  }

  /**
   * 2026-09-07: метка backfill-а встреч (scripts/backfill-meetings.js).
   * PENDING-встреча с «[amo:...]» в comment означает «статус из amoCRM
   * вернуть не удалось» — фронт показывает оранжевый бейдж. Наружу идёт
   * только код метки, не сырой comment (там бывает телефон клиента).
   */
  private meetingAmoStatusMark(row: {
    status?: unknown;
    comment?: unknown;
  }): "UNCONFIRMED" | "LEAD_DELETED" | null {
    if (String(row.status || "") !== "PENDING") return null;
    const comment = String(row.comment || "");
    if (comment.includes("[amo:лид удалён]")) return "LEAD_DELETED";
    if (comment.includes("[amo:статус не подтверждён]")) return "UNCONFIRMED";
    return null;
  }

  private ourBrokerEvidence(item: any) {
    const limit = OUR_ACTIVITY_EVIDENCE_LIMIT;
    // 2026-09-07: строки-основания обогащены именем клиента и проектом,
    // чтобы карточка показывала «Фиксация клиента — Иванов Иван», а не
    // безликую «Запись источника». Точность VERIFIED: строки берутся из
    // таблиц кабинета напрямую по выверенным правилам (FIXATION_CLIENT_WHERE,
    // подтверждённые встречи, подтверждённые сделки).
    const rows: any[] = [
      ...(Array.isArray(item.clients) ? item.clients : []).map((row: any) => ({
        id: `LOCAL_CLIENT:${String(row.id)}`,
        sourceId: String(row.id),
        type: "FIXATION",
        date: this.isoDateTime(row.createdAt),
        occurredAt: this.isoDateTime(row.createdAt),
        status: row.fixationStatus ? String(row.fixationStatus) : null,
        clientName: row.fullName ? String(row.fullName) : null,
        project: row.project ? String(row.project) : null,
        amoLeadId:
          row.amoLeadId === null || row.amoLeadId === undefined
            ? null
            : String(row.amoLeadId),
        amount: null,
        source: "LOCAL_CLIENT",
        exactness: "VERIFIED",
        provenance: "Current local broker-owned fixation row",
      })),
      ...(Array.isArray(item.meetings) ? item.meetings : []).map(
        (row: any) => ({
          id: `LOCAL_MEETING:${String(row.id)}`,
          sourceId: String(row.id),
          type: "MEETING",
          date: this.isoDateTime(row.date),
          occurredAt: this.isoDateTime(row.date),
          status: row.status ? String(row.status) : null,
          meetingType: row.type ? String(row.type) : null,
          // 2026-09-07: маркер backfill-а для бейджа «статус не
          // подтверждён — нет ответа из amo». Сырой comment не шлём
          // (в нём бывает телефон клиента), наружу идёт только код.
          amoStatusMark: this.meetingAmoStatusMark(row),
          clientName: row.client?.fullName ? String(row.client.fullName) : null,
          project: row.client?.project ? String(row.client.project) : null,
          amoLeadId:
            row.client?.amoLeadId === null ||
            row.client?.amoLeadId === undefined
              ? null
              : String(row.client.amoLeadId),
          amount: null,
          source: "LOCAL_MEETING",
          exactness: "VERIFIED",
          provenance: "Current local broker-owned meeting row",
        }),
      ),
      ...(Array.isArray(item.deals) ? item.deals : []).map((row: any) => ({
        id: `LOCAL_DEAL:${String(row.id)}`,
        sourceId: String(row.id),
        type: "DEAL",
        date: this.isoDateTime(row.signedAt || row.createdAt),
        occurredAt: this.isoDateTime(row.signedAt || row.createdAt),
        status: row.status ? String(row.status) : null,
        clientName: row.client?.fullName ? String(row.client.fullName) : null,
        project: row.project
          ? String(row.project)
          : row.client?.project
            ? String(row.client.project)
            : null,
        amoLeadId:
          row.client?.amoLeadId === null || row.client?.amoLeadId === undefined
            ? null
            : String(row.client.amoLeadId),
        amoDealId:
          row.amoDealId === null || row.amoDealId === undefined
            ? null
            : String(row.amoDealId),
        amount:
          row.amount === null || row.amount === undefined
            ? null
            : String(row.amount),
        source: "LOCAL_DEAL",
        exactness: "VERIFIED",
        provenance: "Current local broker-owned confirmed deal row",
      })),
    ].sort((left, right) =>
      String(right.occurredAt || "").localeCompare(
        String(left.occurredAt || ""),
      ),
    );
    const counts = [
      finiteNumber(item._count?.clients),
      finiteNumber(item._count?.meetings),
      finiteNumber(item._count?.deals),
    ];
    const known = counts.every((value) => value !== null);
    const count = known
      ? counts.reduce((sum, value) => sum + (value || 0), 0)
      : null;
    const items = rows.slice(0, limit);
    return {
      items,
      count,
      truncated: count === null ? null : count > items.length,
      limit,
      availability: known ? "LOCAL_PRELIMINARY" : "UNAVAILABLE",
      exactness: known ? "VERIFIED" : "UNKNOWN",
      methodology:
        "События кабинета этого брокера: фиксации клиентов (по правилам фиксации), подтверждённые и состоявшиеся встречи (плюс встречи с пометкой «статус не подтверждён — нет ответа из amo»), подтверждённые сделки. Это данные кабинета, а не полный аудит amoCRM.",
    };
  }

  private resultCodeForValue(entityType: EntityType, value: unknown) {
    const normalized = lower(value);
    const dictionary =
      entityType === "BROKER"
        ? BROKER_CALL_RESULT_ALIASES
        : AGENCY_CALL_RESULT_ALIASES;
    return (
      Object.entries(dictionary).find(
        ([code, aliases]) =>
          lower(code) === normalized ||
          aliases.some((alias) => lower(alias) === normalized),
      )?.[0] || null
    );
  }

  private matchesOurBroker(
    record: any,
    item: any,
    filter: CanonicalLoyaltyFilter,
  ): boolean {
    const lifetimeDeals = Number(record._count?.deals || 0);
    const lifetimeMeetings = Number(record._count?.meetings || 0);
    const lifetimeFixations = Number(record._count?.clients || 0);
    const deals = filter.activityPeriod
      ? finiteNumber(item.periodMetrics?.deals)
      : lifetimeDeals;
    const meetings = filter.activityPeriod
      ? finiteNumber(item.periodMetrics?.meetings)
      : lifetimeMeetings;
    const fixations = filter.activityPeriod
      ? finiteNumber(item.periodMetrics?.fixations)
      : lifetimeFixations;
    const bt = record.brokerTourVisited === true;
    const assigneeId = record.assignedManagerId || "";
    const assigneeName = record.assignedManager?.fullName || "";
    const calls = this.ourCalls(record);
    const callAssignees = uniqueSorted(
      calls.flatMap((call) => this.callAssigneeValues(call)),
    );
    const assignees = uniqueSorted([
      assigneeId,
      assigneeName,
      ...callAssignees,
    ]);
    const statuses = this.ourBrokerStatusCodes(record);
    const quality = this.ourDataQualityCodes(record);
    item.computedStatuses = statuses;
    item.dataQualityCodes = quality;
    item.lastActivityAt = this.ourLastActivity(record);
    item.assignee = record.assignedManager
      ? { id: assigneeId, name: assigneeName }
      : null;
    const latestCall = this.applyCallSummary(item, "BROKER", calls);
    if (!latestCall && record.lastCallAt) item.lastCallAt = record.lastCallAt;
    if (latestCall?.employee || latestCall?.employeeId) {
      item.assignee = {
        id: latestCall.employeeId || null,
        name: latestCall.employeeName || latestCall.employee || null,
      };
    }

    if (filter.segment === "NOT_CALLED_CURRENT_MONTH") {
      // Как в KPI «Не звонили в этом месяце»: только активные брокеры.
      if (String(record.status || "") !== "ACTIVE") return false;
      const period = moscowCurrentMonthFilterPeriod();
      if (this.callPresenceInPeriod(calls, 0, period) !== false) return false;
    }
    if (
      filter.segment === "NEW_BROKER" &&
      (item.normalizedStage !== "Новый" ||
        !hasLoyaltyAcquisitionPhone(item.contactPoints || []))
    )
      return false;
    if (filter.campaignIds.length) {
      const aliases = this.campaignAliases(filter.campaignIds).map(lower);
      const eligible = filter.callPeriod
        ? calls.filter(
            (call) => this.callInPeriod(call, filter.callPeriod!) === true,
          )
        : calls;
      if (
        !eligible.some((call) =>
          this.callCampaignValues(call).some((value) =>
            aliases.includes(lower(value)),
          ),
        )
      )
        return false;
    }

    if (filter.lastCallResults.length) {
      const resultAliases = this.resultAliases(
        "BROKER",
        filter.lastCallResults,
      ).map(lower);
      const campaignAliases = this.campaignAliases(filter.campaignIds).map(
        lower,
      );
      const eligible = calls.filter(
        (call) =>
          (!filter.callPeriod ||
            this.callInPeriod(call, filter.callPeriod) === true) &&
          (!campaignAliases.length ||
            this.callCampaignValues(call).some((value) =>
              campaignAliases.includes(lower(value)),
            )),
      );
      const latest = this.lastCall(eligible);
      if (!latest || !resultAliases.includes(lower(latest.result)))
        return false;
    }
    if (filter.called !== undefined) {
      const presence = this.callPresenceInPeriod(calls, 0, filter.callPeriod!);
      if (presence !== filter.called) return false;
    }
    if (
      filter.assigneeIds.length &&
      !filter.assigneeIds.some((value) => assignees.includes(value))
    )
      return false;
    if (filter.unassigned === true && assignees.length) return false;
    if (
      filter.specializations.length &&
      !filter.specializations.includes(String(record.specialization || ""))
    )
      return false;
    if (filter.geography.length) {
      const geography = explicitGeography(
        [record.region, record.city],
        record.isRegional,
      );
      if (!geography || !filter.geography.includes(geography)) return false;
    }
    if (filter.workFormats.length) {
      const format = record.isCoordinator
        ? "Координатор"
        : record.brokerAgencies?.length
          ? "Агентство"
          : "Частный брокер";
      if (!filter.workFormats.includes(format)) return false;
    }
    if (
      filter.relationshipStages.length &&
      !filter.relationshipStages.includes(String(item.normalizedStage || "")) &&
      !filter.relationshipStages.includes(String(record.funnelStage || ""))
    )
      return false;
    if (
      filter.brokerStatuses.length &&
      !filter.brokerStatuses.some((status) => statuses.includes(status))
    )
      return false;
    if (
      filter.dataQuality.length &&
      !filter.dataQuality.some((code) => quality.includes(code))
    )
      return false;
    if (
      filter.dealCount.min !== undefined &&
      (deals === null || deals < filter.dealCount.min)
    )
      return false;
    if (
      filter.dealCount.max !== undefined &&
      (deals === null || deals > filter.dealCount.max)
    )
      return false;
    if (filter.bt !== undefined && bt !== filter.bt) return false;
    if (
      filter.meetings.min !== undefined &&
      (meetings === null || meetings < filter.meetings.min)
    )
      return false;
    if (
      filter.meetings.max !== undefined &&
      (meetings === null || meetings > filter.meetings.max)
    )
      return false;
    if (filter.staleDays !== undefined) {
      const days = daysSinceDate(item.lastActivityAt);
      if (days === null || days < filter.staleDays) return false;
    }
    const engagementEvents: LoyaltyEngagementView[] = Array.isArray(
      record?.__workflowEvents?.effective,
    )
      ? record.__workflowEvents.effective
      : [];
    if (
      filter.specialTermsProposed !== undefined &&
      engagementEvents.some((event) => event.type === "INDIVIDUAL_TERMS") !==
        filter.specialTermsProposed
    )
      return false;
    if (
      filter.rewardPresent !== undefined &&
      engagementEvents.some((event) => event.type === "AWARD") !==
        filter.rewardPresent
    )
      return false;
    if (
      !this.matchesColumnFilters(filter, {
        hasPhone:
          normalizeLoyaltyContactPoint("PHONE", record.phone || "") !== null ||
          (record.phones || []).some(
            (phone: any) =>
              normalizeLoyaltyContactPoint("PHONE", phone.phone || "") !== null,
          ),
        statuses,
        bt,
        fixations,
        meetings,
        callPresence: this.callPresenceInPeriod(calls, 0, filter.callPeriod),
        assignees,
        deals,
      })
    )
      return false;
    if (
      filter.scenario &&
      !["NOT_CALLED_IN_PERIOD", "CALLED_IN_PERIOD"].includes(filter.scenario) &&
      !this.matchesScenario(filter.scenario, {
        callPresence: null,
        bt,
        fixations,
        meetings,
        deals,
        assignee: assigneeId,
        stage: record.funnelStage,
        projectsOnSite: null,
        hasIndividualTerms: false,
      })
    )
      return false;
    if (
      filter.scenario &&
      ["NOT_CALLED_IN_PERIOD", "CALLED_IN_PERIOD"].includes(filter.scenario) &&
      !this.matchesScenario(filter.scenario, {
        callPresence: this.callPresenceInPeriod(calls, 0, filter.callPeriod!),
      })
    )
      return false;
    // Agency-only dimensions have no canonical backing fields in Broker.
    if (
      filter.partnershipStatuses.length ||
      filter.agencySizes.length ||
      filter.websitePresent !== undefined ||
      filter.projectsOnSite.length ||
      filter.individualTerms !== undefined
    )
      return false;
    return true;
  }

  private matchesOurAgency(
    record: any,
    item: any,
    filter: CanonicalLoyaltyFilter,
  ): boolean {
    const relationMetrics = this.ourAgencyRelationMetrics(record);
    const fixations = finiteNumber(item.metrics?.fixations);
    const meetings = finiteNumber(item.metrics?.meetings);
    const deals = finiteNumber(item.metrics?.deals);
    const brokerTours =
      relationMetrics.brokerTours === null
        ? null
        : relationMetrics.brokerTours.length;
    const bt = brokerTours === null ? null : brokerTours > 0;
    const calls = relationMetrics.calls || this.ourCalls(record);
    const engagementEvents: LoyaltyEngagementView[] = Array.isArray(
      record?.__workflowEvents?.effective,
    )
      ? record.__workflowEvents.effective
      : [];
    const assignees = uniqueSorted(
      calls.flatMap((call) => this.callAssigneeValues(call)),
    );
    item.computedStatuses = this.ourAgencyStatusCodes(relationMetrics);
    item.normalizedStage = this.ourAgencyPartnershipStage(
      item.computedStatuses,
    );
    item.attributes = {
      ...(item.attributes || {}),
      partnershipStatus: item.normalizedStage,
      partnershipStatusSource: item.normalizedStage
        ? "LOCAL_PRELIMINARY_DERIVED"
        : null,
    };
    item.dataQualityCodes = [];
    item.periodMetrics = this.ourAgencyPeriodMetrics(
      relationMetrics,
      filter.activityPeriod,
    );
    // Единое правило с брокерами нашей базы: период задан → метрики за
    // период; период не задан → lifetime-числа. Гейт low-signal ниже
    // намеренно остаётся на lifetime-значениях.
    const filteredDeals = filter.activityPeriod
      ? finiteNumber(item.periodMetrics?.deals)
      : deals;
    const filteredMeetings = filter.activityPeriod
      ? finiteNumber(item.periodMetrics?.meetings)
      : meetings;
    const filteredFixations = filter.activityPeriod
      ? finiteNumber(item.periodMetrics?.fixations)
      : fixations;
    const latestCall = this.applyCallSummary(item, "AGENCY", calls);
    const agencyActivityDates = [
      relationMetrics.lastActivityAt,
      latestCall?.occurredAt ||
        (latestCall ? this.callSortKey(latestCall) : null),
      ...engagementEvents.map((event) => event.occurredAt),
    ]
      .map(dateOnly)
      .filter(Boolean) as string[];
    item.lastActivityAt = agencyActivityDates.sort().at(-1) || null;
    const hasPhone =
      normalizeLoyaltyContactPoint("PHONE", record.phone || "") !== null;
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3);
    const hasRecentMeeting =
      relationMetrics.meetings === null
        ? null
        : relationMetrics.meetings.some((meeting: any) => {
            const value = new Date(meeting.date);
            return (
              Number.isFinite(value.getTime()) &&
              value >= threeMonthsAgo &&
              value <= new Date()
            );
          });
    // 2026-09-07: правило скрытия «малозначимых» агентств уточнено.
    // Раньше оно смотрело только на телефон, сделки и встречи за 3 месяца и
    // срабатывало РАНЬШЕ фильтра «Есть фиксации» — агентство с фиксациями,
    // но без телефона в карточке (таких большинство после импорта 05.09)
    // вырезалось, и фильтр показывал 4 записи вместо реальных. Теперь:
    // известные фиксации — тоже признак значимости, а при явном фильтре по
    // активности (колонка «Активность» или тип активности) правило не
    // применяется вовсе — пользователь сам сказал, что ищет.
    const explicitActivityFilter = Boolean(
      filter.columns?.activity || filter.activityType,
    );
    if (
      !filter.includeLowSignal &&
      !explicitActivityFilter &&
      !hasPhone &&
      deals === 0 &&
      fixations === 0 &&
      hasRecentMeeting === false
    ) {
      return false;
    }
    if (latestCall?.employee || latestCall?.employeeId) {
      item.assignee = {
        id: latestCall.employeeId || null,
        name: latestCall.employeeName || latestCall.employee || null,
      };
    }
    if (
      filter.dealCount.min !== undefined &&
      (filteredDeals === null || filteredDeals < filter.dealCount.min)
    )
      return false;
    if (
      filter.dealCount.max !== undefined &&
      (filteredDeals === null || filteredDeals > filter.dealCount.max)
    )
      return false;
    if (filter.dealsInPeriod !== undefined) {
      const periodDeals = finiteNumber(item.periodMetrics?.deals);
      if (periodDeals === null || periodDeals > 0 !== filter.dealsInPeriod)
        return false;
    }
    if (
      filter.meetings.min !== undefined ||
      filter.meetings.max !== undefined
    ) {
      if (
        filteredMeetings === null ||
        (filter.meetings.min !== undefined &&
          filteredMeetings < filter.meetings.min) ||
        (filter.meetings.max !== undefined &&
          filteredMeetings > filter.meetings.max)
      )
        return false;
    }
    if (filter.activityType) {
      // 2026-09-04 (задача F): без activityPeriod «тип активности» работает
      // lifetime (как у брокеров) — раньше periodMetrics был UNAVAILABLE и
      // вкладка агентств всегда возвращала пустой список. CALL проверяется
      // по объединённой модели звонков; период для CALL — activityPeriod,
      // затем callPeriod, иначе «за всё время».
      const lifetimeValue =
        filter.activityType === "FIXATION"
          ? fixations
          : filter.activityType === "MEETING"
            ? meetings
            : filter.activityType === "DEAL"
              ? deals
              : filter.activityType === "BROKER_TOUR"
                ? brokerTours
                : null;
      const periodValue =
        filter.activityType === "CALL"
          ? this.callPresenceInPeriod(
              calls,
              0,
              filter.activityPeriod ?? filter.callPeriod,
            ) === true
            ? 1
            : 0
          : filter.activityPeriod
            ? filter.activityType === "FIXATION"
              ? finiteNumber(item.periodMetrics?.fixations)
              : filter.activityType === "MEETING"
                ? finiteNumber(item.periodMetrics?.meetings)
                : filter.activityType === "DEAL"
                  ? finiteNumber(item.periodMetrics?.deals)
                  : null
            : lifetimeValue;
      if (periodValue === null || periodValue <= 0) return false;
    }
    if (
      filter.brokerStatuses.length &&
      !filter.brokerStatuses.some((status) =>
        item.computedStatuses.includes(status),
      )
    )
      return false;
    if (
      filter.partnershipStatuses.length &&
      (!item.normalizedStage ||
        !filter.partnershipStatuses.includes(item.normalizedStage))
    )
      return false;
    if (filter.bt !== undefined && (bt === null || bt !== filter.bt))
      return false;
    if (
      filter.scenario === "HAS_DEALS" &&
      !(filteredDeals !== null && filteredDeals > 0)
    )
      return false;
    if (filter.campaignIds.length) {
      const campaignAliases = this.campaignAliases(filter.campaignIds).map(
        lower,
      );
      const eligible = filter.callPeriod
        ? calls.filter(
            (call) => this.callInPeriod(call, filter.callPeriod!) === true,
          )
        : calls;
      if (
        !eligible.some((call) =>
          this.callCampaignValues(call).some((value) =>
            campaignAliases.includes(lower(value)),
          ),
        )
      )
        return false;
    }
    if (filter.lastCallResults.length) {
      const resultAliases = this.resultAliases(
        "AGENCY",
        filter.lastCallResults,
      ).map(lower);
      const campaignAliases = this.campaignAliases(filter.campaignIds).map(
        lower,
      );
      const eligible = calls.filter(
        (call) =>
          (!filter.callPeriod ||
            this.callInPeriod(call, filter.callPeriod) === true) &&
          (!campaignAliases.length ||
            this.callCampaignValues(call).some((value) =>
              campaignAliases.includes(lower(value)),
            )),
      );
      const latest = this.lastCall(eligible);
      if (!latest || !resultAliases.includes(lower(latest.result)))
        return false;
    }
    if (filter.called !== undefined) {
      const presence = this.callPresenceInPeriod(calls, 0, filter.callPeriod!);
      if (presence !== filter.called) return false;
    }
    if (
      filter.assigneeIds.length &&
      !filter.assigneeIds.some((value) => assignees.includes(value))
    )
      return false;
    if (filter.unassigned === true && assignees.length) return false;
    if (filter.staleDays !== undefined) {
      const days = daysSinceDate(item.lastActivityAt);
      if (days === null || days < filter.staleDays) return false;
    }
    const hasIndividualTerms = engagementEvents.some(
      (event) => event.type === "INDIVIDUAL_TERMS",
    );
    if (
      filter.individualTerms !== undefined &&
      hasIndividualTerms !== filter.individualTerms
    )
      return false;
    if (
      filter.specialTermsProposed !== undefined &&
      hasIndividualTerms !== filter.specialTermsProposed
    )
      return false;
    if (
      filter.rewardPresent !== undefined &&
      engagementEvents.some((event) => event.type === "AWARD") !==
        filter.rewardPresent
    )
      return false;
    if (
      !this.matchesColumnFilters(filter, {
        hasPhone: hasPhone,
        statuses: item.computedStatuses,
        bt,
        fixations: filteredFixations,
        meetings: filteredMeetings,
        callPresence: this.callPresenceInPeriod(calls, 0, filter.callPeriod),
        assignees,
        deals: filteredDeals,
      })
    )
      return false;
    const unsupported =
      (filter.scenario &&
        ![
          "HAS_DEALS",
          "HAS_MEETINGS",
          "NO_MEETINGS",
          "BT_VISITED",
          "BT_NOT_VISITED",
          "INDIVIDUAL_TERMS",
          "NO_INDIVIDUAL_TERMS",
          "NOT_CALLED_IN_PERIOD",
          "CALLED_IN_PERIOD",
          "UNASSIGNED",
        ].includes(filter.scenario)) ||
      filter.specializations.length ||
      filter.geography.length ||
      filter.workFormats.length ||
      filter.relationshipStages.length ||
      filter.dataQuality.length ||
      filter.agencySizes.length ||
      filter.websitePresent !== undefined ||
      filter.projectsOnSite.length;
    if (unsupported) return false;
    if (
      filter.scenario &&
      !this.matchesScenario(filter.scenario, {
        callPresence: ["NOT_CALLED_IN_PERIOD", "CALLED_IN_PERIOD"].includes(
          filter.scenario,
        )
          ? this.callPresenceInPeriod(calls, 0, filter.callPeriod!)
          : null,
        deals: filteredDeals,
        fixations: filteredFixations,
        meetings: filteredMeetings,
        bt,
        assignee: assignees[0] || "",
        stage: item.normalizedStage,
        hasIndividualTerms,
      })
    )
      return false;
    return true;
  }

  private ourBrokerActivityFilter(
    type: string,
    period?: { from: Date; to: Date },
  ): any {
    const dateRange = period ? { gte: period.from, lte: period.to } : undefined;
    if (type === "FIXATION")
      return {
        clients: {
          some: {
            ...FIXATION_CLIENT_WHERE,
            ...(dateRange ? { createdAt: dateRange } : {}),
          },
        },
      };
    if (type === "MEETING")
      return {
        meetings: {
          some: {
            status: { in: ["CONFIRMED", "COMPLETED"] },
            ...(dateRange ? { date: dateRange } : {}),
          },
        },
      };
    if (type === "DEAL")
      // AND-обёртка: некоторые вызывающие делают Object.assign(where, …) и
      // затем сами пишут where.OR — прямой OR-ключ там был бы затёрт.
      return {
        AND: [
          {
            OR: [
              { deals: { some: this.ourConfirmedDealWhere(period) } },
              { registryDeals: { some: this.registrySignedAtWhere(period) } },
            ],
          },
        ],
      };
    if (type === "BROKER_TOUR")
      return {
        brokerTourVisited: true,
        ...(dateRange ? { brokerTourDate: dateRange } : {}),
      };
    if (type === "CALL")
      // 2026-09-04 (задача E): объединённая модель звонков — как в ourCalls:
      // легаси CallLog ИЛИ workflow-попытка обзвона (LoyaltyCallAttempt через
      // назначение кампании). Раньше учитывался только CallLog, и брокер,
      // которого обзванивали только через кампании лояльности, не находился.
      // AND-обёртка — как у DEAL (Object.assign-вызывающие пишут свой OR).
      return {
        AND: [
          {
            OR: [
              { callLogs: { some: dateRange ? { createdAt: dateRange } : {} } },
              {
                loyaltyAssignmentsAsTarget: {
                  some: {
                    attempts: {
                      some: dateRange ? { occurredAt: dateRange } : {},
                    },
                  },
                },
              },
            ],
          },
        ],
      };
    return {};
  }

  private async ourBirthdayBrokerIds(): Promise<string[]> {
    const today = moscowDateParts().dayMonth;
    const rows = await this.prisma.broker.findMany({
      where: { role: "BROKER", mergedIntoId: null, birthDate: { not: null } },
      select: { id: true, birthDate: true },
    });
    return rows
      .filter((row) => {
        if (!row.birthDate) return false;
        const value = new Date(row.birthDate);
        const dayMonth = `${String(value.getUTCDate()).padStart(2, "0")}.${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
        return dayMonth === today;
      })
      .map((row) => row.id);
  }

  private async annaBirthdayRecordIds(snapshotId: string): Promise<string[]> {
    const today = moscowDateParts().dayMonth;
    const rows = await this.prisma.loyaltySourceRecord.findMany({
      where: {
        snapshotId,
        entityType: "BROKER",
        sourceArchivedAt: null,
        person: { is: { archivedAt: null } },
      },
      select: { id: true, attributes: true },
    });
    return (rows as any[])
      .filter((row) => annaBirthday(row.attributes) === today)
      .map((row) => row.id);
  }

  private mapOurBroker(
    item: any,
    dealAmount: string | null = null,
    detailed = false,
  ) {
    const result: any = {
      id: item.id,
      entityType: "BROKER",
      // 2026-09-07: «имя для работы» — если КЦ/бэкфилл заполнили
      // Broker.displayName, показываем его; иначе самоназвание брокера.
      // cabinetFullName — всегда оригинальное самоназвание из кабинета
      // (фронт показывает серым «в кабинете: …»).
      displayName: item.displayName || item.fullName,
      cabinetFullName: item.fullName ?? null,
      displayNameSource: item.displayName
        ? item.displayNameSource || null
        : null,
      city: item.region,
      region: item.region,
      isRegional: item.isRegional ?? null,
      isCoordinator: item.isCoordinator ?? null,
      specialization: item.specialization || null,
      funnelStage: item.funnelStage || null,
      normalizedStage: this.ourBrokerRelationshipStage(item),
      userStatus: item.status || null,
      updatedAt: item.updatedAt || null,
      archivedAt: item.mergedIntoId ? true : null,
      contactPoints: [
        {
          type: "PHONE",
          value: item.phone,
          maskedValue: maskContact("PHONE", item.phone),
          isPrimary: true,
        },
        ...(item.phones || []).map((phone: any) => ({
          type: "PHONE",
          value: phone.phone,
          maskedValue: maskContact("PHONE", phone.phone),
          isPrimary: phone.isPrimary,
        })),
        ...(item.email
          ? [
              {
                type: "EMAIL",
                value: item.email,
                maskedValue: maskContact("EMAIL", item.email),
                isPrimary: true,
              },
            ]
          : []),
      ],
      externalIdentities: item.amoContactId
        ? [
            {
              system: "AMOCRM",
              entityType: "CONTACT",
              externalId: String(item.amoContactId),
            },
          ]
        : [],
      agencies: (item.brokerAgencies || []).map((relation: any) => ({
        id: relation.agency.id,
        displayName: relation.agency.name,
        isPrimary: relation.isPrimary,
      })),
      // Красный бейдж «не звонить» на фронте; null — поле не загружено.
      doNotCall:
        typeof item.doNotCall === "boolean" ? item.doNotCall : null,
      metrics: {
        fixations: item._count?.clients || 0,
        deals: item._count?.deals || 0,
        meetings: item._count?.meetings || 0,
        // 2026-09-04 (задача E): единый источник числа звонков в списке и
        // карточке — легаси CallLog + workflow-звонки (семантика ourCalls).
        // Раньше карточка показывала _count.calls (телефония Mango), а
        // список — _count.callLogs; теперь оба — callLogs + workflow.
        // Фолбэк на _count.calls остаётся только для легаси-списка.
        calls:
          Number(item._count?.callLogs ?? item._count?.calls ?? 0) +
          (Array.isArray(item.__workflowCalls?.effective)
            ? item.__workflowCalls.effective.length
            : 0),
        dealAmount,
      },
      periodMetrics: this.unavailablePeriodMetrics(),
      // 2026-09-07: точность VERIFIED — фиксации/встречи/сделки считаются
      // напрямую из таблиц кабинета по выверенным правилам (аудит 09.2026).
      // Label по-русски: он показывается в карточке как есть.
      metricSource: {
        kind: "LOCAL_PRELIMINARY",
        label:
          "Данные кабинета: фиксации, встречи и сделки этого брокера",
        exactness: "VERIFIED",
        ruleVersion: "ours-broker-local-verified-v2",
        periodFilterApplied: false,
        contributingRecords:
          Number(item._count?.clients || 0) +
          Number(item._count?.meetings || 0) +
          Number(item._count?.deals || 0),
        sourceVersions: ["LOCAL_DB:CURRENT"],
      },
      category: item.category,
      assignee: item.assignedManager
        ? {
            id: item.assignedManager.id,
            name: item.assignedManager.fullName,
          }
        : null,
    };
    const calls = this.ourCalls(item);
    const latest = this.applyCallSummary(result, "BROKER", calls);
    this.applyEngagementSummary(result, item);
    if (!latest && item.lastCallAt) result.lastCallAt = item.lastCallAt;
    if (latest?.employee || latest?.employeeId) {
      result.assignee = {
        id: latest.employeeId || null,
        name: latest.employeeName || latest.employee || null,
      };
    }
    if (detailed) {
      const history = this.ourCallHistory(item);
      const evidence = this.ourBrokerEvidence(item);
      result.calls = history;
      result.callHistory = history;
      result.activities = evidence.items;
      result.activityEvidence = evidence;
      result.attributes = {
        calls: history,
        activityEvidence: {
          count: evidence.count,
          truncated: evidence.truncated,
          limit: evidence.limit,
          availability: evidence.availability,
          exactness: evidence.exactness,
          methodology: evidence.methodology,
        },
      };
      const engagementHistory = Array.isArray(item?.__workflowEvents?.history)
        ? item.__workflowEvents.history
        : [];
      result.engagementEvents = engagementHistory;
      result.loyaltyHistory = engagementHistory;
    }
    return result;
  }

  private mapOurAgency(
    item: any,
    dealAmount: string | null = null,
    detailed = false,
  ) {
    const relationMetrics = this.ourAgencyRelationMetrics(item);
    const relations = Array.isArray(item.brokerAgencies)
      ? item.brokerAgencies
      : null;
    const relationByBrokerId = new Map<string, any>();
    for (const relation of relations || []) {
      const brokerId = String(relation?.broker?.id || "");
      if (!brokerId) continue;
      const current = relationByBrokerId.get(brokerId);
      if (!current || relation?.isPrimary === true) {
        relationByBrokerId.set(brokerId, relation);
      }
    }
    const brokerCount =
      relationMetrics.brokers !== null
        ? relationMetrics.brokers.length
        : finiteNumber(item._count?.brokerAgencies);
    const contributingRecords = [
      relationMetrics.fixations,
      relationMetrics.meetings,
      relationMetrics.deals,
      relationMetrics.calls,
      relationMetrics.brokerTours,
    ].reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
    const computedStatuses = this.ourAgencyStatusCodes(relationMetrics);
    const normalizedStage = this.ourAgencyPartnershipStage(computedStatuses);
    const result: any = {
      id: item.id,
      entityType: "AGENCY",
      displayName: item.name,
      legalName: item.legalName,
      taxId: item.inn,
      city: null,
      computedStatuses,
      normalizedStage,
      attributes: {
        partnershipStatus: normalizedStage,
        partnershipStatusSource: normalizedStage
          ? "LOCAL_PRELIMINARY_DERIVED"
          : null,
        agencySize: null,
        website: null,
        projectsOnSite: null,
      },
      contactPoints: [
        ...(item.phone
          ? [
              {
                type: "PHONE",
                value: item.phone,
                maskedValue: maskContact("PHONE", item.phone),
                isPrimary: true,
              },
            ]
          : []),
        ...(item.email
          ? [
              {
                type: "EMAIL",
                value: item.email,
                maskedValue: maskContact("EMAIL", item.email),
                isPrimary: true,
              },
            ]
          : []),
      ],
      ...(relations
        ? {
            brokers: [...relationByBrokerId.values()].map((relation: any) => ({
              id: relation.broker.id,
              displayName: relation.broker.fullName,
              isPrimary: relation.isPrimary,
              contactPoints: [
                ...(relation.broker.phone
                  ? [
                      {
                        type: "PHONE",
                        maskedValue: maskContact(
                          "PHONE",
                          relation.broker.phone,
                        ),
                        isPrimary: true,
                      },
                    ]
                  : []),
                ...(relation.broker.email
                  ? [
                      {
                        type: "EMAIL",
                        maskedValue: maskContact(
                          "EMAIL",
                          relation.broker.email,
                        ),
                        isPrimary: true,
                      },
                    ]
                  : []),
              ],
            })),
          }
        : {}),
      metrics: {
        brokers: brokerCount,
        fixations:
          relationMetrics.fixations === null
            ? null
            : relationMetrics.fixations.length,
        meetings:
          relationMetrics.meetings === null
            ? null
            : relationMetrics.meetings.length,
        deals:
          relationMetrics.deals === null ? null : relationMetrics.deals.length,
        calls:
          relationMetrics.calls === null ? null : relationMetrics.calls.length,
        brokerTours:
          relationMetrics.brokerTours === null
            ? null
            : relationMetrics.brokerTours.length,
        dealAmount: relationMetrics.dealAmount ?? dealAmount,
      },
      periodMetrics: this.unavailablePeriodMetrics(),
      lastActivityAt: relationMetrics.lastActivityAt,
      updatedAt: item.updatedAt || null,
      metricSource: {
        kind: "LOCAL_PRELIMINARY",
        label: "Current local BrokerAgency relation rows",
        exactness: "APPROXIMATE",
        ruleVersion: "ours-agency-relations-v1",
        periodFilterApplied: false,
        contributingRecords,
        sourceVersions: ["LOCAL_DB:CURRENT"],
        methodology: {
          brokers: "Брокеры, привязанные к агентству сейчас (без повторов)",
          fixations:
            "Фиксации клиентов этих брокеров по правилам фиксации (статус «зафиксирован» или «условно уникален»), без повторов",
          meetings:
            "Подтверждённые и состоявшиеся встречи этих брокеров, без повторов",
          deals:
            "Подтверждённые сделки ДДУ агентства и этих брокеров плюс строки реестра ДДУ этих брокеров или с названием агентства, без повторов",
          calls:
            "Звонки агентству и этим брокерам из журнала звонков и кампаний обзвона, без повторов",
          brokerTours: "Брокер-туры этих брокеров",
          attribution:
            "История привязок брокер↔агентство не хранится, поэтому события брокера относятся к его текущему агентству — это оценка, а не точная история",
        },
      },
    };
    const calls = relationMetrics.calls || this.ourCalls(item);
    const latest = this.applyCallSummary(result, "AGENCY", calls);
    this.applyEngagementSummary(result, item);
    const activityDates = [
      result.lastActivityAt,
      latest ? this.callSortKey(latest) : null,
      ...(Array.isArray(item?.__workflowEvents?.effective)
        ? item.__workflowEvents.effective.map(
            (event: LoyaltyEngagementView) => event.occurredAt,
          )
        : []),
    ]
      .map(dateOnly)
      .filter(Boolean) as string[];
    result.lastActivityAt = activityDates.sort().at(-1) || null;
    if (latest?.employee || latest?.employeeId) {
      result.assignee = {
        id: latest.employeeId || null,
        name: latest.employeeName || latest.employee || null,
      };
    }
    if (detailed) {
      const history = this.ourAgencyCallHistory(item);
      const evidence = this.ourAgencyEvidence(
        relationMetrics,
        item?.id ? String(item.id) : null,
      );
      result.calls = history;
      result.callHistory = history;
      result.activities = evidence.items;
      result.activityEvidence = evidence;
      result.attributes = {
        ...result.attributes,
        calls: history,
        activityEvidence: {
          count: evidence.count,
          truncated: evidence.truncated,
          limit: evidence.limit,
          availability: evidence.availability,
          exactness: evidence.exactness,
          methodology: evidence.methodology,
        },
      };
      const engagementHistory = Array.isArray(item?.__workflowEvents?.history)
        ? item.__workflowEvents.history
        : [];
      result.engagementEvents = engagementHistory;
      result.loyaltyHistory = engagementHistory;
    }
    return result;
  }

  async exportCsv(
    baseInput: string,
    entityType: EntityType,
    dto: LoyaltyExportDto,
    actorId?: string,
  ) {
    const query = Object.assign(
      new LoyaltyListQueryDto(),
      dto,
      dto.filters || {},
      { page: 1, pageSize: MAX_LOYALTY_EXPORT_ROWS },
    );
    const search = dto.search?.trim() || undefined;
    const result: any = await this.list(
      baseInput,
      entityType,
      query,
      search,
      dto.filter,
    );
    const items = (result.items || []).slice(0, MAX_LOYALTY_EXPORT_ROWS);
    const truncated = Number(result.total || 0) > items.length;
    if (truncated) {
      throw new BadRequestException({
        message:
          "Export exceeds the synchronous safety limit; narrow the filter or use an asynchronous export job",
        total: Number(result.total || 0),
        maxRows: MAX_LOYALTY_EXPORT_ROWS,
        filterHash: result.filterHash,
      });
    }
    await (this.prisma as any).auditLog.create({
      data: {
        userId: actorId || null,
        action: "LOYALTY_CSV_EXPORT",
        entity: "LoyaltyBase",
        entityId: `${result.base}:${entityType}`,
        // Deliberately exclude search text, filters and row contents.
        payload: {
          base: result.base,
          entityType,
          rowCount: items.length,
          truncated,
          maxRows: MAX_LOYALTY_EXPORT_ROWS,
          filterHash: result.filterHash,
        },
      },
    });
    const header = [
      "База",
      "Тип",
      "Имя / название",
      "Агентство",
      "Телефоны (маска)",
      "Email (маска)",
      "Город",
      "Связь с amoCRM",
      "Роль",
      "Специализация",
      "Стадия",
      "Статусы",
      "Качество данных",
      "Источник канонических метрик",
      "Точность канонических метрик",
      "Точные фиксации",
      "Точные встречи",
      "Точные сделки",
      "Точная сумма сделок",
      "Точный брокер-тур",
      "Наша база: локальные фиксации (предварительно)",
      "Наша база: локальные встречи (предварительно)",
      "Наша база: локальные сделки (предварительно)",
      "Наша база: локальная сумма сделок (предварительно)",
      "Выбранный период: доступность",
      "Выбранный период: с",
      "Выбранный период: по",
      "Выбранный период: фиксации",
      "Выбранный период: встречи",
      "Выбранный период: сделки",
      "Выбранный период: сумма сделок",
      "Выбранный период: последняя фиксация",
      "Выбранный период: последняя встреча",
      "Выбранный период: последняя сделка",
      "Срез Анны: фиксации (не подтверждено)",
      "Срез Анны: встречи (не подтверждено)",
      "Срез Анны: сделки (не подтверждено)",
      "Срез Анны: сумма сделок (не подтверждено)",
      "Срез Анны: брокер-тур (не подтверждено)",
      "Источник среза Анны",
      "Точность среза Анны",
      "Период среза Анны",
      "Ответственный",
      "Последняя активность",
    ];
    const rows = function* () {
      yield Buffer.from("\uFEFF", "utf8");
      yield Buffer.from(csvLine(header), "utf8");
      for (const item of items) {
        const exact = item.metrics || {};
        const source = item.sourceReportedMetrics || {};
        const selectedPeriod = item.periodMetrics || {};
        const metricSource = item.metricSource || {};
        const hasExactMetrics = metricSource.kind === "EXACT_ACTIVITIES";
        const exactMetric = (field: string) =>
          hasExactMetrics && exact[field] !== null && exact[field] !== undefined
            ? exact[field]
            : null;
        const localMetric = (field: string) =>
          result.base === "ours" &&
          exact[field] !== null &&
          exact[field] !== undefined
            ? exact[field]
            : null;
        const sourceMetric = (field: string) =>
          source[field] !== null && source[field] !== undefined
            ? source[field]
            : null;
        const selectedPeriodAvailable =
          selectedPeriod.availability &&
          selectedPeriod.availability !== "UNAVAILABLE";
        const selectedPeriodMetric = (field: string) =>
          selectedPeriodAvailable &&
          selectedPeriod[field] !== null &&
          selectedPeriod[field] !== undefined
            ? selectedPeriod[field]
            : null;
        const sourcePeriod = source.periodKind
          ? [source.periodKind, source.periodFrom, source.periodTo]
              .filter(Boolean)
              .join(" ")
          : null;
        const phones = (item.contactPoints || [])
          .filter((point: any) => point.type === "PHONE")
          .map((point: any) => point.maskedValue)
          .join("; ");
        const emails = (item.contactPoints || [])
          .filter((point: any) => point.type === "EMAIL")
          .map((point: any) => point.maskedValue)
          .join("; ");
        const hasAmo = (item.externalIdentities || []).some(
          (identity: any) => identity.system === "AMOCRM",
        );
        const amoState = hasAmo
          ? "Есть"
          : result.base === "ours" && entityType === "AGENCY"
            ? "Нет данных"
            : "Нет";
        yield Buffer.from(
          csvLine([
            result.base,
            entityType,
            item.displayName,
            (item.agencies || [])
              .map((agency: any) => agency.displayName)
              .filter(Boolean)
              .join("; ") || item.attributes?.company,
            phones,
            emails,
            item.city,
            amoState,
            item.attributes?.role,
            Array.isArray(item.attributes?.specialization)
              ? item.attributes.specialization.join("; ")
              : item.attributes?.specialization || item.specialization,
            item.attributes?.partnershipStatus ||
              item.attributes?.stage ||
              item.funnelStage,
            (item.computedStatuses || []).join("; "),
            (item.dataQualityCodes || []).join("; "),
            metricSource.label || metricSource.kind || null,
            metricSource.exactness ||
              (hasExactMetrics ? "EXACT" : "UNAVAILABLE"),
            exactMetric("fixations"),
            exactMetric("meetings"),
            exactMetric("deals"),
            exactMetric("dealAmount"),
            exactMetric("brokerTours") === null
              ? null
              : Number(exactMetric("brokerTours")) > 0,
            localMetric("fixations"),
            localMetric("meetings"),
            localMetric("deals"),
            localMetric("dealAmount"),
            selectedPeriod.availability || "UNAVAILABLE",
            selectedPeriod.period?.from || null,
            selectedPeriod.period?.to || null,
            selectedPeriodMetric("fixations"),
            selectedPeriodMetric("meetings"),
            selectedPeriodMetric("deals"),
            selectedPeriodMetric("dealAmount"),
            selectedPeriodMetric("lastFixationAt"),
            selectedPeriodMetric("lastMeetingAt"),
            selectedPeriodMetric("lastDealAt"),
            sourceMetric("fixations"),
            sourceMetric("meetings"),
            sourceMetric("deals"),
            sourceMetric("dealAmount"),
            source.brokerTourVisited ??
              (sourceMetric("brokerTours") === null
                ? null
                : Number(sourceMetric("brokerTours")) > 0),
            source.sourceLabel || source.sourceVersion || null,
            source.exactness || source.quality || null,
            sourcePeriod,
            item.assignee?.name || item.attributes?.assignee,
            item.lastActivityAt,
          ]),
          "utf8",
        );
      }
    };
    return {
      stream: Readable.from(rows()),
      fileName: `${result.base}-${entityType.toLowerCase()}-loyalty.csv`,
      rowCount: items.length,
      truncated,
      filterHash: result.filterHash,
    };
  }

  async entityChanges(
    entityType: EntityType,
    id: string,
    query: LoyaltyChangesQueryDto,
  ) {
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    const where =
      entityType === "BROKER" ? { personId: id } : { organizationId: id };
    const [items, total] = await Promise.all([
      (this.prisma as any).loyaltyEntityChange.findMany({
        where,
        select: {
          id: true,
          action: true,
          changedFields: true,
          beforeValues: true,
          afterValues: true,
          actorId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      (this.prisma as any).loyaltyEntityChange.count({ where }),
    ]);
    return {
      entityType,
      entityId: id,
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 2026-09-07: карточка базы Анны показывает данные НАШЕЙ карточки по
   * подтверждённой сцепке (сверка → LINK). Требование владельца: всё, что
   * найдено и дополнено для нашей базы (телефоны, юрназвание, ссылки amo,
   * сделки реестра, события), должно быть видно и в карточке Анны.
   * Берём полную нашу карточку тем же detail("ours", …); если наша запись
   * удалена или недоступна — linkedOurRecord = null, карточка Анны не падает.
   */
  private async attachLinkedOurRecord(
    item: any,
    periodDto?: { from?: string; to?: string },
  ) {
    const link = item?.linkedOurs;
    const type = link?.type === "AGENCY" ? "AGENCY" : link?.type === "BROKER" ? "BROKER" : null;
    if (!type || !link?.id) {
      item.linkedOurRecord = null;
      return;
    }
    try {
      const ours: any = await this.detail("ours", type, String(link.id), periodDto);
      item.linkedOurRecord = ours?.item ?? null;
    } catch {
      item.linkedOurRecord = null;
    }
  }

  async detail(
    baseInput: string,
    entityType: EntityType,
    id: string,
    // 2026-09-07: выбранный в списке «Период встреч и сделок» теперь
    // применяется и к карточке — фронт передаёт его как ?from=&to=.
    periodDto?: { from?: string; to?: string },
  ) {
    const base = this.parseBase(baseInput);
    const activityPeriod = this.parseOptionalFilterPeriod(
      periodDto,
      "activityPeriod",
    );
    if (base === "anna") {
      const active = await this.activeAnnaSnapshot();
      if (!active)
        throw new NotFoundException("Published Anna snapshot not found");
      const record = await this.prisma.loyaltySourceRecord.findFirst({
        where: {
          snapshotId: active.snapshot.id,
          entityType,
          ...(entityType === "BROKER"
            ? { personId: id }
            : { organizationId: id }),
        },
        include: this.annaRecordInclude(
          active.snapshot.id,
          active.snapshot.ruleVersion,
          true,
        ),
      });
      if (!record) {
        const manualDelegate = (this.prisma as any).loyaltyManualEntity;
        const manual = manualDelegate?.findFirst
          ? await manualDelegate.findFirst({
              where: {
                datasetId: active.dataset.id,
                entityType,
                ...(entityType === "BROKER"
                  ? { personId: id }
                  : { organizationId: id }),
              },
              include: this.annaManualEntityInclude(),
            })
          : null;
        if (!manual) throw new NotFoundException("Loyalty entity not found");
        const manualRecord = this.manualOverlayAsAnnaRecord(manual);
        const workflowCalls = await this.workflowCallReadModels(
          "anna",
          entityType,
          [this.workflowTargetId(manualRecord, entityType)],
        );
        this.attachWorkflowCallReadModels(
          [manualRecord],
          entityType,
          workflowCalls,
        );
        const engagementEvents = await this.engagementReadModels(
          "anna",
          entityType,
          [this.workflowTargetId(manualRecord, entityType)],
        );
        this.attachEngagementReadModels(
          [manualRecord],
          entityType,
          engagementEvents,
        );
        const manualItem = this.mapAnnaManualRecord(manualRecord, true);
        await this.attachLinkedOurRecord(manualItem, periodDto);
        return {
          base: "anna",
          entityType,
          item: manualItem,
        };
      }
      const workflowCalls = await this.workflowCallReadModels(
        "anna",
        entityType,
        [this.workflowTargetId(record as any, entityType)],
      );
      this.attachWorkflowCallReadModels(
        [record as any],
        entityType,
        workflowCalls,
      );
      const engagementEvents = await this.engagementReadModels(
        "anna",
        entityType,
        [this.workflowTargetId(record as any, entityType)],
      );
      this.attachEngagementReadModels(
        [record as any],
        entityType,
        engagementEvents,
      );
      const activityObservedThrough =
        this.trustedFullSnapshotActivityCoverage(active.snapshot)
          ?.observedThroughIso || null;
      const annaItem = this.mapAnnaRecord(
        record as any,
        true,
        activityObservedThrough,
      );
      // 2026-09-07: карточка Анны считает агрегаты за всё время снимка.
      // Если запрошен период — честно фиксируем его как непримененный,
      // чтобы фронт показал плашку с причиной (а не молчал).
      if (
        activityPeriod &&
        (!annaItem.periodMetrics ||
          annaItem.periodMetrics.availability === "UNAVAILABLE")
      ) {
        annaItem.periodMetrics = this.unavailablePeriodMetrics(activityPeriod);
      }
      await this.attachLinkedOurRecord(annaItem, periodDto);
      return {
        base: "anna",
        entityType,
        item: annaItem,
      };
    }
    if (entityType === "BROKER") {
      const broker = await this.prisma.broker.findUnique({
        where: { id },
        include: {
          phones: true,
          brokerAgencies: { include: { agency: true } },
          assignedManager: { select: { id: true, fullName: true } },
          callLogs: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: {
              id: true,
              createdAt: true,
              campaign: true,
              result: true,
              operatorId: true,
              comment: true,
              nextCallAt: true,
            },
          },
          clients: {
            where: FIXATION_CLIENT_WHERE,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: OUR_ACTIVITY_EVIDENCE_LIMIT,
            select: {
              id: true,
              createdAt: true,
              fixationStatus: true,
              amoLeadId: true,
              // 2026-09-07: имя клиента и проект — чтобы записи в
              // «События и карточки-основания» читались, а не были безликими.
              fullName: true,
              project: true,
            },
          },
          meetings: {
            // 2026-09-07: помимо подтверждённых — PENDING с меткой
            // backfill-а «[amo:...]» (статус из amoCRM вернуть не удалось).
            // Требование владельца: такие встречи должны быть ЯВНО видны
            // в карточке (оранжевый бейдж), а не пропадать из истории.
            where: {
              OR: [
                { status: { in: ["CONFIRMED", "COMPLETED"] } },
                { status: "PENDING", comment: { contains: "[amo:" } },
              ],
            },
            orderBy: [{ date: "desc" }, { id: "desc" }],
            take: OUR_ACTIVITY_EVIDENCE_LIMIT,
            select: {
              id: true,
              date: true,
              status: true,
              type: true,
              comment: true,
              client: {
                select: { amoLeadId: true, fullName: true, project: true },
              },
            },
          },
          deals: {
            where: this.ourConfirmedDealWhere(),
            orderBy: [{ signedAt: "desc" }, { id: "desc" }],
            take: OUR_ACTIVITY_EVIDENCE_LIMIT,
            select: {
              id: true,
              signedAt: true,
              createdAt: true,
              status: true,
              amount: true,
              amoDealId: true,
              project: true,
              client: {
                select: { amoLeadId: true, fullName: true, project: true },
              },
            },
          },
          _count: {
            select: {
              clients: { where: FIXATION_CLIENT_WHERE },
              deals: { where: this.ourConfirmedDealWhere() },
              meetings: {
                where: { status: { in: ["CONFIRMED", "COMPLETED"] } },
              },
              // Задача E: карточка считает звонки как список — легаси
              // CallLog (+ workflow в mapOurBroker), а не телефонию (calls).
              callLogs: true,
            },
          },
        },
      });
      if (!broker) throw new NotFoundException("Broker not found");
      const dealAmount = await this.prisma.deal.aggregate({
        where: { ...this.ourConfirmedDealWhere(), brokerId: id },
        _sum: { amount: true },
      });
      // «Реестр сделок» в карточке брокера: тот же комбинированный счётчик
      // и сумма, что и в списке нашей базы.
      let registryAmountCents = 0n;
      if (this.registryDealModel) {
        const registry = await this.registryDealModel.aggregate({
          where: { brokerId: id },
          _count: { _all: true },
          _sum: { amount: true },
        });
        const registryCount = Number(registry?._count?._all || 0);
        if (registryCount > 0) {
          (broker as any)._count = {
            ...((broker as any)._count || {}),
            deals: Number((broker as any)._count?.deals || 0) + registryCount,
          };
        }
        if (
          registry?._sum?.amount !== null &&
          registry?._sum?.amount !== undefined
        ) {
          registryAmountCents = moneyToCents(String(registry._sum.amount));
        }
      }
      const workflowCalls = await this.workflowCallReadModels(
        "ours",
        "BROKER",
        [String(broker.id)],
      );
      this.attachWorkflowCallReadModels(
        [broker as any],
        "BROKER",
        workflowCalls,
      );
      const engagementEvents = await this.engagementReadModels(
        "ours",
        "BROKER",
        [String(broker.id)],
      );
      this.attachEngagementReadModels(
        [broker as any],
        "BROKER",
        engagementEvents,
      );
      const item = this.mapOurBroker(
        broker,
        centsToMoney(
          moneyToCents(String(dealAmount._sum.amount || "0")) +
            registryAmountCents,
        ),
        true,
      );
      // 2026-09-07: применяем выбранный период к периодным метрикам карточки
      // тем же батч-агрегатом, что и в списке (ourBrokerPeriodMetrics).
      if (activityPeriod) {
        const periodMetrics = await this.ourBrokerPeriodMetrics(
          [String(broker.id)],
          activityPeriod,
        );
        item.periodMetrics =
          periodMetrics.get(String(broker.id)) ||
          this.unavailablePeriodMetrics(activityPeriod);
        item.metricSource.periodFilterApplied = true;
      }
      return { base: "ours", entityType, item };
    }
    const agency = await this.prisma.agency.findUnique({
      where: { id },
      include: this.ourAgencyReadInclude(),
    });
    if (!agency) throw new NotFoundException("Agency not found");
    await this.attachOurAgencyRegistryDeals([agency as any]);
    const workflowCalls = await this.workflowCallReadModels("ours", "AGENCY", [
      String(agency.id),
    ]);
    this.attachWorkflowCallReadModels([agency as any], "AGENCY", workflowCalls);
    const relatedBrokers = Array.isArray((agency as any).brokerAgencies)
      ? (agency as any).brokerAgencies
          .map((relation: any) => relation?.broker)
          .filter(Boolean)
      : [];
    const relatedBrokerCalls = await this.workflowCallReadModels(
      "ours",
      "BROKER",
      relatedBrokers.map((broker: any) => String(broker.id)),
    );
    this.attachWorkflowCallReadModels(
      relatedBrokers,
      "BROKER",
      relatedBrokerCalls,
    );
    const engagementEvents = await this.engagementReadModels("ours", "AGENCY", [
      String(agency.id),
    ]);
    this.attachEngagementReadModels(
      [agency as any],
      "AGENCY",
      engagementEvents,
    );
    const agencyItem = this.mapOurAgency(agency, null, true);
    // 2026-09-07: период применяется и к карточке агентства — те же строки
    // relation-графа, что и в списке (ourAgencyPeriodMetrics).
    if (activityPeriod) {
      agencyItem.periodMetrics = this.ourAgencyPeriodMetrics(
        this.ourAgencyRelationMetrics(agency),
        activityPeriod,
      );
      agencyItem.metricSource.periodFilterApplied = true;
    }
    return {
      base: "ours",
      entityType,
      item: agencyItem,
    };
  }

  /**
   * 2026-09-07: правка «имени для работы» брокера кабинета из карточки
   * «Нашей базы» (кнопка «Исправить имя»). Пишет Broker.displayName
   * (source='manual'); пустая строка сбрасывает имя (снова показывается
   * самоназвание). fullName (самоназвание брокера) НЕ трогается — брокер
   * в своём кабинете продолжает видеть его. Аудит: DISPLAY_NAME_EDIT.
   */
  async updateOurBrokerDisplayName(
    id: string,
    displayNameInput: string,
    actorId?: string,
  ) {
    const displayName =
      String(displayNameInput ?? "")
        .replace(/\s+/g, " ")
        .trim() || null;
    const broker = await this.prisma.broker.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        displayName: true,
        displayNameSource: true,
      },
    });
    if (!broker) throw new NotFoundException("Broker not found");
    const updated = await (this.prisma.broker as any).update({
      where: { id },
      data: {
        displayName,
        displayNameSource: displayName ? "manual" : null,
      },
      select: { id: true, fullName: true, displayName: true, displayNameSource: true },
    });
    await (this.prisma as any).auditLog.create({
      data: {
        userId: actorId || null,
        action: "DISPLAY_NAME_EDIT",
        entity: "Broker",
        entityId: id,
        payload: {
          before: broker.displayName ?? null,
          beforeSource: broker.displayNameSource ?? null,
          after: displayName,
          afterSource: displayName ? "manual" : null,
        },
      },
    });
    return {
      id: updated.id,
      displayName: updated.displayName || updated.fullName,
      cabinetFullName: updated.fullName ?? null,
      displayNameSource: updated.displayName
        ? updated.displayNameSource || null
        : null,
    };
  }

  async updateAnnaEntity(
    entityType: EntityType,
    id: string,
    dto: LoyaltyEntityUpdateDto,
    actorId?: string,
  ) {
    const expectedUpdatedAt = new Date(dto.expectedUpdatedAt);
    if (Number.isNaN(expectedUpdatedAt.getTime())) {
      throw new BadRequestException(
        "expectedUpdatedAt must be an ISO timestamp",
      );
    }
    if (dto.displayName !== undefined && !dto.displayName.trim()) {
      throw new BadRequestException("displayName cannot be blank");
    }
    if (dto.city !== undefined && !dto.city.trim()) {
      throw new BadRequestException("city cannot be blank");
    }
    const sanitizedAttributes =
      dto.attributes !== undefined ? sanitizeJson(dto.attributes) : undefined;
    const data: any = {};
    const changedFields: string[] = [];
    if (dto.displayName !== undefined) {
      data.manualDisplayName = dto.displayName.trim();
      changedFields.push("displayName");
    }
    if (dto.city !== undefined) {
      data.manualCity = dto.city.trim();
      changedFields.push("city");
    }
    if (dto.attributes !== undefined) {
      data.manualAttributes = sanitizedAttributes;
      changedFields.push("attributes");
    }
    if (dto.archived !== undefined) {
      data.archivedAt = dto.archived ? new Date() : null;
      changedFields.push("archivedAt");
    }
    if (!changedFields.length)
      throw new BadRequestException("No update fields provided");
    await this.prisma.$transaction(
      async (tx: any) => {
        const dataset = await tx.loyaltyDataset.findUnique({
          where: { code: ANNA_DATASET_CODE },
          select: { id: true, activeSnapshotId: true },
        });
        if (!dataset?.activeSnapshotId)
          throw new NotFoundException("Published Anna snapshot not found");
        const record = await tx.loyaltySourceRecord.findFirst({
          where: {
            snapshotId: dataset.activeSnapshotId,
            entityType,
            snapshot: { status: "PUBLISHED", datasetId: dataset.id },
            ...(entityType === "BROKER"
              ? { personId: id }
              : { organizationId: id }),
          },
          include: { person: true, organization: true },
        });
        const manualOverlay = record
          ? null
          : await tx.loyaltyManualEntity.findFirst({
              where: {
                datasetId: dataset.id,
                entityType,
                ...(entityType === "BROKER"
                  ? { personId: id }
                  : { organizationId: id }),
              },
              include: { person: true, organization: true },
            });
        if (!record && !manualOverlay)
          throw new NotFoundException("Loyalty entity not found");
        const entity: any =
          record?.person ||
          record?.organization ||
          manualOverlay?.person ||
          manualOverlay?.organization;
        const mutationAt = new Date();
        data.updatedAt = mutationAt;
        const action =
          dto.archived === true
            ? "ARCHIVE"
            : dto.archived === false && entity.archivedAt
              ? "RESTORE"
              : "UPDATE";
        const beforeValues: Record<string, unknown> = {};
        const afterValues: Record<string, unknown> = {};
        if (dto.displayName !== undefined) {
          beforeValues.displayName = entity.manualDisplayName ?? null;
          afterValues.displayName = data.manualDisplayName;
        }
        if (dto.city !== undefined) {
          beforeValues.city = entity.manualCity ?? null;
          afterValues.city = data.manualCity;
        }
        if (dto.attributes !== undefined) {
          beforeValues.attributes = entity.manualAttributes ?? null;
          afterValues.attributes = sanitizedAttributes;
        }
        if (dto.archived !== undefined) {
          beforeValues.archivedAt = entity.archivedAt
            ? new Date(entity.archivedAt).toISOString()
            : null;
          afterValues.archivedAt = data.archivedAt
            ? new Date(data.archivedAt).toISOString()
            : null;
        }
        let updateResult: { count: number };
        if (manualOverlay) {
          if (dto.archived === false && manualOverlay.archivedAt) {
            const normalizedContacts = [
              manualOverlay.phoneNormalized,
              manualOverlay.emailNormalized,
            ].filter(Boolean);
            if (normalizedContacts.length) {
              const activeConflict = await tx.loyaltyContactPoint.findFirst({
                where: {
                  sourceRecord: { snapshotId: dataset.activeSnapshotId },
                  normalizedValue: { in: normalizedContacts },
                },
                select: { id: true },
              });
              if (activeConflict) {
                throw new ConflictException("LOYALTY_CONTACT_ALREADY_EXISTS");
              }
            }
          }
          const overlayData: any = {
            updatedAt: mutationAt,
            version: { increment: 1 },
          };
          if (dto.displayName !== undefined)
            overlayData.displayName = data.manualDisplayName;
          if (dto.city !== undefined) overlayData.city = data.manualCity;
          if (dto.attributes !== undefined)
            overlayData.attributes = sanitizedAttributes;
          if (dto.archived !== undefined)
            overlayData.archivedAt = data.archivedAt;
          updateResult = await tx.loyaltyManualEntity.updateMany({
            where: { id: manualOverlay.id, updatedAt: expectedUpdatedAt },
            data: overlayData,
          });
          if (updateResult.count === 1) {
            if (entityType === "BROKER") {
              await tx.loyaltyPerson.update({ where: { id }, data });
            } else {
              await tx.loyaltyOrganization.update({ where: { id }, data });
            }
          }
        } else {
          updateResult =
            entityType === "BROKER"
              ? await tx.loyaltyPerson.updateMany({
                  where: { id, updatedAt: expectedUpdatedAt },
                  data,
                })
              : await tx.loyaltyOrganization.updateMany({
                  where: { id, updatedAt: expectedUpdatedAt },
                  data,
                });
        }
        if (updateResult.count !== 1) {
          throw new ConflictException(
            "Loyalty entity changed; reload it before retrying",
          );
        }
        if (action === "ARCHIVE") {
          const ownerWhere =
            entityType === "BROKER" ? { personId: id } : { organizationId: id };
          const revokedLinks = await tx.loyaltyEntityLink.updateMany({
            where: { ...ownerWhere, status: "CONFIRMED", revokedAt: null },
            data: {
              status: "REVOKED",
              revokedAt: mutationAt,
              revokedById: actorId || null,
              version: { increment: 1 },
            },
          });
          const assignmentWhere =
            entityType === "BROKER"
              ? { annaPersonId: id }
              : { annaOrganizationId: id };
          const cancelledAssignments =
            await tx.loyaltyCallAssignment.updateMany({
              where: {
                ...assignmentWhere,
                status: { in: ["PENDING", "IN_PROGRESS"] },
              },
              data: {
                status: "CANCELLED",
                cancelledAt: mutationAt,
                version: { increment: 1 },
              },
            });
          changedFields.push("activeLinks", "openCallAssignments");
          beforeValues.activeLinks = Number(revokedLinks?.count || 0);
          afterValues.activeLinks = 0;
          beforeValues.openCallAssignments = Number(
            cancelledAssignments?.count || 0,
          );
          afterValues.openCallAssignments = 0;
        }
        if (action === "RESTORE") {
          const reopened = await tx.loyaltyReconciliationCase.updateMany({
            where: {
              snapshotId: dataset.activeSnapshotId,
              status: "RESOLVED",
              decision: "ARCHIVE",
              ...(entityType === "BROKER"
                ? { personId: id }
                : { organizationId: id }),
            },
            data: {
              status: "OPEN",
              decision: null,
              decisionReason: null,
              decisionPayload: null,
              resolvedById: null,
              resolvedAt: null,
              version: { increment: 1 },
            },
          });
          if (Number(reopened?.count || 0) > 0) {
            changedFields.push("reconciliationCases");
            beforeValues.reconciliationCases = {
              status: "RESOLVED",
              decision: "ARCHIVE",
              count: reopened.count,
            };
            afterValues.reconciliationCases = {
              status: "OPEN",
              decision: null,
              count: reopened.count,
            };
          }
        }
        await tx.loyaltyEntityChange.create({
          data: {
            personId: entityType === "BROKER" ? id : null,
            organizationId: entityType === "AGENCY" ? id : null,
            action,
            changedFields,
            beforeValues,
            afterValues,
            actorId: actorId || null,
          },
        });
        // Manual values belong to the stable entity. Replicate their provenance
        // to both the active and already-staged source records so a later publish
        // cannot expose an override whose evidence only exists in an old snapshot.
        const provenanceRecords = manualOverlay
          ? []
          : await tx.loyaltySourceRecord.findMany({
              where: {
                entityType,
                snapshot: {
                  datasetId: dataset.id,
                  status: { in: ["PUBLISHED", "STAGED"] },
                },
                ...(entityType === "BROKER"
                  ? { personId: id }
                  : { organizationId: id }),
              },
              select: { id: true },
            });
        const manualFields: any[] = [];
        for (const provenanceRecord of provenanceRecords) {
          if (dto.displayName !== undefined)
            manualFields.push(
              this.fieldValueRow(
                provenanceRecord.id,
                "displayName",
                dto.displayName.trim(),
                dto.displayName.trim().toLowerCase(),
                "MANUAL",
                actorId,
                true,
              ),
            );
          if (dto.city !== undefined)
            manualFields.push(
              this.fieldValueRow(
                provenanceRecord.id,
                "city",
                dto.city.trim(),
                dto.city.trim().toLowerCase(),
                "MANUAL",
                actorId,
                true,
              ),
            );
          if (dto.attributes !== undefined)
            manualFields.push(
              this.fieldValueRow(
                provenanceRecord.id,
                "attributes",
                sanitizedAttributes,
                null,
                "MANUAL",
                actorId,
                true,
              ),
            );
        }
        await this.createManyInChunks(tx.loyaltySourceFieldValue, manualFields);
      },
      { isolationLevel: "Serializable" as any },
    );
    return this.detail("anna", entityType, id);
  }

  async archiveAnnaEntity(
    entityType: EntityType,
    id: string,
    expectedUpdatedAt: string,
    actorId?: string,
  ) {
    return this.updateAnnaEntity(
      entityType,
      id,
      Object.assign(new LoyaltyEntityUpdateDto(), {
        archived: true,
        expectedUpdatedAt,
      }),
      actorId,
    );
  }

  async reconciliation(query: LoyaltyReconciliationQueryDto, search?: string) {
    const active = await this.activeAnnaSnapshot();
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    if (!active) return { items: [], page, pageSize, total: 0, totalPages: 0 };
    const where: any = {
      snapshotId: active.snapshot.id,
      AND: [
        {
          OR: [
            {
              person: {
                is: {
                  archivedAt: null,
                  sourceRecords: {
                    some: {
                      snapshotId: active.snapshot.id,
                      sourceArchivedAt: null,
                    },
                  },
                },
              },
            },
            {
              organization: {
                is: {
                  archivedAt: null,
                  sourceRecords: {
                    some: {
                      snapshotId: active.snapshot.id,
                      sourceArchivedAt: null,
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    };
    if (query.status) where.status = query.status;
    if (query.entityType) where.targetType = query.entityType;
    if (search) {
      const normalizedPhone = normalizeLoyaltyContactPoint("PHONE", search);
      const numericAmoId = positivePostgresBigIntOrNull(search);
      const [ourBrokers, ourAgencies] = await Promise.all([
        this.prisma.broker.findMany({
          where: {
            role: "BROKER",
            mergedIntoId: null,
            OR: [
              { fullName: { contains: search, mode: "insensitive" } },
              ...(normalizedPhone
                ? [
                    { phone: normalizedPhone },
                    { phones: { some: { phone: normalizedPhone } } },
                  ]
                : []),
              ...(numericAmoId !== null
                ? [{ amoContactId: numericAmoId }]
                : []),
            ],
          },
          select: { id: true },
          take: 500,
        }),
        this.prisma.agency.findMany({
          where: {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { legalName: { contains: search, mode: "insensitive" } },
              { inn: { contains: search } },
              ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
            ],
          },
          select: { id: true },
          take: 500,
        }),
      ]);
      const recordFilter: any = {
        snapshotId: active.snapshot.id,
        sourceArchivedAt: null,
        OR: [
          { displayName: { contains: search, mode: "insensitive" } },
          ...(normalizedPhone
            ? [
                {
                  contactPoints: { some: { normalizedValue: normalizedPhone } },
                },
              ]
            : []),
        ],
      };
      where.AND.push({
        OR: [
          { person: { is: { sourceRecords: { some: recordFilter } } } },
          { organization: { is: { sourceRecords: { some: recordFilter } } } },
          ...((ourBrokers as any[]).length
            ? [
                {
                  targetType: "BROKER",
                  targetId: {
                    in: (ourBrokers as any[]).map((item) => item.id),
                  },
                },
              ]
            : []),
          ...((ourAgencies as any[]).length
            ? [
                {
                  targetType: "AGENCY",
                  targetId: {
                    in: (ourAgencies as any[]).map((item) => item.id),
                  },
                },
              ]
            : []),
        ],
      });
    }
    const [cases, total] = await Promise.all([
      this.prisma.loyaltyReconciliationCase.findMany({
        where,
        include: {
          person: {
            include: {
              sourceRecords: {
                where: {
                  snapshotId: active.snapshot.id,
                  sourceArchivedAt: null,
                },
                include: { contactPoints: true },
                take: 1,
              },
            },
          },
          organization: {
            include: {
              sourceRecords: {
                where: {
                  snapshotId: active.snapshot.id,
                  sourceArchivedAt: null,
                },
                include: { contactPoints: true },
                take: 1,
              },
            },
          },
        },
        orderBy: [{ status: "asc" }, { score: "desc" }, { createdAt: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.loyaltyReconciliationCase.count({ where }),
    ]);
    const brokerIds = (cases as any[])
      .filter((item) => item.targetType === "BROKER")
      .map((item) => item.targetId);
    const agencyIds = (cases as any[])
      .filter((item) => item.targetType === "AGENCY")
      .map((item) => item.targetId);
    const [brokers, agencies] = await Promise.all([
      brokerIds.length
        ? this.prisma.broker.findMany({
            where: { id: { in: brokerIds } },
            select: {
              id: true,
              fullName: true,
              phone: true,
              amoContactId: true,
            },
          })
        : [],
      agencyIds.length
        ? this.prisma.agency.findMany({
            where: { id: { in: agencyIds } },
            select: { id: true, name: true, inn: true, phone: true },
          })
        : [],
    ]);
    const targets = new Map<string, any>();
    for (const broker of brokers as any[])
      targets.set(`BROKER:${broker.id}`, {
        id: broker.id,
        entityType: "BROKER",
        displayName: broker.fullName,
        contact: maskContact("PHONE", broker.phone),
        amoContactId: broker.amoContactId ? String(broker.amoContactId) : null,
      });
    for (const agency of agencies as any[])
      targets.set(`AGENCY:${agency.id}`, {
        id: agency.id,
        entityType: "AGENCY",
        displayName: agency.name,
        taxId: agency.inn,
        contact: agency.phone ? maskContact("PHONE", agency.phone) : null,
      });
    const items = (cases as any[]).map((item) => {
      const source =
        item.person?.sourceRecords?.[0] ||
        item.organization?.sourceRecords?.[0];
      return {
        id: item.id,
        version: item.version,
        status: item.status,
        decision: item.decision,
        decisionReason: item.decisionReason || null,
        decisionPayload: item.decisionPayload || null,
        resolvedById: item.resolvedById || null,
        resolvedAt: item.resolvedAt || null,
        matchCodes: item.matchCodes,
        score: String(item.score),
        anna: source
          ? {
              id: item.personId || item.organizationId,
              entityType: source.entityType,
              displayName:
                item.person?.manualDisplayName ||
                item.organization?.manualDisplayName ||
                source.displayName,
              contacts: (source.contactPoints || []).map((point: any) => ({
                type: point.type,
                maskedValue: maskContact(point.type, point.value),
              })),
            }
          : null,
        ours: targets.get(`${item.targetType}:${item.targetId}`) || {
          id: item.targetId,
          entityType: item.targetType,
          missing: true,
        },
      };
    });
    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async activeLinks(query: LoyaltyReconciliationQueryDto) {
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    const active = await this.activeAnnaSnapshot();
    const snapshotId = active?.snapshot.id || "__no_active_snapshot__";
    const annaOwnerScope = {
      OR: [
        { person: { is: { dataset: { is: { code: ANNA_DATASET_CODE } } } } },
        {
          organization: {
            is: { dataset: { is: { code: ANNA_DATASET_CODE } } },
          },
        },
      ],
    };
    const where: any = {
      status: "CONFIRMED",
      revokedAt: null,
      ...annaOwnerScope,
    };
    if (query.entityType) where.targetType = query.entityType;
    const [links, total] = await Promise.all([
      this.prisma.loyaltyEntityLink.findMany({
        where,
        select: {
          id: true,
          version: true,
          personId: true,
          organizationId: true,
          targetType: true,
          targetId: true,
          reconciliationCaseId: true,
          decidedAt: true,
          ruleVersion: true,
          person: {
            select: {
              manualDisplayName: true,
              sourceRecords: {
                where: { snapshotId },
                select: { id: true, displayName: true },
                take: 1,
              },
            },
          },
          organization: {
            select: {
              manualDisplayName: true,
              sourceRecords: {
                where: { snapshotId },
                select: { id: true, displayName: true },
                take: 1,
              },
            },
          },
        },
        orderBy: [{ decidedAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.loyaltyEntityLink.count({ where }),
    ]);
    const brokerIds = (links as any[])
      .filter((link) => link.targetType === "BROKER")
      .map((link) => link.targetId);
    const agencyIds = (links as any[])
      .filter((link) => link.targetType === "AGENCY")
      .map((link) => link.targetId);
    const [brokers, agencies] = await Promise.all([
      brokerIds.length
        ? this.prisma.broker.findMany({
            where: { id: { in: brokerIds } },
            select: { id: true, fullName: true },
          })
        : [],
      agencyIds.length
        ? this.prisma.agency.findMany({
            where: { id: { in: agencyIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const targetNames = new Map<string, string>();
    for (const broker of brokers as any[])
      targetNames.set(`BROKER:${broker.id}`, broker.fullName);
    for (const agency of agencies as any[])
      targetNames.set(`AGENCY:${agency.id}`, agency.name);
    return {
      items: (links as any[]).map((link) => {
        const owner = link.person || link.organization;
        const source = owner?.sourceRecords?.[0];
        return {
          id: link.id,
          version: link.version,
          ownerType: link.personId ? "BROKER" : "AGENCY",
          ownerId: link.personId || link.organizationId,
          ownerName:
            owner?.manualDisplayName ||
            source?.displayName ||
            "Нет в активном снимке",
          targetType: link.targetType,
          targetId: link.targetId,
          targetName:
            targetNames.get(`${link.targetType}:${link.targetId}`) ||
            "Удалено из нашей базы",
          reconciliationCaseId: link.reconciliationCaseId,
          decidedAt: link.decidedAt,
          ruleVersion: link.ruleVersion,
          presentInActiveSnapshot: Boolean(source),
        };
      }),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async unlinkActiveLink(
    _dto: LoyaltyLinkUnlinkDto,
    _actorId?: string,
  ): Promise<never> {
    throw new GoneException({
      statusCode: 410,
      code: "LOYALTY_LEGACY_UNLINK_RETIRED",
      message:
        "Legacy orphan unlink is retired; use the case-bound reconciliation UNLINK decision",
    });
  }

  // "Есть только у Анны" — записи активного снимка без единого кандидата
  // сверки (см. findCandidates). Схема reconciliation_cases требует цель по
  // ту сторону, поэтому "нет пары" не хранится строкой, а вычисляется как
  // разница: у записи ноль связанных дел сверки в активном снимке.
  async unmatchedAnnaRecords(query: LoyaltyReconciliationQueryDto) {
    const active = await this.activeAnnaSnapshot();
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    if (!active) return { items: [], page, pageSize, total: 0, totalPages: 0 };
    const snapshotId = active.snapshot.id;
    const entityWhere = (entityType: EntityType): any => ({
      entityType,
      snapshotId,
      sourceArchivedAt: null,
      ...(entityType === "BROKER"
        ? {
            person: {
              is: {
                archivedAt: null,
                reconciliationCases: { none: { snapshotId } },
              },
            },
          }
        : {
            organization: {
              is: {
                archivedAt: null,
                reconciliationCases: { none: { snapshotId } },
              },
            },
          }),
    });
    const where: any = query.entityType
      ? entityWhere(query.entityType)
      : { OR: [entityWhere("BROKER"), entityWhere("AGENCY")] };
    const [records, total] = await Promise.all([
      this.prisma.loyaltySourceRecord.findMany({
        where,
        include: { contactPoints: true },
        orderBy: { displayName: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.loyaltySourceRecord.count({ where }),
    ]);
    return {
      items: (records as any[]).map((record) => ({
        id: record.personId || record.organizationId,
        entityType: record.entityType,
        displayName: record.displayName,
        city: record.city,
        hasValidPhone: (record.contactPoints || []).some(
          (point: any) => point.type === "PHONE",
        ),
        contacts: (record.contactPoints || []).map((point: any) => ({
          type: point.type,
          maskedValue: maskContact(point.type, point.value),
        })),
      })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // "Есть только в кабинете" — канонические Broker/Agency, на которых не
  // сослалось ни одно дело сверки активного снимка (т.е. Анна их не знает).
  async unmatchedCabinetEntities(query: LoyaltyReconciliationQueryDto) {
    const active = await this.activeAnnaSnapshot();
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    if (!active) return { items: [], page, pageSize, total: 0, totalPages: 0 };
    const snapshotId = active.snapshot.id;
    const matchedIdsFor = async (targetType: EntityType) => {
      const rows = await this.prisma.loyaltyReconciliationCase.findMany({
        where: { snapshotId, targetType },
        select: { targetId: true },
        distinct: ["targetId"],
      });
      return (rows as any[]).map((row) => row.targetId);
    };
    const wantBrokers = !query.entityType || query.entityType === "BROKER";
    const wantAgencies = !query.entityType || query.entityType === "AGENCY";
    const [matchedBrokerIds, matchedAgencyIds] = await Promise.all([
      wantBrokers ? matchedIdsFor("BROKER") : Promise.resolve([]),
      wantAgencies ? matchedIdsFor("AGENCY") : Promise.resolve([]),
    ]);
    const brokerWhere: any = {
      role: "BROKER",
      mergedIntoId: null,
      id: { notIn: matchedBrokerIds.length ? matchedBrokerIds : undefined },
    };
    const agencyWhere: any = {
      id: { notIn: matchedAgencyIds.length ? matchedAgencyIds : undefined },
    };
    const [brokerTotal, agencyTotal] = await Promise.all([
      wantBrokers ? this.prisma.broker.count({ where: brokerWhere }) : 0,
      wantAgencies ? this.prisma.agency.count({ where: agencyWhere }) : 0,
    ]);
    const total = brokerTotal + agencyTotal;
    const offset = (page - 1) * pageSize;
    const items: any[] = [];
    if (wantBrokers && offset < brokerTotal) {
      const brokers = await this.prisma.broker.findMany({
        where: brokerWhere,
        select: { id: true, fullName: true, phone: true, amoContactId: true },
        orderBy: { fullName: "asc" },
        skip: offset,
        take: pageSize,
      });
      items.push(
        ...(brokers as any[]).map((broker) => ({
          id: broker.id,
          entityType: "BROKER" as const,
          displayName: broker.fullName,
          contact: broker.phone ? maskContact("PHONE", broker.phone) : null,
          amoContactId: broker.amoContactId
            ? String(broker.amoContactId)
            : null,
        })),
      );
    }
    const remaining = pageSize - items.length;
    if (wantAgencies && remaining > 0) {
      const agencyOffset = Math.max(0, offset - brokerTotal);
      const agencies = await this.prisma.agency.findMany({
        where: agencyWhere,
        select: { id: true, name: true, inn: true, phone: true },
        orderBy: { name: "asc" },
        skip: agencyOffset,
        take: remaining,
      });
      items.push(
        ...(agencies as any[]).map((agency) => ({
          id: agency.id,
          entityType: "AGENCY" as const,
          displayName: agency.name,
          taxId: agency.inn,
          contact: agency.phone ? maskContact("PHONE", agency.phone) : null,
        })),
      );
    }
    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async decideReconciliation(
    dto: LoyaltyReconciliationDecisionDto,
    actorId?: string,
  ) {
    const current = await this.prisma.loyaltyReconciliationCase.findUnique({
      where: { id: dto.caseId },
    });
    if (!current) throw new NotFoundException("Reconciliation case not found");
    const active = await this.activeAnnaSnapshot();
    if (!active || current.snapshotId !== active.snapshot.id) {
      throw new ConflictException(
        "Reconciliation case belongs to a stale snapshot",
      );
    }
    if (current.version !== dto.expectedVersion)
      throw new ConflictException("Reconciliation case version changed");
    let fieldResolutions: Record<string, unknown> | null = null;
    if (dto.fieldResolutions) {
      const allowed = new Set(["displayName", "city", "attributes"]);
      const unknown = Object.keys(dto.fieldResolutions).filter(
        (key) => !allowed.has(key),
      );
      if (unknown.length) {
        throw new BadRequestException(
          `Unsupported field resolutions: ${unknown.join(", ")}`,
        );
      }
      fieldResolutions = sanitizeJson(dto.fieldResolutions);
    }
    if (dto.decision === "SUPPLEMENT") {
      if (!fieldResolutions || Object.keys(fieldResolutions).length === 0) {
        throw new BadRequestException(
          "SUPPLEMENT requires at least one field resolution",
        );
      }
      for (const key of ["displayName", "city"] as const) {
        if (fieldResolutions[key] !== undefined) {
          const value = fieldResolutions[key];
          const max = key === "displayName" ? 300 : 200;
          if (
            typeof value !== "string" ||
            !value.trim() ||
            value.trim().length > max
          ) {
            throw new BadRequestException(
              `SUPPLEMENT ${key} must be a non-empty string up to ${max} characters`,
            );
          }
          fieldResolutions[key] = value.trim();
        }
      }
      if (
        fieldResolutions.attributes !== undefined &&
        (!fieldResolutions.attributes ||
          typeof fieldResolutions.attributes !== "object" ||
          Array.isArray(fieldResolutions.attributes))
      ) {
        throw new BadRequestException(
          "SUPPLEMENT attributes must be an object",
        );
      }
    }
    const effectiveTargetId = dto.targetId || current.targetId;
    if (
      dto.decision === "UNLINK" &&
      dto.targetId &&
      dto.targetId !== current.targetId
    ) {
      throw new ConflictException(
        "UNLINK targetId must match the target recorded on the case",
      );
    }
    const decisionPayload = sanitizeJson({
      targetId: effectiveTargetId,
      fieldResolutions,
    });
    if (
      dto.decision === "UNLINK" &&
      !(
        current.status === "RESOLVED" &&
        ["LINK", "SUPPLEMENT"].includes(current.decision)
      )
    ) {
      throw new ConflictException(
        "Only a resolved link-bearing decision can be unlinked",
      );
    }
    if (dto.decision !== "UNLINK" && current.status !== "OPEN") {
      throw new ConflictException("Reconciliation case is already resolved");
    }
    await this.prisma.$transaction(
      async (tx: any) => {
        const activeDataset = await tx.loyaltyDataset.findUnique({
          where: { code: ANNA_DATASET_CODE },
          select: { id: true, activeSnapshotId: true },
        });
        if (
          !activeDataset ||
          activeDataset.activeSnapshotId !== current.snapshotId
        ) {
          throw new ConflictException(
            "Reconciliation case belongs to a stale snapshot",
          );
        }
        if (["LINK", "SUPPLEMENT"].includes(dto.decision)) {
          await this.assertActiveAnnaOwner(
            current,
            activeDataset.id,
            current.snapshotId,
            tx,
          );
          await this.assertOurTarget(
            current.targetType as EntityType,
            effectiveTargetId,
            tx,
          );
        }
        const locked = await tx.loyaltyReconciliationCase.updateMany({
          where: {
            id: current.id,
            version: dto.expectedVersion,
            snapshotId: current.snapshotId,
            ...(dto.decision === "UNLINK"
              ? {
                  status: "RESOLVED",
                  decision: { in: ["LINK", "SUPPLEMENT"] },
                }
              : { status: "OPEN" }),
          },
          data:
            dto.decision === "UNLINK"
              ? {
                  status: "OPEN",
                  decision: null,
                  decisionReason: null,
                  decisionPayload: null,
                  version: { increment: 1 },
                  resolvedById: null,
                  resolvedAt: null,
                }
              : {
                  status: "RESOLVED",
                  decision: dto.decision,
                  decisionReason: dto.reason,
                  decisionPayload,
                  ...(dto.targetId &&
                  ["LINK", "SUPPLEMENT"].includes(dto.decision)
                    ? { targetId: effectiveTargetId }
                    : {}),
                  version: { increment: 1 },
                  resolvedById: actorId || null,
                  resolvedAt: new Date(),
                },
        });
        if (locked.count !== 1)
          throw new ConflictException("Reconciliation case version changed");
        const ownerWhere = current.personId
          ? { personId: current.personId }
          : { organizationId: current.organizationId };
        if (!current.personId && !current.organizationId) {
          throw new ConflictException(
            "Reconciliation case has no Anna audit owner",
          );
        }
        await tx.loyaltyEntityChange.create({
          data: {
            ...ownerWhere,
            action: "UPDATE",
            changedFields: ["reconciliationDecision"],
            beforeValues: {
              caseId: current.id,
              status: current.status,
              decision: current.decision,
              reason: current.decisionReason || null,
              payload: current.decisionPayload || null,
              version: current.version,
            },
            afterValues: {
              caseId: current.id,
              status: dto.decision === "UNLINK" ? "OPEN" : "RESOLVED",
              decision: dto.decision === "UNLINK" ? null : dto.decision,
              transition: dto.decision,
              reason: dto.reason,
              payload: dto.decision === "UNLINK" ? null : decisionPayload,
              version: current.version + 1,
            },
            actorId: actorId || null,
          },
        });
        if (dto.decision === "UNLINK") {
          const revoked = await tx.loyaltyEntityLink.updateMany({
            where: {
              ...ownerWhere,
              status: "CONFIRMED",
              revokedAt: null,
              targetType: current.targetType,
              targetId: effectiveTargetId,
            },
            data: {
              status: "REVOKED",
              revokedAt: new Date(),
              revokedById: actorId || null,
            },
          });
          if (revoked.count === 0)
            throw new ConflictException("No active link to revoke");
          return;
        }
        if (dto.decision === "ARCHIVE") {
          const archivedAt = new Date();
          const stableDelegate = current.personId
            ? tx.loyaltyPerson
            : tx.loyaltyOrganization;
          const stableId = current.personId || current.organizationId;
          if (!stableId) {
            throw new ConflictException(
              "Reconciliation case has no Anna entity",
            );
          }
          const archived = await stableDelegate.updateMany({
            where: { id: stableId, archivedAt: null },
            data: { archivedAt },
          });
          if (archived.count !== 1) {
            throw new ConflictException("Anna entity is already archived");
          }
          await tx.loyaltyManualEntity.updateMany({
            where: ownerWhere,
            data: {
              archivedAt,
              version: { increment: 1 },
              updatedAt: archivedAt,
            },
          });
          await tx.loyaltyEntityLink.updateMany({
            where: { ...ownerWhere, status: "CONFIRMED", revokedAt: null },
            data: {
              status: "REVOKED",
              revokedAt: archivedAt,
              revokedById: actorId || null,
            },
          });
          const assignmentWhere = current.personId
            ? { annaPersonId: stableId }
            : { annaOrganizationId: stableId };
          const cancelledAssignments =
            await tx.loyaltyCallAssignment.updateMany({
              where: {
                ...assignmentWhere,
                status: { in: ["PENDING", "IN_PROGRESS"] },
              },
              data: {
                status: "CANCELLED",
                cancelledAt: archivedAt,
                version: { increment: 1 },
              },
            });
          await tx.loyaltyEntityChange.create({
            data: {
              ...ownerWhere,
              action: "ARCHIVE",
              changedFields: [
                "archivedAt",
                "reconciliationDecision",
                "openCallAssignments",
              ],
              beforeValues: {
                archivedAt: null,
                openCallAssignments: Number(cancelledAssignments?.count || 0),
              },
              afterValues: {
                archivedAt: archivedAt.toISOString(),
                caseId: current.id,
                reason: dto.reason,
                openCallAssignments: 0,
              },
              actorId: actorId || null,
              createdAt: archivedAt,
            },
          });
          return;
        }
        if (!["LINK", "SUPPLEMENT"].includes(dto.decision)) {
          return;
        }
        const existingLink = await tx.loyaltyEntityLink.findFirst({
          where: { ...ownerWhere, status: "CONFIRMED", revokedAt: null },
        });
        if (existingLink) {
          if (
            existingLink.targetType !== current.targetType ||
            existingLink.targetId !== effectiveTargetId
          ) {
            throw new ConflictException(
              "An active link already exists; unlink it before linking another target",
            );
          }
        }
        if (dto.decision === "SUPPLEMENT") {
          const stableDelegate = current.personId
            ? tx.loyaltyPerson
            : tx.loyaltyOrganization;
          const stableId = current.personId || current.organizationId;
          if (!stableId) {
            throw new ConflictException(
              "Reconciliation case has no Anna entity",
            );
          }
          const before = await stableDelegate.findUnique({
            where: { id: stableId },
            select: {
              manualDisplayName: true,
              manualCity: true,
              manualAttributes: true,
            },
          });
          if (!before) {
            throw new ConflictException("Anna entity no longer exists");
          }
          const nextAttributes = fieldResolutions?.attributes
            ? {
                ...((before.manualAttributes as Record<string, unknown>) || {}),
                ...(fieldResolutions.attributes as Record<string, unknown>),
              }
            : before.manualAttributes;
          const stableData: Record<string, unknown> = {
            ...(fieldResolutions?.displayName !== undefined
              ? { manualDisplayName: fieldResolutions.displayName }
              : {}),
            ...(fieldResolutions?.city !== undefined
              ? { manualCity: fieldResolutions.city }
              : {}),
            ...(fieldResolutions?.attributes !== undefined
              ? { manualAttributes: nextAttributes }
              : {}),
          };
          await stableDelegate.update({
            where: { id: stableId },
            data: stableData,
          });
          await tx.loyaltyManualEntity.updateMany({
            where: ownerWhere,
            data: {
              ...(fieldResolutions?.displayName !== undefined
                ? { displayName: fieldResolutions.displayName }
                : {}),
              ...(fieldResolutions?.city !== undefined
                ? { city: fieldResolutions.city }
                : {}),
              ...(fieldResolutions?.attributes !== undefined
                ? { attributes: nextAttributes }
                : {}),
              version: { increment: 1 },
              updatedAt: new Date(),
            },
          });
          await tx.loyaltyEntityChange.create({
            data: {
              ...ownerWhere,
              action: "UPDATE",
              changedFields: Object.keys(fieldResolutions || {}).map(
                (key) => `reconciliation.${key}`,
              ),
              beforeValues: {
                displayName: before.manualDisplayName,
                city: before.manualCity,
                attributes: before.manualAttributes,
              },
              afterValues: {
                displayName:
                  stableData.manualDisplayName ?? before.manualDisplayName,
                city: stableData.manualCity ?? before.manualCity,
                attributes: nextAttributes,
                caseId: current.id,
              },
              actorId: actorId || null,
              createdAt: new Date(),
            },
          });
        }
        if (existingLink) {
          // The stable association may have been created by the previous
          // snapshot's case. Resolving the current same-target case is
          // idempotent; a subsequent current-case UNLINK matches owner+target.
          return;
        }
        await tx.loyaltyEntityLink.create({
          data: {
            ...ownerWhere,
            targetType: current.targetType,
            targetId: effectiveTargetId,
            status: "CONFIRMED",
            reconciliationCaseId: current.id,
            evidence: {
              matchCodes: current.matchCodes,
              decision: dto.decision,
              fieldResolutions,
            },
            ruleVersion: current.ruleVersion,
            createdById: actorId || null,
            decidedById: actorId || null,
            decidedAt: new Date(),
          },
        });
      },
      { isolationLevel: "Serializable" as any },
    );
    return this.prisma.loyaltyReconciliationCase.findUnique({
      where: { id: current.id },
    });
  }

  private async assertOurTarget(
    type: EntityType,
    id: string,
    db: any = this.prisma,
  ) {
    if (type === "BROKER") {
      const broker = await db.broker.findUnique({
        where: { id },
        select: {
          id: true,
          role: true,
          status: true,
          source: true,
          mergedIntoId: true,
        },
      });
      if (
        !broker ||
        broker.role !== "BROKER" ||
        broker.status === "BLOCKED" ||
        broker.source === "CLOSED_AS_BROKER" ||
        broker.mergedIntoId !== null
      ) {
        throw new ConflictException(
          "Target OUR broker is no longer eligible for reconciliation",
        );
      }
      return;
    }
    const agency = await db.agency.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!agency) {
      throw new ConflictException("Target OUR agency no longer exists");
    }
  }

  private async assertActiveAnnaOwner(
    reconciliationCase: any,
    datasetId: string,
    snapshotId: string,
    db: any,
  ) {
    const isBroker = reconciliationCase.targetType === "BROKER";
    const ownerId = isBroker
      ? reconciliationCase.personId
      : reconciliationCase.organizationId;
    if (
      !ownerId ||
      (isBroker && reconciliationCase.organizationId) ||
      (!isBroker && reconciliationCase.personId)
    ) {
      throw new ConflictException(
        "Reconciliation case has no valid Anna audit owner",
      );
    }
    const ownerWhere = isBroker
      ? {
          personId: ownerId,
          person: { is: { archivedAt: null } },
        }
      : {
          organizationId: ownerId,
          organization: { is: { archivedAt: null } },
        };
    const [sourceRecord, manualEntity] = await Promise.all([
      db.loyaltySourceRecord.findFirst({
        where: {
          snapshotId,
          entityType: reconciliationCase.targetType,
          sourceArchivedAt: null,
          ...ownerWhere,
        },
        select: { id: true },
      }),
      db.loyaltyManualEntity.findFirst({
        where: {
          datasetId,
          entityType: reconciliationCase.targetType,
          archivedAt: null,
          ...ownerWhere,
        },
        select: { id: true },
      }),
    ]);
    if (!sourceRecord && !manualEntity) {
      throw new ConflictException(
        "Anna source/manual entity is no longer active",
      );
    }
  }
}
