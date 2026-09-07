import { createHash, createHmac, randomUUID } from "node:crypto";

/**
 * Cross-process lock domain for broker-contact GET -> POST -> DB-link flows.
 * Keep this byte-for-byte domain and phone normalization synchronized with
 * the production one-shot provisioner. Phone scoping also serializes distinct
 * Broker rows that own the same normalized number across primary/alias tables.
 */
export const AMO_BROKER_CONTACT_LOCK_DOMAIN =
  "st-michael:amo-broker-contact-phone-lock:v2";

const AMO_IS_BROKER_FIELD_ID = 835415;
const AMO_BROKER_CONTACT_RECONCILIATION_ATTEMPTS = 6;

export const AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION =
  "AMO_BROKER_CONTACT_CREATE_UNCERTAIN";
export const AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION =
  "AMO_BROKER_CONTACT_CREATE_RESOLVED";
const AMO_BROKER_CONTACT_GATE_ENTITY = "AmoBrokerContactPhone";
const AMO_BROKER_CONTACT_GATE_DIGEST_DOMAIN =
  "st-michael:amo-broker-contact-gate:v1";

export function amoBrokerContactGateDigest(phone: unknown): string {
  const secret = process.env.BROKER_CONTACT_GATE_HMAC_KEY || "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AMO_BROKER_CONTACT_GATE_HMAC_KEY_INVALID");
  }
  return createHmac("sha256", secret)
    .update(AMO_BROKER_CONTACT_GATE_DIGEST_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(normalizeAmoBrokerContactLockPhone(phone), "utf8")
    .digest("hex");
}

export function isAmoBrokerContact(contact: any): boolean {
  const fields = Array.isArray(contact?.custom_fields_values)
    ? contact.custom_fields_values
    : [];
  const brokerField = fields.find(
    (field: any) => Number(field?.field_id) === AMO_IS_BROKER_FIELD_ID,
  );
  return brokerField?.values?.[0]?.value === true;
}

export function isDefinitiveAmoContactCreateRejection(error: unknown): boolean {
  const message = String((error as any)?.message || error || "");
  return (
    /^amoCRM (400|401|403|404|422) \/contacts(?:$|:)/.test(message) ||
    message === "AMO_ACCESS_TOKEN not configured"
  );
}

export async function reconcileExactAmoBrokerContact({
  lookup,
  expectedContactId = null,
  sleepImpl = (milliseconds: number) =>
    new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, milliseconds),
    ),
}: {
  lookup: () => Promise<any>;
  expectedContactId?: number | null;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}): Promise<any | null> {
  for (
    let attempt = 1;
    attempt <= AMO_BROKER_CONTACT_RECONCILIATION_ATTEMPTS;
    attempt += 1
  ) {
    const contact = await lookup();
    if (contact) {
      const contactId = Number(contact.id);
      if (
        !Number.isSafeInteger(contactId) ||
        contactId <= 0 ||
        (expectedContactId !== null && contactId !== expectedContactId)
      ) {
        throw new Error("AMO_BROKER_CONTACT_RECONCILIATION_ID_MISMATCH");
      }
      if (isAmoBrokerContact(contact)) return contact;
    }
    if (attempt < AMO_BROKER_CONTACT_RECONCILIATION_ATTEMPTS) {
      await sleepImpl(400 * 2 ** (attempt - 1));
    }
  }
  return null;
}

export async function getUnresolvedAmoBrokerContactCreateGate(
  database: any,
  phone: unknown,
): Promise<string | null> {
  const events = await database.auditLog.findMany({
    where: {
      entity: AMO_BROKER_CONTACT_GATE_ENTITY,
      entityId: amoBrokerContactGateDigest(phone),
      action: {
        in: [
          AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
          AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION,
        ],
      },
    },
    select: { action: true, payload: true },
  });
  const armed = new Set<string>();
  const resolved = new Set<string>();
  for (const event of events) {
    const gateId = String(event?.payload?.gateId || "");
    if (!/^[0-9a-f-]{36}$/.test(gateId)) continue;
    if (event.action === AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION)
      armed.add(gateId);
    if (event.action === AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION)
      resolved.add(gateId);
  }
  const unresolved = [...armed].filter((gateId) => !resolved.has(gateId));
  if (unresolved.length > 1)
    throw new Error("AMO_BROKER_CONTACT_GATE_AMBIGUOUS");
  return unresolved[0] || null;
}

