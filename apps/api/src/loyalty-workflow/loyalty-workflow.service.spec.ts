import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UserRole } from "@st-michael/shared";
import { CreateCampaignDto, UpdateTaskDto } from "./loyalty-workflow.dto";
import { LoyaltyWorkflowController } from "./loyalty-workflow.controller";
import { LoyaltyWorkflowService } from "./loyalty-workflow.service";
import { LoyaltyPermissionService } from "./loyalty-permission.service";

const admin = { id: "admin-1", role: "ADMIN", phone: "", fullName: "Admin" };
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

function harness() {
  const prisma: any = {
    broker: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: "manager-2" }),
      findUnique: jest.fn(),
    },
    agency: { findMany: jest.fn().mockResolvedValue([]) },
    loyaltyDataset: { findFirst: jest.fn() },
    loyaltyPerson: { create: jest.fn() },
    loyaltyOrganization: { create: jest.fn() },
    loyaltySourceRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    },
    loyaltyManualEntity: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    loyaltyContactPoint: {
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    loyaltySourceFieldValue: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    loyaltyCallCampaign: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    loyaltyCallAssignment: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      createMany: jest.fn(),
      updateMany: jest.fn(),
    },
    loyaltyCallAttempt: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    },
    loyaltyTask: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    loyaltyEngagementEvent: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    loyaltySavedView: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    loyaltyUserGrant: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    loyaltyWorkflowAudit: { create: jest.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = jest.fn((callback: (tx: any) => unknown) =>
    callback(prisma),
  );
  const loyaltyBase = {
    resolveSelection: jest.fn().mockResolvedValue({
      ids: ["target-1"],
      total: 1,
      filterHash: "a".repeat(64),
      snapshotId: null,
    }),
  };
  return {
    prisma,
    loyaltyBase,
    service: new LoyaltyWorkflowService(
      prisma,
      loyaltyBase as any,
      new LoyaltyPermissionService(prisma),
    ),
  };
}

function engagementEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    annaPersonId: null,
    annaOrganizationId: null,
    ourBrokerId: "broker-target-1",
    ourAgencyId: null,
    type: "GIFT",
    occurredAt: new Date("2026-08-20T10:00:00.000Z"),
    comment: null,
    amount: null,
    value: null,
    validUntil: null,
    attachmentUrl: null,
    basisUrl: null,
    createdById: admin.id,
    createdBy: admin,
    correctsEventId: null,
    correctionReason: null,
    archivedAt: null,
    version: 1,
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    attachments: [],
    ...overrides,
  };
}

function callAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    assignmentId: "assignment-1",
    submissionId: "submission-original",
    operatorId: admin.id,
    result: "INFORMED",
    comment: null,
    nextStep: null,
    nextActionAt: null,
    correctsAttemptId: null,
    correctionReason: null,
    occurredAt: new Date("2026-08-20T10:00:00.000Z"),
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    assignment: {
      assignedToId: admin.id,
      campaign: { entityType: "BROKER" },
    },
    ...overrides,
  };
}

function grant(prisma: any, ...permissions: string[]) {
  prisma.loyaltyUserGrant.findFirst.mockImplementation(({ where }: any) => {
    const requested =
      typeof where.permission === "string"
        ? [where.permission]
        : Array.isArray(where.permission?.in)
          ? where.permission.in
          : [];
    const matched = requested.find((permission: string) =>
      permissions.includes(permission),
    );
    return Promise.resolve(matched ? { id: `grant-${matched}` } : null);
  });
}

