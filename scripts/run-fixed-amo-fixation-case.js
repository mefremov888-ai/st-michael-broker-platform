"use strict";

// DRAFT protected entry point. No imported recovery/application module executes
// until every staged byte and all deployed adapter/writer bytes are attested.
const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const CONFIRMATION = "RECOVER_APPROVED_FIXED_AMO_CASE_ONCE";
const PLAN_CONFIRMATION = "PLAN_FIXED_AMO_CASE_READONLY";
const FILES = Object.freeze({
  recovery: "scripts/apply-fixed-amo-fixation-case.js",
  certificate: "scripts/fixed-amo-case-exclusion-certificate.js",
  inspector: "scripts/inspect-fixed-amo-fixation-case.js",
  reconciliation: "scripts/inspect-amo-fixation-lead-reconciliation.js",
  lease: "scripts/apply-amo-deadletter-group-recovery.js",
  leaseCore: "scripts/amo-deadletter-group-recovery-core.js",
  leasePlan: "scripts/inspect-amo-deadletter-group-recovery-plan.js",
  adapter: "packages/integrations/dist/amo-crm.adapter.js",
  fields: "packages/integrations/dist/amo-crm.fields.js",
  touches: "packages/integrations/dist/amo-crm.touches.js",
  phoneLock: "packages/integrations/dist/amo-fixation-phone-lock.js",
  traffic: "packages/integrations/dist/amo-traffic-light.js",
  apiPhoneLock: "apps/api/dist/common/amo-fixation-phone-lock.service.js",
  apiSyncRetry: "apps/api/dist/common/amo-sync-retry.js",
  apiFixationSafety: "apps/api/dist/client-fixation/client-fixation-safety.service.js",
  apiFixationController: "apps/api/dist/client-fixation/client-fixation.controller.js",
  apiFixationWriter: "apps/api/dist/client-fixation/client-fixation.service.js",
  apiSchedulerWriter: "apps/api/dist/scheduler/scheduler.service.js",
  apiAdminWriter: "apps/api/dist/admin/admin.service.js",
});
const RUNNER = "scripts/run-fixed-amo-fixation-case.js";
const COMPILED = Object.freeze(["adapter", "fields", "touches", "phoneLock", "traffic",
  "apiPhoneLock", "apiSyncRetry", "apiFixationSafety", "apiFixationController", "apiFixationWriter", "apiSchedulerWriter", "apiAdminWriter"]);
