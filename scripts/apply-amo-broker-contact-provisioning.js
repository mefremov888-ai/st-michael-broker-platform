#!/usr/bin/env node
/**
 * Production-only, PII-safe amoCRM broker-contact provisioner.
 *
 * This is deliberately a standalone one-off repair tool. It rebuilds the
 * complete exhausted-queue provisioning plan with the exact read-only
 * inspector, requires a manually supplied exact-SHA/count manifest, and only
 * then provisions the unambiguous broker contacts in that plan.
 *
 * Mutations are deliberately narrow:
 *   - PATCH an exact unique unflagged contact with IS_BROKER=true only;
 *   - POST one full broker contact for an exact-phone absence only;
 *   - CAS Broker.amoContactId plus one AuditLog row in one Serializable tx.
 *
 * POST/PATCH are never retried. A lost mutation response can only be resolved
 * by bounded exact-phone GET reconciliation. Client/queue rows are read-only;
 * this script never retries a fixation or creates/updates a lead.
 */

"use strict";

const {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");

const EXACT_CONFIRMATION = "PROVISION_AMO_BROKER_CONTACTS";
// Historical count evidence only. This ID never authorizes an apply; the
// workflow attests a new exact-SHA inspector run and passes that run ID in.
const HISTORICAL_COUNT_EVIDENCE_RUN_ID = "32947094767";
const EXPECTED_DATABASE_NAME = "broker_platform";
const STATEMENT_TIMEOUT_MS = 20_000;
const LOCK_TIMEOUT_MS = 5_000;
const TRANSACTION_TIMEOUT_MS = 180_000;
const MUTATION_TIMEOUT_MS = 20_000;
const MAX_MUTATION_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MUTATION_REQUEST_BYTES = 128 * 1024;
const POST_MUTATION_RECONCILIATION_ATTEMPTS = 6;
const HASH_DOMAIN = "st-michael:amo-broker-contact-provisioner:v1";
const AMO_BROKER_CONTACT_LOCK_DOMAIN =
  "st-michael:amo-broker-contact-phone-lock:v2";
const AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION =
  "AMO_BROKER_CONTACT_CREATE_UNCERTAIN";
const AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION =
  "AMO_BROKER_CONTACT_CREATE_RESOLVED";
const AMO_BROKER_CONTACT_GATE_ENTITY = "AmoBrokerContactPhone";
const AMO_BROKER_CONTACT_GATE_DIGEST_DOMAIN =
  "st-michael:amo-broker-contact-gate:v1";
let injectedGateHmacKeyForTests = null;

function injectGateHmacKeyForTests(value) {
  if (process.env.NODE_ENV !== "test") fail("AMO_GATE_TEST_KEY_FORBIDDEN");
  const key = Buffer.from(String(value || ""), "utf8");
  if (key.length < 32) fail("AMO_GATE_HMAC_KEY_INVALID");
  injectedGateHmacKeyForTests = key;
}
const QUEUE_STATUSES = ["FAILED", "PENDING"];
const ATTEMPT_LIMIT = 10;

const AMO_CONTACT_FIELDS = Object.freeze({
  PHONE: 557903,
  EMAIL: 557905,
  POSITION: 557901,
  INN: 834489,
  IS_BROKER: 835415,
  AGENCY_NAME: 835417,
  TELEGRAM_USERNAME: 835983,
  TELEGRAM_ID: 835985,
  WHATSAPP_USERNAME: 842321,
  BLACKLIST: 834665,
  REGION: 589265,
  PRESENTATION_SENT: 835955,
  CORRESPONDENCE_ADDRESS: 558637,
});

const RESOLUTION_CLASSES = Object.freeze([
  "link_existing_broker_contact",
  "promote_existing_contact_candidate",
  "create_contact_candidate",
  "already_linked",
  "effective_broker_missing",
  "broker_merged",
  "no_valid_phone",
  "db_phone_ambiguous",
  "ambiguous_exact_contacts",
  "candidate_already_bound",
]);

const ACTIONABLE_RESOLUTIONS = new Set([
  "link_existing_broker_contact",
  "promote_existing_contact_candidate",
  "create_contact_candidate",
]);

const BLOCKED_RESOLUTIONS = new Set(
  RESOLUTION_CLASSES.filter(
    (resolution) =>
      !ACTIONABLE_RESOLUTIONS.has(resolution) &&
      resolution !== "already_linked",
  ),
);

const REVIEWED_RUN_CEILINGS = Object.freeze({
  queueRows: 12,
  effectiveBrokerGroups: 9,
  actionableGroups: 8,
  actionableRows: 11,
  groups: Object.freeze({
    link_existing_broker_contact: 1,
    promote_existing_contact_candidate: 1,
    create_contact_candidate: 6,
  }),
  rows: Object.freeze({
    link_existing_broker_contact: 1,
    promote_existing_contact_candidate: 2,
    create_contact_candidate: 8,
  }),
});

// This is intentionally duplicated from the reviewed run instead of trusting
// operator-supplied counts alone. The workflow inputs are a second explicit
// confirmation; neither a smaller nor a larger drifted cohort may be applied.
const REVIEWED_RUN_MANIFEST = Object.freeze({
  queueRows: 12,
  effectiveBrokerGroups: 9,
  groups: Object.freeze({
    link_existing_broker_contact: 1,
    promote_existing_contact_candidate: 1,
    create_contact_candidate: 6,
    already_linked: 1,
    effective_broker_missing: 0,
    broker_merged: 0,
    no_valid_phone: 0,
    db_phone_ambiguous: 0,
    ambiguous_exact_contacts: 0,
    candidate_already_bound: 0,
  }),
  rows: Object.freeze({
    link_existing_broker_contact: 1,
    promote_existing_contact_candidate: 2,
    create_contact_candidate: 8,
    already_linked: 1,
    effective_broker_missing: 0,
    broker_merged: 0,
    no_valid_phone: 0,
    db_phone_ambiguous: 0,
    ambiguous_exact_contacts: 0,
    candidate_already_bound: 0,
  }),
});

const RESOLUTION_ORDER = new Map(
  [
    "link_existing_broker_contact",
    "promote_existing_contact_candidate",
    "create_contact_candidate",
  ].map((resolution, index) => [resolution, index]),
);

const BROKER_OWNER_SELECT = Object.freeze({
  id: true,
  amoContactId: true,
  phone: true,
  mergedIntoId: true,
  phones: {
    select: { phone: true },
    orderBy: { phone: "asc" },
  },
});

const BROKER_PROVISION_SELECT = Object.freeze({
  ...BROKER_OWNER_SELECT,
  fullName: true,
  email: true,
  region: true,
  position: true,
  telegramUsername: true,
  telegramId: true,
  whatsappUsername: true,
  presentationSent: true,
  doNotCall: true,
  updatedAt: true,
  brokerAgencies: {
    where: { isPrimary: true },
    select: {
      id: true,
      agencyId: true,
      isPrimary: true,
      joinedAt: true,
      agency: {
        select: {
          id: true,
          name: true,
          inn: true,
          address: true,
        },
      },
    },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    take: 2,
  },
});

const QUEUE_ROW_SELECT = Object.freeze({
  id: true,
  brokerId: true,
  responsibleBrokerId: true,
  amoLeadId: true,
  fixationAgencyId: true,
  amoSyncStatus: true,
  amoSyncAttempts: true,
  amoSyncError: true,
  broker: { select: BROKER_PROVISION_SELECT },
  responsibleBroker: { select: BROKER_PROVISION_SELECT },
});

const QUEUE_CAS_SELECT = Object.freeze({
  id: true,
  brokerId: true,
  responsibleBrokerId: true,
  amoLeadId: true,
  fixationAgencyId: true,
  amoSyncStatus: true,
  amoSyncAttempts: true,
  amoSyncError: true,
});

const FAILURE_PHASE = Object.freeze({
  GATE: "GATE",
  DATABASE: "DATABASE",
  ACCOUNT: "ACCOUNT",
  PLAN: "PLAN",
  PREFLIGHT: "PREFLIGHT",
  AMO_MUTATION: "AMO_MUTATION",
  AMO_RECONCILIATION: "AMO_RECONCILIATION",
  DATABASE_CAS: "DATABASE_CAS",
  REPORT: "REPORT",
});

const FAILURE_STAGE = Object.freeze({
  NOT_APPLICABLE: "NOT_APPLICABLE",
  GLOBAL_ALREADY_LINKED_DATABASE: "GLOBAL_ALREADY_LINKED_DATABASE",
  GLOBAL_ALREADY_LINKED_AMO: "GLOBAL_ALREADY_LINKED_AMO",
  GLOBAL_ACTIONABLE_DATABASE: "GLOBAL_ACTIONABLE_DATABASE",
  GLOBAL_ACTIONABLE_AMO: "GLOBAL_ACTIONABLE_AMO",
  GLOBAL_ACTIONABLE_GATE: "GLOBAL_ACTIONABLE_GATE",
  ALREADY_LINKED_GATE_RECONCILIATION: "ALREADY_LINKED_GATE_RECONCILIATION",
  ACTIONABLE_LOCKED_EXECUTION: "ACTIONABLE_LOCKED_EXECUTION",
  FINAL_POSTCONDITION: "FINAL_POSTCONDITION",
});
const SAFE_FAILURE_STAGES = new Set(Object.values(FAILURE_STAGE));

let activeFailurePhase = FAILURE_PHASE.GATE;
let activeFailureStage = FAILURE_STAGE.NOT_APPLICABLE;
let activeAmoFailureClassifier = null;
const safeProgress = {
  groupsLinked: 0,
  groupsPromoted: 0,
  groupsCreated: 0,
};

class ProvisioningFailure extends Error {
  constructor(code) {
    super("Broker contact provisioning failed");
    this.name = "ProvisioningFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new ProvisioningFailure(code);
}

// Only fixed codes emitted by the pinned GET-only inspector classifier may
// cross the PII-safe report boundary. Arbitrary messages, response bodies,
// URLs, causes and stacks remain unreported.
const SAFE_AMO_GET_FAILURE_CODES = new Set([
  "AMO_ACCESS_TOKEN_MISSING",
  "FETCH_UNAVAILABLE",
  "UNSAFE_AMO_PATH",
  "UNSAFE_AMO_QUERY",
  "UNSAFE_AMO_URL",
  "AMO_REQUEST_FAILED",
  "AMO_REQUEST_REJECTED",
  "AMO_RESPONSE_SIZE_INVALID",
  "AMO_RESPONSE_SIZE_LIMIT_EXCEEDED",
  "AMO_INVALID_JSON",
  "UNEXPECTED_AMO_ACCOUNT",
  "MALFORMED_AMO_CONTACTS_PAGE",
  "INVALID_AMO_CONTACT_RECORD",
  "AMO_CONTACTS_PAGINATION_LOOP",
  "AMO_CONTACTS_PAGINATION_SAFETY_BOUND_EXCEEDED",
]);

// Prisma messages and meta may contain SQL, connection details or row values;
// classify only this narrow allowlist of public error codes.
const PRISMA_FAILURE_CODE_BY_CODE = new Map([
  ["P2002", "DATABASE_UNIQUE_CONSTRAINT"],
  ["P2010", "DATABASE_RAW_QUERY_FAILED"],
  ["P2024", "DATABASE_POOL_TIMEOUT"],
  ["P2028", "DATABASE_TRANSACTION_FAILED"],
  ["P2034", "DATABASE_SERIALIZATION_CONFLICT"],
]);

function safeFailureCode(
  error,
  amoFailureClassifier = activeAmoFailureClassifier,
) {
  try {
    if (
      error instanceof ProvisioningFailure &&
      typeof error.code === "string" &&
      /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
    ) {
      return error.code;
    }
    if (error && typeof error === "object") {
      const prismaFailureCode = PRISMA_FAILURE_CODE_BY_CODE.get(error.code);
      if (prismaFailureCode) return prismaFailureCode;
    }
    if (typeof amoFailureClassifier === "function") {
      const amoFailureCode = amoFailureClassifier(error);
      if (SAFE_AMO_GET_FAILURE_CODES.has(amoFailureCode)) {
        return amoFailureCode;
      }
    }
  } catch {
    return "UNCLASSIFIED_FAILURE";
  }
  return "UNCLASSIFIED_FAILURE";
}

function safeFailureStage(value) {
  return SAFE_FAILURE_STAGES.has(value) ? value : FAILURE_STAGE.NOT_APPLICABLE;
}

function writeSafeEvent(event) {
  const allowed = new Set([
    "event",
    "schemaVersion",
    "sourceSha",
    "brokerHash",
    "resolution",
    "index",
    "total",
    "groupsLinked",
    "groupsPromoted",
    "groupsCreated",
    "alreadyLinked",
    "queueRows",
    "effectiveBrokerGroups",
    "failurePhase",
    "failureStage",
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

function boundedCount(value, field) {
  if (!/^(0|[1-9]\d{0,5})$/.test(String(value ?? ""))) {
    fail(`INVALID_${field}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 999_999) {
    fail(`INVALID_${field}`);
  }
  return parsed;
}

function resolutionEnvName(resolution) {
  return resolution.toUpperCase();
}

function readExecutionGate(env = process.env) {
  if (env.PROVISION_CONFIRMATION !== EXACT_CONFIRMATION) {
    fail("CONFIRMATION_REQUIRED");
  }
  const sourceSha = String(env.PROVISION_SOURCE_SHA || "");
  const confirmedSha = String(env.PROVISION_CONFIRM_EXACT_SHA || "");
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail("SOURCE_SHA_INVALID");
  if (confirmedSha !== sourceSha) fail("SOURCE_SHA_CONFIRMATION_MISMATCH");
  const reviewedPlanRunId = String(env.PROVISION_REVIEWED_PLAN_RUN_ID || "");
  if (!/^[1-9]\d{5,19}$/.test(reviewedPlanRunId)) {
    fail("REVIEWED_PLAN_RUN_ID_INVALID");
  }
  const inspectorSha256 = String(env.BROKER_CONTACT_INSPECTOR_SHA256 || "");
  const deployedGitSha = String(env.BROKER_CONTACT_DEPLOYED_GIT_SHA || "");
  const expectedCohortDigest = String(
    env.PROVISION_EXPECTED_COHORT_DIGEST || "",
  );
  if (!/^[0-9a-f]{64}$/.test(inspectorSha256)) {
    fail("INSPECTOR_SHA256_INVALID");
  }
  if (deployedGitSha !== sourceSha) {
    fail("DEPLOYED_SHA_MISMATCH");
  }
  if (!/^[0-9a-f]{64}$/.test(expectedCohortDigest)) {
    fail("EXPECTED_COHORT_DIGEST_INVALID");
  }
  const expected = {
    queueRows: boundedCount(env.EXPECTED_QUEUE_ROWS, "EXPECTED_QUEUE_ROWS"),
    effectiveBrokerGroups: boundedCount(
      env.EXPECTED_EFFECTIVE_BROKER_GROUPS,
      "EXPECTED_EFFECTIVE_BROKER_GROUPS",
    ),
    groups: {},
    rows: {},
  };
  for (const resolution of RESOLUTION_CLASSES) {
    const name = resolutionEnvName(resolution);
    expected.groups[resolution] = boundedCount(
      env[`EXPECTED_${name}_GROUPS`],
      `EXPECTED_${name}_GROUPS`,
    );
    expected.rows[resolution] = boundedCount(
      env[`EXPECTED_${name}_ROWS`],
      `EXPECTED_${name}_ROWS`,
    );
  }
  return {
    sourceSha,
    inspectorSha256,
    deployedGitSha,
    expectedCohortDigest,
    reviewedPlanRunId,
    expected,
  };
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

function loadPlanModule(
  modulePath = process.env.BROKER_CONTACT_PLAN_MODULE,
  expectedSha256 = process.env.BROKER_CONTACT_INSPECTOR_SHA256,
) {
  const candidate = modulePath
    ? String(modulePath)
    : resolve(__dirname, "inspect-amo-broker-link-repair-plan.js");
  if (!isAbsolute(candidate)) fail("PLAN_MODULE_PATH_NOT_ABSOLUTE");
  let metadata;
  try {
    metadata = lstatSync(candidate);
  } catch {
    fail("PLAN_MODULE_MISSING");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("PLAN_MODULE_UNSAFE");
  }
  if (!/^[0-9a-f]{64}$/.test(String(expectedSha256 || ""))) {
    fail("PLAN_MODULE_SHA_INVALID");
  }
  let actualSha256;
  try {
    actualSha256 = createHash("sha256")
      .update(readFileSync(candidate))
      .digest("hex");
  } catch {
    fail("PLAN_MODULE_HASH_FAILED");
  }
  if (actualSha256 !== expectedSha256) {
    fail("PLAN_MODULE_SHA_MISMATCH");
  }
  const loaded = require(candidate);
  const requiredExports = [
    "assertExpectedAccount",
    "buildCohortAttestation",
    "buildProvisioningReport",
    "classifyFailure",
    "createGetOnlyRequester",
    "lookupExactContacts",
    "normalizePhone",
    "readCohortAttestationKeyFile",
    "readJsonBounded",
    "reportHash",
    "requiredLookupPhones",
  ];
  if (requiredExports.some((name) => typeof loaded?.[name] !== "function")) {
    fail("PLAN_MODULE_CONTRACT_INVALID");
  }
  if (loaded.AMO_ORIGIN !== "https://stmichael.amocrm.ru") {
    fail("PLAN_MODULE_ORIGIN_INVALID");
  }
  if (loaded.ATTEMPT_LIMIT !== ATTEMPT_LIMIT) {
    fail("PLAN_MODULE_ATTEMPT_LIMIT_INVALID");
  }
  return loaded;
}

function assertExpectedCohortAttestation(actual, gate) {
  if (
    !actual ||
    actual.digest !== gate.expectedCohortDigest ||
    actual.inspectorSha256 !== gate.inspectorSha256 ||
    actual.deployedGitSha !== gate.deployedGitSha
  ) {
    fail("COHORT_ATTESTATION_MISMATCH");
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeAmoBrokerContactLockPhone(phone) {
  const trimmed = String(phone ?? "").trim();
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("77")) {
    digits = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith("77")) {
    fail("AMO_BROKER_CONTACT_LOCK_PHONE_INVALID");
  } else if (digits.length === 11 && digits.startsWith("8")) {
    digits = `7${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `7${digits}`;
  }
  if (!/^7\d{10}$/.test(digits)) {
    fail("AMO_BROKER_CONTACT_LOCK_PHONE_INVALID");
  }
  return `+${digits}`;
}

function amoBrokerContactAdvisoryLockKey(phone) {
  const normalizedPhone = normalizeAmoBrokerContactLockPhone(phone);
  return createHash("sha256")
    .update(AMO_BROKER_CONTACT_LOCK_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(normalizedPhone, "utf8")
    .digest()
    .readBigInt64BE(0);
}

async function acquireAmoBrokerContactAdvisoryXactLock(
  transaction,
  brokerId,
  phone,
) {
  if (!transaction || typeof transaction.$queryRaw !== "function") {
    fail("AMO_BROKER_CONTACT_LOCK_TRANSACTION_INVALID");
  }
  const key = amoBrokerContactAdvisoryLockKey(phone);
  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${key})`;
  const brokerRows =
    await transaction.$queryRaw`SELECT id FROM brokers WHERE id = ${brokerId} FOR UPDATE`;
  if (!Array.isArray(brokerRows) || brokerRows.length !== 1) {
    fail("AMO_BROKER_CONTACT_LOCK_BROKER_MISSING");
  }
  return key;
}

function effectiveBroker(row) {
  return row?.responsibleBroker || row?.broker || null;
}

function brokerPhones(broker, planModule) {
  if (!broker) return [];
  const values = [
    broker.phone,
    ...(Array.isArray(broker.phones)
      ? broker.phones.map((entry) => entry?.phone)
      : []),
  ];
  return [
    ...new Set(values.map(planModule.normalizePhone).filter(Boolean)),
  ].sort();
}

function groupQueueRows(queueRows) {
  const groups = new Map();
  for (const row of queueRows) {
    const broker = effectiveBroker(row);
    const key = broker?.id ? `broker:${broker.id}` : `queue:${row?.id}`;
    if (!groups.has(key)) groups.set(key, { broker, queueRows: [] });
    groups.get(key).queueRows.push(row);
  }
  return [...groups.values()];
}

function buildPhoneOwnerMap(allBrokers, planModule) {
  const owners = new Map();
  for (const broker of allBrokers) {
    if (!broker?.id || broker.mergedIntoId) continue;
    for (const phone of brokerPhones(broker, planModule)) {
      if (!owners.has(phone)) owners.set(phone, new Set());
      owners.get(phone).add(String(broker.id));
    }
  }
  return owners;
}

function buildContactOwnerMap(allBrokers) {
  const owners = new Map();
  for (const broker of allBrokers) {
    const contactId = positiveInteger(broker?.amoContactId);
    if (!contactId || !broker?.id) continue;
    if (!owners.has(contactId)) owners.set(contactId, new Set());
    owners.get(contactId).add(String(broker.id));
  }
  return owners;
}

function collectExactContacts(phones, lookups) {
  const contacts = new Map();
  for (const phone of phones) {
    const lookup = lookups.get(phone);
    if (!lookup || !Array.isArray(lookup.contacts)) {
      fail("AMO_LOOKUP_CONTRACT_INVALID");
    }
    for (const candidate of lookup.contacts) {
      const contactId = positiveInteger(candidate?.contactId);
      if (!contactId || typeof candidate?.brokerFlag !== "boolean") {
        fail("AMO_LOOKUP_CONTACT_INVALID");
      }
      const previous = contacts.get(contactId);
      if (previous && previous.brokerFlag !== candidate.brokerFlag) {
        fail("AMO_LOOKUP_CONTACT_CONFLICT");
      }
      contacts.set(contactId, {
        contactId,
        brokerFlag: candidate.brokerFlag,
      });
    }
  }
  return [...contacts.values()].sort(
    (left, right) => left.contactId - right.contactId,
  );
}

function buildInternalProvisioningPlan(
  queueRows,
  allBrokers,
  lookups,
  planModule,
) {
  const phoneOwners = buildPhoneOwnerMap(allBrokers, planModule);
  const contactOwners = buildContactOwnerMap(allBrokers);
  return groupQueueRows(queueRows).map((group) => {
    const broker = group.broker;
    let resolution = null;
    let phones = [];
    let candidateContactId = null;

    if (!broker?.id) {
      resolution = "effective_broker_missing";
    } else if (broker.mergedIntoId) {
      resolution = "broker_merged";
    } else if (positiveInteger(broker.amoContactId)) {
      resolution = "already_linked";
      phones = brokerPhones(broker, planModule);
    } else {
      phones = brokerPhones(broker, planModule);
      if (phones.length === 0) {
        resolution = "no_valid_phone";
      } else {
        const phoneCollision = phones.some((phone) => {
          const owners = phoneOwners.get(phone);
          return !owners || owners.size !== 1 || !owners.has(String(broker.id));
        });
        if (phoneCollision) {
          resolution = "db_phone_ambiguous";
        } else {
          const contacts = collectExactContacts(phones, lookups);
          if (contacts.length === 0) {
            resolution = "create_contact_candidate";
          } else if (contacts.length > 1) {
            resolution = "ambiguous_exact_contacts";
          } else {
            const candidate = contacts[0];
            const owners = contactOwners.get(candidate.contactId) || new Set();
            const occupied = [...owners].some(
              (ownerId) => ownerId !== String(broker.id),
            );
            if (occupied) {
              resolution = "candidate_already_bound";
            } else {
              resolution = candidate.brokerFlag
                ? "link_existing_broker_contact"
                : "promote_existing_contact_candidate";
              candidateContactId = candidate.contactId;
            }
          }
        }
      }
    }

    return {
      broker,
      queueRows: group.queueRows,
      phones,
      candidateContactId,
      resolution,
      brokerSourceSnapshot: broker
        ? brokerSourceSnapshot(broker, planModule)
        : null,
      queueSnapshot: queueSnapshot(group.queueRows),
    };
  });
}

function emptyResolutionCounts() {
  return Object.fromEntries(RESOLUTION_CLASSES.map((key) => [key, 0]));
}

function reportManifest(report) {
  if (
    report?.inspector !== "amo_broker_contact_provisioning_plan" ||
    report?.schemaVersion !== 1
  ) {
    fail("PLAN_REPORT_CONTRACT_INVALID");
  }
  const groups = emptyResolutionCounts();
  const rows = emptyResolutionCounts();
  for (const resolution of RESOLUTION_CLASSES) {
    const groupCount = report?.aggregates?.resolutionByBroker?.[resolution];
    const rowCount = report?.aggregates?.resolutionByQueueRow?.[resolution];
    if (
      !Number.isSafeInteger(groupCount) ||
      groupCount < 0 ||
      !Number.isSafeInteger(rowCount) ||
      rowCount < 0
    ) {
      fail("PLAN_REPORT_COUNT_INVALID");
    }
    groups[resolution] = groupCount;
    rows[resolution] = rowCount;
  }
  const queueRows = report?.aggregates?.exhaustedQueueRows;
  const effectiveBrokerGroups = report?.aggregates?.effectiveBrokerGroups;
  if (
    !Number.isSafeInteger(queueRows) ||
    queueRows < 0 ||
    !Number.isSafeInteger(effectiveBrokerGroups) ||
    effectiveBrokerGroups < 0
  ) {
    fail("PLAN_REPORT_TOTAL_INVALID");
  }
  return { queueRows, effectiveBrokerGroups, groups, rows };
}

function internalPlanManifest(records, queueRowCount) {
  const groups = emptyResolutionCounts();
  const rows = emptyResolutionCounts();
  for (const record of records) {
    if (!RESOLUTION_CLASSES.includes(record.resolution)) {
      fail("INTERNAL_PLAN_RESOLUTION_INVALID");
    }
    groups[record.resolution] += 1;
    rows[record.resolution] += record.queueRows.length;
  }
  return {
    queueRows: queueRowCount,
    effectiveBrokerGroups: records.filter((record) => record.broker?.id).length,
    groups,
    rows,
  };
}

function assertExactManifest(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("EXACT_PLAN_COUNT_DRIFT");
  }
}

function assertReviewedRunCeilings(manifest) {
  const actionableGroups = [...ACTIONABLE_RESOLUTIONS].reduce(
    (sum, resolution) => sum + manifest.groups[resolution],
    0,
  );
  const actionableRows = [...ACTIONABLE_RESOLUTIONS].reduce(
    (sum, resolution) => sum + manifest.rows[resolution],
    0,
  );
  if (
    manifest.queueRows > REVIEWED_RUN_CEILINGS.queueRows ||
    manifest.effectiveBrokerGroups >
      REVIEWED_RUN_CEILINGS.effectiveBrokerGroups ||
    actionableGroups > REVIEWED_RUN_CEILINGS.actionableGroups ||
    actionableRows > REVIEWED_RUN_CEILINGS.actionableRows
  ) {
    fail("REVIEWED_RUN_TOTAL_CEILING_EXCEEDED");
  }
  for (const resolution of ACTIONABLE_RESOLUTIONS) {
    if (
      manifest.groups[resolution] > REVIEWED_RUN_CEILINGS.groups[resolution] ||
      manifest.rows[resolution] > REVIEWED_RUN_CEILINGS.rows[resolution]
    ) {
      fail("REVIEWED_RUN_CLASS_CEILING_EXCEEDED");
    }
  }
}

function assertReviewedRunManifest(manifest) {
  assertExactManifest(manifest, REVIEWED_RUN_MANIFEST);
}

function assertExecutablePlan(records, planModule) {
  if (records.some((record) => BLOCKED_RESOLUTIONS.has(record.resolution))) {
    fail("PLAN_CONTAINS_BLOCKED_CLASS");
  }
  for (const record of records) {
    if (record.resolution === "already_linked") {
      if (
        !record.broker?.id ||
        !positiveInteger(record.broker.amoContactId) ||
        record.phones.length === 0
      ) {
        fail("ALREADY_LINKED_RECORD_INVALID");
      }
    }
    if (ACTIONABLE_RESOLUTIONS.has(record.resolution)) {
      if (!record.broker?.id || record.phones.length === 0) {
        fail("ACTIONABLE_PLAN_RECORD_INVALID");
      }
      if (
        record.resolution === "create_contact_candidate" &&
        record.candidateContactId !== null
      ) {
        fail("CREATE_PLAN_CANDIDATE_INVALID");
      }
      if (
        record.resolution !== "create_contact_candidate" &&
        !positiveInteger(record.candidateContactId)
      ) {
        fail("LINK_PLAN_CANDIDATE_INVALID");
      }
      primaryAgency(record.broker);
      if (
        typeof record.broker.fullName !== "string" ||
        !record.broker.fullName.trim()
      ) {
        fail("BROKER_SOURCE_INVALID");
      }
      const normalizedPrimaryPhone = planModule.normalizePhone(
        record.broker.phone,
      );
      if (
        !normalizedPrimaryPhone ||
        !record.phones.includes(normalizedPrimaryPhone)
      ) {
        fail("BROKER_PRIMARY_PHONE_INVALID");
      }
    }
  }
}

function primaryAgency(broker) {
  const links = Array.isArray(broker?.brokerAgencies)
    ? broker.brokerAgencies
    : [];
  if (links.length > 1) fail("PRIMARY_AGENCY_AMBIGUOUS");
  if (links.length === 0) return null;
  if (!links[0]?.isPrimary || !links[0]?.agency) {
    fail("PRIMARY_AGENCY_INVALID");
  }
  return links[0].agency;
}

function buildBrokerCreatePayload(broker) {
  const agency = primaryAgency(broker);
  const fields = [
    {
      field_id: AMO_CONTACT_FIELDS.IS_BROKER,
      values: [{ value: true }],
    },
  ];
  if (agency?.address) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.CORRESPONDENCE_ADDRESS,
      values: [{ value: String(agency.address) }],
    });
  }
  if (broker.phone) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.PHONE,
      values: [{ value: broker.phone, enum_code: "WORK" }],
    });
  }
  if (broker.email) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.EMAIL,
      values: [{ value: broker.email, enum_code: "WORK" }],
    });
  }
  if (broker.position) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.POSITION,
      values: [{ value: broker.position }],
    });
  }
  if (agency?.inn) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.INN,
      values: [{ value: agency.inn }],
    });
  }
  if (agency?.name) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.AGENCY_NAME,
      values: [{ value: agency.name }],
    });
  }
  if (broker.telegramUsername) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.TELEGRAM_USERNAME,
      values: [{ value: broker.telegramUsername }],
    });
  }
  if (broker.telegramId) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.TELEGRAM_ID,
      values: [{ value: broker.telegramId }],
    });
  }
  if (broker.whatsappUsername) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.WHATSAPP_USERNAME,
      values: [{ value: broker.whatsappUsername }],
    });
  }
  if (broker.region) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.REGION,
      values: [{ value: broker.region }],
    });
  }
  // BROKER_TOUR_VISITED and BROKER_TOUR_DATE intentionally stay inbound-only.
  if (broker.presentationSent) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.PRESENTATION_SENT,
      values: [{ value: true }],
    });
  }
  if (broker.doNotCall) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.BLACKLIST,
      values: [{ value: true }],
    });
  }
  return {
    name: broker.fullName,
    custom_fields_values: fields,
  };
}

function promotionPayload() {
  return {
    custom_fields_values: [
      {
        field_id: AMO_CONTACT_FIELDS.IS_BROKER,
        values: [{ value: true }],
      },
    ],
  };
}

function safeScalar(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  return value;
}

function brokerSourceSnapshot(broker, planModule) {
  const links = Array.isArray(broker?.brokerAgencies)
    ? broker.brokerAgencies
    : [];
  return JSON.stringify({
    id: safeScalar(broker?.id),
    amoContactId: safeScalar(broker?.amoContactId),
    mergedIntoId: safeScalar(broker?.mergedIntoId),
    phones: brokerPhones(broker, planModule),
    fullName: safeScalar(broker?.fullName),
    phone: safeScalar(broker?.phone),
    email: safeScalar(broker?.email),
    region: safeScalar(broker?.region),
    position: safeScalar(broker?.position),
    telegramUsername: safeScalar(broker?.telegramUsername),
    telegramId: safeScalar(broker?.telegramId),
    whatsappUsername: safeScalar(broker?.whatsappUsername),
    presentationSent: safeScalar(broker?.presentationSent),
    doNotCall: safeScalar(broker?.doNotCall),
    updatedAt: safeScalar(broker?.updatedAt),
    primaryAgencies: links.map((link) => ({
      id: safeScalar(link?.id),
      agencyId: safeScalar(link?.agencyId),
      isPrimary: safeScalar(link?.isPrimary),
      joinedAt: safeScalar(link?.joinedAt),
      agency: {
        id: safeScalar(link?.agency?.id),
        name: safeScalar(link?.agency?.name),
        inn: safeScalar(link?.agency?.inn),
        address: safeScalar(link?.agency?.address),
      },
    })),
  });
}

function queueSnapshot(rows) {
  return JSON.stringify(
    [...rows]
      .map((row) => ({
        id: safeScalar(row?.id),
        brokerId: safeScalar(row?.brokerId ?? row?.broker?.id),
        responsibleBrokerId: safeScalar(
          row?.responsibleBrokerId ?? row?.responsibleBroker?.id,
        ),
        amoLeadId: safeScalar(row?.amoLeadId),
        fixationAgencyId: safeScalar(row?.fixationAgencyId),
        amoSyncStatus: safeScalar(row?.amoSyncStatus),
        amoSyncAttempts: safeScalar(row?.amoSyncAttempts),
        amoSyncError: safeScalar(row?.amoSyncError),
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
  );
}

function reportAlias(kind, value, hashKey) {
  if (!Buffer.isBuffer(hashKey) || hashKey.length < 32) {
    fail("REPORT_HASH_KEY_INVALID");
  }
  const digest = createHmac("sha256", hashKey)
    .update(`${HASH_DOMAIN}:${kind}:${String(value)}`)
    .digest("hex")
    .slice(0, 24);
  return `${kind}_${digest}`;
}

function canonicalMutationUrl(origin, method, contactId = null) {
  let pathname;
  if (method === "POST" && contactId === null) {
    pathname = "/api/v4/contacts";
  } else if (method === "PATCH" && positiveInteger(contactId)) {
    pathname = `/api/v4/contacts/${positiveInteger(contactId)}`;
  } else {
    fail("UNSAFE_AMO_MUTATION_TARGET");
  }
  const url = new URL(pathname, origin);
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    fail("UNSAFE_AMO_MUTATION_URL");
  }
  return url;
}

function extractCreatedContactId(payload, expectedRequestId = null) {
  const contacts = payload?._embedded?.contacts;
  if (!Array.isArray(contacts) || contacts.length !== 1) return null;
  if (
    expectedRequestId !== null &&
    contacts[0]?.request_id !== expectedRequestId
  ) {
    return null;
  }
  return positiveInteger(contacts[0]?.id);
}

function validateMutationRequest(
  planModule,
  { method, contactId = null, body },
) {
  const url = canonicalMutationUrl(planModule.AMO_ORIGIN, method, contactId);
  let wireBody;
  try {
    wireBody = JSON.stringify(method === "POST" ? [body] : body);
  } catch {
    fail("AMO_MUTATION_BODY_JSON_INVALID");
  }
  const bodyBytes = Buffer.byteLength(wireBody, "utf8");
  if (bodyBytes <= 0 || bodyBytes > MAX_MUTATION_REQUEST_BYTES) {
    fail("AMO_MUTATION_BODY_SIZE_INVALID");
  }
  return { url, wireBody };
}

function createOneShotMutationRequester(
  accessToken,
  planModule,
  fetchImpl = globalThis.fetch,
) {
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    fail("AMO_ACCESS_TOKEN_MISSING");
  }
  if (typeof fetchImpl !== "function") fail("FETCH_UNAVAILABLE");
  const token = accessToken.trim();
  return async ({ method, contactId = null, body }) => {
    const { url, wireBody } = validateMutationRequest(planModule, {
      method,
      contactId,
      body,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MUTATION_TIMEOUT_MS);
    let response;
    try {
      // Exactly one fetch call: POST/PATCH are intentionally never retried.
      response = await fetchImpl(url, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: wireBody,
      });
    } catch {
      clearTimeout(timeout);
      return {
        accepted: false,
        uncertain: true,
        responseContactId: null,
      };
    }
    if (!response?.ok) {
      clearTimeout(timeout);
      const definitiveRejection = [400, 401, 403, 404, 422].includes(
        Number(response?.status),
      );
      return {
        accepted: false,
        uncertain: !definitiveRejection,
        responseContactId: null,
      };
    }
    let responseContactId = null;
    if (method === "POST" && response.status !== 204) {
      try {
        const payload = await planModule.readJsonBounded(
          response,
          MAX_MUTATION_RESPONSE_BYTES,
          controller,
        );
        responseContactId = extractCreatedContactId(
          payload,
          body?.request_id || null,
        );
      } catch {
        // The accepted response may be truncated/lost. Exact GET below is the
        // only permitted recovery mechanism; the POST is never sent again.
      }
    }
    clearTimeout(timeout);
    return {
      accepted: true,
      uncertain: false,
      responseContactId,
    };
  };
}

async function lookupPhones(phones, requestGet, planModule) {
  const lookups = new Map();
  for (const phone of phones) {
    lookups.set(phone, await planModule.lookupExactContacts(requestGet, phone));
  }
  return lookups;
}

function assertAmoPrecondition(record, contacts) {
  if (record.resolution === "create_contact_candidate") {
    if (contacts.length !== 0) fail("AMO_CREATE_PRECONDITION_DRIFT");
    return;
  }
  if (
    contacts.length !== 1 ||
    contacts[0].contactId !== record.candidateContactId
  ) {
    fail("AMO_LINK_PRECONDITION_DRIFT");
  }
  const shouldBeFlagged = record.resolution === "link_existing_broker_contact";
  if (contacts[0].brokerFlag !== shouldBeFlagged) {
    fail("AMO_BROKER_FLAG_PRECONDITION_DRIFT");
  }
}

async function reconcileUniqueBrokerContact({
  phones,
  expectedContactId,
  requestGet,
  planModule,
  sleepImpl = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  for (
    let attempt = 1;
    attempt <= POST_MUTATION_RECONCILIATION_ATTEMPTS;
    attempt += 1
  ) {
    const lookups = await lookupPhones(phones, requestGet, planModule);
    const contacts = collectExactContacts(phones, lookups);
    if (contacts.length > 1) fail("AMO_POST_MUTATION_AMBIGUOUS");
    if (
      contacts.length === 1 &&
      expectedContactId !== null &&
      contacts[0].contactId !== expectedContactId
    ) {
      fail("AMO_POST_MUTATION_ID_MISMATCH");
    }
    if (contacts.length === 1 && contacts[0].brokerFlag) {
      return contacts[0].contactId;
    }
    if (attempt < POST_MUTATION_RECONCILIATION_ATTEMPTS) {
      await sleepImpl(400 * 2 ** (attempt - 1));
    }
  }
  fail("AMO_POST_MUTATION_NOT_RECONCILED");
}

async function provisionAmoContact({
  record,
  broker,
  requestGet,
  mutateOnce,
  planModule,
  sleepImpl,
  requestIdFactory = () => `provision_${randomBytes(16).toString("hex")}`,
  onCreateMutationOutcome = () => undefined,
  beforeCreateMutation = () => undefined,
}) {
  const preLookups = await lookupPhones(record.phones, requestGet, planModule);
  const preContacts = collectExactContacts(record.phones, preLookups);
  assertAmoPrecondition(record, preContacts);

  let expectedContactId = record.candidateContactId;
  if (record.resolution === "promote_existing_contact_candidate") {
    activeFailurePhase = FAILURE_PHASE.AMO_MUTATION;
    await mutateOnce({
      method: "PATCH",
      contactId: record.candidateContactId,
      body: promotionPayload(),
    });
  } else if (record.resolution === "create_contact_candidate") {
    activeFailurePhase = FAILURE_PHASE.AMO_MUTATION;
    const requestId = requestIdFactory();
    if (!/^provision_[0-9a-f]{32}$/.test(requestId)) {
      fail("AMO_CREATE_REQUEST_ID_INVALID");
    }
    const mutationRequest = {
      method: "POST",
      body: {
        ...buildBrokerCreatePayload(broker),
        request_id: requestId,
      },
    };
    // Every deterministic local failure must happen before the durable ARM.
    validateMutationRequest(planModule, mutationRequest);
    await beforeCreateMutation();
    const mutation = await mutateOnce(mutationRequest);
    onCreateMutationOutcome(mutation);
    if (!mutation?.accepted && !mutation?.uncertain) {
      fail("AMO_CREATE_REJECTED");
    }
    if (positiveInteger(mutation?.responseContactId)) {
      expectedContactId = positiveInteger(mutation.responseContactId);
    }
  }

  activeFailurePhase = FAILURE_PHASE.AMO_RECONCILIATION;
  return reconcileUniqueBrokerContact({
    phones: record.phones,
    expectedContactId,
    requestGet,
    planModule,
    sleepImpl,
  });
}

function amoBrokerContactGateDigest(phone) {
  const gateKeyFile = process.env.BROKER_CONTACT_GATE_HMAC_KEY_FILE;
  const secret =
    injectedGateHmacKeyForTests ||
    (gateKeyFile
      ? readFileSync(gateKeyFile)
      : Buffer.from(process.env.BROKER_CONTACT_GATE_HMAC_KEY || "", "utf8"));
  if (secret.length < 32) fail("AMO_GATE_HMAC_KEY_INVALID");
  return createHmac("sha256", secret)
    .update(AMO_BROKER_CONTACT_GATE_DIGEST_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(normalizeAmoBrokerContactLockPhone(phone), "utf8")
    .digest("hex");
}

async function hasUnresolvedAmoBrokerContactCreate(database, phone) {
  const events = await database.auditLog.findMany({
    where: {
      entity: AMO_BROKER_CONTACT_GATE_ENTITY,
      entityId: amoBrokerContactGateDigest(phone),
      action: {
        in: [
          AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
          AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION,
        ],
      },
    },
    select: { action: true, payload: true },
  });
  const armed = new Set();
  const resolved = new Set();
  for (const event of events) {
    const gateId = String(event?.payload?.gateId || "");
    if (!/^[0-9a-f-]{36}$/.test(gateId)) continue;
    if (event.action === AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION)
      armed.add(gateId);
    if (event.action === AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION)
      resolved.add(gateId);
  }
  const unresolved = [...armed].filter((gateId) => !resolved.has(gateId));
  if (unresolved.length > 1) fail("AMO_CREATE_GATE_AMBIGUOUS");
  return unresolved[0] || null;
}

async function armDurableAmoBrokerContactCreateGate(
  database,
  phone,
  sourceSha,
  reviewedPlanRunId,
) {
  const gateId = randomUUID();
  await database.auditLog.create({
    data: {
      userId: null,
      action: AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
      entity: AMO_BROKER_CONTACT_GATE_ENTITY,
      entityId: amoBrokerContactGateDigest(phone),
      payload: {
        gateVersion: 1,
        gateId,
        source: "production_amo_broker_contact_provisioner",
        sourceSha,
        reviewedPlanRunId,
        reason: "PRE_MUTATION_DURABLE_GATE",
        automaticRetryBlocked: true,
        clientsMutated: false,
        retriesRun: false,
      },
    },
  });
  return gateId;
}

async function recordResolvedAmoBrokerContactCreate(database, phone, gateId) {
  if (!/^[0-9a-f-]{36}$/.test(gateId)) fail("AMO_CREATE_GATE_ID_INVALID");
  await database.auditLog.create({
    data: {
      userId: null,
      action: AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION,
      entity: AMO_BROKER_CONTACT_GATE_ENTITY,
      entityId: amoBrokerContactGateDigest(phone),
      payload: {
        gateVersion: 1,
        gateId,
        source: "production_amo_broker_contact_provisioner",
        automaticRetryBlocked: false,
      },
    },
  });
}

async function assertNoUnresolvedCreateMarkers(database, records) {
  for (const record of records) {
    if (
      record.resolution === "create_contact_candidate" &&
      (await hasUnresolvedAmoBrokerContactCreate(database, record.broker.phone))
    ) {
      fail("AMO_CREATE_UNCERTAIN_MARKER_PRESENT");
    }
  }
}

function directQueueRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    brokerId: row.brokerId ?? row.broker?.id,
    responsibleBrokerId:
      row.responsibleBrokerId ?? row.responsibleBroker?.id ?? null,
    amoLeadId: row.amoLeadId,
    fixationAgencyId: row.fixationAgencyId,
    amoSyncStatus: row.amoSyncStatus,
    amoSyncAttempts: row.amoSyncAttempts,
    amoSyncError: row.amoSyncError,
  }));
}

function assertCurrentDatabaseInvariants({
  record,
  currentBroker,
  currentQueueRows,
  allBrokers,
  contactId,
  planModule,
}) {
  if (
    !currentBroker ||
    currentBroker.id !== record.broker.id ||
    currentBroker.mergedIntoId ||
    positiveInteger(currentBroker.amoContactId)
  ) {
    fail("BROKER_CAS_PRECONDITION_DRIFT");
  }
  if (
    brokerSourceSnapshot(currentBroker, planModule) !==
    record.brokerSourceSnapshot
  ) {
    fail("BROKER_SOURCE_DRIFT");
  }
  if (queueSnapshot(currentQueueRows) !== record.queueSnapshot) {
    fail("QUEUE_STATE_DRIFT");
  }
  for (const row of currentQueueRows) {
    const effectiveId = row.responsibleBrokerId || row.brokerId;
    if (
      effectiveId !== record.broker.id ||
      !QUEUE_STATUSES.includes(row.amoSyncStatus) ||
      !Number.isInteger(row.amoSyncAttempts) ||
      row.amoSyncAttempts < ATTEMPT_LIMIT
    ) {
      fail("QUEUE_CAS_PRECONDITION_DRIFT");
    }
  }

  const targetPhones = brokerPhones(currentBroker, planModule);
  if (JSON.stringify(targetPhones) !== JSON.stringify(record.phones)) {
    fail("BROKER_PHONE_SET_DRIFT");
  }
  const phoneOwners = buildPhoneOwnerMap(allBrokers, planModule);
  for (const phone of targetPhones) {
    const owners = phoneOwners.get(phone);
    if (!owners || owners.size !== 1 || !owners.has(String(record.broker.id))) {
      fail("DATABASE_PHONE_OWNERSHIP_DRIFT");
    }
  }
  const contactOwners = buildContactOwnerMap(allBrokers);
  const owners = contactOwners.get(contactId) || new Set();
  if ([...owners].some((ownerId) => ownerId !== String(record.broker.id))) {
    fail("DATABASE_CONTACT_OWNERSHIP_DRIFT");
  }
}

async function readCurrentGroupState(prisma, record) {
  const queueIds = record.queueRows.map((row) => row.id);
  const [currentBroker, currentQueueRows, allBrokers] = await Promise.all([
    prisma.broker.findUnique({
      where: { id: record.broker.id },
      select: BROKER_PROVISION_SELECT,
    }),
    prisma.client.findMany({
      where: { id: { in: queueIds } },
      select: QUEUE_CAS_SELECT,
      orderBy: { id: "asc" },
    }),
    prisma.broker.findMany({
      select: BROKER_OWNER_SELECT,
      orderBy: { id: "asc" },
    }),
  ]);
  return { currentBroker, currentQueueRows, allBrokers };
}

async function assertDatabasePreflight(prisma, record, planModule) {
  const state = await readCurrentGroupState(prisma, record);
  assertCurrentDatabaseInvariants({
    record,
    ...state,
    contactId: record.candidateContactId || Number.MAX_SAFE_INTEGER,
    planModule,
  });
  return state.currentBroker;
}

async function assertAlreadyLinkedRecord(
  prisma,
  record,
  requestGet,
  planModule,
) {
  activeFailureStage = FAILURE_STAGE.GLOBAL_ALREADY_LINKED_DATABASE;
  const state = await readCurrentGroupState(prisma, record);
  const linkedContactId = positiveInteger(record.broker.amoContactId);
  if (
    !linkedContactId ||
    !state.currentBroker ||
    positiveInteger(state.currentBroker.amoContactId) !== linkedContactId ||
    state.currentBroker.mergedIntoId ||
    brokerSourceSnapshot(state.currentBroker, planModule) !==
      record.brokerSourceSnapshot ||
    queueSnapshot(state.currentQueueRows) !== record.queueSnapshot
  ) {
    fail("ALREADY_LINKED_DATABASE_DRIFT");
  }
  const phoneOwners = buildPhoneOwnerMap(state.allBrokers, planModule);
  for (const phone of record.phones) {
    const owners = phoneOwners.get(phone);
    if (!owners || owners.size !== 1 || !owners.has(String(record.broker.id))) {
      fail("ALREADY_LINKED_PHONE_OWNERSHIP_DRIFT");
    }
  }
  const contactOwners = buildContactOwnerMap(state.allBrokers);
  const owners = contactOwners.get(linkedContactId) || new Set();
  if (owners.size !== 1 || !owners.has(String(record.broker.id))) {
    fail("ALREADY_LINKED_CONTACT_OWNERSHIP_DRIFT");
  }
  activeFailureStage = FAILURE_STAGE.GLOBAL_ALREADY_LINKED_AMO;
  const lookups = await lookupPhones(record.phones, requestGet, planModule);
  const contacts = collectExactContacts(record.phones, lookups);
  if (
    contacts.length !== 1 ||
    contacts[0].contactId !== linkedContactId ||
    !contacts[0].brokerFlag
  ) {
    fail("ALREADY_LINKED_AMO_CONTACT_INVALID");
  }
}

async function assertFinalPostcondition({
  prisma,
  records,
  resolvedContactIds,
  requestGet,
  planModule,
}) {
  const queueIds = records.flatMap((record) =>
    record.queueRows.map((row) => row.id),
  );
  const [allBrokers, allQueueRows] = await Promise.all([
    prisma.broker.findMany({
      select: BROKER_OWNER_SELECT,
      orderBy: { id: "asc" },
    }),
    prisma.client.findMany({
      where: { id: { in: queueIds } },
      select: QUEUE_CAS_SELECT,
      orderBy: { id: "asc" },
    }),
  ]);
  const brokerById = new Map(
    allBrokers.map((broker) => [String(broker.id), broker]),
  );
  const queueById = new Map(allQueueRows.map((row) => [String(row.id), row]));
  const phoneOwners = buildPhoneOwnerMap(allBrokers, planModule);
  const contactOwners = buildContactOwnerMap(allBrokers);

  if (resolvedContactIds.size !== records.length) {
    fail("FINAL_CONTACT_SET_INCOMPLETE");
  }
  for (const record of records) {
    const brokerId = String(record.broker.id);
    const expectedContactId = positiveInteger(resolvedContactIds.get(brokerId));
    const broker = brokerById.get(brokerId);
    if (
      !expectedContactId ||
      !broker ||
      broker.mergedIntoId ||
      positiveInteger(broker.amoContactId) !== expectedContactId ||
      JSON.stringify(brokerPhones(broker, planModule)) !==
        JSON.stringify(record.phones)
    ) {
      fail("FINAL_BROKER_LINK_INVALID");
    }
    for (const phone of record.phones) {
      const owners = phoneOwners.get(phone);
      if (!owners || owners.size !== 1 || !owners.has(brokerId)) {
        fail("FINAL_PHONE_OWNERSHIP_INVALID");
      }
    }
    const owners = contactOwners.get(expectedContactId) || new Set();
    if (owners.size !== 1 || !owners.has(brokerId)) {
      fail("FINAL_CONTACT_OWNERSHIP_INVALID");
    }
    const currentRecordQueue = record.queueRows
      .map((row) => queueById.get(String(row.id)))
      .filter(Boolean);
    if (queueSnapshot(currentRecordQueue) !== record.queueSnapshot) {
      fail("FINAL_QUEUE_STATE_DRIFT");
    }
    const lookups = await lookupPhones(record.phones, requestGet, planModule);
    const contacts = collectExactContacts(record.phones, lookups);
    if (
      contacts.length !== 1 ||
      contacts[0].contactId !== expectedContactId ||
      !contacts[0].brokerFlag
    ) {
      fail("FINAL_AMO_CONTACT_INVALID");
    }
  }
}

async function linkBrokerContactCas({
  prisma,
  record,
  contactId,
  planModule,
  sourceSha,
  reviewedPlanRunId,
}) {
  const queueIds = record.queueRows.map((row) => row.id);
  return prisma.$transaction(
    async (tx) => {
      await acquireAmoBrokerContactAdvisoryXactLock(
        tx,
        record.broker.id,
        record.broker.phone,
      );
      const [currentBroker, currentQueueRows, allBrokers] = await Promise.all([
        tx.broker.findUnique({
          where: { id: record.broker.id },
          select: BROKER_PROVISION_SELECT,
        }),
        tx.client.findMany({
          where: { id: { in: queueIds } },
          select: QUEUE_CAS_SELECT,
          orderBy: { id: "asc" },
        }),
        tx.broker.findMany({
          select: BROKER_OWNER_SELECT,
          orderBy: { id: "asc" },
        }),
      ]);
      assertCurrentDatabaseInvariants({
        record,
        currentBroker,
        currentQueueRows,
        allBrokers,
        contactId,
        planModule,
      });
      const updated = await tx.broker.updateMany({
        where: {
          id: record.broker.id,
          amoContactId: null,
          mergedIntoId: null,
        },
        data: { amoContactId: BigInt(contactId) },
      });
      if (updated?.count !== 1) fail("BROKER_CAS_UPDATE_MISSED");
      await tx.auditLog.create({
        data: {
          userId: null,
          action: "AMO_BROKER_CONTACT_PROVISIONED",
          entity: "Broker",
          entityId: record.broker.id,
          payload: {
            source: "production_amo_broker_contact_provisioner",
            sourceSha,
            reviewedPlanRunId,
            historicalCountEvidenceRunId: HISTORICAL_COUNT_EVIDENCE_RUN_ID,
            resolution: record.resolution,
            amoContactId: String(contactId),
            queueRowsObserved: record.queueRows.length,
            clientsMutated: false,
            retriesRun: false,
          },
        },
      });
      return { linked: true };
    },
    {
      isolationLevel: "Serializable",
      maxWait: LOCK_TIMEOUT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    },
  );
}

async function provisionAndLinkBrokerContact({
  prisma,
  record,
  requestGet,
  mutateOnce,
  planModule,
  sourceSha,
  reviewedPlanRunId,
  sleepImpl,
  requestIdFactory,
}) {
  const queueIds = record.queueRows.map((row) => row.id);
  let durableCreateGateId = null;
  let observedGateId = null;
  let result;
  try {
    result = await prisma.$transaction(
      async (tx) => {
        activeFailurePhase = FAILURE_PHASE.PREFLIGHT;
        await acquireAmoBrokerContactAdvisoryXactLock(
          tx,
          record.broker.id,
          record.broker.phone,
        );
        const before = await readCurrentGroupState(tx, record);
        assertCurrentDatabaseInvariants({
          record,
          ...before,
          contactId: record.candidateContactId || Number.MAX_SAFE_INTEGER,
          planModule,
        });

        // Read through a fresh autocommit snapshot after the advisory waiter has
        // acquired the phone lock. Never trust the long Serializable snapshot.
        observedGateId = await hasUnresolvedAmoBrokerContactCreate(
          prisma,
          before.currentBroker.phone,
        );
        let contactId;
        if (
          observedGateId &&
          record.resolution === "create_contact_candidate"
        ) {
          const recoveryLookups = await lookupPhones(
            record.phones,
            requestGet,
            planModule,
          );
          const recoveryContacts = collectExactContacts(
            record.phones,
            recoveryLookups,
          );
          if (
            recoveryContacts.length !== 1 ||
            !recoveryContacts[0].brokerFlag
          ) {
            fail("AMO_CREATE_UNCERTAIN_MARKER_PRESENT");
          }
          contactId = recoveryContacts[0].contactId;
        } else {
          contactId = await provisionAmoContact({
            record,
            broker: before.currentBroker,
            requestGet,
            mutateOnce,
            planModule,
            sleepImpl,
            requestIdFactory,
            beforeCreateMutation: async () => {
              durableCreateGateId = await armDurableAmoBrokerContactCreateGate(
                prisma,
                before.currentBroker.phone,
                sourceSha,
                reviewedPlanRunId,
              );
            },
          });
        }

        activeFailurePhase = FAILURE_PHASE.DATABASE_CAS;
        const [currentBroker, currentQueueRows, allBrokers] = await Promise.all(
          [
            tx.broker.findUnique({
              where: { id: record.broker.id },
              select: BROKER_PROVISION_SELECT,
            }),
            tx.client.findMany({
              where: { id: { in: queueIds } },
              select: QUEUE_CAS_SELECT,
              orderBy: { id: "asc" },
            }),
            tx.broker.findMany({
              select: BROKER_OWNER_SELECT,
              orderBy: { id: "asc" },
            }),
          ],
        );
        assertCurrentDatabaseInvariants({
          record,
          currentBroker,
          currentQueueRows,
          allBrokers,
          contactId,
          planModule,
        });
        const updated = await tx.broker.updateMany({
          where: {
            id: record.broker.id,
            amoContactId: null,
            mergedIntoId: null,
          },
          data: { amoContactId: BigInt(contactId) },
        });
        if (updated?.count !== 1) fail("BROKER_CAS_UPDATE_MISSED");
        await tx.auditLog.create({
          data: {
            userId: null,
            action: "AMO_BROKER_CONTACT_PROVISIONED",
            entity: "Broker",
            entityId: record.broker.id,
            payload: {
              source: "production_amo_broker_contact_provisioner",
              sourceSha,
              reviewedPlanRunId,
              historicalCountEvidenceRunId: HISTORICAL_COUNT_EVIDENCE_RUN_ID,
              resolution: record.resolution,
              amoContactId: String(contactId),
              queueRowsObserved: record.queueRows.length,
              clientsMutated: false,
              retriesRun: false,
            },
          },
        });
        return contactId;
      },
      {
        isolationLevel: "Serializable",
        maxWait: LOCK_TIMEOUT_MS,
        timeout: TRANSACTION_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (durableCreateGateId && error?.code === "AMO_CREATE_REJECTED") {
      await recordResolvedAmoBrokerContactCreate(
        prisma,
        record.broker.phone,
        durableCreateGateId,
      );
      durableCreateGateId = null;
    }
    throw error;
  }
  const gateToResolve = durableCreateGateId || observedGateId;
  if (gateToResolve) {
    await recordResolvedAmoBrokerContactCreate(
      prisma,
      record.broker.phone,
      gateToResolve,
    );
  }
  return result;
}

async function reconcileAlreadyLinkedCreateGate({
  prisma,
  record,
  requestGet,
  planModule,
}) {
  let observedGateId = null;
  await prisma.$transaction(
    async (tx) => {
      await acquireAmoBrokerContactAdvisoryXactLock(
        tx,
        record.broker.id,
        record.broker.phone,
      );
      observedGateId = await hasUnresolvedAmoBrokerContactCreate(
        prisma,
        record.broker.phone,
      );
      if (!observedGateId) return;
      const current = await tx.broker.findUnique({
        where: { id: record.broker.id },
        select: BROKER_PROVISION_SELECT,
      });
      const expectedId = positiveInteger(current?.amoContactId);
      if (!expectedId || current?.mergedIntoId)
        fail("ALREADY_LINKED_GATE_DB_DRIFT");
      const lookups = await lookupPhones(record.phones, requestGet, planModule);
      const contacts = collectExactContacts(record.phones, lookups);
      if (
        contacts.length !== 1 ||
        contacts[0].contactId !== expectedId ||
        !contacts[0].brokerFlag
      ) {
        fail("ALREADY_LINKED_GATE_AMO_NOT_CONFIRMED");
      }
    },
    {
      isolationLevel: "Serializable",
      maxWait: LOCK_TIMEOUT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    },
  );
  if (observedGateId) {
    await recordResolvedAmoBrokerContactCreate(
      prisma,
      record.broker.phone,
      observedGateId,
    );
  }
}

async function loadProductionState(prisma) {
  const queueRows = await prisma.client.findMany({
    where: {
      amoSyncStatus: { in: QUEUE_STATUSES },
      amoSyncAttempts: { gte: ATTEMPT_LIMIT },
    },
    select: QUEUE_ROW_SELECT,
    orderBy: [
      { amoSyncLastAttemptAt: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });
  const allBrokers = await prisma.broker.findMany({
    select: BROKER_OWNER_SELECT,
    orderBy: { id: "asc" },
  });
  return { queueRows, allBrokers };
}

async function assertDatabasePoolSupportsDurableGate(prisma) {
  await prisma.$transaction(
    async (tx) => {
      const first = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      let poolTimer;
      let second;
      try {
        second = await Promise.race([
          prisma.$queryRaw`SELECT pg_backend_pid() AS pid`,
          new Promise((_, reject) => {
            poolTimer = setTimeout(
              () =>
                reject(
                  new ProvisioningFailure(
                    "DATABASE_POOL_CAPACITY_INSUFFICIENT",
                  ),
                ),
              5_000,
            );
          }),
        ]);
      } finally {
        if (poolTimer) clearTimeout(poolTimer);
      }
      const firstPid = Number(first?.[0]?.pid);
      const secondPid = Number(second?.[0]?.pid);
      if (
        !positiveInteger(firstPid) ||
        !positiveInteger(secondPid) ||
        firstPid === secondPid
      ) {
        fail("DATABASE_POOL_CAPACITY_INSUFFICIENT");
      }
    },
    { maxWait: 2_000, timeout: 8_000 },
  );
}

async function main() {
  activeFailurePhase = FAILURE_PHASE.GATE;
  activeFailureStage = FAILURE_STAGE.NOT_APPLICABLE;
  const gate = readExecutionGate();
  const planModule = loadPlanModule(undefined, gate.inspectorSha256);
  activeAmoFailureClassifier = planModule.classifyFailure;
  let cohortAttestationKey;
  try {
    cohortAttestationKey = planModule.readCohortAttestationKeyFile(
      process.env.BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE,
    );
  } catch {
    fail("COHORT_ATTESTATION_KEY_FILE_INVALID");
  }
  delete process.env.BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE;
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient({
    datasources: {
      db: { url: buildWriteDatabaseUrl(process.env.DATABASE_URL) },
    },
  });
  const reportKey = randomBytes(32);

  try {
    activeFailurePhase = FAILURE_PHASE.DATABASE;
    activeFailureStage = FAILURE_STAGE.NOT_APPLICABLE;
    amoBrokerContactGateDigest("+70000000000");
    await assertProductionDatabase(prisma);
    await assertDatabasePoolSupportsDurableGate(prisma);
    const { queueRows, allBrokers } = await loadProductionState(prisma);

    activeFailurePhase = FAILURE_PHASE.ACCOUNT;
    activeFailureStage = FAILURE_STAGE.NOT_APPLICABLE;
    const requestGet = planModule.createGetOnlyRequester(
      process.env.AMO_ACCESS_TOKEN,
    );
    await planModule.assertExpectedAccount(requestGet);

    activeFailurePhase = FAILURE_PHASE.PLAN;
    activeFailureStage = FAILURE_STAGE.NOT_APPLICABLE;
    const lookups = new Map();
    for (const phone of planModule.requiredLookupPhones(
      queueRows,
      allBrokers,
    )) {
      lookups.set(
        phone,
        await planModule.lookupExactContacts(requestGet, phone),
      );
    }
    const cohortAttestation = planModule.buildCohortAttestation(
      queueRows,
      allBrokers,
      lookups,
      cohortAttestationKey,
      gate.inspectorSha256,
      gate.deployedGitSha,
    );
    cohortAttestationKey.fill(0);
    assertExpectedCohortAttestation(cohortAttestation, gate);
    const report = planModule.buildProvisioningReport(
      queueRows,
      allBrokers,
      lookups,
      new Date(),
      reportKey,
    );
    const actualManifest = reportManifest(report);
    assertExactManifest(actualManifest, gate.expected);

    const records = buildInternalProvisioningPlan(
      queueRows,
      allBrokers,
      lookups,
      planModule,
    );
    assertExactManifest(
      internalPlanManifest(records, queueRows.length),
      actualManifest,
    );
    assertReviewedRunManifest(actualManifest);
    assertReviewedRunCeilings(actualManifest);
    assertExecutablePlan(records, planModule);
    // Open create gates are recovered later under the same phone lock through
    // exact GET confirmation; they must not be blanket-rejected here.

    // Recheck every group before the first mutation so a stale source row,
    // queue drift or amo ambiguity stops the whole run before partial apply.
    activeFailurePhase = FAILURE_PHASE.PREFLIGHT;
    const resolvedContactIds = new Map();
    for (const record of records) {
      if (record.resolution === "already_linked") {
        await assertAlreadyLinkedRecord(prisma, record, requestGet, planModule);
        resolvedContactIds.set(
          String(record.broker.id),
          positiveInteger(record.broker.amoContactId),
        );
      } else if (ACTIONABLE_RESOLUTIONS.has(record.resolution)) {
        activeFailureStage = FAILURE_STAGE.GLOBAL_ACTIONABLE_DATABASE;
        await assertDatabasePreflight(prisma, record, planModule);
        activeFailureStage = FAILURE_STAGE.GLOBAL_ACTIONABLE_AMO;
        const preflightLookups = await lookupPhones(
          record.phones,
          requestGet,
          planModule,
        );
        const preflightContacts = collectExactContacts(
          record.phones,
          preflightLookups,
        );
        activeFailureStage = FAILURE_STAGE.GLOBAL_ACTIONABLE_GATE;
        const recoveryGateId =
          record.resolution === "create_contact_candidate"
            ? await hasUnresolvedAmoBrokerContactCreate(
                prisma,
                record.broker.phone,
              )
            : null;
        if (recoveryGateId) {
          if (
            preflightContacts.length > 1 ||
            (preflightContacts.length === 1 && !preflightContacts[0].brokerFlag)
          ) {
            fail("AMO_CREATE_GATE_PREFLIGHT_AMBIGUOUS");
          }
        } else {
          activeFailureStage = FAILURE_STAGE.GLOBAL_ACTIONABLE_AMO;
          assertAmoPrecondition(record, preflightContacts);
        }
      }
    }

    const mutateOnce = createOneShotMutationRequester(
      process.env.AMO_ACCESS_TOKEN,
      planModule,
    );
    for (const record of records.filter(
      (candidate) => candidate.resolution === "already_linked",
    )) {
      activeFailureStage = FAILURE_STAGE.ALREADY_LINKED_GATE_RECONCILIATION;
      await reconcileAlreadyLinkedCreateGate({
        prisma,
        record,
        requestGet,
        planModule,
      });
    }
    const actionable = records
      .filter((record) => ACTIONABLE_RESOLUTIONS.has(record.resolution))
      .map((record) => ({
        ...record,
        brokerHash: reportAlias("broker", record.broker.id, reportKey),
      }))
      .sort((left, right) => {
        const classOrder =
          RESOLUTION_ORDER.get(left.resolution) -
          RESOLUTION_ORDER.get(right.resolution);
        return classOrder || left.brokerHash.localeCompare(right.brokerHash);
      });

    let index = 0;
    for (const record of actionable) {
      index += 1;
      writeSafeEvent({
        event: "broker_contact_provisioning_started",
        brokerHash: record.brokerHash,
        resolution: record.resolution,
        index,
        total: actionable.length,
      });

      activeFailurePhase = FAILURE_PHASE.PREFLIGHT;
      activeFailureStage = FAILURE_STAGE.ACTIONABLE_LOCKED_EXECUTION;
      const contactId = await provisionAndLinkBrokerContact({
        prisma,
        record,
        requestGet,
        mutateOnce,
        planModule,
        sourceSha: gate.sourceSha,
        reviewedPlanRunId: gate.reviewedPlanRunId,
      });
      resolvedContactIds.set(String(record.broker.id), contactId);
      if (record.resolution === "link_existing_broker_contact") {
        safeProgress.groupsLinked += 1;
      } else if (record.resolution === "promote_existing_contact_candidate") {
        safeProgress.groupsPromoted += 1;
      } else {
        safeProgress.groupsCreated += 1;
      }
      writeSafeEvent({
        event: "broker_contact_provisioning_completed",
        brokerHash: record.brokerHash,
        resolution: record.resolution,
        index,
        total: actionable.length,
      });
    }

    activeFailurePhase = FAILURE_PHASE.PREFLIGHT;
    activeFailureStage = FAILURE_STAGE.FINAL_POSTCONDITION;
    await assertFinalPostcondition({
      prisma,
      records,
      resolvedContactIds,
      requestGet,
      planModule,
    });

    activeFailurePhase = FAILURE_PHASE.REPORT;
    activeFailureStage = FAILURE_STAGE.NOT_APPLICABLE;
    writeSafeEvent({
      event: "broker_contact_provisioning_succeeded",
      schemaVersion: 1,
      sourceSha: gate.sourceSha,
      queueRows: actualManifest.queueRows,
      effectiveBrokerGroups: actualManifest.effectiveBrokerGroups,
      groupsLinked: safeProgress.groupsLinked,
      groupsPromoted: safeProgress.groupsPromoted,
      groupsCreated: safeProgress.groupsCreated,
      alreadyLinked: actualManifest.groups.already_linked,
    });
  } finally {
    cohortAttestationKey.fill(0);
    await prisma.$disconnect();
  }
}

module.exports = {
  ACTIONABLE_RESOLUTIONS,
  AMO_BROKER_CONTACT_LOCK_DOMAIN,
  AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION,
  AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
  AMO_CONTACT_FIELDS,
  BLOCKED_RESOLUTIONS,
  BROKER_OWNER_SELECT,
  BROKER_PROVISION_SELECT,
  EXACT_CONFIRMATION,
  FAILURE_STAGE,
  HISTORICAL_COUNT_EVIDENCE_RUN_ID,
  QUEUE_CAS_SELECT,
  QUEUE_ROW_SELECT,
  REVIEWED_RUN_MANIFEST,
  RESOLUTION_CLASSES,
  ProvisioningFailure,
  acquireAmoBrokerContactAdvisoryXactLock,
  amoBrokerContactGateDigest,
  amoBrokerContactAdvisoryLockKey,
  assertExpectedCohortAttestation,
  assertNoUnresolvedCreateMarkers,
  assertAmoPrecondition,
  assertAlreadyLinkedRecord,
  assertCurrentDatabaseInvariants,
  assertDatabasePoolSupportsDurableGate,
  assertExactManifest,
  assertExecutablePlan,
  assertFinalPostcondition,
  assertReviewedRunCeilings,
  assertReviewedRunManifest,
  brokerPhones,
  brokerSourceSnapshot,
  buildBrokerCreatePayload,
  buildInternalProvisioningPlan,
  buildWriteDatabaseUrl,
  canonicalMutationUrl,
  collectExactContacts,
  createOneShotMutationRequester,
  extractCreatedContactId,
  internalPlanManifest,
  injectGateHmacKeyForTests,
  linkBrokerContactCas,
  loadPlanModule,
  normalizeAmoBrokerContactLockPhone,
  positiveInteger,
  primaryAgency,
  promotionPayload,
  provisionAmoContact,
  provisionAndLinkBrokerContact,
  reconcileAlreadyLinkedCreateGate,
  queueSnapshot,
  readExecutionGate,
  reconcileUniqueBrokerContact,
  reportManifest,
  safeFailureCode,
  safeFailureStage,
  validateMutationRequest,
};

if (require.main === module) {
  main().catch((error) => {
    writeSafeEvent({
      event: "broker_contact_provisioning_failed",
      failurePhase: activeFailurePhase,
      failureStage: safeFailureStage(activeFailureStage),
      failureCode: safeFailureCode(error),
      groupsLinked: safeProgress.groupsLinked,
      groupsPromoted: safeProgress.groupsPromoted,
      groupsCreated: safeProgress.groupsCreated,
    });
    process.exitCode = 1;
  });
}
