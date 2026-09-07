import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "crypto";
import type { PrismaClient } from "@st-michael/database";
import type { CurrentUserPayload } from "../auth/current-user.decorator";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";

export const MAX_LOYALTY_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_LOYALTY_ATTACHMENTS_PER_EVENT = 20;
export const MAX_LOYALTY_ATTACHMENT_BYTES_PER_EVENT = 50 * 1024 * 1024;

const MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
};

const ATTACHMENT_METADATA_SELECT = {
  id: true,
  eventId: true,
  fileName: true,
  mimeType: true,
  size: true,
  sha256: true,
  version: true,
  createdAt: true,
  archivedAt: true,
} as const;

const safeFileName = (value: string): string => {
  const normalized = String(value || "attachment")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  return Array.from(normalized || "attachment")
    .filter((symbol) => {
      const point = symbol.codePointAt(0) || 0;
      return point < 0xd800 || point > 0xdfff;
    })
    .slice(0, 240)
    .join("");
};

const hasExpectedExtension = (mimeType: string, fileName: string): boolean =>
  (MIME_EXTENSIONS[mimeType] || []).some((extension) =>
    fileName.toLowerCase().endsWith(extension),
  );

/**
 * Verify the ZIP central directory instead of accepting every PK-prefixed ZIP
 * as DOCX. No entry is decompressed, so a compressed-data bomb is never
 * expanded in the API process.
 */
const docxContainerMatches = (data: Buffer): boolean => {
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) return false;
  const earliestEocd = Math.max(0, data.length - 65_557);
  let eocd = -1;
  for (let offset = data.length - 22; offset >= earliestEocd; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > data.length) return false;
  const entries = data.readUInt16LE(eocd + 10);
  const directorySize = data.readUInt32LE(eocd + 12);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  if (
    entries === 0 ||
    entries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directorySize > eocd
  )
    return false;

  const names = new Set<string>();
  let cursor = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > eocd || data.readUInt32LE(cursor) !== 0x02014b50)
      return false;
    const flags = data.readUInt16LE(cursor + 8);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x0001) !== 0 || nameLength === 0 || next > eocd) return false;
    const name = data
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8")
      .replace(/\\/g, "/");
    if (
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      name.toLowerCase() === "word/vbaproject.bin"
    )
      return false;
    names.add(name);
    cursor = next;
  }
  if (cursor !== directoryOffset + directorySize) return false;
  return (
    names.has("[Content_Types].xml") &&
    names.has("_rels/.rels") &&
    names.has("word/document.xml")
  );
};

const signatureMatches = (mimeType: string, data: Buffer): boolean => {
  if (mimeType === "application/pdf")
    return data.subarray(0, 5).toString() === "%PDF-";
  if (mimeType === "image/png")
    return data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/jpeg")
    return (
      data.length >= 3 &&
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[2] === 0xff
    );
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return docxContainerMatches(data);
  return false;
};

