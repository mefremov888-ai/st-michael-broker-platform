#!/usr/bin/env node
/**
 * PII-safe, strictly GET-only reconciliation inspector for exhausted amoCRM
 * fixation queue rows.
 *
 * The inspector forces PostgreSQL into read-only mode and selects only the
 * exhausted fixation cohort. Client phones and raw database/amo identifiers
 * are held in memory solely to find exact amo contacts, traverse their linked
 * leads and classify current call-center-pipeline evidence. Output contains
 * per-run HMAC aliases, bounded classifications and a deterministic,
 * domain-separated cohort attestation. It never refreshes OAuth, starts Nest,
 * writes either system, or authorizes a retry.
 */

"use strict";

const { createHmac, randomBytes } = require("node:crypto");
const { isAbsolute } = require("node:path");
const { lstatSync, readFileSync } = require("node:fs");

const AMO_ORIGIN = "https://stmichael.amocrm.ru";
const EXPECTED_ACCOUNT_ID = 28552900;
const KC_PIPELINE_ID = 7600542;
const ATTEMPT_LIMIT = 10;
const KNOWN_QUEUE_ROWS = 12;
const QUEUE_STATUSES = Object.freeze(["FAILED", "PENDING"]);
const STATEMENT_TIMEOUT_MS = 15_000;

const PAGE_LIMIT = 250;
const MAX_CONTACT_SEARCH_PAGES = 20;
const MAX_EXACT_CONTACTS_PER_PHONE = 20;
const MAX_LEADS_PER_CONTACT = 250;
const MAX_LINKED_LEADS_PER_PHONE = 100;
const MAX_DISTINCT_LEADS = 500;
const MAX_CONTACTS_PER_LEAD = 50;
const MAX_SELECTED_FIELD_VALUES = 20;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_ATTEMPTS = 4;
const MIN_REQUEST_INTERVAL_MS = 180;

const STRONG_TIME_WINDOW_SECONDS = 15 * 60;
const STRONG_NEGATIVE_CLOCK_SKEW_SECONDS = 2 * 60;
const WEAK_TIME_WINDOW_SECONDS = 24 * 60 * 60;
const MIN_EVENT_UNIX_SECONDS = 946_684_800;
const MAX_EVENT_UNIX_SECONDS = 4_133_980_800;

const CONTACT_FIELDS = Object.freeze({ PHONE: 557903 });
const LEAD_FIELDS = Object.freeze({
  FROM_BROKER: 665195,
  BROKER_REQUEST_DATE: 833189,
  INTEREST_OBJECT: 839179,
});
const FROM_BROKER_YES_ENUM_ID = 985337;
const PROJECT_LABELS = Object.freeze({
  ZORGE9: "Зорге 9",
  SILVER_BOR: "Берзарина 37",
});

const REPORT_HASH_DOMAIN =
  "st-michael:amo-fixation-lead-reconciliation-report-alias:v1";
const COHORT_ATTESTATION_DOMAIN =
  "st-michael:amo-fixation-lead-reconciliation-cohort-attestation:v1";
const COHORT_CANONICALIZATION =
  "sorted-queue-json-recursive-key-order-length-prefixed-v1";

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

// These are the only historical queue states for which the exact signed
// 12-row cohort may advise a database-only link to an independently observed
// strong amoCRM lead. The error class is not itself proof that a lead exists:
// the one-contact/one-strong/no-weak evidence gates below remain mandatory.
const CAS_LINK_ELIGIBLE_ERROR_CLASSES = Object.freeze([
  "create_reconciliation_required",
  "network_failure",
  "fixation_agency_missing",
  "broker_amo_contact_missing",
]);

const FAILURE_PHASE = Object.freeze({
  ATTESTATION: "ATTESTATION",
  DATABASE: "DATABASE",
  ACCOUNT: "ACCOUNT",
  CONTACT_LOOKUP: "CONTACT_LOOKUP",
  LEAD_LOOKUP: "LEAD_LOOKUP",
  REPORT: "REPORT",
});

const FAILURE_CODE_BY_MESSAGE = new Map([
  ["DATABASE_URL is missing", "DATABASE_URL_MISSING"],
  ["DATABASE_URL is invalid", "DATABASE_URL_INVALID"],
  ["DATABASE_URL must use PostgreSQL", "DATABASE_URL_NOT_POSTGRESQL"],
  ["Database session is not read-only", "DATABASE_SESSION_NOT_READ_ONLY"],
  ["Expected queue row count is invalid", "EXPECTED_QUEUE_COUNT_INVALID"],
  ["Exhausted queue cohort count changed", "QUEUE_COHORT_COUNT_CHANGED"],
  ["Cohort attestation key file is invalid", "ATTESTATION_KEY_FILE_INVALID"],
  ["Cohort attestation key is invalid", "ATTESTATION_KEY_INVALID"],
  ["Inspector source hash is invalid", "INSPECTOR_SHA_INVALID"],
  ["Deployed git SHA is invalid", "DEPLOYED_SHA_INVALID"],
  ["Report hash key is invalid", "REPORT_HASH_KEY_INVALID"],
  ["amoCRM access token is missing", "AMO_ACCESS_TOKEN_MISSING"],
  ["fetch is unavailable", "FETCH_UNAVAILABLE"],
  ["Unsafe amoCRM path", "UNSAFE_AMO_PATH"],
  ["Unsafe amoCRM query", "UNSAFE_AMO_QUERY"],
  ["Unsafe amoCRM URL", "UNSAFE_AMO_URL"],
  ["Malformed amoCRM response", "MALFORMED_AMO_RESPONSE"],
  ["amoCRM request failed", "AMO_REQUEST_FAILED"],
  ["amoCRM request rejected", "AMO_REQUEST_REJECTED"],
  ["amoCRM response content length is invalid", "AMO_INVALID_CONTENT_LENGTH"],
  [
    "amoCRM response body exceeded safety bound",
    "AMO_RESPONSE_BODY_SAFETY_BOUND_EXCEEDED",
  ],
  ["amoCRM response body is unavailable", "AMO_RESPONSE_BODY_UNAVAILABLE"],
  ["amoCRM response body read failed", "AMO_RESPONSE_BODY_READ_FAILED"],
  ["amoCRM returned invalid JSON", "AMO_INVALID_JSON"],
  ["Unexpected amoCRM account", "UNEXPECTED_AMO_ACCOUNT"],
  ["Malformed amoCRM contacts page", "MALFORMED_AMO_CONTACTS_PAGE"],
  ["Invalid amoCRM contact record", "INVALID_AMO_CONTACT_RECORD"],
  ["amoCRM contacts pagination loop detected", "AMO_CONTACTS_PAGINATION_LOOP"],
  [
    "amoCRM contacts pagination exceeded safety bound",
    "AMO_CONTACTS_PAGINATION_SAFETY_BOUND_EXCEEDED",
  ],
  [
    "Exact client contact safety bound exceeded",
    "EXACT_CONTACT_BOUND_EXCEEDED",
  ],
  ["Contact lead safety bound exceeded", "CONTACT_LEAD_BOUND_EXCEEDED"],
  ["Phone lead safety bound exceeded", "PHONE_LEAD_BOUND_EXCEEDED"],
  ["Lead contact safety bound exceeded", "LEAD_CONTACT_BOUND_EXCEEDED"],
  ["Lead field value safety bound exceeded", "LEAD_FIELD_VALUE_BOUND_EXCEEDED"],
  ["Distinct lead safety bound exceeded", "DISTINCT_LEAD_BOUND_EXCEEDED"],
  ["Invalid amoCRM lead record", "INVALID_AMO_LEAD_RECORD"],
  [
    "Ambiguous amoCRM selected custom field",
    "AMBIGUOUS_AMO_SELECTED_CUSTOM_FIELD",
  ],
  ["Invalid amoCRM selected custom field", "INVALID_AMO_SELECTED_CUSTOM_FIELD"],
  ["amoCRM contact/lead relation changed during scan", "AMO_RELATION_CHANGED"],
  ["Invalid queue row", "INVALID_QUEUE_ROW"],
  ["Invalid stored amo lead id", "INVALID_STORED_AMO_LEAD_ID"],
  ["Invalid reconciliation evidence", "INVALID_RECONCILIATION_EVIDENCE"],
]);

