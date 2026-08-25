import {
  getLoyaltyCallResultPresentation,
  type LoyaltyCallResultTone,
  type LoyaltyEntityType,
} from "@/lib/loyalty-base-api";

interface ToneStyle {
  badge: string;
  dot: string;
  accessibleMeaning: string;
}

/**
 * All Tailwind tokens are complete string literals so production extraction
 * does not depend on interpolated class names.
 */
export const LOYALTY_CALL_RESULT_TONE_STYLES = {
  positive: {
    badge: "border-success/30 bg-success/10 text-success",
    dot: "bg-success",
    accessibleMeaning: "положительный результат",
  },
  informational: {
    badge: "border-accent/30 bg-accent/10 text-accent",
    dot: "bg-accent",
    accessibleMeaning: "контакт состоялся",
  },
  follow_up: {
    badge: "border-warning/30 bg-warning/10 text-warning",
    dot: "bg-warning",
    accessibleMeaning: "требуется продолжение",
  },
  unreached: {
    badge: "border-border bg-surface-secondary text-text-muted",
    dot: "bg-text-muted",
    accessibleMeaning: "связаться не удалось",
  },
  negative: {
    badge: "border-error/30 bg-error/10 text-error",
    dot: "bg-error",
    accessibleMeaning: "отрицательный результат",
  },
  invalid: {
    badge: "border-warning/30 bg-warning/10 text-warning",
    dot: "bg-warning",
    accessibleMeaning: "контактные данные недействительны",
  },
  neutral: {
    badge: "border-border bg-surface-secondary text-text-muted",
    dot: "bg-text-muted",
    accessibleMeaning: "результат без известной категории",
  },
} as const satisfies Record<LoyaltyCallResultTone, ToneStyle>;

export function LoyaltyCallResultBadge({
  result,
  entityType,
  emptyLabel = "Нет данных",
  className = "",
}: {
  result: string | null | undefined;
  entityType: LoyaltyEntityType;
  emptyLabel?: string;
  className?: string;
}) {
  const presentation = getLoyaltyCallResultPresentation(result, entityType);
  const tone = presentation?.tone || "neutral";
  const style = LOYALTY_CALL_RESULT_TONE_STYLES[tone];
  const label = presentation?.label || emptyLabel;
  const code = presentation?.code || "NONE";

  return (
    <span
      className={[
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium",
        style.badge,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-call-result-code={code}
      data-call-result-tone={tone}
      aria-label={`Результат звонка: ${label}. Категория: ${style.accessibleMeaning}.`}
      title={`Результат звонка: ${label} · ${style.accessibleMeaning}`}
    >
      <span
        className={["h-2 w-2 shrink-0 rounded-full", style.dot].join(" ")}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}
