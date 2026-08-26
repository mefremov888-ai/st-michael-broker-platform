#!/usr/bin/env node
/**
 * Exact-cohort, PII-safe, GET-only plan for the twelve exhausted amo fixation
 * rows. The executable apply regenerates this plan under the same HMAC key;
 * this script never authorizes or performs a mutation.
 */
"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { isAbsolute } = require("node:path");
const { lstatSync, readFileSync } = require("node:fs");
const core = require("./amo-deadletter-group-recovery-core");
const legacyInspector = require("./inspect-amo-fixation-lead-reconciliation");

const BROKER_SELECT = Object.freeze({
  id: true,
  phone: true,
  fullName: true,
  email: true,
  amoContactId: true,
  mergedIntoId: true,
  updatedAt: true,
  brokerAgencies: {
    select: { id: true, agencyId: true, joinedAt: true, isPrimary: true },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
  },
});

const QUEUE_SELECT = Object.freeze({
  id: true,
  brokerId: true,
  responsibleBrokerId: true,
  phone: true,
  fullName: true,
  email: true,
  comment: true,
  project: true,
  fixationAgencyId: true,
  propertyType: true,
  roomsCount: true,
  amount: true,
  sqm: true,
  clientRegion: true,
  purchaseTiming: true,
  readinessLevel: true,
  createdAt: true,
  updatedAt: true,
  amoLeadId: true,
  amoSyncStatus: true,
  amoSyncAttempts: true,
  amoSyncLastAttemptAt: true,
  amoSyncError: true,
  broker: { select: BROKER_SELECT },
  responsibleBroker: { select: BROKER_SELECT },
});

const CONTACT_PHONE_FIELD_ID = 557903;
const CONTACT_BROKER_FIELD_ID = 835415;

