#!/usr/bin/env node
/**
 * Signed, one-shot recovery for the exact exhausted amoCRM fixation cohort.
 *
 * The unit of work is a normalized client phone, never an individual Client
 * row. All sibling rows are durably fenced before the first amoCRM POST, at
 * most one client contact and one lead are POSTed for a group, and every
 * sibling is linked to the same returned/reconciled lead in one transaction.
 */
"use strict";

const {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");
const { isAbsolute } = require("node:path");
const core = require("./amo-deadletter-group-recovery-core");
const planModule = require("./inspect-amo-deadletter-group-recovery-plan");
const legacyInspector = require("./inspect-amo-fixation-lead-reconciliation");

const EXACT_CONFIRMATION = "APPLY_AMO_DEADLETTER_GROUP_RECOVERY";
const EXPECTED_DATABASE_NAME = "broker_platform";
const STATEMENT_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 300_000;
const PHONE_LEASE_TTL_MS = 10 * 60_000;
const PHONE_LEASE_RENEW_MS = 30_000;
const PHONE_UNCERTAIN_TTL_MS = 24 * 60 * 60_000;
const RECONCILIATION_ATTEMPTS = 6;
const RECONCILIATION_DELAY_MS = 400;
const APPLY_SOURCE = "production_amo_deadletter_group_recovery";
const GATE_ENTITY = "AmoDeadletterGroupRecovery";
const BATCH_ENTITY = "AmoDeadletterGroupRecoveryBatch";
const AUDIT_ATTESTATION_DOMAIN = "st-michael:amo-deadletter-group-audit:v1";
const ACTIONS = Object.freeze({
  CLAIMED: "AMO_DEADLETTER_GROUP_CLAIMED",
  AGENCY_REPAIRED: "AMO_DEADLETTER_FIXATION_AGENCY_REPAIRED",
  CONTACT_ARMED: "AMO_DEADLETTER_CLIENT_CONTACT_POST_ARMED",
  CONTACT_RESOLVED: "AMO_DEADLETTER_CLIENT_CONTACT_POST_RESOLVED",
  LEAD_ARMED: "AMO_DEADLETTER_LEAD_POST_ARMED",
  LEAD_RESOLVED: "AMO_DEADLETTER_LEAD_POST_RESOLVED",
  GROUP_COMPLETED: "AMO_DEADLETTER_GROUP_COMPLETED",
  GROUP_AMBIGUOUS: "AMO_DEADLETTER_GROUP_AMBIGUOUS",
  MOREKIT_ARMED: "AMO_DEADLETTER_MOREKIT_POST_ARMED",
  MOREKIT_DELIVERED: "AMO_DEADLETTER_MOREKIT_POST_DELIVERED",
  MOREKIT_UNRESOLVED: "AMO_DEADLETTER_MOREKIT_POST_UNRESOLVED",
  MOREKIT_SKIPPED: "AMO_DEADLETTER_MOREKIT_POST_SKIPPED",
  BATCH_COMPLETED: "AMO_DEADLETTER_BATCH_COMPLETED",
});
const MANIFEST_KEYS = Object.freeze([
  "queueRows",
  "phoneGroups",
  "createGroups",
  "blockedGroups",
  "clientContactCreates",
  "agencyRepairs",
  "maxLeadPosts",
  "requeues",
]);
const FAILURE_PHASE = Object.freeze({
  GATE: "GATE",
  DATABASE: "DATABASE",
  ACCOUNT: "ACCOUNT",
  IDEMPOTENCY: "IDEMPOTENCY",
  FIRST_PLAN: "FIRST_PLAN",
  PHONE_LOCK: "PHONE_LOCK",
  SECOND_PLAN: "SECOND_PLAN",
  CLAIM: "CLAIM",
  CONTACT: "CONTACT",
  LEAD: "LEAD",
  DATABASE_LINK: "DATABASE_LINK",
  FINAL: "FINAL",
  REPORT: "REPORT",
});

let activeFailurePhase = FAILURE_PHASE.GATE;
let activeProgress = null;

class RecoveryFailure extends Error {
  constructor(code) {
    super("amo deadletter group recovery failed");
    this.name = "RecoveryFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new RecoveryFailure(code);
}

function safeFailureCode(error) {
  if (
    (error instanceof RecoveryFailure || error?.code) &&
    /^[A-Z][A-Z0-9_]{2,95}$/.test(String(error?.code || ""))
  ) {
    return error.code;
  }
  if (error?.code === "P2002") return "DATABASE_UNIQUE_CONSTRAINT";
  if (error?.code === "P2034") return "DATABASE_SERIALIZATION_CONFLICT";
  return "UNCLASSIFIED_FAILURE";
}

function writeSafeEvent(event) {
  const allowed = new Set([
    "event",
    "schemaVersion",
    "sourceSha",
    "reviewedRunId",
    "queueRows",
    "phoneGroups",
    "groupsCompleted",
    "groupsAmbiguous",
    "clientContactsCreated",
    "leadsCreatedOrReconciled",
    "morekitDelivered",
    "morekitUnresolved",
    "requeues",
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

function hashRegularFile(pathname, code) {
  let stat;
  try {
    stat = lstatSync(pathname);
  } catch {
    fail(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) fail(code);
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function boundedCount(value, label) {
  if (!/^(0|[1-9]\d{0,2})$/.test(String(value ?? ""))) {
    fail(`${label}_INVALID`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
    fail(`${label}_INVALID`);
  }
  return parsed;
}

function parseManifest(value) {
  const parts = String(value || "").split(",");
  if (parts.length !== MANIFEST_KEYS.length) fail("MANIFEST_INVALID");
  const output = {};
  for (let index = 0; index < MANIFEST_KEYS.length; index += 1) {
    const key = MANIFEST_KEYS[index];
    const match = parts[index].match(/^([a-zA-Z]+)=(0|[1-9]\d{0,2})$/);
    if (!match || match[1] !== key) fail("MANIFEST_ORDER_INVALID");
    output[key] = boundedCount(match[2], `MANIFEST_${key.toUpperCase()}`);
  }
  return output;
}

function readExecutionGate(env = process.env) {
  if (env.RECOVERY_CONFIRMATION !== EXACT_CONFIRMATION) {
    fail("CONFIRMATION_REQUIRED");
  }
  const sourceSha = String(env.RECOVERY_SOURCE_SHA || "");
  const confirmedSha = String(env.RECOVERY_CONFIRM_EXACT_SHA || "");
  const deployedGitSha = String(env.RECOVERY_DEPLOYED_GIT_SHA || "");
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail("SOURCE_SHA_INVALID");
  if (confirmedSha !== sourceSha) fail("SOURCE_SHA_CONFIRMATION_MISMATCH");
  if (deployedGitSha !== sourceSha) fail("DEPLOYED_SHA_MISMATCH");
  const reviewedRunId = String(env.RECOVERY_REVIEWED_PLAN_RUN_ID || "");
  if (!/^[1-9]\d{5,19}$/.test(reviewedRunId)) {
    fail("REVIEWED_PLAN_RUN_ID_INVALID");
  }
  const expectedDigest = String(env.RECOVERY_EXPECTED_COHORT_DIGEST || "");
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
    fail("EXPECTED_COHORT_DIGEST_INVALID");
  }
  const hashes = {
    coreSha256: String(env.RECOVERY_CORE_SHA256 || ""),
    planSha256: String(env.RECOVERY_PLAN_SHA256 || ""),
    legacyInspectorSha256: String(env.RECOVERY_LEGACY_INSPECTOR_SHA256 || ""),
    applySha256: String(env.RECOVERY_APPLY_SHA256 || ""),
  };
  for (const [name, value] of Object.entries(hashes)) {
    if (!/^[0-9a-f]{64}$/.test(value)) fail(`${name.toUpperCase()}_INVALID`);
  }
  const manifest = parseManifest(env.RECOVERY_EXPECTED_MANIFEST);
  if (
    manifest.queueRows !== core.EXPECTED_QUEUE_ROWS ||
    manifest.phoneGroups !== core.EXPECTED_PHONE_GROUPS ||
    manifest.createGroups !== core.EXPECTED_PHONE_GROUPS ||
    manifest.blockedGroups !== 0 ||
    manifest.maxLeadPosts !== manifest.createGroups ||
    manifest.clientContactCreates > manifest.createGroups ||
    manifest.agencyRepairs > manifest.queueRows ||
    manifest.requeues !== 0
  ) {
    fail("MANIFEST_NOT_FULLY_EXECUTABLE");
  }
  return {
    sourceSha,
    deployedGitSha,
    reviewedRunId,
    expectedDigest,
    manifest,
    manifestText: core.formatManifest(manifest),
    ...hashes,
  };
}

function assertSourceHashes(gate) {
  const paths = {
    coreSha256: require.resolve("./amo-deadletter-group-recovery-core"),
    planSha256: require.resolve("./inspect-amo-deadletter-group-recovery-plan"),
    legacyInspectorSha256:
      require.resolve("./inspect-amo-fixation-lead-reconciliation"),
    applySha256: __filename,
  };
  for (const [name, pathname] of Object.entries(paths)) {
    if (
      !isAbsolute(pathname) ||
      hashRegularFile(pathname, "SOURCE_FILE_UNSAFE") !== gate[name]
    ) {
      fail(`${name.toUpperCase()}_MISMATCH`);
    }
  }
}

function buildWriteDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    fail("DATABASE_URL_INVALID");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    fail("DATABASE_URL_NOT_POSTGRESQL");
  }
  const options = parsed.searchParams.getAll("options").filter(Boolean);
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
    rows?.length !== 1 ||
    rows[0]?.database_name !== EXPECTED_DATABASE_NAME ||
    rows[0]?.read_only !== "off"
  ) {
    fail("PRODUCTION_DATABASE_IDENTITY_MISMATCH");
  }
}

function assertPlanMatchesGate(plan, gate) {
  if (
    plan?.digest !== gate.expectedDigest ||
    plan?.manifestText !== gate.manifestText ||
    plan?.manifest?.queueRows !== core.EXPECTED_QUEUE_ROWS ||
    plan?.manifest?.phoneGroups !== core.EXPECTED_PHONE_GROUPS ||
    plan?.classifications?.length !== core.EXPECTED_PHONE_GROUPS ||
    plan.classifications.some((item) => item.resolution !== "create_one_lead")
  ) {
    fail("SIGNED_PLAN_GATE_MISMATCH");
  }
}

function metadataFor(gate) {
  return {
    sourceSha: gate.sourceSha,
    coreSha256: gate.coreSha256,
    planSha256: gate.planSha256,
    legacyInspectorSha256: gate.legacyInspectorSha256,
  };
}

function groupEntityId(phone, key) {
  return core.hmacDigest(
    "st-michael:amo-deadletter-group-gate-entity:v1",
    phone,
    key,
  );
}

function batchEntityId(gate, key) {
  return core.hmacDigest(
    "st-michael:amo-deadletter-group-batch-entity:v1",
    { sourceSha: gate.sourceSha, digest: gate.expectedDigest },
    key,
  );
}

function phaseId(operationId, phase, key) {
  return core.hmacDigest(
    "st-michael:amo-deadletter-group-phase:v1",
    { operationId, phase },
    key,
  );
}

function sourceRowHmac(row, key) {
  return core.hmacDigest(
    "st-michael:amo-deadletter-group-source-row:v1",
    core.rowSnapshot(row),
    key,
  );
}

function signedAuditPayload(payload, key) {
  const unsigned = { ...payload, schemaVersion: 2 };
  delete unsigned.auditAttestation;
  return {
    ...unsigned,
    auditAttestation: core.hmacDigest(AUDIT_ATTESTATION_DOMAIN, unsigned, key),
  };
}

function assertSignedAuditPayload(payload, key) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.schemaVersion !== 2 ||
    !/^[0-9a-f]{64}$/.test(String(payload.auditAttestation || ""))
  ) {
    fail("AUDIT_ATTESTATION_INVALID");
  }
  const unsigned = { ...payload };
  delete unsigned.auditAttestation;
  const expected = core.hmacDigest(AUDIT_ATTESTATION_DOMAIN, unsigned, key);
  if (
    !timingSafeEqual(
      Buffer.from(payload.auditAttestation, "hex"),
      Buffer.from(expected, "hex"),
    )
  ) {
    fail("AUDIT_ATTESTATION_INVALID");
  }
  return unsigned;
}

async function lockClientWriters(transaction) {
  // Must be the first statement: the Serializable snapshot is acquired only
  // after older Client writers have committed and new ones are excluded.
  await transaction.$executeRaw`LOCK TABLE clients IN SHARE ROW EXCLUSIVE MODE`;
  await transaction.$executeRaw`LOCK TABLE brokers, agencies, broker_agencies IN SHARE MODE`;
}

function expectedRowMap(plan) {
  return new Map(
    plan.classifications.flatMap((item) =>
      item.group.rows.map((row) => [String(row.id), core.rowSnapshot(row)]),
    ),
  );
}

function assertCurrentRows(currentRows, plan) {
  const expected = expectedRowMap(plan);
  if (currentRows.length !== core.EXPECTED_QUEUE_ROWS) fail("QUEUE_CAS_DRIFT");
  for (const row of currentRows) {
    const snapshot = expected.get(String(row.id));
    if (
      !snapshot ||
      core.stableJson(core.rowSnapshot(row)) !== core.stableJson(snapshot)
    ) {
      fail("QUEUE_CAS_DRIFT");
    }
  }
}

async function assertNoPriorGroupGates(prisma, plan, key) {
  const entityIds = plan.classifications.map((item) =>
    groupEntityId(item.group.normalizedPhone, key),
  );
  const prior = await prisma.auditLog.findMany({
    where: { entity: GATE_ENTITY, entityId: { in: entityIds } },
    select: { action: true, entityId: true, payload: true },
  });
  if (prior.length !== 0) fail("DURABLE_GROUP_GATE_ALREADY_PRESENT");
}

function createRedisClient() {
  const Redis = require("ioredis");
  const port = Number(process.env.REDIS_PORT || "6379");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail("REDIS_PORT_INVALID");
  }
  return new Redis({
    host: process.env.REDIS_HOST || "redis",
    port,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || "0"),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
}

const COMPARE_OWNER_EXPIRE = [
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, current = pcall(cjson.decode, raw)",
  "if not ok or current.owner ~= ARGV[1] then return 0 end",
  "return redis.call('PEXPIRE', KEYS[1], ARGV[2])",
].join("\n");
const COMPARE_OWNER_SET = [
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, current = pcall(cjson.decode, raw)",
  "if not ok or current.owner ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])",
  "return 1",
].join("\n");
const COMPARE_OWNER_DELETE = [
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, current = pcall(cjson.decode, raw)",
  "if not ok or current.owner ~= ARGV[1] then return 0 end",
  "return redis.call('DEL', KEYS[1])",
].join("\n");

async function acquirePhoneLeases(redis, classifications, phoneKey) {
  const { amoFixationPhoneLockRedisKey } = require("@st-michael/integrations");
  if (typeof amoFixationPhoneLockRedisKey !== "function") {
    fail("SHARED_PHONE_LOCK_CONTRACT_INVALID");
  }
  const owner = randomUUID();
  const leases = classifications
    .map((item) => ({
      phone: item.group.normalizedPhone,
      redisKey: amoFixationPhoneLockRedisKey(item.group.normalizedPhone),
      fingerprint: core.hmacDigest(
        "st-michael:amo-deadletter-group-redis-owner:v1",
        item.group.normalizedPhone,
        phoneKey,
      ),
    }))
    .sort((left, right) => left.redisKey.localeCompare(right.redisKey));
  const acquired = [];
  try {
    for (const lease of leases) {
      const result = await redis.set(
        lease.redisKey,
        JSON.stringify({
          fingerprint: lease.fingerprint,
          status: "processing",
          owner,
        }),
        "PX",
        PHONE_LEASE_TTL_MS,
        "NX",
      );
      if (result !== "OK") fail("PHONE_LOCK_BUSY");
      acquired.push(lease);
    }
  } catch (error) {
    for (const lease of acquired) {
      await redis
        .eval(COMPARE_OWNER_DELETE, 1, lease.redisKey, owner)
        .catch(() => 0);
    }
    throw error;
  }
  let stopped = false;
  let lost = false;
  let inFlight = Promise.resolve();
  const renew = async () => {
    try {
      const results = await Promise.all(
        leases.map((lease) =>
          redis.eval(
            COMPARE_OWNER_EXPIRE,
            1,
            lease.redisKey,
            owner,
            String(PHONE_LEASE_TTL_MS),
          ),
        ),
      );
      if (results.some((value) => Number(value) !== 1)) lost = true;
    } catch {
      lost = true;
    }
  };
  const timer = setInterval(() => {
    if (!stopped)
      inFlight = inFlight.then(renew, () => {
        lost = true;
      });
  }, PHONE_LEASE_RENEW_MS);
  timer.unref?.();
  return {
    leases,
    owner,
    async assertOwned() {
      // A local timer flag is insufficient: a key can be evicted/deleted one
      // millisecond after the previous 30-second renewal. Every mutation gate
      // performs this owner-checked Redis round trip immediately beforehand.
      await renew();
      if (lost) fail("PHONE_LOCK_OWNERSHIP_LOST");
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
    async release(successfulPhones = new Set()) {
      await this.stop();
      for (const lease of leases) {
        if (successfulPhones.has(lease.phone)) {
          await redis.eval(COMPARE_OWNER_DELETE, 1, lease.redisKey, owner);
        } else {
          const uncertain = JSON.stringify({
            fingerprint: lease.fingerprint,
            status: "uncertain",
            owner,
          });
          await redis.eval(
            COMPARE_OWNER_SET,
            1,
            lease.redisKey,
            owner,
            uncertain,
            String(PHONE_UNCERTAIN_TTL_MS),
          );
        }
      }
    },
  };
}

async function claimAllGroups({ prisma, Prisma, plan, gate, key, leases }) {
  const operationByPhone = new Map(
    plan.classifications.map((item) => [
      item.group.normalizedPhone,
      core.operationId(
        gate.sourceSha,
        gate.expectedDigest,
        item.group.normalizedPhone,
        key,
      ),
    ]),
  );
  await leases.assertOwned();
  await prisma.$transaction(
    async (tx) => {
      await lockClientWriters(tx);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${core.advisoryLockKey(
        gate.sourceSha,
        gate.expectedDigest,
      )})`;
      const currentRows = await planModule.loadExactQueue(tx);
      assertCurrentRows(currentRows, plan);
      const agencies = await planModule.loadAgencies(tx, currentRows);
      const currentById = new Map(
        currentRows.map((row) => [String(row.id), row]),
      );
      for (const item of plan.classifications) {
        await leases.assertOwned();
        const operationId = operationByPhone.get(item.group.normalizedPhone);
        const marker = `${core.RECOVERY_MARKER_PREFIX}${operationId}`;
        for (const proof of item.rowProofs) {
          const current = currentById.get(String(proof.row.id));
          const agency = core.resolveAgency(current, agencies);
          if (
            !agency.ok ||
            String(agency.agency.id) !== String(proof.agency.agency.id) ||
            agency.provenance !== proof.agency.provenance ||
            agency.repair !== proof.agency.repair ||
            core.dateIso(agency.agency.updatedAt) !==
              core.dateIso(proof.agency.agency.updatedAt)
          ) {
            fail("AGENCY_PROOF_DRIFT");
          }
          const updated = await tx.client.updateMany({
            where: {
              id: current.id,
              amoLeadId: null,
              amoSyncStatus: current.amoSyncStatus,
              amoSyncAttempts: current.amoSyncAttempts,
              amoSyncError: current.amoSyncError,
              updatedAt: current.updatedAt,
            },
            data: {
              fixationAgencyId: String(agency.agency.id),
              amoSyncStatus: "FAILED",
              amoSyncError: marker,
              amoSyncLastAttemptAt: new Date(),
            },
          });
          if (updated?.count !== 1) fail("CLIENT_CLAIM_CAS_MISSED");
          if (agency.repair) {
            await tx.auditLog.create({
              data: {
                userId: null,
                action: ACTIONS.AGENCY_REPAIRED,
                entity: "Client",
                entityId: String(current.id),
                payload: signedAuditPayload(
                  {
                    source: APPLY_SOURCE,
                    sourceSha: gate.sourceSha,
                    reviewedRunId: gate.reviewedRunId,
                    cohortDigest: gate.expectedDigest,
                    operationId,
                    agencyId: String(agency.agency.id),
                    provenance: agency.provenance,
                    sourceRowHmac: sourceRowHmac(proof.row, key),
                    piiStored: false,
                  },
                  key,
                ),
              },
            });
          }
        }
        await tx.auditLog.create({
          data: {
            userId: null,
            action: ACTIONS.CLAIMED,
            entity: GATE_ENTITY,
            entityId: groupEntityId(item.group.normalizedPhone, key),
            payload: signedAuditPayload(
              {
                source: APPLY_SOURCE,
                sourceSha: gate.sourceSha,
                reviewedRunId: gate.reviewedRunId,
                cohortDigest: gate.expectedDigest,
                operationId,
                queueRows: item.group.rows.length,
                automaticRetryBlocked: true,
                requeued: false,
                piiStored: false,
              },
              key,
            ),
          },
        });
      }
    },
    {
      isolationLevel: "Serializable",
      maxWait: LOCK_TIMEOUT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    },
  );
  return operationByPhone;
}

async function recordGate(
  prisma,
  item,
  key,
  gate,
  operationId,
  action,
  payload,
) {
  await prisma.auditLog.create({
    data: {
      userId: null,
      action,
      entity: GATE_ENTITY,
      entityId: groupEntityId(item.group.normalizedPhone, key),
      payload: signedAuditPayload(
        {
          source: APPLY_SOURCE,
          sourceSha: gate.sourceSha,
          reviewedRunId: gate.reviewedRunId,
          cohortDigest: gate.expectedDigest,
          operationId,
          ...payload,
          piiStored: false,
        },
        key,
      ),
    },
  });
}

function fixationContactPayload(row) {
  return {
    clientPhone: row.phone,
    clientEmail: row.email || undefined,
    clientName: row.fullName,
    clientRegion: row.clientRegion || undefined,
  };
}

function lostContactResponseMatches({
  contact,
  row,
  normalizedPhone,
  armedAt,
}) {
  const createdAt = Number(contact?.created_at) * 1000;
  const expectedName = String(row?.fullName || "")
    .normalize("NFKC")
    .trim();
  const actualName = String(contact?.name || "")
    .normalize("NFKC")
    .trim();
  const expectedEmail = String(row?.email || "")
    .trim()
    .toLowerCase();
  const emailMatches =
    !expectedEmail ||
    planModule.contactFieldValues(contact, 557905).some(
      (entry) =>
        String(entry?.value || "")
          .trim()
          .toLowerCase() === expectedEmail,
    );
  const expectedRegion = String(row?.clientRegion || "")
    .normalize("NFKC")
    .trim();
  const regionMatches =
    !expectedRegion ||
    planModule.contactFieldValues(contact, 589265).some(
      (entry) =>
        String(entry?.value || "")
          .normalize("NFKC")
          .trim() === expectedRegion,
    );
  return Boolean(
    planModule.contactPhoneMatches(contact, normalizedPhone) &&
    !planModule.contactHasBrokerFlag(contact) &&
    expectedName &&
    actualName === expectedName &&
    emailMatches &&
    regionMatches &&
    Number.isSafeInteger(createdAt) &&
    createdAt >= armedAt.getTime() - 2 * 60_000 &&
    createdAt <= Date.now() + 2 * 60_000,
  );
}

function immutableClaimSource(row) {
  const snapshot = core.rowSnapshot(row);
  for (const key of [
    "updatedAt",
    "fixationAgencyId",
    "amoSyncStatus",
    "amoSyncLastAttemptAt",
    "amoSyncError",
  ]) {
    delete snapshot[key];
  }
  return snapshot;
}

async function revalidateClaimedGroup({
  prisma,
  requestGet,
  item,
  operationId,
  expectedClientContactId,
}) {
  const ids = item.group.rows.map((row) => String(row.id)).sort();
  const currentRows = await prisma.client.findMany({
    where: { id: { in: ids } },
    select: planModule.QUEUE_SELECT,
    orderBy: { id: "asc" },
  });
  const expectedById = new Map(
    item.group.rows.map((row) => [String(row.id), row]),
  );
  const proofById = new Map(
    item.rowProofs.map((proof) => [String(proof.row.id), proof]),
  );
  const marker = `${core.RECOVERY_MARKER_PREFIX}${operationId}`;
  if (currentRows.length !== ids.length) fail("CLAIMED_GROUP_ROWS_MISSING");
  for (const current of currentRows) {
    const original = expectedById.get(String(current.id));
    const proof = proofById.get(String(current.id));
    if (
      !original ||
      !proof ||
      current.amoLeadId !== null ||
      current.amoSyncStatus !== "FAILED" ||
      current.amoSyncAttempts < core.ATTEMPT_LIMIT ||
      current.amoSyncError !== marker ||
      String(current.fixationAgencyId || "") !==
        String(proof.agency.agency.id) ||
      core.stableJson(immutableClaimSource(current)) !==
        core.stableJson(immutableClaimSource(original))
    ) {
      fail("CLAIMED_GROUP_DATABASE_DRIFT");
    }
  }
  const agencyIds = [
    ...new Set(item.rowProofs.map((proof) => String(proof.agency.agency.id))),
  ];
  const agencies = await prisma.agency.findMany({
    where: { id: { in: agencyIds } },
    select: { id: true, name: true, inn: true, updatedAt: true },
  });
  const agencyById = new Map(
    agencies.map((agency) => [String(agency.id), agency]),
  );
  for (const proof of item.rowProofs) {
    const expected = proof.agency.agency;
    const current = agencyById.get(String(expected.id));
    if (
      !current ||
      current.name !== expected.name ||
      current.inn !== expected.inn ||
      core.dateIso(current.updatedAt) !== core.dateIso(expected.updatedAt)
    ) {
      fail("CLAIMED_GROUP_AGENCY_DRIFT");
    }
  }
  const brokerEvidence = await planModule.collectBrokerEvidence(
    prisma,
    currentRows,
    requestGet,
  );
  for (const proof of item.rowProofs) {
    const current = brokerEvidence.get(proof.broker.brokerId);
    if (
      !current ||
      current.contactId !== proof.broker.contactId ||
      current.exactPhone !== true ||
      current.brokerFlag !== true ||
      current.occupiedByOtherBroker === true
    ) {
      fail("CLAIMED_GROUP_BROKER_CONTACT_DRIFT");
    }
  }
  const evidence = await collectGroupEvidence(item, requestGet);
  const expectedContactIds = expectedClientContactId
    ? [expectedClientContactId]
    : [];
  if (
    core.stableJson(evidence.exactContactIds) !==
      core.stableJson(expectedContactIds) ||
    !sameLeadEvidence(evidence, {
      exactContactIds: expectedContactIds,
      leads: item.evidence.leads,
    })
  ) {
    fail("CLAIMED_GROUP_CLIENT_EVIDENCE_DRIFT");
  }
  if (expectedClientContactId) {
    const [contact, owners] = await Promise.all([
      requestGet(`/api/v4/contacts/${expectedClientContactId}`),
      prisma.broker.findMany({
        where: { amoContactId: BigInt(expectedClientContactId) },
        select: { id: true },
        take: 1,
      }),
    ]);
    if (
      !planModule.contactPhoneMatches(contact, item.group.normalizedPhone) ||
      planModule.contactHasBrokerFlag(contact) ||
      owners.length !== 0
    ) {
      fail("CLAIMED_GROUP_CLIENT_ROLE_COLLISION");
    }
  }
  return { currentRows, evidence };
}

async function collectGroupEvidence(item, requestGet) {
  const result = await legacyInspector.collectAmoEvidence(
    item.group.rows,
    requestGet,
  );
  return (
    result.byPhone.get(item.group.normalizedPhone) || {
      exactContactIds: [],
      leads: [],
    }
  );
}

async function pollEvidence(item, requestGet, accept) {
  for (let attempt = 1; attempt <= RECONCILIATION_ATTEMPTS; attempt += 1) {
    const evidence = await collectGroupEvidence(item, requestGet);
    const accepted = accept(evidence);
    if (accepted) return { evidence, accepted };
    if (attempt < RECONCILIATION_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, RECONCILIATION_DELAY_MS * 2 ** (attempt - 1)),
      );
    }
  }
  return null;
}

async function resolveClientContact({
  prisma,
  adapter,
  requestGet,
  item,
  key,
  gate,
  operationId,
  leases,
  revalidate = revalidateClaimedGroup,
}) {
  if (item.clientContactId)
    return { contactId: item.clientContactId, created: false };
  await revalidate({
    prisma,
    requestGet,
    item,
    operationId,
    expectedClientContactId: null,
  });
  const phase = phaseId(operationId, "client_contact_post", key);
  await recordGate(
    prisma,
    item,
    key,
    gate,
    operationId,
    ACTIONS.CONTACT_ARMED,
    {
      phaseId: phase,
      automaticRetryBlocked: true,
      postLimit: 1,
    },
  );
  let responseId = null;
  const armedAt = new Date();
  // The first scan justified arming. Repeat every DB/amo proof after that
  // durable marker, then verify the Redis owner again, so neither a manual
  // amo edit nor a DB merge in the intervening audit write can reach POST.
  await leases.assertOwned();
  await revalidate({
    prisma,
    requestGet,
    item,
    operationId,
    expectedClientContactId: null,
  });
  await leases.assertOwned();
  try {
    const created = await adapter.createFixationClientContactOnce(
      fixationContactPayload(item.leader.row),
    );
    responseId = core.positiveInteger(created?.id);
  } catch {
    // A request can have been accepted while its response was lost. The only
    // permitted next operation is exhaustive GET reconciliation below.
  }
  const reconciled = await pollEvidence(item, requestGet, (evidence) => {
    if (evidence.exactContactIds.length !== 1 || evidence.leads.length !== 0) {
      return null;
    }
    const id = core.positiveInteger(evidence.exactContactIds[0]);
    if (!id || (responseId && responseId !== id)) return null;
    return id;
  });
  if (!reconciled) fail("CLIENT_CONTACT_POST_UNRESOLVED");
  const contactId = core.positiveInteger(reconciled.accepted);
  if (!responseId) {
    const contact = await requestGet(`/api/v4/contacts/${contactId}`, {
      with: "leads",
    });
    if (
      !lostContactResponseMatches({
        contact,
        row: item.leader.row,
        normalizedPhone: item.group.normalizedPhone,
        armedAt,
      })
    ) {
      fail("CLIENT_CONTACT_LOST_RESPONSE_NOT_PROVEN");
    }
  }
  await recordGate(
    prisma,
    item,
    key,
    gate,
    operationId,
    ACTIONS.CONTACT_RESOLVED,
    {
      phaseId: phase,
      contactId: String(contactId),
      responseMatched: responseId === contactId,
      automaticRetryBlocked: false,
    },
  );
  return { contactId, created: true };
}

function sameLeadEvidence(left, right) {
  const reduce = (evidence) => ({
    exactContactIds: [...(evidence.exactContactIds || [])].sort(
      (a, b) => a - b,
    ),
    leads: [...(evidence.leads || [])]
      .map((lead) => ({
        leadId: core.positiveInteger(lead.leadId),
        pipelineId: core.positiveInteger(lead.pipelineId),
        statusId: core.positiveInteger(lead.statusId),
        contactIds: [...(lead.contactIds || [])].sort((a, b) => a - b),
        createdAt: lead.createdAt ?? null,
        sourceMarker: lead.sourceMarker === true,
        requestValues: [...(lead.requestValues || [])],
        projectValues: [...(lead.projectValues || [])],
      }))
      .sort((a, b) => Number(a.leadId) - Number(b.leadId)),
  });
  return core.stableJson(reduce(left)) === core.stableJson(reduce(right));
}

function candidateLeadFromEvidence({
  evidence,
  beforeLeadIds,
  responseLeadId,
  clientContactId,
  brokerContactIds,
  armedAt,
  project,
}) {
  if (
    evidence.exactContactIds.length !== 1 ||
    evidence.exactContactIds[0] !== clientContactId
  ) {
    return null;
  }
  const earliest = armedAt.getTime() - 2 * 60_000;
  const latest = Date.now() + 2 * 60_000;
  const expectedProject = {
    ZORGE9: "Зорге 9",
    SILVER_BOR: "Берзарина 37",
  }[String(project)];
  const expectedContacts = [clientContactId, ...brokerContactIds].sort(
    (left, right) => left - right,
  );
  const candidates = evidence.leads.filter((lead) => {
    const leadId = core.positiveInteger(lead.leadId);
    const createdAt = Number(lead.createdAt) * 1000;
    const requestTimestamp = Number(lead.requestValues?.[0]) * 1000;
    const completePostPatchEvidence =
      lead.sourceMarker === true &&
      Array.isArray(lead.requestValues) &&
      lead.requestValues.length === 1 &&
      Number.isSafeInteger(requestTimestamp) &&
      requestTimestamp >= earliest &&
      requestTimestamp <= latest &&
      Array.isArray(lead.projectValues) &&
      lead.projectValues.length === 1 &&
      String(lead.projectValues[0]).normalize("NFKC").trim() ===
        expectedProject;
    const responseLostBeforePostPatches =
      !responseLeadId &&
      lead.sourceMarker === false &&
      Array.isArray(lead.requestValues) &&
      lead.requestValues.length === 0 &&
      Array.isArray(lead.projectValues) &&
      lead.projectValues.length === 0;
    return (
      leadId &&
      !beforeLeadIds.has(leadId) &&
      Number(lead.pipelineId) === 7600542 &&
      Number.isSafeInteger(createdAt) &&
      createdAt >= earliest &&
      createdAt <= latest &&
      (responseLeadId ||
        completePostPatchEvidence ||
        responseLostBeforePostPatches) &&
      core.stableJson([...lead.contactIds].sort((a, b) => a - b)) ===
        core.stableJson(expectedContacts)
    );
  });
  if (candidates.length !== 1) return null;
  const id = core.positiveInteger(candidates[0].leadId);
  if (responseLeadId && responseLeadId !== id) return null;
  return id;
}

function expectedFixationLeadName(item) {
  const row = item.leader.row;
  return `Фиксация: ${row.fullName} (${row.project})`;
}

function fixationLeadPayload(item, clientContactId) {
  const leader = item.leader;
  const row = leader.row;
  const agency = leader.agency.agency;
  const amount =
    row.amount === null || row.amount === undefined
      ? undefined
      : Number(row.amount);
  const sqm =
    row.sqm === null || row.sqm === undefined ? undefined : Number(row.sqm);
  return {
    clientPhone: row.phone,
    clientEmail: row.email || undefined,
    clientName: row.fullName,
    clientRegion: row.clientRegion || undefined,
    brokerPhone: core.effectiveBroker(row).phone,
    brokerAmoContactId: leader.broker.contactId,
    additionalBrokerAmoContactIds: item.brokerContactIds.filter(
      (id) => id !== leader.broker.contactId,
    ),
    existingClientAmoContactId: clientContactId,
    agencyName: agency.name,
    agencyInn: agency.inn,
    comment: row.comment || "",
    project: row.project,
    propertyType: row.propertyType || undefined,
    roomsCount: row.roomsCount || undefined,
    amount: Number.isFinite(amount) ? amount : undefined,
    sqm: Number.isFinite(sqm) ? sqm : undefined,
    purchaseTiming: row.purchaseTiming || undefined,
    readinessLevel: row.readinessLevel || undefined,
    fromBroker: true,
  };
}

async function createOrReconcileLead({
  prisma,
  adapter,
  requestGet,
  item,
  key,
  gate,
  operationId,
  clientContactId,
  leases,
  revalidate = revalidateClaimedGroup,
  collectEvidence = collectGroupEvidence,
}) {
  await revalidate({
    prisma,
    requestGet,
    item,
    operationId,
    expectedClientContactId: clientContactId,
  });
  const before = await collectEvidence(item, requestGet);
  const expectedBefore = {
    exactContactIds: [clientContactId],
    leads: item.evidence.leads,
  };
  if (!sameLeadEvidence(before, expectedBefore))
    fail("AMO_PRE_LEAD_EVIDENCE_DRIFT");
  if (
    before.leads.some(
      (lead) => !core.FINAL_AMO_STATUSES.has(Number(lead.statusId)),
    )
  ) {
    fail("CURRENT_LEAD_PRESENT");
  }
  const beforeLeadIds = new Set(
    before.leads.map((lead) => Number(lead.leadId)),
  );
  const phase = phaseId(operationId, "lead_post", key);
  const armedAt = new Date();
  await recordGate(prisma, item, key, gate, operationId, ACTIONS.LEAD_ARMED, {
    phaseId: phase,
    armedAt: armedAt.toISOString(),
    automaticRetryBlocked: true,
    postLimit: 1,
    brokerContactCount: item.brokerContactIds.length,
  });
  let responseLeadId = null;
  // Re-run the full signed row/broker/agency/client evidence after the
  // durable LEAD_ARMED audit. A final owner round trip is deliberately the
  // last awaited operation before the unique lead POST.
  await leases.assertOwned();
  await revalidate({
    prisma,
    requestGet,
    item,
    operationId,
    expectedClientContactId: clientContactId,
  });
  await leases.assertOwned();
  try {
    const lead = await adapter.createFixationRequest(
      fixationLeadPayload(item, clientContactId),
    );
    responseLeadId = core.positiveInteger(lead?.id);
  } catch {
    // Never call createFixationRequest again. An exact new-lead GET scan is the
    // only recovery path for a lost response.
  }
  const reconciled = await pollEvidence(item, requestGet, (evidence) =>
    candidateLeadFromEvidence({
      evidence,
      beforeLeadIds,
      responseLeadId,
      clientContactId,
      brokerContactIds: item.brokerContactIds,
      armedAt,
      project: item.leader.row.project,
    }),
  );
  if (!reconciled) fail("LEAD_POST_UNRESOLVED");
  const leadId = core.positiveInteger(reconciled.accepted);
  const hydratedLead = await requestGet(`/api/v4/leads/${leadId}`, {
    with: "contacts",
  });
  if (
    core.positiveInteger(hydratedLead?.id) !== leadId ||
    String(hydratedLead?.name || "")
      .normalize("NFKC")
      .trim() !== expectedFixationLeadName(item).normalize("NFKC").trim()
  ) {
    fail("LEAD_INITIAL_POST_IDENTITY_NOT_PROVEN");
  }
  await recordGate(
    prisma,
    item,
    key,
    gate,
    operationId,
    ACTIONS.LEAD_RESOLVED,
    {
      phaseId: phase,
      leadId: String(leadId),
      responseMatched: responseLeadId === leadId,
      automaticRetryBlocked: false,
    },
  );
  return leadId;
}

async function linkSiblingRows({
  prisma,
  item,
  key,
  gate,
  operationId,
  leadId,
  leases,
}) {
  const marker = `${core.RECOVERY_MARKER_PREFIX}${operationId}`;
  const ids = item.group.rows.map((row) => String(row.id)).sort();
  await leases.assertOwned();
  await prisma.$transaction(
    async (tx) => {
      await lockClientWriters(tx);
      const rows = await tx.client.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          amoLeadId: true,
          amoSyncStatus: true,
          amoSyncAttempts: true,
          amoSyncError: true,
        },
        orderBy: { id: "asc" },
      });
      if (
        rows.length !== ids.length ||
        rows.some(
          (row) =>
            row.amoLeadId !== null ||
            row.amoSyncStatus !== "FAILED" ||
            row.amoSyncAttempts < core.ATTEMPT_LIMIT ||
            row.amoSyncError !== marker,
        )
      ) {
        fail("SIBLING_LINK_CAS_DRIFT");
      }
      const occupied = await tx.client.findMany({
        where: { amoLeadId: BigInt(leadId), id: { notIn: ids } },
        select: { id: true },
        take: 1,
      });
      if (occupied.length !== 0) fail("LEAD_ALREADY_OCCUPIED_BY_OTHER_PHONE");
      const updated = await tx.client.updateMany({
        where: {
          id: { in: ids },
          amoLeadId: null,
          amoSyncStatus: "FAILED",
          amoSyncAttempts: { gte: core.ATTEMPT_LIMIT },
          amoSyncError: marker,
        },
        data: {
          amoLeadId: BigInt(leadId),
          amoSyncStatus: "SYNCED",
          amoSyncError: null,
        },
      });
      if (updated?.count !== ids.length) fail("SIBLING_LINK_CAS_MISSED");
      for (const id of ids) {
        await tx.auditLog.create({
          data: {
            userId: null,
            action: "AMO_DEADLETTER_CLIENT_LINKED",
            entity: "Client",
            entityId: id,
            payload: signedAuditPayload(
              {
                source: APPLY_SOURCE,
                sourceSha: gate.sourceSha,
                reviewedRunId: gate.reviewedRunId,
                cohortDigest: gate.expectedDigest,
                operationId,
                leadId: String(leadId),
                siblingCount: ids.length,
                attemptsReset: false,
                requeued: false,
                piiStored: false,
              },
              key,
            ),
          },
        });
      }
      await tx.auditLog.create({
        data: {
          userId: null,
          action: ACTIONS.GROUP_COMPLETED,
          entity: GATE_ENTITY,
          entityId: groupEntityId(item.group.normalizedPhone, key),
          payload: signedAuditPayload(
            {
              source: APPLY_SOURCE,
              sourceSha: gate.sourceSha,
              reviewedRunId: gate.reviewedRunId,
              cohortDigest: gate.expectedDigest,
              operationId,
              leadId: String(leadId),
              clientIds: ids,
              queueRows: ids.length,
              maxLeadPosts: 1,
              requeued: false,
              piiStored: false,
            },
            key,
          ),
        },
      });
    },
    {
      isolationLevel: "Serializable",
      maxWait: LOCK_TIMEOUT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    },
  );
}

async function recordAmbiguous(prisma, item, key, gate, operationId, code) {
  await recordGate(
    prisma,
    item,
    key,
    gate,
    operationId,
    ACTIONS.GROUP_AMBIGUOUS,
    {
      failureCode: String(code)
        .replace(/[^A-Z0-9_]/g, "_")
        .slice(0, 96),
      automaticRetryBlocked: true,
    },
  );
}

function buildMorekitPayload(item, leadId, integrations, now = new Date()) {
  const row = item.leader.row;
  const broker = core.effectiveBroker(row);
  const agency = item.leader.agency.agency;
  return {
    id: String(leadId),
    agency: agency.name,
    broker_id: String(item.leader.broker.contactId),
    agent_name: broker.fullName,
    agent_phone: integrations.morekitPhone(broker.phone),
    agent_mail: broker.email || "",
    budget: row.amount ? String(row.amount) : "0",
    clients: [
      { name: row.fullName, phone: integrations.morekitPhone(row.phone) },
    ],
    type: row.propertyType || "Квартира",
    lead_date: integrations.morekitLeadDate(now),
    project: integrations.morekitProjectName(String(row.project)),
  };
}

async function loadMorekitUrl(prisma) {
  const row = await prisma.systemSetting.findUnique({
    where: { key: "MOREKIT_WEBHOOK_URL" },
    select: { value: true },
  });
  const raw = String(
    row?.value || process.env.MOREKIT_WEBHOOK_URL || "",
  ).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return null;
  }
  return parsed.toString();
}

async function notifyMorekitOnce({
  prisma,
  item,
  key,
  gate,
  operationId,
  leadId,
  integrations,
}) {
  let url;
  try {
    url = await loadMorekitUrl(prisma);
  } catch {
    url = null;
  }
  if (!url) {
    await recordGate(
      prisma,
      item,
      key,
      gate,
      operationId,
      ACTIONS.MOREKIT_SKIPPED,
      {
        leadId: String(leadId),
        reason: "URL_NOT_CONFIGURED_OR_INVALID",
        automaticRetryAuthorized: false,
        followupRequired: true,
      },
    );
    return "skipped";
  }
  const phase = phaseId(operationId, "morekit_post", key);
  await recordGate(
    prisma,
    item,
    key,
    gate,
    operationId,
    ACTIONS.MOREKIT_ARMED,
    {
      phaseId: phase,
      leadId: String(leadId),
      automaticRetryBlocked: true,
      postLimit: 1,
    },
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7_000);
  let delivered = false;
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "st-michael-broker-platform/1.0",
      },
      body: JSON.stringify(buildMorekitPayload(item, leadId, integrations)),
    });
    delivered = response?.ok === true;
    try {
      await response?.body?.cancel?.();
    } catch {
      // Response bodies are never logged or interpreted.
    }
  } catch {
    delivered = false;
  } finally {
    clearTimeout(timer);
  }
  await recordGate(
    prisma,
    item,
    key,
    gate,
    operationId,
    delivered ? ACTIONS.MOREKIT_DELIVERED : ACTIONS.MOREKIT_UNRESOLVED,
    {
      phaseId: phase,
      leadId: String(leadId),
      automaticRetryBlocked: !delivered,
      followupRequired: !delivered,
    },
  );
  return delivered ? "delivered" : "unresolved";
}

function assertCompletionGroups(groups) {
  if (!Array.isArray(groups) || groups.length !== core.EXPECTED_PHONE_GROUPS) {
    fail("BATCH_INCOMPLETE");
  }
  for (const group of groups) {
    if (
      !group ||
      typeof group !== "object" ||
      !/^[0-9a-f]{64}$/.test(String(group.entityId || "")) ||
      !core.positiveInteger(group.leadId) ||
      !Array.isArray(group.clientIds) ||
      group.clientIds.length < 1 ||
      group.clientIds.some(
        (id) => typeof id !== "string" || !id || id.length > 128,
      ) ||
      new Set(group.clientIds).size !== group.clientIds.length ||
      !["delivered", "unresolved", "skipped"].includes(group.morekitStatus)
    ) {
      fail("BATCH_COMPLETION_GROUP_INVALID");
    }
  }
  if (new Set(groups.map((group) => group.entityId)).size !== groups.length) {
    fail("BATCH_LEDGER_GROUP_DUPLICATE");
  }
  if (
    new Set(groups.map((group) => String(group.leadId))).size !== groups.length
  ) {
    fail("BATCH_LEDGER_LEAD_DUPLICATE");
  }
  const links = groups.flatMap((group) =>
    group.clientIds.map((id) => ({ id, leadId: String(group.leadId) })),
  );
  if (links.length !== core.EXPECTED_QUEUE_ROWS) {
    fail("BATCH_LEDGER_ROW_COUNT_INVALID");
  }
  if (new Set(links.map((item) => item.id)).size !== links.length) {
    fail("BATCH_LEDGER_CLIENT_DUPLICATE");
  }
  return links;
}

async function recordBatchCompletion(prisma, gate, key, completed) {
  assertCompletionGroups(completed);
  await prisma.auditLog.create({
    data: {
      userId: null,
      action: ACTIONS.BATCH_COMPLETED,
      entity: BATCH_ENTITY,
      entityId: batchEntityId(gate, key),
      payload: signedAuditPayload(
        {
          source: APPLY_SOURCE,
          sourceSha: gate.sourceSha,
          reviewedRunId: gate.reviewedRunId,
          cohortDigest: gate.expectedDigest,
          manifest: gate.manifestText,
          queueRows: core.EXPECTED_QUEUE_ROWS,
          phoneGroups: core.EXPECTED_PHONE_GROUPS,
          groups: completed
            .map((item) => ({
              entityId: item.entityId,
              leadId: String(item.leadId),
              clientIds: [...item.clientIds].sort(),
              morekitStatus: item.morekitStatus,
            }))
            .sort((a, b) => a.entityId.localeCompare(b.entityId)),
          requeued: false,
          piiStored: false,
        },
        key,
      ),
    },
  });
}

async function tryCompletedNoop(prisma, gate, key) {
  const entityId = batchEntityId(gate, key);
  const audits = await prisma.auditLog.findMany({
    where: { action: ACTIONS.BATCH_COMPLETED, entity: BATCH_ENTITY, entityId },
    select: { payload: true },
  });
  if (audits.length === 0) return false;
  if (audits.length !== 1) fail("BATCH_COMPLETION_AUDIT_AMBIGUOUS");
  const payload = assertSignedAuditPayload(audits[0].payload, key);
  if (
    payload?.schemaVersion !== 2 ||
    payload?.source !== APPLY_SOURCE ||
    payload?.sourceSha !== gate.sourceSha ||
    payload?.reviewedRunId !== gate.reviewedRunId ||
    payload?.cohortDigest !== gate.expectedDigest ||
    payload?.manifest !== gate.manifestText ||
    payload?.queueRows !== core.EXPECTED_QUEUE_ROWS ||
    payload?.phoneGroups !== core.EXPECTED_PHONE_GROUPS ||
    payload?.requeued !== false ||
    payload?.piiStored !== false ||
    !Array.isArray(payload?.groups) ||
    payload.groups.length !== core.EXPECTED_PHONE_GROUPS
  ) {
    fail("BATCH_COMPLETION_AUDIT_INVALID");
  }
  const links = assertCompletionGroups(payload.groups);
  const rows = await prisma.client.findMany({
    where: { id: { in: links.map((item) => item.id) } },
    select: {
      id: true,
      amoLeadId: true,
      amoSyncStatus: true,
      amoSyncError: true,
    },
  });
  const expected = new Map(links.map((item) => [String(item.id), item.leadId]));
  if (
    rows.length !== links.length ||
    rows.some(
      (row) =>
        String(row.amoLeadId || "") !== expected.get(String(row.id)) ||
        row.amoSyncStatus !== "SYNCED" ||
        row.amoSyncError !== null,
    )
  ) {
    fail("BATCH_COMPLETION_DATABASE_DRIFT");
  }
  return {
    morekitDelivered: payload.groups.filter(
      (group) => group.morekitStatus === "delivered",
    ).length,
    morekitUnresolved: payload.groups.filter(
      (group) => group.morekitStatus !== "delivered",
    ).length,
  };
}

async function main() {
  const gate = readExecutionGate();
  assertSourceHashes(gate);
  const key = planModule.readSecretFile(
    process.env.RECOVERY_COHORT_ATTESTATION_KEY_FILE,
  );
  const { PrismaClient, Prisma } = require("@st-michael/database");
  const prisma = new PrismaClient({
    datasources: {
      db: { url: buildWriteDatabaseUrl(process.env.DATABASE_URL) },
    },
  });
  const redis = createRedisClient();
  let leases = null;
  let durableClaimCommitted = false;
  const successfulPhones = new Set();
  const summary = {
    groupsCompleted: 0,
    groupsAmbiguous: 0,
    clientContactsCreated: 0,
    leadsCreatedOrReconciled: 0,
    morekitDelivered: 0,
    morekitUnresolved: 0,
  };
  activeProgress = summary;
  try {
    activeFailurePhase = FAILURE_PHASE.DATABASE;
    await assertProductionDatabase(prisma);
    await redis.connect();
    if (String(await redis.ping()).toUpperCase() !== "PONG")
      fail("REDIS_NOT_READY");
    activeFailurePhase = FAILURE_PHASE.IDEMPOTENCY;
    const completedNoop = await tryCompletedNoop(prisma, gate, key);
    if (completedNoop) {
      writeSafeEvent({
        event: "amo_deadletter_group_recovery_already_completed",
        schemaVersion: 1,
        sourceSha: gate.sourceSha,
        reviewedRunId: gate.reviewedRunId,
        queueRows: core.EXPECTED_QUEUE_ROWS,
        phoneGroups: core.EXPECTED_PHONE_GROUPS,
        groupsCompleted: core.EXPECTED_PHONE_GROUPS,
        groupsAmbiguous: 0,
        clientContactsCreated: gate.manifest.clientContactCreates,
        leadsCreatedOrReconciled: gate.manifest.maxLeadPosts,
        morekitDelivered: completedNoop.morekitDelivered,
        morekitUnresolved: completedNoop.morekitUnresolved,
        requeues: 0,
      });
      return;
    }
    activeFailurePhase = FAILURE_PHASE.ACCOUNT;
    const requestGet = legacyInspector.createGetOnlyRequester(
      process.env.AMO_ACCESS_TOKEN,
    );
    await legacyInspector.assertExpectedAccount(requestGet);
    activeFailurePhase = FAILURE_PHASE.FIRST_PLAN;
    const first = await planModule.collectPlan({
      prisma,
      request: requestGet,
      metadata: metadataFor(gate),
      attestationKey: key,
      reportKey: randomBytes(32),
    });
    assertPlanMatchesGate(first, gate);
    await assertNoPriorGroupGates(prisma, first, key);
    activeFailurePhase = FAILURE_PHASE.PHONE_LOCK;
    leases = await acquirePhoneLeases(redis, first.classifications, key);
    activeFailurePhase = FAILURE_PHASE.SECOND_PLAN;
    const second = await planModule.collectPlan({
      prisma,
      request: requestGet,
      metadata: metadataFor(gate),
      attestationKey: key,
      reportKey: randomBytes(32),
    });
    assertPlanMatchesGate(second, gate);
    if (
      first.digest !== second.digest ||
      first.manifestText !== second.manifestText
    ) {
      fail("PLAN_DRIFT_BETWEEN_SCANS");
    }
    await leases.assertOwned();
    activeFailurePhase = FAILURE_PHASE.CLAIM;
    const operationByPhone = await claimAllGroups({
      prisma,
      Prisma,
      plan: second,
      gate,
      key,
      leases,
    });
    durableClaimCommitted = true;
    const integrations = require("@st-michael/integrations");
    integrations.setAmoTokens(process.env.AMO_ACCESS_TOKEN || "", "");
    const adapter = new integrations.AmoCrmAdapter();
    const completed = [];
    for (const item of second.classifications) {
      const phone = item.group.normalizedPhone;
      const operationId = operationByPhone.get(phone);
      try {
        await leases.assertOwned();
        activeFailurePhase = FAILURE_PHASE.CONTACT;
        const contact = await resolveClientContact({
          prisma,
          adapter,
          requestGet,
          item,
          key,
          gate,
          operationId,
          leases,
        });
        if (contact.created) summary.clientContactsCreated += 1;
        await leases.assertOwned();
        activeFailurePhase = FAILURE_PHASE.LEAD;
        const leadId = await createOrReconcileLead({
          prisma,
          adapter,
          requestGet,
          item,
          key,
          gate,
          operationId,
          clientContactId: contact.contactId,
          leases,
        });
        summary.leadsCreatedOrReconciled += 1;
        await leases.assertOwned();
        activeFailurePhase = FAILURE_PHASE.DATABASE_LINK;
        await linkSiblingRows({
          prisma,
          item,
          key,
          gate,
          operationId,
          leadId,
          leases,
        });
        successfulPhones.add(phone);
        summary.groupsCompleted += 1;
        const morekitStatus = await notifyMorekitOnce({
          prisma,
          item,
          key,
          gate,
          operationId,
          leadId,
          integrations,
        }).catch(() => "unresolved");
        if (morekitStatus === "delivered") summary.morekitDelivered += 1;
        else summary.morekitUnresolved += 1;
        completed.push({
          entityId: groupEntityId(phone, key),
          leadId,
          clientIds: item.group.rows.map((row) => String(row.id)),
          morekitStatus,
        });
      } catch (error) {
        summary.groupsAmbiguous += 1;
        const failureCode = safeFailureCode(error);
        await recordAmbiguous(
          prisma,
          item,
          key,
          gate,
          operationId,
          failureCode,
        ).catch(() => undefined);
        // A lost semantic lease is global evidence that this process no
        // longer owns its mutation boundary. Do not spend the remainder of
        // the batch probing (and certainly never POSTing) other groups.
        if (failureCode === "PHONE_LOCK_OWNERSHIP_LOST") break;
      }
    }
    if (summary.groupsAmbiguous !== 0) fail("ONE_OR_MORE_GROUPS_AMBIGUOUS");
    activeFailurePhase = FAILURE_PHASE.FINAL;
    await recordBatchCompletion(prisma, gate, key, completed);
    writeSafeEvent({
      event: "amo_deadletter_group_recovery_completed",
      schemaVersion: 1,
      sourceSha: gate.sourceSha,
      reviewedRunId: gate.reviewedRunId,
      queueRows: core.EXPECTED_QUEUE_ROWS,
      phoneGroups: core.EXPECTED_PHONE_GROUPS,
      ...summary,
      requeues: 0,
    });
  } finally {
    if (leases) {
      const safelyReleasable = durableClaimCommitted
        ? successfulPhones
        : new Set(leases.leases.map((lease) => lease.phone));
      await leases.release(safelyReleasable).catch(() => undefined);
    }
    key.fill(0);
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

module.exports = {
  ACTIONS,
  APPLY_SOURCE,
  AUDIT_ATTESTATION_DOMAIN,
  BATCH_ENTITY,
  EXACT_CONFIRMATION,
  FAILURE_PHASE,
  GATE_ENTITY,
  MANIFEST_KEYS,
  RecoveryFailure,
  acquirePhoneLeases,
  assertCurrentRows,
  assertNoPriorGroupGates,
  assertPlanMatchesGate,
  assertSignedAuditPayload,
  batchEntityId,
  buildWriteDatabaseUrl,
  buildMorekitPayload,
  candidateLeadFromEvidence,
  claimAllGroups,
  createOrReconcileLead,
  fixationLeadPayload,
  lostContactResponseMatches,
  expectedFixationLeadName,
  groupEntityId,
  linkSiblingRows,
  loadMorekitUrl,
  notifyMorekitOnce,
  parseManifest,
  readExecutionGate,
  resolveClientContact,
  revalidateClaimedGroup,
  safeFailureCode,
  sameLeadEvidence,
  signedAuditPayload,
  tryCompletedNoop,
  writeSafeEvent,
};

if (require.main === module) {
  main().catch((error) => {
    const completed = Number(activeProgress?.groupsCompleted || 0);
    try {
      writeSafeEvent({
        event: "amo_deadletter_group_recovery_failed",
        schemaVersion: 1,
        queueRows: core.EXPECTED_QUEUE_ROWS,
        phoneGroups: core.EXPECTED_PHONE_GROUPS,
        groupsCompleted: completed,
        groupsAmbiguous: core.EXPECTED_PHONE_GROUPS - completed,
        clientContactsCreated: Number(
          activeProgress?.clientContactsCreated || 0,
        ),
        leadsCreatedOrReconciled: Number(
          activeProgress?.leadsCreatedOrReconciled || 0,
        ),
        morekitDelivered: Number(activeProgress?.morekitDelivered || 0),
        morekitUnresolved: Number(activeProgress?.morekitUnresolved || 0),
        requeues: 0,
        failurePhase: activeFailurePhase,
        failureCode: safeFailureCode(error),
      });
    } catch {
      process.stdout.write(
        '{"event":"amo_deadletter_group_recovery_failed","schemaVersion":1,"queueRows":12,"phoneGroups":9,"groupsCompleted":0,"groupsAmbiguous":9,"clientContactsCreated":0,"leadsCreatedOrReconciled":0,"morekitDelivered":0,"morekitUnresolved":0,"requeues":0,"failurePhase":"REPORT","failureCode":"UNSAFE_REPORT_EVENT"}\n',
      );
    }
    process.exitCode = 1;
  });
}