export async function hasUnresolvedAmoBrokerContactCreate(
  database: any,
  phone: unknown,
): Promise<boolean> {
  return Boolean(
    await getUnresolvedAmoBrokerContactCreateGate(database, phone),
  );
}

/**
 * Commit the fail-safe gate outside the caller's long interactive transaction.
 * The caller must already hold the shared advisory + broker row lock. If the
 * process or transaction dies after this commit, a later lock holder observes
 * the marker and cannot issue another POST.
 */
export async function armDurableAmoBrokerContactCreateGate(
  database: any,
  phone: unknown,
): Promise<string> {
  const gateId = randomUUID();
  await database.auditLog.create({
    data: {
      userId: null,
      action: AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
      entity: AMO_BROKER_CONTACT_GATE_ENTITY,
      entityId: amoBrokerContactGateDigest(phone),
      payload: {
        gateVersion: 1,
        gateId,
        reason: "PRE_MUTATION_DURABLE_GATE",
        automaticRetryBlocked: true,
      },
    },
  });
  return gateId;
}

export async function recordResolvedAmoBrokerContactCreate(
  database: any,
  phone: unknown,
  gateId: string,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(gateId)) {
    throw new Error("AMO_BROKER_CONTACT_GATE_ID_INVALID");
  }
  await database.auditLog.create({
    data: {
      userId: null,
      action: AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION,
      entity: AMO_BROKER_CONTACT_GATE_ENTITY,
      entityId: amoBrokerContactGateDigest(phone),
      payload: {
        gateVersion: 1,
        gateId,
        automaticRetryBlocked: false,
      },
    },
  });
}

export function normalizeAmoBrokerContactLockPhone(phone: unknown): string {
  const trimmed = String(phone ?? "").trim();
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("77")) {
    digits = digits.slice(1);
  } else if (digits.length === 11 && digits.startsWith("77")) {
    throw new Error("AMO_BROKER_CONTACT_LOCK_PHONE_INVALID");
  } else if (digits.length === 11 && digits.startsWith("8")) {
    digits = `7${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `7${digits}`;
  }
  if (!/^7\d{10}$/.test(digits)) {
    throw new Error("AMO_BROKER_CONTACT_LOCK_PHONE_INVALID");
  }
  return `+${digits}`;
}

export function amoBrokerContactAdvisoryLockKey(phone: unknown): bigint {
  const normalizedPhone = normalizeAmoBrokerContactLockPhone(phone);
  return createHash("sha256")
    .update(AMO_BROKER_CONTACT_LOCK_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(normalizedPhone, "utf8")
    .digest()
    .readBigInt64BE(0);
}

export async function acquireAmoBrokerContactAdvisoryXactLock(
  transaction: {
    $executeRaw: (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
    $queryRaw: (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
  },
  brokerId: string,
  phone: unknown,
): Promise<bigint> {
  if (
    !transaction ||
    typeof transaction.$executeRaw !== "function" ||
    typeof transaction.$queryRaw !== "function"
  ) {
    throw new Error("AMO_BROKER_CONTACT_LOCK_TRANSACTION_INVALID");
  }
  const key = amoBrokerContactAdvisoryLockKey(phone);
  // pg_advisory_xact_lock returns void. Prisma $queryRaw tries to deserialize
  // that column and throws P2010 immediately. $executeRaw ignores the result.
  // Cast the signed int64 key so a driver that binds BigInt as text still
  // matches pg_advisory_xact_lock(bigint), not a missing text overload.
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
  // Serializable snapshots may be established while waiting for the advisory
  // lock. Locking the broker row immediately afterwards makes PostgreSQL raise
  // a serialization failure (before any amo HTTP call) instead of allowing a
  // stale pre-lock Broker.amoContactId read after a peer committed.
  const brokerRows =
    await transaction.$queryRaw`SELECT id FROM brokers WHERE id = ${brokerId} FOR UPDATE`;
  if (!Array.isArray(brokerRows) || brokerRows.length !== 1) {
    throw new Error("AMO_BROKER_CONTACT_LOCK_BROKER_MISSING");
  }
  return key;
}
