#!/usr/bin/env node
/**
 * PII-safe, strictly read-only repair-plan inspector for exhausted amoCRM
 * fixation rows whose effective broker may be missing Broker.amoContactId.
 *
 * Raw client/broker/contact identifiers and broker phones are held only in
 * memory. PostgreSQL is forced into read-only mode; amoCRM is accessed through
 * a standalone GET-only client. The emitted plan is advisory and contains only
 * bounded classes, counts and per-run HMAC aliases. It can never be used as an
 * apply payload and never authorizes retrying a lead creation.
 */

"use strict";

const { createHmac, randomBytes } = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");

const AMO_ORIGIN = "https://stmichael.amocrm.ru";
const EXPECTED_ACCOUNT_ID = 28552900;
const ATTEMPT_LIMIT = 10;
const STATEMENT_TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 250;
const MAX_LOOKUP_PAGES = 50;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_ATTEMPTS = 4;
const MIN_REQUEST_INTERVAL_MS = 180;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const HASH_DOMAIN = "st-michael:amo-broker-link-repair-plan:v1";
const COHORT_ATTESTATION_DOMAIN =
  "st-michael:amo-broker-contact-provisioning-cohort-attestation:v1";
const QUEUE_STATUSES = ["FAILED", "PENDING"];

const CONTACT_FIELDS = Object.freeze({
  PHONE: 557903,
  IS_BROKER: 835415,
});

// Keep global ownership reads deliberately narrow: unrelated broker profile
// edits must not invalidate the account-wide phone/contact ownership proof.
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

// This must stay structurally identical to BROKER_PROVISION_SELECT in the
// apply script. These are the source fields from which POST/PATCH payloads and
// their primary-agency values are built, so the reviewed HMAC binds all of
// them rather than only ownership fields.
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

const QUEUE_BASE_SELECT = Object.freeze({
  id: true,
  brokerId: true,
  responsibleBrokerId: true,
  amoLeadId: true,
  fixationAgencyId: true,
  amoSyncStatus: true,
  amoSyncAttempts: true,
  amoSyncError: true,
});

const OWNERSHIP_QUEUE_ROW_SELECT = Object.freeze({
  ...QUEUE_BASE_SELECT,
  broker: { select: BROKER_OWNER_SELECT },
  responsibleBroker: { select: BROKER_OWNER_SELECT },
});

const PROVISIONING_QUEUE_ROW_SELECT = Object.freeze({
  ...QUEUE_BASE_SELECT,
  broker: { select: BROKER_PROVISION_SELECT },
  responsibleBroker: { select: BROKER_PROVISION_SELECT },
});

const RESOLUTION_CLASSES = [
  "link_candidate",
  "already_linked",
  "effective_broker_missing",
  "broker_merged",
  "no_valid_phone",
  "db_phone_ambiguous",
  "no_exact_broker_contact",
  "ambiguous_amo_match",
  "candidate_already_bound",
];

const PROVISIONING_RESOLUTION_CLASSES = [
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
];

const ERROR_CLASSES = [
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
];

const FAILURE_PHASE = Object.freeze({
  DATABASE: "DATABASE",
  ACCOUNT: "ACCOUNT",
  CONTACT_LOOKUP: "CONTACT_LOOKUP",
  ATTESTATION: "ATTESTATION",
  REPORT: "REPORT",
});

const FAILURE_CODE_BY_MESSAGE = new Map([
  ["DATABASE_URL is missing", "DATABASE_URL_MISSING"],
  ["DATABASE_URL is invalid", "DATABASE_URL_INVALID"],
  ["DATABASE_URL must use PostgreSQL", "DATABASE_URL_NOT_POSTGRESQL"],
  ["Database session is not read-only", "DATABASE_SESSION_NOT_READ_ONLY"],
  ["amoCRM access token is missing", "AMO_ACCESS_TOKEN_MISSING"],
  ["fetch is unavailable", "FETCH_UNAVAILABLE"],
  ["Unsafe amoCRM path", "UNSAFE_AMO_PATH"],
  ["Unsafe amoCRM query", "UNSAFE_AMO_QUERY"],
  ["Unsafe amoCRM URL", "UNSAFE_AMO_URL"],
  ["amoCRM request failed", "AMO_REQUEST_FAILED"],
  ["amoCRM request rejected", "AMO_REQUEST_REJECTED"],
  ["amoCRM response size is invalid", "AMO_RESPONSE_SIZE_INVALID"],
  ["amoCRM response exceeded size limit", "AMO_RESPONSE_SIZE_LIMIT_EXCEEDED"],
  ["amoCRM returned invalid JSON", "AMO_INVALID_JSON"],
  ["Unexpected amoCRM account", "UNEXPECTED_AMO_ACCOUNT"],
  ["Malformed amoCRM contacts page", "MALFORMED_AMO_CONTACTS_PAGE"],
  ["Invalid amoCRM contact record", "INVALID_AMO_CONTACT_RECORD"],
  ["amoCRM contacts pagination loop detected", "AMO_CONTACTS_PAGINATION_LOOP"],
  [
    "amoCRM contacts pagination exceeded safety bound",
    "AMO_CONTACTS_PAGINATION_SAFETY_BOUND_EXCEEDED",
  ],
  ["Report hash key is invalid", "REPORT_HASH_KEY_INVALID"],
  ["Cohort attestation key is invalid", "COHORT_ATTESTATION_KEY_INVALID"],
  [
    "Cohort attestation key file is invalid",
    "COHORT_ATTESTATION_KEY_FILE_INVALID",
  ],
  ["Inspector source SHA is invalid", "INSPECTOR_SOURCE_SHA_INVALID"],
  ["Deployed Git SHA is invalid", "DEPLOYED_GIT_SHA_INVALID"],
  ["Inspector mode is invalid", "INSPECTOR_MODE_INVALID"],
]);

