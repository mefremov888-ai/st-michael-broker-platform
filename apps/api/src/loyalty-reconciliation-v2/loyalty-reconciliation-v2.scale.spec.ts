import "reflect-metadata";
import { EXCEPTION_FILTERS_METADATA } from "@nestjs/common/constants";
import { LoyaltyListQueryDto } from "../loyalty-base/loyalty-base.dto";
import {
  LoyaltyBaseService,
  LoyaltyFullScanBusyException,
} from "../loyalty-base/loyalty-base.service";
import { LoyaltyFullScanBusyFilter } from "../loyalty-base/loyalty-full-scan-busy.filter";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";
import { LoyaltyReconciliationV2Controller } from "./loyalty-reconciliation-v2.controller";
import { LoyaltyReconciliationV2Service } from "./loyalty-reconciliation-v2.service";

const ANNA_PRODUCTION_BROKERS = 6_670;
const ANNA_PRODUCTION_AGENCIES = 202;
const OUR_PRODUCTION_BROKERS = 18_893;
const OUR_PRODUCTION_AGENCIES = 202;
const SCALE_CPU_BUDGET_MS = 15_000;
const SCALE_WALL_BUDGET_MS = 55_000;
const SCALE_PIPELINE_HEAP_BUDGET_BYTES = 256 * 1024 * 1024;

