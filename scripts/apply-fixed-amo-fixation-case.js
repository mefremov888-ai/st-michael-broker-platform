"use strict";

// REVIEW DRAFT: deliberately no CLI entry point and no workflow. A reviewed
// protected wrapper must supply and continuously attest the existing exclusive
// production lock. Importing this module performs no database/network writes.
const { createHash, randomBytes } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const inspector = require("./inspect-fixed-amo-fixation-case");
const helpers = require("./inspect-amo-fixation-lead-reconciliation");
const leaseModule = require("./apply-amo-deadletter-group-recovery");
const certificateModule = require("./fixed-amo-case-exclusion-certificate");
// This physical staged module is byte-attested by the runner before this file
// is imported. Never fall back to package resolution from /tmp.
const stagedPhoneLockModule = require("../packages/integrations/dist/amo-fixation-phone-lock.js");

const CLIENT_ID = "8d082b21-7cba-4778-a6c6-1d80bfe7ed7c";
const OWNER_ID = "6e414141-f2ca-4c71-8402-2032c9186568";
const OPERATION_KEY = `fixed-amo-fixation-case:v1:${CLIENT_ID}`;
const ENTITY = "AmoFixedCaseRecovery";
const MARKER = `AMO_CREATE_RECONCILIATION_REQUIRED:FIXED_CASE_RECOVERY:${CLIENT_ID}`;
const CONFIRMATION = "RECOVER_APPROVED_FIXED_AMO_CASE_ONCE";
const PLAN_CONFIRMATION = "PLAN_FIXED_AMO_CASE_READONLY";
const RECOVERY_UUID = "7a8d216e-1637-43eb-985b-19b75fd2b9ed";
const RECOVERY_SOURCE = "st-michael-fixed-amo-case-recovery-v1";
const MAX_EVIDENCE_AGE_MS = 60_000;
const MAX_REQUESTS = 80;
// The reviewed, failed 11 October operation made zero provider writes and
// left no recovery claim. Its finally block alone installed this 24h guard.
const ZERO_POST_FAILURE_RUN_ID = "38150838032";
const ABANDONED_LEASE_EXPIRES_AT = Date.parse("2026-10-12T15:22:30.000Z");
const REPLACE_ABANDONED_UNCERTAIN = [
  "-- fixed-case:replace-reviewed-zero-post-uncertain",
  "local raw = redis.call('GET', KEYS[1])",
  "if raw ~= ARGV[1] then return 0 end",
  "local ok, current = pcall(cjson.decode, raw)",
  "if not ok or current.status ~= 'uncertain' then return 0 end",
  "local ttl = redis.call('PTTL', KEYS[1])",
  "if ttl <= 0 or ttl > tonumber(ARGV[4]) then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])",
  "return 1",
].join("\n");
const PHASES = Object.freeze(["CLAIMED", "CONTACT_ARMED", "CONTACT_RESOLVED", "LEAD_ARMED", "LEAD_RESOLVED", "LINKED", "UNRESOLVED"]);
const SOURCE_FILES = Object.freeze({
  recovery: __filename,
  certificate: join(__dirname, "fixed-amo-case-exclusion-certificate.js"),
  inspector: join(__dirname, "inspect-fixed-amo-fixation-case.js"),
  reconciliation: join(__dirname, "inspect-amo-fixation-lead-reconciliation.js"),
  lease: join(__dirname, "apply-amo-deadletter-group-recovery.js"),
  leaseCore: join(__dirname, "amo-deadletter-group-recovery-core.js"),
  leasePlan: join(__dirname, "inspect-amo-deadletter-group-recovery-plan.js"),
  adapter: join(__dirname, "../packages/integrations/dist/amo-crm.adapter.js"),
  fields: join(__dirname, "../packages/integrations/dist/amo-crm.fields.js"),
  touches: join(__dirname, "../packages/integrations/dist/amo-crm.touches.js"),
  phoneLock: join(__dirname, "../packages/integrations/dist/amo-fixation-phone-lock.js"),
  traffic: join(__dirname, "../packages/integrations/dist/amo-traffic-light.js"),
});
const CLIENT_SELECT = {
  ...inspector.CLIENT_SELECT, email: true, comment: true, uniquenessReason: true,
  inspectionActSigned: true, propertyType: true, roomsCount: true, amount: true,
  sqm: true, clientRegion: true, purchaseTiming: true, readinessLevel: true,
  broker: { select: { ...inspector.CLIENT_SELECT.broker.select, fullName: true } },
  responsibleBroker: { select: { ...inspector.CLIENT_SELECT.responsibleBroker.select, fullName: true } },
};

