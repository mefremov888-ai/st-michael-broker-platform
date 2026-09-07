#!/usr/bin/env node
/**
 * PII-safe live amoCRM source report.
 *
 * This inspector reads the canonical St Michael amoCRM account directly. It
 * never loads Nest, Prisma, or the broker-platform database. All contact and
 * lead identifiers and all contact fields remain in memory. The only output is
 * one aggregate JSON document; dependency errors are deliberately suppressed.
 */

"use strict";

const AMO_ORIGIN = "https://stmichael.amocrm.ru";
const EXPECTED_ACCOUNT_ID = 28552900;
const PAGE_LIMIT = 250;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_ATTEMPTS = 4;
const MIN_REQUEST_INTERVAL_MS = 180;
const MAX_CONTACT_PAGES = 2_000;
const MAX_PIPELINE_PAGES = 1_000;

const FAILURE_CODE_BY_MESSAGE = new Map([
  ["Invalid contact record", "INVALID_CONTACT_RECORD"],
  ["Invalid lead record", "INVALID_LEAD_RECORD"],
  ["Lead escaped requested pipeline", "LEAD_PIPELINE_MISMATCH"],
  ["Lead has invalid status", "INVALID_LEAD_STATUS"],
  [
    "Lead contact relations were not embedded",
    "LEAD_CONTACT_RELATIONS_MISSING",
  ],
  ["Unsafe amoCRM path", "UNSAFE_AMO_PATH"],
  ["Unsafe amoCRM URL", "UNSAFE_AMO_URL"],
  ["amoCRM access token is missing", "AMO_ACCESS_TOKEN_MISSING"],
  ["fetch is unavailable", "FETCH_UNAVAILABLE"],
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
  ["Malformed amoCRM response", "MALFORMED_AMO_RESPONSE"],
  ["Malformed amoCRM page", "MALFORMED_AMO_PAGE"],
  [
    "amoCRM page exceeded item safety bound",
    "AMO_PAGE_ITEM_SAFETY_BOUND_EXCEEDED",
  ],
  ["amoCRM pagination loop detected", "AMO_PAGINATION_LOOP"],
  [
    "amoCRM pagination exceeded safety bound",
    "AMO_PAGINATION_SAFETY_BOUND_EXCEEDED",
  ],
  ["Unexpected amoCRM account", "UNEXPECTED_AMO_ACCOUNT"],
]);

const FAILURE_PHASE = Object.freeze({
  ACCOUNT: "ACCOUNT",
  CONTACTS: "CONTACTS",
  DEAL_AGGREGATION: "DEAL_AGGREGATION",
});

const FAILURE_PHASE_BY_PIPELINE = Object.freeze({
  brokers: "PIPELINE_BROKERS",
  call_center: "PIPELINE_CALL_CENTER",
  sales_a: "PIPELINE_SALES_A",
  sales_b: "PIPELINE_SALES_B",
  sales_c: "PIPELINE_SALES_C",
});

let activeFailurePhase = FAILURE_PHASE.ACCOUNT;

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

const CONTACT_FIELDS = Object.freeze({
  PHONE: 557903,
  IS_BROKER: 835415,
  AGENCY_NAME: 835417,
  TOUR_VISITED: 842303,
  TOUR_DATE: 842305,
});

const LEAD_FIELDS = Object.freeze({
  FROM_BROKER: 665195,
  UTM_SOURCE: 618551,
  COMMENT_TO_REQUEST: 618547,
  MEETING_AT: 839185,
  DDU_AMOUNT: 833065,
  CONTRACT_DATE: 558353,
  CC_ID_PARENT: 839249,
  BROKER_PIPELINE_LINK: 842387,
});

const FROM_BROKER_YES_ENUM_ID = 985337;
const BROKER_SOURCE_TEXT = "Заявка от брокера";

const PIPELINES = Object.freeze({
  brokers: 10787390,
  call_center: 7600542,
  sales_a: 7600546,
  sales_b: 7600550,
  sales_c: 7600554,
});

const CLIENT_PIPELINE_LABELS = Object.freeze([
  "call_center",
  "sales_a",
  "sales_b",
  "sales_c",
]);

const BROKER_STAGE_LABEL_BY_STATUS = new Map([
  [84932446, "new_broker"],
  [84932450, "broker_tour"],
  [84932454, "uniqueness_fixation"],
  [84932514, "meeting"],
  [84932518, "deal"],
  [142, "successful"],
  [143, "closed_lost"],
]);

const MEETING_HELD_OR_LATER_STATUS = Object.freeze({
  call_center: new Set([142]),
  sales_a: new Set([
    62907358, 62907362, 62907366, 62907370, 62907374, 62907378, 62907382,
    62907386, 142,
  ]),
  sales_b: new Set([
    62907430, 62907434, 62907438, 62907442, 62907446, 62907450, 62907454,
    62907458, 142,
  ]),
  sales_c: new Set([
    62907570, 62907574, 62907578, 62907582, 62907586, 62907590, 62907594,
    62907598, 142,
  ]),
});

