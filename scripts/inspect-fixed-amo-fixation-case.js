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
      if (entity?.type === "contact") { if (!positiveId(entity.id)) refused("REVIEW_EVENTS_INVALID"); if (entity.id !== brokerId) ids.add(entity.id); }
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
async function snapshot(prisma, environment, includeToken) {
  return prisma.$transaction(async (tx) => {
    await helpers.assertReadOnlySession(tx);
    const identities = await tx.$queryRaw`SELECT current_setting('transaction_read_only') AS read_only, current_database() AS database_name, system_identifier::text AS system_identifier, (SELECT count(*)::text FROM public.brokers) AS broker_rows FROM pg_control_system()`;
    const identity = Array.isArray(identities) && identities.length === 1 ? identities[0] : null;
    if (!identity || identity.read_only !== "on" || identity.database_name !== "broker_platform" || identity.system_identifier !== environment.PRODUCTION_PG_SYSTEM_IDENTIFIER || !/^[0-9]+$/.test(identity.broker_rows || "") || BigInt(identity.broker_rows) < BigInt(environment.PRODUCTION_MIN_BROKER_ROWS)) refused("DATABASE_IDENTITY_MISMATCH");
    const row = await tx.client.findUnique({ where: { id: CLIENT_ID }, select: CLIENT_SELECT });
    const effective = validateCase(row, true);
    const tokenRow = includeToken && canInspectEffectiveBroker(row, effective) ? await tx.systemSetting.findUnique({ where: { key: "AMO_ACCESS_TOKEN" }, select: { value: true } }) : null;
    return { row, token: tokenRow?.value };
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
async function run({ prisma, environment = process.env, fetchImpl, now = () => new Date() } = {}) {
  const metadata = runtimeMetadata(environment);
  const initial = await snapshot(prisma, environment, true);
  if (!canInspectEffectiveBroker(initial.row)) return buildOwnershipReport(initial.row, metadata);
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
  const storedId = helpers.optionalStoredAmoLeadId(initial.row.amoLeadId);
  const storedRaw = storedId ? await request(`/api/v4/leads/${storedId}`, { with: "contacts" }) : null;
  const storedLead = storedRaw ? helpers.reduceLeadEvidence(storedRaw, storedId) : null;
  const final = await snapshot(prisma, environment, false);
  if (privateFingerprint(initial.row) !== privateFingerprint(final.row)) refused("CASE_CHANGED_DURING_SCAN");
  return { ...buildReport(initial.row, evidence, brokerContact, storedLead, metadata, expanded), reviewLeadComparison, reviewLeadHistory };
}
function failureCode(error) {
  const allowed = ["INVALID_CASE_TIMESTAMP", "INVALID_CASE_STATE", "RESPONSIBLE_BROKER_UNRESOLVED", "OWNER_BROKER_UNRESOLVED", "FIXED_CLIENT_MISSING", "EXPECTED_BROKER_MISMATCH", "EXPECTED_BROKER_NOT_CANONICAL", "INVALID_CLIENT_PHONE", "PROJECT_MAPPING_UNSUPPORTED", "INVALID_SYNC_ATTEMPTS", "INVALID_BROKER_CONTACT_ID", "AGENCY_SCOPE_TOO_LARGE", "SOURCE_ATTESTATION_INVALID", "DATABASE_ATTESTATION_INVALID", "UNSAFE_TLS_CONFIGURATION", "DATABASE_IDENTITY_MISMATCH", "BROKER_CONTACT_ID_MISMATCH", "CASE_CHANGED_DURING_SCAN", "INVALID_CASE_NAME", "CASE_SCAN_WINDOW_UNSAFE", "WINDOW_REQUEST_CONFIGURATION_INVALID", "WINDOW_PAGE_BOUND_EXCEEDED", "WINDOW_REQUEST_REJECTED", "WINDOW_REQUEST_FAILED", "EXPANDED_LEAD_INVALID", "WINDOW_LEAD_OUT_OF_SCOPE", "WINDOW_PAGE_INVALID", "WINDOW_LEAD_DUPLICATED", "WINDOW_PAGINATION_INCOMPLETE", "BROKER_LINK_SCAN_UNAVAILABLE", "BROKER_LINK_SCAN_INVALID", "EXPANDED_CONTACT_EVIDENCE_INVALID", "EXPANDED_LEAD_CHANGED_DURING_SCAN", "EXPANDED_EVIDENCE_INCOMPLETE", "EXPANDED_POSSIBLE_LEAD_PRESENT"];
  allowed.push("REVIEW_REQUEST_CONFIGURATION_INVALID", "REVIEW_NOTES_REQUEST_REJECTED", "REVIEW_NOTES_REQUEST_FAILED", "REVIEW_CONTACT_INVALID", "REVIEW_NOTES_INVALID", "REVIEW_HISTORY_SCOPE_INVALID", "REVIEW_EVENTS_INVALID", "REVIEW_CONTACT_SCOPE_EXCEEDED");
  try { return allowed.includes(error?.safeCode) ? error.safeCode : helpers.classifyFailure(error); } catch { return "UNKNOWN_FAILURE"; }
}
async function main() {
  if (typeof FIXED_CASE_INSPECTOR_SOURCE_SHA256 === "undefined" || typeof FIXED_CASE_DEPENDENCY_SOURCE_SHA256 === "undefined" || FIXED_CASE_INSPECTOR_SOURCE_SHA256 !== process.env.FIXED_CASE_INSPECTOR_SHA256 || FIXED_CASE_DEPENDENCY_SOURCE_SHA256 !== process.env.FIXED_CASE_DEPENDENCY_SHA256) refused("SOURCE_ATTESTATION_INVALID");
  runtimeMetadata(process.env);
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient({ datasources: { db: { url: helpers.buildReadOnlyDatabaseUrl(process.env.DATABASE_URL) } }, log: [] });
  try { process.stdout.write(`${JSON.stringify(await run({ prisma }), null, 2)}\n`); }
  finally { await prisma.$disconnect(); }
}
module.exports = { CLIENT_ID, EXPECTED_BROKER_ID, IS_BROKER_FIELD_ID, CLIENT_SELECT, KC_PIPELINE_ID, WINDOW_PAGE_LIMIT, WINDOW_MAX_PAGES, BROKER_MAX_LINKED_LEADS, privateFingerprint, expectedGeneratedName, makeEvidenceWindow, createKcWindowRequester, collectWindowLeads, collectBrokerLeads, collectExpandedEvidence, assertCompleteNegativeEvidence, validateCase, canInspectEffectiveBroker, brokerFlagEvidence, runtimeMetadata, snapshot, buildReport, buildOwnershipReport, run, failureCode, main };
Object.assign(module.exports, { REVIEW_LEAD_ID, normalizedName, textPhoneMatches, createReviewNotesRequester, collectReviewLeadComparison, validatedLead });
Object.assign(module.exports, { createReviewHistoryRequester, collectReviewEvents, collectReviewLeadHistory, reviewContactEvidence });
if (require.main === module) main().catch((error) => { process.stderr.write(`fixed_case_failure_code=${failureCode(error)}\n`); process.exitCode = 1; });
