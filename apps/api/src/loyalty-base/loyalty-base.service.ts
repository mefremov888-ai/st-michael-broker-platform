import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { PrismaClient } from "@st-michael/database";
import {
  LoyaltyEntityUpdateDto,
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

const ANNA_DATASET_CODE = "ANNA";
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_ISSUES_RETURNED = 200;
const MAX_POSTGRES_BIGINT = 9223372036854775807n;
const MAX_DECIMAL_18_2_CENTS = 999999999999999999n;
const CANDIDATE_QUERY_BATCH_SIZE = 500;

type EntityType = "BROKER" | "AGENCY";
type BaseSlug = "anna" | "ours";

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
  rowFingerprint: string;
}

interface MatchCandidate {
  recordExternalKey: string;
  targetType: EntityType;
  targetId: string;
  matchCodes: string[];
  score: string;
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
  const match = value.trim().match(/^(\d{2})\.(\d{2})(?:\.|$)/);
  return match ? `${match[1]}.${match[2]}` : null;
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

  private prepareImport(dto: LoyaltyImportDto): PreparedImport {
    if (Buffer.byteLength(JSON.stringify(dto), "utf8") > MAX_IMPORT_BYTES) {
      throw new BadRequestException("Import document exceeds 10 MB");
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

    const hashDocument = {
      ruleVersion: dto.ruleVersion,
      expectedRecords: dto.expectedRecords ?? null,
      expectedUniquePhones: dto.expectedUniquePhones ?? null,
      expectedActivities: dto.expectedActivities ?? null,
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
      activities: prepared.reduce(
        (sum, record) => sum + record.activities.length,
        0,
      ),
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
    const rememberBrokers = (rows: any[]) => {
      for (const broker of rows) brokerById.set(broker.id, broker);
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
      for (const agency of rows as any[]) agencyById.set(agency.id, agency);
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

  async dryRunImport(dto: LoyaltyImportDto) {
    const prepared = this.prepareImport(dto);
    const [candidates, coverage] = await Promise.all([
      prepared.issueCount === 0
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
      publishable: prepared.issueCount === 0,
      status: prepared.issueCount === 0 ? "VALID" : "INVALID",
      summary: {
        ...prepared.summary,
        issueCount: prepared.issueCount,
        candidateCount: candidates.length,
        ambiguousRecords: Array.from(candidateCounts.values()).filter(
          (count) => count > 1,
        ).length,
        currentPublishedRecords: coverage.currentPublishedRecords,
        coverageDropRequiresConfirmation: coverage.requiresConfirmation,
        coverageDrops: coverage.droppedDimensions,
      },
      issues: prepared.issues,
    };
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
      includedActivities: summary.includedActivities,
      includedFixations: summary.includedFixations,
      includedMeetings: summary.includedMeetings,
      includedDeals: summary.includedDeals,
      includedBrokerTours: summary.includedBrokerTours,
      includedCalls: summary.includedCalls,
      includedDealAmount: summary.includedDealAmount,
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
      includedActivities: Number(summary.includedActivities || 0),
      includedFixations: Number(summary.includedFixations || 0),
      includedMeetings: Number(summary.includedMeetings || 0),
      includedDeals: Number(summary.includedDeals || 0),
      includedBrokerTours: Number(summary.includedBrokerTours || 0),
      includedCalls: Number(summary.includedCalls || 0),
      includedDealAmount: String(summary.includedDealAmount || "0.00"),
    };
  }

  private coverageDrops(
    current: Record<string, number | string>,
    next: Record<string, number | string>,
  ) {
    const lower = (dimension: string) =>
      dimension === "includedDealAmount"
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

  async stageImport(dto: LoyaltyImportDto, actorId?: string) {
    const prepared = this.prepareImport(dto);
    if (prepared.issueCount > 0) {
      throw new BadRequestException({
        message: "Import document has validation issues",
        issueCount: prepared.issueCount,
        issues: prepared.issues,
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
            dealAmount: centsToMoney(dealAmountCents),
          });
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
        const actualCount = await tx.loyaltySourceRecord.count({
          where: { snapshotId },
        });
        if (actualCount !== snapshot.recordCount)
          throw new ConflictException("Snapshot record count is incomplete");
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
    const currentMonth = { ...moscowCurrentMonthRange(), to: new Date() };
    const [
      brokerTotal,
      agencyTotal,
      fixations,
      meetings,
      deals,
      dealAmount,
      notCalled,
      newCount,
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
      this.prisma.loyaltySourceRecord.count({
        where: {
          ...currentWhere("BROKER"),
          activities: {
            none: {
              type: "CALL",
              occurredAt: { gte: currentMonth.from, lte: currentMonth.to },
              verdict: "INCLUDED",
            },
          },
        },
      }),
      this.prisma.loyaltySourceRecord.count({
        where: {
          ...currentWhere("BROKER"),
          AND: [this.annaNewStageFilter()],
          activities: {
            none: {
              type: { in: ["BROKER_TOUR", "FIXATION", "MEETING", "DEAL"] },
              verdict: "INCLUDED",
            },
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
    const knownBirthdays = (birthdayRows as any[])
      .map((row) => annaBirthday(row.attributes))
      .filter(Boolean) as string[];
    const birthdaysToday = knownBirthdays.length
      ? knownBirthdays.filter(
          (birthday) => birthday === moscowDateParts().dayMonth,
        ).length
      : null;
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
    const confirmedDeals = this.ourConfirmedDealWhere(period);
    const acceptedMeetings: any = {
      status: { in: ["CONFIRMED", "COMPLETED"] },
      date: { gte: period.from, lte: period.to },
    };
    const [
      brokerTotal,
      agencyTotal,
      fixations,
      meetings,
      deals,
      dealAmount,
      notCalled,
      newCount,
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
          fixationStatus: "FIXED",
          createdAt: { gte: period.from, lte: period.to },
        },
      }),
      this.prisma.meeting.count({ where: acceptedMeetings }),
      this.prisma.deal.count({ where: confirmedDeals }),
      this.prisma.deal.aggregate({
        where: confirmedDeals,
        _sum: { amount: true },
      }),
      this.prisma.broker.count({
        where: {
          role: "BROKER",
          mergedIntoId: null,
          callLogs: {
            none: {
              createdAt: { gte: currentMonth.from, lte: currentMonth.to },
            },
          },
        },
      }),
      this.prisma.broker.count({
        where: {
          role: "BROKER",
          mergedIntoId: null,
          funnelStage: "NEW_BROKER",
          brokerTourVisited: false,
          brokerTourDate: null,
          clients: { none: { fixationStatus: "FIXED" } },
          meetings: { none: { status: { in: ["CONFIRMED", "COMPLETED"] } } },
          deals: { none: this.ourConfirmedDealWhere() },
        },
      }),
      this.prisma.broker.count({
        where: {
          role: "BROKER",
          mergedIntoId: null,
          brokerTourVisited: true,
          clients: { none: { fixationStatus: "FIXED" } },
        },
      }),
      this.prisma.broker.findMany({
        where: { role: "BROKER", mergedIntoId: null, birthDate: { not: null } },
        select: { birthDate: true },
      }),
      this.oursDealLeaders("BROKER", period),
      this.oursDealLeaders("AGENCY", period),
    ]);
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
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
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
      activities: { fixations, meetings, deals },
      dealAmount: String(dealAmount._sum.amount || "0"),
    };
  }

  private async oursDealLeaders(
    entityType: EntityType,
    period: { from: Date; to: Date },
  ) {
    const groupField = entityType === "BROKER" ? "brokerId" : "agencyId";
    const groups = await (this.prisma.deal as any).groupBy({
      by: [groupField],
      where: {
        ...this.ourConfirmedDealWhere(period),
        ...(entityType === "AGENCY"
          ? { agencyId: { not: null } }
          : { broker: { is: { role: "BROKER", mergedIntoId: null } } }),
      },
      _count: { [groupField]: true },
      _sum: { amount: true },
      _max: { signedAt: true },
      orderBy: [
        { _count: { [groupField]: "desc" } },
        { _sum: { amount: "desc" } },
        { _max: { signedAt: "desc" } },
        { [groupField]: "asc" },
      ],
      take: 5,
    });
    const ids = groups.map((group: any) => group[groupField]).filter(Boolean);
    if (!ids.length) return [];
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
    return groups.map((group: any) => ({
      id: group[groupField],
      name: names.get(group[groupField]) || "—",
      entityType,
      deals: Number(group._count?.[groupField] || 0),
      dealAmount: String(group._sum?.amount || "0"),
      latestDealAt: group._max?.signedAt || null,
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
    };
  }

  async list(
    baseInput: string,
    entityType: EntityType,
    query: LoyaltyListQueryDto,
    search?: string,
  ) {
    const base = this.parseBase(baseInput);
    return base === "anna"
      ? this.listAnna(entityType, query, search)
      : this.listOurs(entityType, query, search);
  }

  async search(base: string, entityType: EntityType, dto: LoyaltySearchDto) {
    const normalized = Object.assign(
      new LoyaltyListQueryDto(),
      dto,
      dto.filters || {},
    );
    return this.list(base, entityType, normalized, dto.search.trim());
  }

  private async listAnna(
    entityType: EntityType,
    query: LoyaltyListQueryDto,
    search?: string,
  ) {
    const active = await this.activeAnnaSnapshot();
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    if (!active)
      return {
        base: "anna",
        entityType,
        items: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
      };
    const relationName = entityType === "BROKER" ? "person" : "organization";
    const where: any = { snapshotId: active.snapshot.id, entityType };
    if (query.archived === "exclude") {
      where.sourceArchivedAt = null;
      where[relationName] = { is: { archivedAt: null } };
    } else if (query.archived === "only") {
      where.OR = [
        { sourceArchivedAt: { not: null } },
        { [relationName]: { is: { archivedAt: { not: null } } } },
      ];
    }
    if (query.city) where.city = { equals: query.city, mode: "insensitive" };
    if (query.hasAmo !== undefined) {
      where.externalIdentities = query.hasAmo
        ? { some: { system: "AMOCRM" } }
        : { none: { system: "AMOCRM" } };
    }
    if (query.activityType)
      where.activities = {
        some: { type: query.activityType, verdict: "INCLUDED" },
      };
    if (entityType === "BROKER" && query.segment) {
      const currentMonth = { ...moscowCurrentMonthRange(), to: new Date() };
      const segmentFilter: any =
        query.segment === "NOT_CALLED_CURRENT_MONTH"
          ? {
              activities: {
                none: {
                  type: "CALL",
                  occurredAt: { gte: currentMonth.from, lte: currentMonth.to },
                  verdict: "INCLUDED",
                },
              },
            }
          : query.segment === "NEW_BROKER"
            ? {
                AND: [this.annaNewStageFilter()],
                activities: {
                  none: {
                    type: {
                      in: ["BROKER_TOUR", "FIXATION", "MEETING", "DEAL"],
                    },
                    verdict: "INCLUDED",
                  },
                },
              }
            : query.segment === "BT_WITHOUT_FIXATION"
              ? {
                  activities: {
                    some: { type: "BROKER_TOUR", verdict: "INCLUDED" },
                    none: { type: "FIXATION", verdict: "INCLUDED" },
                  },
                }
              : {
                  id: {
                    in: await this.annaBirthdayRecordIds(active.snapshot.id),
                  },
                };
      where.AND = [...(where.AND || []), segmentFilter];
    }
    if (search) {
      const normalizedPhone = normalizeLoyaltyContactPoint("PHONE", search);
      const searchOr: any[] = [
        { displayName: { contains: search, mode: "insensitive" } },
        { city: { contains: search, mode: "insensitive" } },
        { taxId: { contains: search } },
        {
          [relationName]: {
            is: {
              manualDisplayName: { contains: search, mode: "insensitive" },
            },
          },
        },
      ];
      if (normalizedPhone)
        searchOr.push({
          contactPoints: {
            some: { type: "PHONE", normalizedValue: normalizedPhone },
          },
        });
      else
        searchOr.push({
          contactPoints: {
            some: { normalizedValue: { contains: search.toLowerCase() } },
          },
        });
      where.AND = [...(where.AND || []), { OR: searchOr }];
    }
    const include = this.annaRecordInclude(active.snapshot.id, false);
    const [records, total] = await Promise.all([
      this.prisma.loyaltySourceRecord.findMany({
        where,
        include,
        orderBy: [{ displayName: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.loyaltySourceRecord.count({ where }),
    ]);
    return {
      base: "anna",
      entityType,
      items: (records as any[]).map((record) =>
        this.mapAnnaRecord(record, false),
      ),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  private annaRecordInclude(snapshotId: string, detailed: boolean): any {
    return {
      person: {
        include: {
          links: {
            where: { status: "CONFIRMED", revokedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
      organization: {
        include: {
          links: {
            where: { status: "CONFIRMED", revokedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
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
      metrics: { orderBy: { calculatedAt: "desc" }, take: 1 },
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

  private mapAnnaRecord(record: any, detailed: boolean) {
    const entity = record.person || record.organization;
    const metric = record.metrics?.[0] || {};
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
      contactPoints: (record.contactPoints || []).map((point: any) => ({
        id: point.id,
        type: point.type,
        value: point.value,
        maskedValue: maskContact(point.type, point.value),
        label: point.label,
        isPrimary: point.isPrimary,
      })),
      externalIdentities: record.externalIdentities || [],
      metrics: {
        fixations: Number(metric.fixationCount || 0),
        meetings: Number(metric.meetingCount || 0),
        deals: Number(metric.dealCount || 0),
        brokerTours: Number(metric.brokerTourCount || 0),
        calls: Number(metric.callCount || 0),
        dealAmount: String(metric.dealAmount || "0"),
        ruleVersion: metric.ruleVersion || null,
      },
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
    if (detailed) {
      result.activities = record.activities || [];
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

  private async listOurs(
    entityType: EntityType,
    query: LoyaltyListQueryDto,
    search?: string,
  ) {
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    if (entityType === "BROKER") {
      const where: any = { role: "BROKER" };
      if (query.archived === "exclude") where.mergedIntoId = null;
      if (query.archived === "only") where.mergedIntoId = { not: null };
      if (query.city) {
        const city = query.city.trim().toLowerCase();
        if (city === "москва" || city === "msk") where.region = "MSK";
        else if (city === "санкт-петербург" || city === "спб" || city === "spb")
          where.region = "SPB";
        else if (city === "регион") where.isRegional = true;
        else where.region = { equals: query.city, mode: "insensitive" };
      }
      if (query.hasAmo !== undefined)
        where.amoContactId = query.hasAmo ? { not: null } : null;
      if (query.activityType)
        Object.assign(where, this.ourBrokerActivityFilter(query.activityType));
      if (query.segment === "NOT_CALLED_CURRENT_MONTH") {
        const currentMonth = { ...moscowCurrentMonthRange(), to: new Date() };
        where.callLogs = {
          none: { createdAt: { gte: currentMonth.from, lte: currentMonth.to } },
        };
      } else if (query.segment === "NEW_BROKER") {
        Object.assign(where, {
          funnelStage: "NEW_BROKER",
          brokerTourVisited: false,
          brokerTourDate: null,
          clients: { none: { fixationStatus: "FIXED" } },
          meetings: { none: { status: { in: ["CONFIRMED", "COMPLETED"] } } },
          deals: { none: this.ourConfirmedDealWhere() },
        });
      } else if (query.segment === "BT_WITHOUT_FIXATION") {
        Object.assign(where, {
          brokerTourVisited: true,
          clients: { none: { fixationStatus: "FIXED" } },
        });
      } else if (query.segment === "BIRTHDAY_TODAY") {
        where.id = { in: await this.ourBirthdayBrokerIds() };
      }
      if (search) {
        const normalizedPhone = normalizeLoyaltyContactPoint("PHONE", search);
        where.OR = [
          { fullName: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          ...(normalizedPhone
            ? [
                { phone: normalizedPhone },
                { phones: { some: { phone: normalizedPhone } } },
              ]
            : []),
        ];
      }
      const [items, total] = await Promise.all([
        this.prisma.broker.findMany({
          where,
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
            region: true,
            category: true,
            amoContactId: true,
            mergedIntoId: true,
            phones: true,
            brokerAgencies: { include: { agency: true } },
            _count: {
              select: {
                clients: { where: { fixationStatus: "FIXED" } },
                deals: { where: this.ourConfirmedDealWhere() },
                meetings: {
                  where: { status: { in: ["CONFIRMED", "COMPLETED"] } },
                },
                calls: true,
              },
            },
          },
          orderBy: [{ fullName: "asc" }, { id: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.broker.count({ where }),
      ]);
      const dealGroups = items.length
        ? await (this.prisma.deal as any).groupBy({
            by: ["brokerId"],
            where: {
              ...this.ourConfirmedDealWhere(),
              brokerId: { in: items.map((item) => item.id) },
            },
            _sum: { amount: true },
          })
        : [];
      const dealAmountById = new Map<string, string>(
        dealGroups.map((group: any) => [
          group.brokerId,
          String(group._sum?.amount || "0"),
        ]),
      );
      return {
        base: "ours",
        entityType,
        items: items.map((item: any) =>
          this.mapOurBroker(item, dealAmountById.get(item.id) || "0"),
        ),
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      };
    }
    const where: any = {};
    if (query.archived === "only" || query.hasAmo === true)
      where.id = { in: [] };
    const and: any[] = [];
    if (query.city)
      and.push({
        OR: [
          { address: { contains: query.city, mode: "insensitive" } },
          { legalAddress: { contains: query.city, mode: "insensitive" } },
        ],
      });
    if (query.activityType === "DEAL")
      where.deals = { some: this.ourConfirmedDealWhere() };
    else if (query.activityType) {
      where.brokerAgencies = {
        some: { broker: this.ourBrokerActivityFilter(query.activityType) },
      };
    }
    if (search)
      and.push({
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { legalName: { contains: search, mode: "insensitive" } },
          { inn: { contains: search } },
          { phone: { contains: search } },
          { email: { contains: search, mode: "insensitive" } },
        ],
      });
    if (and.length) where.AND = and;
    const [items, total] = await Promise.all([
      this.prisma.agency.findMany({
        where,
        include: {
          _count: {
            select: {
              brokerAgencies: true,
              deals: { where: this.ourConfirmedDealWhere() },
            },
          },
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.agency.count({ where }),
    ]);
    const dealGroups = items.length
      ? await (this.prisma.deal as any).groupBy({
          by: ["agencyId"],
          where: {
            ...this.ourConfirmedDealWhere(),
            agencyId: { in: items.map((item) => item.id) },
          },
          _sum: { amount: true },
        })
      : [];
    const dealAmountById = new Map<string, string>(
      dealGroups.map((group: any) => [
        group.agencyId,
        String(group._sum?.amount || "0"),
      ]),
    );
    return {
      base: "ours",
      entityType,
      items: items.map((item: any) =>
        this.mapOurAgency(item, dealAmountById.get(item.id) || "0"),
      ),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  private ourBrokerActivityFilter(type: string): any {
    if (type === "FIXATION")
      return { clients: { some: { fixationStatus: "FIXED" } } };
    if (type === "MEETING")
      return {
        meetings: { some: { status: { in: ["CONFIRMED", "COMPLETED"] } } },
      };
    if (type === "DEAL")
      return { deals: { some: this.ourConfirmedDealWhere() } };
    if (type === "BROKER_TOUR") return { brokerTourVisited: true };
    if (type === "CALL") return { calls: { some: {} } };
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

  private mapOurBroker(item: any, dealAmount: string | null = null) {
    return {
      id: item.id,
      entityType: "BROKER",
      displayName: item.fullName,
      city: item.region,
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
      metrics: {
        fixations: item._count?.clients || 0,
        deals: item._count?.deals || 0,
        meetings: item._count?.meetings || 0,
        calls: item._count?.calls || 0,
        dealAmount,
      },
      category: item.category,
    };
  }

  private mapOurAgency(item: any, dealAmount: string | null = null) {
    return {
      id: item.id,
      entityType: "AGENCY",
      displayName: item.name,
      legalName: item.legalName,
      taxId: item.inn,
      city: null,
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
      ...(Array.isArray(item.brokerAgencies)
        ? {
            brokers: item.brokerAgencies.map((relation: any) => ({
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
        brokers: item._count?.brokerAgencies || 0,
        deals: item._count?.deals || 0,
        dealAmount,
      },
    };
  }

  async detail(baseInput: string, entityType: EntityType, id: string) {
    const base = this.parseBase(baseInput);
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
        include: this.annaRecordInclude(active.snapshot.id, true),
      });
      if (!record) throw new NotFoundException("Loyalty entity not found");
      return {
        base: "anna",
        entityType,
        item: this.mapAnnaRecord(record as any, true),
      };
    }
    if (entityType === "BROKER") {
      const broker = await this.prisma.broker.findUnique({
        where: { id },
        include: {
          phones: true,
          brokerAgencies: { include: { agency: true } },
          _count: {
            select: {
              clients: { where: { fixationStatus: "FIXED" } },
              deals: { where: this.ourConfirmedDealWhere() },
              meetings: {
                where: { status: { in: ["CONFIRMED", "COMPLETED"] } },
              },
              calls: true,
            },
          },
        },
      });
      if (!broker) throw new NotFoundException("Broker not found");
      const dealAmount = await this.prisma.deal.aggregate({
        where: { ...this.ourConfirmedDealWhere(), brokerId: id },
        _sum: { amount: true },
      });
      return {
        base: "ours",
        entityType,
        item: this.mapOurBroker(broker, String(dealAmount._sum.amount || "0")),
      };
    }
    const agency = await this.prisma.agency.findUnique({
      where: { id },
      include: {
        brokerAgencies: {
          include: {
            broker: {
              select: { id: true, fullName: true, phone: true, email: true },
            },
          },
        },
        _count: {
          select: {
            brokerAgencies: true,
            deals: { where: this.ourConfirmedDealWhere() },
          },
        },
      },
    });
    if (!agency) throw new NotFoundException("Agency not found");
    const dealAmount = await this.prisma.deal.aggregate({
      where: { ...this.ourConfirmedDealWhere(), agencyId: id },
      _sum: { amount: true },
    });
    return {
      base: "ours",
      entityType,
      item: this.mapOurAgency(agency, String(dealAmount._sum.amount || "0")),
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
        if (!record) throw new NotFoundException("Loyalty entity not found");
        const entity: any = record.person || record.organization;
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
        const updateResult =
          entityType === "BROKER"
            ? await tx.loyaltyPerson.updateMany({
                where: { id, updatedAt: expectedUpdatedAt },
                data,
              })
            : await tx.loyaltyOrganization.updateMany({
                where: { id, updatedAt: expectedUpdatedAt },
                data,
              });
        if (updateResult.count !== 1) {
          throw new ConflictException(
            "Loyalty entity changed; reload it before retrying",
          );
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
        const provenanceRecords = await tx.loyaltySourceRecord.findMany({
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

  async unlinkActiveLink(dto: LoyaltyLinkUnlinkDto, actorId?: string) {
    return this.prisma.$transaction(
      async (tx: any) => {
        const revokedAt = new Date();
        const result = await tx.loyaltyEntityLink.updateMany({
          where: {
            id: dto.linkId,
            version: dto.expectedVersion,
            status: "CONFIRMED",
            revokedAt: null,
            OR: [
              {
                person: {
                  is: { dataset: { is: { code: ANNA_DATASET_CODE } } },
                },
              },
              {
                organization: {
                  is: { dataset: { is: { code: ANNA_DATASET_CODE } } },
                },
              },
            ],
          },
          data: {
            status: "REVOKED",
            revokedAt,
            revokedById: actorId || null,
            version: { increment: 1 },
          },
        });
        if (result.count !== 1) {
          throw new ConflictException(
            "Active link version changed or link is already revoked",
          );
        }
        return tx.loyaltyEntityLink.findUnique({ where: { id: dto.linkId } });
      },
      { isolationLevel: "Serializable" as any },
    );
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
    if (
      dto.decision === "UNLINK" &&
      !(current.status === "RESOLVED" && current.decision === "LINK")
    ) {
      throw new ConflictException(
        "Only a resolved LINK decision can be unlinked",
      );
    }
    if (dto.decision !== "UNLINK" && current.status !== "OPEN") {
      throw new ConflictException("Reconciliation case is already resolved");
    }
    await this.prisma.$transaction(
      async (tx: any) => {
        const activeDataset = await tx.loyaltyDataset.findUnique({
          where: { code: ANNA_DATASET_CODE },
          select: { activeSnapshotId: true },
        });
        if (activeDataset?.activeSnapshotId !== current.snapshotId) {
          throw new ConflictException(
            "Reconciliation case belongs to a stale snapshot",
          );
        }
        if (dto.decision === "LINK") {
          await this.assertOurTarget(
            current.targetType as EntityType,
            current.targetId,
            tx,
          );
        }
        const locked = await tx.loyaltyReconciliationCase.updateMany({
          where: {
            id: current.id,
            version: dto.expectedVersion,
            snapshotId: current.snapshotId,
            ...(dto.decision === "UNLINK"
              ? { status: "RESOLVED", decision: "LINK" }
              : { status: "OPEN" }),
          },
          data: {
            status: "RESOLVED",
            decision: dto.decision,
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
        if (dto.decision === "UNLINK") {
          const revoked = await tx.loyaltyEntityLink.updateMany({
            where: {
              ...ownerWhere,
              status: "CONFIRMED",
              revokedAt: null,
              targetType: current.targetType,
              targetId: current.targetId,
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
        if (dto.decision !== "LINK") {
          return;
        }
        const existingLink = await tx.loyaltyEntityLink.findFirst({
          where: { ...ownerWhere, status: "CONFIRMED", revokedAt: null },
        });
        if (existingLink) {
          if (
            existingLink.targetType !== current.targetType ||
            existingLink.targetId !== current.targetId
          ) {
            throw new ConflictException(
              "An active link already exists; unlink it before linking another target",
            );
          }
          // The stable association may have been created by the previous
          // snapshot's case. Resolving the current same-target case is
          // idempotent; a subsequent current-case UNLINK matches owner+target.
          return;
        }
        await tx.loyaltyEntityLink.create({
          data: {
            ...ownerWhere,
            targetType: current.targetType,
            targetId: current.targetId,
            status: "CONFIRMED",
            reconciliationCaseId: current.id,
            evidence: { matchCodes: current.matchCodes },
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
    const exists =
      type === "BROKER"
        ? await db.broker.findUnique({ where: { id }, select: { id: true } })
        : await db.agency.findUnique({ where: { id }, select: { id: true } });
    if (!exists)
      throw new ConflictException("Target OUR entity no longer exists");
  }
}