const admin = {
  id: "scale-admin",
  role: "ADMIN",
  phone: "",
  fullName: "Scale Admin",
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function annaBroker(index: number) {
  return {
    id: `anna-source-broker-${index}`,
    entityType: "BROKER",
    personId: `anna-person-${index}`,
    organizationId: null,
    displayName: `Anna Broker ${String(index).padStart(5, "0")}`,
    city: index % 2 ? "Москва" : "Регион",
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
  };
}

function annaAgency(index: number) {
  return {
    id: `anna-source-agency-${index}`,
    entityType: "AGENCY",
    personId: null,
    organizationId: `anna-organization-${index}`,
    displayName: `Anna Agency ${String(index).padStart(3, "0")}`,
    city: index % 2 ? "Москва" : "Регион",
    taxId: null,
    sourceArchivedAt: null,
    person: null,
    organization: {
      manualDisplayName: null,
      archivedAt: null,
      contactOverrides: [],
    },
    contactPoints: [],
    organizationRoles: [],
  };
}

function ourBroker(index: number) {
  return {
    id: `our-broker-${index}`,
    fullName: `Our Broker ${String(index).padStart(5, "0")}`,
    phone: "",
    email: null,
    status: "ACTIVE",
    source: "BROKER_CABINET",
    mergedIntoId: null,
    phones: [],
    brokerAgencies: [],
  };
}

function ourAgency(index: number) {
  return {
    id: `our-agency-${index}`,
    name: `Our Agency ${String(index).padStart(3, "0")}`,
    legalName: null,
    phone: null,
    email: null,
    address: index % 2 ? "Москва" : "Регион",
  };
}

function reconciliationPrisma(overrides: Record<string, unknown> = {}) {
  const prisma: any = {
    loyaltyDataset: {
      findUnique: jest.fn().mockResolvedValue({
        id: "anna-dataset",
        base: "ANNA",
        activeSnapshotId: "anna-snapshot",
      }),
    },
    loyaltySourceRecord: { findMany: jest.fn().mockResolvedValue([]) },
    loyaltyManualEntity: { findMany: jest.fn().mockResolvedValue([]) },
    loyaltyReconciliationCase: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    broker: { findMany: jest.fn().mockResolvedValue([]) },
    agency: { findMany: jest.fn().mockResolvedValue([]) },
    loyaltyUserGrant: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
  return prisma;
}

function reconciliationService(prisma: any) {
  return new LoyaltyReconciliationV2Service(
    prisma,
    { decideReconciliation: jest.fn() } as any,
    new LoyaltyPermissionService(prisma),
  );
}

describe("loyalty reconciliation V2 production-scale release gate", () => {
  jest.setTimeout(60_000);

  it("builds the current Anna/OUR reconciliation universe within the release budget", async () => {
    const sourceRecords = [
      ...Array.from({ length: ANNA_PRODUCTION_BROKERS }, (_, index) =>
        annaBroker(index),
      ),
      ...Array.from({ length: ANNA_PRODUCTION_AGENCIES }, (_, index) =>
        annaAgency(index),
      ),
    ];
    const brokers = Array.from({ length: OUR_PRODUCTION_BROKERS }, (_, index) =>
      ourBroker(index),
    );
    const agencies = Array.from(
      { length: OUR_PRODUCTION_AGENCIES },
      (_, index) => ourAgency(index),
    );
    const prisma = reconciliationPrisma();
    prisma.loyaltySourceRecord.findMany.mockResolvedValue(sourceRecords);
    prisma.broker.findMany.mockResolvedValue(brokers);
    prisma.agency.findMany.mockResolvedValue(agencies);
    const service = reconciliationService(prisma);
    const heapBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();
    const startedAt = performance.now();

    const result = await service.coverage(
      { base: "anna" } as any,
      admin as any,
    );

    const cpu = process.cpuUsage(cpuBefore);
    const elapsedMs = performance.now() - startedAt;
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    const heapDelta = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
    expect(result.total).toBe(
      ANNA_PRODUCTION_BROKERS + ANNA_PRODUCTION_AGENCIES,
    );
    expect(prisma.loyaltySourceRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.broker.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.agency.findMany).toHaveBeenCalledTimes(1);
    expect(cpuMs).toBeLessThan(SCALE_CPU_BUDGET_MS);
    expect(elapsedMs).toBeLessThan(SCALE_WALL_BUDGET_MS);
    expect(heapDelta).toBeLessThan(SCALE_PIPELINE_HEAP_BUDGET_BYTES);
  });

  it("enforces two process-wide V2 universe slots and rejects a third scan loudly", async () => {
    const dataset = deferred<any>();
    const twoScansStarted = deferred<void>();
    const prisma = reconciliationPrisma();
    let started = 0;
    prisma.loyaltyDataset.findUnique.mockImplementation(() => {
      started += 1;
      if (started === 2) twoScansStarted.resolve();
      return dataset.promise;
    });
    const firstService = reconciliationService(prisma);
    const secondService = reconciliationService(prisma);
    const thirdService = reconciliationService(prisma);

    const firstScan = firstService.coverage(
      { base: "anna" } as any,
      admin as any,
    );
    const secondScan = secondService.coverage(
      { base: "anna" } as any,
      admin as any,
    );
    await twoScansStarted.promise;

    await expect(
      thirdService.coverage({ base: "anna" } as any, admin as any),
    ).rejects.toBeInstanceOf(LoyaltyFullScanBusyException);
    expect(prisma.loyaltyDataset.findUnique).toHaveBeenCalledTimes(2);

    dataset.resolve({
      id: "anna-dataset",
      base: "ANNA",
      activeSnapshotId: "anna-snapshot",
    });
    await Promise.all([firstScan, secondScan]);
    await expect(
      thirdService.coverage({ base: "anna" } as any, admin as any),
    ).resolves.toMatchObject({ total: 0 });
  });

  it("shares the same two process-wide slots between base and V2 scans", async () => {
    const baseRows = deferred<any[]>();
    const baseStarted = deferred<void>();
    const basePrisma: any = {
      broker: {
        findMany: jest.fn(() => {
          baseStarted.resolve();
          return baseRows.promise;
        }),
      },
      deal: { groupBy: jest.fn().mockResolvedValue([]) },
      loyaltyCallAttempt: { findMany: jest.fn().mockResolvedValue([]) },
      loyaltyEngagementEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const dataset = deferred<any>();
    const v2Started = deferred<void>();
    const v2Prisma = reconciliationPrisma({
      loyaltyDataset: {
        findUnique: jest.fn(() => {
          v2Started.resolve();
          return dataset.promise;
        }),
      },
    });
    const baseService = new LoyaltyBaseService(basePrisma);
    const v2Service = reconciliationService(v2Prisma);

    const baseScan = baseService.list(
      "ours",
      "BROKER",
      new LoyaltyListQueryDto(),
    );
    await baseStarted.promise;
    const v2Scan = v2Service.coverage({ base: "anna" } as any, admin as any);
    await v2Started.promise;

    await expect(
      reconciliationService(v2Prisma).coverage(
        { base: "anna" } as any,
        admin as any,
      ),
    ).rejects.toBeInstanceOf(LoyaltyFullScanBusyException);
    expect(v2Prisma.loyaltyDataset.findUnique).toHaveBeenCalledTimes(1);

    baseRows.resolve([]);
    dataset.resolve({
      id: "anna-dataset",
      base: "ANNA",
      activeSnapshotId: "anna-snapshot",
    });
    await Promise.all([baseScan, v2Scan]);
  });

  it("binds the existing Retry-After exception filter to the V2 controller", () => {
    const filters = Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      LoyaltyReconciliationV2Controller,
    );
    expect(filters).toContain(LoyaltyFullScanBusyFilter);
  });
});
