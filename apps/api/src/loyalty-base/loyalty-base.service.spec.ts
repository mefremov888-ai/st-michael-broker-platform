import {
  BadRequestException,
  ConflictException,
  GoneException,
} from "@nestjs/common";
import {
  AGENCY_KEY_ALIASES,
  LoyaltyBaseService,
  MAX_LOYALTY_CLI_IMPORT_BYTES,
  activeFixationClientWhere,
  canonicalAgencyMatchKey,
  explicitGeography,
  isLoyaltyAcquisitionPhone,
  loyaltyContentHash,
  moscowCurrentMonthFilterPeriod,
  normalizeAgencyMatchKey,
  normalizeLoyaltyContactPoint,
  positivePostgresBigIntOrNull,
} from "./loyalty-base.service";

const fn = () => jest.fn();

describe("loyalty filter boundary helpers", () => {
  it("keeps Moscow calendar month boundaries instead of the preceding UTC date", () => {
    expect(
      moscowCurrentMonthFilterPeriod(new Date("2026-09-01T00:15:00.000+03:00")),
    ).toMatchObject({ fromIso: "2026-09-01", toIso: "2026-09-30" });
  });

  it("keeps missing geography unknown instead of coercing it to REGION", () => {
    expect(explicitGeography([null, ""])).toBeNull();
    expect(explicitGeography(["Не указано"])).toBeNull();
    expect(explicitGeography(["Москва"])).toBe("MOSCOW");
    expect(explicitGeography(["Тула"])).toBe("REGION");
    expect(explicitGeography([], true)).toBe("REGION");
    expect(explicitGeography([], false)).toBe("MOSCOW");
  });

  it("normalizes agency names to one match key across legal forms and quotes", () => {
    expect(normalizeAgencyMatchKey('ООО "Ромашка"')).toBe("ромашка");
    expect(normalizeAgencyMatchKey("АН «Ромашка»")).toBe("ромашка");
    expect(normalizeAgencyMatchKey("  ромашка  ")).toBe("ромашка");
    expect(normalizeAgencyMatchKey("Этажи Москва")).toBe("этажимосква");
    // Название из одних стоп-слов не схлопывается в пустой ключ.
    expect(normalizeAgencyMatchKey("АН")).toBe("ан");
    expect(normalizeAgencyMatchKey("")).toBeNull();
    expect(normalizeAgencyMatchKey(null)).toBeNull();
    // Разные названия не совпадают.
    expect(normalizeAgencyMatchKey("ООО Ромашка")).not.toBe(
      normalizeAgencyMatchKey("ООО Василёк"),
    );
  });

  it("maps historical registry agency names onto the canonical card key", () => {
    // «Trend Agent» из реестра и карточка «ООО «Онлайн Недвижимость»» —
    // один ключ через алиас.
    expect(canonicalAgencyMatchKey("Trend Agent")).toBe(
      canonicalAgencyMatchKey("ООО «Онлайн Недвижимость»"),
    );
    expect(canonicalAgencyMatchKey("Нмаркет.Про")).toBe(
      canonicalAgencyMatchKey("Нмаркет"),
    );
    // Значения алиасов — валидные нормализованные ключи.
    for (const [alias, target] of Object.entries(AGENCY_KEY_ALIASES)) {
      expect(normalizeAgencyMatchKey(alias)).toBe(alias);
      expect(normalizeAgencyMatchKey(target)).toBe(target);
    }
    // Без алиаса поведение идентично normalizeAgencyMatchKey.
    expect(canonicalAgencyMatchKey('ООО "Ромашка"')).toBe("ромашка");
    expect(canonicalAgencyMatchKey("")).toBeNull();
    expect(canonicalAgencyMatchKey(null)).toBeNull();
  });

  it("excludes Moscow landlines from broker acquisition", () => {
    expect(isLoyaltyAcquisitionPhone("+7 495 123-45-67")).toBe(false);
    expect(isLoyaltyAcquisitionPhone("8 (499) 123-45-67")).toBe(false);
    expect(isLoyaltyAcquisitionPhone("+7 916 123-45-67")).toBe(true);
    expect(isLoyaltyAcquisitionPhone("not-a-phone")).toBe(false);
  });
});

function prismaMock() {
  return {
    broker: { findMany: fn(), findUnique: fn(), count: fn(), update: fn() },
    agency: { findMany: fn(), findUnique: fn(), count: fn(), update: fn() },
    client: { count: fn(), groupBy: fn() },
    meeting: { count: fn(), groupBy: fn() },
    deal: {
      count: fn(),
      aggregate: fn(),
      groupBy: fn(),
      // Топ-агентство считается правилом карточки (union строк) — по
      // умолчанию сделок нет, чтобы старые тесты видели прежние числа.
      findMany: jest.fn().mockResolvedValue([]),
    },
    // «Реестр сделок» (registry_deals): по умолчанию пустой источник, чтобы
    // существующие тесты видели прежние числа.
    registryDeal: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: null } }),
    },
    brokerAgency: { findMany: jest.fn().mockResolvedValue([]) },
    loyaltyDataset: { findUnique: fn(), upsert: fn(), update: fn() },
    loyaltySnapshot: { findUnique: fn(), create: fn(), update: fn() },
    loyaltyPerson: {
      createMany: fn(),
      findUnique: fn(),
      findMany: fn(),
      update: fn(),
      updateMany: fn(),
    },
    loyaltyOrganization: {
      createMany: fn(),
      findUnique: fn(),
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
    loyaltyContactPoint: { createMany: fn(), count: fn() },
    loyaltyExternalIdentity: { createMany: fn(), count: fn() },
    loyaltyActivity: {
      createMany: fn(),
      count: fn(),
      aggregate: fn(),
      groupBy: fn(),
    },
    loyaltyMetricSnapshot: { createMany: fn(), count: fn() },
    loyaltySourceAggregate: { createMany: fn(), count: fn(), findMany: fn() },
    loyaltyPublicationEvent: { create: fn() },
    loyaltySourceFieldValue: { createMany: fn() },
    loyaltyPersonOrganizationRole: { createMany: fn(), count: fn() },
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
    loyaltyEntityChange: { create: fn(), findMany: fn(), count: fn() },
    loyaltyManualEntity: { findMany: fn(), findFirst: fn(), updateMany: fn() },
    loyaltyCallAssignment: { updateMany: fn() },
    loyaltyCallAttempt: { findMany: fn() },
    loyaltyEngagementEvent: { findMany: fn() },
    loyaltySyncRun: {
      findUnique: jest.fn(({ where }: any) => {
        const matched = String(where?.id || "").match(/-(\d+)$/);
        const coveredRecords = matched ? Number(matched[1]) : 1;
        return Promise.resolve({
          id: where?.id,
          source: "AMOCRM",
          status: "SUCCEEDED",
          contentHash: "a".repeat(64),
          completedAt: new Date("2026-08-22T00:00:00.000Z"),
          counts: {
            complete: true,
            readAt: "2026-08-21T23:59:59.000Z",
            eventCoverageComplete: true,
            coveredRecords,
            activityRuleVersion: "anna-v1",
            activityTypes: [
              "FIXATION",
              "MEETING",
              "DEAL",
              "BROKER_TOUR",
              "CALL",
            ],
          },
        });
      }),
    },
    auditLog: { create: fn() },
    $transaction: fn(),
  } as any;
}

