"use strict";

// One approved case only. Private phones, tokens and raw CRM/DB errors never
// leave memory. This program cannot refresh credentials or repair a record.
const { createHash, randomBytes } = require("node:crypto");
const helpers = typeof FIXED_CASE_RECONCILIATION_HELPERS !== "undefined"
  ? FIXED_CASE_RECONCILIATION_HELPERS
  : require("./inspect-amo-fixation-lead-reconciliation.js");
const CLIENT_ID = "8d082b21-7cba-4778-a6c6-1d80bfe7ed7c";
const EXPECTED_BROKER_ID = "6e414141-f2ca-4c71-8402-2032c9186568";
// AMO_CONTACT_FIELDS.IS_BROKER in the reviewed shared field map; regression
// tests bind this exact checkbox ID, without importing a mutable live module.
const IS_BROKER_FIELD_ID = 835415;
const KC_PIPELINE_ID = 7600542;
const REVIEW_LEAD_ID = 32372907;
const REVIEW_EVENT_PAGE_LIMIT = 100;
const REVIEW_EVENT_MAX_PAGES = 5;
const REVIEW_MAX_HISTORICAL_CONTACTS = 10;
const REVIEW_HISTORY_MAX_BODY_BYTES = 1024 * 1024;
const WINDOW_PAGE_LIMIT = 250;
const WINDOW_MAX_PAGES = 10;
const BROKER_MAX_LINKED_LEADS = 250;
// Manual review may happen after a weekend. Keep the scope fixed to this
// approved case and KC pipeline, with the existing hard page/row limits and
// fail-closed pagination. Never treat a truncated scan as absence evidence.
const WINDOW_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const WINDOW_SKEW_SECONDS = 120;
const BROKER_SELECT = {
  id: true, phone: true, amoContactId: true, role: true, status: true, mergedIntoId: true,
  brokerAgencies: { select: { agencyId: true, isPrimary: true }, take: 101 },
};
const CLIENT_SELECT = {
  id: true, brokerId: true, responsibleBrokerId: true, phone: true, fullName: true,
  project: true, fixationAgencyId: true, createdAt: true, updatedAt: true,
  amoLeadId: true, amoCreatedAt: true, amoUpdatedAt: true,
  amoSyncStatus: true, amoSyncAttempts: true, amoSyncLastAttemptAt: true,
  amoSyncError: true, uniquenessStatus: true, uniquenessExpiresAt: true,
  fixationStatus: true, fixationExpiresAt: true, status: true,
  propertyType: true, roomsCount: true, amount: true, sqm: true,
  purchaseTiming: true, readinessLevel: true,
  broker: { select: BROKER_SELECT }, responsibleBroker: { select: BROKER_SELECT },
};
const SAFE_VALUES = {
  project: ["ZORGE9", "SILVER_BOR", "TOLBUKHINA", "UNKNOWN"],
  amoSyncStatus: ["PENDING", "FAILED", "SYNCED"],
  uniquenessStatus: ["CONDITIONALLY_UNIQUE", "REJECTED", "UNDER_REVIEW", "EXPIRED"],
  fixationStatus: ["NOT_FIXED", "FIXED", "EXPIRED", "ANNULLED"],
  status: ["NEW", "BOOKED", "DEAL", "CANCELLED"],
  brokerStatus: ["ACTIVE", "BLOCKED", "PENDING"],
};
const NO_WRITE = Object.freeze({
  executablePayload: false, databaseMutationAuthorized: false,
  amoMutationAuthorized: false, retryAuthorized: false,
});