const SALES_DEAL_OR_LATER_STATUS = Object.freeze({
  sales_a: new Set([62907378, 62907382, 62907386, 142]),
  sales_b: new Set([62907450, 62907454, 62907458, 142]),
  sales_c: new Set([62907590, 62907594, 62907598, 142]),
});

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function customField(entity, fieldId) {
  const fields = Array.isArray(entity?.custom_fields_values)
    ? entity.custom_fields_values
    : [];
  return fields.find((field) => Number(field?.field_id) === fieldId) || null;
}

function customValues(entity, fieldId) {
  const values = customField(entity, fieldId)?.values;
  return Array.isArray(values) ? values : [];
}

function validateScanObservers(value) {
  const noop = () => undefined;
  if (value === undefined) return { onContact: noop, onLead: noop };
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Invalid scan observer callbacks");
    }
    const allowed = new Set(["onContact", "onLead"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw new TypeError("Invalid scan observer callbacks");
    }
    const onContact = value.onContact === undefined ? noop : value.onContact;
    const onLead = value.onLead === undefined ? noop : value.onLead;
    if (typeof onContact !== "function" || typeof onLead !== "function") {
      throw new TypeError("Invalid scan observer callbacks");
    }
    return { onContact, onLead };
  } catch {
    throw new TypeError("Invalid scan observer callbacks");
  }
}

function nonEmptyValue(value) {
  if (value === null || value === undefined) return false;
  return typeof value === "string" ? value.trim().length > 0 : true;
}

function isTruthyCheckbox(entity, fieldId) {
  return customValues(entity, fieldId).some(({ value }) => {
    if (value === true || value === 1) return true;
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  });
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

function phoneValues(contact) {
  const fields = Array.isArray(contact?.custom_fields_values)
    ? contact.custom_fields_values
    : [];
  const field =
    fields.find(
      (candidate) => Number(candidate?.field_id) === CONTACT_FIELDS.PHONE,
    ) || fields.find((candidate) => candidate?.field_code === "PHONE");
  return Array.isArray(field?.values) ? field.values : [];
}

function validDateValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "number" || /^\d{9,13}$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return false;
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    return milliseconds >= 946684800000 && milliseconds <= 4133980800000;
  }
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    year <= 2100 &&
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function normalizedDateKey(value) {
  if (!validDateValue(value)) return null;
  if (typeof value === "number" || /^\d{9,13}$/.test(String(value).trim())) {
    const numeric = Number(value);
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    return new Date(milliseconds).toISOString().slice(0, 10);
  }
  return String(value).trim().slice(0, 10);
}

function fieldCoverage(entity, fieldId, validator = nonEmptyValue) {
  const values = customValues(entity, fieldId)
    .map((item) => item?.value)
    .filter(nonEmptyValue);
  if (values.length === 0) return "missing";
  return values.some(validator) ? "valid" : "invalid";
}

function linkedIds(entity, relationName) {
  const relation = entity?._embedded?.[relationName];
  if (!Array.isArray(relation)) return null;
  const output = [];
  for (const item of relation) {
    const id = positiveInteger(item?.id);
    if (id) output.push(id);
  }
  return [...new Set(output)];
}

function embeddedContactRelations(lead) {
  const relations = lead?._embedded?.contacts;
  if (!Array.isArray(relations)) return null;
  return relations.map((relation) => ({
    id: positiveInteger(relation?.id),
    isMain: relation?.is_main === true,
  }));
}

function hasStrictBrokerSource(lead) {
  const enumMarker = customValues(lead, LEAD_FIELDS.FROM_BROKER).some(
    (item) => Number(item?.enum_id) === FROM_BROKER_YES_ENUM_ID,
  );
  const textMarker = customValues(lead, LEAD_FIELDS.UTM_SOURCE).some(
    (item) => String(item?.value ?? "").trim() === BROKER_SOURCE_TEXT,
  );
  return enumMarker || textMarker;
}

function parseMoneyToCents(value) {
  if (value === null || value === undefined) return null;
  let text = String(value).normalize("NFKC").trim();
  if (!text) return null;
  text = text
    .replace(/(?:₽|руб(?:\.|лей|ля)?|rub)$/iu, "")
    .replace(/[\s\u00a0\u202f]/g, "")
    .trim();
  const match = /^(\d{1,18})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(2, "0"));
  return whole * 100n + fraction;
}

function centsToRubles(cents) {
  const whole = cents / 100n;
  const fraction = String(cents % 100n).padStart(2, "0");
  return `${whole}.${fraction}`;
}

function parseReferenceIds(value) {
  const matches = String(value ?? "").match(/\d{5,18}/g) || [];
  return [...new Set(matches.map(positiveInteger).filter(Boolean))];
}

function referenceIdsFromField(lead, fieldId) {
  return [
    ...new Set(
      customValues(lead, fieldId).flatMap((item) =>
        parseReferenceIds(item?.value),
      ),
    ),
  ];
}

