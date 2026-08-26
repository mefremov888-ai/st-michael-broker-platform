#!/usr/bin/env node
/**
 * Exact-cohort, link-only repair for exhausted amoCRM fixation rows.
 *
 * amoCRM is strictly GET-only. The only business-row mutation is a
 * compare-and-set of amoLeadId, amoSyncStatus and amoSyncError for rows that
 * independently reproduce one unambiguous strong lead candidate. No row is
 * requeued and no amoCRM entity is mutated.
 */

"use strict";

const { createHash, createHmac, randomBytes } = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");

const EXACT_CONFIRMATION = "LINK_AMO_FIXATION_LEADS";
const EXPECTED_DATABASE_NAME = "broker_platform";
const KNOWN_QUEUE_ROWS = 12;
const EXPECTED_REQUEUE_COUNT = 0;
const ATTEMPT_LIMIT = 10;
const QUEUE_STATUSES = Object.freeze(["FAILED", "PENDING"]);
const STATEMENT_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 300_000;
const APPLY_AUDIT_SOURCE = "production_amo_fixation_lead_reconciliation";
const COMPLETION_ACTION = "AMO_FIXATION_LEAD_REPAIR_COMPLETED";
const ROW_ACTION = "AMO_FIXATION_LEAD_RECONCILED";
const COMPLETION_ENTITY = "AmoFixationLeadRepair";
const COMPLETION_ID_DOMAIN =
  "st-michael:amo-fixation-lead-reconciliation-completion:v1";
const ADVISORY_LOCK_DOMAIN =
  "st-michael:amo-fixation-lead-reconciliation-advisory-lock:v1";

const RESOLUTION_CLASSES = Object.freeze([
  "database_lead_already_present",
  "invalid_client_phone",
  "effective_broker_missing",
  "broker_contact_missing",
  "broker_client_contact_role_collision",
  "no_exact_client_contact",
  "ambiguous_exact_client_contacts",
  "no_candidate",
  "single_strong_candidate",
  "single_strong_with_weak_candidates",
  "multiple_strong_candidates",
  "single_weak_candidate",
  "multiple_weak_candidates",
]);

const ERROR_CLASSES = Object.freeze([
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
]);

const CLIENT_SELECT = Object.freeze({
  id: true,
  brokerId: true,
  responsibleBrokerId: true,
  phone: true,
  project: true,
  createdAt: true,
  updatedAt: true,
  amoLeadId: true,
  amoSyncStatus: true,
  amoSyncAttempts: true,
  amoSyncLastAttemptAt: true,
  amoSyncError: true,
  broker: { select: { id: true, amoContactId: true } },
  responsibleBroker: { select: { id: true, amoContactId: true } },
});

const FAILURE_PHASE = Object.freeze({
  GATE: "GATE",
  DATABASE: "DATABASE",
  ACCOUNT: "ACCOUNT",
  IDEMPOTENCY: "IDEMPOTENCY",
  FIRST_SCAN: "FIRST_SCAN",
  TRANSACTION_LOCK: "TRANSACTION_LOCK",
  SECOND_SCAN: "SECOND_SCAN",
  OCCUPANCY: "OCCUPANCY",
  DATABASE_CAS: "DATABASE_CAS",
  FINAL_SCAN: "FINAL_SCAN",
  AUDIT: "AUDIT",
  REPORT: "REPORT",
});

let activeFailurePhase = FAILURE_PHASE.GATE;

