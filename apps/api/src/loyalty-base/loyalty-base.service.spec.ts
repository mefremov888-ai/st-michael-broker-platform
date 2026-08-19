import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  LoyaltyBaseService,
  loyaltyContentHash,
  normalizeLoyaltyContactPoint,
  positivePostgresBigIntOrNull,
} from "./loyalty-base.service";

const fn = () => jest.fn();

function prismaMock() {
  return {
    broker: { findMany: fn(), findUnique: fn(), count: fn(), update: fn() },
    agency: { findMany: fn(), findUnique: fn(), count: fn(), update: fn() },
    client: { count: fn() },
    meeting: { count: fn() },
    deal: { count: fn(), aggregate: fn(), groupBy: fn() },
    loyaltyDataset: { findUnique: fn(), upsert: fn(), update: fn() },
    loyaltySnapshot: { findUnique: fn(), create: fn(), update: fn() },
    loyaltyPerson: {
      createMany: fn(),
      findMany: fn(),
      update: fn(),
      updateMany: fn(),
    },
    loyaltyOrganization: {
      createMany: fn(),
      findMany: fn(),
      update: fn(),
      updateMany: fn(),
    },
    loyaltySourceRecord: {
      createMany: fn(),
      findMany: fn(),
      findFirst: fn(),
      count: fn(),
    },
    loyaltyContactPoint: { createMany: fn() },
    loyaltyExternalIdentity: { createMany: fn() },
    loyaltyActivity: {
      createMany: fn(),
      count: fn(),
      aggregate: fn(),
      groupBy: fn(),
    },
    loyaltyMetricSnapshot: { createMany: fn() },
    loyaltyPublicationEvent: { create: fn() },
    loyaltySourceFieldValue: { createMany: fn() },
    loyaltyPersonOrganizationRole: { createMany: fn() },
    loyaltyReconciliationCase: {
      createMany: fn(),
      findUnique: fn(),
      updateMany: fn(),
      findMany: fn(),
      count: fn(),
    },
    loyaltyEntityLink: {
      create: fn(),
      updateMany: fn(),
      findFirst: fn(),
      findMany: fn(),
      findUnique: fn(),
      count: fn(),
    },
    loyaltyEntityChange: { create: fn() },
    $transaction: fn(),
  } as any;
}

function importDocument(overrides: Record<string, unknown> = {}): any {
  return {
    sourceName: "anna-export.json",
    ruleVersion: "anna-v1",
    expectedRecords: 1,
    expectedUniquePhones: 1,
    expectedActivities: 0,
    expectedExternalIdentities: 2,
    expectedIncludedFixations: 0,
    expectedIncludedMeetings: 0,
    expectedIncludedDeals: 0,
    expectedIncludedBrokerTours: 0,
    expectedIncludedCalls: 0,
    expectedIncludedDealAmount: "0.00",
    records: [
      {
        externalKey: "anna-person-1",
        entityType: "BROKER",
        displayName: "Тестовая запись",
        contactPoints: [
          { type: "PHONE", value: "+7 (999) 000-00-01", isPrimary: true },
        ],
        externalIdentities: [
          { system: "AMOCRM", entityType: "CONTACT", externalId: "101" },
          { system: "AMOCRM", entityType: "CONTACT", externalId: "202" },
        ],
        activities: [],
      },
    ],
    ...overrides,
  };
}

