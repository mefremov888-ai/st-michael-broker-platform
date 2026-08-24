import { createHash } from "crypto";
import {
  AMO_LEAD_FIELDS,
  AMO_PIPELINES,
  AMO_KC_STATUS,
  AMO_BERZARINA_STATUS,
  AMO_ZORGE_STATUS,
} from "./amo-crm.fields";
import type { AmoLead } from "./amo-crm.adapter";

export const LOYALTY_AMO_RULE_VERSION = "loyalty-amo-v1-2026-08-21";
export const LOYALTY_FIXATION_MARKER = "Заявка от брокера";

export type LoyaltyAmoLinkPath =
  | "DIRECT_BROKER_CONTACT"
  | "STRUCTURED_BROKER_FIELD"
  | "PARENT_KC_LEAD"
  | "VERIFIED_SECONDARY_CONTACT";

export type LoyaltyAmoActivityType = "FIXATION" | "MEETING" | "DEAL";
export type LoyaltyAmoVerdict = "INCLUDED" | "EXCLUDED";

export interface LoyaltyAmoAuditContext {
  brokerKey: string;
  normalizedPhone: string;
  amoContactId: number;
  linkPath: LoyaltyAmoLinkPath | null;
  readAt: string;
}

export interface LoyaltyAmoAuditRow {
  brokerKey: string;
  normalizedPhone: string;
  amoContactId: number;
  amoLeadId: number;
  pipelineId: number | null;
  statusId: number | null;
  type: LoyaltyAmoActivityType;
  verdict: LoyaltyAmoVerdict;
  reasonCode: string;
  rawComment: string | null;
  normalizedComment: string | null;
  amountRub: string | null;
  contractDate: string | null;
  occurredAt: string;
  linkPath: LoyaltyAmoLinkPath | null;
  readAt: string;
  ruleVersion: string;
  sourcePayloadHash: string;
  timestampBasis: "LEAD_CREATED_AT" | "CONTRACT_DATE";
}

function fieldValue(lead: AmoLead, fieldId: number): unknown {
  const field = (lead.custom_fields_values || []).find(
    (item: any) => Number(item?.field_id) === fieldId,
  );
  return field?.values?.[0]?.value ?? null;
}

export function normalizeLoyaltyAmoText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ru-RU");
}

function decimalRub(value: unknown): string | null {
  const normalized = String(value ?? "")
    .replace(/[\s\u00a0]/g, "")
    .replace(",", ".");
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const kopecks =
    BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  if (kopecks <= 0n) return null;
  return `${kopecks / 100n}.${String(kopecks % 100n).padStart(2, "0")}`;
}