class ReconciliationFailure extends Error {
  constructor(code) {
    super("amo fixation lead reconciliation failed");
    this.name = "ReconciliationFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new ReconciliationFailure(code);
}

function safeFailureCode(error) {
  try {
    if (
      error instanceof ReconciliationFailure &&
      typeof error.code === "string" &&
      /^[A-Z][A-Z0-9_]{2,95}$/.test(error.code)
    ) {
      return error.code;
    }
    if (error && typeof error === "object") {
      if (error.code === "P2002") return "DATABASE_UNIQUE_CONSTRAINT";
      if (error.code === "P2034") return "DATABASE_SERIALIZATION_CONFLICT";
    }
  } catch {
    return "UNCLASSIFIED_FAILURE";
  }
  return "UNCLASSIFIED_FAILURE";
}

function writeSafeEvent(event) {
  const allowed = new Set([
    "event",
    "schemaVersion",
    "sourceSha",
    "reviewedRunId",
    "queueRows",
    "linked",
    "alreadyLinked",
    "blocked",
    "requeued",
    "amoMutations",
    "failurePhase",
    "failureCode",
  ]);
  if (
    !event ||
    typeof event !== "object" ||
    Object.keys(event).some((key) => !allowed.has(key))
  ) {
    fail("UNSAFE_REPORT_EVENT");
  }
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function boundedCount(value, field, maximum = KNOWN_QUEUE_ROWS) {
  if (!/^(0|[1-9]\d{0,2})$/.test(String(value ?? ""))) {
    fail(`INVALID_${field}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    fail(`INVALID_${field}`);
  }
  return parsed;
}

function parseFixedManifest(value, keys, label) {
  const raw = String(value ?? "");
  if (raw.length < keys.length * 3 || raw.length > 4096) {
    fail(`${label}_MANIFEST_INVALID`);
  }
  const entries = raw.split(",");
  if (entries.length !== keys.length) fail(`${label}_MANIFEST_INVALID`);
  const result = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const match = entries[index].match(/^([a-z_]+)=(0|[1-9]\d{0,2})$/);
    if (!match || match[1] !== key) fail(`${label}_MANIFEST_ORDER_INVALID`);
    result[key] = boundedCount(match[2], `${label}_${key.toUpperCase()}`);
  }
  return result;
}

function formatFixedManifest(counts, keys) {
  return keys.map((key) => `${key}=${Number(counts?.[key])}`).join(",");
}

function readExecutionGate(env = process.env) {
  if (env.LEAD_RECONCILIATION_CONFIRMATION !== EXACT_CONFIRMATION) {
    fail("CONFIRMATION_REQUIRED");
  }
  const sourceSha = String(env.LEAD_RECONCILIATION_SOURCE_SHA || "");
  const confirmedSha = String(env.LEAD_RECONCILIATION_CONFIRM_EXACT_SHA || "");
  const deployedGitSha = String(env.LEAD_RECONCILIATION_DEPLOYED_GIT_SHA || "");
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail("SOURCE_SHA_INVALID");
  if (confirmedSha !== sourceSha) fail("SOURCE_SHA_CONFIRMATION_MISMATCH");
  if (deployedGitSha !== sourceSha) fail("DEPLOYED_SHA_MISMATCH");

  const reviewedRunId = String(
    env.LEAD_RECONCILIATION_REVIEWED_INSPECTOR_RUN_ID || "",
  );
  if (!/^[1-9]\d{5,19}$/.test(reviewedRunId)) {
    fail("REVIEWED_INSPECTOR_RUN_ID_INVALID");
  }
  const expectedCohortDigest = String(
    env.LEAD_RECONCILIATION_EXPECTED_COHORT_DIGEST || "",
  );
  const inspectorSha256 = String(
    env.LEAD_RECONCILIATION_INSPECTOR_SHA256 || "",
  );
  const applySha256 = String(env.LEAD_RECONCILIATION_APPLY_SHA256 || "");
  for (const [value, code] of [
    [expectedCohortDigest, "EXPECTED_COHORT_DIGEST_INVALID"],
    [inspectorSha256, "INSPECTOR_SHA256_INVALID"],
    [applySha256, "APPLY_SHA256_INVALID"],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(value)) fail(code);
  }
  if (String(env.LEAD_RECONCILIATION_EXPECTED_QUEUE_ROWS || "") !== "12") {
    fail("EXPECTED_QUEUE_ROWS_INVALID");
  }
  if (String(env.LEAD_RECONCILIATION_EXPECTED_REQUEUE_COUNT || "") !== "0") {
    fail("REQUEUE_COUNT_MUST_BE_ZERO");
  }
  const expectedCasCount = boundedCount(
    env.LEAD_RECONCILIATION_EXPECTED_CAS_COUNT,
    "EXPECTED_CAS_COUNT",
  );
  if (expectedCasCount < 1) fail("EXPECTED_CAS_COUNT_MUST_BE_POSITIVE");
  const expectedSharedStrongCount = boundedCount(
    env.LEAD_RECONCILIATION_EXPECTED_SHARED_STRONG_COUNT,
    "EXPECTED_SHARED_STRONG_COUNT",
  );
  if (expectedSharedStrongCount !== 0) {
    fail("SHARED_STRONG_COUNT_MUST_BE_ZERO");
  }
  const resolution = parseFixedManifest(
    env.LEAD_RECONCILIATION_EXPECTED_RESOLUTION_MANIFEST,
    RESOLUTION_CLASSES,
    "RESOLUTION",
  );
  const errorClass = parseFixedManifest(
    env.LEAD_RECONCILIATION_EXPECTED_ERROR_MANIFEST,
    ERROR_CLASSES,
    "ERROR",
  );
  if (
    Object.values(resolution).reduce((sum, count) => sum + count, 0) !==
      KNOWN_QUEUE_ROWS ||
    Object.values(errorClass).reduce((sum, count) => sum + count, 0) !==
      KNOWN_QUEUE_ROWS
  ) {
    fail("MANIFEST_TOTAL_MISMATCH");
  }
  if (resolution.single_strong_candidate < expectedCasCount) {
    fail("EXPECTED_CAS_COUNT_EXCEEDS_STRONG_ROWS");
  }
  return {
    sourceSha,
    deployedGitSha,
    reviewedRunId,
    expectedCohortDigest,
    inspectorSha256,
    applySha256,
    expectedCasCount,
    expectedSharedStrongCount,
    expected: { resolution, errorClass },
  };
}

function hashRegularFile(pathname, missingCode, unsafeCode) {
  let stat;
  try {
    stat = lstatSync(pathname);
  } catch {
    fail(missingCode);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    fail(unsafeCode);
  }
  try {
    return createHash("sha256").update(readFileSync(pathname)).digest("hex");
  } catch {
    fail(unsafeCode);
  }
}

function loadInspectorModule(
  modulePath = process.env.LEAD_RECONCILIATION_INSPECTOR_MODULE,
  expectedSha256 = process.env.LEAD_RECONCILIATION_INSPECTOR_SHA256,
) {
  const candidate = modulePath
    ? String(modulePath)
    : resolve(__dirname, "inspect-amo-fixation-lead-reconciliation.js");
  if (!isAbsolute(candidate)) fail("INSPECTOR_MODULE_PATH_NOT_ABSOLUTE");
  if (!/^[0-9a-f]{64}$/.test(String(expectedSha256 || ""))) {
    fail("INSPECTOR_SHA256_INVALID");
  }
  if (
    hashRegularFile(
      candidate,
      "INSPECTOR_MODULE_MISSING",
      "INSPECTOR_MODULE_UNSAFE",
    ) !== expectedSha256
  ) {
    fail("INSPECTOR_SHA_MISMATCH");
  }
  const loaded = require(candidate);
  for (const required of [
    "assertExpectedAccount",
    "assertExpectedQueueRows",
    "buildReport",
    "classifySyncError",
    "collectAmoEvidence",
    "createGetOnlyRequester",
    "inspectQueueRow",
    "normalizePhone",
    "optionalStoredAmoLeadId",
    "stableJson",
  ]) {
    if (typeof loaded?.[required] !== "function") {
      fail("INSPECTOR_MODULE_CONTRACT_INVALID");
    }
  }
  if (
    loaded.KNOWN_QUEUE_ROWS !== KNOWN_QUEUE_ROWS ||
    loaded.ATTEMPT_LIMIT !== ATTEMPT_LIMIT ||
    loaded.AMO_ORIGIN !== "https://stmichael.amocrm.ru"
  ) {
    fail("INSPECTOR_MODULE_CONSTANTS_INVALID");
  }
  return loaded;
}

function assertOwnSourceHash(expectedSha256) {
  if (!/^[0-9a-f]{64}$/.test(String(expectedSha256 || ""))) {
    fail("APPLY_SHA256_INVALID");
  }
  if (
    hashRegularFile(
      __filename,
      "APPLY_SOURCE_MISSING",
      "APPLY_SOURCE_UNSAFE",
    ) !== expectedSha256
  ) {
    fail("APPLY_SOURCE_SHA_MISMATCH");
  }
}

function readAttestationKey(keyFile) {
  if (typeof keyFile !== "string" || !keyFile || !isAbsolute(keyFile)) {
    fail("ATTESTATION_KEY_FILE_INVALID");
  }
  let stat;
  try {
    stat = lstatSync(keyFile);
  } catch {
    fail("ATTESTATION_KEY_FILE_INVALID");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 32 ||
    stat.size > 4096
  ) {
    fail("ATTESTATION_KEY_FILE_INVALID");
  }
  let key;
  try {
    key = readFileSync(keyFile);
  } catch {
    fail("ATTESTATION_KEY_FILE_INVALID");
  }
  if (!Buffer.isBuffer(key) || key.length < 32 || key.length > 4096) {
    fail("ATTESTATION_KEY_INVALID");
  }
  return key;
}

function buildWriteDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    fail("DATABASE_URL_MISSING");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail("DATABASE_URL_INVALID");
  }
  if (!parsed || !["postgres:", "postgresql:"].includes(parsed.protocol)) {
    fail("DATABASE_URL_NOT_POSTGRESQL");
  }
  const options = parsed.searchParams
    .getAll("options")
    .map((value) => value.trim())
    .filter(Boolean);
  parsed.searchParams.delete("options");
  parsed.searchParams.append(
    "options",
    [
      ...options,
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
    ].join(" "),
  );
  return parsed.toString();
}

async function assertProductionDatabase(prisma) {
  const rows = await prisma.$queryRaw`
    SELECT current_database() AS database_name,
           current_setting('default_transaction_read_only') AS read_only
  `;
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.database_name !== EXPECTED_DATABASE_NAME ||
    rows[0]?.read_only !== "off"
  ) {
    fail("PRODUCTION_DATABASE_IDENTITY_MISMATCH");
  }
}

function validDateIso(value, code) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail(code);
  return date.toISOString();
}

function optionalDateIso(value, code) {
  if (value === null) return null;
  return validDateIso(value, code);
}

function optionalAmoIdString(value, inspector) {
  const parsed = inspector.optionalStoredAmoLeadId(value);
  return parsed === null ? null : String(parsed);
}

function brokerSnapshot(broker) {
  if (broker === null || broker === undefined) return null;
  if (!broker.id) fail("BROKER_SNAPSHOT_INVALID");
  let contactId = null;
  if (broker.amoContactId !== null) {
    if (typeof broker.amoContactId !== "bigint" || broker.amoContactId <= 0n) {
      fail("BROKER_SNAPSHOT_INVALID");
    }
    contactId = broker.amoContactId.toString();
  }
  return { id: String(broker.id), amoContactId: contactId };
}

function rowSnapshot(row, inspector) {
  if (!row?.id || !row.brokerId || typeof row.phone !== "string") {
    fail("QUEUE_ROW_SNAPSHOT_INVALID");
  }
  return inspector.stableJson({
    id: String(row.id),
    brokerId: String(row.brokerId),
    responsibleBrokerId: row.responsibleBrokerId
      ? String(row.responsibleBrokerId)
      : null,
    phone: row.phone,
    project: String(row.project || ""),
    createdAt: validDateIso(row.createdAt, "QUEUE_CREATED_AT_INVALID"),
    updatedAt: validDateIso(row.updatedAt, "QUEUE_UPDATED_AT_INVALID"),
    amoLeadId: optionalAmoIdString(row.amoLeadId, inspector),
    amoSyncStatus: String(row.amoSyncStatus || ""),
    amoSyncAttempts: Number(row.amoSyncAttempts),
    amoSyncLastAttemptAt: optionalDateIso(
      row.amoSyncLastAttemptAt,
      "QUEUE_LAST_ATTEMPT_AT_INVALID",
    ),
    amoSyncError:
      row.amoSyncError === null ? null : String(row.amoSyncError || ""),
    broker: brokerSnapshot(row.broker),
    responsibleBroker: brokerSnapshot(row.responsibleBroker),
  });
}

async function loadExactCohort(database, inspector) {
  const rows = await database.client.findMany({
    where: {
      amoSyncStatus: { in: QUEUE_STATUSES },
      amoSyncAttempts: { gte: ATTEMPT_LIMIT },
    },
    select: CLIENT_SELECT,
    orderBy: [
      { amoSyncLastAttemptAt: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    take: 13,
  });
  try {
    inspector.assertExpectedQueueRows(rows);
  } catch {
    fail("QUEUE_COHORT_COUNT_CHANGED");
  }
  return rows;
}

function reportManifest(report) {
  if (
    report?.inspector !== "amo_fixation_lead_reconciliation" ||
    report?.schemaVersion !== 1 ||
    report?.aggregates?.exhaustedQueueRows !== KNOWN_QUEUE_ROWS
  ) {
    fail("INSPECTOR_REPORT_CONTRACT_INVALID");
  }
  const resolution = {};
  const errorClass = {};
  for (const key of RESOLUTION_CLASSES) {
    resolution[key] = boundedCount(
      report?.aggregates?.resolution?.[key],
      `REPORT_RESOLUTION_${key.toUpperCase()}`,
    );
  }
  for (const key of ERROR_CLASSES) {
    errorClass[key] = boundedCount(
      report?.aggregates?.errorClass?.[key],
      `REPORT_ERROR_${key.toUpperCase()}`,
    );
  }
  const rowsWithCasLinkCandidate = boundedCount(
    report?.aggregates?.rowsWithCasLinkCandidate,
    "REPORT_CAS_COUNT",
  );
  const sharedStrongCount = boundedCount(
    report?.aggregates?.strongLeadHashesSharedAcrossRows,
    "REPORT_SHARED_STRONG_COUNT",
  );
  const cohortDigest = String(report?.cohortAttestation?.hmacSha256 || "");
  if (!/^[0-9a-f]{64}$/.test(cohortDigest)) {
    fail("REPORT_COHORT_DIGEST_INVALID");
  }
  return {
    cohortDigest,
    rowsWithCasLinkCandidate,
    sharedStrongCount,
    resolution,
    errorClass,
  };
}

function assertReportMatchesGate(report, gate) {
  const actual = reportManifest(report);
  if (
    actual.cohortDigest !== gate.expectedCohortDigest ||
    actual.rowsWithCasLinkCandidate !== gate.expectedCasCount ||
    actual.sharedStrongCount !== gate.expectedSharedStrongCount ||
    formatFixedManifest(actual.resolution, RESOLUTION_CLASSES) !==
      formatFixedManifest(gate.expected.resolution, RESOLUTION_CLASSES) ||
    formatFixedManifest(actual.errorClass, ERROR_CLASSES) !==
      formatFixedManifest(gate.expected.errorClass, ERROR_CLASSES) ||
    report?.cohortAttestation?.bindsInspectorSha256 !== gate.inspectorSha256 ||
    report?.cohortAttestation?.bindsDeployedGitSha !== gate.deployedGitSha
  ) {
    fail("INSPECTOR_REPORT_GATE_MISMATCH");
  }
  return actual;
}

function buildExecutionPlan(queueRows, amoEvidence, inspector) {
  if (!Array.isArray(queueRows) || queueRows.length !== KNOWN_QUEUE_ROWS) {
    fail("QUEUE_COHORT_COUNT_CHANGED");
  }
  const records = queueRows.map((row) => {
    let inspected;
    try {
      inspected = inspector.inspectQueueRow(
        row,
        amoEvidence.byPhone,
        randomBytes(32),
      );
    } catch {
      fail("INSPECTOR_ROW_CONTRACT_INVALID");
    }
    const publicRecord = inspected?.publicRecord;
    const strongRawIds = inspected?.strongRawIds;
    if (!publicRecord || !Array.isArray(strongRawIds)) {
      fail("INSPECTOR_ROW_CONTRACT_INVALID");
    }
    const eligible =
      publicRecord.resolution === "single_strong_candidate" &&
      publicRecord.errorClass === "create_reconciliation_required" &&
      row.amoLeadId === null &&
      publicRecord.advisory?.casLinkCandidate === true &&
      publicRecord.exactClientContacts?.count === 1 &&
      publicRecord.linkedLeadEvidence?.strong === 1 &&
      publicRecord.linkedLeadEvidence?.weak === 0 &&
      strongRawIds.length === 1;
    if (publicRecord.advisory?.casLinkCandidate === true && !eligible) {
      fail("UNSAFE_CAS_ADVISORY");
    }
    return {
      row,
      snapshot: rowSnapshot(row, inspector),
      resolution: publicRecord.resolution,
      errorClass: publicRecord.errorClass,
      eligible,
      candidateLeadId: eligible ? strongRawIds[0] : null,
      exactClientContactCount: publicRecord.exactClientContacts?.count,
      strongCount: publicRecord.linkedLeadEvidence?.strong,
      weakCount: publicRecord.linkedLeadEvidence?.weak,
    };
  });
  const strongOwners = new Map();
  for (const record of records.filter((item) => item.eligible)) {
    const key = String(record.candidateLeadId);
    strongOwners.set(key, (strongOwners.get(key) || 0) + 1);
  }
  if ([...strongOwners.values()].some((count) => count !== 1)) {
    fail("STRONG_CANDIDATE_SHARED_ACROSS_ROWS");
  }
  return {
    records,
    actionable: records.filter((record) => record.eligible),
    blocked: records.filter((record) => !record.eligible),
  };
}

function planIdentity(plan, inspector) {
  return inspector.stableJson(
    plan.records.map((record) => ({
      queueId: String(record.row.id),
      snapshot: record.snapshot,
      resolution: record.resolution,
      errorClass: record.errorClass,
      candidateLeadId:
        record.candidateLeadId === null ? null : String(record.candidateLeadId),
    })),
  );
}

function assertExactPlan(plan, gate) {
  if (
    plan.records.length !== KNOWN_QUEUE_ROWS ||
    plan.actionable.length !== gate.expectedCasCount ||
    plan.blocked.length !== KNOWN_QUEUE_ROWS - gate.expectedCasCount
  ) {
    fail("EXECUTION_PLAN_COUNT_MISMATCH");
  }
  for (const record of plan.actionable) {
    if (
      record.resolution !== "single_strong_candidate" ||
      record.errorClass !== "create_reconciliation_required" ||
      record.row.amoLeadId !== null ||
      record.exactClientContactCount !== 1 ||
      record.strongCount !== 1 ||
      record.weakCount !== 0 ||
      !Number.isSafeInteger(record.candidateLeadId) ||
      record.candidateLeadId <= 0
    ) {
      fail("UNSAFE_EXECUTION_PLAN");
    }
  }
}

function completionEntityId(sourceSha, cohortDigest) {
  if (
    !/^[0-9a-f]{40}$/.test(String(sourceSha || "")) ||
    !/^[0-9a-f]{64}$/.test(String(cohortDigest || ""))
  ) {
    fail("COMPLETION_ID_INPUT_INVALID");
  }
  return createHash("sha256")
    .update(COMPLETION_ID_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(sourceSha, "utf8")
    .update("\0", "utf8")
    .update(cohortDigest, "utf8")
    .digest("hex");
}

function advisoryLockKey(sourceSha, cohortDigest) {
  return createHash("sha256")
    .update(ADVISORY_LOCK_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(sourceSha, "utf8")
    .update("\0", "utf8")
    .update(cohortDigest, "utf8")
    .digest()
    .readBigInt64BE(0);
}

async function acquireRepairAdvisoryLock(transaction, gate) {
  const key = advisoryLockKey(gate.sourceSha, gate.expectedCohortDigest);
  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${key})`;
}

async function findRepairLedger(database, gate) {
  const entityId = completionEntityId(
    gate.sourceSha,
    gate.expectedCohortDigest,
  );
  const [completion, rows] = await Promise.all([
    database.auditLog.findMany({
      where: {
        action: COMPLETION_ACTION,
        entity: COMPLETION_ENTITY,
        entityId,
      },
      select: { id: true, entityId: true, payload: true },
      take: 2,
    }),
    database.auditLog.findMany({
      where: {
        action: ROW_ACTION,
        entity: "Client",
        AND: [
          {
            payload: {
              path: ["sourceSha"],
              equals: gate.sourceSha,
            },
          },
          {
            payload: {
              path: ["cohortDigest"],
              equals: gate.expectedCohortDigest,
            },
          },
        ],
      },
      select: { id: true, entityId: true, payload: true },
      orderBy: { id: "asc" },
      take: KNOWN_QUEUE_ROWS + 1,
    }),
  ]);
  if (!Array.isArray(completion) || !Array.isArray(rows)) {
    fail("AUDIT_LEDGER_INVALID");
  }
  if (completion.length > 1 || rows.length > KNOWN_QUEUE_ROWS) {
    fail("AUDIT_LEDGER_DUPLICATE");
  }
  if (completion.length === 0 && rows.length > 0) {
    fail("AUDIT_LEDGER_PARTIAL");
  }
  return { completion, rows, entityId };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort())
  );
}

function validateCompletionLedger(ledger, gate) {
  if (ledger.completion.length !== 1) fail("COMPLETION_AUDIT_MISSING");
  const payload = ledger.completion[0]?.payload;
  if (
    ledger.completion[0]?.entityId !==
      completionEntityId(gate.sourceSha, gate.expectedCohortDigest) ||
    !hasExactKeys(payload, [
      "schemaVersion",
      "source",
      "sourceSha",
      "reviewedRunId",
      "cohortDigest",
      "inspectorSha256",
      "applySha256",
      "queueRows",
      "linked",
      "blocked",
      "requeued",
      "amoMutations",
      "links",
    ]) ||
    !Array.isArray(payload.links)
  ) {
    fail("COMPLETION_AUDIT_MALFORMED");
  }
  if (
    payload.schemaVersion !== 1 ||
    payload.source !== APPLY_AUDIT_SOURCE ||
    payload.sourceSha !== gate.sourceSha ||
    payload.reviewedRunId !== gate.reviewedRunId ||
    payload.cohortDigest !== gate.expectedCohortDigest ||
    payload.inspectorSha256 !== gate.inspectorSha256 ||
    payload.applySha256 !== gate.applySha256 ||
    payload.queueRows !== KNOWN_QUEUE_ROWS ||
    payload.linked !== gate.expectedCasCount ||
    payload.blocked !== KNOWN_QUEUE_ROWS - gate.expectedCasCount ||
    payload.requeued !== EXPECTED_REQUEUE_COUNT ||
    payload.amoMutations !== 0 ||
    payload.links.length !== gate.expectedCasCount ||
    ledger.rows.length !== gate.expectedCasCount
  ) {
    fail("COMPLETION_AUDIT_MALFORMED");
  }
  const links = payload.links.map((link) => {
    if (
      !hasExactKeys(link, ["clientId", "amoLeadId"]) ||
      typeof link.clientId !== "string" ||
      !link.clientId ||
      !/^[1-9]\d{0,15}$/.test(String(link.amoLeadId || ""))
    ) {
      fail("COMPLETION_AUDIT_MALFORMED");
    }
    const leadId = Number(link.amoLeadId);
    if (!Number.isSafeInteger(leadId)) fail("COMPLETION_AUDIT_MALFORMED");
    return { clientId: link.clientId, amoLeadId: leadId };
  });
  const clientIds = links.map((link) => link.clientId);
  const leadIds = links.map((link) => link.amoLeadId);
  if (
    new Set(clientIds).size !== clientIds.length ||
    new Set(leadIds).size !== leadIds.length ||
    JSON.stringify(clientIds) !== JSON.stringify([...clientIds].sort())
  ) {
    fail("COMPLETION_AUDIT_DUPLICATE_LINK");
  }
  const rowByClient = new Map();
  for (const audit of ledger.rows) {
    const rowPayload = audit?.payload;
    if (
      !hasExactKeys(rowPayload, [
        "schemaVersion",
        "source",
        "sourceSha",
        "reviewedRunId",
        "cohortDigest",
        "inspectorSha256",
        "applySha256",
        "clientId",
        "amoLeadId",
        "resolution",
        "errorClass",
        "sourceRowHash",
        "amoSyncAttempts",
        "amoSyncLastAttemptAt",
        "attemptsPreserved",
        "lastAttemptPreserved",
        "requeued",
        "amoMutation",
      ]) ||
      audit.entityId !== rowPayload.clientId ||
      rowPayload.schemaVersion !== 1 ||
      rowPayload.source !== APPLY_AUDIT_SOURCE ||
      rowPayload.sourceSha !== gate.sourceSha ||
      rowPayload.reviewedRunId !== gate.reviewedRunId ||
      rowPayload.cohortDigest !== gate.expectedCohortDigest ||
      rowPayload.inspectorSha256 !== gate.inspectorSha256 ||
      rowPayload.applySha256 !== gate.applySha256 ||
      rowPayload.resolution !== "single_strong_candidate" ||
      rowPayload.errorClass !== "create_reconciliation_required" ||
      !/^[0-9a-f]{64}$/.test(String(rowPayload.sourceRowHash || "")) ||
      rowPayload.attemptsPreserved !== true ||
      rowPayload.lastAttemptPreserved !== true ||
      rowPayload.requeued !== false ||
      rowPayload.amoMutation !== false ||
      !/^[1-9]\d{0,15}$/.test(String(rowPayload.amoLeadId || "")) ||
      !Number.isSafeInteger(rowPayload.amoSyncAttempts) ||
      rowPayload.amoSyncAttempts < ATTEMPT_LIMIT ||
      (rowPayload.amoSyncLastAttemptAt !== null &&
        typeof rowPayload.amoSyncLastAttemptAt !== "string")
    ) {
      fail("ROW_AUDIT_MALFORMED");
    }
    if (rowByClient.has(rowPayload.clientId)) fail("ROW_AUDIT_DUPLICATE");
    rowByClient.set(rowPayload.clientId, rowPayload);
  }
  for (const link of links) {
    const audit = rowByClient.get(link.clientId);
    if (!audit || Number(audit.amoLeadId) !== link.amoLeadId) {
      fail("AUDIT_LEDGER_LINK_MISMATCH");
    }
  }
  return { links, rowByClient };
}

async function lockClientWriters(transaction) {
  if (!transaction || typeof transaction.$executeRaw !== "function") {
    fail("CLIENT_TABLE_LOCK_TRANSACTION_INVALID");
  }
  // Commit-time invariant only: every INSERT/UPDATE/DELETE takes ROW EXCLUSIVE,
  // which conflicts with this mode. Existing writers finish before our stable
  // occupancy check; new writers wait until commit. amoLeadId is intentionally
  // non-unique, so this repair does not claim permanent uniqueness after commit.
  await transaction.$executeRaw`LOCK TABLE clients IN SHARE ROW EXCLUSIVE MODE`;
}

async function checkCandidateOccupancy(transaction, actionable) {
  const candidateIds = actionable
    .map((record) => BigInt(record.candidateLeadId))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    candidateIds.length < 1 ||
    new Set(candidateIds.map(String)).size !== candidateIds.length
  ) {
    fail("CANDIDATE_LEAD_SET_INVALID");
  }
  const occupied = await transaction.client.findMany({
    where: { amoLeadId: { in: candidateIds } },
    select: { id: true, amoLeadId: true },
    orderBy: [{ amoLeadId: "asc" }, { id: "asc" }],
  });
  if (!Array.isArray(occupied)) fail("CANDIDATE_OCCUPANCY_INVALID");
  if (occupied.length !== 0) fail("CANDIDATE_LEAD_ALREADY_OCCUPIED");
}

async function casLinkClient(transaction, Prisma, record) {
  const row = record.row;
  const result = await transaction.$queryRaw(
    Prisma.sql`
      UPDATE clients
         SET amo_lead_id = ${BigInt(record.candidateLeadId)},
             amo_sync_status = 'SYNCED'::"AmoSyncStatus",
             amo_sync_error = NULL
       WHERE id = ${row.id}::uuid
         AND amo_lead_id IS NULL
         AND amo_sync_status::text = ${row.amoSyncStatus}
         AND amo_sync_attempts = ${row.amoSyncAttempts}
         AND amo_sync_error IS NOT DISTINCT FROM ${row.amoSyncError}
         AND amo_sync_last_attempt_at IS NOT DISTINCT FROM ${row.amoSyncLastAttemptAt}
         AND created_at = ${row.createdAt}
         AND updated_at = ${row.updatedAt}
         AND phone = ${row.phone}
         AND project::text = ${row.project}
         AND broker_id = ${row.brokerId}::uuid
         AND responsible_broker_id IS NOT DISTINCT FROM ${row.responsibleBrokerId}::uuid
       RETURNING id
    `,
  );
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    result[0]?.id !== row.id
  ) {
    fail("CLIENT_CAS_UPDATE_MISSED");
  }
}

