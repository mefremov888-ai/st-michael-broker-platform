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
    badge: "border-emerald-300 bg-emerald-50 text-emerald-900",
    dot: "bg-emerald-600",
    accessibleMeaning: "положительный результат",
  },
  informational: {
    badge: "border-blue-300 bg-blue-50 text-blue-900",
    dot: "bg-blue-600",
    accessibleMeaning: "контакт состоялся",
  },
  follow_up: {
    badge: "border-amber-300 bg-amber-50 text-amber-950",
    dot: "bg-amber-600",
    accessibleMeaning: "требуется продолжение",
  },
  unreached: {
    badge: "border-slate-300 bg-slate-100 text-slate-800",
    dot: "bg-slate-600",
    accessibleMeaning: "связаться не удалось",
  },
  negative: {
    badge: "border-red-300 bg-red-50 text-red-900",
    dot: "bg-red-600",
    accessibleMeaning: "отрицательный результат",
  },
  invalid: {
    badge: "border-orange-300 bg-orange-50 text-orange-900",
    dot: "bg-orange-600",
    accessibleMeaning: "контактные данные недействительны",
  },
  neutral: {
    badge: "border-slate-300 bg-slate-100 text-slate-800",
    dot: "bg-slate-600",
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
