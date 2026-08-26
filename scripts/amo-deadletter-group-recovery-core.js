#!/usr/bin/env node
"use strict";

const { createHash, createHmac } = require("node:crypto");

const EXPECTED_QUEUE_ROWS = 12;
const EXPECTED_PHONE_GROUPS = 9;
const ATTEMPT_LIMIT = 10;
const QUEUE_STATUSES = Object.freeze(["FAILED", "PENDING"]);
const FINAL_AMO_STATUSES = new Set([142, 143]);
const NETWORK_NEGATIVE_SKEW_MS = 2 * 60 * 1000;
const NETWORK_NEGATIVE_TAIL_MS = 24 * 60 * 60 * 1000;
const PLAN_DOMAIN = "st-michael:amo-deadletter-group-recovery-plan:v1";
const OPERATION_DOMAIN =
  "st-michael:amo-deadletter-group-recovery-operation:v1";
const ADVISORY_LOCK_DOMAIN =
  "st-michael:amo-deadletter-group-recovery-advisory-lock:v1";
const RECOVERY_MARKER_PREFIX =
  "AMO_CREATE_RECONCILIATION_REQUIRED:RECOVERY_PENDING:";

const RESOLUTION_CLASSES = Object.freeze([
  "create_one_lead",
  "blocked_invalid_phone",
  "blocked_contact_ambiguity",
  "blocked_client_broker_role_collision",
  "blocked_broker_contact",
  "blocked_agency",
  "blocked_project_divergence",
  "blocked_active_or_unknown_lead",
  "blocked_ambiguous_network_evidence",
  "blocked_unresolved_recovery_gate",
  "blocked_invalid_row",
]);

