import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { createHash } from "crypto";
import type { PrismaClient } from "@st-michael/database";
import type { CurrentUserPayload } from "../auth/current-user.decorator";
import { LoyaltyReconciliationDecisionDto } from "../loyalty-base/loyalty-base.dto";
import {
  LoyaltyBaseService,
  normalizeLoyaltyContactPoint,
} from "../loyalty-base/loyalty-base.service";
import { withLoyaltyFullScanSlot } from "../loyalty-base/loyalty-full-scan-coordinator";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";
import {
  LOYALTY_RECONCILIATION_GROUPS,
  LoyaltyReconciliationCoverageQueryDto,
  LoyaltyReconciliationGroup,
  LoyaltyReconciliationGroupExportDto,
  LoyaltyReconciliationGroupSearchDto,
  LoyaltyReconciliationV2DecisionDto,
} from "./loyalty-reconciliation-v2.dto";
import {
  ReconciliationBase,
  ReconciliationEntityType,
  ReconciliationGroupRow,
  ReconciliationParty,
  ReconciliationUniverse,
} from "./loyalty-reconciliation-v2.types";

const ANNA_DATASET_CODE = "ANNA";
const RECONCILIATION_V2_RULE_VERSION = "loyalty-reconciliation-v2";

interface EntityInfo {
  key: string;
  ownerKey: string;
  party: ReconciliationParty;
  searchable: string;
  phones: Set<string>;
  agencyNames: Set<string>;
  excludedReasons: Set<string>;
  linkSupplementEligible: boolean;
}

interface PairInfo {
  reconciliationCase: any;
  anna: EntityInfo | null;
  ours: EntityInfo | null;
  sharedPhones: string[];
  conflictReasons: string[];
}

interface MaterializedCaseSpec {
  identity: string;
  id: string;
  datasetId: string;
  snapshotId: string;
  personId: string | null;
  organizationId: string | null;
  targetType: ReconciliationEntityType;
  targetId: string;
  kind: "PAIR" | "ANNA_ENTITY" | "OURS_ENTITY";
  categories: Set<LoyaltyReconciliationGroup>;
  matchCodes: Set<string>;
  reasons: Set<string>;
}

export const RECONCILIATION_GROUP_DEFINITIONS: Record<
  LoyaltyReconciliationGroup,
  { label: string; calculation: string; paired: boolean }
> = {
  PHONE_MATCHED: {
    label: "Телефон совпал",
    calculation:
      "Пара активного снимка, для которой зафиксирован PHONE_EXACT. Совпадение не означает автоматическое объединение.",
    paired: true,
  },
  ANNA_ONLY: {
    label: "Только у Анны",
    calculation:
      "Активная запись ANNA без единого кандидата сверки в активном снимке.",
    paired: false,
  },
  CABINET_ONLY: {
    label: "Только в кабинете",
    calculation:
      "Каноническая запись кабинета без единого кандидата сверки в активном снимке ANNA.",
    paired: false,
  },
  PHONE_TO_MULTIPLE_CARDS: {
    label: "Телефон у нескольких карточек",
    calculation:
      "Один нормализованный телефон встречается более чем у одной карточки ANNA или кабинета.",
    paired: false,
  },
  INVALID_PHONE: {
    label: "Нет корректного телефона",
    calculation:
      "У записи нет ни одного телефона, прошедшего общий нормализатор российского номера.",
    paired: false,
  },
  NAME_OR_AGENCY_CONFLICT: {
    label: "Расхождение ФИО или агентства",
    calculation:
      "У кандидата слабо пересекаются нормализованные имена либо не пересекаются известные агентства.",
    paired: true,
  },
  EXCLUDED_OR_STALE: {
    label: "Исключено или устарело",
    calculation:
      "Запись архивирована/закрыта/слита, цель отсутствует либо связь существует только в прежнем снимке.",
    paired: false,
  },
};

function normalizeWords(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const ignored = new Set([
    "ооо",
    "ао",
    "пао",
    "зао",
    "ип",
    "агентство",
    "недвижимости",
  ]);
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word && !ignored.has(word));
}

function similarNames(left: string, right: string): boolean {
  const a = new Set(normalizeWords(left));
  const b = new Set(normalizeWords(right));
  if (!a.size || !b.size) return true;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return intersection / Math.max(1, union) >= 0.5;
}

function maskContact(type: string, value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  if (type === "EMAIL") {
    const at = raw.indexOf("@");
    if (at <= 0) return "***";
    return `${raw.slice(0, 1)}***${raw.slice(at)}`;
  }
  if (type === "PHONE") {
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 2 ? `+* (***) ***-**-${digits.slice(-2)}` : "***";
  }
  return raw.length <= 2 ? "***" : `${raw.slice(0, 1)}***${raw.slice(-1)}`;
}

function normalizedPhones(values: unknown[]): Set<string> {
  const phones = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeLoyaltyContactPoint("PHONE", value);
    if (normalized) phones.add(normalized);
  }
  return phones;
}

function mergeContacts(
  ...groups: unknown[]
): Array<{ type: string; value: string }> {
  const contacts = new Map<string, { type: string; value: string }>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const point of group as any[]) {
      if (!point || typeof point !== "object") continue;
      const type = typeof point.type === "string" ? point.type : "OTHER";
      const value = typeof point.value === "string" ? point.value.trim() : "";
      if (!value) continue;
      const normalized =
        typeof point.normalizedValue === "string"
          ? point.normalizedValue
          : normalizeLoyaltyContactPoint(type, value) || value.toLowerCase();
      contacts.set(`${type}:${normalized}`, { type, value });
    }
  }
  return [...contacts.values()];
}

function jsonContacts(value: unknown): Array<{ type: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => ({
      type: typeof item.type === "string" ? item.type : "OTHER",
      value:
        typeof item.value === "string"
          ? item.value
          : typeof item.normalizedValue === "string"
            ? item.normalizedValue
            : "",
    }))
    .filter((item) => item.value);
}

export function escapeSpreadsheetCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  text = text.replace(/[\r\n]+/g, " ");
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function sourceOwnerKey(record: any): string {
  return `${record.entityType}:${record.personId || record.organizationId}`;
}

function caseOwnerKey(item: any): string {
  return `${item.targetType}:${item.personId || item.organizationId}`;
}