describe("LoyaltyBaseService", () => {
  it("normalizes Russian phones without using a mutable name as identity", () => {
    expect(normalizeLoyaltyContactPoint("PHONE", "8 (999) 000-00-01")).toBe(
      "+79990000001",
    );
    expect(loyaltyContentHash({ b: 2, a: 1 })).toBe(
      loyaltyContentHash({ a: 1, b: 2 }),
    );
  });

  it.each([
    ["+7 925 123 45 67", "+79251234567"],
    ["8 (925) 123-45-67", "+79251234567"],
    ["925 123 45 67", "+79251234567"],
    ["+7 7 925 123 45 67", "+79251234567"],
    ["77925123456", null],
    ["+998 90 123 45 67", "+998901234567"],
    ["123", null],
  ] as const)(
    "normalizes phone %s according to the pinned v3 rules",
    (input, expected) => {
      expect(normalizeLoyaltyContactPoint("PHONE", input)).toBe(expected);
    },
  );

  it("accepts only positive PostgreSQL int8 values for amo lookup", () => {
    expect(positivePostgresBigIntOrNull("9223372036854775807")).toBe(
      9223372036854775807n,
    );
    expect(positivePostgresBigIntOrNull("9223372036854775808")).toBeNull();
    expect(positivePostgresBigIntOrNull("9".repeat(160))).toBeNull();
    expect(positivePostgresBigIntOrNull("0")).toBeNull();
  });

  it("dry-run is read-only and preserves multiple amo IDs", async () => {
    const prisma = prismaMock();
    prisma.broker.findMany.mockResolvedValue([]);
    prisma.agency.findMany.mockResolvedValue([]);
    const service = new LoyaltyBaseService(prisma);

    const result = await service.dryRunImport(importDocument());

    expect(result.publishable).toBe(true);
    expect(result.summary.externalIdentities).toBe(2);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.loyaltyDataset.upsert).not.toHaveBeenCalled();
    expect(prisma.broker.update).not.toHaveBeenCalled();
    expect(prisma.agency.update).not.toHaveBeenCalled();
  });

  it("stage requires the hash returned by dry-run before any write", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);

    await expect(
      service.stageImport(
        importDocument({ expectedContentHash: "0".repeat(64) }),
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.broker.findMany).not.toHaveBeenCalled();
  });

  it("rejects a staged import without an explicit expected record count", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const document = importDocument();
    delete document.expectedRecords;

    await expect(
      service.stageImport(document, "admin-1"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects stage when the active snapshot changed after dry-run consent", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.findMany.mockResolvedValue([]);
    prisma.agency.findMany.mockResolvedValue([]);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-a",
      activeSnapshot: {
        id: "snapshot-a",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        recordCount: 1,
        brokerCount: 1,
        agencyCount: 0,
        activityCount: 0,
        summary: {},
      },
    });
    const document = importDocument();
    const dryRun = await service.dryRunImport(document);
    document.expectedContentHash = dryRun.contentHash;
    document.expectedActiveSnapshotId = dryRun.expectedActiveSnapshotId;
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-b",
      activeSnapshot: {
        id: "snapshot-b",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        recordCount: 2,
        brokerCount: 2,
        agencyCount: 0,
        activityCount: 0,
        summary: {},
      },
    });

    await expect(
      service.stageImport(document, "admin-1"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("UNKNOWN activity remains auditable but is excluded from metrics and money", async () => {
    const prisma = prismaMock();
    prisma.broker.findMany.mockResolvedValue([]);
    prisma.agency.findMany.mockResolvedValue([]);
    const service = new LoyaltyBaseService(prisma);
    const raw = importDocument({
      expectedUniquePhones: 0,
      expectedActivities: 2,
      expectedExternalIdentities: 0,
      expectedIncludedDeals: 1,
      expectedIncludedDealAmount: "10.00",
      records: [
        {
          externalKey: "anna-person-1",
          entityType: "BROKER",
          displayName: "Тестовая запись",
          contactPoints: [],
          externalIdentities: [],
          activities: [
            {
              sourceSystem: "AMOCRM",
              externalId: "deal-included",
              type: "DEAL",
              occurredAt: "2026-08-01T10:00:00.000Z",
              amount: "10.00",
              currency: "RUB",
              contractType: "DDU",
              verdict: "INCLUDED",
            },
            {
              sourceSystem: "AMOCRM",
              externalId: "deal-unknown",
              type: "DEAL",
              occurredAt: "2026-08-02T10:00:00.000Z",
              amount: "999.00",
              verdict: "UNKNOWN",
            },
          ],
        },
      ],
    });
    const dryRun = await service.dryRunImport(raw);
    raw.expectedContentHash = dryRun.contentHash;
    raw.expectedActiveSnapshotId = dryRun.expectedActiveSnapshotId;

    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltyDataset.upsert.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: null,
    });
    prisma.loyaltySnapshot.findUnique.mockResolvedValue(null);
    prisma.loyaltySnapshot.create.mockResolvedValue({
      id: "snapshot-1",
      contentHash: dryRun.contentHash,
      status: "STAGED",
    });
    prisma.loyaltyPerson.findMany.mockResolvedValue([
      { id: "person-1", externalKey: "anna-person-1" },
    ]);
    prisma.loyaltyOrganization.findMany.mockResolvedValue([]);
    for (const delegate of [
      prisma.loyaltyPerson,
      prisma.loyaltyOrganization,
      prisma.loyaltySourceRecord,
      prisma.loyaltyContactPoint,
      prisma.loyaltyExternalIdentity,
      prisma.loyaltyActivity,
      prisma.loyaltyMetricSnapshot,
      prisma.loyaltySourceFieldValue,
      prisma.loyaltyPersonOrganizationRole,
      prisma.loyaltyReconciliationCase,
    ])
      delegate.createMany.mockResolvedValue({ count: 1 });

    await service.stageImport(raw, "admin-1");

    const metricBatch =
      prisma.loyaltyMetricSnapshot.createMany.mock.calls[0][0].data;
    expect(metricBatch[0]).toMatchObject({ dealCount: 1, dealAmount: "10.00" });
    const activityBatch =
      prisma.loyaltyActivity.createMany.mock.calls[0][0].data;
    expect(activityBatch).toHaveLength(2);
    expect(activityBatch.map((item: any) => item.verdict)).toEqual([
      "INCLUDED",
      "UNKNOWN",
    ]);
  });

  it("publishes by one serializable pointer switch and validates previous ownership", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltySnapshot.findUnique
      .mockResolvedValueOnce({
        id: "snapshot-new",
        datasetId: "dataset-1",
        status: "STAGED",
        contentHash: "a".repeat(64),
        ruleVersion: "anna-v1",
        errorCount: 0,
        expectedRecords: 1,
        recordCount: 1,
        dataset: {
          id: "dataset-1",
          code: "ANNA",
          activeSnapshotId: "snapshot-old",
        },
      })
      .mockResolvedValueOnce({ datasetId: "dataset-1", recordCount: 1 });
    prisma.loyaltySourceRecord.count.mockResolvedValue(1);
    prisma.loyaltySnapshot.update.mockResolvedValue({});
    prisma.loyaltyDataset.update.mockResolvedValue({});

    const result = await service.publishSnapshot(
      "snapshot-new",
      {
        confirmed: true,
        expectedContentHash: "a".repeat(64),
        expectedActiveSnapshotId: "snapshot-old",
      },
      "admin-1",
    );

    expect(result.status).toBe("PUBLISHED");
    expect(prisma.loyaltySnapshot.update).toHaveBeenNthCalledWith(1, {
      where: { id: "snapshot-old" },
      data: { status: "SUPERSEDED" },
    });
    expect(prisma.loyaltyDataset.update).toHaveBeenCalledWith({
      where: { id: "dataset-1" },
      data: { activeSnapshotId: "snapshot-new" },
    });
    expect(prisma.loyaltyPublicationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        datasetId: "dataset-1",
        snapshotId: "snapshot-new",
        previousSnapshotId: "snapshot-old",
        contentHash: "a".repeat(64),
        ruleVersion: "anna-v1",
        isRollback: false,
        actorId: "admin-1",
      }),
    });
    expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({
      isolationLevel: "Serializable",
    });
  });

  it("requires explicit publish confirmation", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    await expect(
      service.publishSnapshot("snapshot-1", {
        confirmed: false,
        expectedContentHash: "a".repeat(64),
        expectedActiveSnapshotId: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not duplicate publication history on an idempotent publish retry", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltySnapshot.findUnique.mockResolvedValue({
      id: "snapshot-1",
      datasetId: "dataset-1",
      status: "PUBLISHED",
      contentHash: "a".repeat(64),
      ruleVersion: "anna-v1",
      errorCount: 0,
      expectedRecords: 1,
      recordCount: 1,
      publishedAt: new Date("2026-08-01T00:00:00Z"),
      dataset: {
        id: "dataset-1",
        code: "ANNA",
        activeSnapshotId: "snapshot-1",
      },
    });
    prisma.loyaltySourceRecord.count.mockResolvedValue(1);

    const result = await service.publishSnapshot(
      "snapshot-1",
      {
        confirmed: true,
        expectedContentHash: "a".repeat(64),
        expectedActiveSnapshotId: null,
      },
      "admin-1",
    );

    expect(result.idempotent).toBe(true);
    expect(prisma.loyaltyPublicationEvent.create).not.toHaveBeenCalled();
    expect(prisma.loyaltyDataset.update).not.toHaveBeenCalled();
  });

  it("refuses to publish a snapshot without a persisted expected record count", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltySnapshot.findUnique.mockResolvedValue({
      id: "snapshot-1",
      datasetId: "dataset-1",
      status: "STAGED",
      contentHash: "a".repeat(64),
      ruleVersion: "anna-v1",
      errorCount: 0,
      expectedRecords: null,
      recordCount: 1,
      dataset: { id: "dataset-1", code: "ANNA", activeSnapshotId: null },
    });

    await expect(
      service.publishSnapshot("snapshot-1", {
        confirmed: true,
        expectedContentHash: "a".repeat(64),
        expectedActiveSnapshotId: null,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyDataset.update).not.toHaveBeenCalled();
  });

  it("rejecting a candidate never revokes an existing unrelated link or writes Broker", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const reconciliationCase = {
      id: "case-1",
      snapshotId: "snapshot-1",
      version: 1,
      status: "OPEN",
      personId: "person-1",
      organizationId: null,
      targetType: "BROKER",
      targetId: "broker-1",
      matchCodes: ["PHONE_EXACT"],
      ruleVersion: "anna-v1",
    };
    prisma.loyaltyReconciliationCase.findUnique.mockResolvedValue(
      reconciliationCase,
    );
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
      },
    });
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltyReconciliationCase.updateMany.mockResolvedValue({ count: 1 });

    await service.decideReconciliation(
      { caseId: "case-1", decision: "REJECT_MATCH", expectedVersion: 1 },
      "admin-1",
    );

    expect(prisma.loyaltyEntityLink.updateMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyEntityLink.create).not.toHaveBeenCalled();
    expect(prisma.broker.update).not.toHaveBeenCalled();
  });

  it("refuses a decision for a stale snapshot", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyReconciliationCase.findUnique.mockResolvedValue({
      id: "case-old",
      snapshotId: "snapshot-old",
      version: 1,
      status: "OPEN",
      personId: "person-1",
      targetType: "BROKER",
      targetId: "broker-1",
    });
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-new",
      activeSnapshot: {
        id: "snapshot-new",
        datasetId: "dataset-1",
        status: "PUBLISHED",
      },
    });

    await expect(
      service.decideReconciliation({
        caseId: "case-old",
        decision: "LINK",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects snapshot-global duplicate activities before staging", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const document = importDocument({
      expectedRecords: 2,
      expectedUniquePhones: 0,
      expectedActivities: 1,
      expectedExternalIdentities: 0,
      records: [
        {
          externalKey: "p-1",
          entityType: "BROKER",
          displayName: "One",
          activities: [
            {
              sourceSystem: "AMOCRM",
              externalId: "same",
              type: "CALL",
              occurredAt: "2026-08-01T10:00:00Z",
            },
          ],
        },
        {
          externalKey: "p-2",
          entityType: "BROKER",
          displayName: "Two",
          activities: [
            {
              sourceSystem: "AMOCRM",
              externalId: "same",
              type: "CALL",
              occurredAt: "2026-08-02T10:00:00Z",
            },
          ],
        },
      ],
    });

    const result = await service.dryRunImport(document);

    expect(result.publishable).toBe(false);
    expect(result.issues).toContainEqual({
      row: 2,
      code: "DUPLICATE_ACTIVITY_GLOBAL",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects cross-system activity identity references and out-of-range amo IDs safely", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const result = await service.dryRunImport(
      importDocument({
        expectedUniquePhones: 0,
        expectedActivities: 1,
        expectedExternalIdentities: 2,
        records: [
          {
            externalKey: "p-1",
            entityType: "BROKER",
            displayName: "One",
            externalIdentities: [
              {
                system: "GOOGLE_SHEETS",
                entityType: "CONTACT",
                externalId: "shared",
              },
              {
                system: "AMOCRM",
                entityType: "CONTACT",
                externalId: "999999999999999999999999999",
              },
            ],
            activities: [
              {
                sourceSystem: "AMOCRM",
                externalId: "call-1",
                externalIdentityId: "shared",
                type: "CALL",
                occurredAt: "2026-08-01T10:00:00Z",
              },
            ],
          },
        ],
      }),
    );

    expect(result.issues).toEqual(
      expect.arrayContaining([
        { row: 1, code: "AMO_CONTACT_ID_OUT_OF_RANGE" },
        { row: 1, code: "UNKNOWN_EXTERNAL_IDENTITY_REFERENCE" },
      ]),
    );
    expect(prisma.broker.findMany).not.toHaveBeenCalled();
  });

  it("rejects duplicate organization roles instead of silently dropping them on stage", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const result = await service.dryRunImport(
      importDocument({
        expectedRecords: 2,
        expectedUniquePhones: 0,
        expectedExternalIdentities: 0,
        records: [
          {
            externalKey: "agency-1",
            entityType: "AGENCY",
            displayName: "Agency",
          },
          {
            externalKey: "broker-1",
            entityType: "BROKER",
            displayName: "Broker",
            organizationRoles: [
              { organizationExternalKey: "agency-1", role: "AGENT" },
              { organizationExternalKey: "agency-1", role: "AGENT" },
            ],
          },
        ],
      }),
    );

    expect(result.publishable).toBe(false);
    expect(result.issues).toContainEqual({
      row: 2,
      code: "DUPLICATE_ORGANIZATION_ROLE",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("chunks large reconciliation candidate phone lookups", async () => {
    const prisma = prismaMock();
    prisma.broker.findMany.mockResolvedValue([]);
    const service = new LoyaltyBaseService(prisma);
    const records = Array.from({ length: 501 }, (_, index) => ({
      externalKey: `broker-${index}`,
      entityType: "BROKER",
      displayName: `Broker ${index}`,
      contactPoints: [
        { type: "PHONE", value: `+79${String(index).padStart(9, "0")}` },
      ],
    }));

    const result = await service.dryRunImport(
      importDocument({
        expectedRecords: records.length,
        expectedUniquePhones: records.length,
        expectedExternalIdentities: 0,
        records,
      }),
    );

    expect(result.publishable).toBe(true);
    expect(prisma.broker.findMany).toHaveBeenCalledTimes(2);
    expect(
      prisma.broker.findMany.mock.calls.map(
        (call: any[]) => call[0].where.OR[0].phone.in.length,
      ),
    ).toEqual([500, 1]);
  });

  it("rejects a per-record Decimal(18,2) deal aggregate overflow during dry-run", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const result = await service.dryRunImport(
      importDocument({
        expectedUniquePhones: 0,
        expectedActivities: 2,
        expectedExternalIdentities: 0,
        expectedIncludedDeals: 2,
        expectedIncludedDealAmount: "9999999999999999.99",
        records: [
          {
            externalKey: "p-1",
            entityType: "BROKER",
            displayName: "One",
            activities: ["deal-1", "deal-2"].map((externalId) => ({
              sourceSystem: "AMOCRM",
              externalId,
              type: "DEAL",
              occurredAt: "2026-08-01T10:00:00Z",
              amount: "9999999999999999.99",
              currency: "RUB",
              contractType: "DDU",
              verdict: "INCLUDED",
            })),
          },
        ],
      }),
    );

    expect(result.publishable).toBe(false);
    expect(result.issues).toContainEqual({
      row: 1,
      code: "DEAL_AMOUNT_AGGREGATE_OVERFLOW",
    });
  });

  it("blocks a first publish dry-run when INCLUDED deal controls do not match", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const result = await service.dryRunImport(
      importDocument({
        expectedIncludedDeals: 1,
        expectedIncludedDealAmount: "1500000.00",
      }),
    );

    expect(result.publishable).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { row: 0, code: "EXPECTED_INCLUDED_DEAL_COUNT_MISMATCH" },
        { row: 0, code: "EXPECTED_INCLUDED_DEAL_AMOUNT_MISMATCH" },
      ]),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("reconfirms an exact per-type and deal-amount coverage drop even when totals match", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltySnapshot.findUnique
      .mockResolvedValueOnce({
        id: "small",
        datasetId: "dataset-1",
        status: "STAGED",
        contentHash: "b".repeat(64),
        ruleVersion: "anna-v1",
        errorCount: 0,
        expectedRecords: 1,
        recordCount: 1,
        brokerCount: 1,
        agencyCount: 0,
        activityCount: 1,
        summary: {
          uniqueNormalizedPhones: 0,
          externalIdentities: 0,
          includedActivities: 1,
          includedDeals: 0,
          includedCalls: 1,
          includedDealAmount: "0.00",
        },
        dataset: { id: "dataset-1", code: "ANNA", activeSnapshotId: "large" },
      })
      .mockResolvedValueOnce({
        datasetId: "dataset-1",
        recordCount: 1,
        brokerCount: 1,
        agencyCount: 0,
        activityCount: 1,
        summary: {
          uniqueNormalizedPhones: 0,
          externalIdentities: 0,
          includedActivities: 1,
          includedDeals: 1,
          includedCalls: 0,
          includedDealAmount: "10.00",
        },
      });
    prisma.loyaltySourceRecord.count.mockResolvedValue(1);

    await expect(
      service.publishSnapshot("small", {
        confirmed: true,
        expectedContentHash: "b".repeat(64),
        expectedActiveSnapshotId: "large",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyDataset.update).not.toHaveBeenCalled();
  });

  it("allows UNLINK only for the resolved LINK case", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyReconciliationCase.findUnique.mockResolvedValue({
      id: "case-open",
      snapshotId: "snapshot-1",
      version: 1,
      status: "OPEN",
      decision: null,
      personId: "person-1",
      targetType: "BROKER",
      targetId: "broker-1",
    });
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
      },
    });

    await expect(
      service.decideReconciliation({
        caseId: "case-open",
        decision: "UNLINK",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows a current snapshot case to unlink the same-target link created by an older case", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const currentCase = {
      id: "case-new",
      snapshotId: "snapshot-1",
      version: 1,
      status: "OPEN",
      decision: null,
      personId: "person-1",
      organizationId: null,
      targetType: "BROKER",
      targetId: "broker-1",
      matchCodes: ["AMO_ID_EXACT"],
      ruleVersion: "anna-v1",
    };
    prisma.loyaltyReconciliationCase.findUnique.mockResolvedValue(currentCase);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
      },
    });
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.broker.findUnique.mockResolvedValue({ id: "broker-1" });
    prisma.loyaltyReconciliationCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyEntityLink.findFirst.mockResolvedValue({
      id: "link-old",
      personId: "person-1",
      targetType: "BROKER",
      targetId: "broker-1",
      reconciliationCaseId: "case-old",
      status: "CONFIRMED",
      revokedAt: null,
    });

    await service.decideReconciliation({
      caseId: "case-new",
      decision: "LINK",
      expectedVersion: 1,
    });
    expect(prisma.loyaltyEntityLink.create).not.toHaveBeenCalled();

    prisma.loyaltyReconciliationCase.findUnique.mockResolvedValue({
      ...currentCase,
      version: 2,
      status: "RESOLVED",
      decision: "LINK",
    });
    prisma.loyaltyEntityLink.updateMany.mockResolvedValue({ count: 1 });
    await service.decideReconciliation({
      caseId: "case-new",
      decision: "UNLINK",
      expectedVersion: 2,
    });
    expect(prisma.loyaltyEntityLink.updateMany).toHaveBeenCalledWith({
      where: {
        personId: "person-1",
        status: "CONFIRMED",
        revokedAt: null,
        targetType: "BROKER",
        targetId: "broker-1",
      },
      data: {
        status: "REVOKED",
        revokedAt: expect.any(Date),
        revokedById: null,
      },
    });
  });

  it("uses the same filtered fixation count and confirmed DDU amount in OUR detail", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.findUnique.mockResolvedValue({
      id: "broker-1",
      fullName: "Broker",
      phone: "+79990000001",
      phones: [],
      brokerAgencies: [],
      mergedIntoId: null,
      _count: { clients: 2, deals: 1, meetings: 1, calls: 3 },
    });
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: "1250000.00" } });

    const result = await service.detail("ours", "BROKER", "broker-1");

    expect(result.item.metrics).toMatchObject({
      fixations: 2,
      deals: 1,
      dealAmount: "1250000.00",
    });
    expect(
      prisma.broker.findUnique.mock.calls[0][0].include._count.select.clients
        .where,
    ).toEqual({ fixationStatus: "FIXED" });
    expect(prisma.deal.aggregate.mock.calls[0][0].where).toMatchObject({
      brokerId: "broker-1",
      contractType: "DDU",
      amount: { gt: 0 },
      status: { in: ["SIGNED", "PAID", "COMMISSION_PAID"] },
    });
  });

  it("includes broker contacts only in OUR agency detail", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.agency.findUnique.mockResolvedValue({
      id: "agency-1",
      name: "Agency",
      inn: "7700000000",
      phone: "+74950000000",
      brokerAgencies: [
        {
          isPrimary: true,
          broker: {
            id: "broker-1",
            fullName: "Broker",
            phone: "+79990000001",
            email: "broker@example.test",
          },
        },
      ],
      _count: { brokerAgencies: 1, deals: 0 },
    });
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: null } });

    const result = await service.detail("ours", "AGENCY", "agency-1");

    expect(
      prisma.agency.findUnique.mock.calls[0][0].include.brokerAgencies.include
        .broker.select,
    ).toEqual({ id: true, fullName: true, phone: true, email: true });
    expect(result.item.brokers).toEqual([
      expect.objectContaining({
        id: "broker-1",
        displayName: "Broker",
        isPrimary: true,
        contactPoints: [
          { type: "PHONE", maskedValue: "+7***01", isPrimary: true },
          { type: "EMAIL", maskedValue: "b***@example.test", isPrimary: true },
        ],
      }),
    ]);
  });

  it("can optimistically revoke an orphan active link without a current reconciliation case", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltyEntityLink.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyEntityLink.findUnique.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      status: "REVOKED",
      version: 4,
    });

    const result = await service.unlinkActiveLink(
      {
        linkId: "11111111-1111-4111-8111-111111111111",
        expectedVersion: 3,
      },
      "admin-1",
    );

    expect(result.status).toBe("REVOKED");
    expect(prisma.loyaltyEntityLink.updateMany).toHaveBeenCalledWith({
      where: {
        id: "11111111-1111-4111-8111-111111111111",
        version: 3,
        status: "CONFIRMED",
        revokedAt: null,
        OR: [
          { person: { is: { dataset: { is: { code: "ANNA" } } } } },
          { organization: { is: { dataset: { is: { code: "ANNA" } } } } },
        ],
      },
      data: {
        status: "REVOKED",
        revokedAt: expect.any(Date),
        revokedById: "admin-1",
        version: { increment: 1 },
      },
    });
  });

  it("lists active and orphan links with owner/target names but no contacts", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-2",
      activeSnapshot: {
        id: "snapshot-2",
        datasetId: "dataset-1",
        status: "PUBLISHED",
      },
    });
    prisma.loyaltyEntityLink.findMany.mockResolvedValue([
      {
        id: "link-1",
        version: 2,
        personId: "person-1",
        organizationId: null,
        targetType: "BROKER",
        targetId: "broker-1",
        reconciliationCaseId: "case-old",
        decidedAt: new Date("2026-08-01T00:00:00Z"),
        ruleVersion: "anna-v1",
        person: { manualDisplayName: null, sourceRecords: [] },
        organization: null,
      },
    ]);
    prisma.loyaltyEntityLink.count.mockResolvedValue(1);
    prisma.broker.findMany.mockResolvedValue([
      { id: "broker-1", fullName: "Наш брокер" },
    ]);

    const result = await service.activeLinks({ page: 1, pageSize: 30 });

    expect(result.items[0]).toMatchObject({
      id: "link-1",
      version: 2,
      ownerName: "Нет в активном снимке",
      targetName: "Наш брокер",
      presentInActiveSnapshot: false,
    });
    expect(result.items[0]).not.toHaveProperty("contactPoints");
  });

  it("excludes archived Anna owners from headline activity KPIs", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        ruleVersion: "anna-v1",
        publishedAt: new Date(),
      },
    });
    prisma.loyaltySourceRecord.count.mockResolvedValue(0);
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    prisma.loyaltyActivity.count.mockResolvedValue(0);
    prisma.loyaltyActivity.aggregate.mockResolvedValue({
      _sum: { amount: null },
    });
    prisma.loyaltyActivity.groupBy.mockResolvedValue([]);

    await service.overview("anna", {});

    expect(
      prisma.loyaltyActivity.count.mock.calls[0][0].where.sourceRecord,
    ).toEqual({
      snapshotId: "snapshot-1",
      sourceArchivedAt: null,
      OR: [
        { entityType: "BROKER", person: { is: { archivedAt: null } } },
        { entityType: "AGENCY", organization: { is: { archivedAt: null } } },
      ],
    });
  });

  it("uses exact normalized DD.MM birthday parsing for the Anna drill-down", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const today = `${String(shifted.getUTCDate()).padStart(2, "0")}.${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([
      { id: "exact", attributes: { birthday: today } },
      { id: "malformed", attributes: { birthday: `${today}0/foo` } },
    ]);

    const ids = await (service as any).annaBirthdayRecordIds("snapshot-1");

    expect(ids).toEqual(["exact"]);
  });

  it("does not generate reconciliation candidates for archived source records", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const result = await service.dryRunImport(
      importDocument({
        records: [
          {
            ...importDocument().records[0],
            archived: true,
          },
        ],
      }),
    );

    expect(result.publishable).toBe(true);
    expect(result.summary.candidateCount).toBe(0);
    expect(prisma.broker.findMany).not.toHaveBeenCalled();
    expect(prisma.agency.findMany).not.toHaveBeenCalled();
  });

  it("filters archived source and stable owners from reconciliation reads", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
      },
    });
    prisma.loyaltyReconciliationCase.findMany.mockResolvedValue([]);
    prisma.loyaltyReconciliationCase.count.mockResolvedValue(0);

    await service.reconciliation({ page: 1, pageSize: 30 });

    const where =
      prisma.loyaltyReconciliationCase.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      snapshotId: "snapshot-1",
      AND: [
        {
          OR: [
            {
              person: {
                is: {
                  archivedAt: null,
                  sourceRecords: {
                    some: {
                      snapshotId: "snapshot-1",
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
                      snapshotId: "snapshot-1",
                      sourceArchivedAt: null,
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    });
  });

  it("finds Anna records with zero reconciliation cases in the active snapshot", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
      },
    });
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([
      {
        personId: "person-1",
        organizationId: null,
        entityType: "BROKER",
        displayName: "Только у Анны",
        city: null,
        contactPoints: [{ type: "PHONE", value: "+79990000001" }],
      },
    ]);
    prisma.loyaltySourceRecord.count.mockResolvedValue(1);

    const result = await service.unmatchedAnnaRecords({
      page: 1,
      pageSize: 30,
    });

    const where = prisma.loyaltySourceRecord.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      OR: [
        {
          entityType: "BROKER",
          snapshotId: "snapshot-1",
          sourceArchivedAt: null,
          person: {
            is: {
              archivedAt: null,
              reconciliationCases: { none: { snapshotId: "snapshot-1" } },
            },
          },
        },
        {
          entityType: "AGENCY",
          snapshotId: "snapshot-1",
          sourceArchivedAt: null,
          organization: {
            is: {
              archivedAt: null,
              reconciliationCases: { none: { snapshotId: "snapshot-1" } },
            },
          },
        },
      ],
    });
    expect(result.total).toBe(1);
    expect(result.items[0].hasValidPhone).toBe(true);
    // Contact values must never leave the service unmasked.
    expect(result.items[0].contacts[0].maskedValue).not.toBe("+79990000001");
  });

  it("returns empty unmatched-Anna results when there is no published snapshot", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue(null);

    const result = await service.unmatchedAnnaRecords({
      page: 1,
      pageSize: 30,
    });

    expect(result).toEqual({
      items: [],
      page: 1,
      pageSize: 30,
      total: 0,
      totalPages: 0,
    });
    expect(prisma.loyaltySourceRecord.findMany).not.toHaveBeenCalled();
  });

  it("excludes matched brokers/agencies and paginates across the two lists", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
      },
    });
    prisma.loyaltyReconciliationCase.findMany
      .mockResolvedValueOnce([{ targetId: "broker-matched" }])
      .mockResolvedValueOnce([{ targetId: "agency-matched" }]);
    prisma.broker.count.mockResolvedValue(1);
    prisma.agency.count.mockResolvedValue(1);
    prisma.broker.findMany.mockResolvedValue([
      {
        id: "broker-unmatched",
        fullName: "Только в кабинете",
        phone: "+79990000002",
        amoContactId: null,
      },
    ]);
    prisma.agency.findMany.mockResolvedValue([]);

    const result = await service.unmatchedCabinetEntities({
      page: 1,
      pageSize: 30,
    });

    expect(prisma.broker.findMany.mock.calls[0][0].where).toMatchObject({
      role: "BROKER",
      mergedIntoId: null,
      id: { notIn: ["broker-matched"] },
    });
    expect(result.total).toBe(2);
    expect(result.items[0]).toMatchObject({
      id: "broker-unmatched",
      entityType: "BROKER",
    });
  });

  it("updates an Anna entity with an optimistic timestamp and audits before/after", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const expectedUpdatedAt = "2026-08-18T10:00:00.000Z";
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
    });
    prisma.loyaltySourceRecord.findFirst.mockResolvedValue({
      id: "record-1",
      displayName: "Source name",
      person: {
        id: "person-1",
        manualDisplayName: "Old override",
        manualCity: null,
        manualAttributes: { level: 1 },
        archivedAt: null,
        updatedAt: new Date(expectedUpdatedAt),
      },
      organization: null,
    });
    prisma.loyaltyPerson.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    jest
      .spyOn(service, "detail")
      .mockResolvedValue({ item: { id: "person-1" } } as any);

    await service.updateAnnaEntity(
      "BROKER",
      "person-1",
      {
        expectedUpdatedAt,
        displayName: "New override",
        attributes: { level: 2 },
      },
      "admin-1",
    );

    expect(prisma.loyaltyPerson.updateMany).toHaveBeenCalledWith({
      where: { id: "person-1", updatedAt: new Date(expectedUpdatedAt) },
      data: {
        manualDisplayName: "New override",
        manualAttributes: { level: 2 },
        updatedAt: expect.any(Date),
      },
    });
    expect(prisma.loyaltyEntityChange.create).toHaveBeenCalledWith({
      data: {
        personId: "person-1",
        organizationId: null,
        action: "UPDATE",
        changedFields: ["displayName", "attributes"],
        beforeValues: {
          displayName: "Old override",
          attributes: { level: 1 },
        },
        afterValues: {
          displayName: "New override",
          attributes: { level: 2 },
        },
        actorId: "admin-1",
      },
    });
    expect(prisma.loyaltyPerson.update).not.toHaveBeenCalled();
  });

  it("returns conflict and writes no audit when an Anna entity token is stale", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const expectedUpdatedAt = "2026-08-18T10:00:00.000Z";
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
    });
    prisma.loyaltySourceRecord.findFirst.mockResolvedValue({
      id: "record-1",
      person: {
        id: "person-1",
        manualDisplayName: null,
        manualCity: null,
        manualAttributes: null,
        archivedAt: null,
        updatedAt: new Date("2026-08-18T10:01:00.000Z"),
      },
      organization: null,
    });
    prisma.loyaltyPerson.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updateAnnaEntity(
        "BROKER",
        "person-1",
        { expectedUpdatedAt, displayName: "Stale write" },
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyEntityChange.create).not.toHaveBeenCalled();
    expect(prisma.loyaltySourceFieldValue.createMany).not.toHaveBeenCalled();
  });
});
