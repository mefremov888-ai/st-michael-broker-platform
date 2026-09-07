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

// ВАЖНО (hotfix 07.09, ночь): `NOT { comment startsWith }` в Prisma/SQL
// отбрасывает строки с comment IS NULL (NOT NULL = NULL → false) — а у
// большинства записей нового кабинета комментария нет. Поэтому «не
// исторический» = комментарий пуст ИЛИ не начинается с маркера.
export const notHistoricalClientWhere: {
  OR: Array<Record<string, unknown>>;
} = {
  OR: [
    { comment: null },
    { NOT: { comment: { startsWith: HISTORICAL_CLIENT_COMMENT_PREFIX } } },
  ],
};

export function isHistoricalClient(client: { comment?: string | null }): boolean {
  return String(client?.comment || "").startsWith(HISTORICAL_CLIENT_COMMENT_PREFIX);
}

/**
 * 2026-09-07 (решение владельца): фильтр источника «старый кабинет / новый
 * кабинет / оба» для фиксаций. "old" — только перенесённые записи старого
 * кабинета, "new" — только записи нового кабинета (включая синк amo),
 * "all"/пусто — без ограничения.
 */
export type CabinetSource = "old" | "new" | "all";
export const CABINET_SOURCES: readonly CabinetSource[] = ["old", "new", "all"];

export const historicalClientWhere = {
  comment: { startsWith: HISTORICAL_CLIENT_COMMENT_PREFIX },
} as const;

export function cabinetSourceWhere(source?: string | null): Record<string, unknown> {
  if (source === "old") return historicalClientWhere;
  if (source === "new") return notHistoricalClientWhere;
  return {};
}
