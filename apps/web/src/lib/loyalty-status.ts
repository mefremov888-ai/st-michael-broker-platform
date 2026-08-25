import type { LoyaltyRecord } from "./loyalty-base-api";

const labels: Readonly<Record<string, string>> = {
  TOP_SELLER: "Топ-продавец",
  SELLER: "Продавец",
  OFFERING: "Предлагающий",
  FIXATING: "Фиксирующий",
  BROKER_TOUR: "Был на БТ",
  DORMANT: "Спящий",
  NEW: "Новый",
  VIP_PARTNER: "VIP-партнёр",
  SELLING_PARTNER: "Продающий партнёр",
  ACTIVE_PARTNER: "Активный партнёр",
  FIXATING_PARTNER: "Фиксирующий партнёр",
  WARM_PARTNER: "Тёплый партнёр",
  STARTING_PARTNER: "Начинающий партнёр",
  DORMANT_PARTNER: "Спящий партнёр",
  NEW_AGENCY: "Новое агентство",
};

type StatusPalette = {
  badge: string;
  dot: string;
};

const palettes: Readonly<Record<string, StatusPalette>> = {
  TOP_SELLER: {
    badge: "bg-emerald-100 text-emerald-800",
    dot: "bg-emerald-500",
  },
  VIP_PARTNER: {
    badge: "bg-emerald-100 text-emerald-800",
    dot: "bg-emerald-500",
  },
  SELLER: { badge: "bg-green-100 text-green-800", dot: "bg-green-600" },
  SELLING_PARTNER: {
    badge: "bg-green-100 text-green-800",
    dot: "bg-green-600",
  },
  OFFERING: {
    badge: "bg-orange-100 text-orange-800",
    dot: "bg-orange-500",
  },
  ACTIVE_PARTNER: {
    badge: "bg-orange-100 text-orange-800",
    dot: "bg-orange-500",
  },
  FIXATING: {
    badge: "bg-purple-100 text-purple-800",
    dot: "bg-purple-500",
  },
  FIXATING_PARTNER: {
    badge: "bg-purple-100 text-purple-800",
    dot: "bg-purple-500",
  },
  BROKER_TOUR: {
    badge: "bg-yellow-100 text-yellow-800",
    dot: "bg-yellow-400",
  },
  WARM_PARTNER: {
    badge: "bg-yellow-100 text-yellow-800",
    dot: "bg-yellow-400",
  },
  DORMANT: { badge: "bg-red-100 text-red-800", dot: "bg-red-400" },
  DORMANT_PARTNER: {
    badge: "bg-red-100 text-red-800",
    dot: "bg-red-400",
  },
  NEW_AGENCY: {
    badge: "bg-slate-100 text-slate-800",
    dot: "bg-slate-400",
  },
};

const defaultPalette: StatusPalette = {
  badge: "bg-blue-100 text-blue-800",
  dot: "bg-blue-500",
};

export function loyaltyStatusLabel(status: string): string {
  return labels[status] || status;
}

export function loyaltyStatusBadgeColor(status: string): string {
  return (palettes[status] || defaultPalette).badge;
}

export function loyaltyStatusDotColor(status: string): string {
  return (palettes[status] || defaultPalette).dot;
}

/**
 * Keep the scalar legacy status as the primary display value and append the
 * backend-computed statuses in their original order. Normalized API records
 * use the first computed status as the scalar value, so this produces the
 * backend order while still supporting old payloads and hand-built records.
 */
export function loyaltyRecordStatuses(
  record: Pick<LoyaltyRecord, "status" | "computedStatuses">,
): string[] {
  const seen = new Set<string>();
  return [record.status, ...(record.computedStatuses || [])].flatMap(
    (status) => {
      const normalized = String(status || "").trim();
      if (!normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [normalized];
    },
  );
}