function sourceRowHash(record, attestationKey) {
  if (!Buffer.isBuffer(attestationKey) || attestationKey.length < 32) {
    fail("ATTESTATION_KEY_INVALID");
  }
  return createHmac("sha256", attestationKey)
    .update("st-michael:amo-fixation-lead-source-row:v1", "utf8")
    .update("\0", "utf8")
    .update(record.snapshot, "utf8")
    .digest("hex");
}

async function createRowAudit(transaction, record, gate, attestationKey) {
  await transaction.auditLog.create({
    data: {
      userId: null,
      action: ROW_ACTION,
      entity: "Client",
      entityId: record.row.id,
      payload: {
        schemaVersion: 1,
        source: APPLY_AUDIT_SOURCE,
        sourceSha: gate.sourceSha,
        reviewedRunId: gate.reviewedRunId,
        cohortDigest: gate.expectedCohortDigest,
        inspectorSha256: gate.inspectorSha256,
        applySha256: gate.applySha256,
        clientId: record.row.id,
        amoLeadId: String(record.candidateLeadId),
        resolution: record.resolution,
        errorClass: record.errorClass,
        sourceRowHash: sourceRowHash(record, attestationKey),
        amoSyncAttempts: record.row.amoSyncAttempts,
        amoSyncLastAttemptAt: optionalDateIso(
          record.row.amoSyncLastAttemptAt,
          "QUEUE_LAST_ATTEMPT_AT_INVALID",
        ),
        attemptsPreserved: true,
        lastAttemptPreserved: true,
        requeued: false,
        amoMutation: false,
      },
    },
  });
}

