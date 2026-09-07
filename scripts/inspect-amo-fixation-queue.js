#!/usr/bin/env node
/**
 * PII-safe, strictly read-only inspection of the FAILED/PENDING amoCRM
 * fixation queue. This script does not bootstrap Nest, load amoCRM tokens or
 * make network requests. Its database operations are one exact session-mode
 * verification SELECT followed by one Prisma findMany SELECT.
 *
 * Raw database identifiers and dependency errors are used only in memory to
 * produce per-report HMAC aliases and bounded classifications. They are never
 * emitted, and aliases cannot be linked across separate runs.
 */

const { createHmac, randomBytes } = require("node:crypto");

const ATTEMPT_LIMIT = 10;
const STATEMENT_TIMEOUT_MS = 15_000;
const HASH_DOMAIN = "st-michael:amo-fixation-queue-inspector:v1";
const QUEUE_STATUSES = ["FAILED", "PENDING"];
const MAPPING_SOURCES = ["responsible", "owner_fallback", "missing"];
const MAPPING_STATUSES = [
  "amo_contact_present",
  "amo_contact_missing",
  "effective_broker_missing",
];
const ATTEMPT_LIMIT_CLASSES = ["attempt_limit_reached", "below_attempt_limit"];
const ATTEMPT_BUCKETS = ["0", "1-3", "4-9", "10+"];
const ERROR_CLASSES = [
  "none",
  "create_reconciliation_required",
  "uniqueness_recheck_required",
  "auth_rejected",
  "forbidden",
  "rate_limited",
  "temporary_unavailable",
  "network_failure",
  "configuration_missing",
  "fixation_agency_missing",
  "broker_amo_contact_missing",
  "invalid_response",
  "sync_failed",
  "other",
];

function buildReadOnlyDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    throw new Error("DATABASE_URL is missing");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is invalid");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }

  const existingOptions = parsed.searchParams
    .getAll("options")
    .map((value) => value.trim())
    .filter(Boolean);
  parsed.searchParams.delete("options");
  parsed.searchParams.append(
    "options",
    [
      ...existingOptions,
      "-c default_transaction_read_only=on",
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
    ].join(" "),
  );
  return parsed.toString();
}

async function assertReadOnlySession(prisma) {
  const rows =
    await prisma.$queryRaw`SELECT current_setting('default_transaction_read_only') AS mode`;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.mode !== "on") {
    throw new Error("Database session is not read-only");
  }
}

function reportHash(kind, value, hashKey) {
  if (!value) return null;
  if (!Buffer.isBuffer(hashKey) || hashKey.length < 32) {
    throw new Error("Report hash key is invalid");
  }
  const digest = createHmac("sha256", hashKey)
    .update(`${HASH_DOMAIN}:${kind}:${String(value)}`)
    .digest("hex")
    .slice(0, 24);
  return `${kind}_${digest}`;
}

function attemptBucket(attempts) {
  const count = Math.max(
    0,
    Number.isFinite(Number(attempts)) ? Number(attempts) : 0,
  );
  if (count === 0) return "0";
  if (count <= 3) return "1-3";
  if (count < ATTEMPT_LIMIT) return "4-9";
  return "10+";
}

function classifySyncError(error) {
  const raw = String(error || "").trim();
  if (!raw) return "none";
  if (raw.startsWith("AMO_CREATE_RECONCILIATION_REQUIRED:")) {
    return "create_reconciliation_required";
  }
  if (raw.startsWith("AMO_UNIQUENESS_RECHECK_REQUIRED:")) {
    return "uniqueness_recheck_required";
  }

  const normalized = raw.toLowerCase();
  if (raw === "AMO_AUTH_401" || /\b401\b|unauthoriz/.test(normalized)) {
    return "auth_rejected";
  }
  if (raw === "AMO_FORBIDDEN_403" || /\b403\b|forbidden/.test(normalized)) {
    return "forbidden";
  }
  if (raw === "AMO_RATE_LIMIT_429" || /\b429\b|rate.?limit/.test(normalized)) {
    return "rate_limited";
  }
  if (raw === "AMO_TEMPORARY_UNAVAILABLE" || /\b5\d\d\b/.test(normalized)) {
    return "temporary_unavailable";
  }
  if (
    raw === "AMO_NETWORK_ERROR" ||
    /timeout|timed out|network|socket|fetch|econn|enotfound/.test(normalized)
  ) {
    return "network_failure";
  }
  if (
    raw === "AMO_CONFIGURATION_ERROR" ||
    /not configured|не настроен|missing token/.test(normalized)
  ) {
    return "configuration_missing";
  }
  if (raw === "FIXATION_AGENCY_MISSING" || normalized.includes("agency")) {
    return "fixation_agency_missing";
  }
  if (
    raw === "BROKER_AMO_CONTACT_MISSING" ||
    (normalized.includes("broker") && normalized.includes("contact"))
  ) {
    return "broker_amo_contact_missing";
  }
  if (
    raw === "AMO_INVALID_RESPONSE" ||
    /did not return a lead id|не вернула id/.test(normalized)
  ) {
    return "invalid_response";
  }
  if (raw === "AMO_SYNC_FAILED") return "sync_failed";
  return "other";
}

function increment(counts, key) {
  counts[key] = Number(counts[key] || 0) + 1;
}

function zeroCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function hourBucket(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 13)}:00Z`;
}

function oldestHourBucket(candidates, field) {
  return (
    candidates
      .map((candidate) => hourBucket(candidate[field]))
      .filter(Boolean)
      .sort()[0] || null
  );
}

function inspectCandidate(candidate, hashKey) {
  const effective = candidate.responsibleBroker || candidate.broker || null;
  const mappingSource = candidate.responsibleBroker
    ? "responsible"
    : candidate.broker
      ? "owner_fallback"
      : "missing";
  const mappingStatus = !effective
    ? "effective_broker_missing"
    : effective.amoContactId === null || effective.amoContactId === undefined
      ? "amo_contact_missing"
      : "amo_contact_present";
  const attempts = Math.max(
    0,
    Number.isFinite(Number(candidate.amoSyncAttempts))
      ? Number(candidate.amoSyncAttempts)
      : 0,
  );

  return {
    queueHash: reportHash("queue", candidate.id, hashKey),
    effectiveBrokerHash: effective
      ? reportHash("broker", effective.id, hashKey)
      : null,
    status: QUEUE_STATUSES.includes(candidate.amoSyncStatus)
      ? candidate.amoSyncStatus
      : "UNKNOWN",
    attemptLimitClass:
      attempts >= ATTEMPT_LIMIT
        ? "attempt_limit_reached"
        : "below_attempt_limit",
    attemptBucket: attemptBucket(attempts),
    mappingSource,
    mappingStatus,
    mappingClass: `${mappingSource}:${mappingStatus}`,
    errorClass: classifySyncError(candidate.amoSyncError),
  };
}

function buildReport(
  candidates,
  generatedAt = new Date(),
  hashKey = randomBytes(32),
) {
  const records = candidates
    .map((candidate) => inspectCandidate(candidate, hashKey))
    .sort((left, right) =>
      String(left.queueHash).localeCompare(String(right.queueHash)),
    );
  const statusCounts = zeroCounts([...QUEUE_STATUSES, "UNKNOWN"]);
  const attemptLimitCounts = zeroCounts(ATTEMPT_LIMIT_CLASSES);
  const attemptCounts = zeroCounts(ATTEMPT_BUCKETS);
  const mappingSourceCounts = zeroCounts(MAPPING_SOURCES);
  const mappingStatusCounts = zeroCounts(MAPPING_STATUSES);
  const errorCounts = zeroCounts(ERROR_CLASSES);
  const mappingClassCounts = {};
  const brokerHashes = new Set();

  for (const record of records) {
    increment(statusCounts, record.status);
    increment(attemptLimitCounts, record.attemptLimitClass);
    increment(attemptCounts, record.attemptBucket);
    increment(mappingSourceCounts, record.mappingSource);
    increment(mappingStatusCounts, record.mappingStatus);
    increment(mappingClassCounts, record.mappingClass);
    increment(errorCounts, record.errorClass);
    if (record.effectiveBrokerHash)
      brokerHashes.add(record.effectiveBrokerHash);
  }

  return {
    inspector: "amo_fixation_queue",
    schemaVersion: 2,
    generatedAt: generatedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    safety: {
      readOnly: true,
      databaseOperation:
        "read-only session verification SELECT plus Prisma findMany SELECT",
      databaseSessionReadOnly: true,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      amoNetworkRequests: false,
      rawIdentifiersEmitted: false,
      contactFieldsSelected: false,
    },
    attemptLimit: { maxAttempts: ATTEMPT_LIMIT },
    classification: {
      hashScheme: "hmac-sha256-per-report-key-v1-24hex",
      crossRunLinkable: false,
      ageBasis: "created_at_hour_bucket",
      timestampResolution: "hour",
    },
    aggregates: {
      total: records.length,
      oldestCreatedAtHourBucket: oldestHourBucket(candidates, "createdAt"),
      oldestLastAttemptAtHourBucket: oldestHourBucket(
        candidates,
        "amoSyncLastAttemptAt",
      ),
      uniqueEffectiveBrokerHashes: brokerHashes.size,
      status: statusCounts,
      attemptLimitClass: attemptLimitCounts,
      attemptBucket: attemptCounts,
      mappingSource: mappingSourceCounts,
      mappingStatus: mappingStatusCounts,
      mappingClass: Object.fromEntries(
        Object.entries(mappingClassCounts).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      errorClass: errorCounts,
    },
    records,
  };
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const readOnlyDatabaseUrl = buildReadOnlyDatabaseUrl(
    process.env.DATABASE_URL,
  );
  const prisma = new PrismaClient({
    datasources: { db: { url: readOnlyDatabaseUrl } },
  });

  try {
    await assertReadOnlySession(prisma);
    const candidates = await prisma.client.findMany({
      where: { amoSyncStatus: { in: QUEUE_STATUSES } },
      select: {
        id: true,
        createdAt: true,
        amoSyncStatus: true,
        amoSyncAttempts: true,
        amoSyncLastAttemptAt: true,
        amoSyncError: true,
        broker: {
          select: { id: true, amoContactId: true },
        },
        responsibleBroker: {
          select: { id: true, amoContactId: true },
        },
      },
      orderBy: [
        { amoSyncLastAttemptAt: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    process.stdout.write(
      `${JSON.stringify(buildReport(candidates), null, 2)}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  ATTEMPT_LIMIT,
  STATEMENT_TIMEOUT_MS,
  attemptBucket,
  assertReadOnlySession,
  buildReport,
  buildReadOnlyDatabaseUrl,
  classifySyncError,
  hourBucket,
  inspectCandidate,
  reportHash,
};

if (require.main === module) {
  main().catch(() => {
    process.stderr.write(
      "PII-safe queue inspector failed; dependency details suppressed.\n",
    );
    process.exitCode = 1;
  });
}