function ownSha256(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function readSecretFile(pathname) {
  if (typeof pathname !== "string" || !pathname || !isAbsolute(pathname)) {
    core.fail("ATTESTATION_KEY_FILE_INVALID");
  }
  let stat;
  try {
    stat = lstatSync(pathname);
  } catch {
    core.fail("ATTESTATION_KEY_FILE_INVALID");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 32 ||
    stat.size > 4096
  ) {
    core.fail("ATTESTATION_KEY_FILE_INVALID");
  }
  const key = readFileSync(pathname);
  if (key.length < 32) core.fail("ATTESTATION_KEY_INVALID");
  return key;
}

async function loadExactQueue(prisma) {
  const rows = await prisma.client.findMany({
    where: {
      amoLeadId: null,
      amoSyncStatus: { in: core.QUEUE_STATUSES },
      amoSyncAttempts: { gte: core.ATTEMPT_LIMIT },
    },
    select: QUEUE_SELECT,
    orderBy: [
      { amoSyncLastAttemptAt: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    take: core.EXPECTED_QUEUE_ROWS + 1,
  });
  if (rows.length !== core.EXPECTED_QUEUE_ROWS)
    core.fail("QUEUE_ROW_COUNT_CHANGED");
  return rows;
}

async function loadAgencies(prisma, rows) {
  const ids = new Set();
  for (const row of rows) {
    if (row.fixationAgencyId) ids.add(String(row.fixationAgencyId));
    for (const membership of row.broker?.brokerAgencies || []) {
      if (membership.agencyId) ids.add(String(membership.agencyId));
    }
  }
  const agencies = ids.size
    ? await prisma.agency.findMany({
        where: { id: { in: [...ids].sort() } },
        select: { id: true, name: true, inn: true, updatedAt: true },
        orderBy: { id: "asc" },
      })
    : [];
  return new Map(agencies.map((agency) => [String(agency.id), agency]));
}

function contactFieldValues(contact, fieldId) {
  const fields = Array.isArray(contact?.custom_fields_values)
    ? contact.custom_fields_values
    : [];
  const field = fields.find(
    (candidate) =>
      Number(candidate?.field_id) === fieldId ||
      (fieldId === CONTACT_PHONE_FIELD_ID && candidate?.field_code === "PHONE"),
  );
  return Array.isArray(field?.values) ? field.values : [];
}

function contactPhoneMatches(contact, phone) {
  const target = core.normalizePhone(phone);
  return Boolean(
    target &&
    contactFieldValues(contact, CONTACT_PHONE_FIELD_ID).some(
      (item) => core.normalizePhone(item?.value) === target,
    ),
  );
}

function contactHasBrokerFlag(contact) {
  return contactFieldValues(contact, CONTACT_BROKER_FIELD_ID).some(
    (item) => item?.value === true || item?.value === 1 || item?.value === "1",
  );
}

async function collectBrokerEvidence(prisma, rows, request) {
  const brokers = new Map();
  for (const row of rows) {
    for (const broker of [row.broker, row.responsibleBroker]) {
      if (broker?.id) brokers.set(String(broker.id), broker);
    }
  }
  const selectedContactIds = [
    ...new Set(
      [...brokers.values()]
        .map((broker) => core.positiveInteger(broker.amoContactId))
        .filter(Boolean),
    ),
  ].sort((left, right) => left - right);
  // Broker.amoContactId is unique in the schema, but the signed evidence also
  // binds the live database occupancy rather than assuming migrations and the
  // production constraint cannot have drifted.
  const allOwners = selectedContactIds.length
    ? await prisma.broker.findMany({
        where: { amoContactId: { in: selectedContactIds.map(BigInt) } },
        select: { id: true, amoContactId: true },
        orderBy: { id: "asc" },
      })
    : [];
  const contactOwners = new Map();
  for (const owner of allOwners) {
    const contactId = core.positiveInteger(owner.amoContactId);
    if (!contactId) core.fail("BROKER_CONTACT_OWNER_INVALID");
    if (!contactOwners.has(contactId)) contactOwners.set(contactId, new Set());
    contactOwners.get(contactId).add(String(owner.id));
  }
  const evidence = new Map();
  for (const [brokerId, broker] of [...brokers.entries()].sort()) {
    const contactId = core.positiveInteger(broker.amoContactId);
    if (!contactId) {
      evidence.set(brokerId, {
        contactId: null,
        exactPhone: false,
        brokerFlag: false,
        occupiedByOtherBroker: false,
      });
      continue;
    }
    const contact = await request(`/api/v4/contacts/${contactId}`);
    if (!contact || core.positiveInteger(contact.id) !== contactId) {
      core.fail("BROKER_CONTACT_GET_INVALID");
    }
    const owners = contactOwners.get(contactId) || new Set();
    evidence.set(brokerId, {
      contactId,
      exactPhone: contactPhoneMatches(contact, broker.phone),
      brokerFlag: contactHasBrokerFlag(contact),
      occupiedByOtherBroker: [...owners].some((owner) => owner !== brokerId),
    });
  }
  return evidence;
}

async function enrichClientContactRoleEvidence(prisma, amoEvidence, request) {
  const contactIds = [
    ...new Set(
      [...amoEvidence.byPhone.values()].flatMap(
        (evidence) => evidence.exactContactIds || [],
      ),
    ),
  ].sort((left, right) => left - right);
  const occupied = contactIds.length
    ? await prisma.broker.findMany({
        where: { amoContactId: { in: contactIds.map(BigInt) } },
        select: { amoContactId: true },
      })
    : [];
  const occupiedIds = new Set(
    occupied
      .map((broker) => core.positiveInteger(broker.amoContactId))
      .filter(Boolean),
  );
  const brokerFlagged = new Set();
  for (const contactId of contactIds) {
    const contact = await request(`/api/v4/contacts/${contactId}`);
    if (!contact || core.positiveInteger(contact.id) !== contactId) {
      core.fail("CLIENT_CONTACT_ROLE_GET_INVALID");
    }
    if (contactHasBrokerFlag(contact)) brokerFlagged.add(contactId);
  }
  for (const evidence of amoEvidence.byPhone.values()) {
    evidence.exactContactRoleCollision = evidence.exactContactIds.some(
      (id) => brokerFlagged.has(id) || occupiedIds.has(id),
    );
  }
}

function assertCompleteAmoEvidence(rows, amoEvidence) {
  if (
    !amoEvidence?.byPhone ||
    typeof amoEvidence.byPhone.get !== "function" ||
    typeof amoEvidence.byPhone.has !== "function" ||
    typeof amoEvidence.byPhone.keys !== "function" ||
    !Number.isSafeInteger(amoEvidence.byPhone.size)
  ) {
    core.fail("AMO_EVIDENCE_INVALID");
  }
  const expectedPhones = [
    ...new Set(
      rows.map((row) => core.normalizePhone(row?.phone)).filter(Boolean),
    ),
  ].sort();
  const actualPhones = [...amoEvidence.byPhone.keys()].sort();
  if (
    amoEvidence?.stats?.normalizedPhones !== expectedPhones.length ||
    actualPhones.length !== expectedPhones.length ||
    actualPhones.some((phone, index) => phone !== expectedPhones[index])
  ) {
    core.fail("AMO_EVIDENCE_PHONE_SET_INCOMPLETE");
  }
  for (const phone of expectedPhones) {
    if (legacyInspector.normalizePhone(phone) !== phone) {
      core.fail("AMO_PHONE_NORMALIZATION_DIVERGED");
    }
    const evidence = amoEvidence.byPhone.get(phone);
    if (
      !evidence ||
      !Array.isArray(evidence.exactContactIds) ||
      !Array.isArray(evidence.leads)
    ) {
      core.fail("AMO_EVIDENCE_INVALID");
    }
  }
}

async function collectPlan({
  prisma,
  request,
  metadata,
  attestationKey,
  reportKey,
}) {
  const rows = await loadExactQueue(prisma);
  // Reuse the already reviewed exhaustive contact/lead traversal. It fails on
  // pagination bounds, reverse-link drift and malformed selected evidence.
  const amoEvidence = await legacyInspector.collectAmoEvidence(rows, request);
  assertCompleteAmoEvidence(rows, amoEvidence);
  await enrichClientContactRoleEvidence(prisma, amoEvidence, request);
  const [agenciesById, brokerEvidence] = await Promise.all([
    loadAgencies(prisma, rows),
    collectBrokerEvidence(prisma, rows, request),
  ]);
  return core.buildPlan({
    rows,
    evidenceByPhone: amoEvidence.byPhone,
    agenciesById,
    brokerEvidence,
    metadata,
    attestationKey,
    reportKey,
  });
}

async function main() {
  const sourceSha = String(process.env.RECOVERY_SOURCE_SHA || "");
  const coreSha256 = String(process.env.RECOVERY_CORE_SHA256 || "");
  const planSha256 = String(process.env.RECOVERY_PLAN_SHA256 || "");
  const legacyInspectorSha256 = String(
    process.env.RECOVERY_LEGACY_INSPECTOR_SHA256 || "",
  );
  if (ownSha256(__filename) !== planSha256)
    core.fail("PLAN_SOURCE_HASH_MISMATCH");
  const corePath = require.resolve("./amo-deadletter-group-recovery-core");
  if (ownSha256(corePath) !== coreSha256)
    core.fail("CORE_SOURCE_HASH_MISMATCH");
  const legacyInspectorPath =
    require.resolve("./inspect-amo-fixation-lead-reconciliation");
  if (ownSha256(legacyInspectorPath) !== legacyInspectorSha256) {
    core.fail("LEGACY_INSPECTOR_SOURCE_HASH_MISMATCH");
  }
  const attestationKey = readSecretFile(
    process.env.RECOVERY_COHORT_ATTESTATION_KEY_FILE,
  );
  const readOnlyUrl = legacyInspector.buildReadOnlyDatabaseUrl(
    process.env.DATABASE_URL,
  );
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient({
    datasources: { db: { url: readOnlyUrl } },
  });
  try {
    await legacyInspector.assertReadOnlySession(prisma);
    const request = legacyInspector.createGetOnlyRequester(
      process.env.AMO_ACCESS_TOKEN,
    );
    await legacyInspector.assertExpectedAccount(request);
    const plan = await collectPlan({
      prisma,
      request,
      metadata: {
        sourceSha,
        coreSha256,
        planSha256,
        legacyInspectorSha256,
      },
      attestationKey,
      reportKey: randomBytes(32),
    });
    process.stdout.write(`${JSON.stringify(plan.publicReport, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  BROKER_SELECT,
  CONTACT_BROKER_FIELD_ID,
  CONTACT_PHONE_FIELD_ID,
  QUEUE_SELECT,
  assertCompleteAmoEvidence,
  collectBrokerEvidence,
  enrichClientContactRoleEvidence,
  collectPlan,
  contactFieldValues,
  contactHasBrokerFlag,
  contactPhoneMatches,
  loadAgencies,
  loadExactQueue,
  ownSha256,
  readSecretFile,
};

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({
        event: "amo_deadletter_group_recovery_plan_failed",
        schemaVersion: 1,
        failureCode: String(error?.code || error?.message || "UNKNOWN_FAILURE")
          .replace(/[^A-Z0-9_]/g, "_")
          .slice(0, 96),
        piiEmitted: false,
      })}\n`,
    );
    process.exitCode = 1;
  });
}