function increment(object, key, amount = 1) {
  object[key] = Number(object[key] || 0) + amount;
}

function newClientPipelineAggregate() {
  return {
    totalCurrentLeads: 0,
    strictSourceMarked: 0,
    brokerLinkedBroadProxy: 0,
    strictSourceAndBrokerLinked: 0,
    strictSourceWithoutBrokerLink: 0,
    brokerLinkedWithoutStrictSource: 0,
    uniqueStrictLinkedBrokers: new Set(),
    uniqueBroadLinkedBrokers: new Set(),
  };
}

function createState() {
  const clientPipelines = Object.fromEntries(
    CLIENT_PIPELINE_LABELS.map((label) => [
      label,
      newClientPipelineAggregate(),
    ]),
  );
  return {
    contacts: {
      totalContacts: 0,
      brokerContacts: 0,
      brokerContactsWithValidPhone: 0,
      brokerContactsWithoutValidPhone: 0,
      validNormalizedPhoneValues: 0,
      uniqueNormalizedPhones: new Set(),
      tourMarkedContacts: 0,
      tourMarkedWithValidDate: 0,
      tourMarkedWithoutValidDate: 0,
      brokerContactsWithAgencyName: 0,
      brokerContactsWithoutAgencyName: 0,
      brokerContactsWithLinkedCompany: 0,
      brokerContactsWithCompanyRelationPayload: 0,
      uniqueLinkedCompanies: new Set(),
    },
    brokerContactIds: new Set(),
    brokerPipeline: {
      totalCurrentLeads: 0,
      currentStage: {
        new_broker: 0,
        broker_tour: 0,
        uniqueness_fixation: 0,
        meeting: 0,
        deal: 0,
        successful: 0,
        closed_lost: 0,
        other_current_stage: 0,
      },
    },
    clientPipelines,
    clientGlobal: newClientPipelineAggregate(),
    meetings: {
      strictLeadPopulation: 0,
      explicitMeetingDate: { valid: 0, missing: 0, invalid: 0 },
      currentMeetingHeldStageProxy: 0,
      currentMeetingHeldStageProxyByPipeline: Object.fromEntries(
        CLIENT_PIPELINE_LABELS.map((label) => [label, 0]),
      ),
    },
    dealCandidates: [],
  };
}

function ingestContact(state, contact) {
  const contactId = positiveInteger(contact?.id);
  if (!contactId) throw new Error("Invalid contact record");
  state.contacts.totalContacts += 1;
  if (!isTruthyCheckbox(contact, CONTACT_FIELDS.IS_BROKER)) return;

  state.contacts.brokerContacts += 1;
  state.brokerContactIds.add(contactId);

  const normalizedForContact = new Set(
    phoneValues(contact)
      .map((item) => normalizePhone(item?.value))
      .filter(Boolean),
  );
  if (normalizedForContact.size > 0) {
    state.contacts.brokerContactsWithValidPhone += 1;
    state.contacts.validNormalizedPhoneValues += normalizedForContact.size;
    for (const phone of normalizedForContact) {
      state.contacts.uniqueNormalizedPhones.add(phone);
    }
  } else {
    state.contacts.brokerContactsWithoutValidPhone += 1;
  }

  if (isTruthyCheckbox(contact, CONTACT_FIELDS.TOUR_VISITED)) {
    state.contacts.tourMarkedContacts += 1;
    if (
      fieldCoverage(contact, CONTACT_FIELDS.TOUR_DATE, validDateValue) ===
      "valid"
    ) {
      state.contacts.tourMarkedWithValidDate += 1;
    } else {
      state.contacts.tourMarkedWithoutValidDate += 1;
    }
  }

  const agencyNamePresent = customValues(
    contact,
    CONTACT_FIELDS.AGENCY_NAME,
  ).some((item) => nonEmptyValue(item?.value));
  increment(
    state.contacts,
    agencyNamePresent
      ? "brokerContactsWithAgencyName"
      : "brokerContactsWithoutAgencyName",
  );

  const companyIds = linkedIds(contact, "companies");
  if (companyIds !== null) {
    state.contacts.brokerContactsWithCompanyRelationPayload += 1;
    if (companyIds.length > 0) {
      state.contacts.brokerContactsWithLinkedCompany += 1;
      for (const companyId of companyIds) {
        state.contacts.uniqueLinkedCompanies.add(companyId);
      }
    }
  }
}

function updateClientAggregate(aggregate, strict, linkedBrokerIds) {
  const linked = linkedBrokerIds.length > 0;
  aggregate.totalCurrentLeads += 1;
  if (strict) aggregate.strictSourceMarked += 1;
  if (linked) aggregate.brokerLinkedBroadProxy += 1;
  if (strict && linked) aggregate.strictSourceAndBrokerLinked += 1;
  if (strict && !linked) aggregate.strictSourceWithoutBrokerLink += 1;
  if (!strict && linked) aggregate.brokerLinkedWithoutStrictSource += 1;
  if (linked) {
    for (const brokerId of linkedBrokerIds) {
      aggregate.uniqueBroadLinkedBrokers.add(brokerId);
      if (strict) aggregate.uniqueStrictLinkedBrokers.add(brokerId);
    }
  }
}