const ERROR_CLASSES = Object.freeze([
  "broker_amo_contact_missing",
  "fixation_agency_missing",
  "network_failure",
  "create_reconciliation_required",
  "other",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateIso(value, code = "DATE_INVALID") {
  const date = validDate(value);
  if (!date) fail(code);
  return date.toISOString();
}

function positiveInteger(value) {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+7${digits}`;
  if (
    digits.length === 11 &&
    (digits.startsWith("7") || digits.startsWith("8"))
  ) {
    return `+7${digits.slice(1)}`;
  }
  return null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function hmacDigest(domain, value, key) {
  if (!Buffer.isBuffer(key) || key.length < 32) fail("ATTESTATION_KEY_INVALID");
  const domainBytes = Buffer.from(domain, "utf8");
  const valueBytes = Buffer.from(stableJson(value), "utf8");
  return createHmac("sha256", key)
    .update(`${domainBytes.length}:`, "utf8")
    .update(domainBytes)
    .update(`${valueBytes.length}:`, "utf8")
    .update(valueBytes)
    .digest("hex");
}

function reportAlias(kind, value, reportKey) {
  return `${kind}_${hmacDigest(
    `st-michael:amo-deadletter-group-report-alias:${kind}:v1`,
    String(value),
    reportKey,
  ).slice(0, 24)}`;
}

function classifyError(value) {
  const raw = String(value || "");
  const normalized = raw.toLowerCase();
  if (raw.startsWith("AMO_CREATE_RECONCILIATION_REQUIRED:")) {
    return "create_reconciliation_required";
  }
  if (
    raw === "BROKER_AMO_CONTACT_MISSING" ||
    (normalized.includes("broker") && normalized.includes("contact"))
  ) {
    return "broker_amo_contact_missing";
  }
  if (raw === "FIXATION_AGENCY_MISSING" || normalized.includes("agency")) {
    return "fixation_agency_missing";
  }
  if (
    /timeout|timed out|network|socket|fetch|econn|enotfound/.test(normalized)
  ) {
    return "network_failure";
  }
  return "other";
}

function effectiveBroker(row) {
  return row?.responsibleBroker || row?.broker || null;
}

function rowSnapshot(row) {
  return {
    id: String(row.id),
    brokerId: String(row.brokerId),
    responsibleBrokerId: row.responsibleBrokerId
      ? String(row.responsibleBrokerId)
      : null,
    phone: String(row.phone),
    fullName: String(row.fullName),
    email:
      row.email === null || row.email === undefined ? null : String(row.email),
    comment:
      row.comment === null || row.comment === undefined
        ? null
        : String(row.comment),
    project: String(row.project),
    fixationAgencyId: row.fixationAgencyId
      ? String(row.fixationAgencyId)
      : null,
    propertyType: row.propertyType || null,
    roomsCount: row.roomsCount || null,
    amount:
      row.amount === null || row.amount === undefined
        ? null
        : String(row.amount),
    sqm: row.sqm === null || row.sqm === undefined ? null : String(row.sqm),
    clientRegion: row.clientRegion || null,
    purchaseTiming: row.purchaseTiming || null,
    readinessLevel: row.readinessLevel || null,
    createdAt: dateIso(row.createdAt, "ROW_CREATED_AT_INVALID"),
    updatedAt: dateIso(row.updatedAt, "ROW_UPDATED_AT_INVALID"),
    amoLeadId: positiveInteger(row.amoLeadId),
    amoSyncStatus: String(row.amoSyncStatus || ""),
    amoSyncAttempts: Number(row.amoSyncAttempts),
    amoSyncLastAttemptAt:
      validDate(row.amoSyncLastAttemptAt)?.toISOString() || null,
    amoSyncError:
      row.amoSyncError === null ? null : String(row.amoSyncError || ""),
    effectiveBrokerId: effectiveBroker(row)?.id
      ? String(effectiveBroker(row).id)
      : null,
    effectiveBrokerMergedIntoId: effectiveBroker(row)?.mergedIntoId
      ? String(effectiveBroker(row).mergedIntoId)
      : null,
    effectiveBrokerUpdatedAt:
      validDate(effectiveBroker(row)?.updatedAt)?.toISOString() || null,
    effectiveBrokerAmoContactId: positiveInteger(
      effectiveBroker(row)?.amoContactId,
    ),
    effectiveBrokerPhone: effectiveBroker(row)?.phone
      ? String(effectiveBroker(row).phone)
      : null,
    effectiveBrokerFullName: effectiveBroker(row)?.fullName
      ? String(effectiveBroker(row).fullName)
      : null,
    effectiveBrokerEmail:
      effectiveBroker(row)?.email === null ||
      effectiveBroker(row)?.email === undefined
        ? null
        : String(effectiveBroker(row).email),
  };
}

function compareRows(left, right) {
  const byCreated = dateIso(left.createdAt).localeCompare(
    dateIso(right.createdAt),
  );
  return byCreated || String(left.id).localeCompare(String(right.id));
}

function groupRowsByPhone(rows) {
  if (!Array.isArray(rows) || rows.length !== EXPECTED_QUEUE_ROWS) {
    fail("QUEUE_ROW_COUNT_CHANGED");
  }
  const groups = new Map();
  for (const row of rows) {
    const normalizedPhone = normalizePhone(row?.phone);
    const key = normalizedPhone || `invalid:${String(row?.id || "")}`;
    if (!groups.has(key)) groups.set(key, { normalizedPhone, rows: [] });
    groups.get(key).rows.push(row);
  }
  const output = [...groups.values()]
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort(compareRows),
      leader: [...group.rows].sort(compareRows)[0],
    }))
    .sort((left, right) =>
      String(left.normalizedPhone || left.leader.id).localeCompare(
        String(right.normalizedPhone || right.leader.id),
      ),
    );
  if (output.length !== EXPECTED_PHONE_GROUPS)
    fail("PHONE_GROUP_COUNT_CHANGED");
  return output;
}

function resolveAgency(row, agenciesById) {
  const storedId = row?.fixationAgencyId ? String(row.fixationAgencyId) : null;
  if (storedId) {
    const agency = agenciesById.get(storedId);
    if (!agency?.id || !agency?.inn || !agency?.name) {
      return { ok: false, reason: "stored_agency_missing" };
    }
    return {
      ok: true,
      repair: false,
      provenance: "stored_client_value",
      agency,
    };
  }

  // The form's agency belongs to the cabinet owner (brokerId), not to the
  // optional responsible broker. A missing legacy value is recoverable only
  // when exactly one membership already existed when the Client was created.
  const createdAt = validDate(row?.createdAt);
  const memberships = Array.isArray(row?.broker?.brokerAgencies)
    ? row.broker.brokerAgencies
    : [];
  const historical = memberships.filter((membership) => {
    const joinedAt = validDate(membership?.joinedAt);
    return joinedAt && createdAt && joinedAt.getTime() <= createdAt.getTime();
  });
  if (historical.length !== 1) {
    return {
      ok: false,
      reason:
        historical.length === 0
          ? "no_historical_owner_agency"
          : "ambiguous_historical_owner_agency",
    };
  }
  const agencyId = String(historical[0].agencyId || "");
  const agency = agenciesById.get(agencyId);
  if (!agency?.id || !agency?.inn || !agency?.name) {
    return { ok: false, reason: "historical_agency_missing" };
  }
  return {
    ok: true,
    repair: true,
    provenance: "sole_owner_membership_at_client_creation",
    agency,
  };
}

function candidateCreatedAtMs(lead) {
  const seconds = Number(lead?.createdAt);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function networkEvidenceIsAmbiguous(row, leads) {
  if (classifyError(row?.amoSyncError) !== "network_failure") return false;
  const createdAt = validDate(row?.createdAt);
  const lastAttemptAt = validDate(row?.amoSyncLastAttemptAt) || createdAt;
  if (!createdAt || !lastAttemptAt) return true;
  const from = createdAt.getTime() - NETWORK_NEGATIVE_SKEW_MS;
  const to = lastAttemptAt.getTime() + NETWORK_NEGATIVE_TAIL_MS;
  return leads.some((lead) => {
    const timestamp = candidateCreatedAtMs(lead);
    return timestamp === null || (timestamp >= from && timestamp <= to);
  });
}

function brokerProof(row, brokerEvidence) {
  const broker = effectiveBroker(row);
  const brokerId = broker?.id ? String(broker.id) : null;
  const contactId = positiveInteger(broker?.amoContactId);
  if (!brokerId || !contactId || broker?.mergedIntoId) {
    return { ok: false, reason: "effective_broker_or_contact_missing" };
  }
  const evidence = brokerEvidence.get(brokerId);
  if (
    !evidence ||
    evidence.contactId !== contactId ||
    evidence.exactPhone !== true ||
    evidence.brokerFlag !== true ||
    evidence.occupiedByOtherBroker === true
  ) {
    return { ok: false, reason: "broker_contact_not_authoritative" };
  }
  return { ok: true, brokerId, contactId };
}

function classifyGroup(group, evidenceByPhone, agenciesById, brokerEvidence) {
  if (!group.normalizedPhone) {
    return { resolution: "blocked_invalid_phone", reason: "invalid_phone" };
  }
  if (
    !evidenceByPhone ||
    typeof evidenceByPhone.has !== "function" ||
    typeof evidenceByPhone.get !== "function" ||
    !evidenceByPhone.has(group.normalizedPhone)
  ) {
    fail("AMO_EVIDENCE_MISSING");
  }
  const evidence = evidenceByPhone.get(group.normalizedPhone);
  if (
    !Array.isArray(evidence.exactContactIds) ||
    !Array.isArray(evidence.leads)
  ) {
    fail("AMO_EVIDENCE_INVALID");
  }
  if (evidence.exactContactRoleCollision === true) {
    return {
      resolution: "blocked_client_broker_role_collision",
      reason: "exact_client_contact_is_broker_or_db_occupied",
      evidence,
    };
  }
  if (evidence.exactContactIds.length > 1) {
    return {
      resolution: "blocked_contact_ambiguity",
      reason: "multiple_exact_client_contacts",
      evidence,
    };
  }

  const projectSet = new Set(
    group.rows.map((row) => String(row.project || "")),
  );
  if (
    projectSet.size !== 1 ||
    !["ZORGE9", "SILVER_BOR"].includes([...projectSet][0])
  ) {
    return {
      resolution: "blocked_project_divergence",
      reason: "sibling_projects_diverge_or_unknown",
      evidence,
    };
  }

  const rowProofs = [];
  for (const row of group.rows) {
    const snapshot = rowSnapshot(row);
    if (
      String(snapshot.amoSyncError || "").startsWith(RECOVERY_MARKER_PREFIX)
    ) {
      return {
        resolution: "blocked_unresolved_recovery_gate",
        reason: "durable_one_shot_gate_requires_manual_reconciliation",
        evidence,
      };
    }
    if (
      snapshot.amoLeadId !== null ||
      !QUEUE_STATUSES.includes(snapshot.amoSyncStatus) ||
      !Number.isSafeInteger(snapshot.amoSyncAttempts) ||
      snapshot.amoSyncAttempts < ATTEMPT_LIMIT
    ) {
      return {
        resolution: "blocked_invalid_row",
        reason: "row_not_exhausted_and_unlinked",
        evidence,
      };
    }
    const agency = resolveAgency(row, agenciesById);
    if (!agency.ok) {
      return { resolution: "blocked_agency", reason: agency.reason, evidence };
    }
    const broker = brokerProof(row, brokerEvidence);
    if (!broker.ok) {
      return {
        resolution: "blocked_broker_contact",
        reason: broker.reason,
        evidence,
      };
    }
    if (evidence.exactContactIds.includes(broker.contactId)) {
      return {
        resolution: "blocked_client_broker_role_collision",
        reason: "client_contact_is_effective_broker_contact",
        evidence,
      };
    }
    if (networkEvidenceIsAmbiguous(row, evidence.leads)) {
      return {
        resolution: "blocked_ambiguous_network_evidence",
        reason: "lead_exists_in_network_ambiguity_window",
        evidence,
      };
    }
    rowProofs.push({ row, snapshot, agency, broker });
  }

  const agencyIds = new Set(
    rowProofs.map((proof) => String(proof.agency.agency.id)),
  );
  if (agencyIds.size !== 1) {
    return {
      resolution: "blocked_agency",
      reason: "sibling_agencies_diverge",
      evidence,
    };
  }

  if (
    evidence.leads.some(
      (lead) =>
        !positiveInteger(lead?.leadId) ||
        !positiveInteger(lead?.pipelineId) ||
        !positiveInteger(lead?.statusId) ||
        !FINAL_AMO_STATUSES.has(Number(lead.statusId)),
    )
  ) {
    return {
      resolution: "blocked_active_or_unknown_lead",
      reason: "linked_lead_not_final",
      evidence,
    };
  }

  return {
    resolution: "create_one_lead",
    reason:
      evidence.exactContactIds.length === 0
        ? "no_exact_client_contact"
        : evidence.leads.length === 0
          ? "exact_contact_without_leads"
          : "all_linked_leads_final",
    evidence,
    rowProofs,
    leader: rowProofs[0],
    clientContactId: evidence.exactContactIds[0] || null,
    brokerContactIds: [
      ...new Set(rowProofs.map((proof) => proof.broker.contactId)),
    ].sort((left, right) => left - right),
    agencyRepairs: rowProofs.filter((proof) => proof.agency.repair).length,
  };
}

function rawGroupRecord(classification) {
  const group = classification.group;
  return {
    normalizedPhone: group.normalizedPhone,
    resolution: classification.resolution,
    reason: classification.reason,
    rows: group.rows.map(rowSnapshot),
    leaderId: String(group.leader.id),
    exactClientContactIds: [
      ...(classification.evidence?.exactContactIds || []),
    ].sort((left, right) => left - right),
    exactClientContactRoleCollision:
      classification.evidence?.exactContactRoleCollision === true,
    leads: [...(classification.evidence?.leads || [])]
      .map((lead) => ({
        leadId: positiveInteger(lead.leadId),
        pipelineId: positiveInteger(lead.pipelineId),
        statusId: positiveInteger(lead.statusId),
        createdAt: lead.createdAt ?? null,
        contactIds: [...(lead.contactIds || [])].sort((a, b) => a - b),
        sourceMarker: Boolean(lead.sourceMarker),
        requestValues: [...(lead.requestValues || [])],
        projectValues: [...(lead.projectValues || [])],
      }))
      .sort((left, right) => Number(left.leadId) - Number(right.leadId)),
    rowProofs: (classification.rowProofs || []).map((proof) => ({
      clientId: String(proof.row.id),
      brokerId: proof.broker.brokerId,
      brokerContactId: proof.broker.contactId,
      agencyId: String(proof.agency.agency.id),
      agencyName: String(proof.agency.agency.name),
      agencyInn: String(proof.agency.agency.inn),
      agencyUpdatedAt: dateIso(proof.agency.agency.updatedAt),
      agencyProvenance: proof.agency.provenance,
      agencyRepair: proof.agency.repair,
    })),
    brokerContactIds: [...(classification.brokerContactIds || [])],
  };
}

function planManifest(classifications) {
  const create = classifications.filter(
    (item) => item.resolution === "create_one_lead",
  );
  return {
    queueRows: classifications.reduce(
      (sum, item) => sum + item.group.rows.length,
      0,
    ),
    phoneGroups: classifications.length,
    createGroups: create.length,
    blockedGroups: classifications.length - create.length,
    clientContactCreates: create.filter((item) => item.clientContactId === null)
      .length,
    agencyRepairs: create.reduce((sum, item) => sum + item.agencyRepairs, 0),
    maxLeadPosts: create.length,
    requeues: 0,
  };
}

function formatManifest(manifest) {
  const keys = [
    "queueRows",
    "phoneGroups",
    "createGroups",
    "blockedGroups",
    "clientContactCreates",
    "agencyRepairs",
    "maxLeadPosts",
    "requeues",
  ];
  return keys.map((key) => `${key}=${Number(manifest[key])}`).join(",");
}

function buildPlan({
  rows,
  evidenceByPhone,
  agenciesById,
  brokerEvidence,
  metadata,
  attestationKey,
  reportKey,
}) {
  if (!reportKey) reportKey = attestationKey;
  const groups = groupRowsByPhone(rows);
  const classifications = groups.map((group) => ({
    group,
    ...classifyGroup(group, evidenceByPhone, agenciesById, brokerEvidence),
  }));
  const records = classifications.map(rawGroupRecord);
  const manifest = planManifest(classifications);
  const attestation = {
    schemaVersion: 1,
    sourceSha: String(metadata.sourceSha || ""),
    coreSha256: String(metadata.coreSha256 || ""),
    planSha256: String(metadata.planSha256 || ""),
    legacyInspectorSha256: String(metadata.legacyInspectorSha256 || ""),
    records,
    manifest,
  };
  if (!/^[0-9a-f]{40}$/.test(attestation.sourceSha)) fail("SOURCE_SHA_INVALID");
  if (!/^[0-9a-f]{64}$/.test(attestation.coreSha256)) fail("CORE_SHA_INVALID");
  if (!/^[0-9a-f]{64}$/.test(attestation.planSha256)) fail("PLAN_SHA_INVALID");
  if (!/^[0-9a-f]{64}$/.test(attestation.legacyInspectorSha256)) {
    fail("LEGACY_INSPECTOR_SHA_INVALID");
  }
  const digest = hmacDigest(PLAN_DOMAIN, attestation, attestationKey);
  const publicRecords = classifications.map((item) => ({
    groupHash: reportAlias(
      "phone_group",
      item.group.normalizedPhone || item.group.leader.id,
      reportKey,
    ),
    leaderHash: reportAlias("queue", item.group.leader.id, reportKey),
    queueCount: item.group.rows.length,
    resolution: item.resolution,
    exactClientContactCount: item.evidence?.exactContactIds?.length || 0,
    linkedLeadCount: item.evidence?.leads?.length || 0,
    brokerContactCount: item.brokerContactIds?.length || 0,
    agencyRepairs: item.agencyRepairs || 0,
    errorClasses: Object.fromEntries(
      ERROR_CLASSES.map((errorClass) => [
        errorClass,
        item.group.rows.filter(
          (row) => classifyError(row.amoSyncError) === errorClass,
        ).length,
      ]),
    ),
    advisory: {
      createAuthorized: item.resolution === "create_one_lead",
      retryAuthorized: false,
      databaseMutationAuthorized: false,
      amoMutationAuthorized: false,
    },
  }));
  return {
    digest,
    manifest,
    manifestText: formatManifest(manifest),
    classifications,
    rawAttestation: attestation,
    publicReport: {
      inspector: "amo_deadletter_group_recovery_plan",
      schemaVersion: 1,
      safety: {
        readOnly: true,
        amoMethods: ["GET"],
        databaseMutations: false,
        amoMutations: false,
        requeues: 0,
        piiEmitted: false,
      },
      sourceSha: attestation.sourceSha,
      cohortDigest: digest,
      manifest,
      manifestText: formatManifest(manifest),
      records: publicRecords,
    },
  };
}

function operationId(sourceSha, planDigest, groupPhone, key) {
  return hmacDigest(
    OPERATION_DOMAIN,
    { sourceSha, planDigest, groupPhone },
    key,
  );
}

function advisoryLockKey(sourceSha, planDigest) {
  if (!/^[0-9a-f]{40}$/.test(String(sourceSha || "")))
    fail("SOURCE_SHA_INVALID");
  if (!/^[0-9a-f]{64}$/.test(String(planDigest || "")))
    fail("PLAN_DIGEST_INVALID");
  return createHash("sha256")
    .update(ADVISORY_LOCK_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(sourceSha, "utf8")
    .update("\0", "utf8")
    .update(planDigest, "utf8")
    .digest()
    .readBigInt64BE(0);
}

module.exports = {
  ADVISORY_LOCK_DOMAIN,
  ATTEMPT_LIMIT,
  ERROR_CLASSES,
  EXPECTED_PHONE_GROUPS,
  EXPECTED_QUEUE_ROWS,
  FINAL_AMO_STATUSES,
  PLAN_DOMAIN,
  QUEUE_STATUSES,
  RECOVERY_MARKER_PREFIX,
  RESOLUTION_CLASSES,
  advisoryLockKey,
  buildPlan,
  classifyError,
  classifyGroup,
  dateIso,
  effectiveBroker,
  fail,
  formatManifest,
  groupRowsByPhone,
  hmacDigest,
  networkEvidenceIsAmbiguous,
  normalizePhone,
  operationId,
  positiveInteger,
  reportAlias,
  resolveAgency,
  rowSnapshot,
  stableJson,
  validDate,
};