async function createCompletionAudit(transaction, plan, gate) {
  const links = plan.actionable
    .map((record) => ({
      clientId: String(record.row.id),
      amoLeadId: String(record.candidateLeadId),
    }))
    .sort((left, right) => left.clientId.localeCompare(right.clientId));
  await transaction.auditLog.create({
    data: {
      userId: null,
      action: COMPLETION_ACTION,
      entity: COMPLETION_ENTITY,
      entityId: completionEntityId(gate.sourceSha, gate.expectedCohortDigest),
      payload: {
        schemaVersion: 1,
        source: APPLY_AUDIT_SOURCE,
        sourceSha: gate.sourceSha,
        reviewedRunId: gate.reviewedRunId,
        cohortDigest: gate.expectedCohortDigest,
        inspectorSha256: gate.inspectorSha256,
        applySha256: gate.applySha256,
        queueRows: KNOWN_QUEUE_ROWS,
        linked: plan.actionable.length,
        blocked: plan.blocked.length,
        requeued: EXPECTED_REQUEUE_COUNT,
        amoMutations: 0,
        links,
      },
    },
  });
}

function assertSameCohort(beforeRows, currentRows, inspector) {
  if (
    beforeRows.length !== KNOWN_QUEUE_ROWS ||
    currentRows.length !== KNOWN_QUEUE_ROWS
  ) {
    fail("QUEUE_COHORT_COUNT_CHANGED");
  }
  const before = beforeRows.map((row) => rowSnapshot(row, inspector));
  const current = currentRows.map((row) => rowSnapshot(row, inspector));
  if (inspector.stableJson(before) !== inspector.stableJson(current)) {
    fail("QUEUE_DATABASE_STATE_DRIFT");
  }
}