function ingestLead(state, pipelineLabel, lead) {
  const leadId = positiveInteger(lead?.id);
  if (!leadId) throw new Error("Invalid lead record");
  const expectedPipelineId = PIPELINES[pipelineLabel];
  if (Number(lead?.pipeline_id) !== expectedPipelineId) {
    throw new Error("Lead escaped requested pipeline");
  }
  const statusId = positiveInteger(lead?.status_id);
  if (!statusId) throw new Error("Lead has invalid status");

  if (pipelineLabel === "brokers") {
    state.brokerPipeline.totalCurrentLeads += 1;
    increment(
      state.brokerPipeline.currentStage,
      BROKER_STAGE_LABEL_BY_STATUS.get(statusId) || "other_current_stage",
    );
    return;
  }

  const contactRelations = embeddedContactRelations(lead);
  if (contactRelations === null) {
    throw new Error("Lead contact relations were not embedded");
  }
  const relationContactIds = [
    ...new Set(contactRelations.map((relation) => relation.id).filter(Boolean)),
  ];
  const linkedBrokerIds = relationContactIds.filter((contactId) =>
    state.brokerContactIds.has(contactId),
  );
  const strict = hasStrictBrokerSource(lead);
  updateClientAggregate(
    state.clientPipelines[pipelineLabel],
    strict,
    linkedBrokerIds,
  );
  updateClientAggregate(state.clientGlobal, strict, linkedBrokerIds);

  if (strict && linkedBrokerIds.length > 0) {
    state.meetings.strictLeadPopulation += 1;
    increment(
      state.meetings.explicitMeetingDate,
      fieldCoverage(lead, LEAD_FIELDS.MEETING_AT, validDateValue),
    );
    if (MEETING_HELD_OR_LATER_STATUS[pipelineLabel].has(statusId)) {
      state.meetings.currentMeetingHeldStageProxy += 1;
      state.meetings.currentMeetingHeldStageProxyByPipeline[pipelineLabel] += 1;
    }

    if (SALES_DEAL_OR_LATER_STATUS[pipelineLabel]?.has(statusId)) {
      const nonBrokerContactRelations = contactRelations.filter(
        (relation) => relation.id && !state.brokerContactIds.has(relation.id),
      );
      const explicitMainContactIds = nonBrokerContactRelations
        .filter((relation) => relation.isMain)
        .map((relation) => relation.id);
      const dedupClientContactIds =
        explicitMainContactIds.length > 0
          ? explicitMainContactIds
          : nonBrokerContactRelations.length === 1
            ? [nonBrokerContactRelations[0].id]
            : [];
      state.dealCandidates.push({
        id: leadId,
        parentReferenceIds: referenceIdsFromField(
          lead,
          LEAD_FIELDS.CC_ID_PARENT,
        ),
        brokerCopyReferenceIds: referenceIdsFromField(
          lead,
          LEAD_FIELDS.BROKER_PIPELINE_LINK,
        ),
        dduAmountValues: customValues(lead, LEAD_FIELDS.DDU_AMOUNT).map(
          (item) => item?.value,
        ),
        contractDateValues: customValues(lead, LEAD_FIELDS.CONTRACT_DATE).map(
          (item) => item?.value,
        ),
        dedupClientContactIds,
      });
    }
  }
}

class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index) {
    let current = index;
    while (this.parent[current] !== current) {
      this.parent[current] = this.parent[this.parent[current]];
      current = this.parent[current];
    }
    return current;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
  }
}

function singleValidAmountKey(values) {
  const valid = new Set(
    (values || [])
      .map(parseMoneyToCents)
      .filter((value) => value !== null)
      .map(String),
  );
  return valid.size === 1 ? [...valid][0] : null;
}

function singleValidDateKey(values) {
  const valid = new Set((values || []).map(normalizedDateKey).filter(Boolean));
  return valid.size === 1 ? [...valid][0] : null;
}

function corroboratedClientDealTokens(candidate, clientContactIds) {
  const amountKey = singleValidAmountKey(candidate.dduAmountValues);
  const dateKey = singleValidDateKey(candidate.contractDateValues);
  if (!amountKey || !dateKey) return [];
  return [...new Set(clientContactIds)].map(
    (contactId) => `client-deal:${contactId}:${amountKey}:${dateKey}`,
  );
}

function groupCoverage(group, valuesKey, validator) {
  let sawNonEmpty = false;
  for (const candidate of group) {
    const values = (candidate[valuesKey] || []).filter(nonEmptyValue);
    if (values.length > 0) sawNonEmpty = true;
    if (values.some(validator)) return "valid";
  }
  return sawNonEmpty ? "invalid" : "missing";
}

