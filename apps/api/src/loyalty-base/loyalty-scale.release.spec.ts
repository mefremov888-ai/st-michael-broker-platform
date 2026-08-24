import "reflect-metadata";
import {
  LoyaltyListQueryDto,
  LoyaltyReconciliationQueryDto,
} from "./loyalty-base.dto";
import {
  LoyaltyBaseService,
  LoyaltyFullScanBusyException,
} from "./loyalty-base.service";

const ANNA_PRODUCTION_ROWS = 6_872;
const OUR_PRODUCTION_BROKERS = 18_893;
const OUR_PRODUCTION_AGENCIES = 202;
const SCALE_CPU_BUDGET_MS = 15_000;
const SCALE_WALL_BUDGET_MS = 55_000;
const SCALE_PIPELINE_HEAP_BUDGET_BYTES = 256 * 1024 * 1024;

type ScaleMeasurement = {
  elapsedMs: number;
  cpuMs: number;
  heapDeltaBytes: number;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function prismaScaleMock() {
  return {
    broker: { findMany: jest.fn(), count: jest.fn() },
    agency: { findMany: jest.fn(), count: jest.fn() },
    deal: { groupBy: jest.fn().mockResolvedValue([]) },
    loyaltyDataset: { findUnique: jest.fn() },
    loyaltySourceRecord: { findMany: jest.fn() },
    loyaltyManualEntity: { findMany: jest.fn().mockResolvedValue([]) },
    loyaltyCallAttempt: { findMany: jest.fn().mockResolvedValue([]) },
    loyaltyEngagementEvent: { findMany: jest.fn().mockResolvedValue([]) },
    loyaltyReconciliationCase: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  } as any;
}

function annaRecord(index: number) {
  const id = `anna-person-${index}`;
  return {
    id: `anna-source-${index}`,
    personId: id,
    organizationId: null,
    entityType: "BROKER",
    displayName: `Anna Broker ${String(index).padStart(5, "0")}`,
    city: index % 2 ? "Москва" : "Регион",
    taxId: null,
    attributes: {},
    sourceArchivedAt: null,
    person: {
      id,
      manualDisplayName: null,
      manualCity: null,
      manualAttributes: null,
      archivedAt: null,
      updatedAt: new Date("2026-08-21T00:00:00.000Z"),
      contactOverrides: [],
      links: [],
    },
    organization: null,
    contactPoints: [
      {
        id: `anna-phone-${index}`,
        type: "PHONE",
        value: `+79${String(index).padStart(9, "0")}`,
        normalizedValue: `+79${String(index).padStart(9, "0")}`,
        isPrimary: true,
      },
    ],
    externalIdentities: [],
    metrics: [],
    sourceAggregate: null,
    organizationRoles: [],
  };
}

function ourBroker(index: number) {
  return {
    id: `our-broker-${index}`,
    fullName: `Our Broker ${String(index).padStart(5, "0")}`,
    phone: `+78${String(index).padStart(9, "0")}`,
    email: null,
    status: "ACTIVE",
    funnelStage: "NEW_BROKER",
    region: index % 2 ? "MSK" : "SPB",
    isRegional: index % 2 === 0,
    isCoordinator: false,
    specialization: null,
    category: null,
    amoContactId: null,
    mergedIntoId: null,
    brokerTourVisited: false,
    brokerTourDate: null,
    lastCallAt: null,
    updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    assignedManagerId: null,
    assignedManager: null,
    phones: [],
    brokerAgencies: [],
    callLogs: [],
    clients: [],
    meetings: [],
    deals: [],
    _count: { clients: 0, deals: 0, meetings: 0, callLogs: 0 },
  };
}

function ourAgenciesWithProductionBrokerGraph() {
  let brokerIndex = 0;
  const agencies = Array.from(
    { length: OUR_PRODUCTION_AGENCIES },
    (_, agencyIndex) => ({
      id: `our-agency-${agencyIndex}`,
      name: `Our Agency ${String(agencyIndex).padStart(3, "0")}`,
      legalName: null,
      inn: null,
      phone: `+76${String(agencyIndex).padStart(9, "0")}`,
      email: null,
      brokerAgencies: [] as any[],
      deals: [],
      _count: { brokerAgencies: 0 },
    }),
  );
  while (brokerIndex < OUR_PRODUCTION_BROKERS) {
    const agency = agencies[brokerIndex % agencies.length];
    const broker = ourBroker(brokerIndex);
    agency.brokerAgencies.push({
      broker,
      brokerId: broker.id,
      agencyId: agency.id,
      isPrimary: true,
    });
    agency._count.brokerAgencies += 1;
    brokerIndex += 1;
  }
  return agencies;
}

async function measure(
  action: () => Promise<unknown>,
): Promise<ScaleMeasurement> {
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  await action();
  const cpu = process.cpuUsage(cpuBefore);
  return {
    elapsedMs: performance.now() - startedAt,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
  };
}

function expectWithinReleaseBudget(measurement: ScaleMeasurement) {
  expect(measurement.cpuMs).toBeLessThan(SCALE_CPU_BUDGET_MS);
  expect(measurement.elapsedMs).toBeLessThan(SCALE_WALL_BUDGET_MS);
  expect(measurement.heapDeltaBytes).toBeLessThan(
    SCALE_PIPELINE_HEAP_BUDGET_BYTES,
  );
}

describe("loyalty production-scale release gate", () => {
  jest.setTimeout(60_000);

  it("maps, filters, sorts and facets the 6,872-row Anna snapshot within a bounded process budget", async () => {
    const prisma = prismaScaleMock();
    const records = Array.from({ length: ANNA_PRODUCTION_ROWS }, (_, index) =>
      annaRecord(index),
    );
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "anna-dataset",
      activeSnapshotId: "anna-snapshot",
      activeSnapshot: {
        id: "anna-snapshot",
        datasetId: "anna-dataset",
        status: "PUBLISHED",
        ruleVersion: "anna-v1",
        recordCount: ANNA_PRODUCTION_ROWS,
        activityCount: 0,
        summary: { sourceAggregates: ANNA_PRODUCTION_ROWS },
      },
    });
    prisma.loyaltySourceRecord.findMany.mockResolvedValue(records);
    const service = new LoyaltyBaseService(prisma);
    let result: any;

    const measurement = await measure(async () => {
      result = await service.list("anna", "BROKER", new LoyaltyListQueryDto());
    });

    expect(result.total).toBe(ANNA_PRODUCTION_ROWS);
    expect(result.items).toHaveLength(30);
    expect(prisma.loyaltySourceRecord.findMany).toHaveBeenCalledTimes(1);
    expectWithinReleaseBudget(measurement);
  });

  it("maps, filters, sorts and facets 18,893 OUR brokers within a bounded process budget", async () => {
    const prisma = prismaScaleMock();
    const records = Array.from({ length: OUR_PRODUCTION_BROKERS }, (_, index) =>
      ourBroker(index),
    );
    prisma.broker.findMany.mockResolvedValue(records);
    const service = new LoyaltyBaseService(prisma);
    let result: any;

    const measurement = await measure(async () => {
      result = await service.list("ours", "BROKER", new LoyaltyListQueryDto());
    });

    expect(result.total).toBe(OUR_PRODUCTION_BROKERS);
    expect(result.items).toHaveLength(30);
    expect(prisma.broker.findMany).toHaveBeenCalledTimes(1);
    expectWithinReleaseBudget(measurement);
  });

  it("aggregates a 202-agency graph containing 18,893 current broker relations within the same budget", async () => {
    const prisma = prismaScaleMock();
    const agencies = ourAgenciesWithProductionBrokerGraph();
    prisma.agency.findMany.mockResolvedValue(agencies);
    const service = new LoyaltyBaseService(prisma);
    let result: any;

    const measurement = await measure(async () => {
      result = await service.list("ours", "AGENCY", new LoyaltyListQueryDto());
    });

    expect(result.total).toBe(OUR_PRODUCTION_AGENCIES);
    expect(result.items).toHaveLength(30);
    expect(
      agencies.reduce(
        (total: number, agency: any) => total + agency.brokerAgencies.length,
        0,
      ),
    ).toBe(OUR_PRODUCTION_BROKERS);
    expectWithinReleaseBudget(measurement);
  });

  it("admits two full scans, fails the third loudly, and releases both successful slots", async () => {
    const prisma = prismaScaleMock();
    const first = deferred<any[]>();
    const second = deferred<any[]>();
    prisma.broker.findMany
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue([]);
    const service = new LoyaltyBaseService(prisma);
    const firstScan = service.list("ours", "BROKER", new LoyaltyListQueryDto());
    const secondScan = service.list(
      "ours",
      "BROKER",
      new LoyaltyListQueryDto(),
    );

    await expect(
      service.list("ours", "BROKER", new LoyaltyListQueryDto()),
    ).rejects.toBeInstanceOf(LoyaltyFullScanBusyException);

    first.resolve([]);
    second.resolve([]);
    await Promise.all([firstScan, secondScan]);
    await expect(
      service.list("ours", "BROKER", new LoyaltyListQueryDto()),
    ).resolves.toMatchObject({ total: 0, items: [] });
  });

  it("releases a full-scan slot after a database error", async () => {
    const prisma = prismaScaleMock();
    prisma.broker.findMany
      .mockRejectedValueOnce(new Error("synthetic database failure"))
      .mockResolvedValue([]);
    const service = new LoyaltyBaseService(prisma);

    await expect(
      service.list("ours", "BROKER", new LoyaltyListQueryDto()),
    ).rejects.toThrow("synthetic database failure");
    await expect(
      service.list("ours", "BROKER", new LoyaltyListQueryDto()),
    ).resolves.toMatchObject({ total: 0, items: [] });
  });

  it("keeps the persisted reconciliation list DB-paginated at the Anna production total", async () => {
    const prisma = prismaScaleMock();
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "anna-dataset",
      activeSnapshotId: "anna-snapshot",
      activeSnapshot: {
        id: "anna-snapshot",
        datasetId: "anna-dataset",
        status: "PUBLISHED",
      },
    });
    prisma.loyaltyReconciliationCase.findMany.mockResolvedValue([]);
    prisma.loyaltyReconciliationCase.count.mockResolvedValue(
      ANNA_PRODUCTION_ROWS,
    );
    const service = new LoyaltyBaseService(prisma);

    const result = await service.reconciliation(
      new LoyaltyReconciliationQueryDto(),
    );

    expect(result).toMatchObject({
      total: ANNA_PRODUCTION_ROWS,
      page: 1,
      pageSize: 30,
      items: [],
    });
    expect(prisma.loyaltyReconciliationCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 30 }),
    );
  });

  it("bounds the cabinet-only anti-join to stable IDs plus one requested page", async () => {
    const prisma = prismaScaleMock();
    const matchedBrokerIds = Array.from(
      { length: 6_670 },
      (_, index) => `matched-broker-${index}`,
    );
    const matchedAgencyIds = Array.from(
      { length: 202 },
      (_, index) => `matched-agency-${index}`,
    );
    prisma.loyaltyDataset.findUnique.mockResolvedValue({
      id: "anna-dataset",
      activeSnapshotId: "anna-snapshot",
      activeSnapshot: {
        id: "anna-snapshot",
        datasetId: "anna-dataset",
        status: "PUBLISHED",
      },
    });
    prisma.loyaltyReconciliationCase.findMany.mockImplementation(
      ({ where }: any) =>
        Promise.resolve(
          (where.targetType === "BROKER"
            ? matchedBrokerIds
            : matchedAgencyIds
          ).map((targetId) => ({ targetId })),
        ),
    );
    prisma.broker.count.mockResolvedValue(OUR_PRODUCTION_BROKERS);
    prisma.agency.count.mockResolvedValue(OUR_PRODUCTION_AGENCIES);
    prisma.broker.findMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        id: `cabinet-broker-${index}`,
        fullName: `Cabinet Broker ${index}`,
        phone: null,
        amoContactId: null,
      })),
    );
    const service = new LoyaltyBaseService(prisma);

    const result = await service.unmatchedCabinetEntities(
      new LoyaltyReconciliationQueryDto(),
    );

    expect(result).toMatchObject({
      total: OUR_PRODUCTION_BROKERS + OUR_PRODUCTION_AGENCIES,
      page: 1,
      pageSize: 30,
    });
    expect(result.items).toHaveLength(30);
    expect(prisma.broker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 30 }),
    );
    expect(prisma.broker.count.mock.calls[0][0].where.id.notIn).toHaveLength(
      matchedBrokerIds.length,
    );
    expect(prisma.agency.count.mock.calls[0][0].where.id.notIn).toHaveLength(
      matchedAgencyIds.length,
    );
  });
});