async function assertLinkedDatabasePostconditions(
  transaction,
  actionable,
  inspector,
) {
  const ids = actionable.map((record) => record.row.id).sort();
  const rows = await transaction.client.findMany({
    where: { id: { in: ids } },
    select: CLIENT_SELECT,
    orderBy: { id: "asc" },
  });
  if (!Array.isArray(rows) || rows.length !== ids.length) {
    fail("FINAL_DATABASE_ROWS_MISSING");
  }
  const beforeById = new Map(
    actionable.map((record) => [String(record.row.id), record]),
  );
  for (const row of rows) {
    const before = beforeById.get(String(row.id));
    if (!before) fail("FINAL_DATABASE_ROW_UNEXPECTED");
    const storedLeadId = inspector.optionalStoredAmoLeadId(row.amoLeadId);
    if (
      storedLeadId !== before.candidateLeadId ||
      row.amoSyncStatus !== "SYNCED" ||
      row.amoSyncError !== null ||
      row.amoSyncAttempts !== before.row.amoSyncAttempts ||
      optionalDateIso(
        row.amoSyncLastAttemptAt,
        "QUEUE_LAST_ATTEMPT_AT_INVALID",
      ) !==
        optionalDateIso(
          before.row.amoSyncLastAttemptAt,
          "QUEUE_LAST_ATTEMPT_AT_INVALID",
        ) ||
      validDateIso(row.updatedAt, "QUEUE_UPDATED_AT_INVALID") !==
        validDateIso(before.row.updatedAt, "QUEUE_UPDATED_AT_INVALID") ||
      row.phone !== before.row.phone ||
      row.project !== before.row.project ||
      row.brokerId !== before.row.brokerId ||
      row.responsibleBrokerId !== before.row.responsibleBrokerId
    ) {
      fail("FINAL_DATABASE_POSTCONDITION_INVALID");
    }
  }
}

