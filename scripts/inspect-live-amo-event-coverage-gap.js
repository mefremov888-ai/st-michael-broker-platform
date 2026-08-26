#!/usr/bin/env node
/**
 * PII-safe live amoCRM event-coverage gap report.
 *
 * This inspector reuses the complete GET-only traversal implemented by the
 * live source aggregate inspector. It describes current observable evidence
 * and the exact reasons why that evidence cannot attest a complete historical
 * event ledger. Raw entities and source identifiers never leave the process.
 */

"use strict";

const { createHash } = require("crypto");
const source = require("./inspect-live-amo-source-aggregates.js");

const REPORT_NAME = "live_amocrm_event_coverage_gap";
const SCHEMA_VERSION = 1;
const RULE_VERSION = "loyalty-amo-event-gap-v1-2026-08-26";
const LEGACY_FIXATION_MARKER = "Заявка от брокера";
const LEDGER_CANONICALIZATION =
  "typed-length-prefixed-v1_sorted-type-entity-id";

const OBSERVED_EVIDENCE_TYPES = Object.freeze([
  "FIXATION",
  "MEETING",
  "DEAL",
  "BROKER_TOUR",
]);

const REQUIRED_BLOCKERS = Object.freeze([
  "SEQUENTIAL_NON_TRANSACTIONAL_SCAN",
  "CURRENT_STATE_NOT_HISTORICAL_EVENT_LEDGER",
  "TARGET_RECORD_POPULATION_NOT_BOUND",
  "ACTIVITY_RULE_VERSION_NOT_RECONCILED",
  "MEETING_COMPLETION_NOT_EVENT_PROVEN",
  "BROKER_TOUR_HISTORY_COLLAPSED_TO_CONTACT_FIELDS",
  "CALL_EVENT_SOURCE_NOT_SCANNED",
  "SYNC_RUN_NOT_PERSISTED",
]);

const CONDITIONAL_BLOCKERS = Object.freeze({
  BROKER_LINK: "BROKER_LINK_COVERAGE_INCOMPLETE",
  EVENT_TIMESTAMP: "EVENT_TIMESTAMP_COVERAGE_INCOMPLETE",
  DEAL_EVIDENCE: "DEAL_EVIDENCE_INCOMPLETE",
});

const OWN_FAILURE_CODE_BY_MESSAGE = new Map([
  ["Invalid event evidence observation", "INVALID_EVIDENCE_OBSERVATION"],
  ["Duplicate event evidence observation", "DUPLICATE_EVIDENCE_OBSERVATION"],
  ["Source report invariant failed", "SOURCE_REPORT_INVARIANT_FAILED"],
  ["Invalid scan observer callbacks", "INVALID_SCAN_OBSERVER_CALLBACKS"],
]);

let activeFailurePhase = "ACCOUNT";

function classifyFailure(error) {
  try {
    if (
      error !== null &&
      (typeof error === "object" || typeof error === "function") &&
      typeof error.message === "string"
    ) {
      const ownCode = OWN_FAILURE_CODE_BY_MESSAGE.get(error.message);
      if (ownCode) return ownCode;
    }
  } catch {
    return "UNKNOWN_FAILURE";
  }
  return source.classifyFailure(error);
}

function normalizeMarkerText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function hasLegacyCommentMarker(lead) {
  const expected = normalizeMarkerText(LEGACY_FIXATION_MARKER);
  return source
    .customValues(lead, source.LEAD_FIELDS.COMMENT_TO_REQUEST)
    .some((item) => normalizeMarkerText(item?.value) === expected);
}

function validCreatedAt(value) {
  const number = Number(value);
  return (
    Number.isSafeInteger(number) &&
    number >= 946_684_800 &&
    number <= 4_133_980_800
  );
}

function increment(object, key, amount = 1) {
  object[key] = Number(object[key] || 0) + amount;
}

function sortedPositiveIds(values) {
  return [
    ...new Set((values || []).map(source.positiveInteger).filter(Boolean)),
  ].sort((left, right) => left - right);
}