function importDocument(overrides: Record<string, unknown> = {}): any {
  const document: any = {
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
  if (
    Number(document.expectedActivities) > 0 &&
    !Object.prototype.hasOwnProperty.call(overrides, "activityCoverage")
  ) {
    document.activityCoverage = {
      mode: "FULL_SNAPSHOT",
      coveredRecords: document.records.length,
      activityTypes: ["FIXATION", "MEETING", "DEAL", "BROKER_TOUR", "CALL"],
      sourceRunId: `test-full-scan-${document.records.length}`,
      sourceContentHash: "a".repeat(64),
      observedThrough: "2026-08-21T23:59:59.000Z",
    };
  }
  return document;
}

function sourceSummaryGroup(overrides: Record<string, unknown> = {}) {
  return {
    records: 0,
    fixations: null,
    fixationKnownRecords: 0,
    meetings: null,
    meetingKnownRecords: 0,
    deals: null,
    dealKnownRecords: 0,
    brokerTours: null,
    brokerTourKnownRecords: 0,
    calls: null,
    callKnownRecords: 0,
    dealAmount: null,
    dealAmountKnownRecords: 0,
    ...overrides,
  };
}

function mockPersistedSnapshotCounts(
  prisma: ReturnType<typeof prismaMock>,
  overrides: Record<string, number> = {},
) {
  const counts = {
    records: 1,
    brokers: 1,
    agencies: 0,
    contactPoints: 0,
    externalIdentities: 0,
    activities: 0,
    metrics: 1,
    sourceAggregates: 0,
    organizationRoles: 0,
    reconciliationCases: 0,
    ...overrides,
  };
  prisma.loyaltySourceRecord.count.mockImplementation(({ where }: any) => {
    if (where?.entityType === "BROKER") return counts.brokers;
    if (where?.entityType === "AGENCY") return counts.agencies;
    return counts.records;
  });
  prisma.loyaltyContactPoint.count.mockResolvedValue(counts.contactPoints);
  prisma.loyaltyExternalIdentity.count.mockResolvedValue(
    counts.externalIdentities,
  );
  prisma.loyaltyActivity.count.mockResolvedValue(counts.activities);
  prisma.loyaltyMetricSnapshot.count.mockResolvedValue(counts.metrics);
  prisma.loyaltySourceAggregate.count.mockResolvedValue(
    counts.sourceAggregates,
  );
  prisma.loyaltyPersonOrganizationRole.count.mockResolvedValue(
    counts.organizationRoles,
  );
  prisma.loyaltyReconciliationCase.count.mockResolvedValue(
    counts.reconciliationCases,
  );
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

  it("keeps the HTTP-sized default while bounding trusted CLI overrides", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);

    await expect(
      service.dryRunImport(importDocument(), { maxImportBytes: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.dryRunImport(importDocument(), {
        maxImportBytes: MAX_LOYALTY_CLI_IMPORT_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
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

  it("rejects event-bearing imports without an explicit coverage attestation", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const result = await service.dryRunImport(
      importDocument({
        expectedUniquePhones: 0,
        expectedActivities: 1,
        expectedExternalIdentities: 0,
        activityCoverage: null,
        records: [
          {
            externalKey: "partial-event-row",
            entityType: "BROKER",
            displayName: "Partial row",
            contactPoints: [],
            externalIdentities: [],
            activities: [
              {
                sourceSystem: "AMOCRM",
                externalId: "excluded-call",
                type: "CALL",
                occurredAt: "2026-08-21T10:00:00.000Z",
                verdict: "EXCLUDED",
              },
            ],
          },
        ],
      }),
    );

    expect(result.publishable).toBe(false);
    expect(result.issues).toContainEqual({
      row: 0,
      code: "ACTIVITY_COVERAGE_REQUIRED",
    });
    expect(prisma.loyaltySnapshot.create).not.toHaveBeenCalled();
  });

  it("rejects self-declared FULL coverage that is not attested by a successful amo scan", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltySyncRun.findUnique.mockResolvedValue({
      id: "test-full-scan-1",
      source: "AMOCRM",
      status: "SUCCEEDED",
      contentHash: "a".repeat(64),
      completedAt: new Date("2026-08-22T00:00:00.000Z"),
      counts: {
        complete: true,
        readAt: "2026-08-21T23:59:59.000Z",
        eventCoverageComplete: false,
        coveredRecords: 1,
        activityRuleVersion: "anna-v1",
        activityTypes: ["CALL"],
      },
    });
    const result = await service.dryRunImport(
      importDocument({
        expectedUniquePhones: 0,
        expectedActivities: 1,
        expectedIncludedCalls: 1,
        expectedExternalIdentities: 0,
        records: [
          {
            externalKey: "unattested-event-row",
            entityType: "BROKER",
            displayName: "Unattested row",
            contactPoints: [],
            externalIdentities: [],
            activities: [
              {
                sourceSystem: "AMOCRM",
                externalId: "call-1",
                type: "CALL",
                occurredAt: "2026-08-21T10:00:00.000Z",
                verdict: "INCLUDED",
              },
            ],
          },
        ],
      }),
    );

    expect(result.publishable).toBe(false);
    expect(result.issues).toContainEqual({
      row: 0,
      code: "FULL_ACTIVITY_COVERAGE_SYNC_RUN_NOT_ATTESTED",
    });
    expect(prisma.broker.findMany).not.toHaveBeenCalled();
  });

  it("rejects a FULL coverage horizon that does not equal the trusted sync read timestamp", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const result = await service.dryRunImport(
      importDocument({
        expectedUniquePhones: 0,
        expectedActivities: 1,
        expectedIncludedCalls: 1,
        expectedExternalIdentities: 0,
        activityCoverage: {
          mode: "FULL_SNAPSHOT",
          coveredRecords: 1,
          activityTypes: ["FIXATION", "MEETING", "DEAL", "BROKER_TOUR", "CALL"],
          sourceRunId: "test-full-scan-1",
          sourceContentHash: "a".repeat(64),
          observedThrough: "2026-08-21T23:00:00.000Z",
        },
        records: [
          {
            externalKey: "mismatched-cutoff",
            entityType: "BROKER",
            displayName: "Mismatched cutoff",
            contactPoints: [],
            externalIdentities: [],
            activities: [
              {
                sourceSystem: "AMOCRM",
                externalId: "call-before-cutoff",
                type: "CALL",
                occurredAt: "2026-08-21T10:00:00.000Z",
                verdict: "INCLUDED",
              },
            ],
          },
        ],
      }),
    );

    expect(result.publishable).toBe(false);
    expect(result.issues).toContainEqual({
      row: 0,
      code: "FULL_ACTIVITY_COVERAGE_SYNC_RUN_NOT_ATTESTED",
    });
  });

  it("rejects activities newer than the declared observation horizon", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const result = await service.dryRunImport(
      importDocument({
        expectedUniquePhones: 0,
        expectedActivities: 1,
        expectedIncludedCalls: 1,
        expectedExternalIdentities: 0,
        activityCoverage: {
          mode: "FULL_SNAPSHOT",
          coveredRecords: 1,
          activityTypes: ["FIXATION", "MEETING", "DEAL", "BROKER_TOUR", "CALL"],
          sourceRunId: "test-full-scan-1",
          sourceContentHash: "a".repeat(64),
          observedThrough: "2026-08-21T09:00:00.000Z",
        },
        records: [
          {
            externalKey: "future-event",
            entityType: "BROKER",
            displayName: "Future event",
            contactPoints: [],
            externalIdentities: [],
            activities: [
              {
                sourceSystem: "AMOCRM",
                externalId: "call-after-cutoff",
                type: "CALL",
                occurredAt: "2026-08-21T10:00:00.000Z",
                verdict: "INCLUDED",
              },
            ],
          },
        ],
      }),
    );

    expect(result.publishable).toBe(false);
    expect(result.issues).toContainEqual({
      row: 1,
      code: "ACTIVITY_AFTER_OBSERVED_THROUGH",
    });
  });

  it("stores Anna rollups atomically without fabricating event rows", async () => {
    const prisma = prismaMock();
    prisma.broker.findMany.mockResolvedValue([]);
    prisma.agency.findMany.mockResolvedValue([]);
    const service = new LoyaltyBaseService(prisma);
    const raw = importDocument({
      expectedUniquePhones: 0,
      expectedExternalIdentities: 0,
      expectedSourceAggregates: 1,
      expectedSourceReportedSummary: {
        brokers: sourceSummaryGroup({
          records: 1,
          fixations: 4,
          fixationKnownRecords: 1,
          deals: 2,
          dealKnownRecords: 1,
          dealAmount: "1500000.00",
          dealAmountKnownRecords: 1,
        }),
        agencies: sourceSummaryGroup(),
      },
      records: [
        {
          externalKey: "anna-person-1",
          entityType: "BROKER",
          displayName: "Anna source row",
          contactPoints: [],
          externalIdentities: [],
          activities: [],
          sourceAggregate: {
            sourceKind: "ANNA_LEGACY_CRM",
            sourceVersion: "broker-source-enriched-v1",
            sourceLabel: "Anna curated CRM totals",
            quality: "SOURCE_REPORTED",
            exactness: "UNKNOWN",
            periodKind: "LIFETIME",
            contributesToSourceSummary: true,
            fixationCount: 4,
            meetingCount: null,
            dealCount: 2,
            dealAmount: "1500000.00",
            currency: "RUB",
            lastDealAt: "2026-07-01",
            dealsByMonth: { "2026-07": 2 },
            callBreakdown: [{ period: "2026-05", count: 3 }],
            provenance: { rawFields: ["crm.fixations", "crm.deals"] },
          },
        },
      ],
    });
    const dryRun = await service.dryRunImport(raw);
    expect(dryRun.publishable).toBe(true);
    expect(dryRun.summary).toMatchObject({
      activities: 0,
      sourceAggregates: 1,
      sourceSummaryAggregates: 1,
    });
    raw.expectedContentHash = dryRun.contentHash;
    raw.expectedActiveSnapshotId = null;

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
      prisma.loyaltyMetricSnapshot,
      prisma.loyaltySourceAggregate,
      prisma.loyaltySourceFieldValue,
      prisma.loyaltyPersonOrganizationRole,
      prisma.loyaltyReconciliationCase,
    ])
      delegate.createMany.mockResolvedValue({ count: 1 });

    await service.stageImport(raw, "admin-1");

    expect(prisma.loyaltyActivity.createMany).not.toHaveBeenCalled();
    expect(
      prisma.loyaltyMetricSnapshot.createMany.mock.calls[0][0].data[0],
    ).toMatchObject({ activityEvidenceCount: 0, dealCount: 0 });
    expect(
      prisma.loyaltySourceAggregate.createMany.mock.calls[0][0].data[0],
    ).toMatchObject({
      sourceKind: "ANNA_LEGACY_CRM",
      sourceVersion: "broker-source-enriched-v1",
      quality: "SOURCE_REPORTED",
      contributesToSourceSummary: true,
      fixationCount: 4,
      meetingCount: null,
      dealCount: 2,
      dealAmount: "1500000.00",
      dealsByMonth: { "2026-07": 2 },
    });
  });

  it("fails closed when a source rollup manifest is missing", async () => {
    const prisma = prismaMock();
    prisma.broker.findMany.mockResolvedValue([]);
    prisma.agency.findMany.mockResolvedValue([]);
    const service = new LoyaltyBaseService(prisma);
    const raw = importDocument({
      expectedSourceAggregates: 1,
      records: [
        {
          ...importDocument().records[0],
          sourceAggregate: {
            sourceKind: "ANNA_LEGACY_CRM",
            sourceVersion: "broker-source-enriched-v1",
            quality: "SOURCE_REPORTED",
            exactness: "UNKNOWN",
            periodKind: "LIFETIME",
            contributesToSourceSummary: true,
            dealCount: 2,
          },
        },
      ],
    });

    const dryRun = await service.dryRunImport(raw);

    expect(dryRun.publishable).toBe(false);
    expect(dryRun.issues).toContainEqual({
      row: 0,
      code: "EXPECTED_SOURCE_REPORTED_SUMMARY_REQUIRED",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
        brokerCount: 1,
        agencyCount: 0,
        activityCount: 0,
        summary: {
          contactPoints: 0,
          externalIdentities: 0,
          sourceAggregates: 0,
          organizationRoles: 0,
          candidateCount: 0,
        },
        dataset: {
          id: "dataset-1",
          code: "ANNA",
          activeSnapshotId: "snapshot-old",
        },
      })
      .mockResolvedValueOnce({ datasetId: "dataset-1", recordCount: 1 });
    mockPersistedSnapshotCounts(prisma);
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

  it("refuses the pointer switch when persisted snapshot children are incomplete", async () => {
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
      expectedRecords: 1,
      recordCount: 1,
      brokerCount: 1,
      agencyCount: 0,
      activityCount: 0,
      summary: {
        contactPoints: 0,
        externalIdentities: 0,
        sourceAggregates: 0,
        organizationRoles: 0,
        candidateCount: 0,
      },
      dataset: { id: "dataset-1", code: "ANNA", activeSnapshotId: null },
    });
    mockPersistedSnapshotCounts(prisma, { metrics: 0 });

    await expect(
      service.publishSnapshot("snapshot-1", {
        confirmed: true,
        expectedContentHash: "a".repeat(64),
        expectedActiveSnapshotId: null,
      }),
    ).rejects.toThrow("Snapshot metric snapshots coverage is incomplete");
    expect(prisma.loyaltyDataset.update).not.toHaveBeenCalled();
    expect(prisma.loyaltyPublicationEvent.create).not.toHaveBeenCalled();
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
      brokerCount: 1,
      agencyCount: 0,
      activityCount: 0,
      summary: {
        contactPoints: 0,
        externalIdentities: 0,
        sourceAggregates: 0,
        organizationRoles: 0,
        candidateCount: 0,
      },
      publishedAt: new Date("2026-08-01T00:00:00Z"),
      dataset: {
        id: "dataset-1",
        code: "ANNA",
        activeSnapshotId: "snapshot-1",
      },
    });
    mockPersistedSnapshotCounts(prisma);

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
      {
        caseId: "case-1",
        decision: "REJECT_MATCH",
        expectedVersion: 1,
        reason: "Reviewed by administrator",
      },
      "admin-1",
    );

    expect(prisma.loyaltyEntityLink.updateMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyEntityLink.create).not.toHaveBeenCalled();
    expect(prisma.broker.update).not.toHaveBeenCalled();
    expect(prisma.loyaltyReconciliationCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decisionReason: "Reviewed by administrator",
          decisionPayload: {
            targetId: "broker-1",
            fieldResolutions: null,
          },
        }),
      }),
    );
    expect(prisma.loyaltyEntityChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        personId: "person-1",
        action: "UPDATE",
        changedFields: ["reconciliationDecision"],
        actorId: "admin-1",
        beforeValues: expect.objectContaining({
          caseId: "case-1",
          status: "OPEN",
          version: 1,
        }),
        afterValues: expect.objectContaining({
          caseId: "case-1",
          decision: "REJECT_MATCH",
          version: 2,
        }),
      }),
    });
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
        reason: "Reviewed by administrator",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("SUPPLEMENT creates a real confirmed link and retains field resolutions as evidence", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const currentCase = {
      id: "case-supplement",
      snapshotId: "snapshot-1",
      version: 1,
      status: "OPEN",
      decision: null,
      personId: "person-1",
      organizationId: null,
      targetType: "BROKER",
      targetId: "broker-1",
      matchCodes: ["PHONE_EXACT"],
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
    prisma.loyaltySourceRecord.findFirst.mockResolvedValue({
      id: "source-1",
    });
    prisma.loyaltyManualEntity.findFirst.mockResolvedValue(null);
    prisma.broker.findUnique.mockResolvedValue({
      id: "broker-1",
      role: "BROKER",
      status: "ACTIVE",
      source: "BROKER_CABINET",
      mergedIntoId: null,
    });
    prisma.loyaltyPerson.findUnique.mockResolvedValue({
      manualDisplayName: null,
      manualCity: null,
      manualAttributes: null,
    });
    prisma.loyaltyReconciliationCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyEntityLink.findFirst.mockResolvedValue(null);
    prisma.loyaltyEntityLink.create.mockResolvedValue({ id: "link-1" });

    await service.decideReconciliation(
      {
        caseId: "case-supplement",
        decision: "SUPPLEMENT",
        expectedVersion: 1,
        reason: "Связь проверена, расхождение имени сохранено",
        fieldResolutions: { displayName: "KEEP_SEPARATE_VALUES" },
      },
      "admin-1",
    );

    expect(prisma.loyaltyEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        personId: "person-1",
        targetType: "BROKER",
        targetId: "broker-1",
        status: "CONFIRMED",
        evidence: {
          matchCodes: ["PHONE_EXACT"],
          decision: "SUPPLEMENT",
          fieldResolutions: { displayName: "KEEP_SEPARATE_VALUES" },
        },
      }),
    });
  });

  it.each([
    ["non-broker role", { role: "MANAGER" }],
    ["blocked account", { status: "BLOCKED" }],
    ["closed-as-broker source", { source: "CLOSED_AS_BROKER" }],
    ["merged duplicate", { mergedIntoId: "broker-primary" }],
  ])(
    "revalidates and rejects an ineligible OUR target inside the transaction: %s",
    async (_label, override) => {
      const prisma = prismaMock();
      const service = new LoyaltyBaseService(prisma);
      const currentCase = {
        id: "case-link",
        snapshotId: "snapshot-1",
        version: 1,
        status: "OPEN",
        decision: null,
        personId: "person-1",
        organizationId: null,
        targetType: "BROKER",
        targetId: "broker-1",
        matchCodes: ["PHONE_EXACT"],
        ruleVersion: "anna-v1",
      };
      prisma.loyaltyReconciliationCase.findUnique.mockResolvedValue(
        currentCase,
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
      const tx = {
        ...prisma,
        loyaltyDataset: {
          findUnique: jest.fn().mockResolvedValue({
            id: "dataset-1",
            activeSnapshotId: "snapshot-1",
          }),
        },
        loyaltySourceRecord: {
          findFirst: jest.fn().mockResolvedValue({ id: "source-1" }),
        },
        loyaltyManualEntity: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        broker: {
          findUnique: jest.fn().mockResolvedValue({
            id: "broker-1",
            role: "BROKER",
            status: "ACTIVE",
            source: "BROKER_CABINET",
            mergedIntoId: null,
            ...override,
          }),
        },
      } as any;
      prisma.$transaction.mockImplementation(async (callback: any) =>
        callback(tx),
      );

      await expect(
        service.decideReconciliation({
          caseId: "case-link",
          decision: "LINK",
          expectedVersion: 1,
          reason: "Reviewed by administrator",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.loyaltySourceRecord.findFirst).toHaveBeenCalled();
      expect(tx.broker.findUnique).toHaveBeenCalledWith({
        where: { id: "broker-1" },
        select: {
          id: true,
          role: true,
          status: true,
          source: true,
          mergedIntoId: true,
        },
      });
      expect(prisma.broker.findUnique).not.toHaveBeenCalled();
      expect(
        prisma.loyaltyReconciliationCase.updateMany,
      ).not.toHaveBeenCalled();
    },
  );

  it("revalidates an active Anna source or manual owner before locking LINK", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const currentCase = {
      id: "case-link",
      snapshotId: "snapshot-1",
      version: 1,
      status: "OPEN",
      decision: null,
      personId: "person-1",
      organizationId: null,
      targetType: "BROKER",
      targetId: "broker-1",
      matchCodes: ["PHONE_EXACT"],
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
    prisma.loyaltySourceRecord.findFirst.mockResolvedValue(null);
    prisma.loyaltyManualEntity.findFirst.mockResolvedValue(null);

    await expect(
      service.decideReconciliation({
        caseId: "case-link",
        decision: "LINK",
        expectedVersion: 1,
        reason: "Reviewed by administrator",
      }),
    ).rejects.toThrow("Anna source/manual entity is no longer active");
    expect(prisma.broker.findUnique).not.toHaveBeenCalled();
    expect(prisma.loyaltyReconciliationCase.updateMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyManualEntity.findFirst).toHaveBeenCalledWith({
      where: {
        datasetId: "dataset-1",
        entityType: "BROKER",
        archivedAt: null,
        personId: "person-1",
        person: { is: { archivedAt: null } },
      },
      select: { id: true },
    });
  });

  it("ARCHIVE soft-archives the Anna entity, overlay and active link atomically", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyReconciliationCase.findUnique.mockResolvedValue({
      id: "case-archive",
      snapshotId: "snapshot-1",
      version: 2,
      status: "OPEN",
      decision: null,
      personId: "person-1",
      organizationId: null,
      targetType: "BROKER",
      targetId: "broker-1",
      matchCodes: ["EXCLUDED_OR_STALE"],
      ruleVersion: "anna-v1",
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
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltyReconciliationCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyPerson.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyManualEntity.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyEntityLink.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyCallAssignment.updateMany.mockResolvedValue({ count: 4 });
    prisma.loyaltyEntityChange.create.mockResolvedValue({ id: "change-1" });

    await service.decideReconciliation(
      {
        caseId: "case-archive",
        decision: "ARCHIVE",
        expectedVersion: 2,
        reason: "Контакт подтверждён как неактуальный",
      },
      "admin-1",
    );

    expect(prisma.loyaltyPerson.updateMany).toHaveBeenCalledWith({
      where: { id: "person-1", archivedAt: null },
      data: { archivedAt: expect.any(Date) },
    });
    expect(prisma.loyaltyManualEntity.updateMany).toHaveBeenCalledWith({
      where: { personId: "person-1" },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        version: { increment: 1 },
      }),
    });
    expect(prisma.loyaltyCallAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        annaPersonId: "person-1",
        status: { in: ["PENDING", "IN_PROGRESS"] },
      },
      data: expect.objectContaining({
        status: "CANCELLED",
        version: { increment: 1 },
      }),
    });
    expect(prisma.loyaltyEntityChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        personId: "person-1",
        action: "ARCHIVE",
        changedFields: expect.arrayContaining(["openCallAssignments"]),
        beforeValues: expect.objectContaining({ openCallAssignments: 4 }),
        actorId: "admin-1",
      }),
    });
    expect(prisma.broker.update).not.toHaveBeenCalled();
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
          contactPoints: 0,
          uniqueNormalizedPhones: 0,
          externalIdentities: 0,
          sourceAggregates: 0,
          organizationRoles: 0,
          candidateCount: 0,
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
    mockPersistedSnapshotCounts(prisma, { activities: 1 });

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
        reason: "Reviewed by administrator",
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
    prisma.loyaltySourceRecord.findFirst.mockResolvedValue({
      id: "source-1",
    });
    prisma.loyaltyManualEntity.findFirst.mockResolvedValue(null);
    prisma.broker.findUnique.mockResolvedValue({
      id: "broker-1",
      role: "BROKER",
      status: "ACTIVE",
      source: "BROKER_CABINET",
      mergedIntoId: null,
    });
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
      reason: "Reviewed by administrator",
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
      reason: "Reviewed by administrator",
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
    ).toEqual({
      OR: [
        { fixationStatus: "FIXED" },
        { uniquenessStatus: "CONDITIONALLY_UNIQUE" },
      ],
    });
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
            lastCallAt: null,
            brokerTourVisited: false,
            brokerTourDate: null,
            clients: [],
            meetings: [],
            deals: [],
            callLogs: [],
          },
        },
      ],
      deals: [],
      _count: { brokerAgencies: 1 },
    });

    const result = await service.detail("ours", "AGENCY", "agency-1");

    expect(
      prisma.agency.findUnique.mock.calls[0][0].include.brokerAgencies.include
        .broker.select,
    ).toEqual(
      expect.objectContaining({
        id: true,
        fullName: true,
        phone: true,
        email: true,
        clients: expect.any(Object),
        meetings: expect.any(Object),
        deals: expect.any(Object),
        callLogs: expect.any(Object),
      }),
    );
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

  it("retires the orphan unlink path without mutating a link", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);

    const error = await service
      .unlinkActiveLink(
        {
          linkId: "11111111-1111-4111-8111-111111111111",
          expectedVersion: 3,
        },
        "admin-1",
      )
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(GoneException);
    expect(error.getStatus()).toBe(410);
    expect(error.getResponse()).toMatchObject({
      code: "LOYALTY_LEGACY_UNLINK_RETIRED",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.loyaltyEntityLink.updateMany).not.toHaveBeenCalled();
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
        recordCount: 1,
        activityCount: 1,
        summary: {
          activityCoverage: {
            mode: "FULL_SNAPSHOT",
            coveredRecords: 1,
            activityTypes: [
              "FIXATION",
              "MEETING",
              "DEAL",
              "BROKER_TOUR",
              "CALL",
            ],
            sourceRunId: "test-full-scan-1",
            sourceContentHash: "a".repeat(64),
            observedThrough: "2099-12-31T23:59:58.000Z",
            verifiedBySyncRun: true,
            syncCompletedAt: "2099-12-31T23:59:59.000Z",
          },
        },
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

  it("keeps overview not-called KPI in parity with the effective workflow drill-down", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      const prisma = prismaMock();
      const service = new LoyaltyBaseService(prisma);
      const brokerRecord = (personId: string) => ({
        id: `source-${personId}`,
        entityType: "BROKER",
        personId,
        organizationId: null,
        displayName: personId,
        city: "Moscow",
        attributes: {},
        sourceArchivedAt: null,
        person: {
          id: personId,
          manualDisplayName: null,
          manualCity: null,
          manualAttributes: null,
          archivedAt: null,
          updatedAt: new Date("2026-08-24T00:00:00.000Z"),
          contactOverrides: [],
          links: [],
        },
        organization: null,
        contactPoints: [],
        externalIdentities: [],
        metrics: [
          {
            ruleVersion: "anna-v1",
            activityEvidenceCount: 0,
            fixationCount: 0,
            meetingCount: 0,
            dealCount: 0,
            brokerTourCount: 0,
            callCount: 0,
            dealAmount: "0.00",
          },
        ],
        sourceAggregate: null,
        organizationRoles: [],
      });
      const records = [
        brokerRecord("person-called"),
        brokerRecord("person-idle"),
      ];
      prisma.loyaltyDataset.findUnique.mockResolvedValue({
        id: "dataset-1",
        activeSnapshotId: "snapshot-1",
        activeSnapshot: {
          id: "snapshot-1",
          datasetId: "dataset-1",
          status: "PUBLISHED",
          recordCount: 2,
          activityCount: 0,
          ruleVersion: "anna-v1",
          publishedAt: new Date("2026-08-24T00:00:00.000Z"),
          summary: {
            sourceAggregates: 0,
            activityCoverage: {
              mode: "FULL_SNAPSHOT",
              coveredRecords: 2,
              activityTypes: [
                "FIXATION",
                "MEETING",
                "DEAL",
                "BROKER_TOUR",
                "CALL",
              ],
              sourceRunId: "parity-run",
              sourceContentHash: "a".repeat(64),
              observedThrough: "2026-08-24T23:59:58.000Z",
              verifiedBySyncRun: true,
              syncCompletedAt: "2026-08-24T23:59:59.000Z",
            },
          },
        },
      });
      prisma.loyaltyManualEntity.findMany.mockResolvedValue([]);
      prisma.loyaltySourceRecord.findMany.mockImplementation((args: any) =>
        args?.include?.metrics ? records : [],
      );
      prisma.loyaltySourceRecord.count.mockImplementation(({ where }: any) =>
        where?.entityType === "BROKER" ? 2 : 0,
      );
      prisma.loyaltyActivity.count.mockResolvedValue(0);
      prisma.loyaltyActivity.aggregate.mockResolvedValue({
        _sum: { amount: null },
      });
      prisma.loyaltyActivity.groupBy.mockResolvedValue([]);
      prisma.loyaltySourceAggregate.findMany.mockResolvedValue([]);
      prisma.loyaltyCallAttempt.findMany.mockResolvedValue([
        {
          id: "attempt-1",
          assignmentId: "assignment-1",
          operatorId: "operator-1",
          result: "CONNECTED",
          comment: null,
          nextStep: null,
          nextActionAt: null,
          source: "LOYALTY_CALL_QUEUE",
          correctsAttemptId: null,
          correctionReason: null,
          occurredAt: new Date("2026-08-10T10:00:00.000Z"),
          createdAt: new Date("2026-08-10T10:00:01.000Z"),
          operator: { id: "operator-1", fullName: "Operator" },
          assignment: {
            annaPersonId: "person-called",
            annaOrganizationId: null,
            ourBrokerId: null,
            ourAgencyId: null,
            campaign: { id: "campaign-1", name: "August calls" },
          },
        },
      ]);
      prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);

      const overview: any = await service.overview("anna", {});
      const drillDown: any = await service.list("anna", "BROKER", {
        page: 1,
        pageSize: 30,
        segment: "NOT_CALLED_CURRENT_MONTH",
      } as any);

      expect(overview.brokers.notCalledCurrentMonth).toBe(1);
      expect(drillDown.total).toBe(overview.brokers.notCalledCurrentMonth);
      expect(drillDown.items.map((item: any) => item.id)).toEqual([
        "person-idle",
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("uses only explicit source-reported rollups when a snapshot has no exact activities", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        activityCount: 0,
        ruleVersion: "anna-v1",
        publishedAt: new Date("2026-08-21T00:00:00.000Z"),
      },
    });
    prisma.loyaltySourceRecord.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([
      {
        id: "record-1",
        personId: "person-1",
        displayName: "Anna row",
        attributes: { relationshipStage: "NEW" },
        person: { manualDisplayName: null },
        sourceAggregate: {
          quality: "SOURCE_REPORTED",
          contributesToSourceSummary: true,
          fixationCount: 4,
          meetingCount: 3,
          dealCount: 2,
          brokerTourCount: 1,
          callCount: 0,
          dealAmount: "1500000.00",
          lastCallAt: null,
          brokerTourVisited: true,
        },
      },
    ]);
    prisma.loyaltySourceAggregate.findMany.mockResolvedValue([
      {
        sourceKind: "ANNA_LEGACY_CRM",
        sourceVersion: "broker-source-enriched-v1",
        sourceLabel: "Anna curated CRM totals",
        quality: "SOURCE_REPORTED",
        exactness: "UNKNOWN",
        contributesToSourceSummary: true,
        fixationCount: 4,
        meetingCount: 3,
        dealCount: 2,
        dealAmount: "1500000.00",
        lastDealAt: new Date("2026-07-01T00:00:00.000Z"),
        sourceRecord: {
          entityType: "BROKER",
          personId: "person-1",
          organizationId: null,
          displayName: "Anna row",
          person: { manualDisplayName: null },
          organization: null,
        },
      },
    ]);

    const result: any = await service.overview("anna", {});

    expect(result).toMatchObject({
      activities: { fixations: null, meetings: null, deals: null },
      dealAmount: null,
      metricSource: {
        kind: "UNAVAILABLE",
        periodFilterApplied: false,
      },
      sourceReportedSummary: {
        kind: "SOURCE_AGGREGATE",
        confirmationStatus: "NOT_CONFIRMED",
        periodFilterApplied: false,
        brokers: {
          fixations: 4,
          meetings: 3,
          deals: 2,
          dealAmount: "1500000.00",
          notCalledCurrentMonth: null,
          notCalledKnownCount: 0,
        },
        agencies: {
          fixations: null,
          meetings: null,
          deals: null,
          dealAmount: null,
        },
      },
    });
    expect(result.kpiMetadata["activities.deals"]).toMatchObject({
      source: "UNAVAILABLE",
      periodFilterApplied: false,
    });
    expect(result.kpiMetadata["sourceReportedSummary.brokers"]).toMatchObject({
      source: "SOURCE_AGGREGATE",
      confirmationStatus: "NOT_CONFIRMED",
      periodFilterApplied: false,
    });
    expect(
      result.kpiMetadata["sourceReportedSummary.brokers.brokerTours"],
    ).toMatchObject({
      source: "SOURCE_AGGREGATE",
      periodFilterApplied: false,
      formula: expect.stringContaining("brokerTourCount"),
    });
    expect(
      result.kpiMetadata["sourceReportedSummary.brokers.calls"],
    ).toMatchObject({
      source: "SOURCE_AGGREGATE",
      periodFilterApplied: false,
      formula: expect.stringContaining("callCount"),
    });
    expect(
      result.kpiMetadata["sourceReportedSummary.agencies.brokerTours"],
    ).toMatchObject({
      source: "SOURCE_AGGREGATE",
      periodFilterApplied: false,
      formula: expect.stringContaining("brokerTourCount"),
    });
    expect(
      result.kpiMetadata["sourceReportedSummary.agencies.calls"],
    ).toMatchObject({
      source: "SOURCE_AGGREGATE",
      periodFilterApplied: false,
      formula: expect.stringContaining("callCount"),
    });
    const brokerOverviewSelect =
      prisma.loyaltySourceRecord.findMany.mock.calls[0][0].select;
    expect(brokerOverviewSelect.sourceAggregate.select).toMatchObject({
      quality: true,
      lastCallAt: true,
      brokerTourVisited: true,
    });
    expect(brokerOverviewSelect.sourceAggregate.select).not.toHaveProperty(
      "provenance",
    );
    const aggregateOverviewQuery =
      prisma.loyaltySourceAggregate.findMany.mock.calls[0][0];
    expect(aggregateOverviewQuery).not.toHaveProperty("include");
    expect(aggregateOverviewQuery.select.sourceRecord.select).toMatchObject({
      entityType: true,
      displayName: true,
      person: { select: { manualDisplayName: true } },
      organization: { select: { manualDisplayName: true } },
    });
    expect(aggregateOverviewQuery.select).not.toHaveProperty("provenance");
    expect(aggregateOverviewQuery.select).not.toHaveProperty("dealsByMonth");
    expect(aggregateOverviewQuery.select).not.toHaveProperty("callBreakdown");
    expect(prisma.loyaltyActivity.count).not.toHaveBeenCalled();
    expect(prisma.loyaltyActivity.aggregate).not.toHaveBeenCalled();
  });

  it("does not turn one partial or excluded event into exact zeroes for the whole snapshot", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        recordCount: 2,
        activityCount: 1,
        ruleVersion: "anna-v2-partial",
        summary: {
          sourceAggregates: 0,
          activityCoverage: {
            mode: "PARTIAL",
            coveredRecords: 1,
            activityTypes: ["CALL"],
            sourceRunId: "partial-scan",
            sourceContentHash: "b".repeat(64),
            observedThrough: "2026-08-21T00:00:00.000Z",
            verifiedBySyncRun: false,
          },
        },
        publishedAt: new Date("2026-08-21T00:00:00.000Z"),
      },
    });
    prisma.loyaltySourceRecord.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    prisma.loyaltySourceAggregate.findMany.mockResolvedValue([]);

    const result: any = await service.overview("anna", {});

    expect(result.metricSource).toMatchObject({
      kind: "UNAVAILABLE",
      exactness: "UNKNOWN",
    });
    expect(result.activities).toEqual({
      fixations: null,
      meetings: null,
      deals: null,
    });
    expect(prisma.loyaltyActivity.count).not.toHaveBeenCalled();
    expect(prisma.loyaltyActivity.aggregate).not.toHaveBeenCalled();
  });

  it("returns exact zeroes for zero-event rows only under trusted FULL snapshot coverage", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        recordCount: 1,
        activityCount: 0,
        ruleVersion: "anna-v1",
        summary: {
          activityCoverage: {
            mode: "FULL_SNAPSHOT",
            coveredRecords: 1,
            activityTypes: [
              "FIXATION",
              "MEETING",
              "DEAL",
              "BROKER_TOUR",
              "CALL",
            ],
            sourceRunId: "test-full-scan-1",
            sourceContentHash: "a".repeat(64),
            observedThrough: "2099-12-31T23:59:58.000Z",
            verifiedBySyncRun: true,
            syncCompletedAt: "2099-12-31T23:59:59.000Z",
          },
        },
      },
    });
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([
      {
        id: "record-zero",
        entityType: "BROKER",
        displayName: "Zero event broker",
        attributes: {},
        person: {
          id: "person-zero",
          manualDisplayName: null,
          manualCity: null,
          manualAttributes: null,
          archivedAt: null,
          contactOverrides: [],
          links: [],
        },
        organization: null,
        contactPoints: [],
        externalIdentities: [],
        organizationRoles: [],
        metrics: [
          {
            ruleVersion: "anna-v1",
            activityEvidenceCount: 0,
            fixationCount: 0,
            meetingCount: 0,
            dealCount: 0,
            brokerTourCount: 0,
            callCount: 0,
            dealAmount: "0.00",
          },
        ],
        sourceAggregate: null,
      },
    ]);
    prisma.loyaltyManualEntity.findMany.mockResolvedValue([]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);

    const result: any = await service.list("anna", "BROKER", {
      page: 1,
      pageSize: 30,
    } as any);

    expect(result.items[0].metrics).toMatchObject({
      fixations: 0,
      meetings: 0,
      deals: 0,
      brokerTours: 0,
      calls: 0,
      dealAmount: "0.00",
    });
    expect(result.items[0].metricSource).toMatchObject({
      kind: "EXACT_ACTIVITIES",
      exactness: "EXACT",
      activityEvidenceCount: 0,
      observedThrough: "2099-12-31T23:59:58.000Z",
    });
  });

  it("keeps selected-period evidence unknown without exact activity coverage", () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const partialAugust = {
      from: new Date("2026-08-10T00:00:00.000Z"),
      to: new Date("2026-08-20T23:59:59.999Z"),
      fromIso: "2026-08-10",
      toIso: "2026-08-20",
    };
    const fullAugust = {
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-31T23:59:59.999Z"),
      fromIso: "2026-08-01",
      toIso: "2026-08-31",
    };
    const september = {
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-09-30T23:59:59.999Z"),
      fromIso: "2026-09-01",
      toIso: "2026-09-30",
    };

    expect(
      (service as any).callInPeriod({ period: "2026-08" }, partialAugust),
    ).toBeNull();
    expect(
      (service as any).callInPeriod({ period: "2026-08" }, fullAugust),
    ).toBe(true);
    expect(
      (service as any).callInPeriod({ period: "2026-08" }, september),
    ).toBe(false);
    expect(
      (service as any).callPresenceInPeriod(
        [{ period: "2026-08" }],
        null,
        september,
      ),
    ).toBeNull();

    const monthlyItem = {
      metricSource: { kind: "UNAVAILABLE" },
      metrics: { deals: null },
      sourceReportedMetrics: { dealsByMonth: { "2026-08": 3 } },
    };
    expect(
      (service as any).annaDealsInPeriod({}, monthlyItem, partialAugust),
    ).toBeNull();
    expect(
      (service as any).annaDealsInPeriod({}, monthlyItem, fullAugust),
    ).toBeNull();
    expect(
      (service as any).annaDealsInPeriod({}, monthlyItem, september),
    ).toBeNull();

    const lifetimeItem = {
      metricSource: { kind: "UNAVAILABLE" },
      metrics: { deals: null },
      sourceReportedMetrics: {
        deals: 9,
        lastDealAt: "2026-09-15",
      },
    };
    expect(
      (service as any).annaDealsInPeriod({}, lifetimeItem, fullAugust),
    ).toBeNull();
    expect(
      (service as any).annaDealsInPeriod(
        {},
        {
          ...lifetimeItem,
          sourceReportedMetrics: { deals: 9, lastDealAt: "2026-07-31" },
        },
        fullAugust,
      ),
    ).toBeNull();
    expect(
      (service as any).annaDealsInPeriod(
        {},
        {
          ...lifetimeItem,
          sourceReportedMetrics: { deals: 9, lastDealAt: "2026-08-15" },
        },
        fullAugust,
      ),
    ).toBeNull();
    expect(
      (service as any).annaDealsInPeriod(
        {},
        {
          ...lifetimeItem,
          sourceReportedMetrics: { deals: 0, lastDealAt: null },
        },
        fullAugust,
      ),
    ).toBeNull();
    expect(
      (service as any).annaActivityPresence(
        {},
        {
          metricSource: { kind: "UNAVAILABLE" },
          metrics: { fixations: null },
          sourceReportedMetrics: { fixations: 0 },
        },
        "FIXATION",
      ),
    ).toBe(false);
    expect(
      (service as any).annaActivityPresence(
        {},
        {
          metricSource: { kind: "UNAVAILABLE" },
          metrics: { fixations: null },
          sourceReportedMetrics: { fixations: 0 },
        },
        "FIXATION",
        fullAugust,
      ),
    ).toBeNull();
    expect(
      (service as any).annaActivityPresence(
        {},
        {
          metricSource: { kind: "UNAVAILABLE" },
          metrics: { calls: null },
          sourceReportedMetrics: { calls: 0, callBreakdown: [] },
        },
        "CALL",
        fullAugust,
      ),
    ).toBeNull();
  });

  it("does not return exact selected-period zeroes beyond observedThrough", () => {
    const service = new LoyaltyBaseService(prismaMock());
    const period = {
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-31T23:59:59.999Z"),
      fromIso: "2026-08-01",
      toIso: "2026-08-31",
    };
    const item = {
      metricSource: {
        kind: "EXACT_ACTIVITIES",
        observedThrough: "2026-08-15T23:59:59.999Z",
      },
      metrics: {
        fixations: 0,
        meetings: 0,
        deals: 0,
        brokerTours: 0,
        calls: 0,
      },
    };

    expect((service as any).annaPeriodMetrics({}, item, period)).toMatchObject({
      availability: "UNAVAILABLE",
      fixations: null,
      deals: null,
    });
    expect(
      (service as any).callPresenceInPeriod(
        [],
        0,
        period,
        new Date("2026-08-15T23:59:59.999Z"),
      ),
    ).toBeNull();
  });

  it("uses only exact covered period metrics for Anna activity filters", () => {
    const service = new LoyaltyBaseService(prismaMock());
    const activityPeriod = { from: "2026-08-01", to: "2026-08-31" };
    const filter = (query: any = {}, canonical: any = {}) =>
      (service as any).normalizeListFilter(
        { archived: "exclude", page: 1, pageSize: 30, ...query },
        { activityPeriod, ...canonical },
      );
    const matches = (
      record: any,
      item: any,
      query: any = {},
      canonical: any = {},
    ) =>
      (service as any).matchesAnnaRecord(
        record,
        { id: "anna-broker", displayName: "Anna broker", ...item },
        "BROKER",
        filter(query, canonical),
      );
    const sourceOnly = {
      attributes: {},
      contactPoints: [],
      metrics: {
        fixations: null,
        meetings: null,
        deals: null,
        brokerTours: null,
        calls: null,
      },
      sourceReportedMetrics: {
        fixations: 17,
        meetings: 9,
        deals: 4,
        brokerTours: 1,
        calls: 0,
        brokerTourVisited: true,
      },
      metricSource: { kind: "UNAVAILABLE", exactness: "UNKNOWN" },
    };

    // Aggregate-only records fall back to their lifetime source-reported
    // numbers when the requested activity period cannot be computed, so the
    // known totals (17 fixations, 9 meetings, 4 deals) satisfy the filters.
    expect(
      matches({}, sourceOnly, { columns: { activity: "HAS_FIXATIONS" } }),
    ).toBe(true);
    expect(matches({}, sourceOnly, {}, { meetings: { min: 1 } })).toBe(true);
    expect(matches({}, sourceOnly, {}, { dealCount: { min: 1 } })).toBe(true);
    expect(matches({}, sourceOnly, {}, { dealsInPeriod: false })).toBe(false);
    expect(matches({}, sourceOnly, {}, { scenario: "NO_MEETINGS" })).toBe(
      false,
    );
    expect(matches({}, sourceOnly, {}, { scenario: "HAS_DEALS" })).toBe(true);
    const sourceOnlyUnknown = {
      ...sourceOnly,
      sourceReportedMetrics: {
        fixations: null,
        meetings: null,
        deals: null,
        brokerTours: null,
        calls: null,
      },
    };
    // Without even lifetime numbers the record stays "unknown" and is
    // rejected by an explicit deal filter.
    expect(
      matches({}, sourceOnlyUnknown, {}, { dealCount: { min: 1 } }),
    ).toBe(false);
    expect(matches({}, sourceOnlyUnknown, {}, { scenario: "HAS_DEALS" })).toBe(
      false,
    );
    expect(matches({}, sourceOnlyUnknown)).toBe(true);

    const exactItem = {
      attributes: {},
      contactPoints: [],
      metrics: {
        fixations: 1,
        meetings: 1,
        deals: 1,
        brokerTours: 0,
        calls: 0,
      },
      sourceReportedMetrics: { brokerTourVisited: false },
      metricSource: {
        kind: "EXACT_ACTIVITIES",
        exactness: "EXACT",
        observedThrough: "2026-09-01T00:00:00.000Z",
      },
    };
    const outsideRecord = {
      activities: [
        { type: "FIXATION", occurredAt: "2026-07-10T10:00:00.000Z" },
        { type: "MEETING", occurredAt: "2026-07-11T10:00:00.000Z" },
        { type: "DEAL", occurredAt: "2026-07-12T10:00:00.000Z" },
      ],
    };
    expect(
      matches(outsideRecord, exactItem, {
        columns: { activity: "HAS_FIXATIONS" },
      }),
    ).toBe(false);
    expect(
      matches(outsideRecord, exactItem, {}, { meetings: { min: 1 } }),
    ).toBe(false);
    expect(matches(outsideRecord, exactItem, {}, { dealsInPeriod: true })).toBe(
      false,
    );
    expect(
      matches(outsideRecord, exactItem, {
        columns: { activity: "NO_FIXATIONS" },
      }),
    ).toBe(true);

    const insideRecord = {
      activities: [
        { type: "FIXATION", occurredAt: "2026-08-10T10:00:00.000Z" },
        { type: "MEETING", occurredAt: "2026-08-11T10:00:00.000Z" },
        {
          type: "DEAL",
          occurredAt: "2026-08-12T10:00:00.000Z",
          amount: "100.00",
        },
      ],
    };
    expect(
      matches(insideRecord, exactItem, {
        columns: { activity: "HAS_FIXATIONS" },
      }),
    ).toBe(true);
    expect(matches(insideRecord, exactItem, {}, { meetings: { min: 1 } })).toBe(
      true,
    );
    expect(matches(insideRecord, exactItem, {}, { dealsInPeriod: true })).toBe(
      true,
    );

    const notObserved = {
      ...exactItem,
      metrics: {
        fixations: 0,
        meetings: 0,
        deals: 0,
        brokerTours: 0,
        calls: 0,
      },
      metricSource: {
        ...exactItem.metricSource,
        observedThrough: "2026-08-15T23:59:59.999Z",
      },
    };
    expect(
      matches({ activities: [] }, notObserved, {
        columns: { activity: "NO_FIXATIONS" },
      }),
    ).toBe(false);
    expect(
      matches({ activities: [] }, notObserved, {}, { scenario: "NO_MEETINGS" }),
    ).toBe(false);
    expect(
      matches({ activities: [] }, notObserved, {}, { dealsInPeriod: false }),
    ).toBe(false);

    const noPeriodFilter = (service as any).normalizeListFilter(
      {
        archived: "exclude",
        page: 1,
        pageSize: 30,
        columns: { activity: "HAS_FIXATIONS" },
      },
      {},
    );
    expect(
      (service as any).matchesAnnaRecord(
        {},
        {
          id: "source-only-no-period",
          displayName: "Source-only no period",
          ...sourceOnly,
        },
        "BROKER",
        noPeriodFilter,
      ),
    ).toBe(true);

    expect(
      matches(
        outsideRecord,
        {
          ...exactItem,
          metrics: { ...exactItem.metrics, brokerTours: 1 },
          sourceReportedMetrics: { brokerTourVisited: true },
        },
        { segment: "BT_WITHOUT_FIXATION" },
      ),
    ).toBe(false);
  });

  it("does not treat an empty legacy call breakdown as proof of no call", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        activityCount: 0,
        ruleVersion: "anna-v1",
        publishedAt: new Date("2026-08-21T00:00:00.000Z"),
      },
    });
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    prisma.loyaltySourceRecord.count.mockResolvedValue(0);

    await service.list("anna", "BROKER", {
      page: 1,
      pageSize: 30,
      segment: "NOT_CALLED_CURRENT_MONTH",
    } as any);

    const where = prisma.loyaltySourceRecord.findMany.mock.calls[0][0].where;
    // The predicate must run only after workflow attempts are batch-attached;
    // a source-only WHERE would drop a fresh queue call before reconciliation.
    expect(where).not.toHaveProperty("AND");
    expect(JSON.stringify(where)).not.toContain("callCount");
  });

  it("unions manual Anna overlays into the canonical list without false metrics", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        activityCount: 0,
        ruleVersion: "anna-v1",
      },
    });
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    prisma.loyaltyManualEntity.findMany.mockResolvedValue([
      {
        id: "overlay-1",
        entityType: "BROKER",
        personId: "person-manual-1",
        displayName: "Manual broker",
        city: "Moscow",
        phoneNormalized: "+79990000001",
        emailNormalized: null,
        contactPoints: [
          {
            id: "point-1",
            type: "PHONE",
            value: "+79990000001",
            label: "Manual contact",
            isPrimary: true,
          },
        ],
        attributes: { source: "MANUAL" },
        version: 1,
        archivedAt: null,
        createdAt: new Date("2026-08-21T12:00:00Z"),
        updatedAt: new Date("2026-08-21T12:00:00Z"),
        person: {
          id: "person-manual-1",
          manualDisplayName: "Manual broker",
          manualCity: "Moscow",
          manualAttributes: { source: "MANUAL" },
          archivedAt: null,
          updatedAt: new Date("2026-08-21T12:00:00Z"),
          links: [],
          contactOverrides: [
            {
              id: "override-email-1",
              type: "EMAIL",
              value: "manual@example.test",
              normalizedValue: "manual@example.test",
              label: "Рабочая почта",
              isPrimary: true,
              version: 2,
              archivedAt: null,
            },
          ],
        },
        organization: null,
      },
    ]);

    const result: any = await service.list("anna", "BROKER", {
      page: 1,
      pageSize: 30,
    } as any);

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: "person-manual-1",
      sourceRecordId: null,
      manualOverlay: true,
      manualOverlayId: "overlay-1",
      metrics: {
        fixations: null,
        meetings: null,
        deals: null,
        calls: null,
      },
      dataQualityCodes: expect.arrayContaining(["NEEDS_COMPLETION"]),
      contactPoints: expect.arrayContaining([
        expect.objectContaining({
          id: "override-email-1",
          type: "EMAIL",
          value: "manual@example.test",
          version: 2,
          source: "MANUAL_OVERRIDE",
        }),
      ]),
    });
  });

  it("blocks an import that collides with an unrelated active manual overlay", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const document = importDocument();
    const dryRun = await service.dryRunImport(document);
    prisma.loyaltyManualEntity.findMany.mockResolvedValue([
      {
        entityType: "BROKER",
        phoneNormalized: "+79990000001",
        emailNormalized: null,
        person: { externalKey: "MANUAL:other-person" },
        organization: null,
      },
    ]);

    await expect(
      service.stageImport({
        ...document,
        expectedContentHash: dryRun.contentHash,
        expectedActiveSnapshotId: null,
      }),
    ).rejects.toThrow("MANUAL_OVERLAY_CONTACT_REQUIRES_RECONCILIATION");
  });

  it("updates a manual overlay with its own optimistic token", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const updatedAt = new Date("2026-08-21T12:00:00.000Z");
    const manual = {
      id: "overlay-1",
      datasetId: "dataset-1",
      entityType: "BROKER",
      personId: "person-manual-1",
      organizationId: null,
      displayName: "Old name",
      city: "Moscow",
      phoneNormalized: "+79990000001",
      emailNormalized: null,
      contactPoints: [],
      attributes: { source: "MANUAL" },
      version: 1,
      archivedAt: null,
      createdAt: updatedAt,
      updatedAt,
      person: {
        id: "person-manual-1",
        manualDisplayName: "Old name",
        manualCity: "Moscow",
        manualAttributes: { source: "MANUAL" },
        archivedAt: null,
        updatedAt,
        links: [],
      },
      organization: null,
    };
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        ruleVersion: "anna-v1",
      },
    });
    prisma.loyaltySourceRecord.findFirst.mockResolvedValue(null);
    prisma.loyaltyManualEntity.findFirst.mockResolvedValue(manual);
    prisma.loyaltyManualEntity.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyPerson.update.mockResolvedValue({});
    prisma.loyaltyEntityChange.create.mockResolvedValue({});

    const result: any = await service.updateAnnaEntity(
      "BROKER",
      "person-manual-1",
      {
        expectedUpdatedAt: updatedAt.toISOString(),
        displayName: "New name",
      } as any,
      "admin-1",
    );

    expect(prisma.loyaltyManualEntity.updateMany).toHaveBeenCalledWith({
      where: { id: "overlay-1", updatedAt },
      data: expect.objectContaining({
        displayName: "New name",
        version: { increment: 1 },
      }),
    });
    expect(prisma.loyaltyPerson.update).toHaveBeenCalledWith({
      where: { id: "person-manual-1" },
      data: expect.objectContaining({ manualDisplayName: "New name" }),
    });
    expect(result.item.manualOverlay).toBe(true);
  });

  it("reads only metrics produced by the active snapshot rule version", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        activityCount: 0,
        ruleVersion: "anna-active-v2",
      },
    });
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    prisma.loyaltySourceRecord.count.mockResolvedValue(0);

    await service.list("anna", "BROKER", {
      page: 1,
      pageSize: 30,
    } as any);

    expect(
      prisma.loyaltySourceRecord.findMany.mock.calls[0][0].include.metrics,
    ).toMatchObject({
      where: { ruleVersion: "anna-active-v2" },
      orderBy: { calculatedAt: "desc" },
      take: 1,
    });
  });

  it("uses exact DD.MM or ISO birthday parsing for the Anna drill-down", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const today = `${String(shifted.getUTCDate()).padStart(2, "0")}.${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([
      { id: "exact", attributes: { birthday: today } },
      {
        id: "iso",
        attributes: {
          birthday: `1990-${today.slice(3, 5)}-${today.slice(0, 2)}`,
        },
      },
      { id: "malformed", attributes: { birthday: `${today}0/foo` } },
    ]);

    const ids = await (service as any).annaBirthdayRecordIds("snapshot-1");

    expect(ids).toEqual(["exact", "iso"]);
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

  it("restores an Anna entity and reopens its archived reconciliation case", async () => {
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
        archivedAt: new Date("2026-08-17T10:00:00.000Z"),
        updatedAt: new Date(expectedUpdatedAt),
      },
      organization: null,
    });
    prisma.loyaltyPerson.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyReconciliationCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    jest
      .spyOn(service, "detail")
      .mockResolvedValue({ item: { id: "person-1" } } as any);

    await service.updateAnnaEntity(
      "BROKER",
      "person-1",
      { expectedUpdatedAt, archived: false },
      "admin-1",
    );

    expect(prisma.loyaltyReconciliationCase.updateMany).toHaveBeenCalledWith({
      where: {
        snapshotId: "snapshot-1",
        status: "RESOLVED",
        decision: "ARCHIVE",
        personId: "person-1",
      },
      data: expect.objectContaining({
        status: "OPEN",
        decision: null,
        decisionReason: null,
        decisionPayload: null,
        version: { increment: 1 },
      }),
    });
    expect(prisma.loyaltyEntityChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "RESTORE",
        changedFields: ["archivedAt", "reconciliationCases"],
        actorId: "admin-1",
      }),
    });
  });

  it("archives an Anna entity, revokes active links and cancels its open call assignments", async () => {
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
        updatedAt: new Date(expectedUpdatedAt),
      },
      organization: null,
    });
    prisma.loyaltyPerson.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyEntityLink.updateMany.mockResolvedValue({ count: 2 });
    prisma.loyaltyCallAssignment.updateMany.mockResolvedValue({ count: 3 });
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    jest
      .spyOn(service, "detail")
      .mockResolvedValue({ item: { id: "person-1" } } as any);

    await service.updateAnnaEntity(
      "BROKER",
      "person-1",
      { expectedUpdatedAt, archived: true },
      "admin-1",
    );

    expect(prisma.loyaltyEntityLink.updateMany).toHaveBeenCalledWith({
      where: {
        personId: "person-1",
        status: "CONFIRMED",
        revokedAt: null,
      },
      data: expect.objectContaining({
        status: "REVOKED",
        revokedById: "admin-1",
        version: { increment: 1 },
      }),
    });
    expect(prisma.loyaltyCallAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        annaPersonId: "person-1",
        status: { in: ["PENDING", "IN_PROGRESS"] },
      },
      data: expect.objectContaining({
        status: "CANCELLED",
        version: { increment: 1 },
      }),
    });
    expect(prisma.loyaltyEntityChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "ARCHIVE",
        changedFields: ["archivedAt", "activeLinks", "openCallAssignments"],
        beforeValues: expect.objectContaining({
          activeLinks: 2,
          openCallAssignments: 3,
        }),
      }),
    });
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

  it("canonicalizes legacy call results and keeps the call period scoped to calls", () => {
    const service = new LoyaltyBaseService(prismaMock());
    const query: any = {
      archived: "exclude",
      page: 1,
      pageSize: 30,
    };
    const filter = (service as any).normalizeListFilter(query, {
      callPeriod: { from: "2026-08-01", to: "2026-08-31" },
      lastCallResults: ["SEND_INFO"],
    });

    (service as any).assertFilterForEntity("anna", "BROKER", filter);

    // The call period must only affect call predicates: it no longer leaks
    // into the activity period silently.
    expect(filter.callPeriod.fromIso).toBe("2026-08-01");
    expect(filter.callPeriod.toIso).toBe("2026-08-31");
    expect(filter.activityPeriod).toBeUndefined();
    expect(filter.lastCallResults).toEqual(["SEND_INFORMATION"]);
    expect((service as any).listFilterHash("anna", "BROKER", filter)).toMatch(
      /^[a-f0-9]{64}$/,
    );

    // dealsInPeriod stays fail-closed: without an activity period the API
    // refuses the predicate instead of silently borrowing the call period
    // (the UI downgrades it to a lifetime dealCount before sending).
    expect(() =>
      (service as any).normalizeListFilter(query, {
        callPeriod: { from: "2026-08-01", to: "2026-08-31" },
        dealsInPeriod: true,
      }),
    ).toThrow("dealsInPeriod requires activityPeriod");
  });

  it("keeps the legacy flat from/to as a shared period for both calls and activity", () => {
    const service = new LoyaltyBaseService(prismaMock());
    const query: any = {
      archived: "exclude",
      page: 1,
      pageSize: 30,
      from: "2026-08-01",
      to: "2026-08-31",
    };
    const filter = (service as any).normalizeListFilter(query);
    expect(filter.callPeriod.fromIso).toBe("2026-08-01");
    expect(filter.activityPeriod.fromIso).toBe("2026-08-01");
    expect(filter.activityPeriod.toIso).toBe("2026-08-31");
  });

  it("normalizes manual Anna attributes and fails closed for an unknown site value", () => {
    const service = new LoyaltyBaseService(prismaMock());
    expect(
      (service as any).annaSpecializations({ specialization: "Премиум" }),
    ).toEqual(["Бизнес / премиум"]);
    expect((service as any).annaWorkFormat({ role: "Координатор" })).toBe(
      "Координатор",
    );
    expect((service as any).annaStage({ stage: "VIP" }, "BROKER")).toBe(
      "Повторные сделки / VIP",
    );
    expect((service as any).annaProjectStatus("Не указано")).toBeNull();
    expect(
      (service as any).matchesScenario("SITE_NOT_PLACED", {
        projectsOnSite: null,
      }),
    ).toBe(true);
    expect(
      (service as any).matchesScenario("NEW_NO_BT", {
        bt: false,
        stage: "Звонили",
      }),
    ).toBe(true);
    expect(
      (service as any).matchesScenario("NEW_NO_BT", {
        bt: true,
        stage: "Новый",
      }),
    ).toBe(false);
    expect(
      (service as any).matchesColumnFilters(
        { columns: { activity: "BT_NOT_VISITED" } },
        {
          hasPhone: true,
          statuses: [],
          bt: null,
          fixations: null,
          meetings: null,
          callPresence: null,
          assignees: null,
          deals: null,
        },
      ),
    ).toBe(true);
    expect(
      (service as any).matchesColumnFilters(
        { columns: { activity: "BT_NOT_VISITED" } },
        {
          hasPhone: true,
          statuses: [],
          bt: true,
          fixations: null,
          meetings: null,
          callPresence: null,
          assignees: null,
          deals: null,
        },
      ),
    ).toBe(false);
    expect(
      (service as any).annaBrokerTour(
        {
          attributes: { btDate: "2026-03-18" },
          sourceReportedMetrics: { brokerTourVisited: false },
        },
        "BROKER",
      ),
    ).toBe(true);
    expect(
      (service as any).annaBrokerTour(
        {
          attributes: { stage: "Был на БТ" },
          sourceReportedMetrics: { brokerTourVisited: false },
        },
        "BROKER",
      ),
    ).toBe(true);
    expect(
      (service as any).annaBrokerTour(
        {
          attributes: {},
          sourceReportedMetrics: { brokerTourVisited: false },
        },
        "BROKER",
      ),
    ).toBe(false);
    expect(
      (service as any).matchesColumnFilters(
        {
          columns: {
            contact: "HAS_PHONE",
            activity: "NO_MEETINGS",
            deals: "THREE_PLUS",
          },
        },
        {
          hasPhone: true,
          statuses: ["TOP_SELLER"],
          bt: null,
          fixations: null,
          meetings: 0,
          callPresence: null,
          assignees: [],
          deals: 3,
        },
      ),
    ).toBe(true);
    expect(
      (service as any).matchesColumnFilters(
        { columns: { calls: "NOT_CALLED_IN_PERIOD" } },
        {
          hasPhone: true,
          statuses: [],
          bt: null,
          fixations: null,
          meetings: null,
          callPresence: null,
          assignees: null,
          deals: null,
        },
      ),
    ).toBe(false);
    expect(
      (service as any).annaPeriodMetrics(
        {
          activities: [
            {
              type: "FIXATION",
              occurredAt: new Date("2026-08-02T10:00:00.000Z"),
            },
            {
              type: "DEAL",
              occurredAt: new Date("2026-08-03T10:00:00.000Z"),
              amount: "1500000.00",
            },
            {
              type: "DEAL",
              occurredAt: new Date("2026-07-03T10:00:00.000Z"),
              amount: "999.00",
            },
          ],
        },
        {
          metricSource: {
            kind: "EXACT_ACTIVITIES",
            observedThrough: "2026-09-01T00:00:00.000Z",
          },
        },
        {
          from: new Date("2026-08-01T00:00:00.000Z"),
          to: new Date("2026-08-31T23:59:59.999Z"),
          fromIso: "2026-08-01",
          toIso: "2026-08-31",
        },
      ),
    ).toEqual({
      period: { from: "2026-08-01", to: "2026-08-31" },
      availability: "EXACT",
      fixations: 1,
      meetings: 0,
      deals: 1,
      dealAmount: "1500000.00",
      lastFixationAt: "2026-08-02",
      lastMeetingAt: null,
      lastDealAt: "2026-08-03",
    });
  });

  it("uses Moscow calendar boundaries for exact Anna activity timestamps", () => {
    const service = new LoyaltyBaseService(prismaMock());
    const period = (service as any).parseOptionalFilterPeriod(
      { from: "2026-08-01", to: "2026-08-31" },
      "activityPeriod",
    );
    const item = {
      metricSource: {
        kind: "EXACT_ACTIVITIES",
        observedThrough: "2026-09-02T00:00:00.000Z",
      },
    };
    const record = {
      activities: [
        {
          type: "FIXATION",
          occurredAt: new Date("2026-07-31T20:59:59.999Z"),
        },
        {
          type: "FIXATION",
          occurredAt: new Date("2026-07-31T21:00:00.000Z"),
        },
        {
          type: "DEAL",
          occurredAt: new Date("2026-08-31T20:59:59.999Z"),
          amount: "100.00",
        },
        {
          type: "DEAL",
          occurredAt: new Date("2026-08-31T21:00:00.000Z"),
          amount: "900.00",
        },
      ],
    };

    expect((service as any).annaPeriodMetrics(record, item, period)).toEqual({
      period: { from: "2026-08-01", to: "2026-08-31" },
      availability: "EXACT",
      fixations: 1,
      meetings: 0,
      deals: 1,
      dealAmount: "100.00",
      lastFixationAt: "2026-08-01",
      lastMeetingAt: null,
      lastDealAt: "2026-08-31",
    });
    expect(
      (service as any).annaActivityPresence(record, item, "FIXATION", period),
    ).toBe(true);
  });

  it("streams a BOM CSV, neutralizes formulas, masks contacts and audits only counts", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    jest.spyOn(service, "list").mockResolvedValue({
      base: "anna",
      items: [
        {
          id: "person-1",
          displayName: " \t\u000b=SUM(1,1)",
          city: "Москва",
          contactPoints: [
            {
              type: "PHONE",
              value: "+79990000001",
              maskedValue: "+7***01",
            },
            {
              type: "EMAIL",
              value: "secret@example.test",
              maskedValue: "s***@example.test",
            },
          ],
          externalIdentities: [],
          metrics: { fixations: 99 },
          metricSource: { kind: "UNAVAILABLE" },
          sourceReportedMetrics: {
            fixations: 7,
            sourceLabel: "Срез Анны 17.08.2026",
            exactness: "UNKNOWN",
            periodKind: "LIFETIME",
          },
          attributes: {},
        },
      ],
      total: 1,
      filterHash: "a".repeat(64),
    } as any);

    const exported = await service.exportCsv(
      "anna",
      "BROKER",
      { archived: "exclude", search: "secret query" } as any,
      "admin-1",
    );
    const chunks: Buffer[] = [];
    for await (const chunk of exported.stream) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString("utf8");

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("' \t\u000b=SUM(1,1)");
    expect(csv).not.toContain('" \t\u000b=SUM(1,1)"');
    expect(csv).toContain("+7***01");
    expect(csv).not.toContain("+79990000001");
    expect(csv).not.toContain("secret@example.test");
    expect(csv).toContain("Точные фиксации");
    expect(csv).toContain("Срез Анны: фиксации (не подтверждено)");
    expect(csv).toContain("Срез Анны 17.08.2026");
    expect(csv).not.toContain(",99,");
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "admin-1",
        payload: {
          base: "anna",
          entityType: "BROKER",
          rowCount: 1,
          truncated: false,
          maxRows: 50000,
          filterHash: "a".repeat(64),
        },
      }),
    });
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      "secret query",
    );
  });

  it("exports lifetime and selected-period metrics in separate CSV columns", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    jest.spyOn(service, "list").mockResolvedValue({
      base: "ours",
      items: [
        {
          id: "broker-1",
          displayName: "Period broker",
          contactPoints: [],
          externalIdentities: [],
          metrics: {
            fixations: 9,
            meetings: 8,
            deals: 7,
            dealAmount: "700.00",
          },
          metricSource: {
            kind: "LOCAL_PRELIMINARY",
            exactness: "APPROXIMATE",
          },
          periodMetrics: {
            availability: "LOCAL_PRELIMINARY",
            period: { from: "2026-08-01", to: "2026-08-31" },
            fixations: 2,
            meetings: 1,
            deals: 1,
            dealAmount: "100.00",
            lastFixationAt: "2026-08-07",
            lastMeetingAt: null,
            lastDealAt: "2026-08-09",
          },
          attributes: {},
        },
      ],
      total: 1,
      filterHash: "b".repeat(64),
    } as any);

    const exported = await service.exportCsv(
      "ours",
      "BROKER",
      { archived: "exclude" } as any,
      "admin-1",
    );
    const chunks: Buffer[] = [];
    for await (const chunk of exported.stream) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString("utf8");

    expect(csv).toContain("Выбранный период: доступность");
    expect(csv).toContain("Выбранный период: последняя сделка");
    expect(csv).toContain(
      '"9","8","7","700.00","LOCAL_PRELIMINARY","2026-08-01","2026-08-31","2","1","1","100.00","2026-08-07","","2026-08-09"',
    );
  });

  it("resolves workflow selections with the canonical IDs and hash", async () => {
    const service = new LoyaltyBaseService(prismaMock());
    jest.spyOn(service, "list").mockResolvedValue({
      _selectionIds: ["broker-2", "broker-1"],
      total: 2,
      filterHash: "b".repeat(64),
      snapshotId: "snapshot-1",
    } as any);

    await expect(
      service.resolveSelection("anna", "BROKER", {
        archived: "exclude",
        search: "",
      } as any),
    ).resolves.toEqual({
      ids: ["broker-2", "broker-1"],
      total: 2,
      filterHash: "b".repeat(64),
      snapshotId: "snapshot-1",
    });
  });

  // 2026-09-04 (аудит фильтров, задача A): резолв выборки для обзвона
  // всегда исключает брокеров «не звонить» и не меняет filterHash.
  it("resolveSelection для обзвона исключает брокеров doNotCall", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    jest.spyOn(service, "list").mockResolvedValue({
      _selectionIds: ["broker-1", "broker-2", "broker-3"],
      total: 3,
      filterHash: "b".repeat(64),
      snapshotId: null,
    } as any);
    prisma.broker.findMany.mockResolvedValue([{ id: "broker-2" }]);

    await expect(
      service.resolveSelection(
        "ours",
        "BROKER",
        { archived: "exclude", search: "" } as any,
        { excludeDoNotCall: true },
      ),
    ).resolves.toEqual({
      ids: ["broker-1", "broker-3"],
      total: 2,
      filterHash: "b".repeat(64),
      snapshotId: null,
      excludedDoNotCall: 1,
    });
    expect(prisma.broker.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["broker-1", "broker-2", "broker-3"] },
        doNotCall: true,
      },
      select: { id: true },
    });

    // Без опции (экспорт/список) выборка не меняется.
    prisma.broker.findMany.mockClear();
    await expect(
      service.resolveSelection("ours", "BROKER", {
        archived: "exclude",
        search: "",
      } as any),
    ).resolves.toMatchObject({
      ids: ["broker-1", "broker-2", "broker-3"],
      total: 3,
    });
    expect(prisma.broker.findMany).not.toHaveBeenCalled();
  });

  // 2026-09-04 (задача A): фильтр «не звонить» в списке «Нашей базы» —
  // по умолчанию показываются все, exclude/only сужают выборку в БД.
  it("фильтр doNotCall списка брокеров и его недоступность вне «Нашей базы»", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.findMany.mockResolvedValue([]);

    await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { doNotCall: "exclude" } as any,
    );
    expect(prisma.broker.findMany.mock.calls[0][0].where.doNotCall).toBe(false);

    prisma.broker.findMany.mockClear();
    await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { doNotCall: "only" } as any,
    );
    expect(prisma.broker.findMany.mock.calls[0][0].where.doNotCall).toBe(true);

    prisma.broker.findMany.mockClear();
    await service.list("ours", "BROKER", { page: 1, pageSize: 30 } as any);
    expect(
      prisma.broker.findMany.mock.calls[0][0].where.doNotCall,
    ).toBeUndefined();

    // Вне «Нашей базы»/брокеров фильтр fail-closed.
    await expect(
      service.list(
        "anna",
        "BROKER",
        { page: 1, pageSize: 30 } as any,
        undefined,
        { doNotCall: "exclude" } as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // 2026-09-04 (задача B, вариант В): «Действующая фиксация» — протухшая
  // фиксация не проходит, живая (или бессрочная) проходит.
  it("«действующая фиксация»: семантика сроков и включение в where списка", async () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    const where = activeFixationClientWhere(now);
    // Мини-интерпретатор ровно тех операторов, что использует where
    // (равенство null и gt) — фиксирует семантику предиката.
    const matches = (client: Record<string, unknown>) =>
      where.OR.some((branch: any) => {
        const statusField =
          "fixationStatus" in branch ? "fixationStatus" : "uniquenessStatus";
        if (client[statusField] !== branch[statusField]) return false;
        return branch.OR.some((expiry: any) => {
          const [field, condition] = Object.entries(expiry)[0] as [
            string,
            { gt: Date } | null,
          ];
          const value = client[field] as Date | null;
          return condition === null
            ? value === null
            : value instanceof Date && value > condition.gt;
        });
      });

    const live = new Date("2026-10-01T00:00:00.000Z");
    const expired = new Date("2026-08-01T00:00:00.000Z");
    // Живая условная уникальность проходит; протухшая — нет.
    expect(
      matches({ uniquenessStatus: "CONDITIONALLY_UNIQUE", uniquenessExpiresAt: live }),
    ).toBe(true);
    expect(
      matches({ uniquenessStatus: "CONDITIONALLY_UNIQUE", uniquenessExpiresAt: expired }),
    ).toBe(false);
    // FIXED живёт по своему сроку fixationExpiresAt; null = бессрочно.
    expect(
      matches({ fixationStatus: "FIXED", fixationExpiresAt: live }),
    ).toBe(true);
    expect(
      matches({ fixationStatus: "FIXED", fixationExpiresAt: expired }),
    ).toBe(false);
    expect(
      matches({ fixationStatus: "FIXED", fixationExpiresAt: null }),
    ).toBe(true);
    expect(
      matches({ fixationStatus: "NOT_FIXED", uniquenessStatus: "NOT_UNIQUE" }),
    ).toBe(false);

    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.findMany.mockResolvedValue([]);
    await service.list("ours", "BROKER", {
      page: 1,
      pageSize: 30,
      columns: { activity: "HAS_ACTIVE_FIXATIONS" },
    } as any);
    const and = prisma.broker.findMany.mock.calls[0][0].where.AND;
    const clause = and.find((entry: any) => entry?.clients?.some?.OR);
    expect(clause.clients.some.OR).toEqual([
      expect.objectContaining({ fixationStatus: "FIXED" }),
      expect.objectContaining({ uniquenessStatus: "CONDITIONALLY_UNIQUE" }),
    ]);

    // Для базы Анны «действующая фиксация» недоступна (нет сроков).
    await expect(
      service.list("anna", "BROKER", {
        page: 1,
        pageSize: 30,
        columns: { activity: "HAS_ACTIVE_FIXATIONS" },
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // 2026-09-04 (задача C): частичный номер находит брокера — условия
  // buildPhoneSearchConditions и их зеркало на дополнительные телефоны.
  it("поиск брокера по частичному телефону использует digits-условия", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.findMany.mockResolvedValue([]);
    await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      "5724188",
    );
    const and = prisma.broker.findMany.mock.calls[0][0].where.AND;
    const search = and.find((entry: any) => Array.isArray(entry?.OR));
    expect(search.OR).toEqual(
      expect.arrayContaining([
        { phone: { contains: "5724188" } },
        { phones: { some: { phone: { contains: "5724188" } } } },
      ]),
    );

    // «8912…» дополнительно ищется с префиксом 7 (в БД номера +79…).
    prisma.broker.findMany.mockClear();
    await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      "8912455",
    );
    const prefixed = prisma.broker.findMany.mock.calls[0][0].where.AND.find(
      (entry: any) => Array.isArray(entry?.OR),
    );
    expect(prefixed.OR).toEqual(
      expect.arrayContaining([{ phone: { contains: "7912455" } }]),
    );
  });

  // 2026-09-04 (задача E): activityType=CALL видит workflow-звонки — where
  // содержит OR по легаси CallLog и попыткам кампаний лояльности.
  it("activityType=CALL у брокеров учитывает workflow-звонки", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.findMany.mockResolvedValue([]);
    await service.list("ours", "BROKER", {
      page: 1,
      pageSize: 30,
      activityType: "CALL",
    } as any);
    const and = prisma.broker.findMany.mock.calls[0][0].where.AND;
    const clause = and.find((entry: any) => entry?.AND?.[0]?.OR);
    expect(clause.AND[0].OR).toEqual([
      { callLogs: { some: {} } },
      { loyaltyAssignmentsAsTarget: { some: { attempts: { some: {} } } } },
    ]);
  });

  // 2026-09-04 (задача F): «тип активности» у агентств без периода работает
  // lifetime, а не возвращает пустой список через UNAVAILABLE-метрики.
  it("агентский activityType без периода работает lifetime", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const agency: any = {
      id: "agency-activity",
      name: "Active agency",
      inn: "7700000002",
      phone: "+7 (495) 000-11-22",
      email: null,
      brokerAgencies: [
        {
          isPrimary: true,
          broker: {
            id: "broker-1",
            fullName: "Broker 1",
            phone: "+79990000001",
            email: null,
            lastCallAt: null,
            brokerTourVisited: false,
            brokerTourDate: null,
            clients: [],
            meetings: [
              {
                id: "meeting-1",
                date: new Date("2026-05-03T10:00:00.000Z"),
                status: "COMPLETED",
                type: "OFFICE",
              },
            ],
            deals: [],
            callLogs: [],
          },
        },
      ],
      deals: [],
      _count: { brokerAgencies: 1 },
    };
    prisma.agency.findMany.mockResolvedValue([agency]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);

    const withMeetings: any = await service.list("ours", "AGENCY", {
      page: 1,
      pageSize: 30,
      activityType: "MEETING",
    } as any);
    expect(withMeetings.total).toBe(1);
    expect(withMeetings.items[0].id).toBe("agency-activity");

    const withFixations: any = await service.list("ours", "AGENCY", {
      page: 1,
      pageSize: 30,
      activityType: "FIXATION",
    } as any);
    expect(withFixations.total).toBe(0);
  });

  it.each([
    ["BROKER", { partnershipStatuses: ["VIP_PARTNER"] }],
    ["BROKER", { agencySizes: ["LARGE"] }],
    ["BROKER", { websitePresent: true }],
    ["BROKER", { projectsOnSite: ["YES"] }],
    ["BROKER", { individualTerms: true }],
    ["AGENCY", { scenario: "SITE_PLACED" }],
    ["AGENCY", { specializations: ["RESIDENTIAL"] }],
    ["AGENCY", { geography: ["MOSCOW"] }],
    ["AGENCY", { workFormats: ["PRIVATE_BROKER"] }],
    ["AGENCY", { relationshipStages: ["NEW"] }],
    ["AGENCY", { dataQuality: ["MISSING_PHONE"] }],
    ["AGENCY", { agencySizes: ["LARGE"] }],
    ["AGENCY", { websitePresent: false }],
    ["AGENCY", { projectsOnSite: ["NO"] }],
  ] as const)(
    "rejects an unsupported OUR %s dimension before a full scan: %j",
    async (entityType, unsupportedFilter) => {
      const prisma = prismaMock();
      const service = new LoyaltyBaseService(prisma);

      await expect(
        service.list(
          "ours",
          entityType,
          {} as any,
          undefined,
          unsupportedFilter as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.broker.findMany).not.toHaveBeenCalled();
      expect(prisma.agency.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    { archived: "only" },
    { hasAmo: true },
    { segment: "NOT_CALLED_CURRENT_MONTH" },
  ])(
    "rejects an unsupported flat OUR agency dimension before a full scan: %j",
    async (unsupportedFilter) => {
      const prisma = prismaMock();
      const service = new LoyaltyBaseService(prisma);

      await expect(
        service.list("ours", "AGENCY", unsupportedFilter as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.agency.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "BROKER",
      {},
      { partnershipStatuses: ["VIP_PARTNER"] },
      ["partnershipStatuses"],
    ],
    ["AGENCY", { hasAmo: true }, {}, ["hasAmo"]],
    ["AGENCY", { archived: "only" }, {}, ["archived"]],
    ["AGENCY", {}, { dataQuality: ["FULL"] }, ["dataQuality"]],
    ["AGENCY", {}, { scenario: "SITE_PLACED" }, ["scenario"]],
  ] as const)(
    "keeps unsupported OUR %s filter rejection identical for list/search/export/selection: %j / %j",
    async (entityType, flat, canonical, expectedFields) => {
      const prisma = prismaMock();
      const service = new LoyaltyBaseService(prisma);
      const request = { search: "", ...flat, filter: canonical };
      const actions = [
        () =>
          service.list(
            "ours",
            entityType,
            flat as any,
            undefined,
            canonical as any,
          ),
        () => service.search("ours", entityType, request as any),
        () => service.exportCsv("ours", entityType, request as any, "admin-1"),
        () => service.resolveSelection("ours", entityType, request as any),
      ];

      for (const action of actions) {
        const error = await action().catch((caught) => caught);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toMatchObject({
          code: "LOYALTY_FILTER_UNAVAILABLE",
          base: "ours",
          entityType,
          fields: expectedFields,
        });
      }
      expect(prisma.broker.findMany).not.toHaveBeenCalled();
      expect(prisma.agency.findMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("reads saved calls and engagement events across all four canonical targets", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const campaignId = "11111111-1111-4111-8111-111111111111";
    const originalAt = new Date(Date.now() - 60_000);
    const correctedAt = new Date();
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "dataset-1",
      activeSnapshotId: "snapshot-1",
      activeSnapshot: {
        id: "snapshot-1",
        datasetId: "dataset-1",
        status: "PUBLISHED",
        activityCount: 1,
        ruleVersion: "anna-v1",
      },
    });
    prisma.loyaltyManualEntity.findMany.mockResolvedValue([]);
    const annaRecord = (entityType: "BROKER" | "AGENCY", id: string): any => ({
      id: `record-${id}`,
      entityType,
      personId: entityType === "BROKER" ? id : null,
      organizationId: entityType === "AGENCY" ? id : null,
      displayName: id,
      city: "Moscow",
      attributes:
        entityType === "BROKER"
          ? {
              calls: [
                {
                  date: "2026-01-01",
                  campaign: "Legacy",
                  result: "LEGACY_RESULT",
                },
              ],
            }
          : {
              agencyContacts: [{ name: "Contact", phone: "+79990000001" }],
            },
      person:
        entityType === "BROKER"
          ? {
              id,
              updatedAt: correctedAt,
              links: [],
              contactOverrides: [],
            }
          : null,
      organization:
        entityType === "AGENCY"
          ? {
              id,
              updatedAt: correctedAt,
              links: [],
              contactOverrides: [],
              personRoles: [],
              contactPeople: [
                {
                  id: "manual-contact",
                  displayName: "Contact",
                  role: "Director",
                  actualityStatus: "CURRENT",
                  contactPoints: [
                    {
                      type: "PHONE",
                      value: "+79990000001",
                      isPrimary: true,
                    },
                  ],
                  version: 1,
                },
              ],
            }
          : null,
      contactPoints: [],
      externalIdentities: [],
      metrics: [],
      sourceAggregate: null,
      organizationRoles: [],
      activities:
        entityType === "BROKER"
          ? [
              {
                type: "CALL",
                occurredAt: new Date("2026-02-01T10:00:00.000Z"),
                metadata: { resultCode: "SNAPSHOT_RESULT" },
              },
            ]
          : [],
      fieldValues: [],
    });
    const annaBroker = annaRecord("BROKER", "anna-broker");
    const annaAgency = annaRecord("AGENCY", "anna-agency");
    const ourBroker: any = {
      id: "our-broker",
      role: "BROKER",
      fullName: "Our broker",
      phone: "+79990000002",
      phones: [],
      brokerAgencies: [],
      callLogs: [],
      clients: [],
      meetings: [],
      deals: [],
      mergedIntoId: null,
      assignedManagerId: null,
      assignedManager: null,
      brokerTourVisited: false,
      _count: { clients: 0, deals: 0, meetings: 0, callLogs: 0, calls: 0 },
    };
    const ourAgency: any = {
      id: "our-agency",
      name: "Our agency",
      inn: "7700000000",
      phone: "+74950000000",
      brokerAgencies: [],
      _count: { brokerAgencies: 0, deals: 0 },
    };
    const assignment = (target: Record<string, string | null>) => ({
      ...target,
      campaign: { id: campaignId, name: "Campaign" },
    });
    const attempt = (
      id: string,
      target: Record<string, string | null>,
      result: string,
      correctsAttemptId: string | null = null,
      occurredAt = originalAt,
    ) => ({
      id,
      assignmentId: `assignment-${id}`,
      operatorId: "operator-1",
      result,
      comment: `${id} comment`,
      nextStep: `${id} next step`,
      nextActionAt: correctedAt,
      source: "LOYALTY_CALL_QUEUE",
      correctsAttemptId,
      correctionReason: correctsAttemptId ? "Corrected" : null,
      occurredAt,
      createdAt: occurredAt,
      operator: { id: "operator-1", fullName: "Operator" },
      assignment: assignment(target),
    });
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([
      attempt(
        "anna-original",
        {
          annaPersonId: "anna-broker",
          annaOrganizationId: null,
          ourBrokerId: null,
          ourAgencyId: null,
        },
        "NO_ANSWER",
      ),
      attempt(
        "anna-correction",
        {
          annaPersonId: "anna-broker",
          annaOrganizationId: null,
          ourBrokerId: null,
          ourAgencyId: null,
        },
        "SEND_INFORMATION",
        "anna-original",
        correctedAt,
      ),
      attempt(
        "anna-agency-call",
        {
          annaPersonId: null,
          annaOrganizationId: "anna-agency",
          ourBrokerId: null,
          ourAgencyId: null,
        },
        "COOPERATION_AGREED",
      ),
      attempt(
        "our-broker-call",
        {
          annaPersonId: null,
          annaOrganizationId: null,
          ourBrokerId: "our-broker",
          ourAgencyId: null,
        },
        "SEND_INFORMATION",
      ),
      attempt(
        "our-agency-call",
        {
          annaPersonId: null,
          annaOrganizationId: null,
          ourBrokerId: null,
          ourAgencyId: "our-agency",
        },
        "AGREEMENTS_EXIST",
      ),
    ]);
    const event = (id: string, target: Record<string, string | null>) => ({
      id,
      ...target,
      type: "INDIVIDUAL_TERMS",
      occurredAt: originalAt,
      createdAt: originalAt,
      comment: "Terms",
      amount: null,
      value: "2%",
      validUntil: null,
      attachmentUrl: null,
      basisUrl: null,
      createdById: "operator-1",
      createdBy: { id: "operator-1", fullName: "Operator" },
      correctsEventId: null,
      correctionReason: null,
      archivedAt: null,
    });
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([
      event("anna-event", {
        annaPersonId: "anna-broker",
        annaOrganizationId: null,
        ourBrokerId: null,
        ourAgencyId: null,
      }),
      {
        ...event("anna-event-correction", {
          annaPersonId: "anna-broker",
          annaOrganizationId: null,
          ourBrokerId: null,
          ourAgencyId: null,
        }),
        occurredAt: new Date(originalAt.getTime() - 86_400_000),
        createdAt: correctedAt,
        value: "3%",
        correctsEventId: "anna-event",
        correctionReason: "Earlier business date confirmed",
      },
      {
        ...event("anna-award", {
          annaPersonId: "anna-broker",
          annaOrganizationId: null,
          ourBrokerId: null,
          ourAgencyId: null,
        }),
        type: "AWARD",
      },
      event("our-agency-event", {
        annaPersonId: null,
        annaOrganizationId: null,
        ourBrokerId: null,
        ourAgencyId: "our-agency",
      }),
      {
        ...event("our-agency-award", {
          annaPersonId: null,
          annaOrganizationId: null,
          ourBrokerId: null,
          ourAgencyId: "our-agency",
        }),
        type: "AWARD",
      },
    ]);
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([annaBroker]);
    const annaList: any = await service.list(
      "anna",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { lastCallResults: ["SEND_INFORMATION"], rewardPresent: true } as any,
    );
    expect(annaList.total).toBe(1);
    expect(annaList.items[0]).toMatchObject({
      lastCallResult: "SEND_INFORMATION",
      lastCallCampaignId: campaignId,
      lastCallOperator: "Operator",
      lastCallNextStep: "anna-correction next step",
      rewardPresent: true,
    });
    expect(annaList.items[0].metrics.calls).toBeNull();
    expect(annaList.facets.engagementTypes).toEqual([
      { value: "AWARD", matches: 1 },
      { value: "INDIVIDUAL_TERMS", matches: 1 },
    ]);
    expect(prisma.loyaltyCallAttempt.findMany).toHaveBeenCalledTimes(1);

    prisma.loyaltySourceRecord.findFirst
      .mockResolvedValueOnce(annaBroker)
      .mockResolvedValueOnce(annaAgency);
    const annaBrokerDetail: any = await service.detail(
      "anna",
      "BROKER",
      "anna-broker",
    );
    const annaAgencyDetail: any = await service.detail(
      "anna",
      "AGENCY",
      "anna-agency",
    );
    expect(annaBrokerDetail.item.calls.map((call: any) => call.result)).toEqual(
      expect.arrayContaining([
        "LEGACY_RESULT",
        "SNAPSHOT_RESULT",
        "NO_ANSWER",
        "SEND_INFORMATION",
      ]),
    );
    expect(annaBrokerDetail.item.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "anna-original",
          type: "CALL",
          superseded: true,
        }),
        expect.objectContaining({
          id: "anna-correction",
          effective: true,
          correctionReason: "Corrected",
        }),
      ]),
    );
    expect(annaBrokerDetail.item.activities).toHaveLength(1);
    expect(annaBrokerDetail.item.loyaltyHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "anna-event", superseded: true }),
        expect.objectContaining({
          id: "anna-event-correction",
          effective: true,
          value: "3%",
        }),
      ]),
    );
    expect(annaAgencyDetail.item.calls).toEqual([
      expect.objectContaining({ id: "anna-agency-call", type: "CALL" }),
    ]);
    expect(annaAgencyDetail.item.agencyContactPeople).toEqual([
      expect.objectContaining({
        id: "manual-contact",
        source: "MANUAL_OVERLAY",
      }),
    ]);

    prisma.broker.findMany.mockResolvedValue([ourBroker]);
    prisma.agency.findMany.mockResolvedValue([ourAgency]);
    prisma.deal.groupBy.mockResolvedValue([]);
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: null } });
    const ourBrokerList: any = await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { lastCallResults: ["SEND_INFORMATION"] } as any,
    );
    const ourAgencyList: any = await service.list(
      "ours",
      "AGENCY",
      { page: 1, pageSize: 30 } as any,
      undefined,
      {
        lastCallResults: ["AGREEMENTS_EXIST"],
        rewardPresent: true,
        specialTermsProposed: true,
      } as any,
    );
    expect(ourBrokerList.items[0]).toMatchObject({
      lastCallResult: "SEND_INFORMATION",
      lastCallCampaignId: campaignId,
    });
    // 2026-09-04 (задача E): metrics.calls = легаси CallLog + workflow-звонки
    // (единая семантика ourCalls) — workflow-звонок теперь учитывается.
    expect(ourBrokerList.items[0].metrics.calls).toBe(1);
    expect(ourAgencyList.items[0]).toMatchObject({
      lastCallResult: "AGREEMENTS_EXIST",
      rewardPresent: true,
      specialTermsProposed: true,
    });

    prisma.broker.findUnique.mockResolvedValue(ourBroker);
    prisma.agency.findUnique.mockResolvedValue(ourAgency);
    const ourBrokerDetail: any = await service.detail(
      "ours",
      "BROKER",
      "our-broker",
    );
    const ourAgencyDetail: any = await service.detail(
      "ours",
      "AGENCY",
      "our-agency",
    );
    expect(ourBrokerDetail.item.calls).toEqual([
      expect.objectContaining({ id: "our-broker-call", type: "CALL" }),
    ]);
    expect(ourAgencyDetail.item.calls).toEqual([
      expect.objectContaining({ id: "our-agency-call", type: "CALL" }),
    ]);
    expect(ourAgencyDetail.item.loyaltyHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "our-agency-event" }),
        expect.objectContaining({ id: "our-agency-award" }),
      ]),
    );
  });

  it("labels OUR overview KPIs as local preliminary with per-metric provenance", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    prisma.agency.count.mockResolvedValue(3);
    prisma.client.count.mockResolvedValue(3);
    prisma.meeting.count.mockResolvedValue(2);
    prisma.deal.count.mockResolvedValue(1);
    prisma.deal.aggregate.mockResolvedValue({
      _sum: { amount: "12500000.50" },
    });
    prisma.broker.findMany.mockResolvedValue([]);
    prisma.deal.groupBy.mockResolvedValue([]);

    const result: any = await service.overview("ours", {
      from: "2026-08-01",
      to: "2026-08-31",
    });

    expect(result.metricSource).toMatchObject({
      kind: "LOCAL_PRELIMINARY",
      exactness: "APPROXIMATE",
      periodFilterApplied: true,
      contributingRecords: 6,
    });
    expect(result.dataAvailability).toMatchObject({
      exactActivities: false,
      localPreliminary: true,
      exactness: "APPROXIMATE",
      unknownValuesRemainNull: true,
    });
    expect(result.kpiMetadata["activities.deals"]).toMatchObject({
      source: "LOCAL_PRELIMINARY",
      exactness: "APPROXIMATE",
      provenance: "Deal.id / Deal.signedAt / Deal.status / RegistryDeal.brokerId",
    });
    expect(result.kpiMetadata["agencies.top"].formula).toContain(
      "explicit Deal.agencyId",
    );
    expect(result.activities).toEqual({ fixations: 3, meetings: 2, deals: 1 });
    expect(result.dealAmount).toBe("12500000.50");
  });

  it("ranks and filters OUR brokers by selected-period aggregates rather than lifetime totals", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const broker = (
      id: string,
      fullName: string,
      lifetime: { fixations: number; meetings: number; deals: number },
    ) => ({
      id,
      fullName,
      phone: `+79990000${id === "lifetime" ? "001" : id === "period" ? "002" : "003"}`,
      email: null,
      status: "ACTIVE",
      funnelStage: "DEAL",
      region: "MSK",
      isRegional: false,
      isCoordinator: false,
      specialization: null,
      category: "WARM",
      amoContactId: null,
      mergedIntoId: null,
      brokerTourVisited: false,
      brokerTourDate: null,
      lastCallAt: null,
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
      assignedManagerId: null,
      assignedManager: null,
      phones: [],
      brokerAgencies: [],
      callLogs: [],
      clients: lifetime.fixations
        ? [{ createdAt: new Date("2025-01-10T00:00:00.000Z") }]
        : [],
      meetings: lifetime.meetings
        ? [{ date: new Date("2025-01-11T00:00:00.000Z") }]
        : [],
      deals: lifetime.deals
        ? [{ signedAt: new Date("2025-01-12T00:00:00.000Z") }]
        : [],
      _count: {
        clients: lifetime.fixations,
        meetings: lifetime.meetings,
        deals: lifetime.deals,
        callLogs: 0,
      },
    });
    prisma.broker.findMany.mockResolvedValue([
      broker("lifetime", "Lifetime leader", {
        fixations: 7,
        meetings: 8,
        deals: 9,
      }),
      broker("period", "Period leader", {
        fixations: 1,
        meetings: 1,
        deals: 2,
      }),
      broker("unknown", "Unknown amount", {
        fixations: 0,
        meetings: 0,
        deals: 3,
      }),
    ]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);
    prisma.client.groupBy.mockResolvedValue([
      {
        brokerId: "period",
        _count: { _all: 1 },
        _max: { createdAt: new Date("2026-08-07T10:00:00.000Z") },
      },
    ]);
    prisma.meeting.groupBy.mockResolvedValue([
      {
        brokerId: "period",
        _count: { _all: 1 },
        _max: { date: new Date("2026-08-08T10:00:00.000Z") },
      },
    ]);
    prisma.deal.groupBy.mockImplementation((args: any) => {
      if (args?._max?.signedAt) {
        return Promise.resolve([
          {
            brokerId: "period",
            _count: { _all: 2 },
            _sum: { amount: "200.00" },
            _max: { signedAt: new Date("2026-08-09T10:00:00.000Z") },
          },
          {
            brokerId: "unknown",
            _count: { _all: 1 },
            _sum: { amount: null },
            _max: { signedAt: null },
          },
        ]);
      }
      return Promise.resolve([
        { brokerId: "lifetime", _sum: { amount: "900.00" } },
        { brokerId: "period", _sum: { amount: "200.00" } },
        { brokerId: "unknown", _sum: { amount: "300.00" } },
      ]);
    });

    const canonical: any = {
      activityPeriod: { from: "2026-08-01", to: "2026-08-31" },
    };
    const ranked: any = await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30, sortBy: "deals", sortOrder: "desc" } as any,
      undefined,
      canonical,
    );

    expect(ranked.items.map((item: any) => item.id)).toEqual([
      "period",
      "unknown",
      "lifetime",
    ]);
    expect(ranked.items[0].periodMetrics).toMatchObject({
      availability: "LOCAL_PRELIMINARY",
      exactness: "APPROXIMATE",
      fixations: 1,
      meetings: 1,
      deals: 2,
      dealAmount: "200.00",
      lastFixationAt: "2026-08-07",
      lastMeetingAt: "2026-08-08",
      lastDealAt: "2026-08-09",
    });
    expect(ranked.items[2].periodMetrics).toMatchObject({
      fixations: 0,
      deals: 0,
      lastFixationAt: null,
      lastDealAt: null,
    });
    expect(ranked.items[1].periodMetrics.dealAmount).toBeNull();
    expect(ranked.dataAvailability.activityPeriod).toBe("LOCAL_PRELIMINARY");

    const periodFixationsOnly: any = await service.list(
      "ours",
      "BROKER",
      {
        page: 1,
        pageSize: 30,
        sortBy: "fixations",
        sortOrder: "desc",
        columns: { activity: "HAS_FIXATIONS" },
      } as any,
      undefined,
      canonical,
    );
    expect(periodFixationsOnly.items.map((item: any) => item.id)).toEqual([
      "period",
    ]);
  });

  it("passes the OUR broker deal-count filter from registry deals alone", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const broker = (id: string, phoneSuffix: string) => ({
      id,
      fullName: `Broker ${id}`,
      phone: `+7999000${phoneSuffix}`,
      email: null,
      status: "ACTIVE",
      funnelStage: "NEW_BROKER",
      region: "MSK",
      isRegional: false,
      isCoordinator: false,
      specialization: null,
      category: null,
      amoContactId: null,
      mergedIntoId: null,
      brokerTourVisited: false,
      brokerTourDate: null,
      lastCallAt: null,
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
      assignedManagerId: null,
      assignedManager: null,
      phones: [],
      brokerAgencies: [],
      callLogs: [],
      clients: [],
      meetings: [],
      deals: [],
      _count: { clients: 0, deals: 0, meetings: 0, callLogs: 0 },
    });
    prisma.broker.findMany.mockResolvedValue([
      broker("registry-only", "0011"),
      broker("no-deals", "0012"),
    ]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);
    prisma.deal.groupBy.mockResolvedValue([]);
    prisma.registryDeal.groupBy.mockResolvedValue([
      {
        brokerId: "registry-only",
        _count: { _all: 2 },
        _sum: { amount: "500000.00" },
        _max: { signedAt: new Date("2026-07-10T00:00:00.000Z") },
      },
    ]);

    const result: any = await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { dealCount: { min: 1 } } as any,
    );

    expect(result.items.map((item: any) => item.id)).toEqual([
      "registry-only",
    ]);
    expect(result.items[0].metrics.deals).toBe(2);
    expect(result.items[0].metrics.dealAmount).toBe("500000.00");
    expect(result.items[0].computedStatuses).toContain("SELLER");
  });

  it("applies the selected period to registry deals by signedAt", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const broker = (id: string, phoneSuffix: string) => ({
      id,
      fullName: `Broker ${id}`,
      phone: `+7999000${phoneSuffix}`,
      email: null,
      status: "ACTIVE",
      funnelStage: "NEW_BROKER",
      region: "MSK",
      isRegional: false,
      isCoordinator: false,
      specialization: null,
      category: null,
      amoContactId: null,
      mergedIntoId: null,
      brokerTourVisited: false,
      brokerTourDate: null,
      lastCallAt: null,
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
      assignedManagerId: null,
      assignedManager: null,
      phones: [],
      brokerAgencies: [],
      callLogs: [],
      clients: [],
      meetings: [],
      deals: [],
      _count: { clients: 0, deals: 0, meetings: 0, callLogs: 0 },
    });
    prisma.broker.findMany.mockResolvedValue([
      broker("in-period", "0021"),
      broker("out-of-period", "0022"),
    ]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);
    prisma.client.groupBy.mockResolvedValue([]);
    prisma.meeting.groupBy.mockResolvedValue([]);
    prisma.deal.groupBy.mockResolvedValue([]);
    prisma.registryDeal.groupBy.mockImplementation((args: any) => {
      if (args?.where?.signedAt) {
        // Периодный агрегат: только сделка, подписанная в августе.
        return Promise.resolve([
          {
            brokerId: "in-period",
            _count: { _all: 1 },
            _sum: { amount: "100.00" },
            _max: { signedAt: new Date("2026-08-15T00:00:00.000Z") },
          },
        ]);
      }
      // Lifetime: у обоих брокеров есть по одной строке реестра.
      return Promise.resolve([
        {
          brokerId: "in-period",
          _count: { _all: 1 },
          _max: { signedAt: new Date("2026-08-15T00:00:00.000Z") },
        },
        {
          brokerId: "out-of-period",
          _count: { _all: 1 },
          _max: { signedAt: new Date("2026-01-15T00:00:00.000Z") },
        },
      ]);
    });

    const result: any = await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      undefined,
      {
        activityPeriod: { from: "2026-08-01", to: "2026-08-31" },
        dealCount: { min: 1 },
      } as any,
    );

    expect(result.items.map((item: any) => item.id)).toEqual(["in-period"]);
    expect(result.items[0].periodMetrics).toMatchObject({
      deals: 1,
      dealAmount: "100.00",
      lastDealAt: "2026-08-15",
    });
  });

  it("feeds OUR agency deal metrics from registry deals of its current brokers", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.agency.findMany.mockResolvedValue([
      {
        id: "agency-1",
        name: "Registry Agency",
        legalName: null,
        inn: null,
        phone: "+74950000000",
        email: null,
        brokerAgencies: [
          {
            isPrimary: true,
            broker: {
              id: "broker-1",
              fullName: "Broker",
              phone: "+79990000001",
              email: null,
              lastCallAt: null,
              brokerTourVisited: false,
              brokerTourDate: null,
              clients: [],
              meetings: [],
              deals: [],
              callLogs: [],
            },
          },
        ],
        deals: [],
        _count: { brokerAgencies: 1 },
      },
    ]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);
    prisma.registryDeal.findMany.mockResolvedValue([
      {
        id: "rd-1",
        brokerId: "broker-1",
        signedAt: new Date("2026-08-10T00:00:00.000Z"),
        amount: "300000.00",
      },
    ]);

    const result: any = await service.list(
      "ours",
      "AGENCY",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { dealCount: { min: 1 } } as any,
    );

    expect(result.items.map((item: any) => item.id)).toEqual(["agency-1"]);
    expect(result.items[0].metrics.deals).toBe(1);
    expect(result.items[0].metrics.dealAmount).toBe("300000.00");
  });

  it("builds OUR overview deal leaders and deal amount from registry deals", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.count.mockResolvedValue(0);
    prisma.agency.count.mockResolvedValue(0);
    prisma.client.count.mockResolvedValue(0);
    prisma.meeting.count.mockResolvedValue(0);
    prisma.deal.count.mockResolvedValue(0);
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: null } });
    prisma.deal.groupBy.mockResolvedValue([]);
    // broker.findMany: выборки newRows/birthdayRows пустые, лидерам — имя.
    prisma.broker.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        args?.select?.fullName
          ? [{ id: "broker-1", fullName: "Registry Leader" }]
          : [],
      ),
    );
    prisma.agency.findMany.mockResolvedValue([
      { id: "agency-1", name: "Registry Agency" },
    ]);
    prisma.registryDeal.count.mockResolvedValue(2);
    prisma.registryDeal.aggregate.mockResolvedValue({
      _sum: { amount: "300000.00" },
    });
    prisma.registryDeal.groupBy.mockResolvedValue([
      {
        brokerId: "broker-1",
        _count: { _all: 2 },
        _sum: { amount: "300000.00" },
        _max: { signedAt: new Date("2026-08-20T00:00:00.000Z") },
      },
    ]);
    // Топ-агентство берёт строки реестра через findMany (правило карточки):
    // канал по brokerId отдаёт обе строки, канал по названию — пустой.
    prisma.registryDeal.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.brokerId
          ? [
              {
                id: "rd-1",
                brokerId: "broker-1",
                amount: "150000.00",
                signedAt: new Date("2026-08-20T00:00:00.000Z"),
              },
              {
                id: "rd-2",
                brokerId: "broker-1",
                amount: "150000.00",
                signedAt: new Date("2026-08-10T00:00:00.000Z"),
              },
            ]
          : [],
      ),
    );
    prisma.brokerAgency.findMany.mockResolvedValue([
      { brokerId: "broker-1", agencyId: "agency-1" },
    ]);

    const result: any = await service.overview("ours", {
      from: "2026-08-01",
      to: "2026-08-31",
    });

    expect(result.activities.deals).toBe(2);
    expect(result.dealAmount).toBe("300000.00");
    expect(result.brokers.top).toEqual([
      expect.objectContaining({
        id: "broker-1",
        name: "Registry Leader",
        deals: 2,
        dealAmount: "300000.00",
      }),
    ]);
    expect(result.agencies.top).toEqual([
      expect.objectContaining({
        id: "agency-1",
        name: "Registry Agency",
        deals: 2,
        dealAmount: "300000.00",
      }),
    ]);
  });

  it("attributes registry deals to an OUR agency by normalized name with dedup", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.agency.findMany.mockResolvedValue([
      {
        id: "agency-1",
        name: 'ООО "Ромашка"',
        legalName: null,
        inn: null,
        phone: "+74950000000",
        email: null,
        brokerAgencies: [
          {
            isPrimary: true,
            broker: {
              id: "broker-1",
              fullName: "Broker",
              phone: "+79990000001",
              email: null,
              lastCallAt: null,
              brokerTourVisited: false,
              brokerTourDate: null,
              clients: [],
              meetings: [],
              deals: [],
              callLogs: [],
            },
          },
        ],
        deals: [],
        _count: { brokerAgencies: 1 },
      },
    ]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);
    prisma.registryDeal.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.brokerId
          ? // Канал по брокеру: строка rd-1 привязана к broker-1.
            [
              {
                id: "rd-1",
                brokerId: "broker-1",
                signedAt: new Date("2026-08-10T00:00:00.000Z"),
                amount: "100000.00",
              },
            ]
          : // Канал по названию: rd-1 (дубль, не должен добавиться второй
            // раз) и rd-2 без брокера — добавляется по названию.
            [
              {
                id: "rd-1",
                agencyCanonical: "Ромашка",
                agencyNameRaw: 'ООО "Ромашка"',
                signedAt: new Date("2026-08-10T00:00:00.000Z"),
                amount: "100000.00",
              },
              {
                id: "rd-2",
                agencyCanonical: "ромашка",
                agencyNameRaw: "АН «Ромашка»",
                signedAt: new Date("2026-08-12T00:00:00.000Z"),
                amount: "200000.00",
              },
              {
                id: "rd-3",
                agencyCanonical: "Василёк",
                agencyNameRaw: null,
                signedAt: new Date("2026-08-13T00:00:00.000Z"),
                amount: "999999.00",
              },
            ],
      ),
    );

    const result: any = await service.list(
      "ours",
      "AGENCY",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { dealCount: { min: 1 } } as any,
    );

    expect(result.items.map((item: any) => item.id)).toEqual(["agency-1"]);
    // rd-1 (через брокера) + rd-2 (по названию); rd-1 не задвоен, rd-3 чужой.
    expect(result.items[0].metrics.deals).toBe(2);
    expect(result.items[0].metrics.dealAmount).toBe("300000.00");
  });

  it("attributes registry deals through AGENCY_KEY_ALIASES with dedup intact", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.agency.findMany.mockResolvedValue([
      {
        id: "agency-online",
        name: "ООО «Онлайн Недвижимость»",
        legalName: null,
        inn: null,
        phone: "+74950000000",
        email: null,
        brokerAgencies: [
          {
            isPrimary: true,
            broker: {
              id: "broker-1",
              fullName: "Broker",
              phone: "+79990000001",
              email: null,
              lastCallAt: null,
              brokerTourVisited: false,
              brokerTourDate: null,
              clients: [],
              meetings: [],
              deals: [],
              callLogs: [],
            },
          },
        ],
        deals: [],
        _count: { brokerAgencies: 1 },
      },
      {
        id: "agency-nmarket",
        name: "Нмаркет",
        legalName: null,
        inn: null,
        phone: "+74950000001",
        email: null,
        brokerAgencies: [],
        deals: [],
        _count: { brokerAgencies: 0 },
      },
    ]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);
    prisma.registryDeal.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.brokerId
          ? // Канал по брокеру: rd-1 привязана к broker-1.
            [
              {
                id: "rd-1",
                brokerId: "broker-1",
                signedAt: new Date("2026-08-10T00:00:00.000Z"),
                amount: "100000.00",
              },
            ]
          : // Канал по названию: rd-1 «trend agent» — дубль через алиас, не
            // должна добавиться второй раз; rd-2 «Trend Agent» → карточка
            // «ООО «Онлайн Недвижимость»»; rd-3 «Нмаркет.Про» → «Нмаркет».
            [
              {
                id: "rd-1",
                agencyCanonical: "trend agent",
                agencyNameRaw: null,
                signedAt: new Date("2026-08-10T00:00:00.000Z"),
                amount: "100000.00",
              },
              {
                id: "rd-2",
                agencyCanonical: "Trend Agent",
                agencyNameRaw: null,
                signedAt: new Date("2026-08-12T00:00:00.000Z"),
                amount: "200000.00",
              },
              {
                id: "rd-3",
                agencyCanonical: "Нмаркет.Про",
                agencyNameRaw: null,
                signedAt: new Date("2026-08-13T00:00:00.000Z"),
                amount: "50000.00",
              },
            ],
      ),
    );

    const result: any = await service.list(
      "ours",
      "AGENCY",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { dealCount: { min: 1 } } as any,
    );

    const byId = new Map(
      result.items.map((item: any) => [item.id, item.metrics]),
    );
    // rd-1 (через брокера) + rd-2 (по алиасу); rd-1 не задвоена.
    expect((byId.get("agency-online") as any)?.deals).toBe(2);
    expect((byId.get("agency-online") as any)?.dealAmount).toBe("300000.00");
    // «Нмаркет.Про» из реестра попадает карточке «Нмаркет».
    expect((byId.get("agency-nmarket") as any)?.deals).toBe(1);
    expect((byId.get("agency-nmarket") as any)?.dealAmount).toBe("50000.00");
  });

  it("counts the OUR top agency by the agency-card union rule with dedup", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.count.mockResolvedValue(0);
    prisma.agency.count.mockResolvedValue(1);
    prisma.client.count.mockResolvedValue(0);
    prisma.meeting.count.mockResolvedValue(0);
    prisma.deal.count.mockResolvedValue(1);
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: "500000.00" } });
    prisma.deal.groupBy.mockResolvedValue([]);
    prisma.broker.findMany.mockResolvedValue([]);
    // Сделка с явным agencyId, чей брокер тоже входит в agency-1: не должна
    // посчитаться дважды (через agencyId и через брокера).
    prisma.deal.findMany.mockResolvedValue([
      {
        id: "d-1",
        agencyId: "agency-1",
        brokerId: "broker-1",
        amount: "500000.00",
        signedAt: new Date("2026-08-05T00:00:00.000Z"),
      },
    ]);
    prisma.registryDeal.count.mockResolvedValue(0);
    prisma.registryDeal.aggregate.mockResolvedValue({ _sum: { amount: null } });
    prisma.registryDeal.groupBy.mockResolvedValue([]);
    // Реестр: строка без брокера, совпадающая по названию с agency-1.
    prisma.registryDeal.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.brokerId
          ? []
          : [
              {
                id: "rd-name",
                agencyCanonical: "Ромашка",
                agencyNameRaw: null,
                amount: "250000.00",
                signedAt: new Date("2026-08-20T00:00:00.000Z"),
              },
            ],
      ),
    );
    prisma.brokerAgency.findMany.mockResolvedValue([
      { brokerId: "broker-1", agencyId: "agency-1" },
    ]);
    prisma.agency.findMany.mockResolvedValue([
      { id: "agency-1", name: 'ООО "Ромашка"', legalName: null },
    ]);

    const result: any = await service.overview("ours", {
      from: "2026-08-01",
      to: "2026-08-31",
    });

    expect(result.agencies.top).toEqual([
      expect.objectContaining({
        id: "agency-1",
        deals: 2,
        dealAmount: "750000.00",
      }),
    ]);
  });

  it("keeps unattributed registry deals out of the OUR deals KPI but reports them in metadata", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.broker.count.mockResolvedValue(0);
    prisma.agency.count.mockResolvedValue(0);
    prisma.client.count.mockResolvedValue(0);
    prisma.meeting.count.mockResolvedValue(0);
    prisma.deal.count.mockResolvedValue(0);
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: null } });
    prisma.deal.groupBy.mockResolvedValue([]);
    prisma.broker.findMany.mockResolvedValue([]);
    prisma.agency.findMany.mockResolvedValue([]);
    // Всего в периоде 3 строки реестра, из них 1 привязана к действующему
    // брокеру: KPI показывает 1, «+2 без брокера» уходит в метаданные.
    prisma.registryDeal.count.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.brokerId ? 1 : 3),
    );
    prisma.registryDeal.aggregate.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.brokerId
          ? { _sum: { amount: "100.00" } }
          : { _sum: { amount: "300.00" } },
      ),
    );

    const result: any = await service.overview("ours", {
      from: "2026-08-01",
      to: "2026-08-31",
    });

    expect(result.activities.deals).toBe(1);
    expect(result.dealAmount).toBe("100.00");
    expect(result.kpiMetadata["activities.deals"]).toMatchObject({
      unattributedRegistryDeals: 2,
    });
    expect(result.kpiMetadata["activities.deals"].formula).toContain(
      "excludes 2 registry deal(s)",
    );
    expect(result.kpiMetadata.dealAmount).toMatchObject({
      unattributedRegistryDeals: 2,
      unattributedRegistryAmount: "200.00",
    });
    // KPI брокерского блока считают только владельцев role=BROKER без
    // слияния — как списки при дрилл-дауне.
    const ownerWhere = {
      broker: { is: { role: "BROKER", mergedIntoId: null } },
    };
    expect(prisma.client.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining(ownerWhere),
      }),
    );
    expect(prisma.meeting.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining(ownerWhere),
      }),
    );
    expect(prisma.deal.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining(ownerWhere),
      }),
    );
  });

  it("limits the OUR NOT_CALLED_CURRENT_MONTH segment to ACTIVE brokers like the KPI", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const broker = (id: string, status: string, phoneSuffix: string) => ({
      id,
      fullName: `Broker ${id}`,
      phone: `+7999000${phoneSuffix}`,
      email: null,
      status,
      funnelStage: "NEW_BROKER",
      region: "MSK",
      isRegional: false,
      isCoordinator: false,
      specialization: null,
      category: null,
      amoContactId: null,
      mergedIntoId: null,
      brokerTourVisited: false,
      brokerTourDate: null,
      lastCallAt: null,
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
      assignedManagerId: null,
      assignedManager: null,
      phones: [],
      brokerAgencies: [],
      callLogs: [],
      clients: [],
      meetings: [],
      deals: [],
      _count: { clients: 0, deals: 0, meetings: 0, callLogs: 0 },
    });
    // В реальной БД неактивных отсечёт where; мок возвращает обоих, чтобы
    // проверить и in-memory предикат.
    prisma.broker.findMany.mockResolvedValue([
      broker("active-idle", "ACTIVE", "0031"),
      broker("inactive-idle", "INACTIVE", "0032"),
    ]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);
    prisma.deal.groupBy.mockResolvedValue([]);
    prisma.registryDeal.groupBy.mockResolvedValue([]);

    const result: any = await service.list("ours", "BROKER", {
      page: 1,
      pageSize: 30,
      segment: "NOT_CALLED_CURRENT_MONTH",
    } as any);

    expect(result.items.map((item: any) => item.id)).toEqual(["active-idle"]);
    // where списка тоже требует status=ACTIVE — как KPI «Не звонили».
    const findManyArgs = prisma.broker.findMany.mock.calls[0][0];
    expect(findManyArgs.where.AND).toEqual(
      expect.arrayContaining([{ status: "ACTIVE" }]),
    );
  });

  it("supports OUR call filters without callPeriod as lifetime predicates", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const broker = (id: string, phoneSuffix: string, callLogs: any[]) => ({
      id,
      fullName: `Broker ${id}`,
      phone: `+7999000${phoneSuffix}`,
      email: null,
      status: "ACTIVE",
      funnelStage: "NEW_BROKER",
      region: "MSK",
      isRegional: false,
      isCoordinator: false,
      specialization: null,
      category: null,
      amoContactId: null,
      mergedIntoId: null,
      brokerTourVisited: false,
      brokerTourDate: null,
      lastCallAt: null,
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
      assignedManagerId: null,
      assignedManager: null,
      phones: [],
      brokerAgencies: [],
      callLogs,
      clients: [],
      meetings: [],
      deals: [],
      _count: {
        clients: 0,
        deals: 0,
        meetings: 0,
        callLogs: callLogs.length,
      },
    });
    const call = {
      createdAt: new Date("2025-02-01T10:00:00.000Z"),
      campaign: null,
      result: "CONNECTED",
      operatorId: null,
      comment: null,
      nextCallAt: null,
    };
    const load = () => {
      prisma.broker.findMany.mockResolvedValue([
        broker("called-once", "0041", [call]),
        broker("never-called", "0042", []),
      ]);
      prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
      prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);
      prisma.deal.groupBy.mockResolvedValue([]);
      prisma.registryDeal.groupBy.mockResolvedValue([]);
    };

    load();
    const calledEver: any = await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { scenario: "CALLED_IN_PERIOD" } as any,
    );
    expect(calledEver.items.map((item: any) => item.id)).toEqual([
      "called-once",
    ]);

    load();
    const neverCalled: any = await service.list(
      "ours",
      "BROKER",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { scenario: "NOT_CALLED_IN_PERIOD" } as any,
    );
    expect(neverCalled.items.map((item: any) => item.id)).toEqual([
      "never-called",
    ]);

    load();
    const columnNotCalled: any = await service.list("ours", "BROKER", {
      page: 1,
      pageSize: 30,
      columns: { calls: "NOT_CALLED_IN_PERIOD" },
    } as any);
    expect(columnNotCalled.items.map((item: any) => item.id)).toEqual([
      "never-called",
    ]);

    load();
    const calledFlag: any = await service.list("ours", "BROKER", {
      page: 1,
      pageSize: 30,
      called: true,
    } as any);
    expect(calledFlag.items.map((item: any) => item.id)).toEqual([
      "called-once",
    ]);
  });

  it("keeps OUR broker period aggregate SQL batches bounded", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    prisma.client.groupBy.mockResolvedValue([]);
    prisma.meeting.groupBy.mockResolvedValue([]);
    prisma.deal.groupBy.mockResolvedValue([]);
    const ids = Array.from({ length: 501 }, (_, index) => `broker-${index}`);

    const result: Map<string, any> = await (
      service as any
    ).ourBrokerPeriodMetrics(ids, {
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-31T23:59:59.999Z"),
      fromIso: "2026-08-01",
      toIso: "2026-08-31",
    });

    expect(result.size).toBe(501);
    expect(prisma.client.groupBy).toHaveBeenCalledTimes(2);
    for (const [args] of prisma.client.groupBy.mock.calls) {
      expect(args.where.brokerId.in.length).toBeLessThanOrEqual(500);
    }
  });

  it("marks OUR broker activity evidence truncated when only 200 of 250 rows are loaded", () => {
    const service = new LoyaltyBaseService(prismaMock());
    const clients = Array.from({ length: 200 }, (_, index) => ({
      id: `client-${index}`,
      createdAt: new Date(
        `2026-08-${String((index % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
      ),
      fixationStatus: "FIXED",
      amoLeadId: index + 1,
    }));

    const partial = (service as any).ourBrokerEvidence({
      clients,
      meetings: [],
      deals: [],
      _count: { clients: 250, meetings: 0, deals: 0 },
    });
    expect(partial).toMatchObject({
      count: 250,
      truncated: true,
      limit: 200,
    });
    expect(partial.items).toHaveLength(200);

    const complete = (service as any).ourBrokerEvidence({
      clients: [],
      meetings: [],
      deals: [],
      _count: { clients: 0, meetings: 0, deals: 0 },
    });
    expect(complete).toMatchObject({
      count: 0,
      truncated: false,
      limit: 200,
      items: [],
    });
  });

  it("deduplicates current relation rows for OUR agency list/detail and exposes bounded PII-free evidence", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const sharedClient = {
      id: "client-1",
      createdAt: new Date("2026-08-02T10:00:00.000Z"),
      fixationStatus: "FIXED",
      amoLeadId: 101n,
    };
    const sharedMeeting = {
      id: "meeting-1",
      date: new Date("2026-08-03T10:00:00.000Z"),
      status: "CONFIRMED",
      type: "OFFICE",
    };
    const periodDeal = {
      id: "deal-1",
      signedAt: new Date("2026-08-04T10:00:00.000Z"),
      amount: "100.10",
      agencyId: "agency-1",
      status: "SIGNED",
      amoDealId: 201n,
    };
    const laterDeal = {
      id: "deal-2",
      signedAt: new Date("2026-09-04T10:00:00.000Z"),
      amount: "200.20",
      agencyId: null,
      status: "PAID",
      amoDealId: 202n,
    };
    const sharedCall = {
      id: "call-log-1",
      createdAt: new Date("2026-08-05T10:00:00.000Z"),
      campaign: "August",
      result: "AGREEMENTS_EXIST",
      operatorId: "operator-1",
      comment: "must not enter activity evidence",
      nextCallAt: null,
    };
    const broker = (id: string, deals: any[]) => ({
      id,
      fullName: `Broker ${id}`,
      phone: "+79990000001",
      email: null,
      lastCallAt: null,
      brokerTourVisited: false,
      brokerTourDate: null,
      clients: [sharedClient],
      meetings: [sharedMeeting],
      deals,
      callLogs: [sharedCall],
    });
    const agency: any = {
      id: "agency-1",
      name: "Agency",
      legalName: "Agency LLC",
      inn: "7700000000",
      phone: null,
      email: null,
      updatedAt: new Date("2026-08-06T10:00:00.000Z"),
      brokerAgencies: [
        { isPrimary: true, broker: broker("broker-1", [periodDeal]) },
        {
          isPrimary: false,
          broker: broker("broker-2", [periodDeal, laterDeal]),
        },
      ],
      deals: [periodDeal],
      _count: { brokerAgencies: 2 },
    };
    prisma.agency.findMany.mockResolvedValue([agency]);
    prisma.agency.findUnique.mockResolvedValue(agency);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);

    const list: any = await service.list(
      "ours",
      "AGENCY",
      { page: 1, pageSize: 30 } as any,
      undefined,
      {
        includeLowSignal: true,
        activityPeriod: { from: "2026-08-01", to: "2026-08-31" },
      } as any,
    );

    expect(list.items[0].metrics).toMatchObject({
      brokers: 2,
      fixations: 1,
      meetings: 1,
      deals: 2,
      calls: 1,
      dealAmount: "300.30",
    });
    expect(list.items[0].periodMetrics).toMatchObject({
      availability: "LOCAL_PRELIMINARY",
      exactness: "APPROXIMATE",
      fixations: 1,
      meetings: 1,
      deals: 1,
      dealAmount: "100.10",
    });
    expect(list.items[0].computedStatuses).toEqual(["SELLING_PARTNER"]);
    expect(list.dataAvailability).toMatchObject({
      exactActivities: false,
      localPreliminary: true,
      defaultVisibilityApplied: false,
    });

    const detail: any = await service.detail("ours", "AGENCY", "agency-1");
    expect(detail.item.metrics).toMatchObject({
      fixations: 1,
      meetings: 1,
      deals: 2,
      calls: 1,
      dealAmount: "300.30",
    });
    expect(detail.item.activityEvidence).toMatchObject({
      count: 5,
      truncated: false,
      limit: 200,
      availability: "LOCAL_PRELIMINARY",
      exactness: "APPROXIMATE",
    });
    expect(detail.item.activities.map((row: any) => row.type).sort()).toEqual([
      "CALL",
      "DEAL",
      "DEAL",
      "FIXATION",
      "MEETING",
    ]);
    expect(detail.item.activities.some((row: any) => "comment" in row)).toBe(
      false,
    );
    expect(detail.item.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "LOCAL_DEAL:deal-1",
          amoDealId: "201",
          amount: "100.10",
          status: "SIGNED",
          source: "LOCAL_DEAL",
        }),
      ]),
    );
  });

  it("applies the OUR agency low-signal visibility rule, supports All, and fails loudly for unavailable fields", async () => {
    const prisma = prismaMock();
    const service = new LoyaltyBaseService(prisma);
    const agency: any = {
      id: "agency-low-signal",
      name: "Low signal",
      inn: "7700000001",
      phone: null,
      email: null,
      brokerAgencies: [],
      deals: [],
      _count: { brokerAgencies: 0 },
    };
    prisma.agency.findMany.mockResolvedValue([agency]);
    prisma.loyaltyCallAttempt.findMany.mockResolvedValue([]);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);

    const hidden: any = await service.list("ours", "AGENCY", {
      page: 1,
      pageSize: 30,
    } as any);
    expect(hidden.total).toBe(0);
    expect(hidden.dataAvailability.defaultVisibilityApplied).toBe(true);

    const all: any = await service.list(
      "ours",
      "AGENCY",
      { page: 1, pageSize: 30 } as any,
      undefined,
      { includeLowSignal: true } as any,
    );
    expect(all.total).toBe(1);
    expect(all.filterHash).not.toBe(hidden.filterHash);

    await expect(
      service.list(
        "ours",
        "AGENCY",
        { page: 1, pageSize: 30 } as any,
        undefined,
        { websitePresent: true } as any,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "LOYALTY_FILTER_UNAVAILABLE",
        fields: ["websitePresent"],
      }),
    });
  });
});
