import "reflect-metadata";

import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaClient } from "@st-michael/database";
import { plainToInstance } from "class-transformer";
import { ValidationError, validate } from "class-validator";
import { createHash, timingSafeEqual } from "crypto";
import { readFile, stat } from "fs/promises";
import { DatabaseModule } from "../database/database.module";
import { LoyaltyImportDto, LoyaltyPublishDto } from "./loyalty-base.dto";
import { LoyaltyBaseService } from "./loyalty-base.service";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const SAFE_COUNT_KEYS = [
  "records",
  "brokers",
  "agencies",
  "contactPoints",
  "uniqueNormalizedPhones",
  "externalIdentities",
  "activities",
  "sourceAggregates",
  "sourceSummaryAggregates",
  "includedActivities",
  "includedFixations",
  "includedMeetings",
  "includedDeals",
  "includedBrokerTours",
  "includedCalls",
  "excludedActivities",
  "unknownActivities",
  "organizationRoles",
  "duplicateSourceKeys",
  "invalidContactPoints",
  "issueCount",
  "candidateCount",
  "ambiguousRecords",
  "currentPublishedRecords",
] as const;

export interface LoyaltyImportCliOptions {
  file: string | null;
  expectedPayloadSha256: string;
  confirmPublish: true;
  confirmCoverageDrop: boolean;
}

export interface PreparedLoyaltyPayload {
  dto: LoyaltyImportDto;
  payloadSha256: string;
}

type LoyaltyImportService = Pick<
  LoyaltyBaseService,
  "dryRunImport" | "stageImport" | "publishSnapshot"
>;

export type SafeCliResult =
  | {
      status: "PUBLISHED";
      payloadSha256: string;
      contentHash: string;
      counts: Record<string, number>;
      stageStatus: string;
      stageIdempotent: boolean;
      publishIdempotent: boolean;
    }
  | {
      status: "FAILED";
      phase: string;
      code: string;
      payloadSha256?: string;
      contentHash?: string;
      validationErrorCount?: number;
      issueCount?: number;
      counts?: Record<string, number>;
      stageStatus?: string;
      stageIdempotent?: boolean;
    };

export class LoyaltyImportCliError extends Error {
  constructor(
    readonly phase: string,
    readonly code: string,
    readonly safeDetails: Omit<
      Extract<SafeCliResult, { status: "FAILED" }>,
      "status" | "phase" | "code"
    > = {},
  ) {
    super(code);
  }

  toResult(): SafeCliResult {
    return {
      status: "FAILED",
      phase: this.phase,
      code: this.code,
      ...this.safeDetails,
    };
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [LoyaltyBaseService],
})
export class LoyaltyImportCliModule {}