function validMoneyKeys(lead) {
  return [
    ...new Set(
      source
        .customValues(lead, source.LEAD_FIELDS.DDU_AMOUNT)
        .map((item) => source.parseMoneyToCents(item?.value))
        .filter((value) => value !== null)
        .map(String),
    ),
  ].sort();
}

function validDateKeys(lead, fieldId) {
  return [
    ...new Set(
      source
        .customValues(lead, fieldId)
        .map((item) => source.normalizedDateKey(item?.value))
        .filter(Boolean),
    ),
  ].sort();
}

function referenceIds(lead, fieldId) {
  return sortedPositiveIds(
    source
      .customValues(lead, fieldId)
      .flatMap((item) => source.parseReferenceIds(item?.value)),
  );
}

function updateTypedLengthPrefixed(hash, type, value) {
  const typeBytes = Buffer.from(String(type), "utf8");
  const valueBytes = Buffer.from(String(value), "utf8");
  hash.update(`${typeBytes.length}:`);
  hash.update(typeBytes);
  hash.update(`${valueBytes.length}:`);
  hash.update(valueBytes);
}

function evidenceLedger(entries) {
  const typeOrder = new Map(
    OBSERVED_EVIDENCE_TYPES.map((type, index) => [type, index]),
  );
  const ordered = [...entries].sort((left, right) => {
    const byType = typeOrder.get(left.type) - typeOrder.get(right.type);
    return byType || left.entityId - right.entityId;
  });
  const hash = createHash("sha256");
  updateTypedLengthPrefixed(hash, "ledger_schema", RULE_VERSION);
  for (const entry of ordered) {
    updateTypedLengthPrefixed(hash, "evidence_type", entry.type);
    updateTypedLengthPrefixed(hash, "source_entity_id", entry.entityId);
    updateTypedLengthPrefixed(
      hash,
      "allowlisted_evidence",
      JSON.stringify(entry.evidence),
    );
  }
  return {
    kind: "current_observable_event_evidence",
    rowCount: ordered.length,
    algorithm: "sha256",
    canonicalization: LEDGER_CANONICALIZATION,
    sha256: hash.digest("hex"),
    hashInputIncludesOpaqueSourceEntityIds: true,
    sourceEntityIdsEmitted: false,
    completeHistoricalLedger: false,
  };
}