function stableUuid(value: string): string {
  const chars = createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "4";
  chars[16] = "8";
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function materializationKind(item: any): MaterializedCaseSpec["kind"] | null {
  const evidence = item?.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return null;
  }
  const kind = evidence.kind;
  return evidence.generatedBy === RECONCILIATION_V2_RULE_VERSION &&
    ["PAIR", "ANNA_ENTITY", "OURS_ENTITY"].includes(kind)
    ? (kind as MaterializedCaseSpec["kind"])
    : null;
}

function isEntityMaterialization(item: any): boolean {
  const kind = materializationKind(item);
  const becameResolvedPair =
    kind === "ANNA_ENTITY" &&
    item?.status === "RESOLVED" &&
    ["LINK", "SUPPLEMENT"].includes(String(item?.decision));
  return (
    ["ANNA_ENTITY", "OURS_ENTITY"].includes(kind || "") && !becameResolvedPair
  );
}

function partySearchable(
  party: ReconciliationParty,
  rawContacts: Array<{ type: string; value: string }>,
  extras: unknown[] = [],
): string {
  return [
    party.id,
    party.displayName,
    party.city || "",
    ...rawContacts.map((item) => item.value),
    ...rawContacts
      .filter((item) => item.type === "PHONE")
      .map((item) => normalizeLoyaltyContactPoint("PHONE", item.value) || ""),
    ...extras.filter((item): item is string => typeof item === "string"),
  ]
    .join(" ")
    .toLocaleLowerCase("ru-RU");
}