let activeFailurePhase = FAILURE_PHASE.DATABASE;

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

function customValues(entity, fieldId) {
  const fields = Array.isArray(entity?.custom_fields_values)
    ? entity.custom_fields_values
    : [];
  const field = fields.find(
    (candidate) => Number(candidate?.field_id) === fieldId,
  );
  return Array.isArray(field?.values) ? field.values : [];
}

function contactPhoneValues(contact) {
  const fields = Array.isArray(contact?.custom_fields_values)
    ? contact.custom_fields_values
    : [];
  const field =
    fields.find(
      (candidate) => Number(candidate?.field_id) === CONTACT_FIELDS.PHONE,
    ) || fields.find((candidate) => candidate?.field_code === "PHONE");
  return Array.isArray(field?.values) ? field.values : [];
}

function isBrokerContact(contact) {
  return customValues(contact, CONTACT_FIELDS.IS_BROKER).some(({ value }) => {
    if (value === true || value === 1) return true;
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  });
}

function canonicalAmoUrl(pathname, query = {}) {
  const allowedPath =
    pathname === "/api/v4/account" || pathname === "/api/v4/contacts";
  if (!allowedPath) throw new Error("Unsafe amoCRM path");
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new Error("Unsafe amoCRM query");
  }
  const keys = Object.keys(query).sort();
  if (pathname === "/api/v4/account") {
    if (keys.length !== 0) throw new Error("Unsafe amoCRM query");
  } else if (
    keys.join(",") !== "limit,page,query" ||
    typeof query.query !== "string" ||
    !/^\d{10}$/.test(query.query) ||
    query.limit !== PAGE_LIMIT ||
    !Number.isInteger(query.page) ||
    query.page < 1 ||
    query.page > MAX_LOOKUP_PAGES
  ) {
    throw new Error("Unsafe amoCRM query");
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

async function readJsonBounded(
  response,
  maxBytes = MAX_RESPONSE_BYTES,
  controller = null,
) {
  const rawContentLength = response?.headers?.get?.("content-length");
  if (rawContentLength !== null && rawContentLength !== undefined) {
    if (!/^\d+$/.test(String(rawContentLength))) {
      throw new Error("amoCRM response size is invalid");
    }
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error("amoCRM response size is invalid");
    }
    if (contentLength > maxBytes) {
      controller?.abort?.();
      throw new Error("amoCRM response exceeded size limit");
    }
  }

  const chunks = [];
  let bytesRead = 0;
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value || []);
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        controller?.abort?.();
        try {
          await reader.cancel();
        } catch {}
        throw new Error("amoCRM response exceeded size limit");
      }
      chunks.push(chunk);
    }
  } else if (typeof response?.arrayBuffer === "function") {
    const chunk = Buffer.from(await response.arrayBuffer());
    bytesRead = chunk.length;
    if (bytesRead > maxBytes) {
      controller?.abort?.();
      throw new Error("amoCRM response exceeded size limit");
    }
    chunks.push(chunk);
  } else if (typeof response?.text === "function") {
    const chunk = Buffer.from(await response.text(), "utf8");
    bytesRead = chunk.length;
    if (bytesRead > maxBytes) {
      controller?.abort?.();
      throw new Error("amoCRM response exceeded size limit");
    }
    chunks.push(chunk);
  } else {
    throw new Error("amoCRM returned invalid JSON");
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, bytesRead),
    );
    return JSON.parse(text);
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "amoCRM response size is invalid",
        "amoCRM response exceeded size limit",
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error("amoCRM returned invalid JSON");
  }
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
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
      if (response.status === 204) {
        clearTimeout(timeout);
        return null;
      }
      if (response.status === 429 || response.status >= 500) {
        clearTimeout(timeout);
        if (attempt === REQUEST_ATTEMPTS) {
          throw new Error("amoCRM request failed");
        }
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) {
        clearTimeout(timeout);
        throw new Error("amoCRM request rejected");
      }
      try {
        const payload = await readJsonBounded(
          response,
          MAX_RESPONSE_BYTES,
          controller,
        );
        clearTimeout(timeout);
        return payload;
      } catch (error) {
        const timedOut = controller.signal.aborted;
        clearTimeout(timeout);
        if (
          error instanceof Error &&
          [
            "amoCRM response size is invalid",
            "amoCRM response exceeded size limit",
          ].includes(error.message)
        ) {
          throw error;
        }
        if (
          error instanceof Error &&
          error.message === "amoCRM returned invalid JSON" &&
          !timedOut
        ) {
          throw error;
        }
        if (timedOut && attempt < REQUEST_ATTEMPTS) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error("amoCRM returned invalid JSON");
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

async function lookupExactContacts(
  request,
  normalizedPhone,
  maxPages = MAX_LOOKUP_PAGES,
) {
  const target = normalizePhone(normalizedPhone);
  if (!target) {
    return { contacts: [], pagesRead: 0, contactsRead: 0 };
  }
  const query = target.slice(-10);
  const seenIds = new Set();
  const matches = new Map();
  let contactsRead = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await request("/api/v4/contacts", {
      query,
      limit: PAGE_LIMIT,
      page,
    });
    if (payload === null) {
      return {
        contacts: [...matches.values()].sort(
          (left, right) => left.contactId - right.contactId,
        ),
        pagesRead: page - 1,
        contactsRead,
      };
    }
    const contacts = payload?._embedded?.contacts;
    if (!Array.isArray(contacts)) {
      throw new Error("Malformed amoCRM contacts page");
    }
    for (const contact of contacts) {
      const contactId = positiveInteger(contact?.id);
      if (!contactId) throw new Error("Invalid amoCRM contact record");
      if (seenIds.has(contactId)) {
        throw new Error("amoCRM contacts pagination loop detected");
      }
      seenIds.add(contactId);
      contactsRead += 1;
      const exactPhone = contactPhoneValues(contact).some(
        (item) => normalizePhone(item?.value) === target,
      );
      if (exactPhone) {
        matches.set(contactId, {
          contactId,
          brokerFlag: isBrokerContact(contact),
        });
      }
    }
    const hasNext = Boolean(payload?._links?.next);
    if (!hasNext) {
      return {
        contacts: [...matches.values()].sort(
          (left, right) => left.contactId - right.contactId,
        ),
        pagesRead: page,
        contactsRead,
      };
    }
    if (contacts.length === 0) {
      throw new Error("amoCRM contacts pagination loop detected");
    }
  }
  throw new Error("amoCRM contacts pagination exceeded safety bound");
}