function createEvidenceCollector() {
  const brokerContactIds = new Set();
  const evidenceKeys = new Set();
  const entries = [];
  const pipelineCounts = Object.fromEntries(
    Object.keys(source.PIPELINES).map((label) => [label, 0]),
  );
  const counters = {
    contactsScanned: 0,
    brokerContactsScanned: 0,
    leadsScanned: 0,
    pipelines: pipelineCounts,
    fixation: {
      strictMarkerLeadRows: 0,
      strictMarkerAndBrokerLinkedRows: 0,
      strictMarkerWithoutBrokerLinkRows: 0,
      linkedRows: { validCreatedAt: 0, missingCreatedAt: 0 },
      legacyCommentMarkerRows: 0,
      markerRuleDisagreementRows: 0,
      ledgerRows: 0,
    },
    meeting: {
      candidateRows: 0,
      dateCoverage: { valid: 0, missing: 0, invalid: 0 },
      currentHeldOrLaterStageRows: 0,
      validDateAndHeldOrLaterStageRows: 0,
      ledgerRows: 0,
    },
    dealLedgerRows: 0,
    brokerTour: {
      markedContacts: 0,
      dateCoverage: { valid: 0, missing: 0, invalid: 0 },
      ledgerRows: 0,
    },
  };

  function addEvidence(type, entityId, evidence) {
    if (
      !OBSERVED_EVIDENCE_TYPES.includes(type) ||
      !source.positiveInteger(entityId)
    ) {
      throw new Error("Invalid event evidence observation");
    }
    const key = `${type}:${entityId}`;
    if (evidenceKeys.has(key)) {
      throw new Error("Duplicate event evidence observation");
    }
    evidenceKeys.add(key);
    entries.push({ type, entityId, evidence });
  }

  async function onContact(contact) {
    const contactId = source.positiveInteger(contact?.id);
    if (!contactId) throw new Error("Invalid event evidence observation");
    counters.contactsScanned += 1;
    const brokerMarked = source.isTruthyCheckbox(
      contact,
      source.CONTACT_FIELDS.IS_BROKER,
    );
    if (!brokerMarked) return;
    counters.brokerContactsScanned += 1;
    brokerContactIds.add(contactId);

    const tourMarked = source.isTruthyCheckbox(
      contact,
      source.CONTACT_FIELDS.TOUR_VISITED,
    );
    if (!tourMarked) return;
    counters.brokerTour.markedContacts += 1;
    const dateCoverage = source.fieldCoverage(
      contact,
      source.CONTACT_FIELDS.TOUR_DATE,
      source.validDateValue,
    );
    increment(counters.brokerTour.dateCoverage, dateCoverage);
    counters.brokerTour.ledgerRows += 1;
    addEvidence("BROKER_TOUR", contactId, {
      dateCoverage,
      validTourDates: validDateKeys(contact, source.CONTACT_FIELDS.TOUR_DATE),
    });
  }

  async function onLead(pipelineLabel, lead) {
    const leadId = source.positiveInteger(lead?.id);
    const expectedPipelineId = source.PIPELINES[pipelineLabel];
    const statusId = source.positiveInteger(lead?.status_id);
    if (
      !leadId ||
      !expectedPipelineId ||
      Number(lead?.pipeline_id) !== expectedPipelineId ||
      !statusId
    ) {
      throw new Error("Invalid event evidence observation");
    }
    counters.leadsScanned += 1;
    counters.pipelines[pipelineLabel] += 1;
    if (!source.CLIENT_PIPELINE_LABELS.includes(pipelineLabel)) return;

    const relations = source.embeddedContactRelations(lead);
    if (relations === null) {
      throw new Error("Invalid event evidence observation");
    }
    const linkedContactIds = sortedPositiveIds(
      relations.map((relation) => relation.id),
    );
    const linkedBrokerIds = linkedContactIds.filter((contactId) =>
      brokerContactIds.has(contactId),
    );
    const brokerLinked = linkedBrokerIds.length > 0;
    const strictMarker = source.hasStrictBrokerSource(lead);
    const legacyCommentMarker = hasLegacyCommentMarker(lead);
    const createdAtValid = validCreatedAt(lead?.created_at);

    if (strictMarker) counters.fixation.strictMarkerLeadRows += 1;
    if (legacyCommentMarker) counters.fixation.legacyCommentMarkerRows += 1;
    if (strictMarker !== legacyCommentMarker) {
      counters.fixation.markerRuleDisagreementRows += 1;
    }
    if (strictMarker && brokerLinked) {
      counters.fixation.strictMarkerAndBrokerLinkedRows += 1;
      increment(
        counters.fixation.linkedRows,
        createdAtValid ? "validCreatedAt" : "missingCreatedAt",
      );
    } else if (strictMarker) {
      counters.fixation.strictMarkerWithoutBrokerLinkRows += 1;
    }
    if (strictMarker || legacyCommentMarker) {
      counters.fixation.ledgerRows += 1;
      addEvidence("FIXATION", leadId, {
        pipeline: pipelineLabel,
        statusId,
        strictMarker,
        legacyCommentMarker,
        brokerLinked,
        createdAtValid,
        createdAt: createdAtValid ? Number(lead.created_at) : null,
        linkedContactIds,
        linkedBrokerIds,
      });
    }

    if (!strictMarker || !brokerLinked) return;
    counters.meeting.candidateRows += 1;
    const meetingDateCoverage = source.fieldCoverage(
      lead,
      source.LEAD_FIELDS.MEETING_AT,
      source.validDateValue,
    );
    increment(counters.meeting.dateCoverage, meetingDateCoverage);
    const heldOrLater =
      source.MEETING_HELD_OR_LATER_STATUS[pipelineLabel].has(statusId);
    if (heldOrLater) counters.meeting.currentHeldOrLaterStageRows += 1;
    if (heldOrLater && meetingDateCoverage === "valid") {
      counters.meeting.validDateAndHeldOrLaterStageRows += 1;
    }
    counters.meeting.ledgerRows += 1;
    addEvidence("MEETING", leadId, {
      pipeline: pipelineLabel,
      statusId,
      meetingDateCoverage,
      heldOrLater,
      validMeetingDates: validDateKeys(lead, source.LEAD_FIELDS.MEETING_AT),
      linkedContactIds,
      linkedBrokerIds,
    });

    if (!source.SALES_DEAL_OR_LATER_STATUS[pipelineLabel]?.has(statusId)) {
      return;
    }
    counters.dealLedgerRows += 1;
    addEvidence("DEAL", leadId, {
      pipeline: pipelineLabel,
      statusId,
      dduAmountCoverage: source.fieldCoverage(
        lead,
        source.LEAD_FIELDS.DDU_AMOUNT,
        (value) => source.parseMoneyToCents(value) !== null,
      ),
      validDduAmountCents: validMoneyKeys(lead),
      contractDateCoverage: source.fieldCoverage(
        lead,
        source.LEAD_FIELDS.CONTRACT_DATE,
        source.validDateValue,
      ),
      validContractDates: validDateKeys(lead, source.LEAD_FIELDS.CONTRACT_DATE),
      parentReferenceIds: referenceIds(lead, source.LEAD_FIELDS.CC_ID_PARENT),
      brokerCopyReferenceIds: referenceIds(
        lead,
        source.LEAD_FIELDS.BROKER_PIPELINE_LINK,
      ),
      linkedContactIds,
      linkedBrokerIds,
    });
  }

  function snapshot() {
    return {
      contactsScanned: counters.contactsScanned,
      brokerContactsScanned: counters.brokerContactsScanned,
      leadsScanned: counters.leadsScanned,
      pipelines: { ...counters.pipelines },
      fixation: {
        ...counters.fixation,
        linkedRows: { ...counters.fixation.linkedRows },
      },
      meeting: {
        ...counters.meeting,
        dateCoverage: { ...counters.meeting.dateCoverage },
      },
      dealLedgerRows: counters.dealLedgerRows,
      brokerTour: {
        ...counters.brokerTour,
        dateCoverage: { ...counters.brokerTour.dateCoverage },
      },
      evidenceLedger: evidenceLedger(entries),
    };
  }

  return { onContact, onLead, snapshot };
}