function valuesCoverage(values, validator) {
  const nonEmpty = (values || []).filter(nonEmptyValue);
  if (nonEmpty.length === 0) return "missing";
  return nonEmpty.some(validator) ? "valid" : "invalid";
}

function groupAmount(group) {
  const valid = new Set();
  let sawNonEmpty = false;
  for (const candidate of group) {
    for (const value of candidate.dduAmountValues || []) {
      if (!nonEmptyValue(value)) continue;
      sawNonEmpty = true;
      const cents = parseMoneyToCents(value);
      if (cents !== null) valid.add(String(cents));
    }
  }
  if (valid.size === 0) {
    return { classification: sawNonEmpty ? "invalid" : "missing", cents: null };
  }
  if (valid.size > 1) return { classification: "conflicting", cents: null };
  return { classification: "valid", cents: BigInt([...valid][0]) };
}

async function buildDealReport(dealCandidates) {
  const disjoint = new DisjointSet(dealCandidates.length);
  const tokenOwner = new Map();
  const relationRowsScanned = 0;
  let candidatesWithEmbeddedClientContactRelation = 0;
  const candidatesWithFetchedDedupEntityRelation = 0;
  let candidatesWithCorroboratedClientDealKey = 0;
  let candidatesWithUncorroboratedClientRelationOnly = 0;
  let candidatesWithParentReference = 0;
  let candidatesWithBrokerCopyReference = 0;

  for (let index = 0; index < dealCandidates.length; index += 1) {
    const candidate = dealCandidates[index];
    if ((candidate.dedupClientContactIds || []).length > 0) {
      candidatesWithEmbeddedClientContactRelation += 1;
    }
    const parentIds = candidate.parentReferenceIds || [];
    const brokerCopyIds = candidate.brokerCopyReferenceIds || [];
    if (parentIds.length > 0) candidatesWithParentReference += 1;
    if (brokerCopyIds.length > 0) candidatesWithBrokerCopyReference += 1;

    const allClientContactIds = [
      ...new Set(candidate.dedupClientContactIds || []),
    ];
    const clientDealTokens = corroboratedClientDealTokens(
      candidate,
      allClientContactIds,
    );
    if (clientDealTokens.length > 0) {
      candidatesWithCorroboratedClientDealKey += 1;
    } else if (allClientContactIds.length > 0) {
      candidatesWithUncorroboratedClientRelationOnly += 1;
    }

    const tokens = [
      `lead:${candidate.id}`,
      ...parentIds.map((id) => `lead:${id}`),
      ...brokerCopyIds.map((id) => `lead:${id}`),
      ...clientDealTokens,
    ];
    for (const token of new Set(tokens)) {
      const previous = tokenOwner.get(token);
      if (previous === undefined) tokenOwner.set(token, index);
      else disjoint.union(index, previous);
    }
  }

  const groups = new Map();
  for (let index = 0; index < dealCandidates.length; index += 1) {
    const root = disjoint.find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(dealCandidates[index]);
  }

  const amountCoverage = { valid: 0, missing: 0, invalid: 0, conflicting: 0 };
  const contractDateCoverage = { valid: 0, missing: 0, invalid: 0 };
  const rawAmountCoverage = { valid: 0, missing: 0, invalid: 0 };
  const rawContractDateCoverage = { valid: 0, missing: 0, invalid: 0 };
  for (const candidate of dealCandidates) {
    increment(
      rawAmountCoverage,
      valuesCoverage(
        candidate.dduAmountValues,
        (value) => parseMoneyToCents(value) !== null,
      ),
    );
    increment(
      rawContractDateCoverage,
      valuesCoverage(candidate.contractDateValues, validDateValue),
    );
  }
  let unambiguousDduAmountSumCents = 0n;
  const yearBuckets = Object.create(null);
  const from2026 = {
    groups: 0,
    withValidDduAmount: 0,
    sumCents: 0n,
  };
  for (const group of groups.values()) {
    const amount = groupAmount(group);
    increment(amountCoverage, amount.classification);
    if (amount.cents !== null) unambiguousDduAmountSumCents += amount.cents;
    increment(
      contractDateCoverage,
      groupCoverage(group, "contractDateValues", validDateValue),
    );
    const dateKey = singleValidDateKey(
      group.flatMap((candidate) => candidate.contractDateValues || []),
    );
    const year = dateKey ? dateKey.slice(0, 4) : "unknown";
    if (!yearBuckets[year]) {
      yearBuckets[year] = { groups: 0, withValidDduAmount: 0, sumCents: 0n };
    }
    yearBuckets[year].groups += 1;
    if (amount.cents !== null) {
      yearBuckets[year].withValidDduAmount += 1;
      yearBuckets[year].sumCents += amount.cents;
    }
    if (dateKey && dateKey >= "2026-01-01") {
      from2026.groups += 1;
      if (amount.cents !== null) {
        from2026.withValidDduAmount += 1;
        from2026.sumCents += amount.cents;
      }
    }
  }

  const contractDateByYear = {};
  for (const year of Object.keys(yearBuckets).sort()) {
    const bucket = yearBuckets[year];
    contractDateByYear[year] = {
      groups: bucket.groups,
      withValidDduAmount: bucket.withValidDduAmount,
      unambiguousSumRub: centsToRubles(bucket.sumCents),
    };
  }

  return {
    scope:
      "current sales-pipeline leads in deal-or-later statuses, strict source marker and broker link required",
    rawQualifyingLeadRows: dealCandidates.length,
    deduplicatedDealGroups: groups.size,
    duplicateLeadRowsCollapsed: dealCandidates.length - groups.size,
    dedupEvidenceCoverage: {
      candidatesWithParentReference,
      candidatesWithBrokerCopyReference,
      candidatesWithEmbeddedClientContactRelation,
      candidatesWithFetchedDedupEntityRelation,
      candidatesWithCorroboratedClientDealKey,
      candidatesWithUncorroboratedClientRelationOnly,
      entityRelationRowsScanned: relationRowsScanned,
    },
    dedupMethod: {
      explicitReferences: ["parent_reference", "broker_copy_reference"],
      entityRelation:
        "embedded main non-broker contact only when DDU amount and contract date also match",
      uncorroboratedSharedContactMerged: false,
    },
    dduAmount: {
      fieldOnly: "ddu_amount",
      rawQualifyingLeadCoverage: rawAmountCoverage,
      coverageByDeduplicatedGroup: amountCoverage,
      summedUnambiguousGroups: amountCoverage.valid,
      unambiguousSumRub: centsToRubles(unambiguousDduAmountSumCents),
      conflictingGroupsExcludedFromSum: amountCoverage.conflicting,
    },
    contractDate: {
      rawQualifyingLeadCoverage: rawContractDateCoverage,
      coverageByDeduplicatedGroup: contractDateCoverage,
    },
    contractDateByYear,
    from2026: {
      contractDateOnOrAfter: "2026-01-01",
      groups: from2026.groups,
      withValidDduAmount: from2026.withValidDduAmount,
      unambiguousSumRub: centsToRubles(from2026.sumCents),
    },
  };
}

