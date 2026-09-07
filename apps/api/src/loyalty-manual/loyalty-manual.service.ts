import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, PrismaClient } from "@st-michael/database";
import { createHash, randomUUID } from "crypto";
import { normalizeLoyaltyContactPoint } from "../loyalty-base/loyalty-base.service";
import {
  CreateLoyaltyAgencyContactPersonDto,
  CreateLoyaltyContactPointDto,
  CreateLoyaltyManualContactDto,
  LoyaltyAgencyContactPersonPointDto,
  UpdateLoyaltyAgencyContactPersonDto,
  UpdateLoyaltyContactPointDto,
} from "./loyalty-manual.dto";

type ManualEntityType = "BROKER" | "AGENCY";

function mask(type: string, value: string): string {
  if (type === "PHONE") {
    return value.length >= 4 ? `+7 ••• •••-${value.slice(-4)}` : "••••";
  }
  if (type === "EMAIL") {
    const [local, domain] = value.split("@");
    return `${local?.slice(0, 1) || "•"}•••@${domain || "•••"}`;
  }
  return value.length <= 4
    ? "••••"
    : `${value.slice(0, 2)}•••${value.slice(-2)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

@Injectable()
export class LoyaltyManualService {
  constructor(@Inject("PrismaClient") private readonly prisma: PrismaClient) {}

  private entityType(value: string): ManualEntityType {
    const normalized = value.toUpperCase();
    if (["BROKER", "BROKERS"].includes(normalized)) return "BROKER";
    if (["AGENCY", "AGENCIES"].includes(normalized)) return "AGENCY";
    throw new BadRequestException("LOYALTY_ENTITY_TYPE_INVALID");
  }

  private normalizedPoint(type: string, value: string) {
    const trimmed = String(value || "").trim();
    const normalizationType = type === "WHATSAPP" ? "PHONE" : type;
    const normalized = normalizeLoyaltyContactPoint(normalizationType, trimmed);
    if (!normalized) {
      throw new BadRequestException(`${type}_INVALID`);
    }
    return {
      value: ["PHONE", "WHATSAPP", "EMAIL"].includes(type)
        ? normalized
        : trimmed,
      normalized,
    };
  }

  private async entityContext(tx: any, rawType: string, entityId: string) {
    const entityType = this.entityType(rawType);
    const dataset = await tx.loyaltyDataset.findFirst({
      where: {
        code: "ANNA",
        base: "ANNA",
        archivedAt: null,
        activeSnapshot: { is: { status: "PUBLISHED" } },
      },
      select: { id: true, activeSnapshotId: true },
    });
    if (!dataset?.activeSnapshotId) {
      throw new NotFoundException("Published Anna snapshot not found");
    }
    const target = await (
      entityType === "BROKER" ? tx.loyaltyPerson : tx.loyaltyOrganization
    ).findFirst({
      where: { id: entityId, datasetId: dataset.id },
      select: { id: true, archivedAt: true },
    });
    if (!target) throw new NotFoundException("LOYALTY_ENTITY_NOT_FOUND");
    if (target.archivedAt) {
      throw new ConflictException("LOYALTY_ENTITY_ARCHIVED");
    }
    return {
      datasetId: dataset.id as string,
      snapshotId: dataset.activeSnapshotId as string,
      entityType,
      entityId,
      targetWhere:
        entityType === "BROKER"
          ? { personId: entityId }
          : { organizationId: entityId },
    };
  }

  private async assertContactAvailable(
    tx: any,
    context: Awaited<ReturnType<LoyaltyManualService["entityContext"]>>,
    type: string,
    normalizedValue: string,
    excludeOverrideId?: string,
  ) {
    const [sourceDuplicate, overrideDuplicate] = await Promise.all([
      tx.loyaltyContactPoint.findFirst({
        where: {
          sourceRecord: { snapshotId: context.snapshotId },
          type,
          normalizedValue,
        },
        select: { id: true },
      }),
      tx.loyaltyContactOverride.findFirst({
        where: {
          datasetId: context.datasetId,
          type,
          normalizedValue,
          archivedAt: null,
          ...(excludeOverrideId ? { id: { not: excludeOverrideId } } : {}),
        },
        select: { id: true },
      }),
    ]);
    if (sourceDuplicate || overrideDuplicate) {
      throw new ConflictException("LOYALTY_CONTACT_ALREADY_EXISTS");
    }
  }

  private pointResponse(point: any) {
    return {
      id: point.id,
      entityType: point.entityType,
      type: point.type,
      value: point.value,
      normalizedValue: point.normalizedValue,
      maskedValue: mask(point.type, point.normalizedValue),
      label: point.label,
      isPrimary: point.isPrimary,
      version: point.version,
      archivedAt: point.archivedAt,
      createdAt: point.createdAt,
      updatedAt: point.updatedAt,
    };
  }

  private normalizedContactPersonPoints(
    points: LoyaltyAgencyContactPersonPointDto[] = [],
    existingPoints: any[] = [],
    reconcileExistingIds = false,
  ) {
    const seen = new Set<string>();
    const usedIds = new Set<string>();
    const primaryTypes = new Set<string>();
    const existingById = new Map(
      existingPoints.map((point: any) => [String(point.id), point]),
    );
    const existingByKey = new Map<string, any>();
    for (const point of existingPoints) {
      const normalizedValue =
        point.normalizedValue ||
        this.normalizedPoint(point.type, point.value).normalized;
      const key = `${point.type}:${normalizedValue}`;
      if (!existingByKey.has(key)) existingByKey.set(key, point);
    }
    const normalized = points.map((point) => {
      const value = this.normalizedPoint(point.type, point.value);
      const key = `${point.type}:${value.normalized}`;
      if (seen.has(key)) {
        throw new BadRequestException("CONTACT_PERSON_POINT_DUPLICATE");
      }
      seen.add(key);
      let id: string | undefined;
      if (point.id && reconcileExistingIds) {
        const existing = existingById.get(point.id);
        const existingNormalized = existing
          ? existing.normalizedValue ||
            this.normalizedPoint(existing.type, existing.value).normalized
          : null;
        if (
          !existing ||
          existing.type !== point.type ||
          existingNormalized !== value.normalized ||
          usedIds.has(point.id)
        ) {
          throw new BadRequestException("CONTACT_PERSON_POINT_ID_INVALID");
        }
        id = point.id;
      } else if (reconcileExistingIds) {
        const unchanged = existingByKey.get(key);
        if (unchanged && !usedIds.has(String(unchanged.id))) {
          id = String(unchanged.id);
        }
      }
      id ||= randomUUID();
      usedIds.add(id);
      if (point.isPrimary) {
        if (primaryTypes.has(point.type)) {
          throw new BadRequestException(
            "CONTACT_PERSON_MULTIPLE_PRIMARY_POINTS",
          );
        }
        primaryTypes.add(point.type);
      }
      return {
        id,
        type: point.type,
        value: value.value,
        normalizedValue: value.normalized,
        label: point.label?.trim() || null,
        isPrimary: point.isPrimary === true,
      };
    });
    for (const point of normalized) {
      if (
        !primaryTypes.has(point.type) &&
        normalized.find((candidate) => candidate.type === point.type)?.id ===
          point.id
      ) {
        point.isPrimary = true;
        primaryTypes.add(point.type);
      }
    }
    return normalized;
  }

  private agencyContactPersonResponse(person: any) {
    return {
      id: person.id,
      organizationId: person.organizationId,
      displayName: person.displayName,
      role: person.role,
      actualityStatus: person.actualityStatus,
      contactPoints: (Array.isArray(person.contactPoints)
        ? person.contactPoints
        : []
      ).map((point: any) => ({
        id: point.id,
        type: point.type,
        value: point.value,
        normalizedValue: point.normalizedValue,
        maskedValue: mask(point.type, point.normalizedValue || point.value),
        label: point.label,
        isPrimary: point.isPrimary,
      })),
      version: person.version,
      archivedAt: person.archivedAt,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    };
  }

  private safeAgencyContactPerson(person: any | null) {
    if (!person) return null;
    return {
      id: person.id,
      displayNameHash: hash(person.displayName),
      role: person.role,
      actualityStatus: person.actualityStatus,
      contactTypes: (person.contactPoints || []).map(
        (point: any) => point.type,
      ),
      contactHashes: (person.contactPoints || []).map((point: any) =>
        hash(`${point.type}:${point.normalizedValue}`),
      ),
      version: person.version,
      archived: Boolean(person.archivedAt),
    };
  }

  private async refreshManualContactKeys(
    tx: any,
    context: Awaited<ReturnType<LoyaltyManualService["entityContext"]>>,
    now: Date,
  ) {
    const points = await tx.loyaltyContactOverride.findMany({
      where: {
        datasetId: context.datasetId,
        ...context.targetWhere,
        archivedAt: null,
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        type: true,
        value: true,
        normalizedValue: true,
        label: true,
        isPrimary: true,
      },
    });
    const legacyContactPoints = points.map((point: any) => ({
      id: point.id,
      type: point.type,
      value: point.value,
      normalized: point.normalizedValue,
      maskedValue: mask(point.type, point.normalizedValue),
      label: point.label,
      isPrimary: point.isPrimary,
      source: "MANUAL_OVERRIDE",
    }));
    await tx.loyaltyManualEntity.updateMany({
      where: {
        datasetId: context.datasetId,
        ...context.targetWhere,
      },
      data: {
        phoneNormalized:
          points.find((point: any) => point.type === "PHONE")
            ?.normalizedValue || null,
        emailNormalized:
          points.find((point: any) => point.type === "EMAIL")
            ?.normalizedValue || null,
        contactPoints: legacyContactPoints,
        version: { increment: 1 },
        updatedAt: now,
      },
    });
  }

  private async auditPointChange(
    tx: any,
    context: Awaited<ReturnType<LoyaltyManualService["entityContext"]>>,
    actorId: string,
    action: string,
    pointId: string,
    before: any | null,
    after: any | null,
    now: Date,
  ) {
    const safe = (point: any | null) =>
      point
        ? {
            id: point.id,
            type: point.type,
            valueHash: hash(`${point.type}:${point.normalizedValue}`),
            maskedValue: mask(point.type, point.normalizedValue),
            label: point.label,
            isPrimary: point.isPrimary,
            version: point.version,
            archived: Boolean(point.archivedAt),
          }
        : null;
    await tx.loyaltyEntityChange.create({
      data: {
        ...context.targetWhere,
        action: action === "CONTACT_POINT_ARCHIVE" ? "ARCHIVE" : "UPDATE",
        changedFields: [action],
        beforeValues: safe(before),
        afterValues: safe(after),
        actorId,
        createdAt: now,
      },
    });
    await tx.loyaltyWorkflowAudit.create({
      data: {
        actorId,
        action,
        entityType: context.entityType,
        entityId: context.entityId,
        before: safe(before),
        after: { ...safe(after), pointId },
        createdAt: now,
      },
    });
  }

  private async demotePrimaryPoints(
    tx: any,
    context: Awaited<ReturnType<LoyaltyManualService["entityContext"]>>,
    type: string,
    now: Date,
    exceptPointId?: string,
  ): Promise<any[]> {
    const where = {
      datasetId: context.datasetId,
      ...context.targetWhere,
      type,
      archivedAt: null,
      isPrimary: true,
      ...(exceptPointId ? { id: { not: exceptPointId } } : {}),
    };
    const before = await tx.loyaltyContactOverride.findMany({
      where,
      orderBy: { id: "asc" },
    });
    if (!before.length) return [];
    const changed = await tx.loyaltyContactOverride.updateMany({
      where,
      data: {
        isPrimary: false,
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    if (changed.count !== before.length) {
      throw new ConflictException("LOYALTY_CONTACT_PRIMARY_CONFLICT");
    }
    return before;
  }

  private async auditDemotedPrimaryPoints(
    tx: any,
    context: Awaited<ReturnType<LoyaltyManualService["entityContext"]>>,
    actorId: string,
    points: any[],
    now: Date,
  ): Promise<void> {
    for (const point of points) {
      await this.auditPointChange(
        tx,
        context,
        actorId,
        "CONTACT_POINT_PRIMARY_DEMOTED",
        point.id,
        point,
        {
          ...point,
          isPrimary: false,
          version:
            typeof point.version === "number" ? point.version + 1 : undefined,
          updatedAt: now,
        },
        now,
      );
    }
  }

  async create(dto: CreateLoyaltyManualContactDto, actorId: string) {
    if (dto.base.toLowerCase() !== "anna") {
      throw new BadRequestException(
        "OUR_CONTACT_CREATION_REQUIRES_CANONICAL_ADMIN_FLOW",
      );
    }
    const entityType = this.entityType(dto.entityType);
    const phone = dto.phone
      ? normalizeLoyaltyContactPoint("PHONE", dto.phone)
      : null;
    if (dto.phone && !phone) {
      throw new BadRequestException("PHONE_INVALID");
    }
    const email = dto.email?.trim().toLocaleLowerCase("en-US") || null;
    if (!phone && !email) {
      throw new BadRequestException("PHONE_OR_EMAIL_REQUIRED");
    }
    const now = new Date();
    const entityId = randomUUID();
    const overlayId = randomUUID();
    // Keep the same stable key as the reviewed Anna converter. If this manual
    // broker later appears in an authoritative snapshot, the import reuses the
    // stable person instead of silently creating a duplicate.
    const externalKey =
      entityType === "BROKER" && phone
        ? `anna:broker:phone-sha256:${hash(`ANNA_BROKER_PHONE\0${phone}`)}`
        : `MANUAL:${entityId}`;
    const contactPoints = [
      ...(phone
        ? [
            {
              id: randomUUID(),
              type: "PHONE",
              value: phone,
              normalized: phone,
              maskedValue: mask("PHONE", phone),
              label: "Ручной контакт",
              isPrimary: true,
            },
          ]
        : []),
      ...(email
        ? [
            {
              id: randomUUID(),
              type: "EMAIL",
              value: email,
              normalized: email,
              maskedValue: mask("EMAIL", email),
              label: "Ручной контакт",
              isPrimary: !phone,
            },
          ]
        : []),
    ];

    try {
      return await this.prisma.$transaction(
        async (tx: any) => {
          const dataset = await tx.loyaltyDataset.findFirst({
            where: {
              code: "ANNA",
              base: "ANNA",
              archivedAt: null,
              activeSnapshot: { is: { status: "PUBLISHED" } },
            },
            select: { id: true, activeSnapshotId: true },
          });
          if (!dataset?.activeSnapshotId) {
            throw new NotFoundException("Published Anna snapshot not found");
          }
          const sourceDuplicate = await tx.loyaltyContactPoint.findFirst({
            where: {
              sourceRecord: { snapshotId: dataset.activeSnapshotId },
              normalizedValue: { in: [phone, email].filter(Boolean) },
            },
            select: { id: true },
          });
          if (sourceDuplicate) {
            throw new ConflictException("LOYALTY_CONTACT_ALREADY_EXISTS");
          }

          const entityData = {
            id: entityId,
            datasetId: dataset.id,
            externalKey,
            manualDisplayName: dto.name.trim(),
            manualCity: dto.city?.trim() || null,
            manualAttributes: {
              source: "MANUAL",
              dataQuality: "NEEDS_COMPLETION",
              createdAt: now.toISOString(),
            },
          };
          if (entityType === "BROKER") {
            await tx.loyaltyPerson.create({ data: entityData });
          } else {
            await tx.loyaltyOrganization.create({ data: entityData });
          }
          const overlay = await tx.loyaltyManualEntity.create({
            data: {
              id: overlayId,
              datasetId: dataset.id,
              entityType,
              ...(entityType === "BROKER"
                ? { personId: entityId }
                : { organizationId: entityId }),
              displayName: dto.name.trim(),
              city: dto.city?.trim() || null,
              phoneNormalized: phone,
              emailNormalized: email,
              contactPoints,
              attributes: {
                source: "MANUAL",
                dataQuality: "NEEDS_COMPLETION",
              },
              createdById: actorId,
              version: 1,
              createdAt: now,
              updatedAt: now,
            },
            select: {
              id: true,
              personId: true,
              organizationId: true,
              version: true,
              updatedAt: true,
            },
          });
          await tx.loyaltyContactOverride.createMany({
            data: contactPoints.map((point) => ({
              id: point.id,
              datasetId: dataset.id,
              entityType,
              ...(entityType === "BROKER"
                ? { personId: entityId }
                : { organizationId: entityId }),
              type: point.type,
              value: point.value,
              normalizedValue: point.normalized,
              label: point.label,
              isPrimary: point.isPrimary,
              createdById: actorId,
              createdAt: now,
              updatedAt: now,
            })),
          });
          await tx.loyaltyEntityChange.create({
            data: {
              ...(entityType === "BROKER"
                ? { personId: entityId }
                : { organizationId: entityId }),
              action: "UPDATE",
              changedFields: ["MANUAL_CREATE"],
              beforeValues: null,
              afterValues: {
                displayName: dto.name.trim(),
                city: dto.city?.trim() || null,
                contactTypes: contactPoints.map((point) => point.type),
                contactHashes: contactPoints.map((point) =>
                  hash(`${point.type}:${point.normalized}`),
                ),
              },
              actorId,
              createdAt: now,
            },
          });
          await tx.loyaltyWorkflowAudit.create({
            data: {
              actorId,
              action: "MANUAL_CONTACT_CREATED",
              entityType,
              entityId,
              before: null,
              after: { base: "ANNA", overlayId },
            },
          });
          return {
            id: entityId,
            overlayId: overlay.id,
            version: overlay.version,
            updatedAt: overlay.updatedAt,
            base: "anna" as const,
            entityType,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("LOYALTY_CONTACT_ALREADY_EXISTS");
      }
      throw error;
    }
  }

  async listPoints(
    rawEntityType: string,
    entityId: string,
    includeArchived = false,
  ) {
    const context = await this.entityContext(
      this.prisma,
      rawEntityType,
      entityId,
    );
    const points = await (this.prisma as any).loyaltyContactOverride.findMany({
      where: {
        datasetId: context.datasetId,
        ...context.targetWhere,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [
        { archivedAt: "asc" },
        { isPrimary: "desc" },
        { createdAt: "asc" },
      ],
    });
    return {
      base: "ANNA" as const,
      entityType: context.entityType,
      entityId,
      items: points.map((point: any) => this.pointResponse(point)),
    };
  }

  async createPoint(
    rawEntityType: string,
    entityId: string,
    dto: CreateLoyaltyContactPointDto,
    actorId: string,
  ) {
    const normalized = this.normalizedPoint(dto.type, dto.value);
    try {
      return await this.prisma.$transaction(
        async (tx: any) => {
          const context = await this.entityContext(tx, rawEntityType, entityId);
          await this.assertContactAvailable(
            tx,
            context,
            dto.type,
            normalized.normalized,
          );
          const existingOfType = await tx.loyaltyContactOverride.count({
            where: {
              datasetId: context.datasetId,
              ...context.targetWhere,
              type: dto.type,
              archivedAt: null,
            },
          });
          const isPrimary = dto.isPrimary ?? existingOfType === 0;
          const now = new Date();
          const demoted = isPrimary
            ? await this.demotePrimaryPoints(tx, context, dto.type, now)
            : [];
          const point = await tx.loyaltyContactOverride.create({
            data: {
              id: randomUUID(),
              datasetId: context.datasetId,
              entityType: context.entityType,
              ...context.targetWhere,
              type: dto.type,
              value: normalized.value,
              normalizedValue: normalized.normalized,
              label: dto.label?.trim() || null,
              isPrimary,
              createdById: actorId,
              createdAt: now,
              updatedAt: now,
            },
          });
          await this.refreshManualContactKeys(tx, context, now);
          await this.auditDemotedPrimaryPoints(
            tx,
            context,
            actorId,
            demoted,
            now,
          );
          await this.auditPointChange(
            tx,
            context,
            actorId,
            "CONTACT_POINT_CREATE",
            point.id,
            null,
            point,
            now,
          );
          return this.pointResponse(point);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("LOYALTY_CONTACT_ALREADY_EXISTS");
      }
      throw error;
    }
  }

  async updatePoint(
    rawEntityType: string,
    entityId: string,
    pointId: string,
    dto: UpdateLoyaltyContactPointDto,
    actorId: string,
  ) {
    if (
      dto.value === undefined &&
      dto.label === undefined &&
      dto.isPrimary === undefined &&
      dto.archived === undefined
    ) {
      throw new BadRequestException("CONTACT_POINT_CHANGE_REQUIRED");
    }
    if (dto.archived === true && dto.isPrimary === true) {
      throw new BadRequestException("ARCHIVED_CONTACT_CANNOT_BE_PRIMARY");
    }
    try {
      return await this.prisma.$transaction(
        async (tx: any) => {
          const context = await this.entityContext(tx, rawEntityType, entityId);
          const before = await tx.loyaltyContactOverride.findFirst({
            where: {
              id: pointId,
              datasetId: context.datasetId,
              ...context.targetWhere,
            },
          });
          if (!before) {
            throw new NotFoundException("LOYALTY_CONTACT_POINT_NOT_FOUND");
          }
          const normalized =
            dto.value === undefined
              ? { value: before.value, normalized: before.normalizedValue }
              : this.normalizedPoint(before.type, dto.value);
          const archivedAt =
            dto.archived === true
              ? new Date()
              : dto.archived === false
                ? null
                : before.archivedAt;
          if (!archivedAt) {
            await this.assertContactAvailable(
              tx,
              context,
              before.type,
              normalized.normalized,
              pointId,
            );
          }
          const now = new Date();
          const isPrimary = archivedAt
            ? false
            : (dto.isPrimary ?? before.isPrimary);
          const demoted = isPrimary
            ? await this.demotePrimaryPoints(
                tx,
                context,
                before.type,
                now,
                pointId,
              )
            : [];
          const updated = await tx.loyaltyContactOverride.updateMany({
            where: {
              id: pointId,
              version: dto.expectedVersion,
              datasetId: context.datasetId,
              ...context.targetWhere,
            },
            data: {
              value: normalized.value,
              normalizedValue: normalized.normalized,
              ...(dto.label !== undefined
                ? { label: dto.label.trim() || null }
                : {}),
              isPrimary,
              archivedAt,
              version: { increment: 1 },
              updatedAt: now,
            },
          });
          if (updated.count !== 1) {
            throw new ConflictException("LOYALTY_CONTACT_VERSION_CONFLICT");
          }
          const after = await tx.loyaltyContactOverride.findUnique({
            where: { id: pointId },
          });
          if (!after) {
            throw new NotFoundException("LOYALTY_CONTACT_POINT_NOT_FOUND");
          }
          await this.refreshManualContactKeys(tx, context, now);
          await this.auditDemotedPrimaryPoints(
            tx,
            context,
            actorId,
            demoted,
            now,
          );
          const action =
            !before.archivedAt && after.archivedAt
              ? "CONTACT_POINT_ARCHIVE"
              : before.archivedAt && !after.archivedAt
                ? "CONTACT_POINT_RESTORE"
                : "CONTACT_POINT_UPDATE";
          await this.auditPointChange(
            tx,
            context,
            actorId,
            action,
            pointId,
            before,
            after,
            now,
          );
          return this.pointResponse(after);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("LOYALTY_CONTACT_ALREADY_EXISTS");
      }
      throw error;
    }
  }

  async listAgencyContactPeople(
    organizationId: string,
    includeArchived = false,
  ) {
    const context = await this.entityContext(
      this.prisma,
      "AGENCY",
      organizationId,
    );
    const items = await (
      this.prisma as any
    ).loyaltyAgencyContactPerson.findMany({
      where: {
        datasetId: context.datasetId,
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [
        { archivedAt: "asc" },
        { actualityStatus: "asc" },
        { displayName: "asc" },
      ],
    });
    return {
      base: "ANNA" as const,
      entityType: "AGENCY" as const,
      entityId: organizationId,
      items: (items || []).map((item: any) =>
        this.agencyContactPersonResponse(item),
      ),
    };
  }

  async createAgencyContactPerson(
    organizationId: string,
    dto: CreateLoyaltyAgencyContactPersonDto,
    actorId: string,
  ) {
    const contactPoints = this.normalizedContactPersonPoints(dto.contactPoints);
    return this.prisma.$transaction(
      async (tx: any) => {
        const context = await this.entityContext(tx, "AGENCY", organizationId);
        const now = new Date();
        const created = await tx.loyaltyAgencyContactPerson.create({
          data: {
            id: randomUUID(),
            datasetId: context.datasetId,
            organizationId,
            displayName: dto.displayName.trim(),
            role: dto.role?.trim() || null,
            actualityStatus: dto.actualityStatus || "CURRENT",
            contactPoints,
            createdById: actorId,
            createdAt: now,
            updatedAt: now,
          },
        });
        const safeAfter = this.safeAgencyContactPerson(created);
        await tx.loyaltyEntityChange.create({
          data: {
            organizationId,
            action: "UPDATE",
            changedFields: ["AGENCY_CONTACT_PERSON_CREATE"],
            beforeValues: null,
            afterValues: safeAfter,
            actorId,
            createdAt: now,
          },
        });
        await tx.loyaltyWorkflowAudit.create({
          data: {
            actorId,
            action: "AGENCY_CONTACT_PERSON_CREATE",
            entityType: "AGENCY_CONTACT_PERSON",
            entityId: created.id,
            before: null,
            after: safeAfter,
            createdAt: now,
          },
        });
        return this.agencyContactPersonResponse(created);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  }

  async updateAgencyContactPerson(
    organizationId: string,
    contactPersonId: string,
    dto: UpdateLoyaltyAgencyContactPersonDto,
    actorId: string,
  ) {
    if (
      dto.displayName === undefined &&
      dto.role === undefined &&
      dto.actualityStatus === undefined &&
      dto.contactPoints === undefined &&
      dto.archived === undefined
    ) {
      throw new BadRequestException("AGENCY_CONTACT_PERSON_CHANGE_REQUIRED");
    }
    return this.prisma.$transaction(
      async (tx: any) => {
        const context = await this.entityContext(tx, "AGENCY", organizationId);
        const before = await tx.loyaltyAgencyContactPerson.findFirst({
          where: {
            id: contactPersonId,
            datasetId: context.datasetId,
            organizationId,
          },
        });
        if (!before) {
          throw new NotFoundException("AGENCY_CONTACT_PERSON_NOT_FOUND");
        }
        const now = new Date();
        const changed = await tx.loyaltyAgencyContactPerson.updateMany({
          where: {
            id: contactPersonId,
            datasetId: context.datasetId,
            organizationId,
            version: dto.expectedVersion,
          },
          data: {
            ...(dto.displayName !== undefined
              ? { displayName: dto.displayName.trim() }
              : {}),
            ...(dto.role !== undefined
              ? { role: dto.role.trim() || null }
              : {}),
            ...(dto.actualityStatus !== undefined
              ? { actualityStatus: dto.actualityStatus }
              : {}),
            ...(dto.contactPoints !== undefined
              ? {
                  contactPoints: this.normalizedContactPersonPoints(
                    dto.contactPoints,
                    Array.isArray(before.contactPoints)
                      ? before.contactPoints
                      : [],
                    true,
                  ),
                }
              : {}),
            ...(dto.archived === true
              ? { archivedAt: now }
              : dto.archived === false
                ? { archivedAt: null }
                : {}),
            version: { increment: 1 },
            updatedAt: now,
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException("AGENCY_CONTACT_PERSON_VERSION_CONFLICT");
        }
        const after = await tx.loyaltyAgencyContactPerson.findUnique({
          where: { id: contactPersonId },
        });
        if (!after) {
          throw new NotFoundException("AGENCY_CONTACT_PERSON_NOT_FOUND");
        }
        const action =
          !before.archivedAt && after.archivedAt
            ? "AGENCY_CONTACT_PERSON_ARCHIVE"
            : before.archivedAt && !after.archivedAt
              ? "AGENCY_CONTACT_PERSON_RESTORE"
              : "AGENCY_CONTACT_PERSON_UPDATE";
        const safeBefore = this.safeAgencyContactPerson(before);
        const safeAfter = this.safeAgencyContactPerson(after);
        await tx.loyaltyEntityChange.create({
          data: {
            organizationId,
            action: after.archivedAt ? "ARCHIVE" : "UPDATE",
            changedFields: [action],
            beforeValues: safeBefore,
            afterValues: safeAfter,
            actorId,
            createdAt: now,
          },
        });
        await tx.loyaltyWorkflowAudit.create({
          data: {
            actorId,
            action,
            entityType: "AGENCY_CONTACT_PERSON",
            entityId: contactPersonId,
            before: safeBefore,
            after: safeAfter,
            createdAt: now,
          },
        });
        return this.agencyContactPersonResponse(after);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  }
}
