import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { UserRole } from "@st-michael/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LoyaltyReconciliationV2Controller } from "./loyalty-reconciliation-v2.controller";
import {
  LOYALTY_RECONCILIATION_GROUPS,
  LoyaltyReconciliationGroupSearchDto,
  LoyaltyReconciliationV2DecisionDto,
} from "./loyalty-reconciliation-v2.dto";
import {
  escapeSpreadsheetCell,
  LoyaltyReconciliationV2Service,
} from "./loyalty-reconciliation-v2.service";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";

const admin = { id: "actor-1", role: "ADMIN", phone: "", fullName: "Admin" };
const manager = {
  id: "manager-1",
  role: "MANAGER",
  phone: "",
  fullName: "Manager",
};
const broker = {
  id: "broker-1",
  role: "BROKER",
  phone: "",
  fullName: "Broker",
};

function fixtures() {
  const sourceRecords = [
    {
      id: "source-1",
      entityType: "BROKER",
      personId: "anna-1",
      organizationId: null,
      displayName: "Анна Иванова",
      city: "Москва",
      taxId: null,
      sourceArchivedAt: null,
      person: {
        manualDisplayName: null,
        archivedAt: null,
        contactOverrides: [],
      },
      organization: null,
      contactPoints: [
        {
          type: "PHONE",
          value: "+7 (999) 000-00-01",
          normalizedValue: "79990000001",
        },
      ],
      organizationRoles: [
        {
          organization: {
            manualDisplayName: null,
            sourceRecords: [{ displayName: "Альфа" }],
          },
        },
      ],
    },
    {
      id: "source-2",
      entityType: "BROKER",
      personId: "anna-2",
      organizationId: null,
      displayName: "=SUM(1,1)",
      city: null,
      taxId: null,
      sourceArchivedAt: null,
      person: {
        manualDisplayName: null,
        archivedAt: null,
        contactOverrides: [],
      },
      organization: null,
      contactPoints: [],
      organizationRoles: [],
    },
    {
      id: "source-3",
      entityType: "AGENCY",
      personId: null,
      organizationId: "anna-agency-1",
      displayName: "Старая компания",
      city: null,
      taxId: "7700000000",
      sourceArchivedAt: new Date("2026-01-01T00:00:00.000Z"),
      person: null,
      organization: {
        manualDisplayName: null,
        archivedAt: null,
        contactOverrides: [],
      },
      contactPoints: [
        {
          type: "PHONE",
          value: "+7 999 000-00-03",
          normalizedValue: "79990000003",
        },
      ],
      organizationRoles: [],
    },
  ];
  const manualEntities = [
    {
      id: "manual-1",
      entityType: "BROKER",
      personId: "anna-manual-1",
      organizationId: null,
      displayName: "Ручной контакт",
      city: "Москва",
      contactPoints: [{ type: "PHONE", value: "+7 999 000-00-09" }],
      archivedAt: null,
      person: { contactOverrides: [] },
      organization: null,
    },
  ];
  const activeCases = [
    {
      id: "case-1",
      datasetId: "dataset-1",
      snapshotId: "snapshot-1",
      personId: "anna-1",
      organizationId: null,
      targetType: "BROKER",
      targetId: "our-1",
      matchCodes: ["PHONE_EXACT"],
      score: "0.9500",
      status: "OPEN",
      decision: null,
      version: 1,
      evidence: null,
    },
    {
      id: "case-2",
      datasetId: "dataset-1",
      snapshotId: "snapshot-1",
      personId: "anna-1",
      organizationId: null,
      targetType: "BROKER",
      targetId: "our-2",
      matchCodes: ["PHONE_EXACT"],
      score: "0.9500",
      status: "RESOLVED",
      decision: "KEEP_SEPARATE",
      version: 2,
      evidence: null,
    },
  ];
  const staleCases = [
    {
      id: "stale-case-1",
      datasetId: "dataset-1",
      snapshotId: "snapshot-old",
      personId: "anna-2",
      organizationId: null,
      targetType: "BROKER",
      targetId: "our-3",
      evidence: null,
    },
  ];
  const brokers = [
    {
      id: "our-1",
      fullName: "Анна Иванова",
      phone: "+7 999 000-00-01",
      email: "anna@example.test",
      status: "ACTIVE",
      source: "BROKER_CABINET",
      mergedIntoId: null,
      phones: [],
      brokerAgencies: [{ agency: { name: "Бета", legalName: null } }],
    },
    {
      id: "our-2",
      fullName: "Совсем Другой",
      phone: "+7 999 000-00-02",
      email: null,
      status: "ACTIVE",
      source: "BROKER_CABINET",
      mergedIntoId: null,
      phones: [{ phone: "+7 999 000-00-01" }],
      brokerAgencies: [],
    },
    {
      id: "our-3",
      fullName: "Без телефона",
      phone: "bad",
      email: null,
      status: "ACTIVE",
      source: "BROKER_CABINET",
      mergedIntoId: null,
      phones: [],
      brokerAgencies: [],
    },
    {
      id: "our-4",
      fullName: "Слитая карточка",
      phone: "+7 999 000-00-04",
      email: null,
      status: "ACTIVE",
      source: "BROKER_CABINET",
      mergedIntoId: "our-1",
      phones: [],
      brokerAgencies: [],
    },
  ];
  const agencies = [
    {
      id: "our-agency-1",
      name: "Новое агентство",
      legalName: null,
      phone: "+7 999 000-00-05",
      email: null,
      address: "Москва",
    },
  ];
  return {
    sourceRecords,
    manualEntities,
    activeCases,
    staleCases,
    brokers,
    agencies,
  };
}