function publicClientAggregate(aggregate) {
  return {
    totalCurrentLeads: aggregate.totalCurrentLeads,
    strictSourceMarked: aggregate.strictSourceMarked,
    brokerLinkedBroadProxy: aggregate.brokerLinkedBroadProxy,
    strictSourceAndBrokerLinked: aggregate.strictSourceAndBrokerLinked,
    strictSourceWithoutBrokerLink: aggregate.strictSourceWithoutBrokerLink,
    brokerLinkedWithoutStrictSource: aggregate.brokerLinkedWithoutStrictSource,
    uniqueStrictLinkedBrokers: aggregate.uniqueStrictLinkedBrokers.size,
    uniqueBroadLinkedBrokers: aggregate.uniqueBroadLinkedBrokers.size,
  };
}

async function finalizeReport(state, generatedAt) {
  const companyPayloadComplete =
    state.contacts.brokerContactsWithCompanyRelationPayload ===
    state.contacts.brokerContacts;
  const deals = await buildDealReport(state.dealCandidates);
  return {
    report: "live_amocrm_source_aggregate",
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    safety: {
      source: "live_amocrm_api",
      accountIdentityVerified: true,
      httpMethods: ["GET"],
      brokerPlatformDatabaseUsed: false,
      nestApplicationBootstrapped: false,
      rawResponsesEmitted: false,
      rawEntityIdentifiersEmitted: false,
      namesPhonesEmailsOrUrlsEmitted: false,
      perRecordRowsEmitted: false,
      completeScanRequired: true,
    },
    interpretation: {
      snapshot: "current_state_at_scan_time",
      historicalStageTransitionsMeasured: false,
      importedAnnaAggregatesUsed: false,
      platformImportAggregatesUsed: false,
    },
    contacts: {
      total: state.contacts.totalContacts,
      brokersMarked: state.contacts.brokerContacts,
      phoneCoverage: {
        brokersWithAtLeastOneValidNormalizedPhone:
          state.contacts.brokerContactsWithValidPhone,
        brokersWithoutValidNormalizedPhone:
          state.contacts.brokerContactsWithoutValidPhone,
        validNormalizedPhoneValues: state.contacts.validNormalizedPhoneValues,
        uniqueNormalizedPhones: state.contacts.uniqueNormalizedPhones.size,
      },
      brokerTour: {
        markedVisited: state.contacts.tourMarkedContacts,
        markedVisitedWithValidDate: state.contacts.tourMarkedWithValidDate,
        markedVisitedWithoutValidDate:
          state.contacts.tourMarkedWithoutValidDate,
      },
      agencyNameCoverage: {
        present: state.contacts.brokerContactsWithAgencyName,
        missing: state.contacts.brokerContactsWithoutAgencyName,
      },
      linkedCompanies: {
        embeddedRelationPayloadComplete: companyPayloadComplete,
        brokersWithRelationPayload:
          state.contacts.brokerContactsWithCompanyRelationPayload,
        brokersWithLinkedCompany:
          state.contacts.brokerContactsWithLinkedCompany,
        uniqueLinkedCompanies: companyPayloadComplete
          ? state.contacts.uniqueLinkedCompanies.size
          : null,
        observedUniqueLinkedCompanies:
          state.contacts.uniqueLinkedCompanies.size,
      },
    },
    brokerPipeline: {
      semantics: "current stage snapshot, not historical totals",
      totalCurrentLeads: state.brokerPipeline.totalCurrentLeads,
      currentStage: state.brokerPipeline.currentStage,
    },
    clientPipelines: {
      markerDefinition: "strict enum-or-exact-source marker",
      brokerLinkDefinition:
        "embedded contact marked as broker in the same live scan",
      all: publicClientAggregate(state.clientGlobal),
      byPipeline: Object.fromEntries(
        CLIENT_PIPELINE_LABELS.map((label) => [
          label,
          publicClientAggregate(state.clientPipelines[label]),
        ]),
      ),
    },
    meetings: {
      population: "strict source marker and broker-linked client leads",
      qualifyingCurrentLeadRows: state.meetings.strictLeadPopulation,
      explicitMeetingDateCoverage: state.meetings.explicitMeetingDate,
      currentMeetingHeldStageProxy: {
        semantics:
          "current meeting-held-or-later stage; not a historical meeting count",
        total: state.meetings.currentMeetingHeldStageProxy,
        byPipeline: state.meetings.currentMeetingHeldStageProxyByPipeline,
      },
    },
    deals,
    calls: {
      measured: false,
      status: "unavailable",
      reason: "no_call_activity_source_scanned",
    },
  };
}

