import type { PrismaClient } from "@st-michael/database";
import { normalizeAmoFixationClientPhone } from "@st-michael/integrations";
import {
  AMO_CREATE_RECONCILIATION_REQUIRED_MARKER,
  AMO_RETRY_MAX_ATTEMPTS,
} from "./amo-sync-retry";

type AmoPhoneStatePrisma = Pick<PrismaClient, "$queryRaw">;

function requireOptionalClientId(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("AMO_FIXATION_PHONE_STATE_RESULT_INVALID");
  }
  if (rows.length === 0) return null;
  const id = (rows[0] as any)?.id;
  if (typeof id !== "string" || !id) {
    throw new Error("AMO_FIXATION_PHONE_STATE_RESULT_INVALID");
  }
  return id;
}

function normalizedPhoneSuffix(phone: unknown): string {
  return normalizeAmoFixationClientPhone(phone).slice(-10);
}

/**
 * Finds durable evidence that a lead POST for this normalized phone is still
 * unresolved. The expression is backed by clients_normalized_phone_suffix_idx
 * and LIMIT 1 keeps UI requests bounded even with a large dead-letter table.
 */
export async function findUnresolvedSamePhoneAmoClient(
  prisma: AmoPhoneStatePrisma,
  phone: unknown,
  excludeClientId?: string,
): Promise<string | null> {
  const phoneSuffix = normalizedPhoneSuffix(phone);
  const reconciliationPattern =
    `${AMO_CREATE_RECONCILIATION_REQUIRED_MARKER}%`;
  const recoveryPattern = "%RECOVERY_PENDING%";
  const rows = excludeClientId
    ? await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "clients"
        WHERE right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ${phoneSuffix}
          AND "id" <> ${excludeClientId}
          AND "amo_lead_id" IS NULL
          AND (
            "amo_sync_attempts" >= ${AMO_RETRY_MAX_ATTEMPTS}
            OR "amo_sync_error" LIKE ${reconciliationPattern}
            OR "amo_sync_error" LIKE ${recoveryPattern}
          )
        LIMIT 1
      `
    : await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "clients"
        WHERE right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ${phoneSuffix}
          AND "amo_lead_id" IS NULL
          AND (
            "amo_sync_attempts" >= ${AMO_RETRY_MAX_ATTEMPTS}
            OR "amo_sync_error" LIKE ${reconciliationPattern}
            OR "amo_sync_error" LIKE ${recoveryPattern}
          )
        LIMIT 1
      `;
  return requireOptionalClientId(rows);
}

/**
 * A local link absent from the exhaustive amo verdict proves that the verdict
 * is stale. This distinguishes a newly linked sibling from historical closed
 * leads already reflected in RULE_3.
 */
export async function findUnreflectedLinkedSamePhoneAmoClient(
  prisma: AmoPhoneStatePrisma,
  phone: unknown,
  excludeClientId: string,
  reflectedAmoLeadIds: number[],
): Promise<string | null> {
  if (!excludeClientId) {
    throw new Error("AMO_FIXATION_PHONE_STATE_CLIENT_ID_INVALID");
  }
  if (
    reflectedAmoLeadIds.some(
      (id) => !Number.isSafeInteger(id) || id <= 0,
    ) || new Set(reflectedAmoLeadIds).size !== reflectedAmoLeadIds.length
  ) {
    throw new Error("AMO_FIXATION_PHONE_STATE_LEAD_IDS_INVALID");
  }
  const phoneSuffix = normalizedPhoneSuffix(phone);
  const reflectedLeadIdsJson = JSON.stringify(
    reflectedAmoLeadIds.map(String),
  );
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "clients"
    WHERE right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ${phoneSuffix}
      AND "id" <> ${excludeClientId}
      AND "amo_lead_id" IS NOT NULL
      AND "amo_lead_id"::text NOT IN (
        SELECT jsonb_array_elements_text(${reflectedLeadIdsJson}::jsonb)
      )
    LIMIT 1
  `;
  return requireOptionalClientId(rows);
}