function assertFinalAmoEvidence(rows, amoEvidence, expectedLinks, inspector) {
  const expected = new Map(
    expectedLinks.map((link) => [
      String(link.clientId),
      Number(link.amoLeadId),
    ]),
  );
  for (const row of rows) {
    const expectedLeadId = expected.get(String(row.id));
    if (!expectedLeadId) continue;
    let inspected;
    try {
      inspected = inspector.inspectQueueRow(
        row,
        amoEvidence.byPhone,
        randomBytes(32),
      );
    } catch {
      fail("FINAL_AMO_EVIDENCE_INVALID");
    }
    if (
      inspected?.publicRecord?.exactClientContacts?.count !== 1 ||
      inspected?.publicRecord?.linkedLeadEvidence?.strong !== 1 ||
      inspected?.publicRecord?.linkedLeadEvidence?.weak !== 0 ||
      !Array.isArray(inspected?.strongRawIds) ||
      inspected.strongRawIds.length !== 1 ||
      inspected.strongRawIds[0] !== expectedLeadId
    ) {
      fail("FINAL_AMO_EVIDENCE_DRIFT");
    }
  }
}

async function tryCompletedNoop({ prisma, inspector, requestGet, gate }) {
  const initialLedger = await findRepairLedger(prisma, gate);
  if (
    initialLedger.completion.length === 0 &&
    initialLedger.rows.length === 0
  ) {
    return false;
  }
  const initialCompleted = validateCompletionLedger(initialLedger, gate);
  const clientIds = initialCompleted.links.map((link) => link.clientId).sort();
  const preLockRows = await prisma.client.findMany({
    where: { id: { in: clientIds } },
    select: CLIENT_SELECT,
    orderBy: { id: "asc" },
  });
  assertCompletedDatabaseState(preLockRows, initialCompleted, inspector);
  const evidence = await inspector.collectAmoEvidence(preLockRows, requestGet);
  assertFinalAmoEvidence(
    preLockRows,
    evidence,
    initialCompleted.links,
    inspector,
  );

  return prisma.$transaction(
    async (transaction) => {
      await acquireRepairAdvisoryLock(transaction, gate);
      await lockClientWriters(transaction);
      const ledger = await findRepairLedger(transaction, gate);
      const completed = validateCompletionLedger(ledger, gate);
      const rows = await transaction.client.findMany({
        where: {
          id: { in: completed.links.map((link) => link.clientId).sort() },
        },
        select: CLIENT_SELECT,
        orderBy: { id: "asc" },
      });
      assertSameCohort(preLockRows, rows, inspector);
      assertCompletedDatabaseState(rows, completed, inspector);
      assertFinalAmoEvidence(rows, evidence, completed.links, inspector);
      const expectedByClient = new Map(
        completed.links.map((link) => [link.clientId, link]),
      );
      const occupied = await transaction.client.findMany({
        where: {
          amoLeadId: {
            in: completed.links.map((link) => BigInt(link.amoLeadId)),
          },
        },
        select: { id: true, amoLeadId: true },
        orderBy: { id: "asc" },
      });
      if (
        occupied.length !== completed.links.length ||
        occupied.some((row) => {
          const expected = expectedByClient.get(String(row.id));
          return (
            !expected ||
            inspector.optionalStoredAmoLeadId(row.amoLeadId) !==
              expected.amoLeadId
          );
        })
      ) {
        fail("COMPLETED_CANDIDATE_OCCUPANCY_INVALID");
      }
      return true;
    },
    {
      isolationLevel: "Serializable",
      maxWait: LOCK_TIMEOUT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    },
  );
}