function fail(code) { const error = new Error("Fixed case recovery refused"); error.safeCode = code; throw error; }
const PREFLIGHT_STAGES = Object.freeze(["SNAPSHOT", "ACCOUNT", "EVIDENCE", "CERTIFICATE", "PLAN_BINDING", "PRIOR_AUDIT", "NEGATIVE"]);
async function preflightStep(stage, callback) {
  if (!PREFLIGHT_STAGES.includes(stage) || typeof callback !== "function") fail("EXECUTION_GATE_INVALID");
  try { return await callback(); }
  catch (error) {
    const known = safeFailureCode(error);
    // Preserve a reviewed refusal, but never retain raw transport/Prisma errors.
    // This boundary precedes lease acquisition, durable claim and provider writes.
    fail(known === "RECOVERY_REFUSED" ? `PREFLIGHT_${stage}_FAILED` : known);
  }
}
function id(value) {
  if (typeof value === "bigint") return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? String(entry) : entry)).digest("hex");
}
function projectInspectorRow(value, selection = inspector.CLIENT_SELECT) {
  if (value === null) return null;
  const projected = {};
  for (const [key, select] of Object.entries(selection)) {
    projected[key] = select === true ? value[key] : Array.isArray(value[key])
      ? value[key].map((entry) => projectInspectorRow(entry, select.select))
      : projectInspectorRow(value[key], select.select);
  }
  return projected;
}
function effective(row) {
  inspector.validateCase(projectInspectorRow(row), true);
  if (row.brokerId !== OWNER_ID || row.broker?.id !== OWNER_ID) fail("OWNER_SCOPE_MISMATCH");
  const broker = row.responsibleBrokerId === null ? row.broker : row.responsibleBroker;
  if (!broker || broker.id !== (row.responsibleBrokerId || row.brokerId) || broker.role !== "BROKER" || broker.mergedIntoId !== null || !["ACTIVE", "PENDING"].includes(broker.status) || !id(broker.amoContactId)) fail("RESPONSIBLE_SCOPE_INVALID");
  if (!helpers.normalizePhone(broker.phone) || !row.fixationAgencyId || !broker.brokerAgencies.some((membership) => membership.agencyId === row.fixationAgencyId)) fail("RESPONSIBLE_AGENCY_INVALID");
  inspector.expectedGeneratedName(row);
  return broker;
}
function attestSources(environment) {
  let expected;
  try { expected = JSON.parse(environment.FIXED_CASE_SOURCE_HASHES); } catch { fail("SOURCE_ATTESTATION_INVALID"); }
  if (!expected || Array.isArray(expected) || Object.keys(expected).sort().join() !== Object.keys(SOURCE_FILES).sort().join()) fail("SOURCE_ATTESTATION_INVALID");
  const sources = {};
  for (const [key, path] of Object.entries(SOURCE_FILES)) {
    if (!/^[a-f0-9]{64}$/.test(expected[key] || "")) fail("SOURCE_ATTESTATION_INVALID");
    const text = readFileSync(path, "utf8");
    if (createHash("sha256").update(text).digest("hex") !== expected[key]) fail("SOURCE_ATTESTATION_INVALID");
    sources[key] = text;
  }
  if (expected.inspector !== environment.FIXED_CASE_INSPECTOR_SHA256 || expected.reconciliation !== environment.FIXED_CASE_DEPENDENCY_SHA256) fail("SOURCE_ATTESTATION_INVALID");
  return { sources, hashes: expected };
}
function gate(environment, confirmation, operationLock) {
  inspector.runtimeMetadata(environment);
  if (confirmation !== CONFIRMATION || environment.FIXED_CASE_MODE !== "apply" || environment.NODE_ENV !== "production" || !/^[1-9][0-9]*$/.test(environment.FIXED_CASE_RUN_ID || "") || !/^[1-9][0-9]*$/.test(environment.FIXED_CASE_PLAN_RUN_ID || "") || environment.FIXED_CASE_RUN_ATTEMPT !== "1" || typeof operationLock?.assertOwned !== "function") fail("EXECUTION_GATE_INVALID");
  for (const key of ["FIXED_CASE_EXPECTED_CASE_HASH", "FIXED_CASE_EXPECTED_CANDIDATE_HASH"]) if (!/^[a-f0-9]{64}$/.test(environment[key] || "")) fail("EXECUTION_GATE_INVALID");
  return { runId: environment.FIXED_CASE_RUN_ID, planRunId: environment.FIXED_CASE_PLAN_RUN_ID,
    deployedGitSha: environment.FIXED_CASE_DEPLOYED_GIT_SHA,
    caseHash: environment.FIXED_CASE_EXPECTED_CASE_HASH,
    candidateHash: environment.FIXED_CASE_EXPECTED_CANDIDATE_HASH };
}
function planGate(environment, confirmation, operationLock) {
  inspector.runtimeMetadata(environment);
  if (confirmation !== PLAN_CONFIRMATION || environment.FIXED_CASE_MODE !== "plan" || environment.NODE_ENV !== "production" || !/^[1-9][0-9]*$/.test(environment.FIXED_CASE_RUN_ID || "") || environment.FIXED_CASE_RUN_ATTEMPT !== "1" || typeof operationLock?.assertOwned !== "function") fail("EXECUTION_GATE_INVALID");
  return { runId: environment.FIXED_CASE_RUN_ID, deployedGitSha: environment.FIXED_CASE_DEPLOYED_GIT_SHA };
}
async function identity(tx, environment) {
  const records = await tx.$queryRaw`SELECT current_database() AS database_name, system_identifier::text AS system_identifier, (SELECT count(*)::text FROM public.brokers) AS broker_rows FROM pg_control_system()`;
  const row = Array.isArray(records) && records.length === 1 ? records[0] : null;
  if (!row || row.database_name !== "broker_platform" || row.system_identifier !== environment.PRODUCTION_PG_SYSTEM_IDENTIFIER || !/^[0-9]+$/.test(row.broker_rows || "") || BigInt(row.broker_rows) < BigInt(environment.PRODUCTION_MIN_BROKER_ROWS)) fail("DATABASE_IDENTITY_MISMATCH");
}
async function assertNoOtherPhoneRows(tx, row) {
  const phone = helpers.normalizePhone(row.phone);
  if (!phone) fail("CLIENT_PHONE_SCOPE_INVALID");
  const digits = phone.slice(1);
  const aliases = [digits, `8${digits.slice(1)}`, digits.slice(1), `7${digits}`];
  // Bind private values as SQL parameters; formatting and legacy 77/8/10-digit
  // aliases must not hide another pending/unknown request. This draft cannot
  // recover a phone cohort: ANY other local row requires separate review.
  const matches = await tx.$queryRaw`SELECT id, phone FROM public.clients WHERE regexp_replace(phone, '[^0-9]', '', 'g') = ANY(${aliases}::text[]) LIMIT 101`;
  if (!Array.isArray(matches) || matches.length === 0 || matches.length > 100 || matches.some((entry) => typeof entry?.id !== "string" || helpers.normalizePhone(entry.phone) !== phone) || matches.length !== 1 || matches[0].id !== CLIENT_ID) fail("OTHER_PHONE_CASE_PRESENT");
  await assertNoCausalOldGroupGate(tx, row);
}
async function assertNoCausalOldGroupGate(tx, row) {
  const from = new Date(row.createdAt.getTime() - 120_000);
  const relevant = [leaseModule.ACTIONS.CLAIMED, leaseModule.ACTIONS.CONTACT_ARMED,
    leaseModule.ACTIONS.LEAD_ARMED, leaseModule.ACTIONS.GROUP_AMBIGUOUS, leaseModule.ACTIONS.GROUP_COMPLETED];
  // Old group identities are keyed HMACs. Without their private old key this
  // draft cannot bind them to a phone. Refuse all unresolved *causally possible*
  // gates; do not claim absence of unrelated older global recovery history.
  const records = await tx.auditLog.findMany({ where: { entity: leaseModule.GATE_ENTITY,
    action: { in: relevant }, createdAt: { gte: from } },
    select: { entityId: true, action: true, createdAt: true }, take: 301 });
  if (!Array.isArray(records) || records.length > 300) fail("CAUSAL_RECOVERY_GATE_UNRESOLVED");
  const groups = new Map();
  for (const entry of records) {
    const time = Date.prototype.getTime.call(entry?.createdAt);
    if (!/^[0-9a-f]{64}$/.test(entry?.entityId || "") || !relevant.includes(entry.action) || !Number.isFinite(time) || time < from.getTime()) fail("CAUSAL_RECOVERY_GATE_UNRESOLVED");
    const current = groups.get(entry.entityId) || { lastArmed: 0, completed: 0 };
    if (entry.action === leaseModule.ACTIONS.GROUP_COMPLETED) current.completed = Math.max(current.completed, time);
    else current.lastArmed = Math.max(current.lastArmed, time);
    groups.set(entry.entityId, current);
  }
  if ([...groups.values()].some((entry) => entry.completed === 0 || entry.completed < entry.lastArmed)) fail("CAUSAL_RECOVERY_GATE_UNRESOLVED");
}
async function transaction(prisma, environment, callback, lock = false) {
  return prisma.$transaction(async (tx) => {
    // Lock before the first MVCC read; ordinary client writers and concurrent
    // recovery claims cannot race the final CAS/occupied-lead check.
    if (lock) {
      await tx.$executeRaw`LOCK TABLE clients IN SHARE ROW EXCLUSIVE MODE`;
      await tx.$executeRaw`LOCK TABLE brokers, agencies, broker_agencies IN SHARE MODE`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${OPERATION_KEY}, 0))`;
    }
    await identity(tx, environment);
    return callback(tx);
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 20000 });
}
async function snapshot(prisma, environment, includeToken = false) {
  return transaction(prisma, environment, async (tx) => {
    const row = await tx.client.findUnique({ where: { id: CLIENT_ID }, select: CLIENT_SELECT });
    const broker = effective(row);
    await assertNoOtherPhoneRows(tx, row);
    const agency = await tx.agency.findUnique({ where: { id: row.fixationAgencyId }, select: { id: true, name: true, inn: true, updatedAt: true } });
    if (!agency || agency.id !== row.fixationAgencyId || typeof agency.name !== "string" || !agency.name.trim() || !/^(?:[0-9]{10}|[0-9]{12})$/.test(agency.inn || "")) fail("RESPONSIBLE_AGENCY_INVALID");
    const collisions = await tx.broker.findMany({ where: { amoContactId: broker.amoContactId, id: { not: broker.id } }, select: { id: true }, take: 1 });
    if (collisions.length !== 0) fail("BROKER_CONTACT_OCCUPIED");
    const tokenRow = includeToken ? await tx.systemSetting.findUnique({ where: { key: "AMO_ACCESS_TOKEN" }, select: { value: true } }) : null;
    return { row, agency, token: tokenRow?.value };
  });
}
async function audit(tx, phase, metadata, details = {}) {
  if (!PHASES.includes(phase)) fail("INVALID_PHASE");
  if (!metadata || Object.keys(metadata).sort().join() !== "candidateHash,caseHash,deployedGitSha,planRunId,runId,sourceSha256" || !/^[1-9][0-9]*$/.test(metadata.runId || "") || !/^[1-9][0-9]*$/.test(metadata.planRunId || "") || !/^[0-9a-f]{40}$/.test(metadata.deployedGitSha || "") || !/^[0-9a-f]{64}$/.test(metadata.sourceSha256 || "") || !/^[0-9a-f]{64}$/.test(metadata.caseHash || "") || !/^[0-9a-f]{64}$/.test(metadata.candidateHash || "")) fail("INVALID_AUDIT_DETAILS");
  const allowed = ["contactId", "leadId", "armedAt", "reason", "assignmentNeeded"];
  if (Object.keys(details).some((key) => !allowed.includes(key))) fail("INVALID_AUDIT_DETAILS");
  for (const key of ["contactId", "leadId"]) if (details[key] !== undefined && !id(details[key])) fail("INVALID_AUDIT_DETAILS");
  if (details.armedAt !== undefined && !/^20[0-9]{2}-[0-9TZ:.-]+$/.test(details.armedAt)) fail("INVALID_AUDIT_DETAILS");
  if (details.reason !== undefined && !["CONTACT_UNCONFIRMED", "LEAD_UNCONFIRMED", "CASE_DRIFT", "LEASE_LOST", "UNEXPECTED_FAILURE"].includes(details.reason)) fail("INVALID_AUDIT_DETAILS");
  if (details.assignmentNeeded !== undefined && typeof details.assignmentNeeded !== "boolean") fail("INVALID_AUDIT_DETAILS");
  return tx.auditLog.create({ data: {
    action: `AMO_FIXED_CASE_${phase}`, entity: ENTITY, entityId: CLIENT_ID,
    payload: { schemaVersion: 1, operationKey: OPERATION_KEY, ...metadata, phase, ...details, automaticRetryBlocked: phase !== "LINKED", piiStored: false, directMorekitDispatchAttempted: false },
  } });
}
function cas(row) {
  return { id: CLIENT_ID, brokerId: OWNER_ID, responsibleBrokerId: row.responsibleBrokerId,
    amoLeadId: null, amoSyncStatus: row.amoSyncStatus, amoSyncAttempts: row.amoSyncAttempts,
    amoSyncError: row.amoSyncError, updatedAt: row.updatedAt };
}
async function claim(prisma, environment, expected, metadata) {
  return transaction(prisma, environment, async (tx) => {
    const prior = await tx.auditLog.findMany({ where: { entity: ENTITY, entityId: CLIENT_ID }, select: { action: true, payload: true }, take: 30 });
    if (prior.length !== 0) return { prior: true };
    const row = await tx.client.findUnique({ where: { id: CLIENT_ID }, select: CLIENT_SELECT });
    effective(row);
    await assertNoOtherPhoneRows(tx, row);
    if (fingerprint(row) !== fingerprint(expected.row) || row.amoLeadId !== null || row.amoSyncStatus !== "FAILED" || typeof row.amoSyncError !== "string" || !row.amoSyncError.startsWith("AMO_CREATE_RECONCILIATION_REQUIRED:") || row.amoSyncError.includes("RECOVERY")) fail("CLAIM_STATE_INVALID");
    const result = await tx.client.updateMany({ where: cas(row), data: { amoSyncStatus: "FAILED", amoSyncAttempts: Math.max(10, row.amoSyncAttempts), amoSyncError: MARKER } });
    if (result.count !== 1) fail("CLAIM_CAS_FAILED");
    await audit(tx, "CLAIMED", metadata);
    return { prior: false };
  }, true);
}
async function phase(prisma, environment, expected, metadata, name, details = {}) {
  await transaction(prisma, environment, async (tx) => {
    const current = await tx.client.findUnique({ where: { id: CLIENT_ID }, select: CLIENT_SELECT });
    await assertNoOtherPhoneRows(tx, current);
    if (fingerprint(current) !== fingerprint(expected.row) || current.amoSyncError !== MARKER || current.amoSyncStatus !== "FAILED" || current.amoLeadId !== null) fail("CLAIMED_CASE_DRIFT");
    const prior = await tx.auditLog.findMany({ where: { entity: ENTITY, entityId: CLIENT_ID }, select: { action: true }, take: 30 });
    const expectedPhases = PHASES.slice(0, PHASES.indexOf(name)).map((entry) => `AMO_FIXED_CASE_${entry}`);
    if (name === "UNRESOLVED" || name === "LINKED" || prior.length !== expectedPhases.length || prior.some((entry) => !expectedPhases.includes(entry.action)) || new Set(prior.map((entry) => entry.action)).size !== prior.length) fail("PHASE_ALREADY_ARMED");
    await audit(tx, name, metadata, details);
  }, true);
}
function createCanonicalTransport(token, fetchImpl, state, pace = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (typeof token !== "string" || !token.trim() || typeof fetchImpl !== "function" || typeof pace !== "function") fail("AMO_CONFIGURATION_INVALID");
  return async (endpoint, options = {}) => {
    const method = options.method || "GET";
    if (typeof endpoint !== "string" || !/^\/(?:contacts|leads)(?:\/[1-9][0-9]*)?(?:\/notes)?(?:\?[^#]*)?$/.test(endpoint)) fail("TRANSPORT_SCOPE_INVALID");
    const url = new URL(`/api/v4${endpoint}`, helpers.AMO_ORIGIN);
    if (url.origin !== helpers.AMO_ORIGIN || ++state.requests > MAX_REQUESTS) fail("TRANSPORT_SCOPE_INVALID");
    if (method === "POST" && url.pathname === "/api/v4/contacts") {
      if (state.phase !== "CONTACT_ARMED" || ++state.contactPosts !== 1) fail("POST_LIMIT_EXCEEDED");
    } else if (method === "POST" && url.pathname === "/api/v4/leads") {
      if (state.phase !== "LEAD_ARMED" || ++state.leadPosts !== 1) fail("POST_LIMIT_EXCEEDED");
    } else if (method === "PATCH") {
      if (!state.leadId || url.pathname !== `/api/v4/leads/${state.leadId}` || state.phase !== "LEAD_ARMED" || state.patchPosts !== 0) fail("TRANSPORT_SCOPE_INVALID");
      state.patchPosts = 1;
    } else if (method === "POST") {
      if (!state.leadId || url.pathname !== `/api/v4/leads/${state.leadId}/notes` || state.phase !== "LEAD_ARMED" || state.notePosts !== 0) fail("TRANSPORT_SCOPE_INVALID");
      state.notePosts = 1;
    } else if (method !== "GET") fail("TRANSPORT_SCOPE_INVALID");
    if (method !== "GET" && (typeof options.body !== "string" || Buffer.byteLength(options.body, "utf8") > 131072)) fail("TRANSPORT_BODY_INVALID");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), method === "POST" && url.pathname === "/api/v4/leads" ? 45000 : 15000);
    try {
      // The GET inspector is separately paced to the same 2.5 req/s ceiling.
      // Every canonical request waits once as well, so sequential hand-offs
      // between GET evidence and the four one-shot writes cannot burst amoCRM.
      await pace(400);
      await state.assertMutationGate?.(method);
      const response = await fetchImpl(url, { method, redirect: "error", signal: controller.signal, body: method === "GET" ? undefined : options.body, headers: { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json", Accept: "application/json" } });
      if (response?.status === 204 && (method === "GET" || method === "PATCH")) { await response.body?.cancel?.(); return null; }
      if (response?.ok !== true) fail("AMO_REQUEST_UNCONFIRMED");
      const value = await helpers.readBoundedJsonResponse(response, controller);
      if (method === "POST" && url.pathname === "/api/v4/leads") {
        const result = value?._embedded?.leads;
        if (!Array.isArray(result) || result.length !== 1 || !id(result[0]?.id)) fail("AMO_REQUEST_UNCONFIRMED");
        state.leadId = result[0].id;
      }
      return value;
    } catch { fail("AMO_REQUEST_UNCONFIRMED"); }
    finally { clearTimeout(timeout); }
  };
}
function recoveryAgencyTag(agency) {
  return fingerprint({ id: agency.id, name: agency.name, inn: agency.inn,
    updatedAt: Date.prototype.toISOString.call(agency.updatedAt) });
}
function decorateRecoveryNote(text, agency) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 120000) fail("NOTE_PAYLOAD_INVALID");
  return `${text}\n\nCabinet case UUID: ${CLIENT_ID}\nRecovery UUID: ${RECOVERY_UUID}\nRecovery source: ${RECOVERY_SOURCE}\nRecovery agency tag: ${recoveryAgencyTag(agency)}`;
}
function createIsolatedAdapter(sources, request, agency = null) {
  const cache = new Map();
  const names = { "./amo-crm.fields": "fields", "./amo-crm.touches": "touches", "./amo-fixation-phone-lock": "phoneLock", "./amo-traffic-light": "traffic" };
  const load = (name) => {
    if (cache.has(name)) return cache.get(name).exports;
    const target = { exports: {} }; cache.set(name, target);
    const context = vm.createContext({ module: target, exports: target.exports,
      require: (path) => names[path] ? load(names[path]) : ["node:crypto", "node:async_hooks"].includes(path) ? require(path) : fail("ADAPTER_DEPENDENCY_INVALID"),
      process: { env: Object.freeze({ AMO_SUBDOMAIN: "stmichael" }) },
      console: Object.freeze({ log() {}, warn() {}, error() {}, info() {}, debug() {} }),
      Buffer, URL, AbortController, setTimeout, clearTimeout, Date,
    });
    new vm.Script(sources[name], { filename: `reviewed-${name}.js` }).runInContext(context, { timeout: 1000 });
    return target.exports;
  };
  const Adapter = load("adapter").AmoCrmAdapter;
  if (typeof Adapter !== "function") fail("ADAPTER_CONTRACT_INVALID");
  const adapter = new Adapter();
  adapter.request = request;
  // A lost lead POST must not enter adapter best-effort recovery then PATCH.
  // This draft reconciles separately via strict GET-only proof, never resends.
  adapter.createFixationLeadOrRecover = ({ leadData }) => adapter.createLead(leadData);
  if (agency) {
    const addNote = adapter.addNoteToLead.bind(adapter);
    adapter.addNoteToLead = (leadId, text) => addNote(leadId, decorateRecoveryNote(text, agency));
  }
  return adapter;
}
async function freshEvidence(row, request, token, fetchImpl, now) {
  const projected = projectInspectorRow(row);
  const broker = effective(row);
  const brokerContact = await request(`/api/v4/contacts/${id(broker.amoContactId)}`, { with: "leads" });
  if (!brokerContact || brokerContact.id !== id(broker.amoContactId) || !helpers.contactHasExactPhone(brokerContact, helpers.normalizePhone(broker.phone)) || inspector.brokerFlagEvidence(brokerContact).value !== true) fail("BROKER_CONTACT_INVALID");
  const scanNow = now();
  const window = inspector.makeEvidenceWindow(projected, scanNow);
  const expanded = await inspector.collectExpandedEvidence({ row: projected, brokerContact,
    contactEvidence: helpers.collectAmoEvidence([projected], request), request,
    requestWindow: inspector.createKcWindowRequester(token, fetchImpl, window), scanNow });
  return { expanded, brokerContact };
}
async function certificateInput(row, agency, evidence, request, token, fetchImpl) {
  const brokerContactId = id(effective(row).amoContactId);
  let notesResponseStatus = null;
  const notesFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  const notes = inspector.createReviewNotesRequester(token, async (url, options) => {
    const response = await notesFetch(url, options);
    notesResponseStatus = response?.status;
    return response;
  });
  const observedNotes = async () => {
    notesResponseStatus = null;
    const payload = await notes();
    // Pair the literal, source-attested GET with its actual HTTP response.
    // JSON null in an HTTP 200 is malformed evidence, NOT a 204 observation.
    // Errors throw; undefined/malformed 200 bodies remain refused. Preserve
    // 204 provenance in both readbacks/hashes rather than guessing absence.
    if (payload === null && notesResponseStatus !== 204) fail("CERTIFICATE_NOTES_OBSERVATION_INVALID");
    return payload === null ? {
      _embedded: { notes: [] },
      fixedCaseNotesObservation: { coverage: "observed", httpStatus: 204 },
    } : payload;
  };
  const history = inspector.createReviewHistoryRequester(token, fetchImpl);
  const leadFirst = await request(`/api/v4/leads/${inspector.REVIEW_LEAD_ID}`, { with: "contacts" });
  const from = id(leadFirst?.created_at);
  if (!from || !Number.isSafeInteger(evidence?.expanded?.window?.to)) fail("CERTIFICATE_EVIDENCE_INVALID");
  const brokerContactFirst = await request(`/api/v4/contacts/${brokerContactId}`, { with: "leads" });
  const notesFirst = await observedNotes();
  const eventsFirst = await inspector.collectReviewEvents(history, from, evidence.expanded.window.to);
  const leadSecond = await request(`/api/v4/leads/${inspector.REVIEW_LEAD_ID}`, { with: "contacts" });
  const brokerContactSecond = await request(`/api/v4/contacts/${brokerContactId}`, { with: "leads" });
  const notesSecond = await observedNotes();
  const eventsSecond = await inspector.collectReviewEvents(history, from, evidence.expanded.window.to);
  return { row, agency, expanded: evidence.expanded, brokerContactId, expectedCompanyId: 43419077,
    candidate: { leadFirst, leadSecond, brokerContactFirst, brokerContactSecond,
      notesFirst, notesSecond, eventsFirst, eventsSecond } };
}
async function buildCertificate(row, agency, evidence, request, token, fetchImpl) {
  return certificateModule.buildFixedCaseExclusionCertificate(
    await certificateInput(row, agency, evidence, request, token, fetchImpl));
}
async function recheckCertificate(certificate, row, agency, evidence, request, token, fetchImpl) {
  return certificateModule.recheckFixedCaseExclusionCertificate(certificate,
    await certificateInput(row, agency, evidence, request, token, fetchImpl));
}
function negative(evidence, row, now, expectedContactId = null) {
  inspector.assertCompleteNegativeEvidence(evidence.expanded, projectInspectorRow(row));
  const age = now().getTime() - Date.parse(evidence.expanded.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > MAX_EVIDENCE_AGE_MS) fail("EVIDENCE_NOT_FRESH");
  const contact = evidence.expanded.contactEvidence.byPhone.get(helpers.normalizePhone(row.phone));
  const expected = expectedContactId ? [expectedContactId] : [];
  if (JSON.stringify(contact.exactContactIds) !== JSON.stringify(expected)) fail("CLIENT_CONTACT_EVIDENCE_CHANGED");
}
function certifiedNegative(evidence, row, agency, certificate, now, expectedContactId = null) {
  const filtered = certificateModule.filterFixedCaseExcludedCandidate(evidence.expanded, certificate, row, agency);
  negative({ ...evidence, expanded: filtered }, row, now, expectedContactId);
}
function assertCertificateHashes(certificate, metadata) {
  if (certificate?.caseHash !== metadata.caseHash || certificate?.candidateHash !== metadata.candidateHash) fail("PLAN_HASH_MISMATCH");
}
async function unchanged(prisma, environment, baseline) {
  const current = await snapshot(prisma, environment);
  if (fingerprint(current.row) !== fingerprint(baseline.row) || fingerprint(current.agency) !== fingerprint(baseline.agency)) fail("CLAIMED_CASE_DRIFT");
}
function contactMatches(raw, row, contactId, armedAt, now) {
  const brokerFlag = inspector.brokerFlagEvidence(raw);
  const created = raw?.created_at;
  const exactField = (fieldId, expected) => {
    if (!expected) return true;
    if (!Array.isArray(raw?.custom_fields_values)) return false;
    const fields = raw.custom_fields_values.filter((field) => field?.field_id === fieldId);
    return fields.length === 1 && Array.isArray(fields[0].values) && fields[0].values.length === 1 && typeof fields[0].values[0]?.value === "string" && fields[0].values[0].value === expected;
  };
  return raw?.id === contactId && helpers.contactHasExactPhone(raw, helpers.normalizePhone(row.phone)) &&
    ["missing", "valid"].includes(brokerFlag.coverage) && brokerFlag.value !== true &&
    raw.name === row.fullName && exactField(557905, row.email) && exactField(589265, row.clientRegion) && Number.isSafeInteger(created) &&
    created >= Math.floor(armedAt.getTime() / 1000) - 120 && created <= Math.floor(now().getTime() / 1000) + 120 &&
    Array.isArray(raw._embedded?.leads) && raw._embedded.leads.length === 0;
}
function leadMatches(raw, row, contactId, leadId, armedAt, now) {
  if (!raw || raw.id !== leadId || raw.name !== inspector.expectedGeneratedName(row)) return false;
  const lead = helpers.reduceLeadEvidence(raw, leadId);
  const requestTime = lead.requestValues;
  const expectedContacts = [contactId, id(effective(row).amoContactId)].sort((a, b) => a - b);
  const expectedProject = row.project === "ZORGE9" ? "Зорге 9" : "Берзарина 37";
  return lead.pipelineId === 7600542 && lead.statusId === 62907118 &&
    JSON.stringify([...lead.contactIds].sort((a, b) => a - b)) === JSON.stringify(expectedContacts) &&
    lead.sourceMarker === true && JSON.stringify(lead.projectValues) === JSON.stringify([expectedProject]) &&
    lead.createdAt >= Math.floor(armedAt.getTime() / 1000) - 120 && lead.createdAt <= Math.floor(now().getTime() / 1000) + 120 &&
    requestTime.length === 1 && Number.isSafeInteger(requestTime[0]) && requestTime[0] >= Math.floor(armedAt.getTime() / 1000) - 120 && requestTime[0] <= Math.floor(now().getTime() / 1000) + 120;
}
function expectedLeadFields(row) {
  const fields = new Map([
    [583155, { value: "Себе" }],
    [839179, { value: row.project === "ZORGE9" ? "Зорге 9" : "Берзарина 37" }],
    [665195, { enum_id: 985337 }],
    [842273, { enum_id: 1028041 }],
  ]);
  const property = { "квартира": 1025397, "апартаменты": 859233, "апартамент": 859233,
    "коммерческая": 889061, "коммерческое помещение": 889061, "кладовая": 981093,
    "паркинг": 859235, "машиноместо": 859235 }[String(row.propertyType || "").toLowerCase().trim()];
  const rooms = { "1": 852923, "1к": 852923, "однушка": 852923, "2": 852925, "2к": 852925,
    "двушка": 852925, "3": 852927, "3к": 852927, "трёшка": 852927, "трешка": 852927,
    "студия": 889059 }[String(row.roomsCount || "").toLowerCase().trim()];
  if (property) fields.set(587387, { enum_id: property });
  if (rooms) fields.set(583447, { enum_id: rooms });
  if (row.amount !== null && row.amount !== undefined && Number(row.amount) > 0) fields.set(833045, { value: String(Number(row.amount)) });
  if (row.sqm !== null && row.sqm !== undefined && Number(row.sqm) > 0) fields.set(604555, { value: String(Number(row.sqm)) });
  const readiness = String(row.readinessLevel || "").toLowerCase().replace(/[^а-яё]/g, "");
  if (readiness.includes("горяч")) fields.set(839449, { enum_id: 1025401 });
  else if (readiness.includes("тёпл") || readiness.includes("тепл")) fields.set(839449, { enum_id: 1025403 });
  else if (readiness.includes("холод")) fields.set(839449, { enum_id: 1025405 });
  const timing = String(row.purchaseTiming || "").toLowerCase();
  if (timing.includes("1") && timing.includes("3")) fields.set(612517, { enum_id: 890509 });
  else if (timing.includes("3") && timing.includes("6")) fields.set(612517, { enum_id: 890511 });
  else if (timing.includes("6") || timing.includes("12") || timing.includes("более")) fields.set(612517, { enum_id: 890513 });
  else if (timing.includes("выясн") || timing.includes("не указ")) fields.set(612517, { enum_id: 891589 });
  return fields;
}
function exactLeadCustomFields(row, requestAt) {
  const requestTime = Math.floor(Date.prototype.getTime.call(requestAt) / 1000);
  if (!Number.isSafeInteger(requestTime) || requestTime <= 0) fail("PAYLOAD_INVALID");
  return [...expectedLeadFields(row)].map(([field_id, value]) => ({ field_id, values: [{ ...value }] }))
    .concat([{ field_id: 833189, values: [{ value: requestTime }] }]);
}
function exactLeadFormFields(raw, row, armedAt, now) {
  if (!Array.isArray(raw?.custom_fields_values) || raw.custom_fields_values.length > 1000) return false;
  for (const [fieldId, expected] of expectedLeadFields(row)) {
    const matches = raw.custom_fields_values.filter((field) => field?.field_id === fieldId);
    if (matches.length !== 1 || !Array.isArray(matches[0].values) || matches[0].values.length !== 1) return false;
    const actual = matches[0].values[0];
    if (expected.value !== undefined && String(actual?.value) !== expected.value) return false;
    if (expected.enum_id !== undefined && Number(actual?.enum_id) !== expected.enum_id) return false;
  }
  const request = raw.custom_fields_values.filter((field) => field?.field_id === 833189);
  if (request.length !== 1 || !Array.isArray(request[0].values) || request[0].values.length !== 1) return false;
  const value = Number(request[0].values[0]?.value);
  if (!Number.isSafeInteger(value) || value < Math.floor(armedAt.getTime() / 1000) - 120 || value > Math.floor(now().getTime() / 1000) + 120) return false;
  return row.amount === null || row.amount === undefined || Number(row.amount) <= 0 || Number(raw.price) === Number(row.amount);
}
function expectedRecoveryNote(baseline) {
  const row = baseline.row, broker = effective(row);
  const projectName = row.project === "ZORGE9" ? "Зорге 9" : "Берзарина 37";
  const lines = ["📝 Фиксация клиента от брокера", `Клиент: ${row.fullName}`, `Телефон: ${row.phone}`];
  if (row.email) lines.push(`Email: ${row.email}`);
  if (row.clientRegion) lines.push(`Регион: ${row.clientRegion}`);
  lines.push("", `Проект: ${projectName}`);
  if (row.propertyType) lines.push(`Тип: ${row.propertyType}`);
  if (row.roomsCount) lines.push(`Комнат: ${row.roomsCount}`);
  if (row.sqm) lines.push(`Метраж: ${Number(row.sqm)} м²`);
  if (row.amount) lines.push(`Бюджет: ${Number(row.amount).toLocaleString("ru-RU")} ₽`);
  if (row.purchaseTiming) lines.push(`Планирует покупку: ${row.purchaseTiming}`);
  if (row.readinessLevel) lines.push(`Готовность к сделке: ${row.readinessLevel}`);
  lines.push("", `Брокер-агент: ${broker.fullName ? `${broker.fullName}, ` : ""}${broker.phone}`);
  if (broker.id !== row.brokerId) lines.push(`Подал координатор: ${row.broker.fullName}${row.broker.phone ? ` (${row.broker.phone})` : ""}`);
  lines.push(`Агентство: ${baseline.agency.name} (ИНН ${baseline.agency.inn})`);
  if (row.comment) lines.push("", `Комментарий брокера: ${row.comment}`);
  return decorateRecoveryNote(lines.join("\n"), baseline.agency);
}
async function confirmRecoveryNote(request, baseline, leadId) {
  const payload = await request(`/leads/${leadId}/notes?limit=100&page=1`);
  const notes = payload === null ? [] : payload?._embedded?.notes;
  if (!Array.isArray(notes) || notes.length >= 100 || payload?._links?.next) fail("NOTE_UNCONFIRMED");
  const expected = expectedRecoveryNote(baseline);
  const matches = notes.filter((note) => note?.entity_id === leadId && note?.note_type === "common" && note?.params?.text === expected && id(note?.id));
  if (matches.length !== 1) fail("NOTE_UNCONFIRMED");
  return matches[0];
}
function payload(baseline, contactId) {
  const row = baseline.row, broker = effective(row);
  const number = (value) => value === null || value === undefined ? undefined : Number(value);
  const amount = number(row.amount), sqm = number(row.sqm);
  if ((amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) || (sqm !== undefined && (!Number.isFinite(sqm) || sqm <= 0))) fail("PAYLOAD_INVALID");
  return { clientPhone: row.phone, clientEmail: row.email || undefined, clientName: row.fullName,
    clientRegion: row.clientRegion || undefined, brokerPhone: broker.phone, brokerName: broker.fullName,
    filedByName: broker.id !== row.brokerId ? row.broker.fullName : undefined,
    filedByPhone: broker.id !== row.brokerId ? row.broker.phone : undefined,
    brokerAmoContactId: id(broker.amoContactId), existingClientAmoContactId: contactId,
    agencyName: baseline.agency.name, agencyInn: baseline.agency.inn, comment: row.comment || "",
    project: row.project, propertyType: row.propertyType || undefined, roomsCount: row.roomsCount || undefined,
    amount, sqm, purchaseTiming: row.purchaseTiming || undefined, readinessLevel: row.readinessLevel || undefined, fromBroker: true };
}
async function createExactFixationLeadOnce(adapter, request, baseline, contactId, requestAt) {
  const row = baseline.row, broker = effective(row), amount = row.amount === null || row.amount === undefined ? undefined : Number(row.amount);
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) fail("PAYLOAD_INVALID");
  const lead = await adapter.createLead({ name: inspector.expectedGeneratedName(row), pipeline_id: 7600542,
    contacts: [{ id: contactId }, { id: id(broker.amoContactId) }], ...(amount === undefined ? {} : { price: amount }) });
  const leadId = id(lead?.id);
  if (!leadId) fail("AMO_REQUEST_UNCONFIRMED");
  await adapter.updateLead(leadId, { custom_fields_values: exactLeadCustomFields(row, requestAt) });
  await request(`/leads/${leadId}/notes`, { method: "POST", body: JSON.stringify([
    { note_type: "common", params: { text: expectedRecoveryNote(baseline) } },
  ]) });
  return lead;
}
async function pollContacts(row, request, now, armedAt, responseId, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (responseId) {
    const raw = await request(`/api/v4/contacts/${responseId}`, { with: "leads" }).catch(() => null);
    if (contactMatches(raw, row, responseId, armedAt, now)) return responseId;
  }
  for (const delay of [0, 500, 1500]) {
    if (delay) await sleep(delay);
    const result = await helpers.collectAmoEvidence([projectInspectorRow(row)], request);
    const found = result.byPhone.get(helpers.normalizePhone(row.phone));
    if (found?.exactContactIds.length === 1 && found.leads.length === 0) {
      const contactId = id(found.exactContactIds[0]);
      const raw = await request(`/api/v4/contacts/${contactId}`, { with: "leads" });
      if (contactId && (!responseId || responseId === contactId) && contactMatches(raw, row, contactId, armedAt, now)) return contactId;
    }
  }
  fail("CONTACT_UNCONFIRMED");
}
async function pollLeads(row, request, now, armedAt, contactId, responseId, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (responseId) {
    const raw = await request(`/api/v4/leads/${responseId}`, { with: "contacts" }).catch(() => null);
    if (leadMatches(raw, row, contactId, responseId, armedAt, now) && exactLeadFormFields(raw, row, armedAt, now)) return { leadId: responseId, raw };
  }
  for (const delay of [0, 500, 1500]) {
    if (delay) await sleep(delay);
    const result = await helpers.collectAmoEvidence([projectInspectorRow(row)], request);
    const found = result.byPhone.get(helpers.normalizePhone(row.phone));
    if (!found || JSON.stringify(found.exactContactIds) !== JSON.stringify([contactId]) || found.leads.length !== 1) continue;
    const leadId = id(found.leads[0].leadId);
    if (!leadId || (responseId && responseId !== leadId)) continue;
    const raw = await request(`/api/v4/leads/${leadId}`, { with: "contacts" });
    if (leadMatches(raw, row, contactId, leadId, armedAt, now) && exactLeadFormFields(raw, row, armedAt, now)) return { leadId, raw };
  }
  fail("LEAD_UNCONFIRMED");
}
async function link(prisma, environment, baseline, metadata, leadId, successAt) {
  let successTime;
  try { successTime = Date.prototype.getTime.call(successAt); } catch { fail("LINK_CAS_FAILED"); }
  if (!Number.isFinite(successTime)) fail("LINK_CAS_FAILED");
  return transaction(prisma, environment, async (tx) => {
    const current = await tx.client.findUnique({ where: { id: CLIENT_ID }, select: CLIENT_SELECT });
    effective(current);
    await assertNoOtherPhoneRows(tx, current);
    if (fingerprint(current) !== fingerprint(baseline.row) || current.amoSyncError !== MARKER) fail("CLAIMED_CASE_DRIFT");
    const currentAgency = await tx.agency.findUnique({ where: { id: current.fixationAgencyId }, select: { id: true, name: true, inn: true, updatedAt: true } });
    if (fingerprint(currentAgency) !== fingerprint(baseline.agency)) fail("CLAIMED_CASE_DRIFT");
    const resolved = await tx.auditLog.findMany({ where: { entity: ENTITY, entityId: CLIENT_ID, action: "AMO_FIXED_CASE_LEAD_RESOLVED" }, select: { payload: true }, take: 2 });
    if (resolved.length !== 1 || resolved[0].payload?.operationKey !== OPERATION_KEY || resolved[0].payload?.leadId !== leadId) fail("LINK_CAS_FAILED");
    const occupied = await tx.client.findMany({ where: { amoLeadId: BigInt(leadId), id: { not: CLIENT_ID } }, select: { id: true }, take: 1 });
    if (occupied.length) fail("LEAD_OCCUPIED");
    const changed = await tx.client.updateMany({ where: cas(current), data: { amoLeadId: BigInt(leadId), amoSyncStatus: "SYNCED", amoSyncError: null, amoSyncLastAttemptAt: successAt } });
    if (changed.count !== 1) fail("LINK_CAS_FAILED");
    await audit(tx, "LINKED", metadata, { leadId, assignmentNeeded: true });
    const readback = await tx.client.findUnique({ where: { id: CLIENT_ID }, select: CLIENT_SELECT });
    const expected = { ...current, amoLeadId: BigInt(leadId), amoSyncStatus: "SYNCED", amoSyncError: null, amoSyncLastAttemptAt: successAt, updatedAt: readback.updatedAt };
    if (fingerprint(readback) !== fingerprint(expected)) fail("LINK_READBACK_FAILED");
    return readback;
  }, true);
}
function createSerializedGetRequest(token, fetchImpl) {
  const rawRequest = helpers.createGetOnlyRequester(token, fetchImpl);
  let tail = Promise.resolve();
  return (...args) => {
    const pending = tail.then(() => rawRequest(...args));
    tail = pending.catch(() => {});
    return pending;
  };
}
async function runPlan({ prisma, environment = process.env, confirmation,
  operationLock, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const metadata = planGate(environment, confirmation, operationLock);
  const source = attestSources(environment);
  await operationLock.assertOwned();
  const initial = await preflightStep("SNAPSHOT", () => snapshot(prisma, environment, true));
  const token = typeof initial.token === "string" && initial.token.trim() ? initial.token : environment.AMO_ACCESS_TOKEN;
  const request = createSerializedGetRequest(token, fetchImpl);
  await preflightStep("ACCOUNT", () => helpers.assertExpectedAccount(request));
  const evidence = await preflightStep("EVIDENCE", () => freshEvidence(initial.row, request, token, fetchImpl, now));
  let certificate = await preflightStep("CERTIFICATE", () => buildCertificate(initial.row, initial.agency, evidence, request, token, fetchImpl));
  await preflightStep("NEGATIVE", () => certifiedNegative(evidence, initial.row, initial.agency, certificate, now));
  await operationLock.assertOwned(); await unchanged(prisma, environment, initial);
  const readback = await freshEvidence(initial.row, request, token, fetchImpl, now);
  certificate = await recheckCertificate(certificate, initial.row, initial.agency, readback, request, token, fetchImpl);
  certifiedNegative(readback, initial.row, initial.agency, certificate, now);
  return { status: "planned", caseHash: certificate.caseHash, candidateHash: certificate.candidateHash,
    sourceSha256: source.hashes.recovery, deployedGitSha: metadata.deployedGitSha,
    mutationAuthorized: false, databaseWrites: false, amoWrites: false };
}
async function readReviewedAbandonedLease(redis, key, environment, clock = () => Date.now()) {
  if (environment.FIXED_CASE_ZERO_POST_FAILURE_RUN_ID !== ZERO_POST_FAILURE_RUN_ID ||
    !/^client-fixation:semantic:[0-9a-f]{64}$/.test(key)) fail("ABANDONED_LEASE_UNVERIFIED");
  const sample = async () => {
    const start = clock(), raw = await redis.get(key), ttl = await redis.pttl(key), end = clock();
    let value;
    try { value = JSON.parse(raw); } catch { fail("ABANDONED_LEASE_UNVERIFIED"); }
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 512 || !value ||
      Object.keys(value).sort().join() !== "fingerprint,owner,status" || value.status !== "uncertain" ||
      !/^[0-9a-f]{64}$/.test(value.fingerprint || "") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.owner || "") ||
      !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 86400000 ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 1000 ||
      Math.abs(end + ttl - ABANDONED_LEASE_EXPIRES_AT) > 2000) fail("ABANDONED_LEASE_UNVERIFIED");
    return { raw, ttl, start, end };
  };
  const first = await sample(), second = await sample();
  if (first.raw !== second.raw || second.ttl > first.ttl ||
    first.ttl - second.ttl > second.end - first.start + 100 || second.end - first.start > 2000)
    fail("ABANDONED_LEASE_UNVERIFIED");
  return second;
}
async function acquireFixedCasePhoneLeases(redis, row, phoneKey, environment, clock = () => Date.now()) {
  effective(row); // Never use this exception for another case or phone cohort.
  const exactKey = stagedPhoneLockModule.amoFixationPhoneLockRedisKey(row.phone);
  let replacementAttempted = false;
  const guarded = new Proxy(redis, { get(target, property) {
    if (property !== "set") {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return async (...args) => {
      const result = await target.set(...args);
      if (result === "OK") return result;
      if (replacementAttempted || args.length !== 5 || args[0] !== exactKey || args[2] !== "PX" || args[4] !== "NX")
        fail("ABANDONED_LEASE_UNVERIFIED");
      replacementAttempted = true;
      const observed = await readReviewedAbandonedLease(target, exactKey, environment, clock);
      // No DEL/SET gap. A worker, TTL renewal or raw-value change wins and this
      // operation stops before any database claim or provider POST.
      const replaced = await target.eval(REPLACE_ABANDONED_UNCERTAIN, 1, exactKey,
        observed.raw, args[1], String(args[3]), String(observed.ttl));
      return Number(replaced) === 1 ? "OK" : null;
    };
  } });
  return leaseModule.acquirePhoneLeases(guarded,
    [{ group: { normalizedPhone: helpers.normalizePhone(row.phone) } }], phoneKey,
    stagedPhoneLockModule.amoFixationPhoneLockRedisKey);
}
async function runDraftRecovery({ prisma, redis, environment = process.env, confirmation,
  operationLock, fetchImpl = globalThis.fetch, now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const metadata = gate(environment, confirmation, operationLock);
  const source = attestSources(environment);
  metadata.sourceSha256 = source.hashes.recovery;
  await operationLock.assertOwned();
  const initial = await preflightStep("SNAPSHOT", () => snapshot(prisma, environment, true));
  const token = typeof initial.token === "string" && initial.token.trim() ? initial.token : environment.AMO_ACCESS_TOKEN;
  // Legacy request throttling must not be defeated by simultaneous contact/
  // broker collection. Serialize it; the KC-window requester is separately
  // capped at 2.5 requests/sec, below the combined provider budget.
  const request = createSerializedGetRequest(token, fetchImpl);
  await preflightStep("ACCOUNT", () => helpers.assertExpectedAccount(request));
  const initialEvidence = await preflightStep("EVIDENCE", () => freshEvidence(initial.row, request, token, fetchImpl, now));
  let certificate = await preflightStep("CERTIFICATE", () => buildCertificate(initial.row, initial.agency, initialEvidence, request, token, fetchImpl));
  await preflightStep("PLAN_BINDING", () => assertCertificateHashes(certificate, metadata));
  // A rerun of any previously claimed case is GET-only, regardless of new run
  // ID/source SHA or a subsequently cleared marker. No phase is re-armed.
  const prior = await preflightStep("PRIOR_AUDIT", () => transaction(prisma, environment, (tx) => tx.auditLog.findMany({ where: { entity: ENTITY, entityId: CLIENT_ID }, select: { action: true }, take: 1 })));
  if (prior.length) return { status: "prior_operation_readonly", automaticRetryBlocked: true, assignmentNeeded: true, directMorekitDispatchAttempted: false, databaseWrites: false, contactPosts: 0, leadPosts: 0, patchPosts: 0, notePosts: 0 };
  await preflightStep("NEGATIVE", () => certifiedNegative(initialEvidence, initial.row, initial.agency, certificate, now));
  const leaseKey = randomBytes(32);
  let leases, baseline, contactId, leadId, linked = false, claimAttempted = false;
  const state = { phase: "NONE", requests: 0, contactPosts: 0, leadPosts: 0, patchPosts: 0, notePosts: 0, leadId: null };
  try {
    leases = await acquireFixedCasePhoneLeases(redis, initial.row, leaseKey, environment);
    await operationLock.assertOwned(); await leases.assertOwned();
    await unchanged(prisma, environment, initial);
    const currentEvidence = await freshEvidence(initial.row, request, token, fetchImpl, now);
    certificate = await recheckCertificate(certificate, initial.row, initial.agency, currentEvidence, request, token, fetchImpl);
    assertCertificateHashes(certificate, metadata);
    certifiedNegative(currentEvidence, initial.row, initial.agency, certificate, now);
    claimAttempted = true;
    const claimed = await claim(prisma, environment, initial, metadata);
    if (claimed.prior) fail("PRIOR_OPERATION_PRESENT");
    baseline = await snapshot(prisma, environment);
    const expectedClaim = { ...initial.row, amoSyncAttempts: Math.max(10, initial.row.amoSyncAttempts), amoSyncError: MARKER, updatedAt: baseline.row.updatedAt };
    if (fingerprint(baseline.row) !== fingerprint(expectedClaim) || fingerprint(initial.agency) !== fingerprint(baseline.agency)) fail("CLAIMED_CASE_DRIFT");
    state.assertMutationGate = async (method) => { if (method !== "GET") { await operationLock.assertOwned(); await unchanged(prisma, environment, baseline); await leases.assertOwned(); } };
    const canonicalRequest = createCanonicalTransport(token, fetchImpl, state, sleep);
    const adapter = createIsolatedAdapter(source.sources, canonicalRequest, baseline.agency);
    const contactArmed = now();
    await phase(prisma, environment, baseline, metadata, "CONTACT_ARMED", { armedAt: contactArmed.toISOString() });
    await unchanged(prisma, environment, baseline);
    const beforeContact = await freshEvidence(baseline.row, request, token, fetchImpl, now);
    certificate = await recheckCertificate(certificate, baseline.row, baseline.agency, beforeContact, request, token, fetchImpl);
    assertCertificateHashes(certificate, metadata);
    certifiedNegative(beforeContact, baseline.row, baseline.agency, certificate, now);
    state.phase = "CONTACT_ARMED";
    let responseContact = null;
    try { responseContact = id((await adapter.createFixationClientContactOnce(payload(baseline)))?.id); } catch { /* only GET reconciliation follows */ }
    contactId = await pollContacts(baseline.row, request, now, contactArmed, responseContact, sleep);
    await phase(prisma, environment, baseline, metadata, "CONTACT_RESOLVED", { contactId });
    const clientCollision = await transaction(prisma, environment, (tx) => tx.broker.findMany({ where: { amoContactId: BigInt(contactId) }, select: { id: true }, take: 1 }));
    if (clientCollision.length || contactId === id(effective(baseline.row).amoContactId)) fail("CLIENT_ROLE_COLLISION");
    const leadArmed = now();
    await phase(prisma, environment, baseline, metadata, "LEAD_ARMED", { contactId, armedAt: leadArmed.toISOString() });
    await unchanged(prisma, environment, baseline);
    const beforeLead = await freshEvidence(baseline.row, request, token, fetchImpl, now);
    certificate = await recheckCertificate(certificate, baseline.row, baseline.agency, beforeLead, request, token, fetchImpl);
    assertCertificateHashes(certificate, metadata);
    certifiedNegative(beforeLead, baseline.row, baseline.agency, certificate, now, contactId);
    state.phase = "LEAD_ARMED";
    let responseLead = null;
    try { responseLead = id((await createExactFixationLeadOnce(adapter, canonicalRequest, baseline, contactId, leadArmed))?.id); } catch { /* only GET reconciliation follows */ }
    const resolved = await pollLeads(baseline.row, request, now, leadArmed, contactId, responseLead, sleep);
    leadId = resolved.leadId;
    await confirmRecoveryNote(canonicalRequest, baseline, leadId);
    const finalEvidence = await freshEvidence(baseline.row, request, token, fetchImpl, now);
    certificate = await recheckCertificate(certificate, baseline.row, baseline.agency, finalEvidence, request, token, fetchImpl);
    assertCertificateHashes(certificate, metadata);
    const contacts = finalEvidence.expanded.contactEvidence.byPhone.get(helpers.normalizePhone(baseline.row.phone));
    const filteredFinal = certificateModule.filterFixedCaseExcludedCandidate(finalEvidence.expanded, certificate, baseline.row, baseline.agency);
    const candidates = filteredFinal.possibleCandidates;
    const finalAge = now().getTime() - Date.parse(finalEvidence.expanded.capturedAt);
    if (finalEvidence.expanded.complete !== true || finalEvidence.expanded.databaseFingerprint !== inspector.privateFingerprint(projectInspectorRow(baseline.row)) || !Number.isFinite(finalAge) || finalAge < 0 || finalAge > MAX_EVIDENCE_AGE_MS || JSON.stringify(contacts?.exactContactIds) !== JSON.stringify([contactId]) || contacts?.leads.length !== 1 || contacts.leads[0].leadId !== leadId || !Array.isArray(candidates) || candidates.length !== 1 || candidates[0].leadId !== leadId) fail("LEAD_UNCONFIRMED");
    const confirmedRaw = await request(`/api/v4/leads/${leadId}`, { with: "contacts" });
    if (!leadMatches(confirmedRaw, baseline.row, contactId, leadId, leadArmed, now) || !exactLeadFormFields(confirmedRaw, baseline.row, leadArmed, now)) fail("LEAD_UNCONFIRMED");
    await phase(prisma, environment, baseline, metadata, "LEAD_RESOLVED", { contactId, leadId });
    await operationLock.assertOwned(); await leases.assertOwned();
    await link(prisma, environment, baseline, metadata, leadId, now());
    linked = true;
    return { status: "linked", leadId, businessStatePreserved: true, accountStatusPreserved: true,
      assignmentNeeded: true, directMorekitDispatchAttempted: false, contactPosts: state.contactPosts, leadPosts: state.leadPosts,
      patchPosts: state.patchPosts, notePosts: state.notePosts };
  } catch (error) {
    if (baseline) {
      const reason = ["CONTACT_UNCONFIRMED", "LEAD_UNCONFIRMED"].includes(error?.safeCode) ? error.safeCode : error?.safeCode === "CLAIMED_CASE_DRIFT" ? "CASE_DRIFT" : "UNEXPECTED_FAILURE";
      try { await transaction(prisma, environment, (tx) => audit(tx, "UNRESOLVED", metadata, { reason })); } catch { /* durable claim/armed markers remain; no raw output */ }
    }
    return { status: "unresolved", automaticRetryBlocked: true, assignmentNeeded: true, directMorekitDispatchAttempted: false,
      contactPosts: state.contactPosts, leadPosts: state.leadPosts, patchPosts: state.patchPosts, notePosts: state.notePosts,
      failureCode: safeFailureCode(error) };
  } finally {
    // A refusal before claiming/writing is not an ambiguous provider result.
    // Do not leave another 24h uncertain guard after a zero-write preflight.
    const noWrites = !claimAttempted && state.contactPosts === 0 && state.leadPosts === 0 && state.patchPosts === 0 && state.notePosts === 0;
    if (leases) await leases.release(linked || noWrites ? new Set([helpers.normalizePhone(initial.row.phone)]) : new Set()).catch(() => undefined);
    leaseKey.fill(0);
  }
}
function safeFailureCode(error) {
  const codes = ["CONTACT_UNCONFIRMED", "LEAD_UNCONFIRMED", "NOTE_UNCONFIRMED", "PLAN_HASH_MISMATCH", "CLAIMED_CASE_DRIFT", "LEAD_OCCUPIED", "OTHER_PHONE_CASE_PRESENT", "CAUSAL_RECOVERY_GATE_UNRESOLVED", "PHASE_ALREADY_ARMED", "CLAIM_CAS_FAILED", "LINK_CAS_FAILED", "LINK_READBACK_FAILED", "PRIOR_OPERATION_PRESENT", "CLIENT_ROLE_COLLISION"];
  // Only reviewed literal codes cross the report boundary. Shared lease/core
  // failures use .code, while this writer/certificate uses .safeCode. Never
  // print arbitrary codes, messages, stacks or provider payloads.
  codes.push("PHONE_LOCK_BUSY", "PHONE_LOCK_OWNERSHIP_LOST", "SHARED_PHONE_LOCK_CONTRACT_INVALID", "ATTESTATION_KEY_INVALID");
  codes.push("ABANDONED_LEASE_UNVERIFIED");
  codes.push("CERT_BODY_BOUND_EXCEEDED", "CERT_BROKER_INVALID", "CERT_BROKER_LINKS_INVALID", "CERT_CALLTOUCH_PROVENANCE_INVALID",
    "CERT_CANDIDATE_CHANGED", "CERT_CASE_SCOPE_INVALID", "CERT_CASE_TIME_INVALID", "CERT_CREATION_EVENT_INVALID",
    "CERT_EVENT_INVALID", "CERT_EVENT_LINK_INVALID", "CERT_EVENTS_INCOMPLETE", "CERT_EVIDENCE_STALE", "CERT_FIELD_INVALID",
    "CERT_HISTORICAL_FIELD_INVALID", "CERT_INITIAL_LINK_MISSING", "CERT_INITIAL_SOURCE_MISSING", "CERT_LEAD_INVALID",
    "CERT_LEAD_LINKS_INVALID", "CERT_NOTES_INCOMPLETE", "CERT_READBACK_CHANGED", "CERT_RECHECK_CHANGED", "CERT_SCOPE_INVALID",
    "CERT_UNTRUSTED", "CERT_VALUE_DEPTH_EXCEEDED");
  codes.push("CERTIFICATE_EVIDENCE_INVALID", "CERTIFICATE_NOTES_OBSERVATION_INVALID", "BROKER_CONTACT_INVALID",
    "REVIEW_NOTES_REQUEST_REJECTED", "REVIEW_NOTES_REQUEST_FAILED", "REVIEW_EVENTS_INVALID", "REVIEW_HISTORY_SCOPE_INVALID",
    "WINDOW_REQUEST_REJECTED", "WINDOW_REQUEST_FAILED", "WINDOW_PAGE_BOUND_EXCEEDED", "WINDOW_PAGINATION_INCOMPLETE",
    "EXPANDED_LEAD_CHANGED_DURING_SCAN", "EXPANDED_EVIDENCE_INCOMPLETE", "EXPANDED_POSSIBLE_LEAD_PRESENT", "EVIDENCE_NOT_FRESH");
  try {
    if (codes.includes(error?.safeCode)) return error.safeCode;
    if (codes.includes(error?.code)) return error.code;
  } catch { /* hostile/malformed error properties cannot escape the boundary */ }
  return "RECOVERY_REFUSED";
}
module.exports = { CLIENT_ID, OWNER_ID, OPERATION_KEY, ENTITY, MARKER, CONFIRMATION, PLAN_CONFIRMATION,
  RECOVERY_UUID, RECOVERY_SOURCE, SOURCE_FILES, CLIENT_SELECT, effective, projectInspectorRow, gate, planGate,
  attestSources, snapshot, claim, phase, audit, assertNoOtherPhoneRows, assertNoCausalOldGroupGate,
  createCanonicalTransport, createIsolatedAdapter, negative, certifiedNegative, contactMatches, leadMatches,
  exactLeadFormFields, expectedRecoveryNote, confirmRecoveryNote, payload, pollContacts, pollLeads, link,
  exactLeadCustomFields, createExactFixationLeadOnce,
  runPlan, runDraftRecovery, preflightStep, PREFLIGHT_STAGES, safeFailureCode, ZERO_POST_FAILURE_RUN_ID,
  ABANDONED_LEASE_EXPIRES_AT, readReviewedAbandonedLease, acquireFixedCasePhoneLeases, REPLACE_ABANDONED_UNCERTAIN };
