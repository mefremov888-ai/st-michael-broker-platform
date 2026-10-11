"use strict";

// Pure, case-specific advisory certificate. No I/O, CRM/DB mutation, token or
// generic reconciliation override. Opaque certificates work only in this process.
const { createHash } = require("node:crypto");
const inspector = require("./inspect-fixed-amo-fixation-case.js");
const helpers = require("./inspect-amo-fixation-lead-reconciliation.js");
const CASE_ID = "8d082b21-7cba-4778-a6c6-1d80bfe7ed7c";
const OWNER_ID = "6e414141-f2ca-4c71-8402-2032c9186568";
const LEAD_ID = 32372907, BROKER_CONTACT_ID = 47267177, COMPANY_ID = 43419077;
const CREATED_AT = Date.parse("2026-10-09T07:52:47Z") / 1000;
const certificates = new WeakMap();
function fail(code) { const error = new Error("Exact case exclusion refused"); error.safeCode = code; throw error; }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry)).digest("hex"); }
function bounded(value, bytes = 1024 * 1024) { if (Buffer.byteLength(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry) ?? "", "utf8") > bytes) fail("CERT_BODY_BOUND_EXCEEDED"); }
function id(value) { return typeof value === "bigint" ? value === BigInt(BROKER_CONTACT_ID) ? BROKER_CONTACT_ID : null : Number.isSafeInteger(value) && value > 0 ? value : null; }
function context(row, agency) {
  if (!record(row) || row.id !== CASE_ID || row.brokerId !== OWNER_ID || row.broker?.id !== OWNER_ID || row.project !== "ZORGE9" || (row.responsibleBrokerId !== null && (typeof row.responsibleBrokerId !== "string" || !row.responsibleBrokerId || row.responsibleBrokerId.length > 80))) fail("CERT_CASE_SCOPE_INVALID");
  const effective = row.responsibleBrokerId === null ? row.broker : row.responsibleBroker;
  if (!record(effective) || effective.id !== (row.responsibleBrokerId || row.brokerId) || id(effective.amoContactId) !== BROKER_CONTACT_ID || effective.role !== "BROKER" || effective.mergedIntoId !== null || !["ACTIVE", "PENDING"].includes(effective.status)) fail("CERT_CASE_SCOPE_INVALID");
  if (!helpers.normalizePhone(row.phone) || !helpers.normalizePhone(effective.phone) || helpers.normalizePhone(row.phone) === helpers.normalizePhone(effective.phone) || !record(agency) || typeof agency.id !== "string" || agency.id !== row.fixationAgencyId || !Array.isArray(effective.brokerAgencies) || !effective.brokerAgencies.some((member) => member.agencyId === agency.id)) fail("CERT_CASE_SCOPE_INVALID");
  if (new Date(row.createdAt).toISOString() !== "2026-10-08T14:18:19.203Z" || new Date(row.amoSyncLastAttemptAt).toISOString() !== "2026-10-08T14:18:19.466Z" || row.amoLeadId !== null) fail("CERT_CASE_TIME_INVALID");
  inspector.expectedGeneratedName(row);
  bounded(row); bounded(agency, 64000);
  // Operational lease/CAS markers can change while this same immutable case is
  // claimed. Its identity, payload and original attempt timestamp cannot.
  const immutable = { ...row };
  for (const key of ["updatedAt", "amoSyncStatus", "amoSyncAttempts", "amoSyncError"]) delete immutable[key];
  return { row, agency, immutable, effective };
}
function fixedCaseHash(row, agency) { const checked = context(row, agency); return hash({ scope: "fixed-case-calltouch-exclusion-v1", case: checked.immutable, agency: checked.agency }); }
function textValues(lead, fieldId) {
  if (!Array.isArray(lead.custom_fields_values) || lead.custom_fields_values.length > 1000) fail("CERT_FIELD_INVALID");
  const fields = lead.custom_fields_values.filter((field) => field?.field_id === fieldId);
  if (fields.length !== 1 || !Array.isArray(fields[0].values) || fields[0].values.length !== 1 || typeof fields[0].values[0]?.value !== "string" || !fields[0].values[0].value.trim() || Buffer.byteLength(fields[0].values[0].value, "utf8") > 64000) fail("CERT_FIELD_INVALID");
  return fields[0].values[0].value;
}
function strings(value, depth = 0) {
  if (depth > 8) fail("CERT_VALUE_DEPTH_EXCEEDED");
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => strings(item, depth + 1));
  if (record(value)) return Object.values(value).flatMap((item) => strings(item, depth + 1));
  return [];
}
function privateMentions(value, row) {
  const clientName = inspector.normalizedName(row.fullName);
  return strings(value).some((text) => text.includes(CASE_ID) || inspector.textPhoneMatches(text, helpers.normalizePhone(row.phone)) || (` ${inspector.normalizedName(text)} `).includes(` ${clientName} `));
}
function validateLead(lead, row) {
  bounded(lead);
  if (!record(lead) || lead.id !== LEAD_ID || lead.pipeline_id !== 7600542 || lead.status_id !== 143 || lead.created_at !== CREATED_AT || typeof lead.name !== "string" || privateMentions(lead, row)) fail("CERT_LEAD_INVALID");
  const contacts = lead._embedded?.contacts, companies = lead._embedded?.companies;
  if (!Array.isArray(contacts) || contacts.length !== 1 || contacts[0]?.id !== BROKER_CONTACT_ID || !Array.isArray(companies) || companies.length !== 1 || companies[0]?.id !== COMPANY_ID) fail("CERT_LEAD_LINKS_INVALID");
  return lead;
}
function validateBroker(contact, row, effective) {
  bounded(contact);
  if (contact?.id !== BROKER_CONTACT_ID || inspector.brokerFlagEvidence(contact).value !== true || !helpers.contactHasExactPhone(contact, helpers.normalizePhone(effective.phone)) || helpers.contactHasExactPhone(contact, helpers.normalizePhone(row.phone))) fail("CERT_BROKER_INVALID");
  const linked = contact._embedded?.leads;
  if (!Array.isArray(linked) || linked.length > 250 || linked.some((lead) => !Number.isSafeInteger(lead?.id) || lead.id <= 0) || new Set(linked.map((lead) => lead.id)).size !== linked.length) fail("CERT_BROKER_LINKS_INVALID");
}
function brokerIdentity(contact) {
  // Own successful lead creation changes only broker lead membership/version.
  // Expanded scans and the wrapper's expected-created-lead guard still check
  // every linked lead. These are not part of this unrelated-call identity hash.
  const identity = { ...contact, _embedded: { ...contact._embedded } };
  delete identity.updated_at;
  delete identity._embedded.leads;
  return identity;
}
function validateNotes(notes, row) {
  bounded(notes);
  if (!record(notes) || !Array.isArray(notes._embedded?.notes) || notes._embedded.notes.length !== 0 || notes._links?.next || privateMentions(notes, row)) fail("CERT_NOTES_INCOMPLETE");
}
function validateEvents(result, expanded, row) {
  bounded(result);
  if (!record(result) || result.coverage !== "observed" || result.complete !== true || !Number.isInteger(result.pagesRead) || result.pagesRead < 1 || result.pagesRead > 5 || !Array.isArray(result.events) || result.events.length > 500) fail("CERT_EVENTS_INCOMPLETE");
  const ids = new Set();
  for (const event of result.events) {
    if (!record(event) || typeof event.id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(event.id) || ids.has(event.id) || event.entity_id !== LEAD_ID || event.entity_type !== "lead" || event.account_id !== 28552900 || typeof event.type !== "string" || !/^[a-z0-9_]{1,100}$/.test(event.type) || !Number.isSafeInteger(event.created_at) || event.created_at < CREATED_AT || event.created_at > expanded.window.to || !Array.isArray(event.value_before) || !Array.isArray(event.value_after) || event.value_before.length > 100 || event.value_after.length > 100 || /deleted|restored|merged|unlinked/.test(event.type) || privateMentions([event.value_before, event.value_after], row)) fail("CERT_EVENT_INVALID");
    ids.add(event.id);
  }
  const added = result.events.filter((event) => event.type === "lead_added");
  if (added.length !== 1 || added[0].created_at !== CREATED_AT) fail("CERT_CREATION_EVENT_INVALID");
  const linked = [];
  for (const event of result.events.filter((entry) => ["entity_linked", "contact_linked", "company_linked"].includes(entry.type))) {
    for (const value of [...event.value_before, ...event.value_after]) {
      const entity = value?.link?.entity;
      if (!record(entity) || !((entity.type === "contact" && entity.id === BROKER_CONTACT_ID) || (entity.type === "company" && entity.id === COMPANY_ID))) fail("CERT_EVENT_LINK_INVALID");
      linked.push({ ...entity, at: event.created_at });
    }
  }
  if (!linked.some((entity) => entity.type === "contact" && entity.at === CREATED_AT) || !linked.some((entity) => entity.type === "company")) fail("CERT_INITIAL_LINK_MISSING");
  return [...result.events].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}