function harness() {
  const data = fixtures();
  const personAnchors: any[] = [];
  const organizationAnchors: any[] = [];
  const caseFindMany = jest.fn(async ({ where }: any) => {
    const source =
      where?.snapshotId && typeof where.snapshotId === "object"
        ? data.staleCases
        : data.activeCases;
    return source.filter(
      (item: any) =>
        (!where?.datasetId || item.datasetId === where.datasetId) &&
        (!where?.targetType || item.targetType === where.targetType) &&
        (typeof where?.snapshotId !== "string" ||
          item.snapshotId === where.snapshotId),
    );
  });
  const caseFindUnique = jest.fn(async ({ where }: any) =>
    data.activeCases.find((item: any) => item.id === where.id),
  );
  const caseFindFirst = jest.fn(async ({ where }: any) =>
    data.activeCases.find(
      (item: any) =>
        item.datasetId === where.datasetId &&
        item.snapshotId === where.snapshotId &&
        item.targetType === where.targetType &&
        item.targetId === where.targetId &&
        (where.personId
          ? item.personId === where.personId
          : item.organizationId === where.organizationId),
    ),
  );
  const caseCreateMany = jest.fn(async ({ data: rows }: any) => {
    let count = 0;
    for (const row of rows) {
      if (data.activeCases.some((item: any) => item.id === row.id)) continue;
      data.activeCases.push({
        ...row,
        status: "OPEN",
        decision: null,
        version: 1,
      });
      count += 1;
    }
    return { count };
  });
  const personCreateMany = jest.fn(async ({ data: rows }: any) => {
    let count = 0;
    for (const row of rows) {
      if (personAnchors.some((item) => item.id === row.id)) continue;
      personAnchors.push(row);
      count += 1;
    }
    return { count };
  });
  const organizationCreateMany = jest.fn(async ({ data: rows }: any) => {
    let count = 0;
    for (const row of rows) {
      if (organizationAnchors.some((item) => item.id === row.id)) continue;
      organizationAnchors.push(row);
      count += 1;
    }
    return { count };
  });
  const sourceFindFirst = jest.fn(async ({ where }: any) =>
    data.sourceRecords.find((item: any) => {
      if (where.snapshotId && where.snapshotId !== "snapshot-1") return false;
      if (where.entityType && item.entityType !== where.entityType)
        return false;
      if (where.personId && item.personId !== where.personId) return false;
      if (where.organizationId && item.organizationId !== where.organizationId)
        return false;
      if (where.sourceArchivedAt === null && item.sourceArchivedAt !== null)
        return false;
      if (
        where.person?.is?.archivedAt === null &&
        item.person?.archivedAt != null
      )
        return false;
      if (
        where.organization?.is?.archivedAt === null &&
        item.organization?.archivedAt != null
      )
        return false;
      return true;
    }),
  );
  const manualFindFirst = jest.fn(async ({ where }: any) =>
    data.manualEntities.find((item: any) => {
      if (where.datasetId && where.datasetId !== "dataset-1") return false;
      if (where.entityType && item.entityType !== where.entityType)
        return false;
      if (where.personId && item.personId !== where.personId) return false;
      if (where.organizationId && item.organizationId !== where.organizationId)
        return false;
      if (where.archivedAt === null && item.archivedAt !== null) return false;
      if (
        where.person?.is?.archivedAt === null &&
        item.person?.archivedAt != null
      )
        return false;
      if (
        where.organization?.is?.archivedAt === null &&
        item.organization?.archivedAt != null
      )
        return false;
      return true;
    }),
  );
  const prisma: any = {
    loyaltyDataset: {
      findUnique: jest.fn().mockResolvedValue({
        id: "dataset-1",
        base: "ANNA",
        activeSnapshotId: "snapshot-1",
      }),
    },
    loyaltySourceRecord: {
      findMany: jest.fn().mockResolvedValue(data.sourceRecords),
      findFirst: sourceFindFirst,
    },
    loyaltyManualEntity: {
      findMany: jest.fn().mockResolvedValue(data.manualEntities),
      findFirst: manualFindFirst,
    },
    loyaltyReconciliationCase: {
      findMany: caseFindMany,
      findUnique: caseFindUnique,
      findFirst: caseFindFirst,
      createMany: caseCreateMany,
    },
    loyaltyPerson: { createMany: personCreateMany },
    loyaltyOrganization: { createMany: organizationCreateMany },
    broker: {
      findMany: jest.fn().mockResolvedValue(data.brokers),
      findUnique: jest.fn(async ({ where }: any) => {
        const item = data.brokers.find((broker: any) => broker.id === where.id);
        return item ? { ...item, role: "BROKER" } : null;
      }),
    },
    agency: {
      findMany: jest.fn().mockResolvedValue(data.agencies),
      findUnique: jest.fn(async ({ where }: any) =>
        data.agencies.find((agency: any) => agency.id === where.id),
      ),
    },
    loyaltyWorkflowAudit: { create: jest.fn().mockResolvedValue({}) },
    loyaltyUserGrant: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));
  const loyaltyBase: any = {
    decideReconciliation: jest.fn().mockResolvedValue({ id: "case-1" }),
  };
  return {
    data,
    prisma,
    loyaltyBase,
    personAnchors,
    organizationAnchors,
    service: new LoyaltyReconciliationV2Service(
      prisma,
      loyaltyBase,
      new LoyaltyPermissionService(prisma),
    ),
  };
}