async function lookupExactBrokerContacts(
  request,
  normalizedPhone,
  maxPages = MAX_LOOKUP_PAGES,
) {
  const lookup = await lookupExactContacts(request, normalizedPhone, maxPages);
  return {
    contactIds: lookup.contacts
      .filter((contact) => contact.brokerFlag)
      .map((contact) => contact.contactId),
    pagesRead: lookup.pagesRead,
    contactsRead: lookup.contactsRead,
  };
}

function reportHash(kind, value, hashKey) {
  if (value === null || value === undefined || value === "") return null;
  if (!Buffer.isBuffer(hashKey) || hashKey.length < 32) {
    throw new Error("Report hash key is invalid");
  }
  const digest = createHmac("sha256", hashKey)
    .update(`${HASH_DOMAIN}:${kind}:${String(value)}`)
    .digest("hex")
    .slice(0, 24);
  return `${kind}_${digest}`;
}

function cohortAttestationKey(value) {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : typeof value === "string"
      ? Buffer.from(value, "utf8")
      : null;
  if (!key || key.length < 32) {
    throw new Error("Cohort attestation key is invalid");
  }
  return key;
}

function readCohortAttestationKeyFile(pathValue) {
  if (typeof pathValue !== "string" || !pathValue || pathValue.includes("\0")) {
    throw new Error("Cohort attestation key file is invalid");
  }
  try {
    const stats = lstatSync(pathValue);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Cohort attestation key file is invalid");
    }
    return cohortAttestationKey(readFileSync(pathValue));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Cohort attestation key is invalid"
    ) {
      throw error;
    }
    throw new Error("Cohort attestation key file is invalid");
  }
}

function cohortAttestationMetadata(inspectorSha256, deployedGitSha) {
  if (
    typeof inspectorSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(inspectorSha256)
  ) {
    throw new Error("Inspector source SHA is invalid");
  }
  if (
    typeof deployedGitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(deployedGitSha)
  ) {
    throw new Error("Deployed Git SHA is invalid");
  }
  return { inspectorSha256, deployedGitSha };
}

function canonicalAtom(value) {
  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? ["date", value.toISOString()]
      : ["date", "invalid"];
  }
  if (typeof value === "bigint") return ["bigint", value.toString(10)];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return ["number", "non-finite"];
    return ["number", String(value)];
  }
  if (typeof value === "boolean") return ["boolean", value ? "1" : "0"];
  return ["string", String(value)];
}

function compareCanonical(left, right) {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  if (leftJson < rightJson) return -1;
  if (leftJson > rightJson) return 1;
  return 0;
}

function canonicalPhoneTuple(value) {
  return [canonicalAtom(value), canonicalAtom(normalizePhone(value))];
}