@Injectable()
export class LoyaltyReconciliationV2Service {
  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly loyaltyBase: LoyaltyBaseService,
    private readonly permissions: LoyaltyPermissionService,
  ) {}

  definitions(user: CurrentUserPayload) {
    this.permissions.requireStaff(user);
    return LOYALTY_RECONCILIATION_GROUPS.map((code) => ({
      code,
      ...RECONCILIATION_GROUP_DEFINITIONS[code],
    }));
  }

  async coverage(
    query: LoyaltyReconciliationCoverageQueryDto,
    user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "RECONCILE"]);
    const universe = await this.buildUniverse(query.base, query.entityType);
    const classified = new Set<string>();
    const membership = new Map<string, number>();
    const groups = LOYALTY_RECONCILIATION_GROUPS.map((category) => {
      const keys = new Set(
        (universe.rowsByCategory.get(category) || []).map(
          (row) => row.baseEntityKey,
        ),
      );
      for (const key of keys) {
        classified.add(key);
        membership.set(key, (membership.get(key) || 0) + 1);
      }
      return {
        category,
        count: keys.size,
        definition: RECONCILIATION_GROUP_DEFINITIONS[category],
      };
    });
    const total = universe.entityKeys.size;
    const classifiedCount = classified.size;
    return {
      snapshotId: universe.snapshotId,
      base: query.base,
      entityType: query.entityType || null,
      total,
      classified: classifiedCount,
      unclassified: Math.max(0, total - classifiedCount),
      overlapEntities: Array.from(membership.values()).filter(
        (count) => count > 1,
      ).length,
      coveragePercent:
        total === 0
          ? 100
          : Number(((classifiedCount / total) * 100).toFixed(2)),
      groups,
      note: "Group counts may overlap; classified/unclassified use distinct base-side entities.",
    };
  }

  async search(
    dto: LoyaltyReconciliationGroupSearchDto,
    user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "RECONCILE"]);
    const universe = await this.buildUniverse(dto.base, dto.entityType);
    const filtered = this.filterRows(
      universe.rowsByCategory.get(dto.category) || [],
      dto,
    );
    const page = dto.page || 1;
    const pageSize = dto.pageSize || 30;
    const start = (page - 1) * pageSize;
    return {
      snapshotId: universe.snapshotId,
      base: dto.base,
      category: dto.category,
      definition: RECONCILIATION_GROUP_DEFINITIONS[dto.category],
      items: filtered
        .slice(start, start + pageSize)
        .map((row) => this.publicRow(row)),
      page,
      pageSize,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / pageSize),
    };
  }

  async exportCsv(
    dto: LoyaltyReconciliationGroupExportDto,
    user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, [
      "READ_ALL",
      "RECONCILE",
      "EXPORT",
    ]);
    const universe = await this.buildUniverse(dto.base, dto.entityType);
    const rows = this.filterRows(
      universe.rowsByCategory.get(dto.category) || [],
      dto,
    );
    const maxRows = dto.maxRows || 10000;
    if (rows.length > maxRows) {
      throw new BadRequestException(
        `Export contains ${rows.length} rows; narrow the filters to ${maxRows} rows or fewer`,
      );
    }
    const headings = [
      "group",
      "base",
      "entity_type",
      "anna_id",
      "anna_name",
      "anna_contacts_masked",
      "ours_id",
      "ours_name",
      "ours_contacts_masked",
      "case_id",
      "expected_version",
      "status",
      "decision",
      "match_codes",
      "reasons",
    ];
    const body = rows.map((row) => {
      const baseParty = dto.base === "anna" ? row.anna : row.ours;
      return [
        row.category,
        dto.base,
        baseParty?.entityType || "",
        row.anna?.id || "",
        row.anna?.displayName || "",
        (row.anna?.maskedContacts || [])
          .map((item) => `${item.type}:${item.value}`)
          .join(" | "),
        row.ours?.id || "",
        row.ours?.displayName || "",
        (row.ours?.maskedContacts || [])
          .map((item) => `${item.type}:${item.value}`)
          .join(" | "),
        row.caseId || "",
        row.expectedVersion ?? "",
        row.status,
        row.decision || "",
        row.matchCodes.join(" | "),
        row.reasons.join(" | "),
      ]
        .map(escapeSpreadsheetCell)
        .join(",");
    });
    const csv = `\uFEFF${headings.map(escapeSpreadsheetCell).join(",")}\r\n${body.join("\r\n")}\r\n`;
    const filterHash = createHash("sha256")
      .update(
        JSON.stringify({
          base: dto.base,
          category: dto.category,
          entityType: dto.entityType || null,
          status: dto.status || null,
          // Even a deterministic phone/e-mail hash is enumerable and should
          // not become a durable audit identifier. Persist only the fact that
          // a body-only search filter was applied.
          searchApplied: Boolean(dto.search),
          snapshotId: universe.snapshotId,
        }),
      )
      .digest("hex");
    await (this.prisma as any).loyaltyWorkflowAudit.create({
      data: {
        actorId: user.id,
        action: "RECONCILIATION_GROUP_EXPORT",
        entityType: "LOYALTY_RECONCILIATION_GROUP",
        entityId: filterHash,
        before: null,
        after: {
          base: dto.base.toUpperCase(),
          category: dto.category,
          entityType: dto.entityType || null,
          snapshotId: universe.snapshotId,
          rowCount: rows.length,
          filterHash,
        },
      },
    });
    return {
      buffer: Buffer.from(csv, "utf8"),
      filename: `loyalty-reconciliation-${dto.base}-${dto.category.toLocaleLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`,
      rowCount: rows.length,
      filterHash,
    };
  }

  async decide(
    dto: LoyaltyReconciliationV2DecisionDto,
    user: CurrentUserPayload,
  ) {
    this.permissions.requireAdmin(user);
    const db = this.prisma as any;
    let current = await db.loyaltyReconciliationCase.findUnique({
      where: { id: dto.caseId },
    });
    let virtualSpec: MaterializedCaseSpec | null = null;
    if (!current) {
      virtualSpec = await this.resolveVirtualCase(dto.caseId);
      this.assertDecisionKind(virtualSpec.kind, dto);
      current = await this.materializeOneCase(virtualSpec, dto);
    }
    if (!current) {
      throw new ConflictException("Reconciliation case is unavailable");
    }
    if (current.version !== dto.expectedVersion) {
      throw new ConflictException("Reconciliation case version changed");
    }
    const kind = materializationKind(current) || virtualSpec?.kind || null;
    this.assertDecisionKind(kind, dto);
    if (["LINK", "SUPPLEMENT"].includes(dto.action)) {
      await this.revalidateLinkSupplementEligibility(current, dto);
    }
    return this.loyaltyBase.decideReconciliation(
      Object.assign(new LoyaltyReconciliationDecisionDto(), {
        caseId: current.id,
        decision: dto.action,
        expectedVersion: current.version,
        reason: dto.reason,
        fieldResolutions: dto.fieldResolutions,
        targetId: dto.targetId,
      }),
      user.id,
    );
  }

  private assertDecisionKind(
    kind: MaterializedCaseSpec["kind"] | null,
    dto: LoyaltyReconciliationV2DecisionDto,
  ): void {
    if (kind === "OURS_ENTITY" && dto.action !== "KEEP_SEPARATE") {
      throw new BadRequestException(
        "Cabinet-only rows can only be marked KEEP_SEPARATE",
      );
    }
    if (
      kind === "ANNA_ENTITY" &&
      ["LINK", "SUPPLEMENT"].includes(dto.action) &&
      !dto.targetId
    ) {
      throw new BadRequestException(
        `${dto.action} requires an explicit cabinet targetId`,
      );
    }
  }

  private async resolveVirtualCase(
    caseId: string,
  ): Promise<MaterializedCaseSpec> {
    const dataset = await (this.prisma as any).loyaltyDataset.findUnique({
      where: { code: ANNA_DATASET_CODE },
      select: { id: true, base: true, activeSnapshotId: true },
    });
    if (!dataset?.activeSnapshotId || dataset.base !== "ANNA") {
      throw new ConflictException("Active ANNA snapshot is unavailable");
    }
    let resolved: MaterializedCaseSpec | null = null;
    for (const base of ["anna", "ours"] as const) {
      const universe = await this.buildUniverse(base);
      for (const category of LOYALTY_RECONCILIATION_GROUPS) {
        for (const row of universe.rowsByCategory.get(category) || []) {
          if (row.caseId !== caseId) continue;
          const spec = this.caseSpecForRow(
            row,
            dataset.id,
            dataset.activeSnapshotId,
          );
          if (spec.id !== caseId) continue;
          if (!resolved) {
            resolved = spec;
            continue;
          }
          if (resolved.identity !== spec.identity) {
            throw new ConflictException(
              "Virtual reconciliation case identity is ambiguous",
            );
          }
          for (const value of spec.categories) resolved.categories.add(value);
          for (const value of spec.matchCodes) resolved.matchCodes.add(value);
          for (const value of spec.reasons) resolved.reasons.add(value);
        }
      }
    }
    if (resolved) return resolved;
    throw new BadRequestException(
      "Virtual reconciliation case is stale or invalid",
    );
  }

  private async materializeOneCase(
    spec: MaterializedCaseSpec,
    dto: LoyaltyReconciliationV2DecisionDto,
  ): Promise<any> {
    const db = this.prisma as any;
    return db.$transaction(async (tx: any) => {
      const activeDataset = await tx.loyaltyDataset.findUnique({
        where: { code: ANNA_DATASET_CODE },
        select: { id: true, base: true, activeSnapshotId: true },
      });
      if (
        activeDataset?.id !== spec.datasetId ||
        activeDataset.base !== "ANNA" ||
        activeDataset.activeSnapshotId !== spec.snapshotId
      ) {
        throw new ConflictException(
          "Virtual reconciliation case belongs to a stale snapshot",
        );
      }
      if (["LINK", "SUPPLEMENT"].includes(dto.action)) {
        await this.assertLinkSupplementEntitiesEligible(
          tx,
          spec,
          dto.targetId || spec.targetId,
        );
      }
      if (spec.kind === "OURS_ENTITY") {
        const anchor = {
          id: spec.personId || spec.organizationId,
          datasetId: spec.datasetId,
          externalKey: `reconciliation-v2-anchor:${createHash("sha256")
            .update(
              `${spec.datasetId}:${spec.targetType}:${spec.targetId}`,
              "utf8",
            )
            .digest("hex")}`,
        };
        const delegate = spec.personId
          ? tx.loyaltyPerson
          : tx.loyaltyOrganization;
        await delegate.createMany({ data: [anchor], skipDuplicates: true });
      }
      await tx.loyaltyReconciliationCase.createMany({
        data: [
          {
            id: spec.id,
            datasetId: spec.datasetId,
            snapshotId: spec.snapshotId,
            personId: spec.personId,
            organizationId: spec.organizationId,
            targetType: spec.targetType,
            targetId: spec.targetId,
            matchCodes: Array.from(
              new Set([
                ...spec.matchCodes,
                ...[...spec.categories].map((value) => `V2_${value}`),
              ]),
            ).sort(),
            score: spec.matchCodes.has("PHONE_EXACT") ? "1.0000" : "0.0000",
            evidence: {
              generatedBy: RECONCILIATION_V2_RULE_VERSION,
              kind: spec.kind,
              categories: [...spec.categories].sort(),
              reasons: [...spec.reasons].sort(),
            },
            ruleVersion: RECONCILIATION_V2_RULE_VERSION,
          },
        ],
        skipDuplicates: true,
      });
      const current = await tx.loyaltyReconciliationCase.findFirst({
        where: {
          datasetId: spec.datasetId,
          snapshotId: spec.snapshotId,
          targetType: spec.targetType,
          targetId: spec.targetId,
          ...(spec.personId
            ? { personId: spec.personId }
            : { organizationId: spec.organizationId }),
        },
      });
      if (!current) {
        throw new ConflictException(
          "Could not materialize reconciliation case",
        );
      }
      return current;
    });
  }

  private async revalidateLinkSupplementEligibility(
    current: any,
    dto: LoyaltyReconciliationV2DecisionDto,
  ): Promise<void> {
    const db = this.prisma as any;
    await db.$transaction(
      async (tx: any) => {
        const latest = await tx.loyaltyReconciliationCase.findUnique({
          where: { id: current.id },
          select: {
            id: true,
            datasetId: true,
            snapshotId: true,
            personId: true,
            organizationId: true,
            targetType: true,
            targetId: true,
            status: true,
            version: true,
          },
        });
        if (
          !latest ||
          latest.status !== "OPEN" ||
          latest.version !== dto.expectedVersion
        ) {
          throw new ConflictException("Reconciliation case version changed");
        }
        const activeDataset = await tx.loyaltyDataset.findUnique({
          where: { code: ANNA_DATASET_CODE },
          select: { id: true, base: true, activeSnapshotId: true },
        });
        if (
          activeDataset?.id !== latest.datasetId ||
          activeDataset.base !== "ANNA" ||
          activeDataset.activeSnapshotId !== latest.snapshotId
        ) {
          throw new ConflictException(
            "Reconciliation case belongs to a stale snapshot",
          );
        }
        await this.assertLinkSupplementEntitiesEligible(
          tx,
          latest,
          dto.targetId || latest.targetId,
        );
      },
      { isolationLevel: "Serializable" as any },
    );
  }

  private async assertLinkSupplementEntitiesEligible(
    tx: any,
    item: Pick<
      MaterializedCaseSpec,
      "datasetId" | "snapshotId" | "personId" | "organizationId" | "targetType"
    >,
    targetId: string,
  ): Promise<void> {
    const ownerWhere =
      item.targetType === "BROKER" && item.personId && !item.organizationId
        ? { personId: item.personId }
        : item.targetType === "AGENCY" && item.organizationId && !item.personId
          ? { organizationId: item.organizationId }
          : null;
    if (!ownerWhere) {
      throw new ConflictException(
        "Reconciliation case has an invalid Anna entity",
      );
    }
    const ownerRelation =
      item.targetType === "BROKER"
        ? { person: { is: { archivedAt: null } } }
        : { organization: { is: { archivedAt: null } } };
    const sourceWhere = {
      snapshotId: item.snapshotId,
      entityType: item.targetType,
      ...ownerWhere,
    };
    const [source, activeSource] = await Promise.all([
      tx.loyaltySourceRecord.findFirst({
        where: sourceWhere,
        select: { id: true },
      }),
      tx.loyaltySourceRecord.findFirst({
        where: {
          ...sourceWhere,
          sourceArchivedAt: null,
          ...ownerRelation,
        },
        select: { id: true },
      }),
    ]);
    if (source && !activeSource) {
      throw new ConflictException(
        "Anna entity is archived or excluded from reconciliation",
      );
    }
    if (!source) {
      const activeManual = await tx.loyaltyManualEntity.findFirst({
        where: {
          datasetId: item.datasetId,
          entityType: item.targetType,
          ...ownerWhere,
          archivedAt: null,
          ...ownerRelation,
        },
        select: { id: true },
      });
      if (!activeManual) {
        throw new ConflictException(
          "Anna entity is archived, excluded, or unavailable",
        );
      }
    }
    if (item.targetType === "BROKER") {
      const target = await tx.broker.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          role: true,
          status: true,
          source: true,
          mergedIntoId: true,
        },
      });
      if (
        !target ||
        target.role !== "BROKER" ||
        target.status === "BLOCKED" ||
        target.source === "CLOSED_AS_BROKER" ||
        target.mergedIntoId
      ) {
        throw new ConflictException(
          "Target OUR broker is closed, merged, blocked, or unavailable",
        );
      }
      return;
    }
    const target = await tx.agency.findUnique({
      where: { id: targetId },
      select: { id: true },
    });
    if (!target) {
      throw new ConflictException("Target OUR agency no longer exists");
    }
  }

  private filterRows(
    rows: ReconciliationGroupRow[],
    dto: LoyaltyReconciliationGroupSearchDto,
  ) {
    const search = dto.search?.toLocaleLowerCase("ru-RU");
    const normalizedPhone = dto.search
      ? normalizeLoyaltyContactPoint("PHONE", dto.search)
      : null;
    return rows
      .filter((row) => !dto.status || row.status === dto.status)
      .filter(
        (row) =>
          !search ||
          row.searchable.includes(search) ||
          Boolean(normalizedPhone && row.searchable.includes(normalizedPhone)),
      )
      .sort((left, right) => {
        const leftParty = dto.base === "anna" ? left.anna : left.ours;
        const rightParty = dto.base === "anna" ? right.anna : right.ours;
        return (leftParty?.displayName || "").localeCompare(
          rightParty?.displayName || "",
          "ru",
        );
      });
  }

  private publicRow(row: ReconciliationGroupRow) {
    const {
      searchable: _searchable,
      baseEntityKey: _baseEntityKey,
      linkSupplementEligible: _linkSupplementEligible,
      ...safe
    } = row;
    const openActions = row.anna
      ? [
          ...(row.linkSupplementEligible ? ["LINK"] : []),
          "KEEP_SEPARATE",
          ...(row.linkSupplementEligible ? ["SUPPLEMENT"] : []),
          ...(row.anna.archived ? [] : ["ARCHIVE"]),
        ]
      : ["KEEP_SEPARATE"];
    const allowedActions = !row.caseId
      ? []
      : row.status === "OPEN"
        ? openActions
        : row.status === "RESOLVED" &&
            ["LINK", "SUPPLEMENT"].includes(String(row.decision))
          ? ["UNLINK"]
          : [];
    return {
      ...safe,
      actionable: Boolean(row.caseId),
      allowedActions,
    };
  }

  private emptyUniverse(snapshotId: string | null): ReconciliationUniverse {
    return {
      snapshotId,
      rowsByCategory: new Map(
        LOYALTY_RECONCILIATION_GROUPS.map((category) => [category, []]),
      ),
      entityKeys: new Set(),
    };
  }

  private buildUniverse(
    base: ReconciliationBase,
    entityType?: ReconciliationEntityType,
  ): Promise<ReconciliationUniverse> {
    return withLoyaltyFullScanSlot(() =>
      this.buildUniverseWithinSlot(base, entityType),
    );
  }

  private async buildUniverseWithinSlot(
    base: ReconciliationBase,
    entityType?: ReconciliationEntityType,
  ): Promise<ReconciliationUniverse> {
    const dataset = await (this.prisma as any).loyaltyDataset.findUnique({
      where: { code: ANNA_DATASET_CODE },
      select: { id: true, base: true, activeSnapshotId: true },
    });
    if (!dataset?.activeSnapshotId) return this.emptyUniverse(null);
    if (dataset.base !== "ANNA") {
      throw new ConflictException("ANNA dataset base invariant is broken");
    }
    const snapshotId = dataset.activeSnapshotId;
    const [
      sourceRecords,
      manualEntities,
      activeCases,
      staleCases,
      brokers,
      agencies,
    ] = await Promise.all([
      (this.prisma as any).loyaltySourceRecord.findMany({
        where: { snapshotId, ...(entityType ? { entityType } : {}) },
        select: {
          id: true,
          entityType: true,
          personId: true,
          organizationId: true,
          displayName: true,
          city: true,
          taxId: true,
          sourceArchivedAt: true,
          person: {
            select: {
              manualDisplayName: true,
              archivedAt: true,
              contactOverrides: {
                where: { archivedAt: null },
                select: {
                  type: true,
                  value: true,
                  normalizedValue: true,
                },
              },
            },
          },
          organization: {
            select: {
              manualDisplayName: true,
              archivedAt: true,
              contactOverrides: {
                where: { archivedAt: null },
                select: {
                  type: true,
                  value: true,
                  normalizedValue: true,
                },
              },
            },
          },
          contactPoints: {
            select: { type: true, value: true, normalizedValue: true },
          },
          organizationRoles: {
            where: { validTo: null },
            select: {
              organization: {
                select: {
                  manualDisplayName: true,
                  sourceRecords: {
                    where: { snapshotId },
                    select: { displayName: true },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      }),
      (this.prisma as any).loyaltyManualEntity.findMany({
        where: {
          datasetId: dataset.id,
          ...(entityType ? { entityType } : {}),
        },
        select: {
          id: true,
          entityType: true,
          personId: true,
          organizationId: true,
          displayName: true,
          city: true,
          contactPoints: true,
          archivedAt: true,
          person: {
            select: {
              archivedAt: true,
              contactOverrides: {
                where: { archivedAt: null },
                select: {
                  type: true,
                  value: true,
                  normalizedValue: true,
                },
              },
            },
          },
          organization: {
            select: {
              archivedAt: true,
              contactOverrides: {
                where: { archivedAt: null },
                select: {
                  type: true,
                  value: true,
                  normalizedValue: true,
                },
              },
            },
          },
        },
      }),
      (this.prisma as any).loyaltyReconciliationCase.findMany({
        where: {
          datasetId: dataset.id,
          snapshotId,
          ...(entityType ? { targetType: entityType } : {}),
        },
        select: {
          id: true,
          personId: true,
          organizationId: true,
          targetType: true,
          targetId: true,
          matchCodes: true,
          score: true,
          status: true,
          decision: true,
          version: true,
          evidence: true,
        },
      }),
      (this.prisma as any).loyaltyReconciliationCase.findMany({
        where: {
          datasetId: dataset.id,
          snapshotId: { not: snapshotId },
          ...(entityType ? { targetType: entityType } : {}),
        },
        select: {
          personId: true,
          organizationId: true,
          targetType: true,
          targetId: true,
          evidence: true,
        },
      }),
      !entityType || entityType === "BROKER"
        ? (this.prisma as any).broker.findMany({
            where: { role: "BROKER" },
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
              status: true,
              source: true,
              mergedIntoId: true,
              phones: { select: { phone: true } },
              brokerAgencies: {
                select: {
                  agency: { select: { name: true, legalName: true } },
                },
              },
            },
          })
        : Promise.resolve([]),
      !entityType || entityType === "AGENCY"
        ? (this.prisma as any).agency.findMany({
            select: {
              id: true,
              name: true,
              legalName: true,
              phone: true,
              email: true,
              address: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const anna = this.mapAnna(sourceRecords, manualEntities);
    const ours = this.mapOurs(brokers, agencies);
    const annaByOwner = new Map(anna.map((item) => [item.ownerKey, item]));
    const oursByOwner = new Map(ours.map((item) => [item.ownerKey, item]));
    const pairCases = (activeCases as any[]).filter(
      (item) => !isEntityMaterialization(item),
    );
    const activeByAnna = new Map<string, any[]>();
    const activeByOurs = new Map<string, any[]>();
    for (const item of pairCases) {
      const annaKey = caseOwnerKey(item);
      const oursKey = `${item.targetType}:${item.targetId}`;
      activeByAnna.set(annaKey, [...(activeByAnna.get(annaKey) || []), item]);
      activeByOurs.set(oursKey, [...(activeByOurs.get(oursKey) || []), item]);
    }
    const staleAnna = new Set<string>();
    const staleOurs = new Set<string>();
    for (const item of staleCases as any[]) {
      if (isEntityMaterialization(item)) continue;
      staleAnna.add(caseOwnerKey(item));
      staleOurs.add(`${item.targetType}:${item.targetId}`);
    }

    const duplicatePhones = new Set<string>();
    const annaPhoneOwners = new Map<string, Set<string>>();
    const ourPhoneOwners = new Map<string, Set<string>>();
    const collectPhones = (
      rows: EntityInfo[],
      destination: Map<string, Set<string>>,
    ) => {
      for (const row of rows) {
        if (!row.linkSupplementEligible) continue;
        for (const phone of row.phones) {
          const owners = destination.get(phone) || new Set<string>();
          owners.add(row.ownerKey);
          destination.set(phone, owners);
        }
      }
    };
    collectPhones(anna, annaPhoneOwners);
    collectPhones(ours, ourPhoneOwners);
    for (const [phone, owners] of [...annaPhoneOwners, ...ourPhoneOwners]) {
      if (owners.size > 1) duplicatePhones.add(phone);
    }

    const pairsByIdentity = new Map<string, PairInfo>();
    const addPair = (item: any) => {
      const annaInfo = annaByOwner.get(caseOwnerKey(item)) || null;
      const oursInfo =
        oursByOwner.get(`${item.targetType}:${item.targetId}`) || null;
      const sharedPhones =
        annaInfo && oursInfo
          ? Array.from(annaInfo.phones).filter((phone) =>
              oursInfo.phones.has(phone),
            )
          : [];
      const pair = {
        reconciliationCase: item,
        anna: annaInfo,
        ours: oursInfo,
        sharedPhones,
        conflictReasons: this.conflictReasons(item, annaInfo, oursInfo),
      };
      const identity = `${caseOwnerKey(item)}:${item.targetType}:${item.targetId}`;
      pairsByIdentity.set(identity, pair);
    };
    for (const item of pairCases) addPair(item);

    // Current phone ownership, not a previously materialized candidate list,
    // is authoritative. Only unambiguous 1:1 cross-base matches become pairs;
    // ambiguous ownership is represented by entity rows below and never
    // expanded into an unsafe Cartesian product.
    for (const [phone, annaOwners] of annaPhoneOwners) {
      const ourOwners = ourPhoneOwners.get(phone);
      if (annaOwners.size !== 1 || ourOwners?.size !== 1) continue;
      const annaKey = [...annaOwners][0];
      const oursKey = [...ourOwners][0];
      const annaInfo = annaByOwner.get(annaKey);
      const oursInfo = oursByOwner.get(oursKey);
      if (!annaInfo || !oursInfo) continue;
      if (annaInfo.party.entityType !== oursInfo.party.entityType) continue;
      const identity = `${annaKey}:${oursInfo.party.entityType}:${oursInfo.party.id}`;
      if (pairsByIdentity.has(identity)) continue;
      const item = {
        id: null,
        personId:
          annaInfo.party.entityType === "BROKER" ? annaInfo.party.id : null,
        organizationId:
          annaInfo.party.entityType === "AGENCY" ? annaInfo.party.id : null,
        targetType: annaInfo.party.entityType,
        targetId: oursInfo.party.id,
        matchCodes: ["PHONE_EXACT"],
        score: "1.0000",
        status: "OPEN",
        decision: null,
        version: 1,
        evidence: {
          generatedBy: RECONCILIATION_V2_RULE_VERSION,
          kind: "PAIR",
          phoneMatch: true,
        },
      };
      addPair(item);
      activeByAnna.set(annaKey, [...(activeByAnna.get(annaKey) || []), item]);
      activeByOurs.set(oursKey, [...(activeByOurs.get(oursKey) || []), item]);
    }
    const pairs = [...pairsByIdentity.values()];

    const universe = this.emptyUniverse(snapshotId);
    const baseRows = base === "anna" ? anna : ours;
    for (const item of baseRows) universe.entityKeys.add(item.key);
    const add = (
      category: LoyaltyReconciliationGroup,
      row: ReconciliationGroupRow,
    ) => universe.rowsByCategory.get(category)!.push(row);

    for (const pair of pairs) {
      const baseInfo = base === "anna" ? pair.anna : pair.ours;
      if (!baseInfo) continue;
      const matchCodes: string[] = pair.reconciliationCase.matchCodes || [];
      if (matchCodes.includes("PHONE_EXACT") || pair.sharedPhones.length > 0) {
        add("PHONE_MATCHED", this.pairRow(base, "PHONE_MATCHED", pair));
      }
      if (pair.conflictReasons.length) {
        add(
          "NAME_OR_AGENCY_CONFLICT",
          this.pairRow(
            base,
            "NAME_OR_AGENCY_CONFLICT",
            pair,
            pair.conflictReasons,
          ),
        );
      }
      if (!pair.ours && pair.anna && base === "anna") {
        pair.anna.excludedReasons.add("TARGET_MISSING");
      }
      if (!pair.anna && pair.ours && base === "ours") {
        pair.ours.excludedReasons.add("SOURCE_MISSING");
      }
    }

    for (const item of baseRows) {
      const activeCasesForEntity =
        base === "anna"
          ? activeByAnna.get(item.ownerKey) || []
          : activeByOurs.get(item.ownerKey) || [];
      const stale =
        base === "anna"
          ? staleAnna.has(item.ownerKey)
          : staleOurs.has(item.ownerKey);
      if (stale && activeCasesForEntity.length === 0) {
        item.excludedReasons.add("STALE_PREVIOUS_SNAPSHOT_MATCH");
      }
      if (item.phones.size === 0) {
        add(
          "INVALID_PHONE",
          this.entityRow(base, "INVALID_PHONE", item, [
            "NO_VALID_NORMALIZED_PHONE",
          ]),
        );
      }
      if (Array.from(item.phones).some((phone) => duplicatePhones.has(phone))) {
        add(
          "PHONE_TO_MULTIPLE_CARDS",
          this.entityRow(base, "PHONE_TO_MULTIPLE_CARDS", item, [
            "PHONE_SHARED_BY_MULTIPLE_CARDS",
          ]),
        );
      }
      if (item.excludedReasons.size) {
        add(
          "EXCLUDED_OR_STALE",
          this.entityRow(
            base,
            "EXCLUDED_OR_STALE",
            item,
            Array.from(item.excludedReasons),
          ),
        );
      }
      if (activeCasesForEntity.length === 0 && !item.party.archived) {
        const category = base === "anna" ? "ANNA_ONLY" : "CABINET_ONLY";
        add(category, this.entityRow(base, category, item));
      }
    }
    this.attachStableCaseIds(
      universe,
      dataset.id,
      snapshotId,
      activeCases as any[],
    );
    return universe;
  }

  private attachStableCaseIds(
    universe: ReconciliationUniverse,
    datasetId: string,
    snapshotId: string,
    activeCases: any[],
  ): void {
    const existing = new Map<string, any>();
    const existingById = new Map<string, any>();
    for (const item of activeCases) {
      existing.set(this.caseIdentity(snapshotId, item), item);
      existingById.set(item.id, item);
    }
    for (const category of LOYALTY_RECONCILIATION_GROUPS) {
      for (const row of universe.rowsByCategory.get(category) || []) {
        if (row.caseId) continue;
        const spec = this.caseSpecForRow(row, datasetId, snapshotId);
        // ANNA_ENTITY cases keep their deterministic id when an explicit
        // LINK/SUPPLEMENT replaces the virtual target with a real OUR target.
        // Identity therefore changes, but overlapping entity groups must
        // still expose the persisted version instead of a stale v1 shell.
        const persisted =
          existing.get(spec.identity) || existingById.get(spec.id);
        if (persisted) {
          this.applyCase(row, persisted);
          continue;
        }
        row.caseId = spec.id;
        row.expectedVersion = 1;
        row.status = "OPEN";
        row.decision = null;
        row.matchCodes = Array.from(
          new Set([
            ...row.matchCodes,
            ...[...spec.categories].map((value) => `V2_${value}`),
          ]),
        ).sort();
        row.score = spec.matchCodes.has("PHONE_EXACT") ? "1.0000" : "0.0000";
      }
    }
  }

  private caseSpecForRow(
    row: ReconciliationGroupRow,
    datasetId: string,
    snapshotId: string,
  ): MaterializedCaseSpec {
    let personId: string | null = null;
    let organizationId: string | null = null;
    let targetType: ReconciliationEntityType;
    let targetId: string;
    let kind: MaterializedCaseSpec["kind"];
    if (row.anna) {
      targetType = row.anna.entityType;
      personId = targetType === "BROKER" ? row.anna.id : null;
      organizationId = targetType === "AGENCY" ? row.anna.id : null;
      if (row.ours) {
        if (row.ours.entityType !== targetType) {
          throw new ConflictException(
            "Reconciliation pair contains different entity types",
          );
        }
        targetId = row.ours.id;
        kind = "PAIR";
      } else {
        targetId = stableUuid(
          `reconciliation-v2:virtual-target:${datasetId}:${snapshotId}:${targetType}:${row.anna.id}`,
        );
        kind = "ANNA_ENTITY";
      }
    } else if (row.ours) {
      targetType = row.ours.entityType;
      targetId = row.ours.id;
      const anchorId = stableUuid(
        `reconciliation-v2:anchor:${datasetId}:${targetType}:${targetId}`,
      );
      personId = targetType === "BROKER" ? anchorId : null;
      organizationId = targetType === "AGENCY" ? anchorId : null;
      kind = "OURS_ENTITY";
    } else {
      throw new ConflictException(
        "Reconciliation row has neither ANNA nor OURS entity",
      );
    }
    const identity = this.caseIdentity(snapshotId, {
      personId,
      organizationId,
      targetType,
      targetId,
    });
    return {
      identity,
      id: stableUuid(`reconciliation-v2:case:${identity}`),
      datasetId,
      snapshotId,
      personId,
      organizationId,
      targetType,
      targetId,
      kind,
      categories: new Set([row.category]),
      matchCodes: new Set(row.matchCodes),
      reasons: new Set(row.reasons),
    };
  }

  private caseIdentity(snapshotId: string, item: any): string {
    return [
      snapshotId,
      item.targetType,
      item.personId
        ? `PERSON:${item.personId}`
        : `ORGANIZATION:${item.organizationId}`,
      item.targetId,
    ].join(":");
  }

  private applyCase(row: ReconciliationGroupRow, item: any): void {
    row.caseId = item.id;
    row.expectedVersion = item.version;
    row.status = item.status;
    row.decision = item.decision || null;
    row.matchCodes = Array.from(
      new Set([...(row.matchCodes || []), ...(item.matchCodes || [])]),
    );
    row.score =
      item.score === null || item.score === undefined
        ? null
        : String(item.score);
  }

  private mapAnna(records: any[], manualEntities: any[]): EntityInfo[] {
    const result = new Map<string, EntityInfo>();
    for (const record of records as any[]) {
      const ownerKey = sourceOwnerKey(record);
      const owner = record.person || record.organization;
      const contacts = mergeContacts(
        record.contactPoints,
        owner?.contactOverrides,
      );
      const archived = Boolean(record.sourceArchivedAt || owner?.archivedAt);
      const party: ReconciliationParty = {
        id: record.personId || record.organizationId,
        entityType: record.entityType,
        displayName: owner?.manualDisplayName || record.displayName,
        city: record.city,
        maskedContacts: contacts.map((point: any) => ({
          type: point.type,
          value: maskContact(point.type, point.value),
        })),
        archived,
      };
      const agencyNames = new Set<string>();
      for (const role of record.organizationRoles || []) {
        const organization = role.organization;
        const name =
          organization?.manualDisplayName ||
          organization?.sourceRecords?.[0]?.displayName;
        if (name) agencyNames.add(name);
      }
      result.set(ownerKey, {
        key: `ANNA:${ownerKey}`,
        ownerKey,
        party,
        searchable: partySearchable(party, contacts, [record.taxId]),
        phones: normalizedPhones(
          contacts
            .filter((point: any) => point.type === "PHONE")
            .map((point: any) => point.value),
        ),
        agencyNames,
        excludedReasons: new Set(
          archived ? ["ANNA_ARCHIVED_OR_SOURCE_EXCLUDED"] : [],
        ),
        linkSupplementEligible: !archived,
      });
    }
    for (const manual of manualEntities as any[]) {
      const owner = manual.person || manual.organization;
      const contacts = mergeContacts(
        jsonContacts(manual.contactPoints),
        owner?.contactOverrides,
      );
      const ownerKey = `${manual.entityType}:${manual.personId || manual.organizationId}`;
      if (result.has(ownerKey)) continue;
      const archived = Boolean(manual.archivedAt || owner?.archivedAt);
      const party: ReconciliationParty = {
        id: manual.personId || manual.organizationId,
        entityType: manual.entityType,
        displayName: manual.displayName,
        city: manual.city,
        maskedContacts: contacts.map((point) => ({
          type: point.type,
          value: maskContact(point.type, point.value),
        })),
        archived,
      };
      result.set(ownerKey, {
        key: `ANNA:${ownerKey}`,
        ownerKey,
        party,
        searchable: partySearchable(party, contacts),
        phones: normalizedPhones(
          contacts
            .filter((point) => point.type === "PHONE")
            .map((point) => point.value),
        ),
        agencyNames: new Set(),
        excludedReasons: new Set(archived ? ["MANUAL_OVERLAY_ARCHIVED"] : []),
        linkSupplementEligible: !archived,
      });
    }
    return Array.from(result.values());
  }

  private mapOurs(brokers: any[], agencies: any[]): EntityInfo[] {
    const result: EntityInfo[] = [];
    for (const broker of brokers as any[]) {
      const contacts = [
        ...(broker.phone ? [{ type: "PHONE", value: broker.phone }] : []),
        ...(broker.phones || []).map((item: any) => ({
          type: "PHONE",
          value: item.phone,
        })),
        ...(broker.email ? [{ type: "EMAIL", value: broker.email }] : []),
      ];
      const excludedReasons = new Set<string>();
      if (broker.mergedIntoId) excludedReasons.add("BROKER_MERGED");
      if (broker.status === "BLOCKED") excludedReasons.add("BROKER_BLOCKED");
      if (broker.source === "CLOSED_AS_BROKER")
        excludedReasons.add("BROKER_CLOSED");
      const party: ReconciliationParty = {
        id: broker.id,
        entityType: "BROKER",
        displayName: broker.fullName,
        maskedContacts: contacts.map((point) => ({
          type: point.type,
          value: maskContact(point.type, point.value),
        })),
        archived: excludedReasons.size > 0,
      };
      const agencyNames = new Set<string>();
      for (const relation of broker.brokerAgencies || []) {
        if (relation.agency?.name) agencyNames.add(relation.agency.name);
        if (relation.agency?.legalName)
          agencyNames.add(relation.agency.legalName);
      }
      result.push({
        key: `OURS:BROKER:${broker.id}`,
        ownerKey: `BROKER:${broker.id}`,
        party,
        searchable: partySearchable(party, contacts),
        phones: normalizedPhones(
          contacts
            .filter((point) => point.type === "PHONE")
            .map((point) => point.value),
        ),
        agencyNames,
        excludedReasons,
        linkSupplementEligible: excludedReasons.size === 0,
      });
    }
    for (const agency of agencies as any[]) {
      const contacts = [
        ...(agency.phone ? [{ type: "PHONE", value: agency.phone }] : []),
        ...(agency.email ? [{ type: "EMAIL", value: agency.email }] : []),
      ];
      const party: ReconciliationParty = {
        id: agency.id,
        entityType: "AGENCY",
        displayName: agency.name,
        city: agency.address,
        maskedContacts: contacts.map((point) => ({
          type: point.type,
          value: maskContact(point.type, point.value),
        })),
        archived: false,
      };
      result.push({
        key: `OURS:AGENCY:${agency.id}`,
        ownerKey: `AGENCY:${agency.id}`,
        party,
        searchable: partySearchable(party, contacts, [agency.legalName]),
        phones: normalizedPhones(
          contacts
            .filter((point) => point.type === "PHONE")
            .map((point) => point.value),
        ),
        agencyNames: new Set([agency.name, agency.legalName].filter(Boolean)),
        excludedReasons: new Set(),
        linkSupplementEligible: true,
      });
    }
    return result;
  }

  private conflictReasons(
    reconciliationCase: any,
    anna: EntityInfo | null,
    ours: EntityInfo | null,
  ): string[] {
    const explicit = (reconciliationCase.matchCodes || []).filter(
      (code: string) =>
        code.includes("NAME_CONFLICT") || code.includes("AGENCY_CONFLICT"),
    );
    if (!anna || !ours) return explicit;
    const reasons = [...explicit];
    if (!similarNames(anna.party.displayName, ours.party.displayName)) {
      reasons.push("DISPLAY_NAME_MISMATCH");
    }
    if (anna.agencyNames.size && ours.agencyNames.size) {
      const overlaps = Array.from(anna.agencyNames).some((annaName) =>
        Array.from(ours.agencyNames).some((ourName) =>
          similarNames(annaName, ourName),
        ),
      );
      if (!overlaps) reasons.push("AGENCY_MISMATCH");
    }
    return Array.from(new Set(reasons));
  }

  private pairRow(
    base: ReconciliationBase,
    category: LoyaltyReconciliationGroup,
    pair: PairInfo,
    extraReasons: string[] = [],
  ): ReconciliationGroupRow {
    const item = pair.reconciliationCase;
    const baseInfo = base === "anna" ? pair.anna! : pair.ours!;
    const stablePairKey =
      item.id ||
      `${pair.anna?.ownerKey || "missing-anna"}:${pair.ours?.ownerKey || "missing-ours"}`;
    return {
      key: `${category}:${base}:${stablePairKey}`,
      base,
      baseEntityKey: baseInfo.key,
      category,
      caseId: item.id,
      expectedVersion: item.version,
      status: item.status,
      decision: item.decision || null,
      matchCodes: item.matchCodes || [],
      score:
        item.score === null || item.score === undefined
          ? null
          : String(item.score),
      reasons: extraReasons,
      anna: pair.anna?.party || null,
      ours: pair.ours?.party || null,
      linkSupplementEligible: Boolean(
        pair.anna?.linkSupplementEligible && pair.ours?.linkSupplementEligible,
      ),
      searchable: [pair.anna?.searchable || "", pair.ours?.searchable || ""]
        .join(" ")
        .toLocaleLowerCase("ru-RU"),
    };
  }

  private entityRow(
    base: ReconciliationBase,
    category: LoyaltyReconciliationGroup,
    item: EntityInfo,
    reasons: string[] = [],
  ): ReconciliationGroupRow {
    return {
      key: `${category}:${item.key}`,
      base,
      baseEntityKey: item.key,
      category,
      caseId: null,
      expectedVersion: null,
      status: "OPEN",
      decision: null,
      matchCodes: [],
      score: null,
      reasons,
      anna: base === "anna" ? item.party : null,
      ours: base === "ours" ? item.party : null,
      linkSupplementEligible: base === "anna" && item.linkSupplementEligible,
      searchable: item.searchable,
    };
  }
}