function totalCoverage(coverage, keys) {
  return keys.reduce((sum, key) => sum + Number(coverage?.[key] || 0), 0);
}

function assertSourceReport(sourceReport, observed) {
  const clientLeadTotal = source.CLIENT_PIPELINE_LABELS.reduce(
    (sum, label) => sum + observed.pipelines[label],
    0,
  );
  const sourceMeetingCoverage =
    sourceReport?.meetings?.explicitMeetingDateCoverage;
  const sourceTour = sourceReport?.contacts?.brokerTour;
  const invariants = [
    sourceReport?.report === "live_amocrm_source_aggregate",
    sourceReport?.schemaVersion === 1,
    sourceReport?.safety?.accountIdentityVerified === true,
    sourceReport?.safety?.httpMethods?.length === 1,
    sourceReport?.safety?.httpMethods?.[0] === "GET",
    sourceReport?.contacts?.total === observed.contactsScanned,
    sourceReport?.contacts?.brokersMarked === observed.brokerContactsScanned,
    sourceReport?.brokerPipeline?.totalCurrentLeads ===
      observed.pipelines.brokers,
    sourceReport?.clientPipelines?.all?.totalCurrentLeads === clientLeadTotal,
    observed.leadsScanned === clientLeadTotal + observed.pipelines.brokers,
    sourceReport?.clientPipelines?.all?.strictSourceMarked ===
      observed.fixation.strictMarkerLeadRows,
    sourceReport?.clientPipelines?.all?.strictSourceAndBrokerLinked ===
      observed.fixation.strictMarkerAndBrokerLinkedRows,
    sourceReport?.clientPipelines?.all?.strictSourceWithoutBrokerLink ===
      observed.fixation.strictMarkerWithoutBrokerLinkRows,
    sourceReport?.meetings?.qualifyingCurrentLeadRows ===
      observed.meeting.candidateRows,
    sourceMeetingCoverage?.valid === observed.meeting.dateCoverage.valid,
    sourceMeetingCoverage?.missing === observed.meeting.dateCoverage.missing,
    sourceMeetingCoverage?.invalid === observed.meeting.dateCoverage.invalid,
    sourceReport?.meetings?.currentMeetingHeldStageProxy?.total ===
      observed.meeting.currentHeldOrLaterStageRows,
    sourceTour?.markedVisited === observed.brokerTour.markedContacts,
    sourceTour?.markedVisitedWithValidDate ===
      observed.brokerTour.dateCoverage.valid,
    sourceTour?.markedVisitedWithoutValidDate ===
      observed.brokerTour.dateCoverage.missing +
        observed.brokerTour.dateCoverage.invalid,
    sourceReport?.deals?.rawQualifyingLeadRows === observed.dealLedgerRows,
    observed.evidenceLedger.rowCount ===
      observed.fixation.ledgerRows +
        observed.meeting.ledgerRows +
        observed.dealLedgerRows +
        observed.brokerTour.ledgerRows,
  ];
  if (invariants.some((value) => value !== true)) {
    throw new Error("Source report invariant failed");
  }
}