describe("LoyaltyReconciliationV2Service", () => {
  it("defines exactly the seven independently selectable groups", () => {
    const { service } = harness();
    expect(service.definitions(admin).map((item) => item.code)).toEqual(
      LOYALTY_RECONCILIATION_GROUPS,
    );
  });

  it("computes overlapping ANNA coverage and a distinct unclassified count", async () => {
    const { service } = harness();
    const result = await service.coverage({ base: "anna" }, admin);
    const counts = Object.fromEntries(
      result.groups.map((item) => [item.category, item.count]),
    );
    expect(result).toMatchObject({
      snapshotId: "snapshot-1",
      total: 4,
      classified: 4,
      unclassified: 0,
    });
    expect(counts).toMatchObject({
      PHONE_MATCHED: 1,
      ANNA_ONLY: 2,
      PHONE_TO_MULTIPLE_CARDS: 1,
      INVALID_PHONE: 1,
      NAME_OR_AGENCY_CONFLICT: 1,
      EXCLUDED_OR_STALE: 2,
    });
    expect(result.overlapEntities).toBeGreaterThan(0);
  });

  it("keeps the OURS universe isolated and includes cabinet-only rows", async () => {
    const { service } = harness();
    const result = await service.coverage({ base: "ours" }, admin);
    const counts = Object.fromEntries(
      result.groups.map((item) => [item.category, item.count]),
    );
    expect(result.total).toBe(5);
    expect(counts.CABINET_ONLY).toBe(2);
    expect(counts.ANNA_ONLY).toBe(0);
    expect(counts.EXCLUDED_OR_STALE).toBe(2);
  });

  it("accepts sensitive search only in POST body and never returns raw contacts", async () => {
    const { service } = harness();
    const result = await service.search(
      {
        base: "anna",
        category: "PHONE_MATCHED",
        search: "79990000001",
        page: 1,
        pageSize: 30,
      },
      admin,
    );
    expect(result.total).toBe(2);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("+7 (999) 000-00-01");
    expect(serialized).not.toContain("79990000001");
    expect(serialized).toContain("***-**-01");
    expect(serialized).not.toContain("searchable");
  });

  it("exports masked, formula-escaped CSV and writes a PII-free audit", async () => {
    const { service, prisma } = harness();
    const result = await service.exportCsv(
      {
        base: "anna",
        category: "ANNA_ONLY",
        page: 1,
        pageSize: 30,
        maxRows: 100,
      },
      admin,
    );
    const csv = result.buffer.toString("utf8");
    expect(csv).toContain('"\'=SUM(1,1)"');
    expect(csv).not.toContain("+7 999 000-00-09");
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "actor-1",
        action: "RECONCILIATION_GROUP_EXPORT",
        after: expect.objectContaining({ rowCount: 2 }),
      }),
    });
  });

  it("fails closed instead of silently truncating an export", async () => {
    const { service } = harness();
    await expect(
      service.exportCsv(
        {
          base: "anna",
          category: "PHONE_MATCHED",
          page: 1,
          pageSize: 30,
          maxRows: 1,
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("delegates all mutations to the existing optimistic safe decision path", async () => {
    const { service, loyaltyBase } = harness();
    await service.decide(
      {
        caseId: "case-1",
        action: "SUPPLEMENT",
        expectedVersion: 1,
        reason: "Проверено оператором",
        fieldResolutions: { city: "ANNA" },
      },
      admin,
    );
    expect(loyaltyBase.decideReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: "case-1",
        decision: "SUPPLEMENT",
        expectedVersion: 1,
        reason: "Проверено оператором",
      }),
      "actor-1",
    );
  });

  it.each([
    [
      "source-archived Anna",
      (data: ReturnType<typeof fixtures>) => {
        data.sourceRecords[0].sourceArchivedAt = new Date(
          "2026-08-24T00:00:00.000Z",
        );
      },
    ],
    [
      "stable archived Anna",
      (data: ReturnType<typeof fixtures>) => {
        data.sourceRecords[0].person!.archivedAt = new Date(
          "2026-08-24T00:00:00.000Z",
        );
      },
    ],
    [
      "merged OUR broker",
      (data: ReturnType<typeof fixtures>) => {
        data.brokers[0].mergedIntoId = "our-canonical";
      },
    ],
    [
      "blocked OUR broker",
      (data: ReturnType<typeof fixtures>) => {
        data.brokers[0].status = "BLOCKED";
      },
    ],
    [
      "closed OUR broker",
      (data: ReturnType<typeof fixtures>) => {
        data.brokers[0].source = "CLOSED_AS_BROKER";
      },
    ],
  ])(
    "removes LINK/SUPPLEMENT and rejects both decisions for a %s pair",
    async (_label, configure) => {
      const { data, loyaltyBase, service } = harness();
      configure(data);

      const result = await service.search(
        {
          base: "anna",
          category: "PHONE_MATCHED",
          page: 1,
          pageSize: 100,
        },
        admin,
      );
      const row = result.items.find((item) => item.caseId === "case-1");
      expect(row).toBeDefined();
      expect(row!.allowedActions).not.toContain("LINK");
      expect(row!.allowedActions).not.toContain("SUPPLEMENT");

      for (const action of ["LINK", "SUPPLEMENT"] as const) {
        await expect(
          service.decide(
            {
              caseId: "case-1",
              action,
              expectedVersion: 1,
              reason: "Eligibility revalidation",
              ...(action === "SUPPLEMENT"
                ? { fieldResolutions: { city: "Moscow" } }
                : {}),
            },
            admin,
          ),
        ).rejects.toBeInstanceOf(ConflictException);
      }
      expect(loyaltyBase.decideReconciliation).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "source-archived Anna",
      (data: ReturnType<typeof fixtures>) => {
        data.sourceRecords[0].sourceArchivedAt = new Date(
          "2026-08-24T00:00:00.000Z",
        );
      },
    ],
    [
      "merged OUR broker",
      (data: ReturnType<typeof fixtures>) => {
        data.brokers[0].mergedIntoId = "our-canonical";
      },
    ],
    [
      "blocked OUR broker",
      (data: ReturnType<typeof fixtures>) => {
        data.brokers[0].status = "BLOCKED";
      },
    ],
    [
      "closed OUR broker",
      (data: ReturnType<typeof fixtures>) => {
        data.brokers[0].source = "CLOSED_AS_BROKER";
      },
    ],
  ])(
    "does not auto-generate a phone-match candidate for %s",
    async (_label, configure) => {
      const { data, service } = harness();
      data.activeCases.splice(0);
      data.brokers[1].phones = [];
      configure(data);

      const result = await service.search(
        {
          base: "anna",
          category: "PHONE_MATCHED",
          page: 1,
          pageSize: 100,
        },
        admin,
      );

      expect(
        result.items.some(
          (item) => item.anna?.id === "anna-1" && item.ours?.id === "our-1",
        ),
      ).toBe(false);
    },
  );

  it.each([
    {
      base: "anna" as const,
      category: "PHONE_MATCHED" as const,
      configure(data: ReturnType<typeof fixtures>) {
        data.activeCases.splice(0);
        data.brokers[1].phones = [];
      },
    },
    {
      base: "anna" as const,
      category: "ANNA_ONLY" as const,
      configure() {},
    },
    {
      base: "ours" as const,
      category: "CABINET_ONLY" as const,
      configure() {},
    },
    {
      base: "anna" as const,
      category: "PHONE_TO_MULTIPLE_CARDS" as const,
      configure() {},
    },
    {
      base: "anna" as const,
      category: "INVALID_PHONE" as const,
      configure() {},
    },
    {
      base: "anna" as const,
      category: "NAME_OR_AGENCY_CONFLICT" as const,
      configure(data: ReturnType<typeof fixtures>) {
        data.activeCases.splice(0);
        data.brokers[1].phones = [];
      },
    },
    {
      base: "anna" as const,
      category: "EXCLUDED_OR_STALE" as const,
      configure() {},
    },
  ])(
    "gives every $category row a stable actionable caseId without write-on-read",
    async ({ base, category, configure }) => {
      const { data, prisma, service } = harness();
      configure(data);
      const query = { base, category, page: 1, pageSize: 100 };

      const first = await service.search(query, admin);
      const second = await service.search(query, admin);

      expect(first.items.length).toBeGreaterThan(0);
      expect(first.items.map((item) => item.caseId)).toEqual(
        second.items.map((item) => item.caseId),
      );
      for (const item of first.items) {
        expect(item.caseId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(item.actionable).toBe(true);
        expect(item.expectedVersion).toBeGreaterThanOrEqual(1);
        expect(item.allowedActions.length).toBeGreaterThan(0);
      }
      expect(
        prisma.loyaltyReconciliationCase.createMany,
      ).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("derives duplicate-phone rows from current owners including active overrides", async () => {
    const { data, prisma, service } = harness();
    data.activeCases.splice(0);
    (data.sourceRecords[1].person as any).contactOverrides.push({
      type: "PHONE",
      value: "+7 (999) 000-00-01",
      normalizedValue: "79990000001",
    });

    const result = await service.search(
      {
        base: "anna",
        category: "PHONE_TO_MULTIPLE_CARDS",
        page: 1,
        pageSize: 100,
      },
      admin,
    );

    expect(result.items.map((item) => item.anna?.id).sort()).toEqual([
      "anna-1",
      "anna-2",
    ]);
    expect(result.items.every((item) => item.actionable)).toBe(true);
    expect(prisma.loyaltySourceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          person: {
            select: expect.objectContaining({
              contactOverrides: expect.objectContaining({
                where: { archivedAt: null },
              }),
            }),
          },
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("79990000001");
    expect(prisma.loyaltyReconciliationCase.createMany).not.toHaveBeenCalled();
  });

  it("materializes one cabinet-only case idempotently only after an explicit decision", async () => {
    const { data, prisma, loyaltyBase, personAnchors, service } = harness();
    const before = data.activeCases.length;
    const search = await service.search(
      {
        base: "ours",
        category: "CABINET_ONLY",
        page: 1,
        pageSize: 100,
      },
      admin,
    );
    const row = search.items.find((item) => item.ours?.id === "our-3");
    expect(row).toBeDefined();

    const decision = {
      caseId: row!.caseId!,
      action: "KEEP_SEPARATE" as const,
      expectedVersion: row!.expectedVersion!,
      reason: "Проверено оператором",
    };
    await service.decide(decision, admin);
    await service.decide(decision, admin);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.loyaltyReconciliationCase.createMany).toHaveBeenCalledTimes(
      1,
    );
    expect(data.activeCases).toHaveLength(before + 1);
    expect(personAnchors).toHaveLength(1);
    expect(loyaltyBase.decideReconciliation).toHaveBeenCalledTimes(2);
    const created =
      prisma.loyaltyReconciliationCase.createMany.mock.calls[0][0].data;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: row!.caseId,
      datasetId: "dataset-1",
      snapshotId: "snapshot-1",
      targetType: "BROKER",
      targetId: "our-3",
      evidence: {
        generatedBy: "loyalty-reconciliation-v2",
        kind: "OURS_ENTITY",
        categories: expect.arrayContaining(["CABINET_ONLY"]),
      },
    });
    expect(JSON.stringify(created[0].evidence)).not.toContain("Без телефона");
    expect(JSON.stringify(created[0].evidence)).not.toContain("bad");
  });

  it("materializes an Anna-only row and forwards an explicit real target", async () => {
    const { prisma, loyaltyBase, personAnchors, organizationAnchors, service } =
      harness();
    const search = await service.search(
      {
        base: "anna",
        category: "ANNA_ONLY",
        page: 1,
        pageSize: 100,
      },
      admin,
    );
    const row = search.items.find((item) => item.anna?.id === "anna-2");
    expect(row).toBeDefined();

    await service.decide(
      {
        caseId: row!.caseId!,
        action: "LINK",
        targetId: "our-3",
        expectedVersion: row!.expectedVersion!,
        reason: "Связь подтверждена вручную",
      },
      admin,
    );

    expect(personAnchors).toHaveLength(0);
    expect(organizationAnchors).toHaveLength(0);
    expect(loyaltyBase.decideReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: row!.caseId,
        targetId: "our-3",
        decision: "LINK",
        expectedVersion: 1,
      }),
      "actor-1",
    );
    const created =
      prisma.loyaltyReconciliationCase.createMany.mock.calls[0][0].data[0];
    expect(created.personId).toBe("anna-2");
    expect(created.evidence.categories).toEqual(
      expect.arrayContaining([
        "ANNA_ONLY",
        "INVALID_PHONE",
        "EXCLUDED_OR_STALE",
      ]),
    );
  });

  it.each([
    [
      "Anna source is archived",
      (data: ReturnType<typeof fixtures>) => {
        data.sourceRecords[1].sourceArchivedAt = new Date(
          "2026-08-24T00:00:00.000Z",
        );
      },
    ],
    [
      "OUR target is blocked",
      (data: ReturnType<typeof fixtures>) => {
        data.brokers[2].status = "BLOCKED";
      },
    ],
  ])(
    "revalidates a virtual LINK in its materialization transaction when %s",
    async (_label, makeIneligible) => {
      const { data, prisma, loyaltyBase, service } = harness();
      const search = await service.search(
        {
          base: "anna",
          category: "ANNA_ONLY",
          page: 1,
          pageSize: 100,
        },
        admin,
      );
      const row = search.items.find((item) => item.anna?.id === "anna-2")!;
      makeIneligible(data);

      await expect(
        service.decide(
          {
            caseId: row.caseId!,
            action: "LINK",
            targetId: "our-3",
            expectedVersion: row.expectedVersion!,
            reason: "Eligibility changed after listing",
          },
          admin,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(
        prisma.loyaltyReconciliationCase.createMany,
      ).not.toHaveBeenCalled();
      expect(loyaltyBase.decideReconciliation).not.toHaveBeenCalled();
    },
  );

  it("rejects a virtual case if the active snapshot changes before materialization", async () => {
    const { prisma, loyaltyBase, personAnchors, service } = harness();
    const search = await service.search(
      {
        base: "ours",
        category: "CABINET_ONLY",
        page: 1,
        pageSize: 100,
      },
      admin,
    );
    const row = search.items.find((item) => item.ours?.id === "our-3")!;
    let lookup = 0;
    prisma.loyaltyDataset.findUnique.mockImplementation(async () => ({
      id: "dataset-1",
      base: "ANNA",
      activeSnapshotId: ++lookup >= 4 ? "snapshot-2" : "snapshot-1",
    }));

    await expect(
      service.decide(
        {
          caseId: row.caseId!,
          action: "KEEP_SEPARATE",
          expectedVersion: row.expectedVersion!,
          reason: "Проверено оператором",
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyReconciliationCase.createMany).not.toHaveBeenCalled();
    expect(personAnchors).toHaveLength(0);
    expect(loyaltyBase.decideReconciliation).not.toHaveBeenCalled();
  });

  it.each(["LINK", "SUPPLEMENT"] as const)(
    "reloads a resolved ANNA_ENTITY %s as a pair with UNLINK instead of stale only rows",
    async (decision) => {
      const { data, service } = harness();
      data.activeCases.splice(0);
      const initial = await service.search(
        {
          base: "anna",
          category: "ANNA_ONLY",
          page: 1,
          pageSize: 100,
        },
        admin,
      );
      const virtual = initial.items.find((item) => item.anna?.id === "anna-2")!;
      (data.activeCases as any[]).push({
        id: virtual.caseId,
        datasetId: "dataset-1",
        snapshotId: "snapshot-1",
        personId: "anna-2",
        organizationId: null,
        targetType: "BROKER",
        targetId: "our-3",
        matchCodes: ["V2_ANNA_ONLY"],
        score: "0.0000",
        status: "RESOLVED",
        decision,
        version: 2,
        evidence: {
          generatedBy: "loyalty-reconciliation-v2",
          kind: "ANNA_ENTITY",
          categories: ["ANNA_ONLY", "INVALID_PHONE"],
          reasons: [],
        },
      });

      const [annaOnly, cabinetOnly] = await Promise.all([
        service.search(
          {
            base: "anna",
            category: "ANNA_ONLY",
            page: 1,
            pageSize: 100,
          },
          admin,
        ),
        service.search(
          {
            base: "ours",
            category: "CABINET_ONLY",
            page: 1,
            pageSize: 100,
          },
          admin,
        ),
      ]);
      const [conflicts, invalidPhone] = await Promise.all([
        service.search(
          {
            base: "anna",
            category: "NAME_OR_AGENCY_CONFLICT",
            page: 1,
            pageSize: 100,
          },
          admin,
        ),
        service.search(
          {
            base: "anna",
            category: "INVALID_PHONE",
            page: 1,
            pageSize: 100,
          },
          admin,
        ),
      ]);

      expect(annaOnly.items.some((item) => item.anna?.id === "anna-2")).toBe(
        false,
      );
      expect(cabinetOnly.items.some((item) => item.ours?.id === "our-3")).toBe(
        false,
      );
      expect(conflicts.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caseId: virtual.caseId,
            expectedVersion: 2,
            status: "RESOLVED",
            decision,
            allowedActions: ["UNLINK"],
            anna: expect.objectContaining({ id: "anna-2" }),
            ours: expect.objectContaining({ id: "our-3" }),
          }),
        ]),
      );
      expect(invalidPhone.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caseId: virtual.caseId,
            expectedVersion: 2,
            allowedActions: ["UNLINK"],
          }),
        ]),
      );
    },
  );

  it("validates group and decision contracts", async () => {
    const invalidSearch = plainToInstance(LoyaltyReconciliationGroupSearchDto, {
      base: "all",
      category: "UNKNOWN",
      search: "",
    });
    expect(await validate(invalidSearch)).not.toHaveLength(0);
    const invalidDecision = plainToInstance(
      LoyaltyReconciliationV2DecisionDto,
      {
        caseId: "case-1",
        action: "DELETE",
        expectedVersion: 0,
        reason: "x",
      },
    );
    expect(await validate(invalidDecision)).not.toHaveLength(0);
  });

  it("formula-escapes spreadsheet commands after leading whitespace", () => {
    expect(escapeSpreadsheetCell("  =1+1")).toBe('"\'  =1+1"');
    expect(escapeSpreadsheetCell("normal")).toBe('"normal"');
  });

  it("lets managers reach guarded reads/exports and keeps decisions admin-only", () => {
    expect(
      Reflect.getMetadata("roles", LoyaltyReconciliationV2Controller),
    ).toEqual([UserRole.ADMIN, UserRole.MANAGER]);
    expect(
      Reflect.getMetadata(
        "roles",
        LoyaltyReconciliationV2Controller.prototype.export,
      ),
    ).toEqual([UserRole.ADMIN, UserRole.MANAGER]);
    expect(
      Reflect.getMetadata(
        "roles",
        LoyaltyReconciliationV2Controller.prototype.decide,
      ),
    ).toEqual([UserRole.ADMIN]);
  });

  it("denies reconciliation data to managers without both grants and to brokers", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findMany.mockResolvedValue([
      { permission: "RECONCILE" },
    ]);
    await expect(
      service.coverage({ base: "anna" }, manager),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.loyaltySourceRecord.findMany).not.toHaveBeenCalled();
    expect(() => service.definitions(broker)).toThrow(ForbiddenException);
  });

  it("allows a manager with READ_ALL and RECONCILE to inspect coverage", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findMany.mockResolvedValue([
      { permission: "READ_ALL" },
      { permission: "RECONCILE" },
    ]);
    await expect(
      service.coverage({ base: "anna" }, manager),
    ).resolves.toMatchObject({ snapshotId: "snapshot-1", base: "anna" });
  });

  it("keeps reconciliation decisions admin-only even with a manager grant", async () => {
    const { service } = harness();
    await expect(
      service.decide(
        {
          caseId: "case-1",
          action: "KEEP_SEPARATE",
          expectedVersion: 1,
          reason: "Checked",
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