describe("LoyaltyWorkflowService security and concurrency", () => {
  it("admits only internal roles at the workflow controller boundary", () => {
    expect(Reflect.getMetadata("roles", LoyaltyWorkflowController)).toEqual([
      UserRole.ADMIN,
      UserRole.MANAGER,
    ]);
  });

  it("forwards expectedVersion for both event archive and restore routes", async () => {
    const workflow: any = {
      archiveEvent: jest.fn().mockResolvedValue({}),
      restoreEvent: jest.fn().mockResolvedValue({}),
    };
    const controller = new LoyaltyWorkflowController(workflow);
    const id = "11111111-1111-4111-8111-111111111111";

    await controller.archiveEvent(id, { expectedVersion: 3 }, admin as any);
    await controller.restoreEvent(id, { expectedVersion: 4 }, admin as any);

    expect(workflow.archiveEvent).toHaveBeenCalledWith(id, 3, admin);
    expect(workflow.restoreEvent).toHaveBeenCalledWith(id, 4, admin);
    expect(
      Reflect.getMetadata(
        "path",
        LoyaltyWorkflowController.prototype.restoreEvent,
      ),
    ).toBe("events/:id/restore");
  });

  it("validates the discriminated campaign selection contract", async () => {
    const valid = plainToInstance(CreateCampaignDto, {
      name: "Campaign",
      message: "Message",
      base: "ours",
      entityType: "brokers",
      filterSnapshot: {},
      filterHash: "a".repeat(64),
      snapshotId: null,
      selection: {
        mode: "FILTER",
        filterHash: "a".repeat(64),
        expectedCount: 10,
        excludedIds: [],
      },
    });
    expect(await validate(valid)).toHaveLength(0);

    const missingCount = plainToInstance(CreateCampaignDto, {
      ...valid,
      selection: { mode: "FILTER", filterHash: "a".repeat(64) },
    });
    const missingIds = plainToInstance(CreateCampaignDto, {
      ...valid,
      selection: { mode: "IDS" },
    });
    expect(await validate(missingCount)).not.toHaveLength(0);
    expect(await validate(missingIds)).not.toHaveLength(0);
  });

  it("rejects BROKER before any workflow read", async () => {
    const { prisma, service } = harness();
    await expect(service.operators(broker)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.broker.findMany).not.toHaveBeenCalled();
  });

  it("lists only operators who are actually eligible for assignment", async () => {
    const { prisma, service } = harness();
    grant(prisma, "READ_ALL");
    prisma.broker.findMany.mockResolvedValue([admin]);

    await expect(service.operators(manager)).resolves.toEqual([
      { id: admin.id, name: admin.fullName, role: admin.role },
    ]);
    expect(prisma.broker.findMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        mergedIntoId: null,
        OR: [
          { role: "ADMIN" },
          {
            role: "MANAGER",
            loyaltyGrants: {
              some: { permission: "CALL_EXECUTE", revokedAt: null },
            },
          },
        ],
      },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true, role: true },
    });
  });

  it("lists every active manager as a grant bootstrap target", async () => {
    const { prisma, service } = harness();
    prisma.broker.findMany.mockResolvedValue([
      { id: manager.id, fullName: manager.fullName, role: manager.role },
    ]);

    await expect(service.grantTargets(admin)).resolves.toEqual([
      { id: manager.id, name: manager.fullName, role: manager.role },
    ]);
    expect(prisma.broker.findMany).toHaveBeenCalledWith({
      where: { role: "MANAGER", status: "ACTIVE", mergedIntoId: null },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true, role: true },
    });
  });

  it("replaces a grant profile atomically with one audit record", async () => {
    const { prisma, service } = harness();
    prisma.broker.findFirst.mockResolvedValue({ id: manager.id });
    prisma.loyaltyUserGrant.findMany.mockResolvedValue([
      { id: "grant-read", permission: "READ_ALL" },
      { id: "grant-import", permission: "IMPORT" },
    ]);
    prisma.loyaltyUserGrant.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyUserGrant.create.mockResolvedValue({ id: "grant-call" });

    await expect(
      service.replaceGrantProfile(
        {
          userId: manager.id,
          permissions: ["READ_ALL", "CALL_EXECUTE"],
        } as any,
        admin,
      ),
    ).resolves.toEqual({
      userId: manager.id,
      permissions: ["CALL_EXECUTE", "READ_ALL"],
      granted: ["CALL_EXECUTE"],
      revoked: ["IMPORT"],
    });
    expect(prisma.loyaltyUserGrant.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["grant-import"] } },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.loyaltyUserGrant.create).toHaveBeenCalledWith({
      data: {
        userId: manager.id,
        permission: "CALL_EXECUTE",
        grantedById: admin.id,
      },
    });
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("returns immutable version 2 campaign IDs for draft recovery", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyCallCampaign.findUnique.mockResolvedValue({
      id: "campaign-recoverable",
      name: "Recoverable",
      message: "Call again",
      base: "OUR",
      entityType: "BROKER",
      status: "DRAFT",
      expectedCount: 2,
      version: 1,
      createdAt: new Date("2026-08-24T10:00:00.000Z"),
      updatedAt: new Date("2026-08-24T10:00:00.000Z"),
      filterHash: "a".repeat(64),
      filterSnapshot: {
        version: 2,
        targetIds: ["target-1", "target-2"],
        selection: { mode: "IDS", expectedCount: 2 },
      },
      createdBy: admin,
      assignments: [],
    });

    await expect(
      service.campaign("campaign-recoverable", admin),
    ).resolves.toMatchObject({
      id: "campaign-recoverable",
      selection: { mode: "IDS", ids: ["target-1", "target-2"] },
      assignments: [],
      assignmentCounts: {
        PENDING: 0,
        IN_PROGRESS: 0,
        COMPLETED: 0,
        CANCELLED: 0,
      },
      assignmentPage: { page: 1, pageSize: 100, total: 0, totalPages: 1 },
    });
  });

  it("paginates campaign assignments and returns authoritative status counts", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyCallCampaign.findUnique.mockResolvedValue({
      id: "campaign-paged",
      name: "Paged",
      message: "Call",
      base: "OUR",
      entityType: "BROKER",
      status: "ACTIVE",
      expectedCount: 7,
      version: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
      filterSnapshot: null,
      createdBy: admin,
    });
    prisma.loyaltyCallAssignment.findMany.mockResolvedValue([
      {
        id: "assignment-page-2",
        status: "COMPLETED",
        version: 1,
        ourBrokerId: "target-page-2",
        assignedTo: manager,
        attempts: [{ result: "INFORMED", occurredAt: new Date() }],
      },
    ]);
    prisma.loyaltyCallAssignment.groupBy.mockResolvedValue([
      { status: "PENDING", _count: { _all: 2 } },
      { status: "IN_PROGRESS", _count: { _all: 1 } },
      { status: "COMPLETED", _count: { _all: 4 } },
    ]);

    await expect(
      service.campaign("campaign-paged", admin, { page: 2, limit: 3 }),
    ).resolves.toMatchObject({
      remainingCount: 3,
      assignmentCounts: {
        PENDING: 2,
        IN_PROGRESS: 1,
        COMPLETED: 4,
        CANCELLED: 0,
      },
      assignmentPage: { page: 2, pageSize: 3, total: 7, totalPages: 3 },
      assignments: [{ id: "assignment-page-2", targetId: "target-page-2" }],
    });
    expect(prisma.loyaltyCallAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 3, take: 3 }),
    );
  });

  it("exports campaign CSV only with EXPORT, neutralizes formulas and audits no contents", async () => {
    const { prisma, service } = harness();
    await expect(
      service.exportCampaign("campaign-export", manager),
    ).rejects.toBeInstanceOf(ForbiddenException);

    prisma.loyaltyCallCampaign.findUnique.mockResolvedValue({
      id: "campaign-export",
      name: '   =WEBSERVICE("https://example.test")',
      status: "ACTIVE",
    });
    prisma.loyaltyCallAssignment.count.mockResolvedValue(1);
    prisma.loyaltyCallAssignment.findMany.mockResolvedValue([
      {
        id: "assignment-export",
        status: "COMPLETED",
        ourBrokerId: "target-export",
        assignedAt: new Date("2026-08-24T10:00:00.000Z"),
        completedAt: new Date("2026-08-24T11:00:00.000Z"),
        cancelledAt: null,
        assignedTo: {
          id: manager.id,
          fullName: "+CMD",
          role: manager.role,
        },
        attempts: [
          {
            result: "INFORMED",
            occurredAt: new Date("2026-08-24T10:30:00.000Z"),
          },
        ],
      },
    ]);

    const result = await service.exportCampaign("campaign-export", admin);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString("utf8");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("'   =WEBSERVICE");
    expect(csv).not.toContain('"   =WEBSERVICE');
    expect(csv).toContain("'+CMD");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledWith({
      data: {
        actorId: admin.id,
        action: "CAMPAIGN_CSV_EXPORTED",
        entityType: "CAMPAIGN",
        entityId: "campaign-export",
        after: { rowCount: 1, sha256: result.sha256 },
      },
    });
    expect(
      JSON.stringify(prisma.loyaltyWorkflowAudit.create.mock.calls[0][0]),
    ).not.toContain("WEBSERVICE");
  });

  it("fails campaign export loudly above the 50k synchronous limit", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyCallCampaign.findUnique.mockResolvedValue({
      id: "campaign-too-large",
      name: "Large",
      status: "ACTIVE",
    });
    prisma.loyaltyCallAssignment.count.mockResolvedValue(50_001);

    await expect(
      service.exportCampaign("campaign-too-large", admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.loyaltyCallAssignment.findMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyWorkflowAudit.create).not.toHaveBeenCalled();
  });

  it("requires READ_ALL for common campaign reads and both grants for mutation", async () => {
    const { prisma, service } = harness();
    await expect(
      service.listCampaigns({ page: 1, limit: 100 }, manager),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.createCampaign(
        {
          name: "Campaign",
          message: "Message",
          base: "ours",
          entityType: "brokers",
          filterSnapshot: {},
          filterHash: "a".repeat(64),
          snapshotId: null,
          selection: { mode: "IDS", ids: ["target-1"] },
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.loyaltyUserGrant.findMany).toHaveBeenCalledWith({
      where: {
        userId: manager.id,
        permission: { in: ["READ_ALL", "CALL_ASSIGN"] },
        revokedAt: null,
      },
      select: { permission: true },
    });
  });

  it.each([
    ["BROKER", "COOPERATION_AGREED"],
    ["AGENCY", "INFORMED"],
  ])(
    "validates a separate %s call result catalog",
    async (entityType, result) => {
      const { prisma, service } = harness();
      grant(prisma, "CALL_EXECUTE");
      prisma.loyaltyCallAssignment.findUnique.mockResolvedValue({
        id: "assignment-1",
        assignedToId: manager.id,
        status: "PENDING",
        campaignId: "campaign-1",
        campaign: { id: "campaign-1", entityType, status: "ACTIVE" },
      });
      await expect(
        service.createAttempt(
          "assignment-1",
          {
            expectedVersion: 1,
            submissionId: "submission-0001",
            result,
          } as any,
          manager,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("requires a nonblank comment for every agency call attempt", async () => {
    const { prisma, service } = harness();
    grant(prisma, "CALL_EXECUTE");
    prisma.loyaltyCallAssignment.findUnique.mockResolvedValue({
      id: "assignment-agency",
      assignedToId: manager.id,
      status: "PENDING",
      campaignId: "campaign-agency",
      campaign: {
        id: "campaign-agency",
        entityType: "AGENCY",
        status: "ACTIVE",
      },
    });
    await expect(
      service.createAttempt(
        "assignment-agency",
        {
          expectedVersion: 1,
          submissionId: "submission-agency-comment",
          result: "NO_ANSWER",
          comment: "   ",
        } as any,
        manager,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns the original attempt for an identical retry", async () => {
    const { prisma, service } = harness();
    grant(prisma, "CALL_EXECUTE");
    prisma.loyaltyCallAssignment.findUnique.mockResolvedValue({
      id: "assignment-1",
      assignedToId: manager.id,
      status: "COMPLETED",
      campaignId: "campaign-1",
      campaign: { id: "campaign-1", entityType: "BROKER", status: "ACTIVE" },
    });
    prisma.loyaltyCallAttempt.findUnique.mockResolvedValue({
      id: "attempt-1",
      assignmentId: "assignment-1",
      operatorId: manager.id,
      submissionId: "submission-0001",
      result: "INFORMED",
      comment: "done",
      nextStep: null,
      nextActionAt: null,
      correctsAttemptId: null,
    });
    await expect(
      service.createAttempt(
        "assignment-1",
        {
          expectedVersion: 1,
          submissionId: "submission-0001",
          result: "INFORMED",
          comment: "done",
        },
        manager,
      ),
    ).resolves.toMatchObject({ id: "attempt-1", idempotent: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("never lets a manager record a result in another employee's queue", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyCallAssignment.findUnique.mockResolvedValue({
      id: "assignment-1",
      assignedToId: "manager-2",
      status: "PENDING",
      campaignId: "campaign-1",
      campaign: { id: "campaign-1", entityType: "BROKER", status: "ACTIVE" },
    });
    prisma.loyaltyUserGrant.findFirst.mockResolvedValue({ id: "grant-1" });

    await expect(
      service.createAttempt(
        "assignment-1",
        {
          expectedVersion: 1,
          submissionId: "submission-other-queue",
          result: "INFORMED",
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.loyaltyCallAttempt.create).not.toHaveBeenCalled();
  });

  it("denies an observer manager queue and call writes without explicit grants", async () => {
    const queueHarness = harness();
    await expect(
      queueHarness.service.queue({ page: 1, limit: 100 }, manager),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      queueHarness.prisma.loyaltyCallAssignment.findMany,
    ).not.toHaveBeenCalled();
    expect(queueHarness.prisma.loyaltyUserGrant.findFirst).toHaveBeenCalledWith(
      {
        where: {
          userId: manager.id,
          permission: { in: ["READ_OWN_QUEUE", "CALL_EXECUTE"] },
          revokedAt: null,
        },
        select: { id: true },
      },
    );

    const attemptHarness = harness();
    attemptHarness.prisma.loyaltyCallAssignment.findUnique.mockResolvedValue({
      id: "assignment-1",
      assignedToId: manager.id,
      status: "PENDING",
      campaignId: "campaign-1",
      campaign: { id: "campaign-1", entityType: "BROKER", status: "ACTIVE" },
    });
    await expect(
      attemptHarness.service.createAttempt(
        "assignment-1",
        {
          expectedVersion: 1,
          submissionId: "submission-no-grant",
          result: "INFORMED",
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      attemptHarness.prisma.loyaltyCallAssignment.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      attemptHarness.prisma.loyaltyCallAttempt.create,
    ).not.toHaveBeenCalled();

    const correctionHarness = harness();
    correctionHarness.prisma.loyaltyCallAttempt.findUnique.mockResolvedValue({
      id: "attempt-1",
      assignmentId: "assignment-1",
      assignment: {
        assignedToId: manager.id,
        campaign: { entityType: "BROKER" },
      },
    });
    await expect(
      correctionHarness.service.correctAttempt(
        "assignment-1",
        "attempt-1",
        {
          submissionId: "submission-correction-no-grant",
          result: "INFORMED",
          correctionReason: "Исправление",
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      correctionHarness.prisma.loyaltyCallAttempt.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      correctionHarness.prisma.loyaltyCallAttempt.create,
    ).not.toHaveBeenCalled();
  });

  it("lets a CALL_EXECUTE-only manager read their own queue", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.permission?.in?.includes("CALL_EXECUTE")
          ? { id: "grant-call" }
          : null,
      ),
    );

    await expect(
      service.queue({ page: 1, limit: 100 }, manager),
    ).resolves.toMatchObject({
      items: [],
      total: 0,
      remaining: 0,
      page: 1,
      pageSize: 100,
      totalPages: 0,
    });
    expect(prisma.loyaltyCallAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assignedToId: manager.id }),
      }),
    );
  });

  it("corrects only the current call-attempt leaf inside a serializable transaction", async () => {
    const { prisma, service } = harness();
    const rows: any[] = [callAttempt()];
    prisma.loyaltyCallAttempt.findUnique.mockImplementation(
      ({ where }: any) => {
        const row = where.id
          ? rows.find((candidate) => candidate.id === where.id)
          : rows.find(
              (candidate) => candidate.submissionId === where.submissionId,
            );
        return Promise.resolve(row || null);
      },
    );
    prisma.loyaltyCallAttempt.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        rows.filter(
          (candidate) =>
            candidate.correctsAttemptId === where.correctsAttemptId,
        ),
      ),
    );
    prisma.loyaltyCallAttempt.create.mockImplementation(({ data }: any) => {
      const created = callAttempt({
        ...data,
        id: `attempt-${rows.length + 1}`,
        assignment: rows[0].assignment,
        occurredAt: new Date("2026-08-21T10:00:00.000Z"),
        createdAt: new Date("2026-08-21T10:00:00.000Z"),
      });
      rows.push(created);
      return Promise.resolve(created);
    });

    const first = await service.correctAttempt(
      "assignment-1",
      "attempt-1",
      {
        submissionId: "submission-correction-1",
        result: "INFORMED",
        correctionReason: "Уточнён комментарий",
      },
      admin,
    );
    expect(first).toMatchObject({
      id: "attempt-2",
      correctsAttemptId: "attempt-1",
      idempotent: false,
    });

    await expect(
      service.correctAttempt(
        "assignment-1",
        "attempt-1",
        {
          submissionId: "submission-stale-branch",
          result: "INFORMED",
          correctionReason: "Параллельная ветка",
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyCallAttempt.create).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
    expect(prisma.$transaction).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
  });

  it("returns a conflict when PostgreSQL aborts a concurrent correction branch", async () => {
    const { prisma, service } = harness();
    prisma.$transaction.mockRejectedValueOnce({ code: "P2034" });

    await expect(
      service.correctAttempt(
        "assignment-1",
        "attempt-1",
        {
          submissionId: "submission-concurrent-branch",
          result: "INFORMED",
          correctionReason: "Конкурентная правка",
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("allows assignment only to an active admin or a manager with CALL_EXECUTE", async () => {
    const { prisma, service } = harness();
    prisma.broker.findFirst.mockResolvedValue(null);

    await expect(
      (service as any).validAssignee("manager-2"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.broker.findFirst).toHaveBeenCalledWith({
      where: {
        id: "manager-2",
        status: "ACTIVE",
        mergedIntoId: null,
        OR: [
          { role: "ADMIN" },
          {
            role: "MANAGER",
            loyaltyGrants: {
              some: { permission: "CALL_EXECUTE", revokedAt: null },
            },
          },
        ],
      },
      select: { id: true },
    });
  });

  it("denies own task reads and writes without queue/call grants", async () => {
    const listHarness = harness();
    await expect(
      listHarness.service.listTasks({ page: 1, limit: 100 } as any, manager),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(listHarness.prisma.loyaltyTask.findMany).not.toHaveBeenCalled();

    const updateHarness = harness();
    updateHarness.prisma.loyaltyTask.findUnique.mockResolvedValue({
      id: "task-1",
      assignedToId: manager.id,
      status: "OPEN",
      version: 1,
    });
    await expect(
      updateHarness.service.updateTask(
        "task-1",
        { expectedVersion: 1, status: "COMPLETED" },
        manager,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(updateHarness.prisma.loyaltyTask.updateMany).not.toHaveBeenCalled();
  });

  it("limits a READ_OWN_QUEUE manager task list to that manager", async () => {
    const { prisma, service } = harness();
    grant(prisma, "READ_OWN_QUEUE");

    await service.listTasks({ page: 1, limit: 100 } as any, manager);

    expect(prisma.loyaltyTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assignedToId: manager.id }),
      }),
    );
  });

  it("lets a CALL_EXECUTE manager update an own task", async () => {
    const { prisma, service } = harness();
    grant(prisma, "CALL_EXECUTE");
    prisma.loyaltyTask.findUnique
      .mockResolvedValueOnce({
        id: "task-1",
        assignedToId: manager.id,
        status: "OPEN",
        version: 1,
      })
      .mockResolvedValueOnce({
        id: "task-1",
        assignedToId: manager.id,
        status: "COMPLETED",
        version: 2,
        assignedTo: manager,
      });
    prisma.loyaltyTask.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.updateTask(
        "task-1",
        { expectedVersion: 1, status: "COMPLETED" },
        manager,
      ),
    ).resolves.toMatchObject({ id: "task-1", status: "COMPLETED" });
    expect(prisma.loyaltyUserGrant.findFirst).toHaveBeenCalledWith({
      where: {
        userId: manager.id,
        permission: "CALL_EXECUTE",
        revokedAt: null,
      },
      select: { id: true },
    });
  });

  it("requires READ_ALL before a manager can read another queue history", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyCallAssignment.findUnique.mockResolvedValue({
      id: "assignment-1",
      assignedToId: "manager-2",
    });

    await expect(
      service.listAttempts("assignment-1", manager),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.loyaltyCallAttempt.findMany).not.toHaveBeenCalled();
  });

  it("returns a paginated queue envelope and prioritizes active manual phones", async () => {
    const { prisma, service } = harness();
    grant(prisma, "READ_OWN_QUEUE");
    prisma.loyaltyCallAssignment.findMany.mockResolvedValue([
      {
        id: "assignment-1",
        version: 2,
        status: "PENDING",
        assignedAt: new Date("2026-08-21T09:00:00.000Z"),
        assignedTo: manager,
        annaPersonId: "anna-person-1",
        annaOrganizationId: null,
        ourBrokerId: null,
        ourAgencyId: null,
        ourBroker: null,
        ourAgency: null,
        campaign: {
          id: "campaign-1",
          name: "August calls",
          message: "Hello",
          base: "ANNA",
          entityType: "BROKER",
          snapshotId: "snapshot-1",
        },
      },
    ]);
    prisma.loyaltyCallAssignment.count
      .mockResolvedValueOnce(250)
      .mockResolvedValueOnce(42);
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([
      {
        snapshotId: "snapshot-1",
        personId: "anna-person-1",
        organizationId: null,
        displayName: "Anna broker",
        city: "Moscow",
        attributes: {},
        contactPoints: [
          {
            value: "+7 900 000-00-01",
            normalizedValue: "79000000001",
            isPrimary: true,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
        person: {
          contactOverrides: [
            {
              value: "+7 900 000-00-02",
              normalizedValue: "79000000002",
              isPrimary: true,
              createdAt: new Date("2026-08-20T00:00:00.000Z"),
            },
          ],
        },
        organization: null,
      },
    ]);

    await expect(
      service.queue({ page: 2, limit: 100 }, manager),
    ).resolves.toMatchObject({
      items: [{ id: "assignment-1", phone: "+7 900 000-00-02" }],
      total: 250,
      remaining: 42,
      page: 2,
      pageSize: 100,
      totalPages: 3,
    });
    expect(prisma.loyaltySourceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            {
              snapshotId: "snapshot-1",
              personId: "anna-person-1",
              person: { is: { archivedAt: null } },
            },
          ],
          sourceArchivedAt: null,
        },
        select: expect.objectContaining({
          person: {
            select: {
              contactOverrides: expect.objectContaining({
                where: { type: "PHONE", archivedAt: null },
              }),
            },
          },
        }),
      }),
    );
  });

  it("filters both stable ANNA owner types from queue source lookups", async () => {
    const { prisma, service } = harness();
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    const campaign = {
      base: "ANNA",
      entityType: "BROKER",
      snapshotId: "snapshot-1",
    };

    await (service as any).queueSourceRecords([
      {
        campaign,
        annaPersonId: "anna-person-1",
        annaOrganizationId: null,
      },
      {
        campaign: { ...campaign, entityType: "AGENCY" },
        annaPersonId: null,
        annaOrganizationId: "anna-organization-1",
      },
    ]);

    expect(prisma.loyaltySourceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            {
              snapshotId: "snapshot-1",
              personId: "anna-person-1",
              person: { is: { archivedAt: null } },
            },
            {
              snapshotId: "snapshot-1",
              organizationId: "anna-organization-1",
              organization: { is: { archivedAt: null } },
            },
          ],
          sourceArchivedAt: null,
        },
      }),
    );
  });

  it("returns authoritative queue remaining counts after an attempt", async () => {
    const { prisma, service } = harness();
    grant(prisma, "CALL_EXECUTE");
    prisma.loyaltyCallAssignment.findUnique.mockResolvedValue({
      id: "assignment-1",
      assignedToId: manager.id,
      status: "PENDING",
      campaignId: "campaign-1",
      version: 1,
      annaPersonId: null,
      annaOrganizationId: null,
      ourBrokerId: "target-1",
      ourAgencyId: null,
      campaign: {
        id: "campaign-1",
        base: "OUR",
        entityType: "BROKER",
        snapshotId: null,
        status: "ACTIVE",
      },
    });
    prisma.broker.findMany.mockResolvedValue([{ id: "target-1" }]);
    prisma.loyaltyCallAttempt.findUnique.mockResolvedValue(null);
    prisma.loyaltyCallAssignment.updateMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyCallAssignment.count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(3);
    prisma.loyaltyCallAttempt.create.mockResolvedValue({
      id: "attempt-1",
      assignmentId: "assignment-1",
      operatorId: manager.id,
      result: "INFORMED",
    });

    await expect(
      service.createAttempt(
        "assignment-1",
        {
          expectedVersion: 1,
          submissionId: "submission-remaining",
          result: "INFORMED",
        },
        manager,
      ),
    ).resolves.toMatchObject({
      id: "attempt-1",
      remaining: 3,
      campaignRemaining: 7,
    });
    expect(prisma.broker.findMany).toHaveBeenCalledWith({
      // 2026-09-04 (задача A): «не звонить» — жёсткий стоп при валидации
      // целей обзвона.
      where: { id: { in: ["target-1"] }, mergedIntoId: null, doNotCall: false },
      select: { id: true },
    });
  });

  it("revalidates an ANNA target inside the attempt transaction before writing", async () => {
    const { prisma, service } = harness();
    grant(prisma, "CALL_EXECUTE");
    prisma.loyaltyCallAssignment.findUnique.mockResolvedValue({
      id: "assignment-1",
      assignedToId: manager.id,
      status: "PENDING",
      campaignId: "campaign-1",
      version: 1,
      annaPersonId: "anna-person-1",
      annaOrganizationId: null,
      ourBrokerId: null,
      ourAgencyId: null,
      campaign: {
        id: "campaign-1",
        base: "ANNA",
        entityType: "BROKER",
        snapshotId: "snapshot-1",
        status: "ACTIVE",
      },
    });
    prisma.loyaltyCallAttempt.findUnique.mockResolvedValue(null);
    // It was active when the assignment was loaded. The in-transaction read
    // now sees neither an active source owner nor an active manual overlay.
    prisma.loyaltySourceRecord.findMany.mockResolvedValue([]);
    prisma.loyaltyManualEntity.findMany.mockResolvedValue([]);

    await expect(
      service.createAttempt(
        "assignment-1",
        {
          expectedVersion: 1,
          submissionId: "submission-archive-race",
          result: "INFORMED",
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.loyaltySourceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          snapshotId: "snapshot-1",
          personId: { in: ["anna-person-1"] },
          person: { is: { archivedAt: null } },
        }),
      }),
    );
    expect(prisma.loyaltyCallAssignment.updateMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyCallAttempt.create).not.toHaveBeenCalled();
    expect(prisma.loyaltyWorkflowAudit.create).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key with different content", async () => {
    const { prisma, service } = harness();
    grant(prisma, "CALL_EXECUTE");
    prisma.loyaltyCallAssignment.findUnique.mockResolvedValue({
      id: "assignment-1",
      assignedToId: manager.id,
      status: "PENDING",
      campaignId: "campaign-1",
      campaign: { id: "campaign-1", entityType: "BROKER", status: "ACTIVE" },
    });
    prisma.loyaltyCallAttempt.findUnique.mockResolvedValue({
      id: "attempt-1",
      assignmentId: "assignment-1",
      operatorId: manager.id,
      result: "NO_ANSWER",
      comment: null,
      nextStep: null,
      nextActionAt: null,
      correctsAttemptId: null,
    });
    await expect(
      service.createAttempt(
        "assignment-1",
        {
          expectedVersion: 1,
          submissionId: "submission-0001",
          result: "INFORMED",
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("requires expectedVersion for task patches and rejects stale writes", async () => {
    const invalid = plainToInstance(UpdateTaskDto, { status: "COMPLETED" });
    expect(await validate(invalid)).not.toHaveLength(0);

    const { prisma, service } = harness();
    prisma.loyaltyTask.findUnique.mockResolvedValue({
      id: "task-1",
      status: "OPEN",
      version: 2,
    });
    prisma.loyaltyTask.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.updateTask(
        "task-1",
        {
          expectedVersion: 1,
          status: "COMPLETED",
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1", version: 1 },
      }),
    );
  });

  it("creates assignments transactionally without changing campaign version", async () => {
    const { prisma, service } = harness();
    const campaign = {
      id: "campaign-1",
      base: "OUR",
      entityType: "BROKER",
      status: "DRAFT",
      version: 1,
      filterHash: "a".repeat(64),
      expectedCount: 1,
      filterSnapshot: {
        version: 1,
        query: {},
        selection: { mode: "IDS", ids: ["target-1"] },
        resolvedTotal: 1,
        selectionDigest: (service as any).idsDigest(["target-1"]),
      },
    };
    prisma.loyaltyCallCampaign.findUnique.mockResolvedValue(campaign);
    prisma.broker.findMany.mockResolvedValue([{ id: "target-1" }]);
    prisma.loyaltyCallAssignment.createMany.mockResolvedValue({ count: 1 });
    prisma.loyaltyCallAssignment.count.mockResolvedValue(1);
    await expect(
      service.createAssignments(
        "campaign-1",
        {
          assigneeId: "manager-2",
          selection: { mode: "IDS", ids: ["target-1"] },
          expectedVersion: 1,
        },
        admin,
      ),
    ).resolves.toMatchObject({ createdCount: 1, totalCount: 1 });

    expect(prisma.loyaltyCallCampaign.updateMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyCallCampaign.update).not.toHaveBeenCalled();
  });

  it("freezes FILTER selection count, exclusions and a result-set digest on create", async () => {
    const { prisma, loyaltyBase, service } = harness();
    loyaltyBase.resolveSelection.mockResolvedValue({
      ids: ["target-1", "target-2", "target-3"],
      total: 3,
      filterHash: "b".repeat(64),
      snapshotId: null,
    });
    prisma.loyaltyCallCampaign.create.mockImplementation(({ data }: any) => ({
      id: "campaign-filter",
      ...data,
      status: "DRAFT",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    await service.createCampaign(
      {
        name: "Filtered",
        message: "Message",
        base: "ours",
        entityType: "brokers",
        filterSnapshot: { search: "+7 999 123-45-67" },
        filterHash: "b".repeat(64),
        snapshotId: null,
        selection: {
          mode: "FILTER",
          filterHash: "b".repeat(64),
          expectedCount: 2,
          excludedIds: ["target-2"],
        },
      },
      admin,
    );

    const data = prisma.loyaltyCallCampaign.create.mock.calls[0][0].data;
    expect(data.expectedCount).toBe(2);
    expect(data.filterSnapshot).toMatchObject({
      version: 2,
      query: {},
      targetIds: ["target-1", "target-3"],
      resolvedTotal: 3,
      selection: {
        mode: "FILTER",
        expectedCount: 2,
        excludedIds: ["target-2"],
      },
    });
    expect(data.filterSnapshot.selectionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data.filterSnapshot)).not.toContain("+7 999");
  });

  // 2026-09-04 (аудит фильтров, задача A): кампания обзвона резолвит выборку
  // с исключением брокеров «не звонить»; несовпадение счётчика из-за них —
  // понятная бизнес-ошибка, а не общий «дрейф выборки».
  it("создание кампании исключает doNotCall и объясняет несовпадение выборки", async () => {
    const { loyaltyBase, service } = harness();
    loyaltyBase.resolveSelection.mockResolvedValue({
      ids: ["target-1"],
      total: 1,
      filterHash: "b".repeat(64),
      snapshotId: null,
      excludedDoNotCall: 1,
    });

    await expect(
      service.createCampaign(
        {
          name: "С «не звонить»",
          message: "Message",
          base: "ours",
          entityType: "brokers",
          filterSnapshot: {},
          filterHash: "b".repeat(64),
          snapshotId: null,
          selection: {
            mode: "FILTER",
            filterHash: "b".repeat(64),
            expectedCount: 2,
            excludedIds: [],
          },
        } as any,
        admin,
      ),
    ).rejects.toThrow(/не звонить/);
    expect(loyaltyBase.resolveSelection).toHaveBeenCalledWith(
      "ours",
      "BROKER",
      expect.anything(),
      { excludeDoNotCall: true },
    );
  });

  it("returns 409 when a live FILTER result set drifts without changing its count", async () => {
    const { prisma, loyaltyBase, service } = harness();
    const selected = ["target-1", "target-3"];
    prisma.loyaltyCallCampaign.findUnique.mockResolvedValue({
      id: "campaign-filter",
      base: "OUR",
      entityType: "BROKER",
      status: "DRAFT",
      version: 1,
      expectedCount: 2,
      filterHash: "b".repeat(64),
      snapshotId: null,
      filterSnapshot: {
        version: 1,
        query: {},
        resolvedTotal: 3,
        selection: {
          mode: "FILTER",
          expectedCount: 2,
          excludedIds: ["target-2"],
        },
        selectionDigest: (service as any).idsDigest(selected),
      },
    });
    loyaltyBase.resolveSelection.mockResolvedValue({
      ids: ["target-4", "target-2", "target-3"],
      total: 3,
      filterHash: "b".repeat(64),
      snapshotId: null,
    });

    await expect(
      service.previewAssignments(
        "campaign-filter",
        {
          assigneeId: "manager-2",
          selection: {
            mode: "FILTER",
            filterHash: "b".repeat(64),
            expectedCount: 2,
            excludedIds: ["target-2"],
          },
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("uses the immutable version 2 FILTER targets without repeating a sensitive search", async () => {
    const { prisma, loyaltyBase, service } = harness();
    const selected = ["target-1", "target-3"];
    prisma.loyaltyCallCampaign.findUnique.mockResolvedValue({
      id: "campaign-filter-v2",
      base: "OUR",
      entityType: "BROKER",
      status: "DRAFT",
      version: 1,
      expectedCount: 2,
      filterHash: "b".repeat(64),
      snapshotId: null,
      filterSnapshot: {
        version: 2,
        query: {},
        targetIds: selected,
        resolvedTotal: 3,
        selection: {
          mode: "FILTER",
          expectedCount: 2,
          excludedIds: ["target-2"],
        },
        selectionDigest: (service as any).idsDigest(selected),
      },
    });
    prisma.broker.findMany.mockResolvedValue(selected.map((id) => ({ id })));

    await expect(
      service.previewAssignments(
        "campaign-filter-v2",
        {
          assigneeId: "manager-2",
          expectedVersion: 1,
          selection: {
            mode: "FILTER",
            filterHash: "b".repeat(64),
            expectedCount: 2,
            excludedIds: ["target-2"],
          },
        },
        admin,
      ),
    ).resolves.toMatchObject({
      requestedCount: 2,
      assignableCount: 2,
    });
    expect(loyaltyBase.resolveSelection).not.toHaveBeenCalled();
  });

  it("keeps workflow audit snapshots free of campaign message and task text", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyCallCampaign.create.mockResolvedValue({
      id: "campaign-1",
      name: "Sensitive campaign",
      message: "Sensitive message",
      base: "OUR",
      entityType: "BROKER",
      status: "DRAFT",
      version: 1,
      expectedCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.createCampaign(
      {
        name: "Sensitive campaign",
        message: "Sensitive message",
        base: "ours",
        entityType: "brokers",
        filterSnapshot: {},
        filterHash: "a".repeat(64),
        snapshotId: null,
        selection: { mode: "IDS", ids: ["target-1"] },
      },
      admin,
    );
    const auditPayload =
      prisma.loyaltyWorkflowAudit.create.mock.calls[0][0].data;
    expect(JSON.stringify(auditPayload)).not.toContain("Sensitive");
  });

  it("archives an event with optimistic locking and an append-only audit row", async () => {
    const { prisma, service } = harness();
    const current = engagementEvent();
    const archivedAt = new Date("2026-08-21T10:00:00.000Z");
    const updated = engagementEvent({ archivedAt, version: 2 });
    prisma.loyaltyEngagementEvent.findUnique
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(updated);
    prisma.loyaltyEngagementEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.archiveEvent(current.id, 1, admin),
    ).resolves.toMatchObject({
      id: current.id,
      version: 2,
      archivedAt,
    });

    expect(prisma.loyaltyEngagementEvent.updateMany).toHaveBeenCalledWith({
      where: { id: current.id, version: 1, archivedAt: null },
      data: { archivedAt: expect.any(Date), version: { increment: 1 } },
    });
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledWith({
      data: {
        actorId: admin.id,
        action: "EVENT_ARCHIVED",
        entityType: "ENGAGEMENT_EVENT",
        entityId: current.id,
        before: { archived: false, version: 1 },
        after: { archived: true, version: 2 },
      },
    });
  });

  it("restores an archived event with the next version and a new audit row", async () => {
    const { prisma, service } = harness();
    const archivedAt = new Date("2026-08-21T10:00:00.000Z");
    const current = engagementEvent({ archivedAt, version: 2 });
    const restored = engagementEvent({ archivedAt: null, version: 3 });
    prisma.loyaltyEngagementEvent.findUnique
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(restored);
    prisma.loyaltyEngagementEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.restoreEvent(current.id, 2, admin),
    ).resolves.toMatchObject({
      id: current.id,
      version: 3,
      archivedAt: null,
    });

    expect(prisma.loyaltyEngagementEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: current.id,
        version: 2,
        archivedAt: { not: null },
      },
      data: { archivedAt: null, version: { increment: 1 } },
    });
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledWith({
      data: {
        actorId: admin.id,
        action: "EVENT_RESTORED",
        entityType: "ENGAGEMENT_EVENT",
        entityId: current.id,
        before: { archived: true, version: 2 },
        after: { archived: false, version: 3 },
      },
    });
  });

  it("rejects stale or same-state event toggles without an audit entry", async () => {
    const stale = harness();
    stale.prisma.loyaltyEngagementEvent.findUnique.mockResolvedValue(
      engagementEvent({ version: 2 }),
    );

    await expect(
      stale.service.archiveEvent(
        "11111111-1111-4111-8111-111111111111",
        1,
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      stale.prisma.loyaltyEngagementEvent.updateMany,
    ).not.toHaveBeenCalled();
    expect(stale.prisma.loyaltyWorkflowAudit.create).not.toHaveBeenCalled();

    const sameState = harness();
    sameState.prisma.loyaltyEngagementEvent.findUnique.mockResolvedValue(
      engagementEvent({
        archivedAt: new Date("2026-08-21T10:00:00.000Z"),
        version: 2,
      }),
    );
    await expect(
      sameState.service.archiveEvent(
        "11111111-1111-4111-8111-111111111111",
        2,
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      sameState.prisma.loyaltyEngagementEvent.updateMany,
    ).not.toHaveBeenCalled();
    expect(sameState.prisma.loyaltyWorkflowAudit.create).not.toHaveBeenCalled();
  });

  it("fails a racing archive compare-and-swap without emitting a false audit", async () => {
    const { prisma, service } = harness();
    const current = engagementEvent();
    prisma.loyaltyEngagementEvent.findUnique.mockResolvedValue(current);
    prisma.loyaltyEngagementEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.archiveEvent(current.id, 1, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyWorkflowAudit.create).not.toHaveBeenCalled();
  });

  it("keeps corrections append-only and independent from archive versioning", async () => {
    const { prisma, service } = harness();
    const original = engagementEvent({ version: 7 });
    const correction = engagementEvent({
      id: "22222222-2222-4222-8222-222222222222",
      correctsEventId: original.id,
      correctionReason: "Исправлена дата",
      occurredAt: new Date("2026-08-20T11:00:00.000Z"),
      version: 1,
    });
    prisma.loyaltyEngagementEvent.findUnique.mockResolvedValue(original);
    prisma.loyaltyEngagementEvent.create.mockResolvedValue(correction);

    await expect(
      service.correctEvent(
        original.id,
        {
          type: "GIFT",
          occurredAt: "2026-08-20T11:00:00.000Z",
          correctionReason: "Исправлена дата",
        },
        admin,
      ),
    ).resolves.toMatchObject({
      id: correction.id,
      version: 1,
      correctsEventId: original.id,
      correctionReason: "Исправлена дата",
    });

    expect(prisma.loyaltyEngagementEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correctsEventId: original.id,
        correctionReason: "Исправлена дата",
        createdById: admin.id,
      }),
      include: expect.any(Object),
    });
    expect(prisma.loyaltyEngagementEvent.updateMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "EVENT_CORRECTED",
        entityId: original.id,
        after: expect.objectContaining({ correctionId: correction.id }),
      }),
    });
  });

  it("uses correction creation order for the effective leaf and archives only that leaf", async () => {
    const { prisma, service } = harness();
    const original = engagementEvent({
      id: "11111111-1111-4111-8111-111111111111",
      occurredAt: new Date("2026-08-20T12:00:00.000Z"),
      createdAt: new Date("2026-08-20T12:00:00.000Z"),
    });
    let correction = engagementEvent({
      id: "22222222-2222-4222-8222-222222222222",
      correctsEventId: original.id,
      correctionReason: "Исправлена дата",
      // Business time is earlier, but this is still the current correction
      // because chain order is immutable creation order.
      occurredAt: new Date("2026-08-19T09:00:00.000Z"),
      createdAt: new Date("2026-08-21T09:00:00.000Z"),
    });
    const rows = () => [original, correction];
    prisma.loyaltyEngagementEvent.findUnique.mockImplementation(
      ({ where }: any) =>
        Promise.resolve(
          where.id === original.id
            ? original
            : where.id === correction.id
              ? correction
              : null,
        ),
    );
    prisma.loyaltyEngagementEvent.findMany.mockImplementation((args: any) => {
      if (args.skip !== undefined) return Promise.resolve(rows());
      if (args.where?.id?.in) {
        const ids = new Set(args.where.id.in);
        return Promise.resolve(rows().filter((row) => ids.has(row.id)));
      }
      if (args.where?.correctsEventId?.in) {
        const parentIds = new Set(args.where.correctsEventId.in);
        return Promise.resolve(
          rows().filter(
            (row) => row.correctsEventId && parentIds.has(row.correctsEventId),
          ),
        );
      }
      return Promise.resolve([]);
    });
    prisma.loyaltyEngagementEvent.updateMany.mockImplementation(
      ({ where, data }: any) => {
        if (where.id !== correction.id || where.version !== correction.version)
          return Promise.resolve({ count: 0 });
        correction = {
          ...correction,
          archivedAt: data.archivedAt,
          version: correction.version + 1,
        };
        return Promise.resolve({ count: 1 });
      },
    );

    const initial = await service.listEvents(
      { page: 1, limit: 100, includeArchived: true } as any,
      admin,
    );
    expect(initial).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: original.id,
          current: false,
          effective: false,
          superseded: true,
        }),
        expect.objectContaining({
          id: correction.id,
          correctionReason: "Исправлена дата",
          current: true,
          effective: true,
          superseded: false,
        }),
      ]),
    );

    await expect(
      service.archiveEvent(original.id, 1, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyEngagementEvent.updateMany).not.toHaveBeenCalled();

    await expect(
      service.archiveEvent(correction.id, 1, admin),
    ).resolves.toMatchObject({
      id: correction.id,
      version: 2,
      current: true,
      effective: false,
      superseded: false,
    });
    const suppressed = await service.listEvents(
      { page: 1, limit: 100, includeArchived: true } as any,
      admin,
    );
    expect(suppressed.every((row: any) => row.effective === false)).toBe(true);

    await expect(
      service.restoreEvent(correction.id, 2, admin),
    ).resolves.toMatchObject({
      id: correction.id,
      version: 3,
      current: true,
      effective: true,
      superseded: false,
    });
    expect(
      prisma.loyaltyWorkflowAudit.create.mock.calls.map(
        (call: any[]) => call[0].data.action,
      ),
    ).toEqual(["EVENT_ARCHIVED", "EVENT_RESTORED"]);
  });

  it("returns active attachment metadata without leaking stored bytes", async () => {
    const { prisma, service } = harness();
    const row = engagementEvent({
      correctionReason: "Исправлено основание",
      attachments: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          fileName: "акт.pdf",
          mimeType: "application/pdf",
          size: 321,
          sha256: "b".repeat(64),
          version: 2,
          createdAt: new Date("2026-08-21T11:00:00.000Z"),
          data: Buffer.from("secret evidence"),
        },
      ],
    });
    prisma.loyaltyEngagementEvent.findUnique.mockResolvedValue(row);
    prisma.loyaltyEngagementEvent.findMany.mockResolvedValue([]);

    const response: any = await service.event(row.id, admin);

    expect(response.correctionReason).toBe("Исправлено основание");
    expect(response.attachments).toEqual([
      {
        id: "33333333-3333-4333-8333-333333333333",
        fileName: "акт.pdf",
        mimeType: "application/pdf",
        size: 321,
        sha256: "b".repeat(64),
        version: 2,
        createdAt: new Date("2026-08-21T11:00:00.000Z"),
        downloadUrl:
          "/api/loyalty-attachments/33333333-3333-4333-8333-333333333333",
      },
    ]);
    expect(response.attachments[0]).not.toHaveProperty("data");
    expect(prisma.loyaltyEngagementEvent.findUnique).toHaveBeenCalledWith({
      where: { id: row.id },
      include: expect.objectContaining({
        attachments: {
          where: { archivedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: expect.not.objectContaining({ data: true }),
        },
      }),
    });
  });

  it("lets a READ_ALL manager save a private view but requires REFERENCE_MANAGE for sharing", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.permission === "READ_ALL" ? { id: "grant-read" } : null,
      ),
    );
    prisma.loyaltySavedView.create.mockResolvedValue({
      id: "view-1",
      ownerId: manager.id,
      owner: manager,
      name: "Мой список",
      base: "ANNA",
      entityType: "BROKER",
      filters: { segment: "NOT_CALLED" },
      filterHash: "a".repeat(64),
      isShared: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.createSavedView(
        {
          name: "Мой список",
          base: "anna",
          entityType: "brokers",
          filters: {
            segment: "NOT_CALLED",
            search: "+7 999 123-45-67",
            ui: { filters: { search: "private@example.test" } },
          },
          isShared: false,
        },
        manager,
      ),
    ).resolves.toMatchObject({ id: "view-1", isShared: false });

    const savedFilters =
      prisma.loyaltySavedView.create.mock.calls[0][0].data.filters;
    expect(savedFilters).toEqual({
      segment: "NOT_CALLED",
      ui: { filters: {} },
    });
    expect(JSON.stringify(savedFilters)).not.toContain("+7 999");
    expect(JSON.stringify(savedFilters)).not.toContain("private@example.test");

    await expect(
      service.createSavedView(
        {
          name: "Общий список",
          base: "anna",
          entityType: "brokers",
          filters: {},
          isShared: true,
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
