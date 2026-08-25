import type { LoyaltyRecord } from "@/lib/loyalty-base-api";
import {
  loyaltyRecordStatuses,
  loyaltyStatusBadgeColor,
  loyaltyStatusLabel,
} from "@/lib/loyalty-status";

export function LoyaltyStatusBadge({
  status,
  title,
  className = "",
}: {
  status: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={[
        "inline-block rounded-full px-2 py-1 text-xs",
        loyaltyStatusBadgeColor(status),
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      title={title}
      data-loyalty-status={status}
    >
      {loyaltyStatusLabel(status)}
    </span>
  );
}

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
        <LoyaltyStatusBadge
          key={status}
          status={status}
          title={index === 0 ? "Основной статус" : "Дополнительный статус"}
        />
      ))}
    </span>
  );
}