function assertCompletedDatabaseState(rows, completed, inspector) {
  if (!Array.isArray(rows) || rows.length !== completed.links.length) {
    fail("COMPLETED_DATABASE_ROWS_MISSING");
  }
  const expectedByClient = new Map(
    completed.links.map((link) => [link.clientId, link]),
  );
  for (const row of rows) {
    const expected = expectedByClient.get(String(row.id));
    const rowAudit = completed.rowByClient.get(String(row.id));
    if (
      !expected ||
      !rowAudit ||
      inspector.optionalStoredAmoLeadId(row.amoLeadId) !== expected.amoLeadId ||
      row.amoSyncStatus !== "SYNCED" ||
      row.amoSyncError !== null ||
      row.amoSyncAttempts !== rowAudit.amoSyncAttempts ||
      optionalDateIso(
        row.amoSyncLastAttemptAt,
        "QUEUE_LAST_ATTEMPT_AT_INVALID",
      ) !== rowAudit.amoSyncLastAttemptAt
    ) {
      fail("COMPLETED_DATABASE_POSTCONDITION_INVALID");
    }
  }
}

async function collectPreWriteScans({
  prisma,
  inspector,
  requestGet,
  gate,
  attestationKey,
}) {
  const metadata = {
    inspectorSha256: gate.inspectorSha256,
    deployedGitSha: gate.deployedGitSha,
  };
  let priorRows = null;
  let expectedIdentity = null;
  let finalScan = null;
  for (let scan = 1; scan <= 3; scan += 1) {
    activeFailurePhase =
      scan === 1
        ? FAILURE_PHASE.FIRST_SCAN
        : scan === 2
          ? FAILURE_PHASE.SECOND_SCAN
          : FAILURE_PHASE.FINAL_SCAN;
    const rows = await loadExactCohort(prisma, inspector);
    if (priorRows) assertSameCohort(priorRows, rows, inspector);
    const evidence = await inspector.collectAmoEvidence(rows, requestGet);
    const report = inspector.buildReport(
      rows,
      evidence,
      metadata,
      attestationKey,
      randomBytes(32),
    );
    assertReportMatchesGate(report, gate);
    const plan = buildExecutionPlan(rows, evidence, inspector);
    assertExactPlan(plan, gate);
    const identity = planIdentity(plan, inspector);
    if (expectedIdentity !== null && identity !== expectedIdentity) {
      fail("EXECUTION_PLAN_DRIFT_BETWEEN_SCANS");
    }
    expectedIdentity = identity;
    priorRows = rows;
    finalScan = { rows, evidence, plan, identity };
  }
  return finalScan;
}

