// 2026-09-28 (решения владельца): «Наша база» лояльности читает срез amoCRM
// из таблицы BrokerAmoContactSync (её наполняет ночной синк в модуле amocrm)
// и сливает его с данными кабинета ПРИ ЧТЕНИИ. Здесь — чистые правила
// слияния без обращений к базе и к amo, чтобы их было просто тестировать.

/** amo call_status 1..7 → русская подпись результата звонка. */
export const AMO_CALL_STATUS_LABELS: Record<number, string> = {
  1: "оставил сообщение",
  2: "перезвонить позже",
  3: "нет на месте",
  4: "разговор состоялся",
  5: "неверный номер",
  6: "не дозвонился",
  7: "номер занят",
};

export type LoyaltyAmoLinkStatus =
  | "LINKED"
  | "AMBIGUOUS"
  | "NOT_FOUND"
  | "UNCHECKED";

export const LOYALTY_AMO_LINK_FILTERS = [
  "LINKED",
  "AMBIGUOUS",
  "NOT_FOUND",
  "UNCHECKED",
] as const;

export type LoyaltyContactSource = "cabinet" | "amo" | "anna";

export type LoyaltyContactKind =
  | "CALL_IN"
  | "CALL_OUT"
  | "TASK_COMPLETED"
  | "MEETING"
  | "NOTE"
  | "FIXATION"
  | "DEAL"
  | "BROKER_TOUR"
  | "LEAD_STATUS"
  | "CONTACT_UPDATE";

export interface LoyaltyContactCandidate {
  at: unknown;
  kind: LoyaltyContactKind;
  source: LoyaltyContactSource;
}

export interface LoyaltyLastContact {
  at: string;
  kind: LoyaltyContactKind;
  source: LoyaltyContactSource;
}

function isoOf(value: unknown): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function amoCallStatusLabel(status: unknown): string | null {
  const code = Number(status);
  if (!Number.isInteger(code)) return null;
  return AMO_CALL_STATUS_LABELS[code] || null;
}

/**
 * Статус привязки брокера к контакту amo для фильтра «Привязка к amo».
 * Главный признак — Broker.amoContactId; строка синка уточняет, почему
 * привязки нет (не найден / несколько кандидатов / ещё не искали).
 */
export function amoLinkStatusOf(
  brokerAmoContactId: unknown,
  sync: {
    amoContactId?: unknown;
    amoLookupAt?: unknown;
    amoLookupStatus?: unknown;
  } | null | undefined,
): LoyaltyAmoLinkStatus {
  if (brokerAmoContactId !== null && brokerAmoContactId !== undefined)
    return "LINKED";
  if (!sync) return "UNCHECKED";
  if (sync.amoContactId !== null && sync.amoContactId !== undefined)
    return "LINKED";
  if (!sync.amoLookupAt) return "UNCHECKED";
  const status = String(sync.amoLookupStatus || "").toUpperCase();
  if (status === "AMBIGUOUS") return "AMBIGUOUS";
  // NOT_BROKER — контакт по номеру нашёлся, но без галочки «Брокер»: для
  // админа это тоже «в amo как брокер не найден».
  if (status === "NOT_FOUND" || status === "NOT_BROKER") return "NOT_FOUND";
  return "UNCHECKED";
}

export function amoLinkMatches(
  filterValue: string | undefined,
  status: LoyaltyAmoLinkStatus,
): boolean {
  if (!filterValue) return true;
  return String(filterValue).toUpperCase() === status;
}

/** +79254259619 → «+7 925 ***-**-19»: админ видит код и хвост, не весь номер. */
export function maskAmoCandidatePhone(phone: unknown): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  const national =
    digits.length === 11 && (digits[0] === "7" || digits[0] === "8")
      ? digits.slice(1)
      : digits.length === 10
        ? digits
        : null;
  if (!national) return `***${digits.slice(-2)}`;
  return `+7 ${national.slice(0, 3)} ***-**-${national.slice(-2)}`;
}

/** Вид касания amo (AmoTouchKind) → вид контакта в «Нашей базе». */
export function amoTouchKindToContactKind(
  kind: unknown,
  direction?: unknown,
): LoyaltyContactKind | null {
  const value = String(kind || "").toUpperCase();
  switch (value) {
    case "CALL_IN":
    case "CALL_OUT":
    case "TASK_COMPLETED":
    case "MEETING":
    case "NOTE":
    case "LEAD_STATUS":
    case "CONTACT_UPDATE":
      return value;
    case "CALL":
      return String(direction || "").toUpperCase() === "IN"
        ? "CALL_IN"
        : "CALL_OUT";
    default:
      return null;
  }
}

/** Самое свежее касание из всех источников (кабинет / amo / база Анны). */
export function pickLatestContact(
  candidates: LoyaltyContactCandidate[],
): LoyaltyLastContact | null {
  let best: LoyaltyLastContact | null = null;
  for (const candidate of candidates) {
    const at = isoOf(candidate.at);
    if (!at) continue;
    if (!best || at > best.at)
      best = { at, kind: candidate.kind, source: candidate.source };
  }
  return best;
}