function refused(code) { const error = new Error("Fixed case inspection refused"); error.safeCode = code; throw error; }
function positiveId(value) {
  if (typeof value === "bigint") return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function iso(value, optional = false) {
  if (optional && value === null) return null;
  // Intrinsic Date operations validate the actual Date internal slot and also
  // work for Prisma/test objects created in another JavaScript realm.
  let time, year;
  try { time = Date.prototype.getTime.call(value); year = Date.prototype.getUTCFullYear.call(value); }
  catch { refused("INVALID_CASE_TIMESTAMP"); }
  if (!Number.isFinite(time) || year < 2000 || year > 2100) refused("INVALID_CASE_TIMESTAMP");
  return Date.prototype.toISOString.call(value);
}
function enumValue(key, value) {
  if (!SAFE_VALUES[key].includes(value)) refused("INVALID_CASE_STATE");
  return value;
}
function effectiveBroker(row) {
  if (row.responsibleBrokerId !== null) {
    if (!row.responsibleBroker || row.responsibleBroker.id !== row.responsibleBrokerId) refused("RESPONSIBLE_BROKER_UNRESOLVED");
    return { source: "responsible", broker: row.responsibleBroker };
  }
  if (!row.broker || row.broker.id !== row.brokerId) refused("OWNER_BROKER_UNRESOLVED");
  return { source: "owner_fallback", broker: row.broker };
}
function canInspectEffectiveBroker(row, effective = effectiveBroker(row)) {
  if (effective.broker.role !== "BROKER" || effective.broker.mergedIntoId !== null) return false;
  if (effective.broker.id === EXPECTED_BROKER_ID) return true;
  // The additional read-only scope is the stored responsible relation of this
  // one approved owner's one client, never a guessed/newest duplicate account.
  return row.brokerId === EXPECTED_BROKER_ID && row.broker?.id === EXPECTED_BROKER_ID &&
    row.responsibleBrokerId !== null && effective.source === "responsible";
}
function validateCase(row, allowOwnershipMismatch = false) {
  if (!row || row.id !== CLIENT_ID) refused("FIXED_CLIENT_MISSING");
  const effective = effectiveBroker(row);
  const expectedParticipant = row.brokerId === EXPECTED_BROKER_ID || row.responsibleBrokerId === EXPECTED_BROKER_ID;
  const expectedEffective = effective.broker.id === EXPECTED_BROKER_ID;
  if (!expectedParticipant || (!expectedEffective && !allowOwnershipMismatch)) refused("EXPECTED_BROKER_MISMATCH");
  if (row.brokerId === EXPECTED_BROKER_ID && row.broker?.id !== EXPECTED_BROKER_ID) refused("OWNER_BROKER_UNRESOLVED");
  if (expectedEffective && (effective.broker.role !== "BROKER" || effective.broker.mergedIntoId !== null)) refused("EXPECTED_BROKER_NOT_CANONICAL");
  if (!["BROKER", "MANAGER", "ADMIN"].includes(effective.broker.role)) refused("INVALID_CASE_STATE");
  enumValue("brokerStatus", effective.broker.status);
  const crmReadAllowed = canInspectEffectiveBroker(row, effective);
  if (crmReadAllowed && !helpers.normalizePhone(row.phone)) refused("INVALID_CLIENT_PHONE");
  if (crmReadAllowed && !["ZORGE9", "SILVER_BOR"].includes(row.project)) refused("PROJECT_MAPPING_UNSUPPORTED");
  if (!Number.isSafeInteger(row.amoSyncAttempts) || row.amoSyncAttempts < 0) refused("INVALID_SYNC_ATTEMPTS");
  for (const key of ["project", "amoSyncStatus", "uniquenessStatus", "fixationStatus", "status"]) enumValue(key, row[key]);
  for (const key of ["createdAt", "updatedAt"]) iso(row[key]);
  for (const key of ["amoCreatedAt", "amoUpdatedAt", "amoSyncLastAttemptAt", "uniquenessExpiresAt", "fixationExpiresAt"]) iso(row[key], true);
  helpers.optionalStoredAmoLeadId(row.amoLeadId);
  if (crmReadAllowed && effective.broker.amoContactId !== null && !positiveId(effective.broker.amoContactId)) refused("INVALID_BROKER_CONTACT_ID");
  if (crmReadAllowed && (!Array.isArray(effective.broker.brokerAgencies) || effective.broker.brokerAgencies.length > 100)) refused("AGENCY_SCOPE_TOO_LARGE");
  return effective;
}
function privateFingerprint(row) {
  // Snapshot equality includes all selected values, not only updatedAt. This
  // detects imports/raw SQL that change linkage without updating timestamps.
  return createHash("sha256").update(JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value)).digest("hex");
}
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function unixTime(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 946684800 && value <= 4133980800 ? value : null;
}
function expectedGeneratedName(row) {
  if (typeof row.fullName !== "string" || !row.fullName.trim() || Buffer.byteLength(row.fullName, "utf8") > 1000 || /[\x00-\x1f\x7f]/.test(row.fullName)) refused("INVALID_CASE_NAME");
  return `Фиксация: ${row.fullName} (${row.project})`;
}
function makeEvidenceWindow(row, scanNow) {
  const created = Math.floor(new Date(iso(row.createdAt)).getTime() / 1000);
  const now = Math.floor(new Date(iso(scanNow)).getTime() / 1000);
  if (now < created - WINDOW_SKEW_SECONDS || now - created > WINDOW_MAX_AGE_SECONDS) refused("CASE_SCAN_WINDOW_UNSAFE");
  expectedGeneratedName(row);
  return { pipelineId: KC_PIPELINE_ID, from: created - WINDOW_SKEW_SECONDS, to: now + WINDOW_SKEW_SECONDS };
}
function validateEvidenceWindow(window) {
  if (!record(window) || Object.keys(window).sort().join(",") !== "from,pipelineId,to" || window.pipelineId !== KC_PIPELINE_ID || !unixTime(window.from) || !unixTime(window.to) || window.to < window.from || window.to - window.from > WINDOW_MAX_AGE_SECONDS + 2 * WINDOW_SKEW_SECONDS) refused("CASE_SCAN_WINDOW_UNSAFE");
}
function createKcWindowRequester(accessToken, fetchImpl = globalThis.fetch, window) {
  validateEvidenceWindow(window);
  window = { ...window };
  if (typeof accessToken !== "string" || !accessToken.trim() || typeof fetchImpl !== "function") refused("WINDOW_REQUEST_CONFIGURATION_INVALID");
  const token = accessToken.trim();
  let lastStarted = 0;
  return async (page) => {
    if (!Number.isInteger(page) || page < 1 || page > WINDOW_MAX_PAGES) refused("WINDOW_PAGE_BOUND_EXCEEDED");
    const url = new URL("https://stmichael.amocrm.ru/api/v4/leads");
    url.searchParams.set("filter[created_at][from]", String(window.from));
    url.searchParams.set("filter[created_at][to]", String(window.to));
    url.searchParams.set("filter[pipeline_id][]", String(KC_PIPELINE_ID));
    url.searchParams.set("limit", String(WINDOW_PAGE_LIMIT));
    url.searchParams.set("page", String(page));
    url.searchParams.set("with", "contacts");
    // The separately serialized legacy requester is <=4 requests/sec. Keep
    // this parallel collection below 2.5/sec; never follow server next URLs.
    const wait = lastStarted + 400 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastStarted = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
      if (response?.status === 204) {
        try { await response.body?.cancel?.(); } catch { /* no provider output */ }
        return null;
      }
      if (response?.ok !== true) {
        controller.abort();
        try { await response?.body?.cancel?.(); } catch { /* no provider output */ }
        refused("WINDOW_REQUEST_REJECTED");
      }
      return await helpers.readBoundedJsonResponse(response, controller);
    } catch (error) {
      controller.abort();
      if (["WINDOW_REQUEST_REJECTED"].includes(error?.safeCode)) throw error;
      refused("WINDOW_REQUEST_FAILED");
    } finally { clearTimeout(timeout); }
  };
}
function serializeRequester(request) {
  let tail = Promise.resolve();
  return (...args) => {
    const current = tail.then(() => request(...args));
    tail = current.catch(() => {});
    return current;
  };
}
function normalizedName(value) {
  return typeof value === "string" ? value.normalize("NFC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
}
function textPhoneMatches(value, phone) {
  if (typeof value !== "string") return false;
  return (value.match(/(?<!\d)(?:\+?7|8)[\s()\-]*\d(?:[\s()\-]*\d){9}(?!\d)/g) || []).some((entry) => helpers.normalizePhone(entry) === phone);
}
function createReviewNotesRequester(accessToken, fetchImpl = globalThis.fetch) {
  if (typeof accessToken !== "string" || !accessToken.trim() || typeof fetchImpl !== "function") refused("REVIEW_REQUEST_CONFIGURATION_INVALID");
  return async () => {
    const url = new URL(`https://stmichael.amocrm.ru/api/v4/leads/${REVIEW_LEAD_ID}/notes?limit=100&page=1`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", Authorization: `Bearer ${accessToken.trim()}` } });
      if (response?.status === 204) return null;
      if (response?.ok !== true) refused("REVIEW_NOTES_REQUEST_REJECTED");
      return await helpers.readBoundedJsonResponse(response, controller);
    } catch (error) {
      controller.abort();
      if (error?.safeCode === "REVIEW_NOTES_REQUEST_REJECTED") throw error;
      refused("REVIEW_NOTES_REQUEST_FAILED");
    } finally { clearTimeout(timeout); }
  };
}
async function collectReviewLeadComparison(row, expanded, request, requestNotes) {
  if (!expanded.possibleCandidates.some((candidate) => candidate.leadId === REVIEW_LEAD_ID)) return { performed: false, reason: "fixed_review_lead_not_in_candidate_scope" };
  const effective = validateCase(row, true);
  const raw = await request(`/api/v4/leads/${REVIEW_LEAD_ID}`, { with: "contacts" });
  const reduced = validatedLead(raw, REVIEW_LEAD_ID, row, expanded.window, false);
  const prior = expanded.possibleCandidates.find((candidate) => candidate.leadId === REVIEW_LEAD_ID).privateLead;
  if (JSON.stringify(reduced) !== JSON.stringify(prior)) refused("EXPANDED_LEAD_CHANGED_DURING_SCAN");
  const phone = helpers.normalizePhone(row.phone), name = normalizedName(row.fullName), contacts = [];
  for (const id of reduced.contactIds) {
    if (id === positiveId(effective.broker.amoContactId)) continue;
    const contact = await request(`/api/v4/contacts/${id}`, { with: "leads" });
    if (!record(contact) || contact.id !== id || typeof contact.name !== "string" || Buffer.byteLength(contact.name, "utf8") > 4000) refused("REVIEW_CONTACT_INVALID");
    const flag = brokerFlagEvidence(contact);
    contacts.push({ brokerFlagEvidence: flag.coverage, isBroker: flag.value, exactClientPhoneMatches: helpers.contactHasExactPhone(contact, phone), normalizedClientNameMatches: normalizedName(contact.name) === name });
  }
  const payload = await requestNotes(), notes = payload === null ? [] : payload?._embedded?.notes;
  if (!Array.isArray(notes) || notes.length > 100 || (payload?._links !== undefined && !record(payload._links))) refused("REVIEW_NOTES_INVALID");
  const texts = notes.map((note) => {
    if (!record(note) || !positiveId(note.id) || note.entity_id !== REVIEW_LEAD_ID || !record(note.params)) refused("REVIEW_NOTES_INVALID");
    if (note.params.text === undefined) return "";
    if (typeof note.params.text !== "string" || Buffer.byteLength(note.params.text, "utf8") > 64000) refused("REVIEW_NOTES_INVALID");
    return note.params.text;
  });
  return {
    performed: true, leadId: REVIEW_LEAD_ID, leadUrl: `https://stmichael.amocrm.ru/leads/detail/${REVIEW_LEAD_ID}`,
    normalizedLeadNameMatchesClient: normalizedName(raw.name) === name,
    clientNameMentionedInLeadName: (` ${normalizedName(raw.name)} `).includes(` ${name} `), exactGeneratedName: reduced.exactGeneratedName,
    nonEffectiveBrokerContactsRead: contacts.length, contacts,
    notes: { read: notes.length, complete: payload === null || (!payload._links?.next && notes.length < 100), requestUuidMentioned: texts.some((text) => text.includes(CLIENT_ID)), exactClientPhoneMentioned: texts.some((text) => textPhoneMatches(text, phone)), clientNameMentioned: texts.some((text) => (` ${normalizedName(text)} `).includes(` ${name} `)) },
    advisoryOnly: true, identityConfirmed: false,
  };
}
async function readReviewHistoryJson(response, controller) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && /^[0-9]+$/.test(declared) && Number(declared) > REVIEW_HISTORY_MAX_BODY_BYTES) throw new Error("Review history response bound exceeded");
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("Review history stream unavailable");
  let bytes = 0;
  const limitedReader = {
    async read() {
      const item = await reader.read();
      if (!item?.done && item?.value instanceof Uint8Array) {
        bytes += item.value.byteLength;
        if (bytes > REVIEW_HISTORY_MAX_BODY_BYTES) { controller.abort(); throw new Error("Review history response bound exceeded"); }
      }
      return item;
    },
    cancel: () => reader.cancel(), releaseLock: () => reader.releaseLock(),
  };
  return helpers.readBoundedJsonResponse({ headers: response.headers, body: { getReader: () => limitedReader } }, controller);
}
function createReviewHistoryRequester(accessToken, fetchImpl = globalThis.fetch) {
  if (typeof accessToken !== "string" || !accessToken.trim() || typeof fetchImpl !== "function") refused("REVIEW_REQUEST_CONFIGURATION_INVALID");
  let lastStarted = 0;
  return async (kind, args) => {
    let url;
    if (kind === "events" && record(args) && Object.keys(args).sort().join() === "from,page,to" && unixTime(args.from) && unixTime(args.to) && args.to >= args.from && args.to - args.from <= WINDOW_MAX_AGE_SECONDS + 2 * WINDOW_SKEW_SECONDS && Number.isInteger(args.page) && args.page >= 1 && args.page <= REVIEW_EVENT_MAX_PAGES) {
      url = new URL("https://stmichael.amocrm.ru/api/v4/events");
      url.searchParams.set("filter[entity]", "lead");
      url.searchParams.set("filter[entity_id][]", String(REVIEW_LEAD_ID));
      url.searchParams.set("filter[created_at][from]", String(args.from));
      url.searchParams.set("filter[created_at][to]", String(args.to));
      url.searchParams.set("limit", String(REVIEW_EVENT_PAGE_LIMIT)); url.searchParams.set("page", String(args.page));
    } else if (kind === "historicalContact" && record(args) && Object.keys(args).sort().join() === "allowedIds,id" && positiveId(args.id) && Array.isArray(args.allowedIds) && args.allowedIds.length <= REVIEW_MAX_HISTORICAL_CONTACTS && args.allowedIds.includes(args.id) && args.allowedIds.every((id) => positiveId(id))) {
      url = new URL(`https://stmichael.amocrm.ru/api/v4/contacts/${args.id}?with=leads`);
    } else refused("REVIEW_HISTORY_SCOPE_INVALID");
    const wait = lastStarted + 400 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastStarted = Date.now();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", Authorization: `Bearer ${accessToken.trim()}` } });
      if (response?.status === 204) return { coverage: "observed", payload: null };
      if (response?.status === 404) return { coverage: "deleted_or_unavailable", payload: null };
      if (response?.status === 403) return { coverage: "forbidden", payload: null };
      if (response?.ok !== true) return { coverage: "unavailable", payload: null };
      return { coverage: "observed", payload: await readReviewHistoryJson(response, controller) };
    } catch { return { coverage: "request_failed", payload: null }; }
    finally { controller.abort(); clearTimeout(timeout); }
  };
}
function stableReviewEntity(raw) {
  return raw === null ? null : { id: raw.id, name: raw.name, created_at: raw.created_at, updated_at: raw.updated_at, pipeline_id: raw.pipeline_id, status_id: raw.status_id, custom_fields_values: raw.custom_fields_values, contacts: raw._embedded?.contacts, leads: raw._embedded?.leads };
}
async function collectReviewEvents(requestHistory, from, to) {
  const events = [], seen = new Set();
  let complete = false, pagesRead = 0, coverage = "observed";
  for (let page = 1; page <= REVIEW_EVENT_MAX_PAGES; page += 1) {
    const result = await requestHistory("events", { from, to, page }); pagesRead += 1;
    if (result.coverage !== "observed") { coverage = result.coverage; break; }
    if (result.payload === null) { complete = true; break; }
    const payload = result.payload, batch = payload?._embedded?.events;
    if (!record(payload) || !Array.isArray(batch) || batch.length > REVIEW_EVENT_PAGE_LIMIT || (payload._links !== undefined && !record(payload._links))) refused("REVIEW_EVENTS_INVALID");
    for (const raw of batch) {
      if (!record(raw) || typeof raw.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(raw.id) || seen.has(raw.id) || raw.entity_type !== "lead" || raw.entity_id !== REVIEW_LEAD_ID || raw.account_id !== 28552900 || typeof raw.type !== "string" || !/^[a-z0-9_]{1,100}$/.test(raw.type) || !unixTime(raw.created_at) || raw.created_at < from || raw.created_at > to || !Array.isArray(raw.value_before) || !Array.isArray(raw.value_after) || raw.value_before.length > 100 || raw.value_after.length > 100) refused("REVIEW_EVENTS_INVALID");
      seen.add(raw.id);
      events.push({ id: raw.id, entity_id: raw.entity_id, entity_type: raw.entity_type, account_id: raw.account_id, type: raw.type, created_at: raw.created_at, value_before: raw.value_before, value_after: raw.value_after });
    }
    const next = payload._links?.next;
    if (next !== undefined && next !== null && !record(next)) refused("REVIEW_EVENTS_INVALID");
    if (!next) { complete = batch.length < REVIEW_EVENT_PAGE_LIMIT; break; }
    if (batch.length === 0) refused("REVIEW_EVENTS_INVALID");
  }
  return { events, complete, pagesRead, coverage };
}
function stringsInEventValue(value, depth = 0) {
  if (depth > 8) refused("REVIEW_EVENTS_INVALID");
  if (typeof value === "string") { if (Buffer.byteLength(value, "utf8") > 64000) refused("REVIEW_EVENTS_INVALID"); return [value]; }
  if (Array.isArray(value)) return value.flatMap((entry) => stringsInEventValue(entry, depth + 1));
  if (record(value)) return Object.values(value).flatMap((entry) => stringsInEventValue(entry, depth + 1));
  return [];
}
function reviewContactEvidence(raw, row, leadName, id) {
  if (!record(raw) || raw.id !== id || typeof raw.name !== "string" || Buffer.byteLength(raw.name, "utf8") > 4000 || !Array.isArray(raw._embedded?.leads) || raw._embedded.leads.length > 250 || raw._embedded.leads.some((lead) => !positiveId(lead?.id))) refused("REVIEW_CONTACT_INVALID");
  if (raw.custom_fields_values !== null && raw.custom_fields_values !== undefined && (!Array.isArray(raw.custom_fields_values) || raw.custom_fields_values.length > 1000)) refused("REVIEW_CONTACT_INVALID");
  const fields = (raw.custom_fields_values || []).filter((field) => field?.field_id === 557903 || field?.field_code === "PHONE");
  const values = fields.flatMap((field) => Array.isArray(field.values) ? field.values : []);
  if (values.length > 100) refused("REVIEW_CONTACT_INVALID");
  const phones = values.map((entry) => helpers.normalizePhone(entry?.value)).filter(Boolean), phone = helpers.normalizePhone(row.phone);
  const flag = brokerFlagEvidence(raw);
  return {
    contactId: id, coverage: "observed",
    phoneCoverage: fields.length === 0 ? "missing" : phones.length === 0 ? "invalid_or_missing" : "valid",
    validPhoneCount: phones.length, exactClientPhoneMatches: phones.includes(phone),
    allObservedPhonesDifferentFromClient: phones.length > 0 && !phones.includes(phone),
    normalizedClientNameMatches: normalizedName(raw.name) === normalizedName(row.fullName),
    leadNameMatchesContactName: !!normalizedName(raw.name) && normalizedName(leadName) === normalizedName(raw.name),
    brokerFlagEvidence: flag.coverage, isBroker: flag.value,
    currentlyLinkedToReviewLead: raw._embedded.leads.some((lead) => lead.id === REVIEW_LEAD_ID),
    historicalPhoneValuesCoverage: "not_read", nonBrokerFlagConfirmed: flag.value === false,
    // A false/missing checkbox is not a verified client role.
    clientRoleConfirmed: false,
  };
}
function reviewSourceEvidence(rawLead, events, row) {
  const fields = rawLead.custom_fields_values || [];
  if (!Array.isArray(fields) || fields.length > 1000) refused("REVIEW_SOURCE_INVALID");
  const scalarValues = (value, depth = 0) => {
    if (depth > 8) refused("REVIEW_SOURCE_INVALID");
    if (Array.isArray(value)) return value.flatMap((entry) => scalarValues(entry, depth + 1));
    if (!record(value)) return [];
    const result = [];
    for (const [key, child] of Object.entries(value)) {
      if (key === "value" && (typeof child === "string" || typeof child === "number")) {
        if (typeof child === "number" && !Number.isSafeInteger(child)) continue;
        const text = String(child);
        if (Buffer.byteLength(text, "utf8") > 64000) refused("REVIEW_SOURCE_INVALID");
        result.push(text);
      } else if (record(child) || Array.isArray(child)) result.push(...scalarValues(child, depth + 1));
    }
    return result;
  };
  const current = (id) => scalarValues(fields.filter((field) => field?.field_id === id));
  const historical = (id) => events.filter((event) => event.type === `custom_field_${id}_value_changed`).flatMap((event) => [...event.value_before, ...event.value_after].flatMap((change) => {
    const field = change?.custom_field_value;
    if (!record(field)) return [];
    if (field.field_id !== undefined && field.field_id !== id) refused("REVIEW_SOURCE_INVALID");
    // Official Events API uses custom_field_value.text, unlike current
    // custom_fields_values[].values[].value. Never scan unrelated event text.
    if (typeof field.text === "string") {
      if (field.field_id !== id || Buffer.byteLength(field.text, "utf8") > 64000) refused("REVIEW_SOURCE_INVALID");
      return [field.text];
    }
    if (field.text !== undefined && field.text !== null) refused("REVIEW_SOURCE_INVALID");
    return scalarValues(field);
  }));
  const phoneEvidence = (values) => {
    const phones = values.map((value) => helpers.normalizePhone(value)).filter(Boolean);
    const clientPhone = helpers.normalizePhone(row.phone), brokerPhone = helpers.normalizePhone(effectiveBroker(row).broker.phone);
    return { validPhoneCount: phones.length, exactClientPhoneMatches: !!clientPhone && phones.includes(clientPhone), exactEffectiveBrokerPhoneMatches: !!brokerPhone && phones.includes(brokerPhone), allObservedPhonesDifferentFromClient: phones.length > 0 && !phones.includes(clientPhone) };
  };
  const parseTime = (value) => {
    // Ambiguous local date strings must never be silently assigned UTC.
    if (/^\d{10}$/.test(value) && unixTime(Number(value))) return new Date(Number(value) * 1000).toISOString();
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && unixTime(Math.floor(parsed / 1000)) ? new Date(parsed).toISOString() : null;
  };
  const sourceValues = [...current(618511), ...historical(618511)];
  const callIds = [...current(618577), ...historical(618577)];
  const requestTimes = [...current(618527), ...historical(618527)];
  const linkedEntities = [];
  for (const event of events.filter((item) => ["contact_linked", "contact_unlinked", "entity_linked", "entity_unlinked"].includes(item.type))) {
    for (const change of [...event.value_before, ...event.value_after]) {
      const entity = change?.link?.entity || change?.unlink?.entity;
      if (!entity) continue;
      if (!positiveId(entity.id)) refused("REVIEW_SOURCE_INVALID");
      linkedEntities.push({ eventType: event.type, at: new Date(event.created_at * 1000).toISOString(), entityId: entity.id, entityType: ["contact", "contacts", "company", "companies", "lead", "leads", "customer", "customers"].includes(entity.type) ? entity.type : "unknown" });
    }
  }
  const lastAttempt = row.amoSyncLastAttemptAt === null ? null : new Date(iso(row.amoSyncLastAttemptAt)).getTime();
  const leadCreated = rawLead.created_at * 1000;
  return {
    currentClientNumber: phoneEvidence(current(618517)), historicalClientNumber: phoneEvidence(historical(618517)),
    createdFromCalltouchObserved: sourceValues.some((value) => /(?:^|[^a-z])calltouch(?:$|[^a-z])/i.test(value)),
    createdFromCoverage: sourceValues.length > 0 ? "observed_unclassified_or_calltouch" : "missing",
    calltouchCallIdNonempty: callIds.some((value) => value.trim().length > 0),
    parsedRequestTimes: [...new Set(requestTimes.map(parseTime).filter(Boolean))], unparsedRequestTimeCount: requestTimes.filter((value) => parseTime(value) === null).length,
    linkedEntities,
    caseLastAttemptAt: lastAttempt === null ? null : new Date(lastAttempt).toISOString(),
    leadCreatedAt: new Date(leadCreated).toISOString(),
    leadCreatedSecondsAfterCaseLastAttempt: lastAttempt === null ? null : Math.floor((leadCreated - lastAttempt) / 1000),
    laterAutoRetryProven: false, identityConfirmed: false, absenceProof: false,
  };
}
async function collectReviewLeadHistory(row, expanded, request, requestHistory) {
  if (!expanded.possibleCandidates.some((candidate) => candidate.leadId === REVIEW_LEAD_ID)) return { performed: false, reason: "fixed_review_lead_not_in_candidate_scope" };
  const rawLead = await request(`/api/v4/leads/${REVIEW_LEAD_ID}`, { with: "contacts" });
  const lead = validatedLead(rawLead, REVIEW_LEAD_ID, row, expanded.window, false);
  const prior = expanded.possibleCandidates.find((candidate) => candidate.leadId === REVIEW_LEAD_ID).privateLead;
  if (JSON.stringify(lead) !== JSON.stringify(prior)) refused("EXPANDED_LEAD_CHANGED_DURING_SCAN");
  const from = rawLead.created_at, to = expanded.window.to;
  const first = await collectReviewEvents(requestHistory, from, to);
  const brokerId = positiveId(validateCase(row, true).broker.amoContactId), ids = new Set();
  for (const event of first.events) {
    if (!["contact_linked", "contact_unlinked", "entity_linked", "entity_unlinked"].includes(event.type)) continue;
    for (const change of [...event.value_before, ...event.value_after]) {
      const entity = change?.link?.entity || change?.unlink?.entity;
      if (["contact", "contacts"].includes(entity?.type)) { if (!positiveId(entity.id)) refused("REVIEW_EVENTS_INVALID"); if (entity.id !== brokerId) ids.add(entity.id); }
    }
  }
  if (ids.size > REVIEW_MAX_HISTORICAL_CONTACTS) refused("REVIEW_CONTACT_SCOPE_EXCEEDED");
  const allowedIds = [...ids].sort((a, b) => a - b), contacts = [], contactFingerprints = new Map();
  for (const id of allowedIds) {
    const result = await requestHistory("historicalContact", { id, allowedIds });
    contacts.push(result.coverage === "observed" && result.payload !== null ? reviewContactEvidence(result.payload, row, rawLead.name, id) : { contactId: id, coverage: result.payload === null && result.coverage === "observed" ? "deleted_or_unavailable" : result.coverage, clientRoleConfirmed: false });
    contactFingerprints.set(id, privateFingerprint({ coverage: result.coverage, entity: stableReviewEntity(result.payload) }));
  }
  const second = await collectReviewEvents(requestHistory, from, to);
  const after = await request(`/api/v4/leads/${REVIEW_LEAD_ID}`, { with: "contacts" });
  validatedLead(after, REVIEW_LEAD_ID, row, expanded.window, false);
  let contactsStable = true;
  for (const id of allowedIds) {
    const readback = await requestHistory("historicalContact", { id, allowedIds });
    if (readback.coverage === "observed" && readback.payload !== null) reviewContactEvidence(readback.payload, row, after.name, id);
    if (contactFingerprints.get(id) !== privateFingerprint({ coverage: readback.coverage, entity: stableReviewEntity(readback.payload) })) contactsStable = false;
  }
  const order = (events) => [...events].sort((a, b) => a.id.localeCompare(b.id));
  const stableReadback = contactsStable && privateFingerprint(stableReviewEntity(rawLead)) === privateFingerprint(stableReviewEntity(after)) && privateFingerprint(order(first.events)) === privateFingerprint(order(second.events)) && first.coverage === second.coverage && first.complete === second.complete;
  const texts = first.events.flatMap((event) => stringsInEventValue([event.value_before, event.value_after]));
  const nameValues = first.events.filter((event) => event.type === "name_field_changed").flatMap((event) => stringsInEventValue([event.value_before, event.value_after]));
  const missingHistoricalEntities = contacts.some((contact) => contact.coverage !== "observed");
  const noteDeleted = first.events.some((event) => event.type === "common_note_deleted");
  return {
    performed: true, leadId: REVIEW_LEAD_ID,
    pagesRead: first.pagesRead, eventsRead: first.events.length, secondPagesRead: second.pagesRead,
    coverage: first.coverage, eventWindowComplete: first.complete && second.complete, stableReadback,
    leadCreatedEventObserved: first.events.some((event) => event.type === "lead_added"),
    scope: "lead_events_and_current_historical_contacts_only",
    // Event pagination completeness cannot prove deleted data or prior contact
    // phone values are available. Never publish global identity/absence proof.
    historyComplete: false,
    historicalContacts: contacts, historicalContactsRead: contacts.length,
    contactLinkEvents: first.events.filter((event) => event.type === "contact_linked").length,
    contactUnlinkEvents: first.events.filter((event) => event.type === "contact_unlinked").length,
    deletedNoteObserved: noteDeleted, missingHistoricalEntityObserved: missingHistoricalEntities,
    historicalClientNameMentioned: nameValues.some((text) => (` ${normalizedName(text)} `).includes(` ${normalizedName(row.fullName)} `)),
    requestUuidMentionedInEvents: texts.some((text) => text.includes(CLIENT_ID)),
    exactClientPhoneMentionedInEvents: texts.some((text) => textPhoneMatches(text, helpers.normalizePhone(row.phone))),
    eventSummary: first.events.map((event) => ({ type: event.type, at: new Date(event.created_at * 1000).toISOString() })),
    sourceComparison: reviewSourceEvidence(rawLead, first.events, row),
    advisoryOnly: true, identityConfirmed: false, historicalPhoneChangesInspected: false, absenceProof: false,
  };
}
function validatedLead(raw, expectedId, row, window, requireWindow) {
  if (!record(raw) || positiveId(raw.id) !== expectedId || !positiveId(raw.pipeline_id) || !positiveId(raw.status_id) || !unixTime(raw.created_at) || typeof raw.name !== "string" || Buffer.byteLength(raw.name, "utf8") > 4000) refused("EXPANDED_LEAD_INVALID");
  if (requireWindow && (raw.pipeline_id !== KC_PIPELINE_ID || raw.created_at < window.from || raw.created_at > window.to)) refused("WINDOW_LEAD_OUT_OF_SCOPE");
  const ids = raw._embedded?.contacts;
  if (!Array.isArray(ids) || ids.length > 50) refused("EXPANDED_LEAD_INVALID");
  const seen = new Set();
  for (const contact of ids) {
    const id = positiveId(contact?.id);
    if (!id || seen.has(id)) refused("EXPANDED_LEAD_INVALID");
    seen.add(id);
  }
  const reduced = helpers.reduceLeadEvidence(raw, expectedId);
  return { ...reduced, exactGeneratedName: raw.name === expectedGeneratedName(row) };
}
async function collectWindowLeads(row, window, requestWindow) {
  validateEvidenceWindow(window);
  expectedGeneratedName(row);
  const leads = [], seen = new Set();
  let pagesRead = 0, complete = false;
  for (let page = 1; page <= WINDOW_MAX_PAGES; page += 1) {
    const payload = await requestWindow(page);
    pagesRead += 1;
    if (payload === null) { complete = true; break; }
    const batch = payload?._embedded?.leads;
    if (!record(payload) || !Array.isArray(batch) || batch.length > WINDOW_PAGE_LIMIT) refused("WINDOW_PAGE_INVALID");
    for (const raw of batch) {
      const id = positiveId(raw?.id);
      if (!id || seen.has(id)) refused("WINDOW_LEAD_DUPLICATED");
      seen.add(id);
      leads.push(validatedLead(raw, id, row, window, true));
    }
    const links = payload._links;
    if (links !== undefined && links !== null && !record(links)) refused("WINDOW_PAGE_INVALID");
    const next = links?.next;
    if (next !== undefined && next !== null && !record(next)) refused("WINDOW_PAGE_INVALID");
    if (next === undefined || next === null) {
      // A full page without a next marker cannot establish a complete scan.
      if (batch.length === WINDOW_PAGE_LIMIT) refused("WINDOW_PAGINATION_INCOMPLETE");
      complete = true; break;
    }
    if (batch.length === 0) refused("WINDOW_PAGINATION_INCOMPLETE");
  }
  if (!complete) refused("WINDOW_PAGE_BOUND_EXCEEDED");
  return { leads, pagesRead };
}
async function collectBrokerLeads(row, brokerContact, request, window) {
  if (!brokerContact) refused("BROKER_LINK_SCAN_UNAVAILABLE");
  const refs = brokerContact._embedded?.leads;
  if (!Array.isArray(refs) || refs.length > BROKER_MAX_LINKED_LEADS) refused("BROKER_LINK_SCAN_INVALID");
  const ids = [], seen = new Set();
  for (const ref of refs) {
    const id = positiveId(ref?.id);
    if (!id || seen.has(id)) refused("BROKER_LINK_SCAN_INVALID");
    seen.add(id); ids.push(id);
  }
  const leads = [];
  for (const id of ids.sort((a, b) => a - b)) {
    const raw = await request(`/api/v4/leads/${id}`, { with: "contacts" });
    leads.push(validatedLead(raw, id, row, window, false));
  }
  return leads;
}
async function collectExpandedEvidence({ row, brokerContact, contactEvidence, request, requestWindow, scanNow }) {
  const effective = validateCase(row, true);
  if (!canInspectEffectiveBroker(row, effective)) refused("EXPECTED_BROKER_NOT_CANONICAL");
  if (!positiveId(effective.broker.amoContactId) || !brokerContact || positiveId(brokerContact.id) !== positiveId(effective.broker.amoContactId)) refused("BROKER_CONTACT_ID_MISMATCH");
  const window = makeEvidenceWindow(row, scanNow);
  const existingPromise = typeof contactEvidence === "function" ? contactEvidence() : contactEvidence;
  const [windowResult, brokerLinkedLeads, existing] = await Promise.all([
    collectWindowLeads(row, window, requestWindow),
    collectBrokerLeads(row, brokerContact, request, window),
    existingPromise,
  ]);
  const exactIds = existing?.byPhone?.get(helpers.normalizePhone(row.phone))?.exactContactIds;
  if (!Array.isArray(exactIds) || exactIds.some((id) => !positiveId(id)) || new Set(exactIds).size !== exactIds.length) refused("EXPANDED_CONTACT_EVIDENCE_INVALID");
  const brokerId = positiveId(effective.broker.amoContactId);
  const candidates = new Map();
  for (const [scope, leads] of [["kc_creation_window", windowResult.leads], ["stored_broker_link", brokerLinkedLeads]]) {
    for (const lead of leads) {
      const brokerLinked = brokerId !== null && lead.contactIds.includes(brokerId);
      const clientLinked = lead.contactIds.some((id) => exactIds.includes(id));
      const inWindow = lead.createdAt >= window.from && lead.createdAt <= window.to;
      if (!lead.exactGeneratedName && !clientLinked && !(brokerLinked && inWindow && lead.pipelineId === KC_PIPELINE_ID)) continue;
      const current = candidates.get(lead.leadId);
      if (current && JSON.stringify(current.privateLead) !== JSON.stringify(lead)) refused("EXPANDED_LEAD_CHANGED_DURING_SCAN");
      const entry = current || { privateLead: lead, leadId: lead.leadId, pipelineId: lead.pipelineId, statusId: lead.statusId, exactGeneratedName: lead.exactGeneratedName, effectiveBrokerLinked: brokerLinked, exactClientContactLinked: clientLinked, strictBrokerSourceMarker: lead.sourceMarker, projectEvidence: safeProjectEvidence(lead.projectValues, row.project), leadCreatedAt: safeTimestamp(lead.createdAt, row.createdAt), scopes: [] };
      entry.scopes.push(scope); candidates.set(lead.leadId, entry);
    }
  }
  return { complete: true, capturedAt: iso(scanNow), window, contactEvidence: existing, brokerLinkedLeads, kcWindowLeads: windowResult.leads, windowPagesRead: windowResult.pagesRead, possibleCandidates: [...candidates.values()].sort((a, b) => a.leadId - b.leadId), databaseFingerprint: privateFingerprint(row) };
}
function safeProjectEvidence(values, project) {
  if (!Array.isArray(values) || values.length === 0) return "missing";
  if (values.length !== 1 || typeof values[0] !== "string") return "ambiguous";
  const expected = project === "ZORGE9" ? "Зорге 9" : "Квартал Серебряный Бор";
  return values[0] === expected ? "matches" : "different_or_unknown";
}
function assertCompleteNegativeEvidence(expanded, row) {
  validateCase(row, true);
  if (!expanded || expanded.complete !== true || expanded.databaseFingerprint !== privateFingerprint(row) || !Array.isArray(expanded.brokerLinkedLeads) || expanded.brokerLinkedLeads.length > BROKER_MAX_LINKED_LEADS || !Array.isArray(expanded.kcWindowLeads) || expanded.kcWindowLeads.length > WINDOW_PAGE_LIMIT * WINDOW_MAX_PAGES || !Number.isInteger(expanded.windowPagesRead) || expanded.windowPagesRead < 1 || expanded.windowPagesRead > WINDOW_MAX_PAGES) refused("EXPANDED_EVIDENCE_INCOMPLETE");
  const expected = makeEvidenceWindow(row, new Date(expanded.capturedAt));
  if (helpers.optionalStoredAmoLeadId(row.amoLeadId) !== null || JSON.stringify(expanded.window) !== JSON.stringify(expected) || !Array.isArray(expanded.possibleCandidates) || expanded.possibleCandidates.length !== 0) refused("EXPANDED_POSSIBLE_LEAD_PRESENT");
  const contacts = expanded.contactEvidence?.byPhone?.get(helpers.normalizePhone(row.phone));
  if (!contacts || !Array.isArray(contacts.exactContactIds) || !Array.isArray(contacts.leads) || contacts.leads.length !== 0) refused("EXPANDED_POSSIBLE_LEAD_PRESENT");
  return true; // Proof about these bounded GET scopes, never write authority.
}
function runtimeMetadata(environment) {
  const metadata = {
    inspectorSha256: environment.FIXED_CASE_INSPECTOR_SHA256,
    dependencySha256: environment.FIXED_CASE_DEPENDENCY_SHA256,
    deployedGitSha: environment.FIXED_CASE_DEPLOYED_GIT_SHA,
  };
  if (!/^[0-9a-f]{64}$/.test(metadata.inspectorSha256 || "") || !/^[0-9a-f]{64}$/.test(metadata.dependencySha256 || "") || !/^[0-9a-f]{40}$/.test(metadata.deployedGitSha || "")) refused("SOURCE_ATTESTATION_INVALID");
  if (!/^[0-9]+$/.test(environment.PRODUCTION_PG_SYSTEM_IDENTIFIER || "") || !/^[1-9][0-9]*$/.test(environment.PRODUCTION_MIN_BROKER_ROWS || "")) refused("DATABASE_ATTESTATION_INVALID");
  const floor = Number(environment.PRODUCTION_MIN_BROKER_ROWS);
  if (!Number.isSafeInteger(floor) || floor <= 0) refused("DATABASE_ATTESTATION_INVALID");
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") refused("UNSAFE_TLS_CONFIGURATION");
  return metadata;
}
const AUDIT_FROM = "2026-10-08T14:16:00.000Z";
const AUDIT_TO = "2026-10-09T08:00:00.000Z";
function auditQuery() {
  return { where: { entity: "Client", entityId: CLIENT_ID, createdAt: { gte: new Date(AUDIT_FROM), lte: new Date(AUDIT_TO) } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 101, select: { id: true, entity: true, entityId: true, action: true, createdAt: true, payload: true } };
}
function validateAuditRows(rows) {
  if (!Array.isArray(rows) || rows.length > 100) refused("CASE_AUDIT_SCOPE_EXCEEDED");
  const ids = new Set();
  for (const row of rows) {
    if (!record(row) || typeof row.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(row.id) || ids.has(row.id) || row.entity !== "Client" || row.entityId !== CLIENT_ID || typeof row.action !== "string" || Buffer.byteLength(row.action) > 200 || iso(row.createdAt) < AUDIT_FROM || iso(row.createdAt) > AUDIT_TO || Buffer.byteLength(JSON.stringify(row.payload ?? null), "utf8") > 64000) refused("CASE_AUDIT_INVALID");
    ids.add(row.id);
  }
  return rows;
}
function auditReport(rows, row, stableReadback) {
  validateAuditRows(rows);
  return { from: AUDIT_FROM, to: AUDIT_TO, recordsRead: rows.length, boundedWindowComplete: true, stableReadback, absenceProof: false,
    events: rows.map((entry) => {
      const payload = record(entry.payload) ? entry.payload : {};
      const error = typeof payload.error === "string" ? payload.error : "";
      const code = error.match(/(?:HTTP(?:\s+(?:status|error))?|status(?:Code)?|code)[\s:=]+([45]\d{2})(?!\d)/i);
      return { at: iso(entry.createdAt), action: ["AMO_SYNC_FAILED", "CLIENT_FIXATION", "CLIENT_FIXATION_CONFLICT", "CLIENT_FIXATION_DUPLICATE_LEAD"].includes(entry.action) ? entry.action : "other",
        step: ["createFixationRequest", "refixation", "retryAmoSync", "retry", "sync"].includes(payload.step) ? payload.step : "unknown_or_missing",
        scenario: ["NEW_CLIENT", "REFIX_AFTER_CLOSED", "REFIX_AMO_DOWN"].includes(payload.scenario) ? payload.scenario : "unknown_or_missing",
        clientPhoneMatches: !!helpers.normalizePhone(payload.phone) && helpers.normalizePhone(payload.phone) === helpers.normalizePhone(row.phone),
        errorPresent: !!error, errorClass: error ? helpers.classifySyncError(error) : "none",
        httpStatus: code ? Number(code[1]) : null,
        requestUuidMentioned: error.includes(CLIENT_ID), reviewLeadIdMentioned: /(?:^|\D)32372907(?:$|\D)/.test(error),
        timeoutMentioned: /timeout|timed out|ETIMEDOUT|AbortError/i.test(error), connectionResetMentioned: /ECONNRESET|socket hang up/i.test(error),
      };
    }),
  };
}
// Two reviewed attempts of this one case only. No caller-configurable scope.
const RECOVERY_AUDIT_FROM = "2026-10-11T00:00:00.000Z";
const RECOVERY_AUDIT_TO = "2026-10-12T23:59:59.999Z";
const RECOVERY_PHASES = Object.freeze(["CLAIMED", "CONTACT_ARMED", "CONTACT_RESOLVED", "LEAD_ARMED", "LEAD_RESOLVED", "LINKED", "UNRESOLVED"]);
const RECOVERY_REASONS = Object.freeze(["CONTACT_UNCONFIRMED", "LEAD_UNCONFIRMED", "CASE_DRIFT", "LEASE_LOST", "UNEXPECTED_FAILURE"]);
const RECOVERY_PLAN = Object.freeze({ runId: "38150838032", planRunId: "38150597583",
  caseHash: "84252dd3069705e3f29d703f4e60b50e89db7e66b45b126cce94f88e63e03a1f",
  candidateHash: "65e35f7515359f37364c8e24a04074562e8dc2570ff30c63eb89da7f8797c67f" });
function recoveryAuditQuery() {
  return { where: { entity: "AmoFixedCaseRecovery", entityId: CLIENT_ID,
    createdAt: { gte: new Date(RECOVERY_AUDIT_FROM), lte: new Date(RECOVERY_AUDIT_TO) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 17,
    select: { id: true, entity: true, entityId: true, action: true, createdAt: true, payload: true } };
}
function validateRecoveryAuditRows(rows) {
  if (!Array.isArray(rows) || rows.length > 16) refused("RECOVERY_AUDIT_SCOPE_EXCEEDED");
  const ids = new Set();
  for (const row of rows) {
    if (!record(row) || typeof row.id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(row.id) || ids.has(row.id) ||
      row.entity !== "AmoFixedCaseRecovery" || row.entityId !== CLIENT_ID ||
      !RECOVERY_PHASES.some((phase) => row.action === `AMO_FIXED_CASE_${phase}`) ||
      iso(row.createdAt) < RECOVERY_AUDIT_FROM || iso(row.createdAt) > RECOVERY_AUDIT_TO ||
      !record(row.payload) || Buffer.byteLength(JSON.stringify(row.payload), "utf8") > 64000)
      refused("RECOVERY_AUDIT_INVALID");
    ids.add(row.id);
  }
  return rows;
}
function recoveryAuditReport(rows, stableReadback) {
  validateRecoveryAuditRows(rows);
  return { from: RECOVERY_AUDIT_FROM, to: RECOVERY_AUDIT_TO,
    recordsRead: rows.length, boundedWindowComplete: true, stableReadback, absenceProof: false,
    events: rows.map((row) => {
      const payload = row.payload;
      const counters = {};
      for (const key of ["contactPosts", "leadPosts", "patchPosts", "notePosts"]) {
        if (Number.isSafeInteger(payload[key]) && payload[key] >= 0 && payload[key] <= 1) counters[key] = payload[key];
      }
      return { phase: row.action.slice("AMO_FIXED_CASE_".length),
        phasePayloadMatches: payload.phase === row.action.slice("AMO_FIXED_CASE_".length),
        reason: RECOVERY_REASONS.includes(payload.reason) ? payload.reason : "unknown_or_missing",
        operationKeyMatches: payload.operationKey === `fixed-amo-fixation-case:v1:${CLIENT_ID}`,
        applyRunMatches: payload.runId === RECOVERY_PLAN.runId,
        latestApplyRunMatches: payload.runId === "38240019073",
        latestPlanRunMatches: payload.planRunId === "38238691800",
        planRunMatches: payload.planRunId === RECOVERY_PLAN.planRunId,
        caseHashMatchesPlan: payload.caseHash === RECOVERY_PLAN.caseHash,
        candidateHashMatchesPlan: payload.candidateHash === RECOVERY_PLAN.candidateHash,
        sourceMetadataWellFormed: typeof payload.deployedGitSha === "string" && /^[0-9a-f]{40}$/.test(payload.deployedGitSha) && typeof payload.sourceSha256 === "string" && /^[0-9a-f]{64}$/.test(payload.sourceSha256),
        automaticRetryBlocked: payload.automaticRetryBlocked === true, ...counters };
    }) };
}
// Literal latest armed recovery only. Diagnostic booleans are not a linking
// certificate and cannot authorize another provider write or release a lease.
const ARMED_RECOVERY_LEAD_ID = 32377125;
const ARMED_RECOVERY_METADATA = Object.freeze({
  runId: "38252692034", planRunId: "38252028798",
  caseHash: "ac50b11e3b127b97962b7bd8eddb919fe05fdc885eab6b3568919c8a5fd1f82c",
  candidateHash: "ba653455a3ef3f00d3307cb9e081b5f9ac0c02b486aa85743949011f0fb4be72",
  sourceSha256: "33231586afb08d248a1bcf7478264d44c307d4b0dcf62b7338b75e123b0a4c3c",
  deployedGitSha: "50c88ff5cef87894394c2d563904e2befafd781a",
});
const ARMED_NOTE_SELECT = {
  ...CLIENT_SELECT, email: true, comment: true, clientRegion: true,
  broker: { select: { ...BROKER_SELECT, fullName: true } },
  responsibleBroker: { select: { ...BROKER_SELECT, fullName: true } },
};
function armedRecoveryAuditBound(auditRows) {
  const phases = ["CLAIMED", "CONTACT_ARMED", "CONTACT_RESOLVED", "LEAD_ARMED", "UNRESOLVED"];
  return auditRows.length === phases.length && auditRows.every((entry, index) =>
    entry.action === `AMO_FIXED_CASE_${phases[index]}` && entry.payload.phase === phases[index] &&
    entry.payload.operationKey === `fixed-amo-fixation-case:v1:${CLIENT_ID}` &&
    Object.entries(ARMED_RECOVERY_METADATA).every(([key, value]) => entry.payload[key] === value));
}
// Literal expected note from the byte-bound writer. Private strings and the
// agency fingerprint remain in memory, never in the public diagnostic.
function armedRecoveryExpectedNote(row, agency) {
  const broker = effectiveBroker(row).broker;
  if (!agency || agency.id !== row.fixationAgencyId || typeof agency.name !== "string" || !agency.name.trim() ||
    !/^(?:[0-9]{10}|[0-9]{12})$/.test(agency.inn || "")) refused("REVIEW_SOURCE_INVALID");
  const tag = privateFingerprint({ id: agency.id, name: agency.name, inn: agency.inn, updatedAt: iso(agency.updatedAt) });
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
  lines.push(`Агентство: ${agency.name} (ИНН ${agency.inn})`);
  if (row.comment) lines.push("", `Комментарий брокера: ${row.comment}`);
  return `${lines.join("\n")}\n\nCabinet case UUID: ${CLIENT_ID}\nRecovery UUID: 7a8d216e-1637-43eb-985b-19b75fd2b9ed\nRecovery source: st-michael-fixed-amo-case-recovery-v1\nRecovery agency tag: ${tag}`;
}
// These are literal fields sent by the byte-bound reviewed writer, not a
// relaxed replacement validator. Values stay in memory; only field IDs leave.
function armedRecoveryFormDiagnostic(raw, row) {
  const expected = new Map([[583155, { value: "Себе" }],
    [839179, { value: row.project === "ZORGE9" ? "Зорге 9" : "Берзарина 37" }],
    [665195, { enum_id: 985337 }], [842273, { enum_id: 1028041 }]]);
  const property = { "квартира": 1025397, "апартаменты": 859233, "апартамент": 859233,
    "коммерческая": 889061, "коммерческое помещение": 889061, "кладовая": 981093,
    "паркинг": 859235, "машиноместо": 859235 }[String(row.propertyType || "").toLowerCase().trim()];
  const rooms = { "1": 852923, "1к": 852923, "однушка": 852923, "2": 852925, "2к": 852925,
    "двушка": 852925, "3": 852927, "3к": 852927, "трёшка": 852927, "трешка": 852927,
    "студия": 889059 }[String(row.roomsCount || "").toLowerCase().trim()];
  if (property) expected.set(587387, { enum_id: property });
  if (rooms) expected.set(583447, { enum_id: rooms });
  if (Number(row.amount) > 0) expected.set(833045, { value: String(Number(row.amount)) });
  if (Number(row.sqm) > 0) expected.set(604555, { value: String(Number(row.sqm)) });
  const readiness = String(row.readinessLevel || "").toLowerCase().replace(/[^а-яё]/g, "");
  if (readiness.includes("горяч")) expected.set(839449, { enum_id: 1025401 });
  else if (readiness.includes("тёпл") || readiness.includes("тепл")) expected.set(839449, { enum_id: 1025403 });
  else if (readiness.includes("холод")) expected.set(839449, { enum_id: 1025405 });
  const timing = String(row.purchaseTiming || "").toLowerCase();
  if (timing.includes("1") && timing.includes("3")) expected.set(612517, { enum_id: 890509 });
  else if (timing.includes("3") && timing.includes("6")) expected.set(612517, { enum_id: 890511 });
  else if (timing.includes("6") || timing.includes("12") || timing.includes("более")) expected.set(612517, { enum_id: 890513 });
  else if (timing.includes("выясн") || timing.includes("не указ")) expected.set(612517, { enum_id: 891589 });
  const fields = raw.custom_fields_values;
  if (!Array.isArray(fields) || fields.length > 1000) refused("EXPANDED_LEAD_INVALID");
  const mismatchedFieldIds = [];
  for (const [id, value] of expected) {
    const matches = fields.filter((field) => field?.field_id === id);
    if (matches.length !== 1 || !Array.isArray(matches[0].values) || matches[0].values.length !== 1 ||
      (value.value !== undefined && String(matches[0].values[0]?.value) !== value.value) ||
      (value.enum_id !== undefined && Number(matches[0].values[0]?.enum_id) !== value.enum_id)) mismatchedFieldIds.push(id);
  }
  return { expectedFieldCount: expected.size, mismatchedFieldIds,
    priceMatches: !(Number(row.amount) > 0) || Number(raw.price) === Number(row.amount) };
}
function createArmedRecoveryExtraRequester(token, fetchImpl = globalThis.fetch) {
  if (typeof token !== "string" || !token.trim() || typeof fetchImpl !== "function") refused("REVIEW_REQUEST_CONFIGURATION_INVALID");
  return async (kind) => {
    const path = kind === "notes" ? `/api/v4/leads/${ARMED_RECOVERY_LEAD_ID}/notes?limit=100&page=1`
      : kind === "dateField" ? "/api/v4/leads/custom_fields/833189" : null;
    if (!path) refused("REVIEW_HISTORY_SCOPE_INVALID");
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchImpl(new URL(`https://stmichael.amocrm.ru${path}`), {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json", Authorization: `Bearer ${token.trim()}` } });
      if (response?.status === 204 && kind === "notes") return null;
      if (response?.ok !== true) refused("REVIEW_NOTES_REQUEST_REJECTED");
      return await helpers.readBoundedJsonResponse(response, controller);
    } catch (error) {
      if (error?.safeCode === "REVIEW_NOTES_REQUEST_REJECTED") throw error;
      refused("REVIEW_NOTES_REQUEST_FAILED");
    } finally { controller.abort(); clearTimeout(timeout); }
  };
}
function armedRecoveryExtraDiagnostic(row, payload, field, noteBaseline = null) {
  if (!record(field) || field.id !== 833189 || field.entity_type !== "leads" || typeof field.type !== "string") refused("REVIEW_SOURCE_INVALID");
  const notes = payload === null ? [] : payload?._embedded?.notes;
  if (!Array.isArray(notes) || notes.length >= 100 || payload?._links?.next) refused("REVIEW_NOTES_INVALID");
  const matches = notes.filter((note) => {
    if (!record(note) || !positiveId(note.id) || note.entity_id !== ARMED_RECOVERY_LEAD_ID || !record(note.params)) refused("REVIEW_NOTES_INVALID");
    if (note.params.text === undefined) return false;
    if (typeof note.params.text !== "string" || Buffer.byteLength(note.params.text, "utf8") > 120000) refused("REVIEW_NOTES_INVALID");
    return note.note_type === "common" && note.params.text.includes(`Cabinet case UUID: ${CLIENT_ID}`) &&
      note.params.text.includes("Recovery UUID: 7a8d216e-1637-43eb-985b-19b75fd2b9ed") &&
      note.params.text.includes("Recovery source: st-michael-fixed-amo-case-recovery-v1") &&
      textPhoneMatches(note.params.text, helpers.normalizePhone(row.phone)) &&
      note.params.text.includes(`Клиент: ${row.fullName}`);
  });
  const expectedNote = noteBaseline ? armedRecoveryExpectedNote(noteBaseline.row, noteBaseline.agency) : null;
  const exact = expectedNote === null ? [] : notes.filter((note) => note.note_type === "common" && note.params.text === expectedNote);
  return { dateFieldType: ["date", "date_time"].includes(field.type) ? field.type : "other",
    recoveryNoteCount: matches.length, recoveryNoteMarkersPhoneNameMatch: matches.length === 1,
    fullNoteExactMatchInspected: expectedNote !== null,
    fullNoteExactMatch: expectedNote !== null && exact.length === 1 && matches.length === 1,
    exactNoteCount: exact.length };
}
function armedRecoveryLeadDiagnostic(row, auditRows, raw, exactIds, scanNow) {
  validateRecoveryAuditRows(auditRows);
  const bound = armedRecoveryAuditBound(auditRows);
  if (!bound) return { performed: false, reason: "literal_armed_recovery_binding_not_confirmed", retryAuthorized: false };
  const contactId = positiveId(auditRows[2].payload.contactId);
  const armed = Date.parse(auditRows[3].payload.armedAt), now = Date.parse(iso(scanNow));
  if (!contactId || !Number.isFinite(armed) || armed > now || now - armed > WINDOW_MAX_AGE_SECONDS * 1000)
    return { performed: false, reason: "armed_recovery_details_invalid", retryAuthorized: false };
  const lead = validatedLead(raw, ARMED_RECOVERY_LEAD_ID, row, makeEvidenceWindow(row, scanNow), false);
  const expectedContacts = [contactId, positiveId(effectiveBroker(row).broker.amoContactId)].sort((a, b) => a - b);
  const inRange = (value) => Number.isSafeInteger(value) && value >= Math.floor(armed / 1000) - 120 && value <= Math.floor(now / 1000) + 120;
  const request = lead.requestValues;
  const fields = raw.custom_fields_values;
  if (!Array.isArray(fields) || fields.length > 1000) refused("EXPANDED_LEAD_INVALID");
  const requestFields = fields.filter((field) => field?.field_id === 833189);
  const singleRequest = requestFields.length === 1 && Array.isArray(requestFields[0].values) && requestFields[0].values.length === 1;
  return { performed: true, leadId: ARMED_RECOVERY_LEAD_ID, auditBindingConfirmed: true,
    unresolvedReasonMatches: auditRows[4].payload.reason === "LEAD_UNCONFIRMED",
    exactContactLookupMatchesAudit: Array.isArray(exactIds) && JSON.stringify(exactIds) === JSON.stringify([contactId]),
    exactGeneratedNameMatches: lead.exactGeneratedName,
    exactLeadContactsMatch: JSON.stringify([...lead.contactIds].sort((a, b) => a - b)) === JSON.stringify(expectedContacts),
    pipelineMatches: lead.pipelineId === 7600542, statusMatches: lead.statusId === 62907118,
    strictSourceMarkerMatches: lead.sourceMarker === true,
    exactProjectMatches: JSON.stringify(lead.projectValues) === JSON.stringify([row.project === "ZORGE9" ? "Зорге 9" : "Берзарина 37"]),
    createdWithinArmedWindow: inRange(lead.createdAt), requestValueCount: request.length,
    requestValueIsInteger: request.length === 1 && Number.isSafeInteger(request[0]),
    requestValueIsString: request.length === 1 && typeof request[0] === "string",
    requestWithinArmedWindowStrict: request.length === 1 && inRange(request[0]),
    requestWithinArmedWindowNumeric: request.length === 1 && inRange(Number(request[0])),
    requestFieldCardinalityMatches: singleRequest,
    requestFieldNumericWindowMatches: singleRequest && inRange(Number(requestFields[0].values[0]?.value)),
    requestSecondsFromArmed: request.length === 1 && unixTime(request[0]) ? request[0] - Math.floor(armed / 1000) : null,
    requestUtcMidnight: request.length === 1 && unixTime(request[0]) ? request[0] % 86400 === 0 : false,
    requestMoscowMidnight: request.length === 1 && unixTime(request[0]) ? (request[0] + 10800) % 86400 === 0 : false,
    requestUtcDayMatchesArmed: request.length === 1 && unixTime(request[0]) ? Math.floor(request[0] / 86400) === Math.floor(armed / 86400000) : false,
    requestMoscowDayMatchesArmed: request.length === 1 && unixTime(request[0]) ? Math.floor((request[0] + 10800) / 86400) === Math.floor((armed + 10800000) / 86400000) : false,
    formFields: armedRecoveryFormDiagnostic(raw, row),
    identityConfirmed: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false };
}
async function snapshot(prisma, environment, includeToken, includeAudit = false) {
  return prisma.$transaction(async (tx) => {
    await helpers.assertReadOnlySession(tx);
    const identities = await tx.$queryRaw`SELECT current_setting('transaction_read_only') AS read_only, current_database() AS database_name, system_identifier::text AS system_identifier, (SELECT count(*)::text FROM public.brokers) AS broker_rows FROM pg_control_system()`;
    const identity = Array.isArray(identities) && identities.length === 1 ? identities[0] : null;
    if (!identity || identity.read_only !== "on" || identity.database_name !== "broker_platform" || identity.system_identifier !== environment.PRODUCTION_PG_SYSTEM_IDENTIFIER || !/^[0-9]+$/.test(identity.broker_rows || "") || BigInt(identity.broker_rows) < BigInt(environment.PRODUCTION_MIN_BROKER_ROWS)) refused("DATABASE_IDENTITY_MISMATCH");
    const row = await tx.client.findUnique({ where: { id: CLIENT_ID }, select: CLIENT_SELECT });
    const effective = validateCase(row, true);
    const tokenRow = includeToken && canInspectEffectiveBroker(row, effective) ? await tx.systemSetting.findUnique({ where: { key: "AMO_ACCESS_TOKEN" }, select: { value: true } }) : null;
    const audit = includeAudit && canInspectEffectiveBroker(row, effective) ? validateAuditRows(await tx.auditLog.findMany(auditQuery())) : [];
    const recoveryAudit = includeAudit && canInspectEffectiveBroker(row, effective) ? validateRecoveryAuditRows(await tx.auditLog.findMany(recoveryAuditQuery())) : [];
    let noteBaseline = null;
    if (armedRecoveryAuditBound(recoveryAudit)) {
      const noteRow = await tx.client.findUnique({ where: { id: CLIENT_ID }, select: ARMED_NOTE_SELECT });
      if (!noteRow || Object.keys(CLIENT_SELECT).some((key) => privateFingerprint(noteRow[key] && CLIENT_SELECT[key]?.select ?
        Object.fromEntries(Object.keys(CLIENT_SELECT[key].select).map((field) => [field, noteRow[key][field]])) : noteRow[key]) !== privateFingerprint(row[key])))
        refused("CASE_CHANGED_DURING_SCAN");
      const agency = await tx.agency.findUnique({ where: { id: row.fixationAgencyId }, select: { id: true, name: true, inn: true, updatedAt: true } });
      armedRecoveryExpectedNote(noteRow, agency);
      noteBaseline = { row: noteRow, agency };
    }
    return { row, token: tokenRow?.value, audit, recoveryAudit, noteBaseline };
  }, { isolationLevel: "RepeatableRead", timeout: 20000, maxWait: 5000 });
}
function buildReport(row, evidence, brokerContact, storedLead, metadata, expanded = null) {
  const effective = validateCase(row, true);
  if (!canInspectEffectiveBroker(row, effective)) refused("EXPECTED_BROKER_NOT_CANONICAL");
  const expectedBrokerMatched = effective.broker.id === EXPECTED_BROKER_ID;
  const brokerContactMatchesCurrentBrokerPhone = Boolean(brokerContact && helpers.normalizePhone(effective.broker.phone) && helpers.contactHasExactPhone(brokerContact, helpers.normalizePhone(effective.broker.phone)));
  const brokerFlag = brokerFlagEvidence(brokerContact);
  const inspected = helpers.inspectQueueRow(row, evidence.byPhone, randomBytes(32));
  const privateRecord = inspected.attestationRecord;
  const candidates = privateRecord.candidates.map((candidate) => ({
    leadId: candidate.leadId, pipelineId: candidate.pipelineId, statusId: candidate.statusId,
    strength: candidate.strength,
    effectiveBrokerAttachment: candidate.brokerAttachment,
    expectedBrokerAttachment: expectedBrokerMatched ? candidate.brokerAttachment : "not_inspected",
    strictBrokerSourceMarker: candidate.sourceMarker, projectEvidence: candidate.projectEvidence,
    leadCreatedAt: safeTimestamp(candidate.createdAt, row.createdAt),
    brokerRequestAt: safeTimestamp(candidate.requestValidValues, row.createdAt),
  }));
  const storedLeadId = helpers.optionalStoredAmoLeadId(row.amoLeadId);
  const exactIds = evidence.byPhone.get(helpers.normalizePhone(row.phone))?.exactContactIds || [];
  const storedDetail = storedLead ? {
    leadId: storedLead.leadId, pipelineId: storedLead.pipelineId, statusId: storedLead.statusId,
    exactClientContactLinked: storedLead.contactIds.some((id) => exactIds.includes(id)),
    effectiveBrokerLinked: positiveId(effective.broker.amoContactId) !== null && storedLead.contactIds.includes(positiveId(effective.broker.amoContactId)),
    expectedBrokerLinked: expectedBrokerMatched ? positiveId(effective.broker.amoContactId) !== null && storedLead.contactIds.includes(positiveId(effective.broker.amoContactId)) : null,
    strictBrokerSourceMarker: storedLead.sourceMarker,
    leadCreatedAt: safeTimestamp(storedLead.createdAt, row.createdAt),
  } : null;
  const resolution = inspected.publicRecord.resolution;
  // Complete bounded evidence permits a narrow absence statement only about
  // contact-linked KC leads. It does not certify absence anywhere in amoCRM.
  let negativeEvidenceComplete = false;
  if (expanded) {
    try { negativeEvidenceComplete = assertCompleteNegativeEvidence(expanded, row); }
    catch (error) { if (!["EXPANDED_POSSIBLE_LEAD_PRESENT"].includes(error?.safeCode)) throw error; }
  }
  const conclusion = storedLeadId !== null ? "stored_link_requires_review"
    : expanded?.possibleCandidates.length ? "possible_lead_observed_in_expanded_scopes"
    : negativeEvidenceComplete ? "no_possible_lead_observed_in_complete_bounded_scopes"
    : resolution === "single_strong_candidate" ? "unique_strong_candidate_advisory"
    : ["no_exact_client_contact", "no_candidate"].includes(resolution) ? "no_contact_linked_kc_candidate_observed"
    : "ambiguous_or_incomplete_evidence";
  return {
    schemaVersion: 1, scope: "approved_single_client_case", ...metadata,
    expectedBrokerMatched,
    expectedBrokerIsOwner: row.brokerId === EXPECTED_BROKER_ID,
    expectedBrokerIsResponsible: row.responsibleBrokerId === EXPECTED_BROKER_ID,
    mappingSource: effective.source,
    effectiveBrokerRole: effective.broker.role,
    effectiveBrokerStatus: effective.broker.status,
    effectiveBrokerMerged: effective.broker.mergedIntoId !== null,
    effectiveBrokerCanonical: true,
    crmInspectionPerformed: true,
    brokerLinkageReference: "stored_effective_broker_contact",
    brokerStatus: effective.broker.status, brokerContactConfigured: positiveId(effective.broker.amoContactId) !== null,
    brokerContactObserved: brokerContact !== null,
    brokerContactMatchesCurrentBrokerPhone,
    brokerContactHasBrokerFlag: brokerFlag.value === true,
    brokerContactBrokerFlagEvidence: brokerFlag.coverage,
    brokerAgencyCount: effective.broker.brokerAgencies.length,
    fixationAgencyConfigured: row.fixationAgencyId !== null,
    fixationAgencyBelongsToBroker: row.fixationAgencyId !== null && effective.broker.brokerAgencies.some((agency) => agency.agencyId === row.fixationAgencyId),
    database: { ...safeDatabaseState(row), storedLeadObserved: storedLead !== null, storedLeadEvidence: storedDetail },
    evidenceCounts: evidence.stats, exactClientContactCount: exactIds.length,
    strongLeadIds: candidates.filter((candidate) => candidate.strength === "strong").map((candidate) => candidate.leadId),
    linkedLeadCounts: inspected.publicRecord.linkedLeadEvidence,
    resolution, conclusion, candidates, rowUnchangedDuringScan: true,
    expandedEvidence: expanded ? {
      complete: expanded.complete, capturedAt: expanded.capturedAt, window: expanded.window,
      kcWindowPagesRead: expanded.windowPagesRead, kcWindowLeadsRead: expanded.kcWindowLeads.length,
      storedBrokerLinkedLeadsRead: expanded.brokerLinkedLeads.length,
      possibleLeadIds: expanded.possibleCandidates.map((candidate) => candidate.leadId),
      possibleCandidates: expanded.possibleCandidates.map(({ privateLead: _privateLead, ...candidate }) => candidate),
      negativeEvidenceComplete,
      absenceScope: "contact_links_and_all_stored_broker_links_and_bounded_kc_creation_window_only",
    } : null,
    advisory: { ...NO_WRITE, candidateLinkEvidenceSufficient: expectedBrokerMatched && conclusion === "unique_strong_candidate_advisory" && brokerContactMatchesCurrentBrokerPhone && brokerFlag.value === true && effective.broker.status === "ACTIVE" && candidates.some((candidate) => candidate.strength === "strong" && candidate.strictBrokerSourceMarker) },
  };
}
function brokerFlagEvidence(contact) {
  if (contact === null) return { coverage: "contact_missing", value: null };
  const fields = contact.custom_fields_values;
  if (fields === null || fields === undefined) return { coverage: "missing", value: null };
  if (!Array.isArray(fields) || fields.length > 1000) return { coverage: "invalid", value: null };
  const flags = fields.filter((field) => field?.field_id === IS_BROKER_FIELD_ID);
  if (flags.length === 0) return { coverage: "missing", value: null };
  if (flags.length !== 1 || !Array.isArray(flags[0].values) || flags[0].values.length !== 1 || typeof flags[0].values[0]?.value !== "boolean") return { coverage: "invalid", value: null };
  return { coverage: "valid", value: flags[0].values[0].value };
}
function safeDatabaseState(row) {
  return {
    project: row.project, status: row.status, amoSyncStatus: row.amoSyncStatus,
    amoSyncAttempts: row.amoSyncAttempts, errorClass: helpers.classifySyncError(row.amoSyncError),
    uniquenessStatus: row.uniquenessStatus, fixationStatus: row.fixationStatus,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    amoCreatedAt: iso(row.amoCreatedAt, true), amoUpdatedAt: iso(row.amoUpdatedAt, true),
    lastAttemptAt: iso(row.amoSyncLastAttemptAt, true),
    uniquenessExpiresAt: iso(row.uniquenessExpiresAt, true), fixationExpiresAt: iso(row.fixationExpiresAt, true),
    storedLeadId: helpers.optionalStoredAmoLeadId(row.amoLeadId),
  };
}
function buildOwnershipReport(row, metadata) {
  const effective = validateCase(row, true);
  if (effective.broker.id === EXPECTED_BROKER_ID) refused("EXPECTED_BROKER_MISMATCH");
  return {
    schemaVersion: 1, scope: "approved_single_client_case", ...metadata,
    expectedBrokerMatched: false,
    expectedBrokerIsOwner: row.brokerId === EXPECTED_BROKER_ID,
    expectedBrokerIsResponsible: row.responsibleBrokerId === EXPECTED_BROKER_ID,
    mappingSource: effective.source,
    effectiveBrokerRole: effective.broker.role,
    effectiveBrokerStatus: effective.broker.status,
    effectiveBrokerMerged: effective.broker.mergedIntoId !== null,
    effectiveBrokerCanonical: effective.broker.role === "BROKER" && effective.broker.mergedIntoId === null,
    crmInspectionPerformed: false, tokenRead: false,
    database: safeDatabaseState(row),
    conclusion: "effective_broker_mismatch_db_only",
    advisory: { ...NO_WRITE, candidateLinkEvidenceSufficient: false },
  };
}
function safeTimestamp(values, reference) {
  const evidence = helpers.unixTimestampEvidence(values, reference);
  return { coverage: evidence.coverage, validValueCount: evidence.validValueCount, relativeToQueue: evidence.relativeToQueue };
}
const RUNTIME_PHONE_LOCK_PATH = "/app/packages/integrations/dist/amo-fixation-phone-lock.js";
const RUNTIME_PHONE_LOCK_SHA256 = "9bfdcd078d6e708456c8b5face324e04b90174abf85b00ed6b533edd4c5c8c49";
function attestedRuntimePhoneLock() {
  const fs = require("node:fs");
  for (const path of ["/app", "/app/packages", "/app/packages/integrations", "/app/packages/integrations/dist", RUNTIME_PHONE_LOCK_PATH]) {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink() || (path === RUNTIME_PHONE_LOCK_PATH ? !stat.isFile() || stat.size > 64000 : !stat.isDirectory()) || fs.realpathSync(path) !== path) refused("REDIS_HELPER_ATTESTATION_INVALID");
  }
  const bytes = fs.readFileSync(RUNTIME_PHONE_LOCK_PATH);
  if (createHash("sha256").update(bytes).digest("hex") !== RUNTIME_PHONE_LOCK_SHA256) refused("REDIS_HELPER_ATTESTATION_INVALID");
  const module = { exports: {} };
  require("node:vm").runInNewContext(bytes.toString("utf8"), {
    module, exports: module.exports,
    require: (name) => { if (name !== "node:crypto") refused("REDIS_HELPER_ATTESTATION_INVALID"); return require(name); },
  }, { timeout: 1000 });
  if (module.exports.AMO_FIXATION_PHONE_LOCK_REDIS_PREFIX !== "client-fixation:semantic:" || typeof module.exports.amoFixationPhoneLockRedisKey !== "function") refused("REDIS_HELPER_ATTESTATION_INVALID");
  return module.exports.amoFixationPhoneLockRedisKey;
}
function createReadOnlyRedis(Redis, environment) {
  if (environment.REDIS_HOST !== "redis" || environment.REDIS_PORT !== "6379" ||
    (environment.REDIS_DB !== undefined && environment.REDIS_DB !== "0") || environment.REDIS_PASSWORD) refused("REDIS_IDENTITY_INVALID");
  return new Redis({ host: "redis", port: 6379, db: 0, lazyConnect: true,
    enableReadyCheck: false, maxRetriesPerRequest: 0, commandTimeout: 3000,
    connectTimeout: 3000, retryStrategy: () => null });
}
async function collectReadOnlyRedisLease(redis, row, phoneLockKey, clock = () => Date.now()) {
  validateCase(row, true);
  if (!canInspectEffectiveBroker(row) || typeof phoneLockKey !== "function" ||
    !redis || ["get", "exists", "pttl"].some((method) => typeof redis[method] !== "function")) refused("REDIS_LEASE_SCOPE_INVALID");
  const key = phoneLockKey(row.phone);
  if (typeof key !== "string" || !/^client-fixation:semantic:[0-9a-f]{64}$/.test(key)) refused("REDIS_LEASE_SCOPE_INVALID");
  const sample = async () => {
    const start = clock();
    // The raw key/value stay private. Only these three readonly Redis methods
    // are called; never SCAN, KEYS, SET, EVAL, MULTI, delete or lease renewal.
    const value = await redis.get(key);
    const ttl = await redis.pttl(key);
    const exists = await redis.exists(key);
    const end = clock();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 10000 ||
      ![0, 1].includes(exists) || !Number.isSafeInteger(ttl) || ttl < -2 || ttl > 24 * 60 * 60 * 1000 ||
      (value !== null && (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096))) refused("REDIS_LEASE_OBSERVATION_INVALID");
    let status = "absent";
    if (value !== null) {
      let parsed; try { parsed = JSON.parse(value); } catch { refused("REDIS_LEASE_OBSERVATION_INVALID"); }
      if (!record(parsed) || !["processing", "completed", "uncertain"].includes(parsed.status)) refused("REDIS_LEASE_OBSERVATION_INVALID");
      status = parsed.status;
    }
    return { valueHash: privateFingerprint(value), present: exists === 1, ttl, status, start, end,
      consistent: value === null ? exists === 0 && ttl === -2 : exists === 1 && ttl >= -1 };
  };
  const first = await sample(), second = await sample();
  const elapsed = second.end - first.start;
  const ttlStable = first.ttl < 0 ? first.ttl === second.ttl : second.ttl >= 0 && second.ttl <= first.ttl && first.ttl - second.ttl <= elapsed + 100;
  const stableReadback = first.consistent && second.consistent && first.present === second.present && first.status === second.status && first.valueHash === second.valueHash && elapsed >= 0 && elapsed <= 20000 && ttlStable;
  return { performed: true, lockPresent: second.present, ttlMs: second.ttl,
    uncertainPresent: second.present && second.status === "uncertain",
    uncertainTtlMs: second.present && second.status === "uncertain" ? second.ttl : null,
    bounded: true, identitySafe: true, stableReadback, mutationAttempted: false };
}
async function run({ prisma, environment = process.env, fetchImpl, now = () => new Date(), readRedisLease } = {}) {
  const metadata = runtimeMetadata(environment);
  const initial = await snapshot(prisma, environment, true, true);
  if (!canInspectEffectiveBroker(initial.row)) return buildOwnershipReport(initial.row, metadata);
  const redisLease = typeof readRedisLease === "function" ? await readRedisLease(initial.row) : { performed: false };
  const token = typeof initial.token === "string" && initial.token.trim() ? initial.token : environment.AMO_ACCESS_TOKEN;
  const scanNow = now();
  const window = makeEvidenceWindow(initial.row, scanNow);
  const request = serializeRequester(helpers.createGetOnlyRequester(token, fetchImpl));
  const requestWindow = createKcWindowRequester(token, fetchImpl, window);
  await helpers.assertExpectedAccount(request);
  const effective = validateCase(initial.row, true);
  const brokerContactId = positiveId(effective.broker.amoContactId);
  const brokerContact = brokerContactId ? await request(`/api/v4/contacts/${brokerContactId}`, { with: "leads" }) : null;
  if (brokerContact && brokerContact.id !== brokerContactId) refused("BROKER_CONTACT_ID_MISMATCH");
  const contactEvidence = () => helpers.collectAmoEvidence([initial.row], request);
  const expanded = await collectExpandedEvidence({ row: initial.row, brokerContact, contactEvidence, request, requestWindow, scanNow });
  const reviewLeadComparison = await collectReviewLeadComparison(initial.row, expanded, request, createReviewNotesRequester(token, fetchImpl));
  const reviewLeadHistory = await collectReviewLeadHistory(initial.row, expanded, request, createReviewHistoryRequester(token, fetchImpl));
  const evidence = expanded.contactEvidence;
  let armedRecoveryLead = { performed: false, reason: "literal_recovery_lead_not_observed", retryAuthorized: false };
  if (expanded.possibleCandidates.some((candidate) => candidate.leadId === ARMED_RECOVERY_LEAD_ID)) {
    const raw = await request(`/api/v4/leads/${ARMED_RECOVERY_LEAD_ID}`, { with: "contacts" });
    armedRecoveryLead = armedRecoveryLeadDiagnostic(initial.row, initial.recoveryAudit, raw,
      evidence.byPhone.get(helpers.normalizePhone(initial.row.phone))?.exactContactIds, scanNow);
    if (armedRecoveryLead.performed) {
      const extra = createArmedRecoveryExtraRequester(token, fetchImpl);
      const notes = await extra("notes"), field = await extra("dateField");
      Object.assign(armedRecoveryLead, armedRecoveryExtraDiagnostic(initial.row, notes, field, initial.noteBaseline));
      const notesAfter = await extra("notes"), fieldAfter = await extra("dateField");
      const rawAfter = await request(`/api/v4/leads/${ARMED_RECOVERY_LEAD_ID}`, { with: "contacts" });
      if (privateFingerprint(stableReviewEntity(raw)) !== privateFingerprint(stableReviewEntity(rawAfter)) ||
        raw.price !== rawAfter?.price || privateFingerprint(notes) !== privateFingerprint(notesAfter) || privateFingerprint(field) !== privateFingerprint(fieldAfter))
        armedRecoveryLead = { performed: false, reason: "recovery_extra_evidence_changed_during_scan", retryAuthorized: false };
    }
  }
  const storedId = helpers.optionalStoredAmoLeadId(initial.row.amoLeadId);
  const storedRaw = storedId ? await request(`/api/v4/leads/${storedId}`, { with: "contacts" }) : null;
  const storedLead = storedRaw ? helpers.reduceLeadEvidence(storedRaw, storedId) : null;
  const final = await snapshot(prisma, environment, false, true);
  if (privateFingerprint(initial.row) !== privateFingerprint(final.row)) refused("CASE_CHANGED_DURING_SCAN");
  if (privateFingerprint(initial.noteBaseline) !== privateFingerprint(final.noteBaseline)) refused("CASE_CHANGED_DURING_SCAN");
  if (privateFingerprint(initial.recoveryAudit) !== privateFingerprint(final.recoveryAudit))
    armedRecoveryLead = { performed: false, reason: "recovery_audit_changed_during_scan", retryAuthorized: false };
  return { ...buildReport(initial.row, evidence, brokerContact, storedLead, metadata, expanded), reviewLeadComparison, reviewLeadHistory, armedRecoveryLead, caseAudit: auditReport(initial.audit, initial.row, privateFingerprint(initial.audit) === privateFingerprint(final.audit)), recoveryAudit: recoveryAuditReport(initial.recoveryAudit, privateFingerprint(initial.recoveryAudit) === privateFingerprint(final.recoveryAudit)), redisLease };
}
function failureCode(error) {
  const allowed = ["INVALID_CASE_TIMESTAMP", "INVALID_CASE_STATE", "RESPONSIBLE_BROKER_UNRESOLVED", "OWNER_BROKER_UNRESOLVED", "FIXED_CLIENT_MISSING", "EXPECTED_BROKER_MISMATCH", "EXPECTED_BROKER_NOT_CANONICAL", "INVALID_CLIENT_PHONE", "PROJECT_MAPPING_UNSUPPORTED", "INVALID_SYNC_ATTEMPTS", "INVALID_BROKER_CONTACT_ID", "AGENCY_SCOPE_TOO_LARGE", "SOURCE_ATTESTATION_INVALID", "DATABASE_ATTESTATION_INVALID", "UNSAFE_TLS_CONFIGURATION", "DATABASE_IDENTITY_MISMATCH", "BROKER_CONTACT_ID_MISMATCH", "CASE_CHANGED_DURING_SCAN", "INVALID_CASE_NAME", "CASE_SCAN_WINDOW_UNSAFE", "WINDOW_REQUEST_CONFIGURATION_INVALID", "WINDOW_PAGE_BOUND_EXCEEDED", "WINDOW_REQUEST_REJECTED", "WINDOW_REQUEST_FAILED", "EXPANDED_LEAD_INVALID", "WINDOW_LEAD_OUT_OF_SCOPE", "WINDOW_PAGE_INVALID", "WINDOW_LEAD_DUPLICATED", "WINDOW_PAGINATION_INCOMPLETE", "BROKER_LINK_SCAN_UNAVAILABLE", "BROKER_LINK_SCAN_INVALID", "EXPANDED_CONTACT_EVIDENCE_INVALID", "EXPANDED_LEAD_CHANGED_DURING_SCAN", "EXPANDED_EVIDENCE_INCOMPLETE", "EXPANDED_POSSIBLE_LEAD_PRESENT"];
  allowed.push("REVIEW_REQUEST_CONFIGURATION_INVALID", "REVIEW_NOTES_REQUEST_REJECTED", "REVIEW_NOTES_REQUEST_FAILED", "REVIEW_CONTACT_INVALID", "REVIEW_NOTES_INVALID", "REVIEW_HISTORY_SCOPE_INVALID", "REVIEW_EVENTS_INVALID", "REVIEW_CONTACT_SCOPE_EXCEEDED");
  allowed.push("REVIEW_SOURCE_INVALID", "CASE_AUDIT_INVALID", "CASE_AUDIT_SCOPE_EXCEEDED");
  allowed.push("RECOVERY_AUDIT_INVALID", "RECOVERY_AUDIT_SCOPE_EXCEEDED");
  allowed.push("REDIS_HELPER_ATTESTATION_INVALID", "REDIS_IDENTITY_INVALID", "REDIS_LEASE_SCOPE_INVALID", "REDIS_LEASE_OBSERVATION_INVALID");
  try { return allowed.includes(error?.safeCode) ? error.safeCode : helpers.classifyFailure(error); } catch { return "UNKNOWN_FAILURE"; }
}
async function main() {
  if (typeof FIXED_CASE_INSPECTOR_SOURCE_SHA256 === "undefined" || typeof FIXED_CASE_DEPENDENCY_SOURCE_SHA256 === "undefined" || FIXED_CASE_INSPECTOR_SOURCE_SHA256 !== process.env.FIXED_CASE_INSPECTOR_SHA256 || FIXED_CASE_DEPENDENCY_SOURCE_SHA256 !== process.env.FIXED_CASE_DEPENDENCY_SHA256) refused("SOURCE_ATTESTATION_INVALID");
  runtimeMetadata(process.env);
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient({ datasources: { db: { url: helpers.buildReadOnlyDatabaseUrl(process.env.DATABASE_URL) } }, log: [] });
  let redis;
  try {
    const phoneLockKey = attestedRuntimePhoneLock();
    redis = createReadOnlyRedis(require("/app/node_modules/ioredis"), process.env);
    redis.on("error", () => {});
    await redis.connect();
    process.stdout.write(`${JSON.stringify(await run({ prisma, readRedisLease: (row) => collectReadOnlyRedisLease(redis, row, phoneLockKey) }), null, 2)}\n`);
  } finally { redis?.disconnect(); await prisma.$disconnect(); }
}
module.exports = { CLIENT_ID, EXPECTED_BROKER_ID, IS_BROKER_FIELD_ID, CLIENT_SELECT, KC_PIPELINE_ID, WINDOW_PAGE_LIMIT, WINDOW_MAX_PAGES, BROKER_MAX_LINKED_LEADS, privateFingerprint, expectedGeneratedName, makeEvidenceWindow, createKcWindowRequester, collectWindowLeads, collectBrokerLeads, collectExpandedEvidence, assertCompleteNegativeEvidence, validateCase, canInspectEffectiveBroker, brokerFlagEvidence, runtimeMetadata, snapshot, buildReport, buildOwnershipReport, run, failureCode, main };
Object.assign(module.exports, { REVIEW_LEAD_ID, normalizedName, textPhoneMatches, createReviewNotesRequester, collectReviewLeadComparison, validatedLead });
Object.assign(module.exports, { createReviewHistoryRequester, collectReviewEvents, collectReviewLeadHistory, reviewContactEvidence, reviewSourceEvidence, auditQuery, validateAuditRows, auditReport });
Object.assign(module.exports, { recoveryAuditQuery, validateRecoveryAuditRows, recoveryAuditReport });
Object.assign(module.exports, { armedRecoveryLeadDiagnostic, ARMED_RECOVERY_METADATA });
Object.assign(module.exports, { armedRecoveryFormDiagnostic, createArmedRecoveryExtraRequester, armedRecoveryExtraDiagnostic });
Object.assign(module.exports, { ARMED_NOTE_SELECT, armedRecoveryAuditBound, armedRecoveryExpectedNote });
Object.assign(module.exports, { attestedRuntimePhoneLock, createReadOnlyRedis, collectReadOnlyRedisLease });
if (require.main === module) main().catch((error) => { process.stderr.write(`fixed_case_failure_code=${failureCode(error)}\n`); process.exitCode = 1; });