let activeFailurePhase = FAILURE_PHASE.ATTESTATION;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function classifyFailure(error) {
  try {
    if (
      error === null ||
      (typeof error !== "object" && typeof error !== "function") ||
      typeof error.message !== "string"
    ) {
      return "UNKNOWN_FAILURE";
    }
    return FAILURE_CODE_BY_MESSAGE.get(error.message) || "UNKNOWN_FAILURE";
  } catch {
    return "UNKNOWN_FAILURE";
  }
}

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

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function optionalStoredAmoLeadId(value) {
  if (value === null) return null;
  let parsed;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new Error("Invalid stored amo lead id");
  }
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid stored amo lead id");
  }
  return Number(parsed);
}

function normalizePhone(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("77")) {
    digits = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith("77")) {
    return null;
  } else if (digits.length === 11 && digits.startsWith("8")) {
    digits = `7${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `7${digits}`;
  }
  if (!/^7\d{10}$/.test(digits)) return null;
  return `+${digits}`;
}

function isJsonRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectedCustomField(entity, fieldId, fallbackCode = null) {
  const rawFields = entity?.custom_fields_values;
  if (
    rawFields !== null &&
    rawFields !== undefined &&
    !Array.isArray(rawFields)
  ) {
    throw new Error("Invalid amoCRM selected custom field");
  }
  const fields = rawFields || [];
  const selected = fields.filter(
    (candidate) =>
      positiveInteger(candidate?.field_id) === fieldId ||
      (fallbackCode !== null && candidate?.field_code === fallbackCode),
  );
  if (selected.length > 1) {
    throw new Error("Ambiguous amoCRM selected custom field");
  }
  if (selected.length === 0) return null;
  if (!Array.isArray(selected[0]?.values)) {
    throw new Error("Invalid amoCRM selected custom field");
  }
  return selected[0];
}

function customValues(entity, fieldId) {
  return selectedCustomField(entity, fieldId)?.values || [];
}

function contactPhoneValues(contact) {
  return (
    selectedCustomField(contact, CONTACT_FIELDS.PHONE, "PHONE")?.values || []
  );
}

function contactHasExactPhone(contact, normalizedPhone) {
  return contactPhoneValues(contact).some(
    (entry) => normalizePhone(entry?.value) === normalizedPhone,
  );
}

function canonicalAmoUrl(pathname, query = {}) {
  if (!isJsonRecord(query)) throw new Error("Unsafe amoCRM query");
  const keys = Object.keys(query).sort();
  let allowed = false;
  if (pathname === "/api/v4/account") {
    allowed = keys.length === 0;
  } else if (pathname === "/api/v4/contacts") {
    allowed =
      keys.join(",") === "limit,page,query" &&
      typeof query.query === "string" &&
      /^\d{10}$/.test(query.query) &&
      query.limit === PAGE_LIMIT &&
      Number.isInteger(query.page) &&
      query.page >= 1 &&
      query.page <= MAX_CONTACT_SEARCH_PAGES;
  } else if (/^\/api\/v4\/contacts\/[1-9]\d*$/.test(pathname)) {
    allowed = keys.length === 1 && keys[0] === "with" && query.with === "leads";
  } else if (/^\/api\/v4\/leads\/[1-9]\d*$/.test(pathname)) {
    allowed =
      keys.length === 1 && keys[0] === "with" && query.with === "contacts";
  }
  if (!allowed) {
    if (
      pathname !== "/api/v4/account" &&
      pathname !== "/api/v4/contacts" &&
      !/^\/api\/v4\/(?:contacts|leads)\/[1-9]\d*$/.test(pathname)
    ) {
      throw new Error("Unsafe amoCRM path");
    }
    throw new Error("Unsafe amoCRM query");
  }
  const url = new URL(pathname, AMO_ORIGIN);
  for (const key of keys) url.searchParams.append(key, String(query[key]));
  if (
    url.origin !== AMO_ORIGIN ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Unsafe amoCRM URL");
  }
  return url;
}

function responseHeader(response, name) {
  let headers;
  try {
    headers = response?.headers;
  } catch {
    throw new Error("Malformed amoCRM response");
  }
  if (headers === undefined || headers === null) return null;
  if (typeof headers.get !== "function") {
    throw new Error("Malformed amoCRM response");
  }
  let value;
  try {
    value = headers.get(name);
  } catch {
    throw new Error("Malformed amoCRM response");
  }
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Malformed amoCRM response");
  return value;
}

function responseBody(response) {
  try {
    return response?.body;
  } catch {
    throw new Error("Malformed amoCRM response");
  }
}

function responseContentLength(response) {
  const rawLength = responseHeader(response, "content-length");
  if (rawLength === null) return { declaredBytes: null, verifyExact: false };
  const normalized = rawLength.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw new Error("amoCRM response content length is invalid");
  }
  const declaredBytes = Number(normalized);
  if (!Number.isSafeInteger(declaredBytes)) {
    throw new Error("amoCRM response content length is invalid");
  }
  if (declaredBytes > MAX_RESPONSE_BODY_BYTES) {
    throw new Error("amoCRM response body exceeded safety bound");
  }
  const encoding = responseHeader(response, "content-encoding");
  return {
    declaredBytes,
    verifyExact:
      encoding === null || encoding.trim().toLowerCase() === "identity",
  };
}

function abortResponseBody(body, reader, controller) {
  try {
    controller?.abort?.();
  } catch {
    // The fixed caller error remains authoritative.
  }
  try {
    const cancellation = reader?.cancel
      ? reader.cancel()
      : typeof body?.cancel === "function"
        ? body.cancel()
        : null;
    if (cancellation && typeof cancellation.catch === "function") {
      cancellation.catch(() => undefined);
    }
  } catch {
    // Cancellation is best effort after abort.
  }
}

async function readBoundedJsonResponse(response, controller) {
  let body;
  try {
    body = responseBody(response);
  } catch (error) {
    abortResponseBody(null, null, controller);
    throw error;
  }
  let lengthMetadata;
  try {
    lengthMetadata = responseContentLength(response);
  } catch (error) {
    abortResponseBody(body, null, controller);
    throw error;
  }
  if (!body || typeof body.getReader !== "function") {
    abortResponseBody(body, null, controller);
    throw new Error("amoCRM response body is unavailable");
  }
  let reader;
  try {
    reader = body.getReader();
  } catch {
    abortResponseBody(body, null, controller);
    throw new Error("amoCRM response body read failed");
  }
  if (!reader || typeof reader.read !== "function") {
    abortResponseBody(body, reader, controller);
    throw new Error("amoCRM response body read failed");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      let item;
      try {
        item = await reader.read();
      } catch {
        abortResponseBody(body, reader, controller);
        throw new Error("amoCRM response body read failed");
      }
      if (!isJsonRecord(item) || typeof item.done !== "boolean") {
        abortResponseBody(body, reader, controller);
        throw new Error("amoCRM response body read failed");
      }
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        abortResponseBody(body, reader, controller);
        throw new Error("amoCRM response body read failed");
      }
      bytesRead += item.value.byteLength;
      if (bytesRead > MAX_RESPONSE_BODY_BYTES) {
        abortResponseBody(body, reader, controller);
        throw new Error("amoCRM response body exceeded safety bound");
      }
      try {
        chunks.push(decoder.decode(item.value, { stream: true }));
      } catch {
        abortResponseBody(body, reader, controller);
        throw new Error("amoCRM returned invalid JSON");
      }
    }
    if (
      lengthMetadata.verifyExact &&
      bytesRead !== lengthMetadata.declaredBytes
    ) {
      throw new Error("amoCRM response content length is invalid");
    }
    try {
      chunks.push(decoder.decode());
    } catch {
      throw new Error("amoCRM returned invalid JSON");
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Best effort after completion/abort.
    }
  }
  let payload;
  try {
    payload = JSON.parse(chunks.join(""));
  } catch {
    throw new Error("amoCRM returned invalid JSON");
  }
  if (!isJsonRecord(payload)) throw new Error("Malformed amoCRM response");
  return payload;
}

function createGetOnlyRequester(accessToken, fetchImpl = globalThis.fetch) {
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("amoCRM access token is missing");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const token = accessToken.trim();
  let lastRequestStartedAt = 0;
  return async (pathname, query = {}) => {
    const url = canonicalAmoUrl(pathname, query);
    for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
      const wait = lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestStartedAt = Date.now();
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
        });
      } catch {
        clearTimeout(timeout);
        if (attempt === REQUEST_ATTEMPTS) {
          throw new Error("amoCRM request failed");
        }
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      if (response?.status === 204) {
        clearTimeout(timeout);
        return null;
      }
      if (response?.status === 429 || Number(response?.status) >= 500) {
        clearTimeout(timeout);
        abortResponseBody(responseBody(response), null, controller);
        if (attempt === REQUEST_ATTEMPTS) {
          throw new Error("amoCRM request failed");
        }
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      if (response?.ok !== true) {
        clearTimeout(timeout);
        abortResponseBody(responseBody(response), null, controller);
        throw new Error("amoCRM request rejected");
      }
      try {
        const payload = await readBoundedJsonResponse(response, controller);
        clearTimeout(timeout);
        return payload;
      } catch (error) {
        clearTimeout(timeout);
        if (timedOut && attempt < REQUEST_ATTEMPTS) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }
        if (timedOut) throw new Error("amoCRM request failed");
        throw error;
      }
    }
    throw new Error("amoCRM request failed");
  };
}

async function assertExpectedAccount(request) {
  const account = await request("/api/v4/account");
  if (positiveInteger(account?.id) !== EXPECTED_ACCOUNT_ID) {
    throw new Error("Unexpected amoCRM account");
  }
}

function embeddedLeadIds(contact) {
  const embedded = contact?._embedded;
  if (!isJsonRecord(embedded)) throw new Error("Invalid amoCRM contact record");
  const leads = embedded.leads;
  if (!Array.isArray(leads)) throw new Error("Invalid amoCRM contact record");
  if (leads.length > MAX_LEADS_PER_CONTACT) {
    throw new Error("Contact lead safety bound exceeded");
  }
  const ids = [];
  const seen = new Set();
  for (const lead of leads) {
    const id = positiveInteger(lead?.id);
    if (!id) throw new Error("Invalid amoCRM contact record");
    if (seen.has(id)) throw new Error("Invalid amoCRM contact record");
    seen.add(id);
    ids.push(id);
  }
  return ids.sort((left, right) => left - right);
}

async function lookupExactClientContacts(
  request,
  normalizedPhone,
  maxPages = MAX_CONTACT_SEARCH_PAGES,
) {
  const target = normalizePhone(normalizedPhone);
  if (!target) return { contacts: [], pagesRead: 0, contactsRead: 0 };
  if (
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > MAX_CONTACT_SEARCH_PAGES
  ) {
    throw new Error("amoCRM contacts pagination exceeded safety bound");
  }
  const query = target.slice(-10);
  const seenSearchIds = new Set();
  const exactIds = new Set();
  let contactsRead = 0;
  let pagesRead = 0;
  let completed = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await request("/api/v4/contacts", {
      query,
      limit: PAGE_LIMIT,
      page,
    });
    if (payload === null) {
      completed = true;
      break;
    }
    const contacts = payload?._embedded?.contacts;
    if (!Array.isArray(contacts) || contacts.length > PAGE_LIMIT) {
      throw new Error("Malformed amoCRM contacts page");
    }
    pagesRead = page;
    contactsRead += contacts.length;
    for (const contact of contacts) {
      const id = positiveInteger(contact?.id);
      if (!id) throw new Error("Invalid amoCRM contact record");
      if (seenSearchIds.has(id)) {
        throw new Error("amoCRM contacts pagination loop detected");
      }
      seenSearchIds.add(id);
      if (contactHasExactPhone(contact, target)) exactIds.add(id);
      if (exactIds.size > MAX_EXACT_CONTACTS_PER_PHONE) {
        throw new Error("Exact client contact safety bound exceeded");
      }
    }
    const links = payload?._links;
    if (links !== undefined && links !== null && !isJsonRecord(links)) {
      throw new Error("Malformed amoCRM contacts page");
    }
    const next = links?.next;
    if (next !== undefined && next !== null && !isJsonRecord(next)) {
      throw new Error("Malformed amoCRM contacts page");
    }
    if (next === undefined || next === null) {
      completed = true;
      break;
    }
    if (contacts.length === 0) {
      throw new Error("amoCRM contacts pagination loop detected");
    }
  }
  if (!completed) {
    throw new Error("amoCRM contacts pagination exceeded safety bound");
  }

  const hydrated = [];
  for (const contactId of [...exactIds].sort((left, right) => left - right)) {
    const contact = await request(`/api/v4/contacts/${contactId}`, {
      with: "leads",
    });
    if (
      contact === null ||
      positiveInteger(contact?.id) !== contactId ||
      !contactHasExactPhone(contact, target)
    ) {
      throw new Error("Invalid amoCRM contact record");
    }
    hydrated.push({ contactId, leadIds: embeddedLeadIds(contact) });
  }
  return { contacts: hydrated, pagesRead, contactsRead };
}

function embeddedContactIds(lead) {
  const contacts = lead?._embedded?.contacts;
  if (!Array.isArray(contacts)) throw new Error("Invalid amoCRM lead record");
  if (contacts.length > MAX_CONTACTS_PER_LEAD) {
    throw new Error("Lead contact safety bound exceeded");
  }
  const ids = [];
  const seen = new Set();
  for (const contact of contacts) {
    const id = positiveInteger(contact?.id);
    if (!id || seen.has(id)) throw new Error("Invalid amoCRM lead record");
    seen.add(id);
    ids.push(id);
  }
  return ids.sort((left, right) => left - right);
}

function boundedSelectedScalar(value, maxStringBytes) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }
  if (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= maxStringBytes
  ) {
    return value;
  }
  return "__INVALID_SELECTED_VALUE__";
}

function boundedSelectedValues(lead, fieldId, maxStringBytes) {
  const values = customValues(lead, fieldId);
  if (values.length > MAX_SELECTED_FIELD_VALUES) {
    throw new Error("Lead field value safety bound exceeded");
  }
  return values.map((item) =>
    boundedSelectedScalar(item?.value, maxStringBytes),
  );
}

function reduceLeadEvidence(lead, expectedLeadId) {
  const leadId = positiveInteger(lead?.id);
  const pipelineId = positiveInteger(lead?.pipeline_id);
  const statusId = positiveInteger(lead?.status_id);
  if (leadId !== expectedLeadId || !pipelineId || !statusId) {
    throw new Error("Invalid amoCRM lead record");
  }
  const fromBrokerValues = customValues(lead, LEAD_FIELDS.FROM_BROKER);
  if (fromBrokerValues.length > MAX_SELECTED_FIELD_VALUES) {
    throw new Error("Lead field value safety bound exceeded");
  }
  return {
    leadId,
    pipelineId,
    statusId,
    createdAt: boundedSelectedScalar(lead?.created_at, 64),
    contactIds: embeddedContactIds(lead),
    sourceMarker: fromBrokerValues.some(
      (item) => Number(item?.enum_id) === FROM_BROKER_YES_ENUM_ID,
    ),
    requestValues: boundedSelectedValues(
      lead,
      LEAD_FIELDS.BROKER_REQUEST_DATE,
      64,
    ),
    projectValues: boundedSelectedValues(
      lead,
      LEAD_FIELDS.INTEREST_OBJECT,
      128,
    ),
  };
}

async function collectAmoEvidence(queueRows, request) {
  const phones = [
    ...new Set(
      queueRows.map((row) => normalizePhone(row?.phone)).filter(Boolean),
    ),
  ].sort();
  const contactLookups = new Map();
  const allLeadIds = new Set();
  let contactSearchPages = 0;
  let contactRowsRead = 0;
  let exactContacts = 0;

  for (const phone of phones) {
    activeFailurePhase = FAILURE_PHASE.CONTACT_LOOKUP;
    const lookup = await lookupExactClientContacts(request, phone);
    contactLookups.set(phone, lookup);
    contactSearchPages += lookup.pagesRead;
    contactRowsRead += lookup.contactsRead;
    exactContacts += lookup.contacts.length;
    const phoneLeadIds = new Set();
    for (const contact of lookup.contacts) {
      for (const leadId of contact.leadIds) {
        phoneLeadIds.add(leadId);
        if (phoneLeadIds.size > MAX_LINKED_LEADS_PER_PHONE) {
          throw new Error("Phone lead safety bound exceeded");
        }
        allLeadIds.add(leadId);
        if (allLeadIds.size > MAX_DISTINCT_LEADS) {
          throw new Error("Distinct lead safety bound exceeded");
        }
      }
    }
  }

  activeFailurePhase = FAILURE_PHASE.LEAD_LOOKUP;
  const leads = new Map();
  for (const leadId of [...allLeadIds].sort((left, right) => left - right)) {
    const lead = await request(`/api/v4/leads/${leadId}`, { with: "contacts" });
    if (lead === null) {
      throw new Error("Invalid amoCRM lead record");
    }
    leads.set(leadId, reduceLeadEvidence(lead, leadId));
  }

  const byPhone = new Map();
  for (const phone of phones) {
    const lookup = contactLookups.get(phone);
    const exactContactIds = lookup.contacts
      .map((contact) => contact.contactId)
      .sort((left, right) => left - right);
    const leadIds = new Set();
    for (const contact of lookup.contacts) {
      for (const leadId of contact.leadIds) {
        const current = leads.get(leadId);
        if (!current || !current.contactIds.includes(contact.contactId)) {
          throw new Error("amoCRM contact/lead relation changed during scan");
        }
        leadIds.add(leadId);
        if (leadIds.size > MAX_LINKED_LEADS_PER_PHONE) {
          throw new Error("Phone lead safety bound exceeded");
        }
      }
    }
    byPhone.set(phone, {
      exactContactIds,
      leads: [...leadIds]
        .sort((left, right) => left - right)
        .map((leadId) => leads.get(leadId)),
    });
  }

  return {
    byPhone,
    stats: {
      normalizedPhones: phones.length,
      contactSearchPages,
      contactRowsRead,
      exactContacts,
      distinctLinkedLeadsRead: leads.size,
    },
  };
}

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function relativeTimeClass(offsetSeconds) {
  if (!Number.isFinite(offsetSeconds)) return "unavailable";
  if (Math.abs(offsetSeconds) <= STRONG_TIME_WINDOW_SECONDS) {
    return "within_15m";
  }
  if (offsetSeconds < -WEAK_TIME_WINDOW_SECONDS) return "before_more_than_24h";
  if (offsetSeconds < -2 * 60 * 60) return "before_within_24h";
  if (offsetSeconds < 0) return "before_within_2h";
  if (offsetSeconds <= 2 * 60 * 60) return "after_within_2h";
  if (offsetSeconds <= WEAK_TIME_WINDOW_SECONDS) return "after_within_24h";
  return "after_more_than_24h";
}

function unixTimestampEvidence(rawValues, referenceDate) {
  const reference = validDate(referenceDate);
  const raw = Array.isArray(rawValues) ? rawValues : [rawValues];
  const valid = [];
  let invalidCount = 0;
  for (const item of raw) {
    if (item === null || item === undefined || item === "") continue;
    const value = Number(item);
    if (
      Number.isSafeInteger(value) &&
      value >= MIN_EVENT_UNIX_SECONDS &&
      value <= MAX_EVENT_UNIX_SECONDS
    ) {
      valid.push(value);
    } else {
      invalidCount += 1;
    }
  }
  const unique = [...new Set(valid)].sort((left, right) => left - right);
  const coverage =
    unique.length === 0
      ? invalidCount > 0
        ? "invalid"
        : "missing"
      : unique.length > 1 || invalidCount > 0
        ? "conflicting"
        : "valid";
  if (!reference || coverage !== "valid") {
    return {
      coverage,
      validValueCount: unique.length,
      relativeToQueue: "unavailable",
      withinStrongWindow: false,
      withinWeakWindow: false,
      rawValidValues: unique,
      invalidValueCount: invalidCount,
    };
  }
  const referenceSeconds = reference.getTime() / 1000;
  const offsets = unique.map((value) => value - referenceSeconds);
  offsets.sort(
    (left, right) => Math.abs(left) - Math.abs(right) || left - right,
  );
  const closest = offsets[0];
  return {
    coverage,
    validValueCount: unique.length,
    relativeToQueue: relativeTimeClass(closest),
    withinStrongWindow:
      closest >= -STRONG_NEGATIVE_CLOCK_SKEW_SECONDS &&
      closest <= STRONG_TIME_WINDOW_SECONDS,
    withinWeakWindow: Math.abs(closest) <= WEAK_TIME_WINDOW_SECONDS,
    rawValidValues: unique,
    invalidValueCount: invalidCount,
  };
}

function publicTimestampEvidence(evidence) {
  return {
    coverage: evidence.coverage,
    validValueCount: evidence.validValueCount,
    relativeToQueue: evidence.relativeToQueue,
  };
}

function projectMatchEvidence(values, expectedProject) {
  const expectedLabel = PROJECT_LABELS[expectedProject];
  if (!expectedLabel) throw new Error("Invalid queue row");
  if (!Array.isArray(values) || values.length === 0) {
    return { coverage: "missing", matches: false };
  }
  const normalized = values.map((value) =>
    typeof value === "string" ? value.normalize("NFKC").trim() : "",
  );
  if (
    normalized.some((value) => !value || value === "__INVALID_SELECTED_VALUE__")
  ) {
    return { coverage: "invalid", matches: false };
  }
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== 1) {
    return { coverage: "conflicting", matches: false };
  }
  return unique[0] === expectedLabel
    ? { coverage: "match", matches: true }
    : { coverage: "mismatch", matches: false };
}

function reportHash(kind, value, hashKey) {
  if (value === null || value === undefined || value === "") return null;
  if (!Buffer.isBuffer(hashKey) || hashKey.length < 32) {
    throw new Error("Report hash key is invalid");
  }
  const digest = createHmac("sha256", hashKey)
    .update(`${REPORT_HASH_DOMAIN}:${kind}:${String(value)}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${kind}_${digest}`;
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
    /timeout|timed out|network|socket|fetch|econn|enotfound/.test(normalized)
  ) {
    return "network_failure";
  }
  if (/not configured|missing token/.test(normalized))
    return "configuration_missing";
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
    /did not return a lead id/.test(normalized)
  ) {
    return "invalid_response";
  }
  if (raw === "AMO_SYNC_FAILED") return "sync_failed";
  return "other";
}

function isCasLinkEligibleErrorClass(errorClass) {
  return CAS_LINK_ELIGIBLE_ERROR_CLASSES.includes(errorClass);
}

function effectiveBroker(row) {
  if (row?.responsibleBroker) {
    return { source: "responsible", broker: row.responsibleBroker };
  }
  if (row?.broker) return { source: "owner_fallback", broker: row.broker };
  return { source: "missing", broker: null };
}

function inspectCandidate(row, leadEnvelope, exactContactIds, hashKey) {
  const leadId = positiveInteger(leadEnvelope?.leadId);
  const pipelineId = positiveInteger(leadEnvelope?.pipelineId);
  const statusId = positiveInteger(leadEnvelope?.statusId);
  if (
    !leadId ||
    !pipelineId ||
    !statusId ||
    !Array.isArray(leadEnvelope?.contactIds) ||
    !Array.isArray(leadEnvelope?.requestValues) ||
    !Array.isArray(leadEnvelope?.projectValues) ||
    typeof leadEnvelope?.sourceMarker !== "boolean"
  ) {
    throw new Error("Invalid reconciliation evidence");
  }
  const linkedExactContactIds = leadEnvelope.contactIds.filter((id) =>
    exactContactIds.includes(id),
  );
  if (linkedExactContactIds.length === 0) {
    throw new Error("amoCRM contact/lead relation changed during scan");
  }
  const effective = effectiveBroker(row);
  const expectedBrokerContactId = positiveInteger(
    effective.broker?.amoContactId,
  );
  const roleCollision = Boolean(
    expectedBrokerContactId &&
    exactContactIds.includes(expectedBrokerContactId),
  );
  const brokerAttachment = roleCollision
    ? "role_collision"
    : expectedBrokerContactId
      ? leadEnvelope.contactIds.includes(expectedBrokerContactId)
        ? "present"
        : "absent"
      : "unavailable";
  const created = unixTimestampEvidence(leadEnvelope.createdAt, row.createdAt);
  const request = unixTimestampEvidence(
    leadEnvelope.requestValues,
    row.createdAt,
  );
  const project = projectMatchEvidence(leadEnvelope.projectValues, row.project);
  const sourceMarker = leadEnvelope.sourceMarker;
  const inKcPipeline = pipelineId === KC_PIPELINE_ID;
  const strongTime = created.withinStrongWindow || request.withinStrongWindow;
  const weakEvidence =
    brokerAttachment === "present" ||
    sourceMarker ||
    project.matches ||
    created.withinWeakWindow ||
    request.withinWeakWindow;
  const strength = !inKcPipeline
    ? "outside_kc"
    : brokerAttachment === "present" && strongTime && project.matches
      ? "strong"
      : weakEvidence
        ? "weak"
        : "unrelated";
  const publicRecord = {
    leadHash: reportHash("lead", leadId, hashKey),
    exactClientContactHashes: linkedExactContactIds
      .map((id) => reportHash("contact", id, hashKey))
      .sort(),
    expectedBrokerAttachment: brokerAttachment,
    strictBrokerSourceMarker: sourceMarker,
    projectEvidence: project.coverage,
    leadCreatedAt: publicTimestampEvidence(created),
    brokerRequestAt: publicTimestampEvidence(request),
  };
  return {
    raw: {
      leadId,
      pipelineId,
      statusId,
      contactIds: [...leadEnvelope.contactIds],
      linkedExactContactIds: [...linkedExactContactIds],
      expectedBrokerContactId,
      brokerAttachment,
      sourceMarker,
      projectEvidence: project.coverage,
      projectValues: [...leadEnvelope.projectValues],
      createdAt: leadEnvelope.createdAt ?? null,
      createdValidValues: created.rawValidValues,
      createdInvalidValueCount: created.invalidValueCount,
      requestValidValues: request.rawValidValues,
      requestInvalidValueCount: request.invalidValueCount,
      strength,
    },
    publicRecord,
    strength,
  };
}

function rowResolution({
  storedLeadId,
  normalizedPhone,
  effective,
  expectedBrokerContactId,
  roleCollision,
  exactContactCount,
  strongCount,
  weakCount,
}) {
  if (storedLeadId) return "database_lead_already_present";
  if (!normalizedPhone) return "invalid_client_phone";
  if (!effective.broker) return "effective_broker_missing";
  if (!expectedBrokerContactId) return "broker_contact_missing";
  if (exactContactCount === 0) return "no_exact_client_contact";
  if (roleCollision) return "broker_client_contact_role_collision";
  if (exactContactCount > 1) return "ambiguous_exact_client_contacts";
  if (strongCount > 1) return "multiple_strong_candidates";
  if (strongCount === 1 && weakCount > 0) {
    return "single_strong_with_weak_candidates";
  }
  if (strongCount === 1) return "single_strong_candidate";
  if (weakCount > 1) return "multiple_weak_candidates";
  if (weakCount === 1) return "single_weak_candidate";
  return "no_candidate";
}

function inspectQueueRow(row, evidenceByPhone, hashKey) {
  if (!row?.id || !validDate(row.createdAt) || !PROJECT_LABELS[row.project])
    throw new Error("Invalid queue row");
  const normalizedPhone = normalizePhone(row.phone);
  const evidence = normalizedPhone
    ? evidenceByPhone.get(normalizedPhone) || { exactContactIds: [], leads: [] }
    : { exactContactIds: [], leads: [] };
  if (
    !Array.isArray(evidence.exactContactIds) ||
    !Array.isArray(evidence.leads)
  ) {
    throw new Error("Invalid reconciliation evidence");
  }
  const effective = effectiveBroker(row);
  const expectedBrokerContactId = positiveInteger(
    effective.broker?.amoContactId,
  );
  const roleCollision = Boolean(
    expectedBrokerContactId &&
    evidence.exactContactIds.includes(expectedBrokerContactId),
  );
  // Prisma returns PostgreSQL BIGINT values as bigint. A malformed or
  // out-of-range persisted ID is evidence of an unsafe state, not evidence
  // that the row is unlinked.
  const storedLeadId = optionalStoredAmoLeadId(row.amoLeadId);
  const candidates = evidence.leads
    .map((lead) =>
      inspectCandidate(row, lead, evidence.exactContactIds, hashKey),
    )
    .sort((left, right) => left.raw.leadId - right.raw.leadId);
  const strong = candidates.filter(
    (candidate) => candidate.strength === "strong",
  );
  const weak = candidates.filter((candidate) => candidate.strength === "weak");
  const unrelated = candidates.filter(
    (candidate) => candidate.strength === "unrelated",
  );
  const outsideKc = candidates.filter(
    (candidate) => candidate.strength === "outside_kc",
  );
  const resolution = rowResolution({
    storedLeadId,
    normalizedPhone,
    effective,
    expectedBrokerContactId,
    roleCollision,
    exactContactCount: evidence.exactContactIds.length,
    strongCount: strong.length,
    weakCount: weak.length,
  });
  const errorClass = classifySyncError(row.amoSyncError);
  if (!RESOLUTION_CLASSES.includes(resolution)) {
    throw new Error("Invalid reconciliation evidence");
  }
  const storedObserved = storedLeadId
    ? candidates.some((candidate) => candidate.raw.leadId === storedLeadId)
    : false;
  const publicRecord = {
    queueHash: reportHash("queue", row.id, hashKey),
    effectiveBrokerHash: effective.broker?.id
      ? reportHash("broker", effective.broker.id, hashKey)
      : null,
    storedLeadHash: storedLeadId
      ? reportHash("lead", storedLeadId, hashKey)
      : null,
    storedLeadObservedInLinkedEvidence: storedObserved,
    queueStatus: QUEUE_STATUSES.includes(row.amoSyncStatus)
      ? row.amoSyncStatus
      : "UNKNOWN",
    attemptLimitReached: Number(row.amoSyncAttempts) >= ATTEMPT_LIMIT,
    errorClass,
    mappingSource: effective.source,
    exactClientContacts: {
      count: evidence.exactContactIds.length,
      hashes: evidence.exactContactIds
        .map((id) => reportHash("contact", id, hashKey))
        .sort(),
    },
    linkedLeadEvidence: {
      total: candidates.length,
      kcPipeline: strong.length + weak.length + unrelated.length,
      outsideKcPipeline: outsideKc.length,
      strong: strong.length,
      weak: weak.length,
      unrelatedKc: unrelated.length,
    },
    resolution,
    strongCandidates: strong.map((candidate) => candidate.publicRecord),
    weakCandidates: weak.map((candidate) => candidate.publicRecord),
    advisory: {
      casLinkCandidate:
        resolution === "single_strong_candidate" &&
        storedLeadId === null &&
        isCasLinkEligibleErrorClass(errorClass),
      executablePayload: false,
      databaseMutationAuthorized: false,
      amoMutationAuthorized: false,
      retryAuthorized: false,
    },
  };
  const attestationRecord = {
    queueId: String(row.id),
    queueCreatedAt: validDate(row.createdAt).toISOString(),
    lastAttemptAt: validDate(row.amoSyncLastAttemptAt)?.toISOString() || null,
    queueStatus: String(row.amoSyncStatus || ""),
    syncAttempts: Number(row.amoSyncAttempts || 0),
    syncError: String(row.amoSyncError || ""),
    project: row.project,
    storedLeadId,
    normalizedPhone,
    effectiveBrokerId: effective.broker?.id
      ? String(effective.broker.id)
      : null,
    expectedBrokerContactId,
    exactContactIds: [...evidence.exactContactIds].sort((a, b) => a - b),
    candidates: candidates.map((candidate) => candidate.raw),
    resolution,
  };
  return {
    publicRecord,
    attestationRecord,
    strongRawIds: strong.map((c) => c.raw.leadId),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cohortAttestation(records, metadata, attestationKey) {
  if (!Buffer.isBuffer(attestationKey) || attestationKey.length < 32) {
    throw new Error("Cohort attestation key is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(metadata?.inspectorSha256 || "")) {
    throw new Error("Inspector source hash is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(metadata?.deployedGitSha || "")) {
    throw new Error("Deployed git SHA is invalid");
  }
  const canonical = stableJson({
    deployedGitSha: metadata.deployedGitSha,
    inspectorSha256: metadata.inspectorSha256,
    records: [...records].sort((left, right) =>
      left.queueId.localeCompare(right.queueId),
    ),
  });
  const hmac = createHmac("sha256", attestationKey);
  const domainBytes = Buffer.from(COHORT_ATTESTATION_DOMAIN, "utf8");
  const canonicalBytes = Buffer.from(canonical, "utf8");
  hmac.update(`${domainBytes.length}:`, "utf8");
  hmac.update(domainBytes);
  hmac.update(`${canonicalBytes.length}:`, "utf8");
  hmac.update(canonicalBytes);
  return hmac.digest("hex");
}

function zeroCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function increment(target, key, amount = 1) {
  target[key] = Number(target[key] || 0) + amount;
}

function assertExpectedQueueRows(rows) {
  if (!Array.isArray(rows) || rows.length !== KNOWN_QUEUE_ROWS) {
    throw new Error("Exhausted queue cohort count changed");
  }
}

function buildReport(
  queueRows,
  amoEvidence,
  metadata,
  attestationKey,
  hashKey = randomBytes(32),
) {
  assertExpectedQueueRows(queueRows);
  const inspected = queueRows
    .map((row) => inspectQueueRow(row, amoEvidence.byPhone, hashKey))
    .sort((left, right) =>
      left.attestationRecord.queueId.localeCompare(
        right.attestationRecord.queueId,
      ),
    );
  const resolution = zeroCounts(RESOLUTION_CLASSES);
  const errorClass = zeroCounts(ERROR_CLASSES);
  const candidates = { strong: 0, weak: 0, unrelatedKc: 0, outsideKc: 0 };
  const exactClientContacts = { none: 0, one: 0, multiple: 0 };
  const strongLeadToRows = new Map();
  for (const record of inspected) {
    increment(resolution, record.publicRecord.resolution);
    increment(errorClass, record.publicRecord.errorClass);
    candidates.strong += record.publicRecord.linkedLeadEvidence.strong;
    candidates.weak += record.publicRecord.linkedLeadEvidence.weak;
    candidates.unrelatedKc +=
      record.publicRecord.linkedLeadEvidence.unrelatedKc;
    candidates.outsideKc +=
      record.publicRecord.linkedLeadEvidence.outsideKcPipeline;
    const exactCount = record.publicRecord.exactClientContacts.count;
    increment(
      exactClientContacts,
      exactCount === 0 ? "none" : exactCount === 1 ? "one" : "multiple",
    );
    for (const leadId of record.strongRawIds) {
      if (!strongLeadToRows.has(leadId)) strongLeadToRows.set(leadId, 0);
      strongLeadToRows.set(leadId, strongLeadToRows.get(leadId) + 1);
    }
  }
  const attestationRecords = inspected.map(
    (record) => record.attestationRecord,
  );
  const digest = cohortAttestation(
    attestationRecords,
    metadata,
    attestationKey,
  );
  return {
    inspector: "amo_fixation_lead_reconciliation",
    schemaVersion: 1,
    safety: {
      readOnly: true,
      databaseSessionReadOnly: true,
      databaseOperations:
        "read-only session verification SELECT plus one Prisma findMany SELECT",
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      amoHttpMethods: ["GET"],
      amoEndpoints: [
        "/api/v4/account",
        "/api/v4/contacts?query=<last10>",
        "/api/v4/contacts/{hmac-only-id}?with=leads",
        "/api/v4/leads/{hmac-only-id}?with=contacts",
      ],
      oauthRefreshAttempted: false,
      nestApplicationBootstrapped: false,
      databaseMutations: false,
      amoMutations: false,
      rawIdentifiersEmitted: false,
      namesEmailsCommentsSelected: false,
      clientPhonesHeldInMemoryOnly: true,
      nonTransactionalCurrentStateScan: true,
    },
    classification: {
      aliases: "hmac-sha256-per-report-random-key-v1-24hex",
      aliasesCrossRunLinkable: false,
      strongCandidate:
        "distinct exact-client-contact + KC pipeline + expected-broker-contact + matching project + one valid created-or-request timestamp from 2 minutes before through 15 minutes after the queue row",
      weakCandidate:
        "exact-client-contact + KC pipeline + broker/source/project/time evidence, but not strong",
      createdAndRequestTimestamps:
        "inspected exactly in memory; emitted only as coverage and relative-time classes; queue timestamps remain HMAC-only",
      collisionPolicy: "fail_closed",
    },
    cohortAttestation: {
      hmacSha256: digest,
      domain: COHORT_ATTESTATION_DOMAIN,
      canonicalization: COHORT_CANONICALIZATION,
      deterministicForSameSecretAndEvidence: true,
      bindsInspectorSha256: metadata.inspectorSha256,
      bindsDeployedGitSha: metadata.deployedGitSha,
      expectedQueueRows: KNOWN_QUEUE_ROWS,
      rawAttestationInputEmitted: false,
    },
    plan: {
      advisoryOnly: true,
      executablePayload: false,
      databaseMutationAuthorized: false,
      amoMutationAuthorized: false,
      retryAuthorized: false,
      requiredNextGate:
        "separately reviewed exact-cohort CAS link for one unambiguous strong candidate; only proven no-lead rows may be considered for a later retry",
    },
    aggregates: {
      exhaustedQueueRows: queueRows.length,
      amoLookup: { ...amoEvidence.stats },
      exactClientContacts,
      candidates,
      resolution,
      errorClass,
      rowsWithCasLinkCandidate: inspected.filter(
        (record) => record.publicRecord.advisory.casLinkCandidate,
      ).length,
      strongLeadHashesSharedAcrossRows: [...strongLeadToRows.values()].filter(
        (count) => count > 1,
      ).length,
    },
    records: inspected.map((record) => record.publicRecord),
  };
}

function readCohortAttestationKey(keyFile) {
  if (typeof keyFile !== "string" || !keyFile || !isAbsolute(keyFile)) {
    throw new Error("Cohort attestation key file is invalid");
  }
  let stat;
  try {
    stat = lstatSync(keyFile);
  } catch {
    throw new Error("Cohort attestation key file is invalid");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 32 ||
    stat.size > 4096
  ) {
    throw new Error("Cohort attestation key file is invalid");
  }
  let key;
  try {
    key = readFileSync(keyFile);
  } catch {
    throw new Error("Cohort attestation key file is invalid");
  }
  if (!Buffer.isBuffer(key) || key.length < 32 || key.length > 4096) {
    throw new Error("Cohort attestation key is invalid");
  }
  return key;
}

function readRuntimeMetadata(environment = process.env) {
  const keyFile = environment.BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE;
  delete environment.BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE;
  const inspectorSha256 = String(
    environment.LEAD_RECONCILIATION_INSPECTOR_SHA256 || "",
  ).trim();
  const deployedGitSha = String(
    environment.LEAD_RECONCILIATION_DEPLOYED_GIT_SHA || "",
  ).trim();
  const rawExpected = String(
    environment.LEAD_RECONCILIATION_EXPECTED_QUEUE_ROWS || "",
  ).trim();
  if (!/^[0-9a-f]{64}$/.test(inspectorSha256)) {
    throw new Error("Inspector source hash is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(deployedGitSha)) {
    throw new Error("Deployed git SHA is invalid");
  }
  if (rawExpected !== String(KNOWN_QUEUE_ROWS)) {
    throw new Error("Expected queue row count is invalid");
  }
  return {
    attestationKey: readCohortAttestationKey(keyFile),
    metadata: {
      inspectorSha256,
      deployedGitSha,
    },
  };
}

async function main() {
  activeFailurePhase = FAILURE_PHASE.ATTESTATION;
  const runtime = readRuntimeMetadata();
  const { PrismaClient } = require("@st-michael/database");
  const readOnlyDatabaseUrl = buildReadOnlyDatabaseUrl(
    process.env.DATABASE_URL,
  );
  const prisma = new PrismaClient({
    datasources: { db: { url: readOnlyDatabaseUrl } },
  });
  try {
    activeFailurePhase = FAILURE_PHASE.DATABASE;
    await assertReadOnlySession(prisma);
    const queueRows = await prisma.client.findMany({
      where: {
        amoSyncStatus: { in: QUEUE_STATUSES },
        amoSyncAttempts: { gte: ATTEMPT_LIMIT },
      },
      select: {
        id: true,
        phone: true,
        project: true,
        createdAt: true,
        amoLeadId: true,
        amoSyncStatus: true,
        amoSyncAttempts: true,
        amoSyncLastAttemptAt: true,
        amoSyncError: true,
        broker: { select: { id: true, amoContactId: true } },
        responsibleBroker: { select: { id: true, amoContactId: true } },
      },
      orderBy: [
        { amoSyncLastAttemptAt: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      // Twelve exact rows plus one overflow sentinel; any thirteenth row makes
      // the cohort assertion fail closed before amoCRM is queried.
      take: 13,
    });
    assertExpectedQueueRows(queueRows);

    activeFailurePhase = FAILURE_PHASE.ACCOUNT;
    const request = createGetOnlyRequester(process.env.AMO_ACCESS_TOKEN);
    await assertExpectedAccount(request);
    const amoEvidence = await collectAmoEvidence(queueRows, request);

    activeFailurePhase = FAILURE_PHASE.REPORT;
    const report = buildReport(
      queueRows,
      amoEvidence,
      runtime.metadata,
      runtime.attestationKey,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  AMO_ORIGIN,
  ATTEMPT_LIMIT,
  CAS_LINK_ELIGIBLE_ERROR_CLASSES,
  COHORT_ATTESTATION_DOMAIN,
  EXPECTED_ACCOUNT_ID,
  KC_PIPELINE_ID,
  KNOWN_QUEUE_ROWS,
  MAX_CONTACT_SEARCH_PAGES,
  MAX_DISTINCT_LEADS,
  MAX_EXACT_CONTACTS_PER_PHONE,
  MAX_LINKED_LEADS_PER_PHONE,
  MAX_RESPONSE_BODY_BYTES,
  STATEMENT_TIMEOUT_MS,
  assertExpectedAccount,
  assertExpectedQueueRows,
  assertReadOnlySession,
  buildReadOnlyDatabaseUrl,
  buildReport,
  canonicalAmoUrl,
  classifyFailure,
  classifySyncError,
  cohortAttestation,
  collectAmoEvidence,
  contactHasExactPhone,
  createGetOnlyRequester,
  inspectQueueRow,
  isCasLinkEligibleErrorClass,
  lookupExactClientContacts,
  normalizePhone,
  optionalStoredAmoLeadId,
  readBoundedJsonResponse,
  reduceLeadEvidence,
  relativeTimeClass,
  reportHash,
  stableJson,
  unixTimestampEvidence,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `failure_phase=${activeFailurePhase}\nfailure_code=${classifyFailure(error)}\n`,
    );
    process.exitCode = 1;
  });
}