function buildReport(sourceReport, observed) {
  assertSourceReport(sourceReport, observed);
  const dealAmountCoverage =
    sourceReport.deals.dduAmount.coverageByDeduplicatedGroup;
  const dealDateCoverage =
    sourceReport.deals.contractDate.coverageByDeduplicatedGroup;
  const conditionalBlockers = [];

  if (observed.fixation.strictMarkerWithoutBrokerLinkRows > 0) {
    conditionalBlockers.push(CONDITIONAL_BLOCKERS.BROKER_LINK);
  }
  const timestampIncomplete =
    observed.fixation.linkedRows.missingCreatedAt > 0 ||
    totalCoverage(observed.meeting.dateCoverage, ["missing", "invalid"]) > 0 ||
    totalCoverage(observed.brokerTour.dateCoverage, ["missing", "invalid"]) >
      0 ||
    totalCoverage(dealDateCoverage, ["missing", "invalid"]) > 0;
  if (timestampIncomplete) {
    conditionalBlockers.push(CONDITIONAL_BLOCKERS.EVENT_TIMESTAMP);
  }
  const dealEvidenceIncomplete =
    totalCoverage(dealAmountCoverage, ["missing", "invalid", "conflicting"]) >
      0 ||
    totalCoverage(dealDateCoverage, ["missing", "invalid"]) > 0 ||
    sourceReport.deals.dedupEvidenceCoverage
      .candidatesWithUncorroboratedClientRelationOnly > 0;
  if (dealEvidenceIncomplete) {
    conditionalBlockers.push(CONDITIONAL_BLOCKERS.DEAL_EVIDENCE);
  }

  return {
    report: REPORT_NAME,
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: RULE_VERSION,
    generatedAt: sourceReport.generatedAt,
    safety: {
      source: "live_amocrm_api",
      accountIdentityVerified: true,
      httpMethods: ["GET"],
      oauthRefreshAttempted: false,
      brokerPlatformDatabaseUsed: false,
      nestApplicationBootstrapped: false,
      syncRunPersisted: false,
      rawResponsesEmitted: false,
      rawEntityIdentifiersEmitted: false,
      namesPhonesEmailsOrUrlsEmitted: false,
      perRecordRowsEmitted: false,
      completeTraversalRequired: true,
    },
    scan: {
      transactionalSnapshot: false,
      currentStateOnly: true,
      contactsScanned: observed.contactsScanned,
      brokerContactsScanned: observed.brokerContactsScanned,
      leadsScanned: observed.leadsScanned,
      pipelines: observed.pipelines,
    },
    coverageDecision: {
      eventCoverageComplete: false,
      fullSnapshotAttestable: false,
      coveredRecords: null,
      attestedActivityTypes: [],
      observedEvidenceTypes: [...OBSERVED_EVIDENCE_TYPES],
      blockers: [...REQUIRED_BLOCKERS, ...conditionalBlockers],
    },
    counts: {
      FIXATION: {
        strictMarkerLeadRows: observed.fixation.strictMarkerLeadRows,
        strictMarkerAndBrokerLinkedRows:
          observed.fixation.strictMarkerAndBrokerLinkedRows,
        strictMarkerWithoutBrokerLinkRows:
          observed.fixation.strictMarkerWithoutBrokerLinkRows,
        linkedRows: observed.fixation.linkedRows,
        legacyCommentMarkerRows: observed.fixation.legacyCommentMarkerRows,
        markerRuleDisagreementRows:
          observed.fixation.markerRuleDisagreementRows,
        historicalIncludedEvents: null,
        accuracy: "UNKNOWN",
      },
      MEETING: {
        candidateRows: observed.meeting.candidateRows,
        dateCoverage: observed.meeting.dateCoverage,
        currentHeldOrLaterStageRows:
          observed.meeting.currentHeldOrLaterStageRows,
        validDateAndHeldOrLaterStageRows:
          observed.meeting.validDateAndHeldOrLaterStageRows,
        historicalIncludedEvents: null,
        accuracy: "UNKNOWN",
      },
      DEAL: {
        rawCandidateLeadRows: sourceReport.deals.rawQualifyingLeadRows,
        deduplicatedCandidateGroups: sourceReport.deals.deduplicatedDealGroups,
        duplicateRowsCollapsed: sourceReport.deals.duplicateLeadRowsCollapsed,
        dduAmountCoverage: dealAmountCoverage,
        contractDateCoverage: dealDateCoverage,
        unambiguousCurrentSumRub:
          sourceReport.deals.dduAmount.unambiguousSumRub,
        historicalIncludedEvents: null,
        accuracy: "UNKNOWN",
      },
      BROKER_TOUR: {
        markedContacts: observed.brokerTour.markedContacts,
        dateCoverage: observed.brokerTour.dateCoverage,
        historicalIncludedEvents: null,
        accuracy: "UNKNOWN",
      },
      CALL: {
        sourceScanned: false,
        candidateRows: null,
        historicalIncludedEvents: null,
        accuracy: "UNKNOWN",
      },
    },
    evidenceLedger: observed.evidenceLedger,
  };
}

async function main() {
  activeFailurePhase = "ACCOUNT";
  const collector = createEvidenceCollector();
  const request = source.createGetOnlyRequester(process.env.AMO_ACCESS_TOKEN);
  const sourceReport = await source.scanLiveAmo(
    request,
    (phase) => {
      activeFailurePhase = phase;
    },
    { onContact: collector.onContact, onLead: collector.onLead },
  );
  activeFailurePhase = "REPORT";
  const report = buildReport(sourceReport, collector.snapshot());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

module.exports = {
  CONDITIONAL_BLOCKERS,
  LEDGER_CANONICALIZATION,
  OBSERVED_EVIDENCE_TYPES,
  REPORT_NAME,
  REQUIRED_BLOCKERS,
  RULE_VERSION,
  buildReport,
  classifyFailure,
  createEvidenceCollector,
  evidenceLedger,
  hasLegacyCommentMarker,
  validCreatedAt,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `failure_phase=${activeFailurePhase}\nfailure_code=${classifyFailure(error)}\n`,
    );
    process.exitCode = 1;
  });
}
