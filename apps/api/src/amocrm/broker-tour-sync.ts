import { AMO_CONTACT_FIELDS } from "@st-michael/integrations";

export interface BrokerTourSnapshot {
  brokerTourVisited: boolean;
  brokerTourDate: Date | null;
}

export interface CurrentBrokerTourState {
  brokerTourVisited: boolean;
  brokerTourDate: Date | null;
}

export type BrokerTourUpdate = Partial<BrokerTourSnapshot>;

const TRUE_CHECKBOX_VALUES = new Set(["1", "true", "yes", "on", "да"]);

export function parseAmoCheckbox(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  return TRUE_CHECKBOX_VALUES.has(String(value).trim().toLowerCase());
}

export function parseAmoDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (value == null || value === "") return null;

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const timestamp = Number(text);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    // amoCRM date fields normally return Unix seconds; accept milliseconds too.
    const date = new Date(
      timestamp >= 100_000_000_000 ? timestamp : timestamp * 1000,
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const ruDate = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (ruDate) {
    const day = Number(ruDate[1]);
    const month = Number(ruDate[2]);
    const year = Number(ruDate[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function customFieldValue(contact: any, fieldId: number): unknown {
  const field = (contact?.custom_fields_values || []).find(
    (candidate: any) => Number(candidate?.field_id) === fieldId,
  );
  return field?.values?.[0]?.value ?? null;
}

export function brokerTourSnapshotFromAmoContact(
  contact: any,
): BrokerTourSnapshot {
  return {
    brokerTourVisited: parseAmoCheckbox(
      customFieldValue(contact, AMO_CONTACT_FIELDS.BROKER_TOUR_VISITED),
    ),
    brokerTourDate: parseAmoDate(
      customFieldValue(contact, AMO_CONTACT_FIELDS.BROKER_TOUR_DATE),
    ),
  };
}

export function buildBrokerTourUpdate(
  current: CurrentBrokerTourState,
  snapshot: BrokerTourSnapshot,
): BrokerTourUpdate | null {
  const update: BrokerTourUpdate = {};
  if (Boolean(current.brokerTourVisited) !== snapshot.brokerTourVisited) {
    update.brokerTourVisited = snapshot.brokerTourVisited;
  }

  const currentDateMs = current.brokerTourDate?.getTime() ?? null;
  const snapshotDateMs = snapshot.brokerTourDate?.getTime() ?? null;
  if (currentDateMs !== snapshotDateMs) {
    update.brokerTourDate = snapshot.brokerTourDate;
  }

  return Object.keys(update).length > 0 ? update : null;
}

function valuesOfEvents(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

export function extractAmoContactIds(payload: any): number[] {
  const ids = new Set<number>();
  const add = (rawId: unknown) => {
    const id = Number(rawId);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  };

  for (const eventType of ["update", "add"]) {
    for (const event of valuesOfEvents(payload?.contacts?.[eventType])) {
      add(event?.id);
    }
  }

  // Backward-compatible direct calls and tests may still pass a full contact.
  add(payload?.id);
  return Array.from(ids);
}