function canonicalAmoUrl(pathname, query = {}) {
  if (typeof pathname !== "string" || !pathname.startsWith("/api/v4/")) {
    throw new Error("Unsafe amoCRM path");
  }
  const url = new URL(pathname, AMO_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.append(key, String(value));
  }
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

function isJsonRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (typeof value !== "string") {
    throw new Error("Malformed amoCRM response");
  }
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
  const normalizedLength = rawLength.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalizedLength)) {
    throw new Error("amoCRM response content length is invalid");
  }
  const declaredBytes = Number(normalizedLength);
  if (!Number.isSafeInteger(declaredBytes)) {
    throw new Error("amoCRM response content length is invalid");
  }
  if (declaredBytes > MAX_RESPONSE_BODY_BYTES) {
    throw new Error("amoCRM response body exceeded safety bound");
  }
  const contentEncoding = responseHeader(response, "content-encoding");
  return {
    declaredBytes,
    // Fetch implementations may expose a compressed Content-Length while
    // yielding decoded bytes. The actual decoded stream is always capped; an
    // exact length comparison is safe only for identity/no encoding.
    verifyExact:
      contentEncoding === null ||
      contentEncoding.trim().toLowerCase() === "identity",
  };
}

function abortResponseBody(body, reader, controller) {
  try {
    controller.abort();
  } catch {
    // The fixed failure emitted by the caller remains authoritative.
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
    // Cancellation is best effort after the request has already been aborted.
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
  const textChunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch {
        abortResponseBody(body, reader, controller);
        throw new Error("amoCRM response body read failed");
      }
      let done;
      let value;
      try {
        if (!isJsonRecord(result) || typeof result.done !== "boolean") {
          throw new Error("amoCRM response body read failed");
        }
        done = result.done;
        value = result.value;
      } catch {
        abortResponseBody(body, reader, controller);
        throw new Error("amoCRM response body read failed");
      }
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        abortResponseBody(body, reader, controller);
        throw new Error("amoCRM response body read failed");
      }
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BODY_BYTES) {
        abortResponseBody(body, reader, controller);
        throw new Error("amoCRM response body exceeded safety bound");
      }
      try {
        textChunks.push(decoder.decode(value, { stream: true }));
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
      textChunks.push(decoder.decode());
    } catch {
      throw new Error("amoCRM returned invalid JSON");
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Releasing a completed/aborted reader is best effort.
    }
  }

  let payload;
  try {
    payload = JSON.parse(textChunks.join(""));
  } catch {
    throw new Error("amoCRM returned invalid JSON");
  }
  if (!isJsonRecord(payload)) {
    throw new Error("Malformed amoCRM response");
  }
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
      const waitForRateLimit =
        lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now();
      if (waitForRateLimit > 0) await sleep(waitForRateLimit);
      lastRequestStartedAt = Date.now();
      const controller = new AbortController();
      let requestTimedOut = false;
      const timeout = setTimeout(() => {
        requestTimedOut = true;
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
        if (attempt === REQUEST_ATTEMPTS)
          throw new Error("amoCRM request failed");
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      if (response.status === 204) {
        clearTimeout(timeout);
        return null;
      }
      if (response.status === 429 || response.status >= 500) {
        clearTimeout(timeout);
        abortResponseBody(responseBody(response), null, controller);
        if (attempt === REQUEST_ATTEMPTS)
          throw new Error("amoCRM request failed");
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) {
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
        if (requestTimedOut && attempt < REQUEST_ATTEMPTS) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }
        if (requestTimedOut) throw new Error("amoCRM request failed");
        throw error;
      }
    }
    throw new Error("amoCRM request failed");
  };
}

