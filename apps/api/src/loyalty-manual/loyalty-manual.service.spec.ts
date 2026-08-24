import "reflect-metadata";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { UserRole } from "@st-michael/shared";
import { LoyaltyManualController } from "./loyalty-manual.controller";
import { LoyaltyManualService } from "./loyalty-manual.service";

function harness() {
  const prisma: any = {
    loyaltyDataset: {
      findFirst: jest.fn().mockResolvedValue({
        id: "dataset-1",
        activeSnapshotId: "snapshot-1",
      }),
    },
    loyaltyContactPoint: { findFirst: jest.fn().mockResolvedValue(null) },
    loyaltyPerson: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({
        id: "person-1",
        archivedAt: null,
      }),
    },
    loyaltyOrganization: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({
        id: "organization-1",
        archivedAt: null,
      }),
    },
    loyaltyManualEntity: {
      create: jest.fn().mockImplementation(({ data }: any) => ({
        id: data.id,
        personId: data.personId,
        organizationId: data.organizationId,
        version: 1,
        updatedAt: data.updatedAt,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    loyaltyContactOverride: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }: any) => ({
        ...data,
        version: 1,
        archivedAt: null,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    loyaltyAgencyContactPerson: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: any) => ({
        ...data,
        version: 1,
        archivedAt: null,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    loyaltyEntityChange: { create: jest.fn().mockResolvedValue({}) },
    loyaltyWorkflowAudit: { create: jest.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = jest.fn((callback: (tx: any) => unknown) =>
    callback(prisma),
  );
  return { prisma, service: new LoyaltyManualService(prisma) };
}

describe("LoyaltyManualService", () => {
  it("creates an ANNA overlay without touching the published snapshot", async () => {
    const { prisma, service } = harness();
    const result = await service.create(
      {
        base: "anna",
        entityType: "brokers",
        name: "Тестовый контакт",
        phone: "+7 999 000-00-01",
        city: "Москва",
      },
      "actor-1",
    );

    expect(result).toMatchObject({
      base: "anna",
      entityType: "BROKER",
      version: 1,
    });
    expect(prisma.loyaltyPerson.create).toHaveBeenCalled();
    expect(prisma.loyaltyPerson.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        externalKey: expect.stringMatching(/^anna:broker:phone-sha256:/),
      }),
    });
    expect(prisma.loyaltyContactPoint.findFirst).toHaveBeenCalledWith({
      where: {
        sourceRecord: { snapshotId: "snapshot-1" },
        normalizedValue: { in: ["+79990000001"] },
      },
      select: { id: true },
    });
    expect(prisma.loyaltyManualEntity.create).toHaveBeenCalled();
    expect(prisma.loyaltyContactOverride.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          datasetId: "dataset-1",
          entityType: "BROKER",
          personId: expect.any(String),
          type: "PHONE",
          normalizedValue: "+79990000001",
        }),
      ],
    });
    expect(prisma.loyaltySourceRecord).toBeUndefined();
    expect(prisma.loyaltySnapshot).toBeUndefined();
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "MANUAL_CONTACT_CREATED" }),
    });
  });

  it("rejects OUR creation and invalid phones before any database write", async () => {
    const { prisma, service } = harness();
    await expect(
      service.create(
        {
          base: "OUR",
          entityType: "BROKER",
          name: "Test",
          phone: "+7 999 000-00-01",
        },
        "actor-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(
        {
          base: "anna",
          entityType: "BROKER",
          name: "Test",
          phone: "123",
        },
        "actor-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a contact already present in the active immutable snapshot", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyContactPoint.findFirst.mockResolvedValue({ id: "existing" });
    await expect(
      service.create(
        {
          base: "anna",
          entityType: "AGENCY",
          name: "Agency",
          email: "office@example.test",
        },
        "actor-1",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyOrganization.create).not.toHaveBeenCalled();
  });

  it("lets ADMIN and MANAGER reach the controller so grants can be enforced", () => {
    expect(Reflect.getMetadata("roles", LoyaltyManualController)).toEqual([
      UserRole.ADMIN,
      UserRole.MANAGER,
    ]);
  });

  it("adds a typed contact override and records only masked audit data", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyContactOverride.findMany.mockResolvedValue([
      {
        id: "point-1",
        type: "PHONE",
        value: "+79990000002",
        normalizedValue: "+79990000002",
        label: "Рабочий",
        isPrimary: true,
      },
    ]);

    const result = await service.createPoint(
      "brokers",
      "person-1",
      {
        type: "PHONE",
        value: "+7 (999) 000-00-02",
        label: "Рабочий",
        isPrimary: true,
      },
      "actor-1",
    );

    expect(result).toMatchObject({
      type: "PHONE",
      normalizedValue: "+79990000002",
      version: 1,
    });
    expect(prisma.loyaltyContactOverride.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        personId: "person-1",
        normalizedValue: "+79990000002",
        isPrimary: true,
      }),
    });
    const audit = prisma.loyaltyWorkflowAudit.create.mock.calls.at(-1)[0];
    expect(JSON.stringify(audit)).not.toContain("+79990000002");
    expect(JSON.stringify(audit)).toContain("CONTACT_POINT_CREATE");
  });

  it("audits every existing primary contact demoted by a new primary", async () => {
    const { prisma, service } = harness();
    const previousPrimary = {
      id: "10000000-0000-4000-8000-000000000020",
      datasetId: "dataset-1",
      entityType: "BROKER",
      personId: "person-1",
      organizationId: null,
      type: "PHONE",
      value: "+79990000020",
      normalizedValue: "+79990000020",
      label: "Старый основной",
      isPrimary: true,
      version: 7,
      archivedAt: null,
    };
    prisma.loyaltyContactOverride.count.mockResolvedValue(1);
    prisma.loyaltyContactOverride.findMany
      .mockResolvedValueOnce([previousPrimary])
      .mockResolvedValueOnce([]);

    await service.createPoint(
      "brokers",
      "person-1",
      {
        type: "PHONE",
        value: "+7 999 000-00-21",
        isPrimary: true,
      },
      "actor-1",
    );

    expect(prisma.loyaltyContactOverride.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        personId: "person-1",
        type: "PHONE",
        isPrimary: true,
      }),
      data: expect.objectContaining({
        isPrimary: false,
        version: { increment: 1 },
      }),
    });
    const auditRows = prisma.loyaltyWorkflowAudit.create.mock.calls.map(
      ([call]: any[]) => call.data,
    );
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "CONTACT_POINT_PRIMARY_DEMOTED",
          before: expect.objectContaining({ isPrimary: true, version: 7 }),
          after: expect.objectContaining({ isPrimary: false, version: 8 }),
        }),
        expect.objectContaining({ action: "CONTACT_POINT_CREATE" }),
      ]),
    );
    expect(JSON.stringify(auditRows)).not.toContain("+79990000020");
  });

  it("audits another primary demoted while promoting an existing contact", async () => {
    const { prisma, service } = harness();
    const promoted = {
      id: "10000000-0000-4000-8000-000000000030",
      datasetId: "dataset-1",
      entityType: "BROKER",
      personId: "person-1",
      organizationId: null,
      type: "EMAIL",
      value: "secondary@example.test",
      normalizedValue: "secondary@example.test",
      label: null,
      isPrimary: false,
      version: 2,
      archivedAt: null,
    };
    const previousPrimary = {
      ...promoted,
      id: "10000000-0000-4000-8000-000000000031",
      value: "primary@example.test",
      normalizedValue: "primary@example.test",
      isPrimary: true,
      version: 5,
    };
    prisma.loyaltyContactOverride.findFirst
      .mockResolvedValueOnce(promoted)
      .mockResolvedValueOnce(null);
    prisma.loyaltyContactOverride.findMany
      .mockResolvedValueOnce([previousPrimary])
      .mockResolvedValueOnce([]);
    prisma.loyaltyContactOverride.findUnique.mockResolvedValue({
      ...promoted,
      isPrimary: true,
      version: 3,
    });

    await service.updatePoint(
      "BROKER",
      "person-1",
      promoted.id,
      { expectedVersion: 2, isPrimary: true },
      "actor-1",
    );

    const auditRows = prisma.loyaltyWorkflowAudit.create.mock.calls.map(
      ([call]: any[]) => call.data,
    );
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "CONTACT_POINT_PRIMARY_DEMOTED",
          before: expect.objectContaining({ isPrimary: true, version: 5 }),
          after: expect.objectContaining({ isPrimary: false, version: 6 }),
        }),
        expect.objectContaining({ action: "CONTACT_POINT_UPDATE" }),
      ]),
    );
    expect(JSON.stringify(auditRows)).not.toContain("primary@example.test");
  });

  it("updates a contact only with the expected version and supports archive", async () => {
    const { prisma, service } = harness();
    const before = {
      id: "10000000-0000-4000-8000-000000000001",
      datasetId: "dataset-1",
      entityType: "BROKER",
      personId: "person-1",
      organizationId: null,
      type: "EMAIL",
      value: "old@example.test",
      normalizedValue: "old@example.test",
      label: null,
      isPrimary: true,
      version: 2,
      archivedAt: null,
      createdAt: new Date("2026-08-21T10:00:00Z"),
      updatedAt: new Date("2026-08-21T10:00:00Z"),
    };
    prisma.loyaltyContactOverride.findFirst.mockResolvedValue(before);
    prisma.loyaltyContactOverride.findUnique.mockResolvedValue({
      ...before,
      isPrimary: false,
      version: 3,
      archivedAt: new Date("2026-08-21T11:00:00Z"),
    });

    const result = await service.updatePoint(
      "BROKER",
      "person-1",
      before.id,
      { expectedVersion: 2, archived: true },
      "actor-1",
    );

    expect(result).toMatchObject({ version: 3, isPrimary: false });
    expect(result.archivedAt).toBeTruthy();
    expect(prisma.loyaltyContactOverride.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: before.id, version: 2 }),
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        version: { increment: 1 },
      }),
    });
  });

  it("returns 409 when a contact optimistic version is stale", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyContactOverride.findFirst.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
      type: "PHONE",
      value: "+79990000003",
      normalizedValue: "+79990000003",
      isPrimary: true,
      version: 4,
      archivedAt: null,
    });
    prisma.loyaltyContactOverride.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updatePoint(
        "BROKER",
        "person-1",
        "10000000-0000-4000-8000-000000000001",
        { expectedVersion: 3, label: "Новый ярлык" },
        "actor-1",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("creates an agency contact person with multiple typed contacts and no broker row", async () => {
    const { prisma, service } = harness();

    const result = await service.createAgencyContactPerson(
      "organization-1",
      {
        displayName: "Контакт агентства",
        role: "Координатор",
        actualityStatus: "CURRENT",
        contactPoints: [
          { type: "PHONE", value: "+7 999 000-00-04" },
          { type: "EMAIL", value: "office@example.test" },
        ],
      },
      "actor-1",
    );

    expect(result).toMatchObject({
      organizationId: "organization-1",
      displayName: "Контакт агентства",
      version: 1,
      contactPoints: [
        expect.objectContaining({
          type: "PHONE",
          normalizedValue: "+79990000004",
          isPrimary: true,
        }),
        expect.objectContaining({
          type: "EMAIL",
          normalizedValue: "office@example.test",
          isPrimary: true,
        }),
      ],
    });
    expect(prisma.loyaltyAgencyContactPerson.create).toHaveBeenCalled();
    expect(prisma.loyaltyPerson.create).not.toHaveBeenCalled();
    const audit = prisma.loyaltyWorkflowAudit.create.mock.calls.at(-1)[0];
    expect(JSON.stringify(audit)).not.toContain("office@example.test");
    expect(JSON.stringify(audit)).not.toContain("+79990000004");
  });

  it("soft-archives an agency contact person with optimistic locking", async () => {
    const { prisma, service } = harness();
    const before = {
      id: "10000000-0000-4000-8000-000000000010",
      datasetId: "dataset-1",
      organizationId: "organization-1",
      displayName: "Contact",
      role: "Manager",
      actualityStatus: "CURRENT",
      contactPoints: [],
      version: 3,
      archivedAt: null,
      createdAt: new Date("2026-08-21T10:00:00Z"),
      updatedAt: new Date("2026-08-21T10:00:00Z"),
    };
    prisma.loyaltyAgencyContactPerson.findFirst.mockResolvedValue(before);
    prisma.loyaltyAgencyContactPerson.findUnique.mockResolvedValue({
      ...before,
      version: 4,
      archivedAt: new Date("2026-08-21T11:00:00Z"),
    });

    const result = await service.updateAgencyContactPerson(
      "organization-1",
      before.id,
      { expectedVersion: 3, archived: true },
      "actor-1",
    );

    expect(result).toMatchObject({ version: 4 });
    expect(result.archivedAt).toBeTruthy();
    expect(prisma.loyaltyAgencyContactPerson.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: before.id, version: 3 }),
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        version: { increment: 1 },
      }),
    });
  });

  it("preserves the exact contact-point array and IDs on a name-only edit", async () => {
    const { prisma, service } = harness();
    const contactPoints = [
      {
        id: "20000000-0000-4000-8000-000000000001",
        type: "PHONE",
        value: "+7 999 000-00-04",
        normalizedValue: "+79990000004",
        label: "Рабочий",
        isPrimary: true,
      },
      {
        id: "20000000-0000-4000-8000-000000000002",
        type: "EMAIL",
        value: "office@example.test",
        normalizedValue: "office@example.test",
        label: null,
        isPrimary: true,
      },
    ];
    const before = {
      id: "10000000-0000-4000-8000-000000000010",
      datasetId: "dataset-1",
      organizationId: "organization-1",
      displayName: "Старое имя",
      role: "Manager",
      actualityStatus: "CURRENT",
      contactPoints,
      version: 3,
      archivedAt: null,
    };
    prisma.loyaltyAgencyContactPerson.findFirst.mockResolvedValue(before);
    prisma.loyaltyAgencyContactPerson.findUnique.mockResolvedValue({
      ...before,
      displayName: "Новое имя",
      contactPoints,
      version: 4,
    });

    const result = await service.updateAgencyContactPerson(
      "organization-1",
      before.id,
      { expectedVersion: 3, displayName: "Новое имя" },
      "actor-1",
    );

    const updateData =
      prisma.loyaltyAgencyContactPerson.updateMany.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("contactPoints");
    expect(result.contactPoints.map((point: any) => point.id)).toEqual(
      contactPoints.map((point) => point.id),
    );
  });

  it("keeps IDs of unchanged contact points during an actual contact edit", async () => {
    const { prisma, service } = harness();
    const unchangedId = "20000000-0000-4000-8000-000000000001";
    const replacedId = "20000000-0000-4000-8000-000000000002";
    const before = {
      id: "10000000-0000-4000-8000-000000000010",
      datasetId: "dataset-1",
      organizationId: "organization-1",
      displayName: "Контакт",
      role: "Manager",
      actualityStatus: "CURRENT",
      contactPoints: [
        {
          id: unchangedId,
          type: "PHONE",
          value: "+7 999 000-00-04",
          normalizedValue: "+79990000004",
          label: "Основной",
          isPrimary: true,
        },
        {
          id: replacedId,
          type: "PHONE",
          value: "+7 999 000-00-05",
          normalizedValue: "+79990000005",
          label: null,
          isPrimary: false,
        },
      ],
      version: 3,
      archivedAt: null,
    };
    let updatedPoints: any[] = [];
    prisma.loyaltyAgencyContactPerson.findFirst.mockResolvedValue(before);
    prisma.loyaltyAgencyContactPerson.updateMany.mockImplementation(
      ({ data }: any) => {
        updatedPoints = data.contactPoints;
        return Promise.resolve({ count: 1 });
      },
    );
    prisma.loyaltyAgencyContactPerson.findUnique.mockImplementation(() =>
      Promise.resolve({ ...before, contactPoints: updatedPoints, version: 4 }),
    );

    const result = await service.updateAgencyContactPerson(
      "organization-1",
      before.id,
      {
        expectedVersion: 3,
        contactPoints: [
          {
            id: unchangedId,
            type: "PHONE",
            value: "+7 999 000-00-04",
            label: "Основной",
            isPrimary: true,
          },
          {
            type: "PHONE",
            value: "+7 999 000-00-06",
            isPrimary: false,
          },
        ],
      },
      "actor-1",
    );

    expect(result.contactPoints[0].id).toBe(unchangedId);
    expect(result.contactPoints[1].id).not.toBe(replacedId);
    expect(result.contactPoints[1].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
