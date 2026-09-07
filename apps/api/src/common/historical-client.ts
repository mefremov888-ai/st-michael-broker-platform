/**
 * 2026-09-07: исторические клиенты — перенос фиксаций СТАРОГО кабинета
 * (scripts/import-old-cabinet-fixations.js). Помечаются маркером в comment
 * `[old-cabinet:<id>]`, у них createdAt = дата старого кабинета, статус
 * уникальности EXPIRED/REJECTED и нет amoLeadId.
 *
 * Синк amo → кабинет ищет клиента по телефону и переиспользует существующую
 * запись; исторические строки из этого поиска ИСКЛЮЧАЮТСЯ, иначе новый лид
 * amo «приклеился» бы к заявке 2021 года.
 */
export const HISTORICAL_CLIENT_COMMENT_PREFIX = "[old-cabinet:";

export const notHistoricalClientWhere = {
  NOT: { comment: { startsWith: HISTORICAL_CLIENT_COMMENT_PREFIX } },
} as const;

export function isHistoricalClient(client: { comment?: string | null }): boolean {
  return String(client?.comment || "").startsWith(HISTORICAL_CLIENT_COMMENT_PREFIX);
}