function historyValues(events, fieldId) {
  const changes = events.filter((event) => event.type === `custom_field_${fieldId}_value_changed`);
  if (changes.length === 0) fail("CERT_INITIAL_SOURCE_MISSING");
  const all = [];
  for (const event of changes) {
    for (const change of [...event.value_before, ...event.value_after]) {
      const field = change?.custom_field_value;
      if (!record(field) || field.field_id !== fieldId || typeof field.text !== "string" || Buffer.byteLength(field.text, "utf8") > 64000) fail("CERT_HISTORICAL_FIELD_INVALID");
      if (field.text.trim()) all.push(field.text);
    }
  }
  const firstAfter = changes[0].value_after.map((change) => change?.custom_field_value?.text).filter((text) => typeof text === "string" && text.trim());
  if (firstAfter.length !== 1 || all.length === 0) fail("CERT_INITIAL_SOURCE_MISSING");
  return { initial: firstAfter[0], all };
}
function stableInput(input) {
  const { row, agency, expanded, candidate } = input;
  const { effective } = context(row, agency);
  if (input.brokerContactId !== BROKER_CONTACT_ID || input.expectedCompanyId !== COMPANY_ID || !record(expanded) || expanded.complete !== true || !record(expanded.window) || expanded.window.pipelineId !== 7600542 || !Number.isSafeInteger(expanded.window.to) || !Array.isArray(expanded.possibleCandidates) || expanded.possibleCandidates.filter((item) => item.leadId === LEAD_ID).length !== 1 || !record(candidate)) fail("CERT_SCOPE_INVALID");
  const age = Date.now() - Date.parse(expanded.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > 60000) fail("CERT_EVIDENCE_STALE");
  const firstLead = validateLead(candidate.leadFirst, row), secondLead = validateLead(candidate.leadSecond, row);
  validateBroker(candidate.brokerContactFirst, row, effective); validateBroker(candidate.brokerContactSecond, row, effective);
  validateNotes(candidate.notesFirst, row); validateNotes(candidate.notesSecond, row);
  const firstEvents = validateEvents(candidate.eventsFirst, expanded, row), secondEvents = validateEvents(candidate.eventsSecond, expanded, row);
  for (const [first, second] of [[firstLead, secondLead], [candidate.brokerContactFirst, candidate.brokerContactSecond], [candidate.notesFirst, candidate.notesSecond], [{ ...candidate.eventsFirst, events: firstEvents }, { ...candidate.eventsSecond, events: secondEvents }]]) if (hash(first) !== hash(second)) fail("CERT_READBACK_CHANGED");
  const source = textValues(firstLead, 618511), phone = textValues(firstLead, 618517), callId = textValues(firstLead, 618577), requestTime = textValues(firstLead, 618527);
  const historicalSource = historyValues(firstEvents, 618511), historicalPhone = historyValues(firstEvents, 618517), historicalCall = historyValues(firstEvents, 618577), historicalTime = historyValues(firstEvents, 618527);
  const calltouch = (value) => /(?:^|[^a-z])calltouch(?:$|[^a-z])/i.test(value);
  if (!calltouch(source) || !calltouch(historicalSource.initial) || !historicalSource.all.every(calltouch) || !historicalCall.all.every((value) => value === callId) || !historicalTime.all.every((value) => value === requestTime) || !historicalPhone.all.every((value) => helpers.normalizePhone(value) === helpers.normalizePhone(effective.phone)) || helpers.normalizePhone(phone) !== helpers.normalizePhone(effective.phone)) fail("CERT_CALLTOUCH_PROVENANCE_INVALID");
  const privateLead = inspector.validatedLead(firstLead, LEAD_ID, row, expanded.window, false);
  const candidateEntry = expanded.possibleCandidates.find((item) => item.leadId === LEAD_ID);
  if (hash(privateLead) !== hash(candidateEntry.privateLead)) fail("CERT_CANDIDATE_CHANGED");
  return { caseHash: fixedCaseHash(row, agency), privateLeadHash: hash(privateLead), candidateHash: hash({ lead: firstLead, broker: brokerIdentity(candidate.brokerContactFirst), notes: candidate.notesFirst, events: { ...candidate.eventsFirst, events: firstEvents } }), evidenceCapturedAt: expanded.capturedAt, windowHash: hash(expanded.window) };
}
function buildFixedCaseExclusionCertificate(input) {
  const evidence = stableInput(input);
  const cert = Object.freeze({ schemaVersion: 1, caseHash: evidence.caseHash, candidateHash: evidence.candidateHash, leadId: LEAD_ID, source: "exact_case_broker_calltouch_readback" });
  certificates.set(cert, evidence);
  return cert;
}
function recheckFixedCaseExclusionCertificate(cert, input) {
  const original = certificates.get(cert);
  if (!original) fail("CERT_UNTRUSTED");
  const fresh = stableInput(input);
  if (original.caseHash !== fresh.caseHash || original.candidateHash !== fresh.candidateHash || original.privateLeadHash !== fresh.privateLeadHash) fail("CERT_RECHECK_CHANGED");
  const rechecked = buildFixedCaseExclusionCertificate(input);
  certificates.delete(cert);
  return rechecked;
}
function filterFixedCaseExcludedCandidate(expanded, cert, row, agency) {
  const proof = certificates.get(cert);
  const age = Date.now() - Date.parse(expanded.capturedAt);
  if (!proof || !Number.isFinite(age) || age < 0 || age > 60000 || expanded.complete !== true || fixedCaseHash(row, agency) !== proof.caseHash || expanded.capturedAt !== proof.evidenceCapturedAt || hash(expanded.window) !== proof.windowHash) fail("CERT_UNTRUSTED");
  const entry = expanded.possibleCandidates?.filter((item) => item.leadId === LEAD_ID);
  if (!Array.isArray(entry) || entry.length !== 1 || hash(entry[0].privateLead) !== proof.privateLeadHash) fail("CERT_CANDIDATE_CHANGED");
  return { ...expanded, possibleCandidates: expanded.possibleCandidates.filter((item) => item.leadId !== LEAD_ID) };
}
module.exports = { buildFixedCaseExclusionCertificate, recheckFixedCaseExclusionCertificate, filterFixedCaseExcludedCandidate, fixedCaseHash };