function unixDate(value: unknown): string | null {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function leadCreatedAt(lead: AmoLead): string | null {
  return unixDate(lead.created_at);
}

function payloadHash(lead: AmoLead): string {
  const stable = JSON.stringify({
    id: lead.id,
    pipeline_id: lead.pipeline_id ?? null,
    status_id: lead.status_id ?? null,
    created_at: lead.created_at ?? null,
    custom_fields_values: (lead.custom_fields_values || [])
      .map((field: any) => ({
        field_id: Number(field?.field_id),
        values: (field?.values || []).map((value: any) => value?.value ?? null),
      }))
      .sort((a: any, b: any) => a.field_id - b.field_id),
  });
  return createHash("sha256").update(stable).digest("hex");
}

function baseRow(
  lead: AmoLead,
  context: LoyaltyAmoAuditContext,
  type: LoyaltyAmoActivityType,
  occurredAt: string,
  timestampBasis: LoyaltyAmoAuditRow["timestampBasis"],
): Omit<LoyaltyAmoAuditRow, "verdict" | "reasonCode"> {
  const rawCommentValue = fieldValue(lead, AMO_LEAD_FIELDS.COMMENT_TO_REQUEST);
  const rawComment = rawCommentValue == null ? null : String(rawCommentValue);
  const normalizedComment =
    rawComment == null ? null : normalizeLoyaltyAmoText(rawComment);
  return {
    brokerKey: context.brokerKey,
    normalizedPhone: context.normalizedPhone,
    amoContactId: context.amoContactId,
    amoLeadId: Number(lead.id),
    pipelineId: Number.isSafeInteger(lead.pipeline_id)
      ? Number(lead.pipeline_id)
      : null,
    statusId: Number.isSafeInteger(lead.status_id)
      ? Number(lead.status_id)
      : null,
    type,
    rawComment,
    normalizedComment,
    amountRub: decimalRub(fieldValue(lead, AMO_LEAD_FIELDS.PRICE_DDU)),
    contractDate: unixDate(fieldValue(lead, AMO_LEAD_FIELDS.CONTRACT_DATE)),
    occurredAt,
    linkPath: context.linkPath,
    readAt: context.readAt,
    ruleVersion: LOYALTY_AMO_RULE_VERSION,
    sourcePayloadHash: payloadHash(lead),
    timestampBasis,
  };
}

/**
 * Produces auditable INCLUDED/EXCLUDED rows only for pipelines covered by the
 * approved rules. Unknown timestamps are excluded instead of being replaced
 * with updated_at/read time, so period metrics cannot be fabricated.
 */
export function classifyLoyaltyAmoLead(
  lead: AmoLead,
  context: LoyaltyAmoAuditContext,
): LoyaltyAmoAuditRow[] {
  const pipelineId = Number(lead.pipeline_id);
  const statusId = Number(lead.status_id);
  const createdAt = leadCreatedAt(lead);
  const linkVerified = context.linkPath !== null;
  const rows: LoyaltyAmoAuditRow[] = [];

  if (pipelineId === AMO_PIPELINES.KC) {
    const occurredAt = createdAt || context.readAt;
    const fixationBase = baseRow(
      lead,
      context,
      "FIXATION",
      occurredAt,
      "LEAD_CREATED_AT",
    );
    const markerMatches =
      fixationBase.normalizedComment ===
      normalizeLoyaltyAmoText(LOYALTY_FIXATION_MARKER);
    const fixationReason = !createdAt
      ? "FIXATION_TIMESTAMP_MISSING"
      : !markerMatches
        ? "FIXATION_COMMENT_MISMATCH"
        : !linkVerified
          ? "BROKER_LINK_UNVERIFIED"
          : "FIXATION_RULE_MATCH";
    const fixationIncluded =
      createdAt !== null && markerMatches && linkVerified;
    rows.push({
      ...fixationBase,
      verdict: fixationIncluded ? "INCLUDED" : "EXCLUDED",
      reasonCode: fixationReason,
    });

    const meetingBase = baseRow(
      lead,
      context,
      "MEETING",
      occurredAt,
      "LEAD_CREATED_AT",
    );
    const meetingIncluded =
      fixationIncluded && statusId === AMO_KC_STATUS.MEETING_HELD;
    rows.push({
      ...meetingBase,
      verdict: meetingIncluded ? "INCLUDED" : "EXCLUDED",
      reasonCode: !fixationIncluded
        ? fixationReason
        : statusId !== AMO_KC_STATUS.MEETING_HELD
          ? "MEETING_STATUS_MISMATCH"
          : "MEETING_RULE_MATCH",
    });
  }

  const allowedDealStatus =
    (pipelineId === AMO_PIPELINES.BERZARINA &&
      [AMO_BERZARINA_STATUS.PAYMENT_CONTROL, 142].includes(statusId)) ||
    (pipelineId === AMO_PIPELINES.ZORGE9 &&
      [AMO_ZORGE_STATUS.PAYMENT_CONTROL, 142].includes(statusId));
  if (
    pipelineId === AMO_PIPELINES.BERZARINA ||
    pipelineId === AMO_PIPELINES.ZORGE9
  ) {
    const contractDate = unixDate(
      fieldValue(lead, AMO_LEAD_FIELDS.CONTRACT_DATE),
    );
    const occurredAt = contractDate || context.readAt;
    const dealBase = baseRow(
      lead,
      context,
      "DEAL",
      occurredAt,
      "CONTRACT_DATE",
    );
    const reasonCode = !allowedDealStatus
      ? "DEAL_PIPELINE_STATUS_MISMATCH"
      : dealBase.amountRub === null
        ? "DEAL_DDU_AMOUNT_MISSING_OR_NONPOSITIVE"
        : contractDate === null
          ? "DEAL_CONTRACT_DATE_MISSING"
          : !linkVerified
            ? "BROKER_LINK_UNVERIFIED"
            : "DEAL_RULE_MATCH";
    rows.push({
      ...dealBase,
      verdict: reasonCode === "DEAL_RULE_MATCH" ? "INCLUDED" : "EXCLUDED",
      reasonCode,
    });
  }

  return rows;
}