function canonicalBrokerTuple(role, broker) {
  if (!broker) return [role, ["missing"]];
  const additionalPhones = (Array.isArray(broker.phones) ? broker.phones : [])
    .map((entry) => canonicalPhoneTuple(entry?.phone))
    .sort(compareCanonical);
  return [
    role,
    canonicalAtom(broker.id),
    canonicalAtom(broker.amoContactId),
    canonicalAtom(broker.mergedIntoId),
    ["primaryPhone", canonicalPhoneTuple(broker.phone)],
    ["additionalPhones", additionalPhones],
  ];
}

function canonicalProvisioningBrokerTuple(role, broker) {
  if (!broker) return [role, ["missing"]];
  const primaryAgencies = (
    Array.isArray(broker.brokerAgencies) ? broker.brokerAgencies : []
  )
    .map((membership) => [
      "primaryAgencyMembership",
      canonicalAtom(membership?.id),
      canonicalAtom(membership?.agencyId),
      canonicalAtom(membership?.isPrimary),
      canonicalAtom(membership?.joinedAt),
      [
        "agency",
        canonicalAtom(membership?.agency?.id),
        canonicalAtom(membership?.agency?.name),
        canonicalAtom(membership?.agency?.inn),
        canonicalAtom(membership?.agency?.address),
      ],
    ])
    .sort(compareCanonical);
  return [
    role,
    ["ownership", canonicalBrokerTuple("broker", broker)],
    ["fullName", canonicalAtom(broker.fullName)],
    ["email", canonicalAtom(broker.email)],
    ["region", canonicalAtom(broker.region)],
    ["position", canonicalAtom(broker.position)],
    ["telegramUsername", canonicalAtom(broker.telegramUsername)],
    ["telegramId", canonicalAtom(broker.telegramId)],
    ["whatsappUsername", canonicalAtom(broker.whatsappUsername)],
    ["presentationSent", canonicalAtom(broker.presentationSent)],
    ["doNotCall", canonicalAtom(broker.doNotCall)],
    ["updatedAt", canonicalAtom(broker.updatedAt)],
    ["primaryAgencies", primaryAgencies],
  ];
}

function canonicalQueueTuples(queueRows) {
  if (!Array.isArray(queueRows)) {
    throw new Error("Invalid cohort attestation input");
  }
  return queueRows
    .map((row) => [
      "queue",
      canonicalAtom(row?.id),
      canonicalAtom(row?.brokerId),
      canonicalAtom(row?.responsibleBrokerId),
      canonicalAtom(row?.amoLeadId),
      canonicalAtom(row?.fixationAgencyId),
      canonicalAtom(row?.amoSyncStatus),
      canonicalAtom(row?.amoSyncAttempts),
      canonicalAtom(row?.amoSyncError),
      canonicalProvisioningBrokerTuple("assignedBroker", row?.broker),
      canonicalProvisioningBrokerTuple(
        "responsibleBroker",
        row?.responsibleBroker,
      ),
    ])
    .sort(compareCanonical);
}

function canonicalBrokerTuples(allBrokers) {
  if (!Array.isArray(allBrokers)) {
    throw new Error("Invalid cohort attestation input");
  }
  return allBrokers
    .map((broker) => canonicalBrokerTuple("brokerOwnership", broker))
    .sort(compareCanonical);
}

function canonicalAmoContactTuples(lookups) {
  if (!lookups || typeof lookups.entries !== "function") {
    throw new Error("Invalid cohort attestation input");
  }
  return [...lookups.entries()]
    .map(([phone, lookup]) => {
      if (!lookup || !Array.isArray(lookup.contacts)) {
        throw new Error("Malformed amoCRM contacts page");
      }
      const contacts = lookup.contacts
        .map((contact) => {
          const contactId = positiveInteger(contact?.contactId);
          if (!contactId || typeof contact?.brokerFlag !== "boolean") {
            throw new Error("Invalid amoCRM contact record");
          }
          return [
            "exactContact",
            canonicalAtom(contactId),
            canonicalAtom(contact.brokerFlag),
          ];
        })
        .sort(compareCanonical);
      return ["amoExactPhoneLookup", canonicalPhoneTuple(phone), contacts];
    })
    .sort(compareCanonical);
}

function buildCohortAttestation(
  queueRows,
  allBrokers,
  lookups,
  keyValue,
  inspectorSha256,
  deployedGitSha,
) {
  const key = cohortAttestationKey(keyValue);
  const metadata = cohortAttestationMetadata(inspectorSha256, deployedGitSha);
  const canonicalState = JSON.stringify([
    ["schemaVersion", 1],
    ["inspectorSha256", metadata.inspectorSha256],
    ["deployedGitSha", metadata.deployedGitSha],
    ["queue", canonicalQueueTuples(queueRows)],
    ["brokerOwnership", canonicalBrokerTuples(allBrokers)],
    ["amoExactContacts", canonicalAmoContactTuples(lookups)],
  ]);
  const digest = createHmac("sha256", key)
    .update(COHORT_ATTESTATION_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(canonicalState, "utf8")
    .digest("hex");
  return {
    digest,
    inspectorSha256: metadata.inspectorSha256,
    deployedGitSha: metadata.deployedGitSha,
  };
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
    raw === "AMO_NETWORK_ERROR" ||
    /timeout|timed out|network|socket|fetch|econn|enotfound/.test(normalized)
  ) {
    return "network_failure";
  }
  if (
    raw === "AMO_CONFIGURATION_ERROR" ||
    /not configured|не настроен|missing token/.test(normalized)
  ) {
    return "configuration_missing";
  }
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
    /did not return a lead id|не вернула id/.test(normalized)
  ) {
    return "invalid_response";
  }
  if (raw === "AMO_SYNC_FAILED") return "sync_failed";
  return "other";
}