@Injectable()
export class LoyaltyAttachmentsService {
  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly permissions: LoyaltyPermissionService,
  ) {}

  async upload(
    eventId: string,
    file: Express.Multer.File | undefined,
    user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    if (!file?.buffer?.length)
      throw new BadRequestException("File is required");
    if (file.buffer.length > MAX_LOYALTY_ATTACHMENT_BYTES)
      throw new BadRequestException("Attachment exceeds the 5 MiB limit");
    if (
      !MIME_TYPES.has(file.mimetype) ||
      !signatureMatches(file.mimetype, file.buffer)
    )
      throw new BadRequestException("Unsupported or invalid attachment format");
    const fileName = safeFileName(file.originalname);
    if (!hasExpectedExtension(file.mimetype, fileName))
      throw new BadRequestException(
        "Attachment extension does not match its declared format",
      );
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    try {
      return await (this.prisma as any).$transaction(async (tx: any) => {
        const event = await tx.loyaltyEngagementEvent.findUnique({
          where: { id: eventId },
          select: {
            id: true,
            archivedAt: true,
            corrections: { select: { id: true }, take: 1 },
          },
        });
        if (!event || event.archivedAt)
          throw new NotFoundException("Active loyalty event not found");
        if (event.corrections?.length)
          throw new ConflictException(
            "Attachments can only be added to the current event revision",
          );
        const usage = await tx.loyaltyEventAttachment.aggregate({
          where: { eventId },
          _count: { _all: true },
          _sum: { size: true },
        });
        const count = Number(usage?._count?._all || 0);
        const bytes = Number(usage?._sum?.size || 0);
        if (
          count >= MAX_LOYALTY_ATTACHMENTS_PER_EVENT ||
          bytes + file.buffer.length > MAX_LOYALTY_ATTACHMENT_BYTES_PER_EVENT
        )
          throw new BadRequestException(
            "Attachment storage limit for this event has been reached",
          );
        const created = await tx.loyaltyEventAttachment.create({
          data: {
            eventId,
            fileName,
            mimeType: file.mimetype,
            size: file.buffer.length,
            sha256,
            data: file.buffer,
            createdById: user.id,
          },
          select: ATTACHMENT_METADATA_SELECT,
        });
        await tx.loyaltyWorkflowAudit.create({
          data: {
            actorId: user.id,
            action: "EVENT_ATTACHMENT_CREATED",
            entityType: "ENGAGEMENT_EVENT_ATTACHMENT",
            entityId: created.id,
            before: null,
            after: {
              eventId,
              fileName,
              mimeType: file.mimetype,
              size: file.buffer.length,
              sha256,
            },
          },
        });
        return this.metadata(created);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("loyalty event attachment storage limit"))
        throw new BadRequestException(
          "Attachment storage limit for this event has been reached",
        );
      if (
        message.includes(
          "loyalty attachment requires the current event revision",
        )
      )
        throw new ConflictException(
          "Attachments can only be added to the current event revision",
        );
      if (
        message.includes("loyalty attachment parent event does not exist") ||
        message.includes("loyalty attachment parent event is not active")
      )
        throw new NotFoundException("Active loyalty event not found");
      throw error;
    }
  }

  async download(id: string, user: CurrentUserPayload) {
    await this.permissions.require(user, "READ_ALL");
    return (this.prisma as any).$transaction(async (tx: any) => {
      const row = await tx.loyaltyEventAttachment.findFirst({
        where: { id, archivedAt: null, event: { is: { archivedAt: null } } },
        select: { ...ATTACHMENT_METADATA_SELECT, data: true },
      });
      if (!row) throw new NotFoundException("Attachment not found");
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: "EVENT_ATTACHMENT_DOWNLOADED",
          entityType: "ENGAGEMENT_EVENT_ATTACHMENT",
          entityId: row.id,
          before: null,
          after: {
            eventId: row.eventId,
            size: Number(row.size),
            sha256: row.sha256,
          },
        },
      });
      return {
        ...this.metadata(row),
        data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data),
      };
    });
  }

  async archive(id: string, expectedVersion: number, user: CurrentUserPayload) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return (this.prisma as any).$transaction(async (tx: any) => {
      const current = await tx.loyaltyEventAttachment.findUnique({
        where: { id },
        select: ATTACHMENT_METADATA_SELECT,
      });
      if (!current || current.archivedAt)
        throw new NotFoundException("Active attachment not found");
      const archivedAt = new Date();
      const changed = await tx.loyaltyEventAttachment.updateMany({
        where: { id, version: expectedVersion, archivedAt: null },
        data: { archivedAt, version: { increment: 1 } },
      });
      if (changed.count !== 1)
        throw new ConflictException(
          "Attachment version changed; reload and retry",
        );
      await tx.loyaltyWorkflowAudit.create({
        data: {
          actorId: user.id,
          action: "EVENT_ATTACHMENT_ARCHIVED",
          entityType: "ENGAGEMENT_EVENT_ATTACHMENT",
          entityId: id,
          before: {
            eventId: current.eventId,
            version: current.version,
            archived: false,
            size: Number(current.size),
            sha256: current.sha256,
          },
          after: {
            eventId: current.eventId,
            version: current.version + 1,
            archived: true,
            size: Number(current.size),
            sha256: current.sha256,
          },
        },
      });
      return { id, version: current.version + 1, archivedAt };
    });
  }

  private metadata(row: any) {
    return {
      id: row.id,
      eventId: row.eventId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      size: Number(row.size),
      sha256: row.sha256,
      version: row.version,
      createdAt: row.createdAt,
      archivedAt: row.archivedAt || null,
      downloadUrl: `/api/loyalty-attachments/${encodeURIComponent(row.id)}`,
    };
  }
}