const RECOVERY_SOURCE_KEYS = Object.freeze(["recovery", "certificate", "inspector", "reconciliation", "lease", "leaseCore", "leasePlan", "adapter", "fields", "touches", "phoneLock", "traffic"]);
const SAFE_REFUSAL_CODES = Object.freeze(new Set([
  "SOURCE_ATTESTATION_INVALID", "LIVE_ADAPTER_MISMATCH", "EXECUTION_GATE_INVALID", "DATABASE_IDENTITY_MISMATCH",
  "REDIS_CONFIGURATION_INVALID", "BROKER_CONTACT_INVALID", "BROKER_CONTACT_OCCUPIED", "CERTIFICATE_EVIDENCE_INVALID",
  "OTHER_PHONE_CASE_PRESENT", "CAUSAL_RECOVERY_GATE_UNRESOLVED", "PLAN_HASH_MISMATCH", "CLAIMED_CASE_DRIFT",
  "CONTACT_UNCONFIRMED", "LEAD_UNCONFIRMED", "NOTE_UNCONFIRMED", "LINK_CAS_FAILED", "LINK_READBACK_FAILED",
  "CERT_BODY_BOUND_EXCEEDED", "CERT_BROKER_INVALID", "CERT_BROKER_LINKS_INVALID", "CERT_CALLTOUCH_PROVENANCE_INVALID",
  "CERT_CANDIDATE_CHANGED", "CERT_CASE_SCOPE_INVALID", "CERT_CASE_TIME_INVALID", "CERT_CREATION_EVENT_INVALID",
  "CERT_EVENT_INVALID", "CERT_EVENT_LINK_INVALID", "CERT_EVENTS_INCOMPLETE", "CERT_EVIDENCE_STALE", "CERT_FIELD_INVALID",
  "CERT_HISTORICAL_FIELD_INVALID", "CERT_INITIAL_LINK_MISSING", "CERT_INITIAL_SOURCE_MISSING", "CERT_LEAD_INVALID",
  "CERT_LEAD_LINKS_INVALID", "CERT_NOTES_INCOMPLETE", "CERT_READBACK_CHANGED", "CERT_RECHECK_CHANGED",
  "CERT_SCOPE_INVALID", "CERT_UNTRUSTED", "CERT_VALUE_DEPTH_EXCEEDED",
]));
const LIMIT = 1024 * 1024;
function refuse(code) { const error = new Error("Protected case runner refused"); error.safeCode = code; throw error; }
function safeRefusalCode(error) { return SAFE_REFUSAL_CODES.has(error?.safeCode) ? error.safeCode : "UNCLASSIFIED_REFUSAL"; }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function physicalFile(root, relative, privateMode = false) {
  const target = path.join(root, relative);
  let current = root;
  for (const segment of relative.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const directory = fs.lstatSync(current);
    if (!directory.isDirectory() || directory.isSymbolicLink()) refuse("SOURCE_ATTESTATION_INVALID");
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > LIMIT || (privateMode && (stat.mode & 0o777) !== 0o600)) refuse("SOURCE_ATTESTATION_INVALID");
  return fs.readFileSync(target);
}
function buildPayload(reviewedRoot, runtimeRoot, destination, metadata) {
  if (!metadata || Object.keys(metadata).sort().join() !== "deployedGitSha,sourceGitSha" || !/^[0-9a-f]{40}$/.test(metadata.sourceGitSha || "") || !/^[0-9a-f]{40}$/.test(metadata.deployedGitSha || "")) refuse("SOURCE_ATTESTATION_INVALID");
  fs.mkdirSync(destination, { mode: 0o700 });
  const sourceHashes = {};
  for (const [key, relative] of Object.entries(FILES)) {
    const bytes = physicalFile(COMPILED.includes(key) ? runtimeRoot : reviewedRoot, relative);
    sourceHashes[key] = hash(bytes);
    fs.mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(destination, relative), bytes, { flag: "wx", mode: 0o600 });
  }
  const runner = physicalFile(reviewedRoot, RUNNER);
  fs.writeFileSync(path.join(destination, RUNNER), runner, { flag: "wx", mode: 0o600 });
  const manifest = { schemaVersion: 1, ...metadata, sourceHashes, runnerSha256: hash(runner) };
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  return manifest;
}
function attest(root, environment, liveRoot = "/app") {
  const mode = environment.FIXED_CASE_MODE;
  const confirmation = mode === "plan" ? PLAN_CONFIRMATION : mode === "apply" ? CONFIRMATION : null;
  if (environment.NODE_ENV !== "production" || environment.FIXED_CASE_CONFIRMATION !== confirmation || environment.FIXED_CASE_RUN_ATTEMPT !== "1" || !/^[1-9][0-9]*$/.test(environment.FIXED_CASE_RUN_ID || "") || !/^[0-9a-f]{40}$/.test(environment.FIXED_CASE_SOURCE_GIT_SHA || "") || environment.GIT_SHA !== environment.FIXED_CASE_DEPLOYED_GIT_SHA || !/^[0-9a-f]{40}$/.test(environment.GIT_SHA || "") || environment.NODE_TLS_REJECT_UNAUTHORIZED === "0" || !/^[0-9]+$/.test(environment.PRODUCTION_PG_SYSTEM_IDENTIFIER || "") || !/^[1-9][0-9]{0,15}$/.test(environment.PRODUCTION_MIN_BROKER_ROWS || "") || !Number.isSafeInteger(Number(environment.PRODUCTION_MIN_BROKER_ROWS))) refuse("EXECUTION_GATE_INVALID");
  if (mode === "apply" && (!/^[1-9][0-9]*$/.test(environment.FIXED_CASE_PLAN_RUN_ID || "") || !/^[a-f0-9]{64}$/.test(environment.FIXED_CASE_EXPECTED_CASE_HASH || "") || !/^[a-f0-9]{64}$/.test(environment.FIXED_CASE_EXPECTED_CANDIDATE_HASH || ""))) refuse("EXECUTION_GATE_INVALID");
  if (path.resolve(root) !== root || !/^\/tmp\/st-michael-fixed-case\.[A-Za-z0-9]{6}$/.test(root)) refuse("STAGING_PATH_INVALID");
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || fs.realpathSync(root) !== root) refuse("STAGING_PATH_INVALID");
  const manifestBytes = physicalFile(root, "manifest.json", true);
  if (hash(manifestBytes) !== environment.FIXED_CASE_MANIFEST_SHA256) refuse("SOURCE_ATTESTATION_INVALID");
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { refuse("SOURCE_ATTESTATION_INVALID"); }
  if (Object.keys(manifest).sort().join() !== "deployedGitSha,runnerSha256,schemaVersion,sourceGitSha,sourceHashes" || manifest.schemaVersion !== 1 || manifest.sourceGitSha !== environment.FIXED_CASE_SOURCE_GIT_SHA || manifest.deployedGitSha !== environment.GIT_SHA || manifest.runnerSha256 !== environment.FIXED_CASE_RUNNER_SHA256 || Object.keys(manifest.sourceHashes || {}).sort().join() !== Object.keys(FILES).sort().join()) refuse("SOURCE_ATTESTATION_INVALID");
  for (const [key, relative] of Object.entries(FILES)) {
    if (!/^[0-9a-f]{64}$/.test(manifest.sourceHashes[key] || "") || hash(physicalFile(root, relative, true)) !== manifest.sourceHashes[key]) refuse("SOURCE_ATTESTATION_INVALID");
    if (COMPILED.includes(key) && hash(physicalFile(liveRoot, relative)) !== manifest.sourceHashes[key]) refuse("LIVE_ADAPTER_MISMATCH");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.runnerSha256 || "") || hash(physicalFile(root, RUNNER, true)) !== manifest.runnerSha256) refuse("SOURCE_ATTESTATION_INVALID");
  environment.FIXED_CASE_SOURCE_HASHES = JSON.stringify(Object.fromEntries(
    RECOVERY_SOURCE_KEYS.map((key) => [key, manifest.sourceHashes[key]])));
  environment.FIXED_CASE_INSPECTOR_SHA256 = manifest.sourceHashes.inspector;
  environment.FIXED_CASE_DEPENDENCY_SHA256 = manifest.sourceHashes.reconciliation;
  return manifest;
}
function createOperationLock(input, output, onFatal = () => {}) {
  let pending = null, buffer = "", lost = false, heartbeat;
  const invalidate = () => {
    if (lost) return;
    lost = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error("LOCK_NOT_OWNED")); pending = null; }
    clearInterval(heartbeat);
    onFatal();
  };
  input.on("data", (chunk) => {
    if (lost) return;
    buffer += chunk.toString("utf8");
    if (buffer.length > 128) return invalidate();
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!pending || line !== `lock-ok:${pending.nonce}` || buffer !== "") return invalidate();
    const acknowledged = pending; pending = null;
    clearTimeout(acknowledged.timer); acknowledged.resolve();
  });
  input.on("end", invalidate); input.on("error", invalidate);
  const assertOwned = () => {
    if (lost) return Promise.reject(new Error("LOCK_NOT_OWNED"));
    if (pending) return pending.promise;
    const nonce = randomBytes(16).toString("hex");
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    pending = { nonce, promise, resolve, reject, timer: setTimeout(invalidate, 5000) };
    output.write(`lock-check:${nonce}\n`, (error) => { if (error) invalidate(); });
    return promise;
  };
  heartbeat = setInterval(() => { assertOwned().catch(invalidate); }, 500);
  return { assertOwned, close() {
    // After the last mutation, a heartbeat in flight is a normal shutdown,
    // not lost ownership. Never turn a successfully emitted report into an
    // ambiguous fatal exit merely because its acknowledgement was pending.
    lost = true; clearInterval(heartbeat);
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error("LOCK_CLOSED")); pending = null; }
    input.removeAllListeners("data"); input.removeAllListeners("end"); input.removeAllListeners("error"); input.pause(); input.destroy?.();
  } };
}
function safeReport(result) {
  if (result?.status === "planned") {
    const keys = ["amoWrites", "candidateHash", "caseHash", "databaseWrites", "deployedGitSha", "mutationAuthorized", "sourceSha256", "status"];
    if (Object.keys(result).sort().join() !== keys.sort().join() || result.mutationAuthorized !== false || result.databaseWrites !== false || result.amoWrites !== false || !/^[a-f0-9]{64}$/.test(result.caseHash || "") || !/^[a-f0-9]{64}$/.test(result.candidateHash || "") || !/^[a-f0-9]{64}$/.test(result.sourceSha256 || "") || !/^[a-f0-9]{40}$/.test(result.deployedGitSha || "")) refuse("REPORT_INVALID");
    return JSON.stringify(result);
  }
  const flags = ["automaticRetryBlocked", "assignmentNeeded", "directMorekitDispatchAttempted", "databaseWrites", "businessStatePreserved", "accountStatusPreserved"];
  const allowed = ["status", "leadId", "contactPosts", "leadPosts", "patchPosts", "notePosts", "failureCode", ...flags];
  if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).some((key) => !allowed.includes(key)) || !["linked", "unresolved", "prior_operation_readonly"].includes(result.status) || result.directMorekitDispatchAttempted !== false || result.assignmentNeeded !== true || !Number.isInteger(result.contactPosts) || result.contactPosts < 0 || result.contactPosts > 1 || !Number.isInteger(result.leadPosts) || result.leadPosts < 0 || result.leadPosts > 1 || !Number.isInteger(result.patchPosts) || result.patchPosts < 0 || result.patchPosts > 1 || !Number.isInteger(result.notePosts) || result.notePosts < 0 || result.notePosts > 1) refuse("REPORT_INVALID");
  for (const flag of flags) if (result[flag] !== undefined && typeof result[flag] !== "boolean") refuse("REPORT_INVALID");
  if (result.leadId !== undefined && (!Number.isSafeInteger(result.leadId) || result.leadId <= 0)) refuse("REPORT_INVALID");
  const failures = ["CONTACT_UNCONFIRMED", "LEAD_UNCONFIRMED", "NOTE_UNCONFIRMED", "PLAN_HASH_MISMATCH", "CLAIMED_CASE_DRIFT", "LEAD_OCCUPIED", "OTHER_PHONE_CASE_PRESENT", "CAUSAL_RECOVERY_GATE_UNRESOLVED", "PHASE_ALREADY_ARMED", "CLAIM_CAS_FAILED", "LINK_CAS_FAILED", "LINK_READBACK_FAILED", "PRIOR_OPERATION_PRESENT", "CLIENT_ROLE_COLLISION", "RECOVERY_REFUSED", "ABANDONED_LEASE_UNVERIFIED", "PHONE_LOCK_BUSY"];
  if (result.failureCode !== undefined && !failures.includes(result.failureCode)) refuse("REPORT_INVALID");
  if (result.status === "linked" && (!result.leadId || result.businessStatePreserved !== true || result.accountStatusPreserved !== true)) refuse("REPORT_INVALID");
  if (result.status !== "linked" && result.automaticRetryBlocked !== true) refuse("REPORT_INVALID");
  if (result.status === "prior_operation_readonly" && result.databaseWrites !== false) refuse("REPORT_INVALID");
  return JSON.stringify(result);
}
function isSuccessfulResultForMode(mode, status) {
  return (mode === "plan" && status === "planned") || (mode === "apply" && status === "linked");
}
function createRedis(Redis, environment) {
  // Live AppModule Bull configuration passes only REDIS_HOST/REDIS_PORT, hence
  // DB0 and no password. A separate DB/connection would not fence API writers.
  if (environment.REDIS_HOST !== "redis" || environment.REDIS_PORT !== "6379" || (environment.REDIS_DB !== undefined && environment.REDIS_DB !== "0") || environment.REDIS_PASSWORD) refuse("REDIS_CONFIGURATION_INVALID");
  return new Redis({ host: environment.REDIS_HOST, port: 6379, db: 0, lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: true, connectTimeout: 5000, retryStrategy: () => null });
}
async function main() {
  const environment = process.env, root = path.dirname(__dirname);
  attest(root, environment); // Must precede all non-built-in require calls.
  const fatal = () => { process.exitCode = 1; process.exit(1); };
  const deadline = setTimeout(fatal, 8 * 60_000);
  for (const method of ["log", "warn", "error", "info", "debug"]) console[method] = () => {};
  process.on("uncaughtException", fatal); process.on("unhandledRejection", fatal);
  fs.writeFileSync(path.join(root, "runner.pid"), String(process.pid), { flag: "wx", mode: 0o600 });
  const operationLock = createOperationLock(process.stdin, process.stdout, fatal);
  let prisma, redis;
  try {
    await operationLock.assertOwned();
    const recovery = require("./apply-fixed-amo-fixation-case.js");
    const lease = require("./apply-amo-deadletter-group-recovery.js");
    const reconciliation = require("./inspect-amo-fixation-lead-reconciliation.js");
    // The private payload is staged below /tmp and must not rely on NODE_PATH
    // or another mutable module search path. These are the already-running
    // image's exact runtime dependencies, loaded only after byte attestation.
    const { PrismaClient } = require("/app/node_modules/@st-michael/database");
    const Redis = require("/app/node_modules/ioredis");
    const mode = environment.FIXED_CASE_MODE;
    prisma = new PrismaClient({ datasources: { db: { url: mode === "plan" ? reconciliation.buildReadOnlyDatabaseUrl(environment.DATABASE_URL) : lease.buildWriteDatabaseUrl(environment.DATABASE_URL) } }, log: [] });
    if (mode === "apply") {
      redis = createRedis(Redis, environment); redis.on("error", () => {});
      await redis.connect();
      if (await redis.ping() !== "PONG") refuse("REDIS_CONFIGURATION_INVALID");
    }
    await operationLock.assertOwned();
    const result = mode === "plan"
      ? await recovery.runPlan({ prisma, environment, confirmation: environment.FIXED_CASE_CONFIRMATION, operationLock })
      : await recovery.runDraftRecovery({ prisma, redis, environment, confirmation: environment.FIXED_CASE_CONFIRMATION, operationLock });
    await operationLock.assertOwned();
    const json = safeReport(result);
    process.stdout.write(`report:${Buffer.from(json).toString("base64")}\n`);
    if (!isSuccessfulResultForMode(mode, result.status)) process.exitCode = 1;
  } finally {
    if (redis) redis.disconnect();
    if (prisma) await prisma.$disconnect().catch(() => {});
    operationLock.close(); clearTimeout(deadline);
  }
}
module.exports = { FILES, RUNNER, COMPILED, RECOVERY_SOURCE_KEYS, CONFIRMATION, PLAN_CONFIRMATION, physicalFile, buildPayload, attest, createOperationLock, safeReport, safeRefusalCode, isSuccessfulResultForMode, createRedis, main };
if (require.main === module) main().catch((error) => { process.stderr.write(`fixed_case_runner_refused=true\nfixed_case_runner_refused_code=${safeRefusalCode(error)}\n`); process.exitCode = 1; });
