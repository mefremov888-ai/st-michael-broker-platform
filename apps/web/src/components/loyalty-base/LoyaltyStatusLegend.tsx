"use client";

import type {
  LoyaltyAgencyStatus,
  LoyaltyBrokerStatus,
  LoyaltyFacets,
} from "@/lib/loyalty-base-api";
import {
  loyaltyStatusDotColor,
  loyaltyStatusLabel,
} from "@/lib/loyalty-status";

const brokerLegend: ReadonlyArray<{
  value: LoyaltyBrokerStatus;
  rule: string;
}> = [
  {
    value: "TOP_SELLER",
    rule: "3 и более сделок",
  },
  {
    value: "SELLER",
    rule: "1–2 сделки",
  },
  {
    value: "OFFERING",
    rule: "Был на встрече",
  },
  {
    value: "FIXATING",
    rule: "Есть фиксации",
  },
  {
    value: "BROKER_TOUR",
    rule: "Посетил БТ",
  },
  {
    value: "DORMANT",
    rule: "Более 90 дней нет активности",
  },
  {
    value: "NEW",
    rule: "Ещё не прошёл БТ",
  },
];

const agencyLegend: ReadonlyArray<{
  value: LoyaltyAgencyStatus;
  rule: string;
}> = [
  {
    value: "VIP_PARTNER",
    rule: "5 и более сделок",
  },
  {
    value: "SELLING_PARTNER",
    rule: "1–4 сделки",
  },
  {
    value: "ACTIVE_PARTNER",
    rule: "Были встречи, но сделок пока нет",
  },
  {
    value: "FIXATING_PARTNER",
    rule: "Есть заявки / фиксации, но встреч пока нет",
  },
  {
    value: "WARM_PARTNER",
    rule: "Был БТ, но фиксаций пока нет",
  },
  {
    value: "STARTING_PARTNER",
    rule: "Идут переговоры о сотрудничестве",
  },
  {
    value: "DORMANT_PARTNER",
    rule: "Ранее работали, но более 90 дней нет активности",
  },
  {
    value: "NEW_AGENCY",
    rule: "Взаимодействия ещё не было",
  },
];

export function LoyaltyStatusLegend({
  entityType,
  facets,
  active,
  sourceStatusesUnconfirmed = false,
  onSelect,
}: {
  entityType: "brokers" | "agencies";
  facets: LoyaltyFacets | null;
  active: string;
  sourceStatusesUnconfirmed?: boolean;
  onSelect?: (status: LoyaltyBrokerStatus | LoyaltyAgencyStatus) => void;
}) {
  const entries = entityType === "brokers" ? brokerLegend : agencyLegend;
  const filterable = entityType === "brokers" && Boolean(onSelect);
  const count = (value: string) =>
    facets?.statuses.find((item) => item.value === value)?.matches ?? null;
  return (
    <section
      className="card space-y-3"
      aria-label={
        entityType === "brokers"
          ? "Значения статусов брокеров"
          : "Уровни партнёрства агентств"
      }
    >
      <div>
        <h2 className="font-semibold">
          {entityType === "brokers"
            ? "Статусы брокеров"
            : "Уровни партнёрства"}
        </h2>
        <p className="text-xs text-text-muted">
          {entityType === "agencies"
            ? "Справка по уровням. Фильтр — в поле «Уровень партнёрства»."
            : sourceStatusesUnconfirmed
              ? "Статусы по срезу источника. Нажмите карточку, чтобы открыть список."
              : "Нажмите карточку, чтобы открыть список."}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {entries.map((item) => {
          const body = (
            <>
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-semibold text-sm">
                  <span
                    className={`h-3 w-3 rounded-full ${loyaltyStatusDotColor(item.value)}`}
                  />{" "}
                  {loyaltyStatusLabel(item.value)}
                </span>
                <b>
                  {count(item.value) === null
                    ? "Нет данных"
                    : count(item.value)}
                </b>
              </span>
              <span className="mt-1 block text-xs text-text-muted">
                {item.rule}
                {filterable ? " · открыть список →" : ""}
              </span>
            </>
          );
          const className = `rounded-xl border p-3 text-left ${
            active === item.value
              ? "border-accent ring-2 ring-accent/20"
              : "border-border"
          }`;
          if (!filterable) {
            return (
              <article key={item.value} className={className}>
                {body}
              </article>
            );
          }
          return (
            <button
              key={item.value}
              type="button"
              aria-pressed={active === item.value}
              className={`${className} transition hover:border-accent`}
              onClick={() => onSelect?.(item.value)}
            >
              {body}
            </button>
          );
        })}
      </div>
    </section>
  );
}