export function parseLoyaltyImportCliArgs(
  argv: string[],
): LoyaltyImportCliOptions {
  let file: string | null = null;
  let expectedPayloadSha256 = "";
  let confirmPublish = false;
  let confirmCoverageDrop = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--file") {
      const value = argv[++index];
      if (!value || file !== null)
        throw new LoyaltyImportCliError("ARGUMENTS", "ARGUMENTS_INVALID");
      file = value === "-" ? null : value;
    } else if (argument === "--expected-payload-sha256") {
      const value = argv[++index];
      if (!value || expectedPayloadSha256)
        throw new LoyaltyImportCliError("ARGUMENTS", "ARGUMENTS_INVALID");
      expectedPayloadSha256 = value;
    } else if (argument === "--confirm-publish") {
      confirmPublish = true;
    } else if (argument === "--confirm-coverage-drop") {
      confirmCoverageDrop = true;
    } else {
      throw new LoyaltyImportCliError("ARGUMENTS", "ARGUMENTS_INVALID");
    }
  }

  if (!SHA256_PATTERN.test(expectedPayloadSha256)) {
    throw new LoyaltyImportCliError(
      "ARGUMENTS",
      "EXPECTED_PAYLOAD_SHA256_REQUIRED",
    );
  }
  if (!confirmPublish) {
    throw new LoyaltyImportCliError(
      "ARGUMENTS",
      "PUBLISH_CONFIRMATION_REQUIRED",
    );
  }

  return {
    file,
    expectedPayloadSha256,
    confirmPublish: true,
    confirmCoverageDrop,
  };
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_IMPORT_BYTES) {
      throw new LoyaltyImportCliError("READ", "PAYLOAD_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readLoyaltyImportPayload(
  file: string | null,
): Promise<Buffer> {
  if (file === null) return readStdin();

  try {
    const fileStat = await stat(file);
    if (!fileStat.isFile())
      throw new LoyaltyImportCliError("READ", "PAYLOAD_NOT_REGULAR_FILE");
    if (fileStat.size > MAX_IMPORT_BYTES)
      throw new LoyaltyImportCliError("READ", "PAYLOAD_TOO_LARGE");
    const payload = await readFile(file);
    if (payload.length > MAX_IMPORT_BYTES)
      throw new LoyaltyImportCliError("READ", "PAYLOAD_TOO_LARGE");
    return payload;
  } catch (error) {
    if (error instanceof LoyaltyImportCliError) throw error;
    throw new LoyaltyImportCliError("READ", "PAYLOAD_READ_FAILED");
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function validationErrorCount(errors: ValidationError[]): number {
  return errors.reduce(
    (count, error) =>
      count +
      (error.constraints ? Object.keys(error.constraints).length : 0) +
      validationErrorCount(error.children || []),
    0,
  );
}

export async function prepareLoyaltyImportPayload(
  raw: Buffer,
  expectedPayloadSha256: string,
): Promise<PreparedLoyaltyPayload> {
  if (raw.length > MAX_IMPORT_BYTES)
    throw new LoyaltyImportCliError("READ", "PAYLOAD_TOO_LARGE");
  if (!SHA256_PATTERN.test(expectedPayloadSha256)) {
    throw new LoyaltyImportCliError("HASH", "EXPECTED_PAYLOAD_SHA256_INVALID");
  }

  const payloadSha256 = sha256(raw);
  if (!hashesEqual(payloadSha256, expectedPayloadSha256)) {
    throw new LoyaltyImportCliError("HASH", "PAYLOAD_SHA256_MISMATCH", {
      payloadSha256,
    });
  }

  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
  } catch {
    throw new LoyaltyImportCliError("PARSE", "PAYLOAD_JSON_INVALID", {
      payloadSha256,
    });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new LoyaltyImportCliError("VALIDATION", "PAYLOAD_ROOT_INVALID", {
      payloadSha256,
    });
  }

  const dto = plainToInstance(LoyaltyImportDto, document);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
  });
  if (errors.length > 0) {
    throw new LoyaltyImportCliError("VALIDATION", "PAYLOAD_VALIDATION_FAILED", {
      payloadSha256,
      validationErrorCount: validationErrorCount(errors),
    });
  }

  return { dto, payloadSha256 };
}

function safeCounts(summary: unknown): Record<string, number> {
  if (!summary || typeof summary !== "object") return {};
  const source = summary as Record<string, unknown>;
  return Object.fromEntries(
    SAFE_COUNT_KEYS.flatMap((key) =>
      typeof source[key] === "number" && Number.isFinite(source[key])
        ? [[key, source[key] as number]]
        : [],
    ),
  );
}

