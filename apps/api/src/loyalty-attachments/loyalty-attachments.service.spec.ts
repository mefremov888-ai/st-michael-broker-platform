import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import {
  LoyaltyAttachmentsService,
  MAX_LOYALTY_ATTACHMENTS_PER_EVENT,
} from "./loyalty-attachments.service";

const user: any = {
  id: "manager-1",
  role: "MANAGER",
  phone: "",
  fullName: "Manager",
};

const zipWithEntries = (names: string[]): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entryName of names) {
    const name = Buffer.from(entryName, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const directory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, directory, eocd]);
};

const harness = () => {
  const prisma: any = {
    loyaltyEngagementEvent: { findUnique: jest.fn() },
    loyaltyEventAttachment: {
      create: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 0 },
        _sum: { size: null },
      }),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    loyaltyWorkflowAudit: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: any) => callback(prisma));
  const permissions: any = {
    require: jest.fn().mockResolvedValue(undefined),
    requireAll: jest.fn().mockResolvedValue(undefined),
  };
  return {
    prisma,
    permissions,
    service: new LoyaltyAttachmentsService(prisma, permissions),
  };
};

describe("LoyaltyAttachmentsService", () => {
  it("fails before touching storage when the manager lacks explicit grants", async () => {
    const { prisma, permissions, service } = harness();
    permissions.requireAll.mockRejectedValue(
      new ForbiddenException("Insufficient permissions"),
    );

    await expect(
      service.upload(
        "event-1",
        {
          buffer: Buffer.from("%PDF-1.7"),
          mimetype: "application/pdf",
          originalname: "proof.pdf",
        } as any,
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("stores validated metadata without returning or auditing protected bytes", async () => {
    const { prisma, permissions, service } = harness();
    const data = Buffer.from("%PDF-1.7\nprivate-content");
    prisma.loyaltyEngagementEvent.findUnique.mockResolvedValue({
      id: "event-1",
      archivedAt: null,
      corrections: [],
    });
    prisma.loyaltyEventAttachment.create.mockImplementation(
      ({ data: row }: any) =>
        Promise.resolve({
          id: "attachment-1",
          version: 1,
          createdAt: new Date("2026-08-21T10:00:00.000Z"),
          archivedAt: null,
          ...row,
        }),
    );

    const result = await service.upload(
      "event-1",
      {
        buffer: data,
        size: data.length,
        mimetype: "application/pdf",
        originalname: "../\u202eдо\r\nговор.pdf",
      } as any,
      user,
    );

    expect(permissions.requireAll).toHaveBeenCalledWith(user, [
      "READ_ALL",
      "ENTITY_EDIT",
    ]);
    expect(result).toMatchObject({
      id: "attachment-1",
      fileName: "_договор.pdf",
      mimeType: "application/pdf",
      size: data.length,
      version: 1,
    });
    expect(prisma.loyaltyEventAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ data: true }),
      }),
    );
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "EVENT_ATTACHMENT_CREATED",
        after: expect.objectContaining({
          eventId: "event-1",
          size: data.length,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    });
    expect(
      JSON.stringify(prisma.loyaltyWorkflowAudit.create.mock.calls),
    ).not.toContain("private-content");
  });

  it("rejects an extension-only file whose bytes do not match the declared type", async () => {
    const { service } = harness();
    await expect(
      service.upload(
        "event-1",
        {
          buffer: Buffer.from("not a pdf"),
          mimetype: "application/pdf",
          originalname: "fake.pdf",
        } as any,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a valid signature when the filename extension contradicts the MIME type", async () => {
    const { service } = harness();
    await expect(
      service.upload(
        "event-1",
        {
          buffer: Buffer.from("%PDF-1.7"),
          mimetype: "application/pdf",
          originalname: "invoice.exe",
        } as any,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("accepts only a DOCX ZIP with the required OOXML entries", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyEngagementEvent.findUnique.mockResolvedValue({
      id: "event-1",
      archivedAt: null,
      corrections: [],
    });
    prisma.loyaltyEventAttachment.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: "attachment-docx",
        version: 1,
        createdAt: new Date(),
        archivedAt: null,
        ...data,
      }),
    );
    const valid = zipWithEntries([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
    ]);
    await expect(
      service.upload(
        "event-1",
        {
          buffer: valid,
          mimetype:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          originalname: "evidence.docx",
        } as any,
        user,
      ),
    ).resolves.toMatchObject({ fileName: "evidence.docx" });

    await expect(
      service.upload(
        "event-1",
        {
          buffer: zipWithEntries(["unrelated.txt"]),
          mimetype:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          originalname: "fake.docx",
        } as any,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects uploads to a superseded event revision", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyEngagementEvent.findUnique.mockResolvedValue({
      id: "event-1",
      archivedAt: null,
      corrections: [{ id: "new-revision" }],
    });

    await expect(
      service.upload(
        "event-1",
        {
          buffer: Buffer.from("%PDF-1.7"),
          mimetype: "application/pdf",
          originalname: "proof.pdf",
        } as any,
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyEventAttachment.create).not.toHaveBeenCalled();
  });

  it("enforces the lifetime per-event quota before storing bytes", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyEngagementEvent.findUnique.mockResolvedValue({
      id: "event-1",
      archivedAt: null,
      corrections: [],
    });
    prisma.loyaltyEventAttachment.aggregate.mockResolvedValue({
      _count: { _all: MAX_LOYALTY_ATTACHMENTS_PER_EVENT },
      _sum: { size: 1 },
    });

    await expect(
      service.upload(
        "event-1",
        {
          buffer: Buffer.from("%PDF-1.7"),
          mimetype: "application/pdf",
          originalname: "proof.pdf",
        } as any,
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.loyaltyEventAttachment.create).not.toHaveBeenCalled();
  });

  it("downloads only active evidence after READ_ALL and audits metadata only", async () => {
    const { prisma, permissions, service } = harness();
    prisma.loyaltyEventAttachment.findFirst.mockResolvedValue({
      id: "attachment-1",
      eventId: "event-1",
      fileName: "proof.pdf",
      mimeType: "application/pdf",
      size: 7,
      sha256: "a".repeat(64),
      version: 1,
      createdAt: new Date(),
      archivedAt: null,
      data: Buffer.from("%PDF-1"),
    });

    const result = await service.download("attachment-1", user);

    expect(permissions.require).toHaveBeenCalledWith(user, "READ_ALL");
    expect(result.data.equals(Buffer.from("%PDF-1"))).toBe(true);
    expect(prisma.loyaltyEventAttachment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "attachment-1",
          archivedAt: null,
          event: { is: { archivedAt: null } },
        },
      }),
    );
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "EVENT_ATTACHMENT_DOWNLOADED",
        after: {
          eventId: "event-1",
          size: 7,
          sha256: "a".repeat(64),
        },
      }),
    });
    expect(
      JSON.stringify(prisma.loyaltyWorkflowAudit.create.mock.calls),
    ).not.toContain("%PDF-1");
  });

  it("fails closed when the attachment version changed before archive", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyEventAttachment.findUnique.mockResolvedValue({
      id: "attachment-1",
      version: 2,
      archivedAt: null,
    });
    prisma.loyaltyEventAttachment.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.archive("attachment-1", 1, user),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.loyaltyWorkflowAudit.create).not.toHaveBeenCalled();
  });

  it("archives with optimistic versioning and audits digest metadata without loading bytes", async () => {
    const { prisma, permissions, service } = harness();
    prisma.loyaltyEventAttachment.findUnique.mockResolvedValue({
      id: "attachment-1",
      eventId: "event-1",
      fileName: "proof.pdf",
      mimeType: "application/pdf",
      size: 123,
      sha256: "c".repeat(64),
      version: 2,
      createdAt: new Date(),
      archivedAt: null,
    });
    prisma.loyaltyEventAttachment.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.archive("attachment-1", 2, user),
    ).resolves.toMatchObject({
      id: "attachment-1",
      version: 3,
      archivedAt: expect.any(Date),
    });

    expect(permissions.requireAll).toHaveBeenCalledWith(user, [
      "READ_ALL",
      "ENTITY_EDIT",
    ]);
    expect(prisma.loyaltyEventAttachment.findUnique).toHaveBeenCalledWith({
      where: { id: "attachment-1" },
      select: expect.not.objectContaining({ data: true }),
    });
    expect(prisma.loyaltyEventAttachment.updateMany).toHaveBeenCalledWith({
      where: { id: "attachment-1", version: 2, archivedAt: null },
      data: { archivedAt: expect.any(Date), version: { increment: 1 } },
    });
    expect(prisma.loyaltyWorkflowAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "EVENT_ATTACHMENT_ARCHIVED",
        before: expect.objectContaining({
          version: 2,
          sha256: "c".repeat(64),
        }),
        after: expect.objectContaining({
          version: 3,
          sha256: "c".repeat(64),
        }),
      }),
    });
    const audit = prisma.loyaltyWorkflowAudit.create.mock.calls[0][0].data;
    expect(audit.before).not.toHaveProperty("data");
    expect(audit.after).not.toHaveProperty("data");
  });
});
