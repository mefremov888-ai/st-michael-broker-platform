import { createHash } from "crypto";
import {
  LoyaltyImportCliError,
  executeLoyaltyImport,
  parseLoyaltyImportCliArgs,
  prepareLoyaltyImportPayload,
} from "./loyalty-import.cli";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validDocument(overrides: Record<string, unknown> = {}) {
  return {
    sourceName: "normalized-anna-export",
    ruleVersion: "anna-normalized-v1",
    expectedRecords: 1,
    expectedUniquePhones: 1,
    expectedActivities: 0,
    expectedExternalIdentities: 0,
    expectedIncludedFixations: 0,
    expectedIncludedMeetings: 0,
    expectedIncludedDeals: 0,
    expectedIncludedBrokerTours: 0,
    expectedIncludedCalls: 0,
    expectedIncludedDealAmount: "0.00",
    records: [
      {
        externalKey: "anna-row-1",
        entityType: "BROKER",
        displayName: "Sensitive Person Name",
        contactPoints: [{ type: "PHONE", value: "+79991234567" }],
      },
    ],
    ...overrides,
  };
}

async function preparedDocument(overrides: Record<string, unknown> = {}) {
  const raw = Buffer.from(JSON.stringify(validDocument(overrides)), "utf8");
  return prepareLoyaltyImportPayload(raw, sha256(raw));
}

describe("loyalty import CLI arguments", () => {
  it("requires both an exact payload hash and explicit publish confirmation", () => {
    expect(() =>
      parseLoyaltyImportCliArgs(["--expected-payload-sha256", "a".repeat(64)]),
    ).toThrow(
      expect.objectContaining({ code: "PUBLISH_CONFIRMATION_REQUIRED" }),
    );
    expect(() => parseLoyaltyImportCliArgs(["--confirm-publish"])).toThrow(
      expect.objectContaining({ code: "EXPECTED_PAYLOAD_SHA256_REQUIRED" }),
    );
  });

  it("accepts stdin and an explicit coverage-drop confirmation", () => {
    expect(
      parseLoyaltyImportCliArgs([
        "--file",
        "-",
        "--expected-payload-sha256",
        "b".repeat(64),
        "--confirm-publish",
        "--confirm-coverage-drop",
      ]),
    ).toEqual({
      file: null,
      expectedPayloadSha256: "b".repeat(64),
      confirmPublish: true,
      confirmCoverageDrop: true,
    });
  });
});

describe("loyalty import CLI payload boundary", () => {
  it("checks exact payload bytes before parsing or connecting to the database", async () => {
    const raw = Buffer.from(JSON.stringify(validDocument()), "utf8");
    await expect(
      prepareLoyaltyImportPayload(raw, "0".repeat(64)),
    ).rejects.toEqual(
      expect.objectContaining({
        phase: "HASH",
        code: "PAYLOAD_SHA256_MISMATCH",
      }),
    );
  });

  it("forbids unknown fields, including nested DTO fields", async () => {
    const document = validDocument();
    (document.records[0] as any).unexpectedSensitiveColumn = "must not pass";
    const raw = Buffer.from(JSON.stringify(document), "utf8");

    await expect(prepareLoyaltyImportPayload(raw, sha256(raw))).rejects.toEqual(
      expect.objectContaining({
        phase: "VALIDATION",
        code: "PAYLOAD_VALIDATION_FAILED",
        safeDetails: expect.objectContaining({ validationErrorCount: 1 }),
      }),
    );
  });
});

describe("loyalty import CLI service sequence", () => {
  it("binds dry-run, stage and publish to the same service content hash", async () => {
    const prepared = await preparedDocument();
    const contentHash = "c".repeat(64);
    const service = {
      dryRunImport: jest.fn().mockResolvedValue({
        dryRun: true,
        publishable: true,
        status: "VALID",
        contentHash,
        expectedActiveSnapshotId: null,
        summary: { records: 1, brokers: 1, includedDealAmount: "0.00" },
      }),
      stageImport: jest.fn().mockResolvedValue({
        snapshotId: "staged-snapshot-id",
        contentHash,
        status: "STAGED",
        idempotent: false,
      }),
      publishSnapshot: jest.fn().mockResolvedValue({
        contentHash,
        status: "PUBLISHED",
        idempotent: false,
      }),
    };

    const result = await executeLoyaltyImport(service as any, prepared, {
      confirmCoverageDrop: false,
    });

    expect(service.stageImport).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContentHash: contentHash,
        expectedActiveSnapshotId: null,
        confirmCoverageDrop: false,
      }),
    );
    expect(service.publishSnapshot).toHaveBeenCalledWith("staged-snapshot-id", {
      confirmed: true,
      expectedContentHash: contentHash,
      expectedActiveSnapshotId: null,
      confirmCoverageDrop: false,
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: "PUBLISHED",
        contentHash,
        counts: { records: 1, brokers: 1 },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("Sensitive Person Name");
    expect(JSON.stringify(result)).not.toContain("+79991234567");
  });

  it("does not stage an invalid dry-run and exposes no service error content", async () => {
    const prepared = await preparedDocument();
    const service = {
      dryRunImport: jest.fn().mockResolvedValue({
        dryRun: true,
        publishable: false,
        status: "INVALID",
        contentHash: "d".repeat(64),
        summary: { records: 1, issueCount: 1 },
        issues: [{ row: 1, code: "PRIVATE_VALUE_Sensitive Person Name" }],
      }),
      stageImport: jest.fn(),
      publishSnapshot: jest.fn(),
    };

    let failure: LoyaltyImportCliError | undefined;
    try {
      await executeLoyaltyImport(service as any, prepared, {
        confirmCoverageDrop: false,
      });
    } catch (error) {
      failure = error as LoyaltyImportCliError;
    }

    expect(failure?.toResult()).toEqual(
      expect.objectContaining({
        status: "FAILED",
        phase: "DRY_RUN",
        code: "DRY_RUN_NOT_PUBLISHABLE",
        issueCount: 1,
      }),
    );
    expect(service.stageImport).not.toHaveBeenCalled();
    expect(JSON.stringify(failure?.toResult())).not.toContain(
      "Sensitive Person Name",
    );
  });

  it("is safe to rerun when stage and publish report idempotency", async () => {
    const prepared = await preparedDocument();
    const contentHash = "e".repeat(64);
    const service = {
      dryRunImport: jest.fn().mockResolvedValue({
        dryRun: true,
        publishable: true,
        status: "VALID",
        contentHash,
        expectedActiveSnapshotId: "48e76571-3ef3-40f9-a84e-16c88b71820a",
        summary: { records: 1 },
      }),
      stageImport: jest.fn().mockResolvedValue({
        snapshotId: "already-active",
        contentHash,
        status: "PUBLISHED",
        idempotent: true,
      }),
      publishSnapshot: jest.fn().mockResolvedValue({
        contentHash,
        status: "PUBLISHED",
        idempotent: true,
      }),
    };

    await expect(
      executeLoyaltyImport(service as any, prepared, {
        confirmCoverageDrop: false,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "PUBLISHED",
        stageIdempotent: true,
        publishIdempotent: true,
      }),
    );
  });
});