function brokerPhones(broker) {
  if (!broker) return [];
  const values = [
    broker.phone,
    ...(Array.isArray(broker.phones)
      ? broker.phones.map((entry) => entry?.phone)
      : []),
  ];
  return [...new Set(values.map(normalizePhone).filter(Boolean))].sort();
}

function effectiveBroker(queueRow) {
  return queueRow?.responsibleBroker || queueRow?.broker || null;
}

function groupQueueRows(queueRows) {
  const groups = new Map();
  for (const row of queueRows) {
    const broker = effectiveBroker(row);
    const key = broker?.id ? `broker:${broker.id}` : `queue:${row.id}`;
    if (!groups.has(key)) groups.set(key, { broker, queueRows: [] });
    groups.get(key).queueRows.push(row);
  }
  return [...groups.values()];
}

function buildPhoneOwnerMap(allBrokers) {
  const owners = new Map();
  for (const broker of allBrokers) {
    if (!broker?.id || broker.mergedIntoId) continue;
    for (const phone of brokerPhones(broker)) {
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

function preclassifyGroup(group, phoneOwners) {
  const broker = group.broker;
  if (!broker?.id) {
    return { resolution: "effective_broker_missing", phones: [] };
  }
  if (broker.mergedIntoId) {
    return { resolution: "broker_merged", phones: [] };
  }
  if (positiveInteger(broker.amoContactId)) {
    return { resolution: "already_linked", phones: [] };
  }
  const phones = brokerPhones(broker);
  if (phones.length === 0) {
    return { resolution: "no_valid_phone", phones: [] };
  }
  const collision = phones.some((phone) => {
    const owners = phoneOwners.get(phone);
    return !owners || owners.size !== 1 || !owners.has(String(broker.id));
  });
  if (collision) {
    return { resolution: "db_phone_ambiguous", phones: [] };
  }
  return { resolution: null, phones };
}

function requiredLookupPhones(queueRows, allBrokers) {
  const phoneOwners = buildPhoneOwnerMap(allBrokers);
  const output = new Set();
  for (const group of groupQueueRows(queueRows)) {
    const preliminary = preclassifyGroup(group, phoneOwners);
    if (preliminary.resolution === null) {
      for (const phone of preliminary.phones) output.add(phone);
    }
  }
  return [...output].sort();
}

function zeroCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function increment(counts, key, amount = 1) {
  counts[key] = Number(counts[key] || 0) + amount;
}

function queuePrerequisites(rows) {
  const leadId = { present: 0, absent: 0 };
  const fixationAgency = { present: 0, absent: 0 };
  const errorClass = zeroCounts(ERROR_CLASSES);
  const status = { FAILED: 0, PENDING: 0, UNKNOWN: 0 };
  for (const row of rows) {
    increment(leadId, positiveInteger(row.amoLeadId) ? "present" : "absent");
    increment(fixationAgency, row.fixationAgencyId ? "present" : "absent");
    increment(errorClass, classifySyncError(row.amoSyncError));
    increment(
      status,
      QUEUE_STATUSES.includes(row.amoSyncStatus)
        ? row.amoSyncStatus
        : "UNKNOWN",
    );
  }
  return { leadId, fixationAgency, errorClass, status };
}

function resolveGroup(group, phoneOwners, contactOwners, lookups, hashKey) {
  const preliminary = preclassifyGroup(group, phoneOwners);
  const broker = group.broker;
  let resolution = preliminary.resolution;
  let candidateContactHash = null;
  let amoCandidateCount = 0;
  let exactPhoneMatchCount = 0;

  if (resolution === null) {
    const candidates = new Set();
    for (const phone of preliminary.phones) {
      const lookup = lookups.get(phone);
      if (!lookup || !Array.isArray(lookup.contactIds)) {
        throw new Error("Malformed amoCRM contacts page");
      }
      const ids = [...new Set(lookup.contactIds.map(positiveInteger))];
      if (ids.some((id) => id === null)) {
        throw new Error("Invalid amoCRM contact record");
      }
      if (ids.length > 0) exactPhoneMatchCount += 1;
      for (const id of ids) candidates.add(id);
    }
    amoCandidateCount = candidates.size;
    if (candidates.size === 0) {
      resolution = "no_exact_broker_contact";
    } else if (candidates.size > 1) {
      resolution = "ambiguous_amo_match";
    } else {
      const candidateId = [...candidates][0];
      const owners = contactOwners.get(candidateId) || new Set();
      const occupiedByOther = [...owners].some(
        (ownerId) => ownerId !== String(broker.id),
      );
      if (occupiedByOther) {
        resolution = "candidate_already_bound";
      } else {
        resolution = "link_candidate";
        candidateContactHash = reportHash("contact", candidateId, hashKey);
      }
    }
  }

  return {
    brokerHash: broker?.id ? reportHash("broker", broker.id, hashKey) : null,
    queueHashes: group.queueRows
      .map((row) => reportHash("queue", row.id, hashKey))
      .sort(),
    queueCount: group.queueRows.length,
    resolution,
    searchedPhoneCount: preliminary.phones.length,
    exactPhoneMatchCount,
    amoCandidateCount,
    candidateContactHash,
    prerequisites: queuePrerequisites(group.queueRows),
    advisory: {
      brokerLinkCandidate: resolution === "link_candidate",
      databaseMutationAuthorized: false,
      amoMutationAuthorized: false,
      retryAuthorized: false,
    },
  };
}

function buildReport(
  queueRows,
  allBrokers,
  lookups,
  generatedAt = new Date(),
  hashKey = randomBytes(32),
) {
  const phoneOwners = buildPhoneOwnerMap(allBrokers);
  const contactOwners = buildContactOwnerMap(allBrokers);
  const records = groupQueueRows(queueRows)
    .map((group) =>
      resolveGroup(group, phoneOwners, contactOwners, lookups, hashKey),
    )
    .sort((left, right) =>
      String(left.brokerHash || left.queueHashes[0]).localeCompare(
        String(right.brokerHash || right.queueHashes[0]),
      ),
    );
  const resolutionByBroker = zeroCounts(RESOLUTION_CLASSES);
  const resolutionByQueueRow = zeroCounts(RESOLUTION_CLASSES);
  const queueStatus = { FAILED: 0, PENDING: 0, UNKNOWN: 0 };
  const errorClass = zeroCounts(ERROR_CLASSES);
  const leadId = { present: 0, absent: 0 };
  const fixationAgency = { present: 0, absent: 0 };
  for (const record of records) {
    increment(resolutionByBroker, record.resolution);
    increment(resolutionByQueueRow, record.resolution, record.queueCount);
    for (const [key, value] of Object.entries(record.prerequisites.status)) {
      increment(queueStatus, key, value);
    }
    for (const [key, value] of Object.entries(
      record.prerequisites.errorClass,
    )) {
      increment(errorClass, key, value);
    }
    for (const [key, value] of Object.entries(record.prerequisites.leadId)) {
      increment(leadId, key, value);
    }
    for (const [key, value] of Object.entries(
      record.prerequisites.fixationAgency,
    )) {
      increment(fixationAgency, key, value);
    }
  }

  const lookupStats = [...lookups.values()].reduce(
    (accumulator, lookup) => ({
      queries: accumulator.queries + 1,
      pagesRead: accumulator.pagesRead + Number(lookup?.pagesRead || 0),
      contactsRead:
        accumulator.contactsRead + Number(lookup?.contactsRead || 0),
    }),
    { queries: 0, pagesRead: 0, contactsRead: 0 },
  );

  return {
    inspector: "amo_broker_link_repair_plan",
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    safety: {
      readOnly: true,
      databaseSessionReadOnly: true,
      databaseOperations:
        "read-only session verification SELECT plus two Prisma findMany SELECTs",
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      amoHttpMethods: ["GET"],
      amoEndpoints: ["/api/v4/account", "/api/v4/contacts"],
      oauthRefresh: false,
      databaseMutations: false,
      amoMutations: false,
      rawIdentifiersEmitted: false,
      contactFieldsHeldInMemoryOnly: true,
    },
    classification: {
      hashScheme: "hmac-sha256-per-report-key-v1-24hex",
      crossRunLinkable: false,
      effectiveBroker: "responsible_broker_then_owner_fallback",
      phoneMatch:
        "unique-active-db-owner-and-exact-normalized-amo-phone-and-broker-flag",
      collisionPolicy: "fail_closed",
    },
    plan: {
      advisoryOnly: true,
      executablePayload: false,
      databaseMutationAuthorized: false,
      amoMutationAuthorized: false,
      retryAuthorized: false,
      requiredNextGate:
        "recompute mappings with CAS, then separately reconcile client leads before any retry",
    },
    aggregates: {
      exhaustedQueueRows: queueRows.length,
      effectiveBrokerGroups: records.filter((record) => record.brokerHash)
        .length,
      lookup: lookupStats,
      resolutionByBroker,
      resolutionByQueueRow,
      queueStatus,
      errorClass,
      leadId,
      fixationAgency,
    },
    records,
  };
}

function buildProvisioningRecord(
  group,
  phoneOwners,
  contactOwners,
  lookups,
  hashKey,
) {
  const preliminary = preclassifyGroup(group, phoneOwners);
  const broker = group.broker;
  let resolution = preliminary.resolution;
  let candidateContactHash = null;
  let exactPhoneMatchCount = 0;
  let exactContactCount = 0;
  let brokerFlaggedContactCount = 0;
  let unflaggedContactCount = 0;

  if (resolution === null) {
    const candidates = new Map();
    for (const phone of preliminary.phones) {
      const lookup = lookups.get(phone);
      if (!lookup || !Array.isArray(lookup.contacts)) {
        throw new Error("Malformed amoCRM contacts page");
      }
      if (lookup.contacts.length > 0) exactPhoneMatchCount += 1;
      for (const contact of lookup.contacts) {
        const contactId = positiveInteger(contact?.contactId);
        if (!contactId || typeof contact?.brokerFlag !== "boolean") {
          throw new Error("Invalid amoCRM contact record");
        }
        const existing = candidates.get(contactId);
        if (
          existing !== undefined &&
          existing.brokerFlag !== contact.brokerFlag
        ) {
          throw new Error("Invalid amoCRM contact record");
        }
        candidates.set(contactId, {
          contactId,
          brokerFlag: contact.brokerFlag,
        });
      }
    }

    exactContactCount = candidates.size;
    brokerFlaggedContactCount = [...candidates.values()].filter(
      (contact) => contact.brokerFlag,
    ).length;
    unflaggedContactCount = exactContactCount - brokerFlaggedContactCount;

    if (exactContactCount === 0) {
      resolution = "create_contact_candidate";
    } else if (exactContactCount > 1) {
      resolution = "ambiguous_exact_contacts";
    } else {
      const candidate = [...candidates.values()][0];
      const owners = contactOwners.get(candidate.contactId) || new Set();
      const occupiedByOther = [...owners].some(
        (ownerId) => ownerId !== String(broker.id),
      );
      if (occupiedByOther) {
        resolution = "candidate_already_bound";
      } else {
        resolution = candidate.brokerFlag
          ? "link_existing_broker_contact"
          : "promote_existing_contact_candidate";
        candidateContactHash = reportHash(
          "contact",
          candidate.contactId,
          hashKey,
        );
      }
    }
  }

  return {
    brokerHash: broker?.id ? reportHash("broker", broker.id, hashKey) : null,
    queueHashes: group.queueRows
      .map((row) => reportHash("queue", row.id, hashKey))
      .sort(),
    queueCount: group.queueRows.length,
    resolution,
    searchedPhoneCount: preliminary.phones.length,
    exactPhoneMatchCount,
    exactContactCount,
    brokerFlaggedContactCount,
    unflaggedContactCount,
    candidateContactHash,
    prerequisites: queuePrerequisites(group.queueRows),
    advisory: {
      databaseLinkCandidate:
        resolution === "link_existing_broker_contact" ||
        resolution === "promote_existing_contact_candidate",
      amoPromotionCandidate:
        resolution === "promote_existing_contact_candidate",
      amoCreateCandidate: resolution === "create_contact_candidate",
      databaseMutationAuthorized: false,
      amoMutationAuthorized: false,
      retryAuthorized: false,
    },
  };
}

function buildProvisioningReport(
  queueRows,
  allBrokers,
  lookups,
  generatedAt = new Date(),
  hashKey = randomBytes(32),
) {
  const phoneOwners = buildPhoneOwnerMap(allBrokers);
  const contactOwners = buildContactOwnerMap(allBrokers);
  const records = groupQueueRows(queueRows)
    .map((group) =>
      buildProvisioningRecord(
        group,
        phoneOwners,
        contactOwners,
        lookups,
        hashKey,
      ),
    )
    .sort((left, right) =>
      String(left.brokerHash || left.queueHashes[0]).localeCompare(
        String(right.brokerHash || right.queueHashes[0]),
      ),
    );
  const resolutionByBroker = zeroCounts(PROVISIONING_RESOLUTION_CLASSES);
  const resolutionByQueueRow = zeroCounts(PROVISIONING_RESOLUTION_CLASSES);
  const queueStatus = { FAILED: 0, PENDING: 0, UNKNOWN: 0 };
  const errorClass = zeroCounts(ERROR_CLASSES);
  const leadId = { present: 0, absent: 0 };
  const fixationAgency = { present: 0, absent: 0 };
  for (const record of records) {
    increment(resolutionByBroker, record.resolution);
    increment(resolutionByQueueRow, record.resolution, record.queueCount);
    for (const [key, value] of Object.entries(record.prerequisites.status)) {
      increment(queueStatus, key, value);
    }
    for (const [key, value] of Object.entries(
      record.prerequisites.errorClass,
    )) {
      increment(errorClass, key, value);
    }
    for (const [key, value] of Object.entries(record.prerequisites.leadId)) {
      increment(leadId, key, value);
    }
    for (const [key, value] of Object.entries(
      record.prerequisites.fixationAgency,
    )) {
      increment(fixationAgency, key, value);
    }
  }

  const lookupStats = [...lookups.values()].reduce(
    (accumulator, lookup) => ({
      queries: accumulator.queries + 1,
      pagesRead: accumulator.pagesRead + Number(lookup?.pagesRead || 0),
      contactsRead:
        accumulator.contactsRead + Number(lookup?.contactsRead || 0),
      exactContacts:
        accumulator.exactContacts +
        (Array.isArray(lookup?.contacts) ? lookup.contacts.length : 0),
    }),
    { queries: 0, pagesRead: 0, contactsRead: 0, exactContacts: 0 },
  );

  return {
    inspector: "amo_broker_contact_provisioning_plan",
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    safety: {
      readOnly: true,
      databaseSessionReadOnly: true,
      databaseOperations:
        "read-only session verification SELECT plus two Prisma findMany SELECTs",
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      amoHttpMethods: ["GET"],
      amoEndpoints: ["/api/v4/account", "/api/v4/contacts"],
      oauthRefresh: false,
      databaseMutations: false,
      amoMutations: false,
      rawIdentifiersEmitted: false,
      contactFieldsHeldInMemoryOnly: true,
    },
    classification: {
      hashScheme: "hmac-sha256-per-report-key-v1-24hex",
      crossRunLinkable: false,
      effectiveBroker: "responsible_broker_then_owner_fallback",
      exactContactMatch:
        "unique-active-db-owner-and-exact-normalized-amo-phone",
      brokerFlagRead: true,
      collisionPolicy: "fail_closed",
    },
    plan: {
      advisoryOnly: true,
      executablePayload: false,
      databaseMutationAuthorized: false,
      amoMutationAuthorized: false,
      retryAuthorized: false,
      requiredNextGate:
        "apply only separately reviewed exact-count CAS link, promotion or create classes; reconcile client leads before retry",
    },
    aggregates: {
      exhaustedQueueRows: queueRows.length,
      effectiveBrokerGroups: records.filter((record) => record.brokerHash)
        .length,
      lookup: lookupStats,
      resolutionByBroker,
      resolutionByQueueRow,
      queueStatus,
      errorClass,
      leadId,
      fixationAgency,
    },
    records,
  };
}

async function main() {
  const rawMode = String(process.env.BROKER_CONTACT_PROVISIONING_PLAN || "0");
  if (rawMode !== "0" && rawMode !== "1") {
    throw new Error("Inspector mode is invalid");
  }
  const provisioningMode = rawMode === "1";
  let attestationConfiguration = null;
  if (provisioningMode) {
    activeFailurePhase = FAILURE_PHASE.ATTESTATION;
    attestationConfiguration = {
      key: readCohortAttestationKeyFile(
        process.env.BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE,
      ),
      ...cohortAttestationMetadata(
        process.env.BROKER_CONTACT_INSPECTOR_SHA256,
        process.env.BROKER_CONTACT_DEPLOYED_GIT_SHA,
      ),
    };
  }

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
      select: provisioningMode
        ? PROVISIONING_QUEUE_ROW_SELECT
        : OWNERSHIP_QUEUE_ROW_SELECT,
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

    activeFailurePhase = FAILURE_PHASE.ACCOUNT;
    const request = createGetOnlyRequester(process.env.AMO_ACCESS_TOKEN);
    await assertExpectedAccount(request);

    activeFailurePhase = FAILURE_PHASE.CONTACT_LOOKUP;
    const lookups = new Map();
    for (const phone of requiredLookupPhones(queueRows, allBrokers)) {
      lookups.set(
        phone,
        provisioningMode
          ? await lookupExactContacts(request, phone)
          : await lookupExactBrokerContacts(request, phone),
      );
    }

    activeFailurePhase = FAILURE_PHASE.REPORT;
    const report = provisioningMode
      ? {
          ...buildProvisioningReport(queueRows, allBrokers, lookups),
          cohortAttestation: buildCohortAttestation(
            queueRows,
            allBrokers,
            lookups,
            attestationConfiguration.key,
            attestationConfiguration.inspectorSha256,
            attestationConfiguration.deployedGitSha,
          ),
        }
      : buildReport(queueRows, allBrokers, lookups);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  AMO_ORIGIN,
  ATTEMPT_LIMIT,
  EXPECTED_ACCOUNT_ID,
  MAX_LOOKUP_PAGES,
  MAX_RESPONSE_BYTES,
  STATEMENT_TIMEOUT_MS,
  BROKER_OWNER_SELECT,
  BROKER_PROVISION_SELECT,
  OWNERSHIP_QUEUE_ROW_SELECT,
  PROVISIONING_QUEUE_ROW_SELECT,
  assertExpectedAccount,
  assertReadOnlySession,
  buildCohortAttestation,
  buildReadOnlyDatabaseUrl,
  buildProvisioningReport,
  buildReport,
  canonicalAmoUrl,
  classifyFailure,
  classifySyncError,
  createGetOnlyRequester,
  effectiveBroker,
  lookupExactBrokerContacts,
  lookupExactContacts,
  normalizePhone,
  readJsonBounded,
  readCohortAttestationKeyFile,
  reportHash,
  requiredLookupPhones,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `PII-safe broker link repair-plan inspector failed; failure_phase=${activeFailurePhase}; failure_code=${classifyFailure(error)}\n`,
    );
    process.exitCode = 1;
  });
}