async function executeFirstApply({
  prisma,
  Prisma,
  inspector,
  gate,
  attestationKey,
  lastPreLockRows,
  finalEvidence,
  expectedPlanIdentity,
}) {
  const metadata = {
    inspectorSha256: gate.inspectorSha256,
    deployedGitSha: gate.deployedGitSha,
  };
  return prisma.$transaction(
    async (transaction) => {
      activeFailurePhase = FAILURE_PHASE.TRANSACTION_LOCK;
      await acquireRepairAdvisoryLock(transaction, gate);
      await lockClientWriters(transaction);
      const ledger = await findRepairLedger(transaction, gate);
      if (ledger.completion.length !== 0 || ledger.rows.length !== 0) {
        fail("AUDIT_LEDGER_CHANGED_DURING_APPLY");
      }

      const lockedRows = await loadExactCohort(transaction, inspector);
      assertSameCohort(lastPreLockRows, lockedRows, inspector);
      const lockedReport = inspector.buildReport(
        lockedRows,
        finalEvidence,
        metadata,
        attestationKey,
        randomBytes(32),
      );
      assertReportMatchesGate(lockedReport, gate);
      const lockedPlan = buildExecutionPlan(
        lockedRows,
        finalEvidence,
        inspector,
      );
      assertExactPlan(lockedPlan, gate);
      if (planIdentity(lockedPlan, inspector) !== expectedPlanIdentity) {
        fail("EXECUTION_PLAN_DRIFT_BEFORE_COMMIT");
      }
      assertFinalAmoEvidence(
        lockedRows,
        finalEvidence,
        lockedPlan.actionable.map((record) => ({
          clientId: record.row.id,
          amoLeadId: record.candidateLeadId,
        })),
        inspector,
      );

      activeFailurePhase = FAILURE_PHASE.OCCUPANCY;
      await checkCandidateOccupancy(transaction, lockedPlan.actionable);

      activeFailurePhase = FAILURE_PHASE.DATABASE_CAS;
      for (const record of lockedPlan.actionable) {
        await casLinkClient(transaction, Prisma, record);
        activeFailurePhase = FAILURE_PHASE.AUDIT;
        await createRowAudit(transaction, record, gate, attestationKey);
        activeFailurePhase = FAILURE_PHASE.DATABASE_CAS;
      }

      await assertLinkedDatabasePostconditions(
        transaction,
        lockedPlan.actionable,
        inspector,
      );

      activeFailurePhase = FAILURE_PHASE.AUDIT;
      await createCompletionAudit(transaction, lockedPlan, gate);
      return { linked: lockedPlan.actionable.length };
    },
    {
      isolationLevel: "Serializable",
      maxWait: LOCK_TIMEOUT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    },
  );
}

async function main() {
  activeFailurePhase = FAILURE_PHASE.GATE;
  const gate = readExecutionGate();
  assertOwnSourceHash(gate.applySha256);
  const inspector = loadInspectorModule(undefined, gate.inspectorSha256);
  const attestationKey = readAttestationKey(
    process.env.BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE,
  );
  delete process.env.BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE;
  const { PrismaClient, Prisma } = require("@st-michael/database");
  const prisma = new PrismaClient({
    datasources: {
      db: { url: buildWriteDatabaseUrl(process.env.DATABASE_URL) },
    },
  });

  let summary = null;
  let failure = null;
  try {
    activeFailurePhase = FAILURE_PHASE.DATABASE;
    await assertProductionDatabase(prisma);
    activeFailurePhase = FAILURE_PHASE.ACCOUNT;
    const requestGet = inspector.createGetOnlyRequester(
      process.env.AMO_ACCESS_TOKEN,
    );
    await inspector.assertExpectedAccount(requestGet);

    activeFailurePhase = FAILURE_PHASE.IDEMPOTENCY;
    const alreadyCompleted = await tryCompletedNoop({
      prisma,
      inspector,
      requestGet,
      gate,
    });
    if (alreadyCompleted) {
      summary = {
        event: "lead_reconciliation_already_completed",
        schemaVersion: 1,
        sourceSha: gate.sourceSha,
        reviewedRunId: gate.reviewedRunId,
        queueRows: KNOWN_QUEUE_ROWS,
        linked: 0,
        alreadyLinked: gate.expectedCasCount,
        blocked: KNOWN_QUEUE_ROWS - gate.expectedCasCount,
        requeued: EXPECTED_REQUEUE_COUNT,
        amoMutations: 0,
      };
    } else {
      const finalScan = await collectPreWriteScans({
        prisma,
        inspector,
        requestGet,
        gate,
        attestationKey,
      });

      const result = await executeFirstApply({
        prisma,
        Prisma,
        inspector,
        gate,
        attestationKey,
        lastPreLockRows: finalScan.rows,
        finalEvidence: finalScan.evidence,
        expectedPlanIdentity: finalScan.identity,
      });
      summary = {
        event: "lead_reconciliation_completed",
        schemaVersion: 1,
        sourceSha: gate.sourceSha,
        reviewedRunId: gate.reviewedRunId,
        queueRows: KNOWN_QUEUE_ROWS,
        linked: result.linked,
        alreadyLinked: 0,
        blocked: KNOWN_QUEUE_ROWS - result.linked,
        requeued: EXPECTED_REQUEUE_COUNT,
        amoMutations: 0,
      };
    }
  } catch (error) {
    failure = error;
  }
  try {
    await prisma.$disconnect();
  } catch (disconnectError) {
    // Once Prisma has returned a committed transaction result, a later client
    // disconnect error must not turn the exact repair into an ambiguous retry.
    if (!summary && !failure) failure = disconnectError;
  }
  if (failure) throw failure;
  if (!summary) fail("COMPLETION_SUMMARY_MISSING");
  activeFailurePhase = FAILURE_PHASE.REPORT;
  writeSafeEvent(summary);
}

module.exports = {
  ADVISORY_LOCK_DOMAIN,
  APPLY_AUDIT_SOURCE,
  COMPLETION_ACTION,
  ERROR_CLASSES,
  EXACT_CONFIRMATION,
  EXPECTED_REQUEUE_COUNT,
  FAILURE_PHASE,
  KNOWN_QUEUE_ROWS,
  RESOLUTION_CLASSES,
  ROW_ACTION,
  TRANSACTION_TIMEOUT_MS,
  advisoryLockKey,
  assertExactPlan,
  assertFinalAmoEvidence,
  assertReportMatchesGate,
  assertSameCohort,
  buildExecutionPlan,
  buildWriteDatabaseUrl,
  casLinkClient,
  checkCandidateOccupancy,
  collectPreWriteScans,
  completionEntityId,
  executeFirstApply,
  findRepairLedger,
  formatFixedManifest,
  lockClientWriters,
  parseFixedManifest,
  planIdentity,
  readExecutionGate,
  reportManifest,
  rowSnapshot,
  safeFailureCode,
  tryCompletedNoop,
  validateCompletionLedger,
  writeSafeEvent,
};

if (require.main === module) {
  main().catch((error) => {
    try {
      writeSafeEvent({
        event: "lead_reconciliation_failed",
        schemaVersion: 1,
        failurePhase: activeFailurePhase,
        failureCode: safeFailureCode(error),
        queueRows: KNOWN_QUEUE_ROWS,
        linked: 0,
        alreadyLinked: 0,
        blocked: KNOWN_QUEUE_ROWS,
        requeued: EXPECTED_REQUEUE_COUNT,
        amoMutations: 0,
      });
    } catch {
      process.stdout.write(
        '{"event":"lead_reconciliation_failed","schemaVersion":1,"failurePhase":"REPORT","failureCode":"UNSAFE_REPORT_EVENT","queueRows":12,"linked":0,"alreadyLinked":0,"blocked":12,"requeued":0,"amoMutations":0}\n',
      );
    }
    process.exitCode = 1;
  });
}