export async function executeLoyaltyImport(
  service: LoyaltyImportService,
  prepared: PreparedLoyaltyPayload,
  options: Pick<LoyaltyImportCliOptions, "confirmCoverageDrop">,
): Promise<SafeCliResult> {
  let contentHash: string | undefined;
  let counts: Record<string, number> | undefined;
  let stageStatus: string | undefined;
  let stageIdempotent: boolean | undefined;

  try {
    const dryRun = (await service.dryRunImport(prepared.dto)) as any;
    contentHash = dryRun?.contentHash;
    counts = safeCounts(dryRun?.summary);
    if (
      dryRun?.dryRun !== true ||
      dryRun?.publishable !== true ||
      dryRun?.status !== "VALID" ||
      !SHA256_PATTERN.test(contentHash || "")
    ) {
      throw new LoyaltyImportCliError("DRY_RUN", "DRY_RUN_NOT_PUBLISHABLE", {
        payloadSha256: prepared.payloadSha256,
        contentHash,
        issueCount:
          typeof dryRun?.summary?.issueCount === "number"
            ? dryRun.summary.issueCount
            : undefined,
        counts,
      });
    }

    prepared.dto.expectedContentHash = contentHash;
    prepared.dto.expectedActiveSnapshotId =
      dryRun.expectedActiveSnapshotId === null
        ? null
        : dryRun.expectedActiveSnapshotId;
    prepared.dto.confirmCoverageDrop = options.confirmCoverageDrop;

    const staged = (await service.stageImport(prepared.dto)) as any;
    stageStatus = String(staged?.status || "UNKNOWN");
    stageIdempotent = staged?.idempotent === true;
    if (
      typeof staged?.snapshotId !== "string" ||
      staged?.contentHash !== contentHash ||
      !["STAGED", "SUPERSEDED", "PUBLISHED"].includes(stageStatus)
    ) {
      throw new LoyaltyImportCliError("STAGE", "STAGE_RESULT_INVALID", {
        payloadSha256: prepared.payloadSha256,
        contentHash,
        counts,
        stageStatus,
        stageIdempotent,
      });
    }

    const publishDto: LoyaltyPublishDto = {
      confirmed: true,
      expectedContentHash: contentHash,
      expectedActiveSnapshotId: prepared.dto.expectedActiveSnapshotId,
      confirmCoverageDrop: options.confirmCoverageDrop,
    };
    const published = (await service.publishSnapshot(
      staged.snapshotId,
      publishDto,
    )) as any;
    if (
      published?.status !== "PUBLISHED" ||
      published?.contentHash !== contentHash
    ) {
      throw new LoyaltyImportCliError("PUBLISH", "PUBLISH_RESULT_INVALID", {
        payloadSha256: prepared.payloadSha256,
        contentHash,
        counts,
        stageStatus,
        stageIdempotent,
      });
    }

    return {
      status: "PUBLISHED",
      payloadSha256: prepared.payloadSha256,
      contentHash,
      counts,
      stageStatus,
      stageIdempotent,
      publishIdempotent: published.idempotent === true,
    };
  } catch (error) {
    if (error instanceof LoyaltyImportCliError) throw error;
    const phase = stageStatus ? "PUBLISH" : contentHash ? "STAGE" : "DRY_RUN";
    throw new LoyaltyImportCliError(phase, `${phase}_FAILED`, {
      payloadSha256: prepared.payloadSha256,
      contentHash,
      counts,
      stageStatus,
      stageIdempotent,
    });
  }
}

function silenceConsole(): () => void {
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = Object.fromEntries(
    methods.map((method) => [method, console[method]]),
  ) as Record<(typeof methods)[number], (...args: any[]) => void>;
  for (const method of methods) console[method] = () => undefined;
  return () => {
    for (const method of methods) console[method] = originals[method];
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const restoreConsole = silenceConsole();
  let app: Awaited<
    ReturnType<typeof NestFactory.createApplicationContext>
  > | null = null;
  let prisma: PrismaClient | null = null;
  let result: SafeCliResult;
  try {
    const options = parseLoyaltyImportCliArgs(argv);
    const raw = await readLoyaltyImportPayload(options.file);
    const prepared = await prepareLoyaltyImportPayload(
      raw,
      options.expectedPayloadSha256,
    );

    app = await NestFactory.createApplicationContext(LoyaltyImportCliModule, {
      logger: false,
      abortOnError: false,
    });
    prisma = app.get<PrismaClient>("PrismaClient");
    result = await executeLoyaltyImport(
      app.get(LoyaltyBaseService),
      prepared,
      options,
    );
  } catch (error) {
    result =
      error instanceof LoyaltyImportCliError
        ? error.toResult()
        : {
            status: "FAILED",
            phase: "BOOTSTRAP",
            code: "BOOTSTRAP_FAILED",
          };
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => undefined);
    if (prisma) await prisma.$disconnect().catch(() => undefined);
    restoreConsole();
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  void main();
}