async function paginate({
  request,
  pathname,
  baseQuery,
  collection,
  maxPages,
  itemKey,
  onItem,
}) {
  const seen = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await request(pathname, {
      ...baseQuery,
      limit: PAGE_LIMIT,
      page,
    });
    if (payload === null) return;
    const items = payload?._embedded?.[collection];
    if (!Array.isArray(items)) throw new Error("Malformed amoCRM page");
    if (items.length > PAGE_LIMIT) {
      throw new Error("amoCRM page exceeded item safety bound");
    }
    const links = payload?._links;
    if (links !== undefined && !isJsonRecord(links)) {
      throw new Error("Malformed amoCRM page");
    }
    const next = links?.next;
    if (next !== undefined && next !== null && !isJsonRecord(next)) {
      throw new Error("Malformed amoCRM page");
    }
    for (const item of items) {
      const key = itemKey(item);
      if (!key || seen.has(key))
        throw new Error("amoCRM pagination loop detected");
      seen.add(key);
      await onItem(item);
    }
    const hasNext = next !== undefined && next !== null;
    if (!hasNext) return;
    if (items.length === 0) throw new Error("amoCRM pagination loop detected");
  }
  throw new Error("amoCRM pagination exceeded safety bound");
}

async function scanLiveAmo(
  request,
  onPhase = () => undefined,
  scanObservers = undefined,
) {
  const observers = validateScanObservers(scanObservers);
  onPhase(FAILURE_PHASE.ACCOUNT);
  const account = await request("/api/v4/account");
  if (positiveInteger(account?.id) !== EXPECTED_ACCOUNT_ID) {
    throw new Error("Unexpected amoCRM account");
  }

  const state = createState();
  onPhase(FAILURE_PHASE.CONTACTS);
  await paginate({
    request,
    pathname: "/api/v4/contacts",
    // Linked companies are embedded by default for contacts. Do not request
    // unsupported/unused expansions or collect linked lead payloads here.
    baseQuery: {},
    collection: "contacts",
    maxPages: MAX_CONTACT_PAGES,
    itemKey: (contact) => positiveInteger(contact?.id),
    onItem: async (contact) => {
      ingestContact(state, contact);
      await observers.onContact(contact);
    },
  });

  for (const [pipelineLabel, pipelineId] of Object.entries(PIPELINES)) {
    onPhase(FAILURE_PHASE_BY_PIPELINE[pipelineLabel]);
    await paginate({
      request,
      pathname: "/api/v4/leads",
      baseQuery: {
        "filter[pipeline_id][]": pipelineId,
        with: "contacts",
      },
      collection: "leads",
      maxPages: MAX_PIPELINE_PAGES,
      itemKey: (lead) => positiveInteger(lead?.id),
      onItem: async (lead) => {
        ingestLead(state, pipelineLabel, lead);
        await observers.onLead(pipelineLabel, lead);
      },
    });
  }

  // `with=contacts` is the documented complete source for each lead's linked
  // contact IDs and main-contact flag. The entity-specific /links endpoint
  // cannot link a lead to another lead, so it adds no dedup evidence here.
  onPhase(FAILURE_PHASE.DEAL_AGGREGATION);
  return finalizeReport(state, new Date());
}

async function main() {
  activeFailurePhase = FAILURE_PHASE.ACCOUNT;
  const request = createGetOnlyRequester(process.env.AMO_ACCESS_TOKEN);
  const report = await scanLiveAmo(request, (phase) => {
    activeFailurePhase = phase;
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

module.exports = {
  AMO_ORIGIN,
  CLIENT_PIPELINE_LABELS,
  CONTACT_FIELDS,
  EXPECTED_ACCOUNT_ID,
  LEAD_FIELDS,
  MAX_RESPONSE_BODY_BYTES,
  MEETING_HELD_OR_LATER_STATUS,
  PIPELINES,
  SALES_DEAL_OR_LATER_STATUS,
  buildDealReport,
  canonicalAmoUrl,
  classifyFailure,
  createGetOnlyRequester,
  createState,
  customValues,
  embeddedContactRelations,
  fieldCoverage,
  finalizeReport,
  hasStrictBrokerSource,
  ingestContact,
  ingestLead,
  isTruthyCheckbox,
  normalizePhone,
  normalizedDateKey,
  paginate,
  parseMoneyToCents,
  parseReferenceIds,
  positiveInteger,
  readBoundedJsonResponse,
  scanLiveAmo,
  validateScanObservers,
  validDateValue,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `failure_phase=${activeFailurePhase}\nfailure_code=${classifyFailure(error)}\n`,
    );
    process.exitCode = 1;
  });
}
