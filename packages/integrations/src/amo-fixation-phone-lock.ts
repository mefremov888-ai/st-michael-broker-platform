import { createHash } from "node:crypto";

/**
 * This prefix is already deployed by ClientFixationSafetyService. Keep it
 * stable: completed UI idempotency records and in-flight scheduler/recovery
 * leases must remain mutually exclusive across rolling deploys.
 */
export const AMO_FIXATION_PHONE_LOCK_REDIS_PREFIX =
  "client-fixation:semantic:";

/**
 * Canonical Russian client-phone identity shared by the API, scheduler and
 * one-shot recovery tooling. It intentionally mirrors the accepted fixation
 * DTO while tolerating historical 8/10/12-digit representations in the DB.
 */
export function normalizeAmoFixationClientPhone(phone: unknown): string {
  const trimmed = String(phone ?? "").trim();
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("77")) {
    digits = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith("8")) {
    digits = `7${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `7${digits}`;
  }
  if (!/^7\d{10}$/.test(digits)) {
    throw new Error("AMO_FIXATION_PHONE_LOCK_PHONE_INVALID");
  }
  return `+${digits}`;
}

/**
 * Byte-for-byte compatible with the previously deployed
 * clientFixationSemanticFingerprint for a canonical fixation DTO.
 */
export function amoFixationPhoneLockFingerprint(phone: unknown): string {
  const normalizedPhone = normalizeAmoFixationClientPhone(phone);
  return createHash("sha256")
    .update(JSON.stringify({ phone: normalizedPhone }), "utf8")
    .digest("hex");
}

export function amoFixationPhoneLockRedisKey(phone: unknown): string {
  return `${AMO_FIXATION_PHONE_LOCK_REDIS_PREFIX}${amoFixationPhoneLockFingerprint(phone)}`;
}
