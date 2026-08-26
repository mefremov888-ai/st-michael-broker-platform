import { createHash } from "node:crypto";

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

export async function hasUnresolvedAmoBrokerContactCreate(
  transaction: any,
  brokerId: string,
): Promise<boolean> {
  const latest = await transaction.auditLog.findFirst({
    where: {
      entity: "Broker",
      entityId: brokerId,
      action: {
        in: [
          AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
          AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION,
        ],
      },
    },
    select: { action: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return latest?.action === AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION;
}

export async function recordUncertainAmoBrokerContactCreate(
  transaction: any,
  brokerId: string,
): Promise<void> {
  await transaction.auditLog.create({
    data: {
      userId: null,
      action: AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
      entity: "Broker",
      entityId: brokerId,
      payload: {
        reason: "AMBIGUOUS_POST_RESULT",
        automaticRetryBlocked: true,
      },
    },
  });
  // The row write is intentional: a Serializable transaction that waited on
  // the advisory lock with an older snapshot must fail before it can miss the
  // newly committed durable marker and send another POST.
  await transaction.broker.update({
    where: { id: brokerId },
    data: { updatedAt: new Date() },
  });
}

/**
 * Commit the fail-safe gate outside the caller's long interactive transaction.
 * The caller must already hold the shared advisory + broker row lock. If the
 * process or transaction dies after this commit, a later lock holder observes
 * the marker and cannot issue another POST.
 */
export async function armDurableAmoBrokerContactCreateGate(
  database: any,
  brokerId: string,
): Promise<void> {
  await database.auditLog.create({
    data: {
      userId: null,
      action: AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
      entity: "Broker",
      entityId: brokerId,
      payload: {
        reason: "PRE_MUTATION_DURABLE_GATE",
        automaticRetryBlocked: true,
      },
    },
  });
}

export async function recordResolvedAmoBrokerContactCreate(
  transaction: any,
  brokerId: string,
): Promise<void> {
  await transaction.auditLog.create({
    data: {
      userId: null,
      action: AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION,
      entity: "Broker",
      entityId: brokerId,
      payload: {
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
    $queryRaw: (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
  },
  brokerId: string,
  phone: unknown,
): Promise<bigint> {
  if (!transaction || typeof transaction.$queryRaw !== "function") {
    throw new Error("AMO_BROKER_CONTACT_LOCK_TRANSACTION_INVALID");
  }
  const key = amoBrokerContactAdvisoryLockKey(phone);
  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${key})`;
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
