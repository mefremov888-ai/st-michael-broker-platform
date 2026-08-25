import type { LoyaltyRecord } from "@/lib/loyalty-base-api";
import {
  loyaltyRecordStatuses,
  loyaltyStatusBadgeColor,
  loyaltyStatusLabel,
} from "@/lib/loyalty-status";

export function LoyaltyStatusBadges({
  record,
  emptyLabel = "Нет данных",
}: {
  record: Pick<LoyaltyRecord, "status" | "computedStatuses">;
  emptyLabel?: string;
}) {
  const statuses = loyaltyRecordStatuses(record);
  if (!statuses.length) {
    return <span className="text-xs text-text-muted">{emptyLabel}</span>;
  }

  return (
    <span className="flex flex-wrap gap-1.5" aria-label="Статусы">
      {statuses.map((status, index) => (
        <span
          key={status}
          className={`inline-block rounded-full px-2 py-1 text-xs ${loyaltyStatusBadgeColor(status)}`}
          title={index === 0 ? "Основной статус" : "Дополнительный статус"}
        >
          {loyaltyStatusLabel(status)}
        </span>
      ))}
    </span>
  );
}
