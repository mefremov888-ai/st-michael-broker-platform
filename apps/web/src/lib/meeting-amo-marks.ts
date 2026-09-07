// 2026-09-07: метки backfill-а встреч (scripts/backfill-meetings.js).
// Встречи, по которым статус из amoCRM вернуть не удалось, остаются
// PENDING, но получают текстовую метку в comment (схема БД не менялась).
// UI обязан показывать их ЯВНО (оранжевый бейдж), а не как обычное
// «Ожидает» — требование владельца.

export const AMO_MARK_UNCONFIRMED = "[amo:статус не подтверждён]";
export const AMO_MARK_LEAD_DELETED = "[amo:лид удалён]";

export type MeetingAmoMark = "UNCONFIRMED" | "LEAD_DELETED";

/**
 * Метка «нет ответа из amo» для встречи. Показывается только на PENDING:
 * если статус позже дотянули (COMPLETED/CANCELLED), метка в comment —
 * исторический след, бейдж не нужен.
 */
export function meetingAmoMark(
  comment: string | null | undefined,
  status: string | null | undefined,
): MeetingAmoMark | null {
  if ((status || "").toUpperCase() !== "PENDING") return null;
  const text = comment || "";
  if (text.includes(AMO_MARK_LEAD_DELETED)) return "LEAD_DELETED";
  if (text.includes(AMO_MARK_UNCONFIRMED)) return "UNCONFIRMED";
  return null;
}

/** Русский текст бейджа. */
export function meetingAmoMarkLabel(mark: MeetingAmoMark): string {
  return mark === "LEAD_DELETED"
    ? "Лид удалён в amo"
    : "Статус не подтверждён · нет ответа из amo";
}

/** Comment без служебных меток — для показа человеку. */
export function stripMeetingAmoMarks(
  comment: string | null | undefined,
): string {
  return (comment || "")
    .split("\n")
    .filter(
      (line) =>
        !line.includes(AMO_MARK_UNCONFIRMED) &&
        !line.includes(AMO_MARK_LEAD_DELETED),
    )
    .join("\n")
    .trim();
}
