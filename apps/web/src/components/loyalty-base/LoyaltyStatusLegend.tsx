"use client";

import { RotateCcw } from "lucide-react";
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
    rule: "3 и более подтверждённых сделок",
  },
  {
    value: "SELLER",
    rule: "1–2 подтверждённые сделки",
  },
  {
    value: "OFFERING",
    rule: "Сделок нет, есть встреча",
  },
  {
    value: "FIXATING",
    rule: "Встреч нет, есть фиксация",
  },
  {
    value: "BROKER_TOUR",
    rule: "БТ подтверждён полем или датой amoCRM",
  },
  {
    value: "DORMANT",
    rule: "Раньше был активен, более 90 дней без активности",
  },
  {
    value: "NEW",
    rule: "Не достиг БТ и нет подтверждённой активности",
  },
];

const agencyLegend: ReadonlyArray<{
  value: LoyaltyAgencyStatus;
  rule: string;
}> = [
  {
    value: "VIP_PARTNER",
    rule: "5 и более подтверждённых сделок",
  },
  {
    value: "SELLING_PARTNER",
    rule: "1–4 подтверждённые сделки",
  },
  {
    value: "ACTIVE_PARTNER",
    rule: "Сделок нет, есть встречи",
  },
  {
    value: "FIXATING_PARTNER",
    rule: "Есть фиксации, встреч нет",
  },
  {
    value: "WARM_PARTNER",
    rule: "Был БТ, фиксаций нет",
  },
  {
    value: "STARTING_PARTNER",
    rule: "Идут переговоры о сотрудничестве",
  },
  {
    value: "DORMANT_PARTNER",
    rule: "Более 90 дней нет активности",
  },
  {
    value: "NEW_AGENCY",
    rule: "Работа ещё не началась",
  },
];

export function LoyaltyStatusLegend({
  entityType,
  facets,
  active,
  sourceStatusesUnconfirmed = false,
  onSelect,
  onReset,
}: {
  entityType: "brokers" | "agencies";
  facets: LoyaltyFacets | null;
  active: string;
  sourceStatusesUnconfirmed?: boolean;
  onSelect: (status: LoyaltyBrokerStatus | LoyaltyAgencyStatus) => void;
  onReset: () => void;
}) {
  const entries = entityType === "brokers" ? brokerLegend : agencyLegend;
  const count = (value: string) =>
    facets?.statuses.find((item) => item.value === value)?.matches ?? null;
  return (
    <section className="card space-y-3" aria-label="Легенда статусов">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">
            {entityType === "brokers"
              ? "Статусы брокеров"
              : "Уровни партнёрства"}
          </h2>
          <p className="text-xs text-text-muted">
            {sourceStatusesUnconfirmed
              ? "Статусы рассчитаны по срезу источника и не подтверждены событиями. Нажмите карточку, чтобы применить фильтр."
              : "Статусы рассчитаны по подтверждённым событиям. Нажмите карточку, чтобы применить фильтр."}
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onReset}>
          <RotateCcw className="h-4 w-4" /> Сбросить фильтры
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {entries.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={active === item.value}
            className={`rounded-xl border p-3 text-left transition hover:border-accent ${active === item.value ? "border-accent ring-2 ring-accent/20" : "border-border"}`}
            onClick={() => onSelect(item.value)}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-semibold text-sm">
                <span
                  className={`h-3 w-3 rounded-full ${loyaltyStatusDotColor(item.value)}`}
                />{" "}
                {loyaltyStatusLabel(item.value)}
              </span>
              <b>
                {count(item.value) === null ? "Нет данных" : count(item.value)}
              </b>
            </span>
            <span className="mt-1 block text-xs text-text-muted">
              {sourceStatusesUnconfirmed
                ? item.rule.replace(
                    /подтвержд[ёе]нн(ых|ые|ой)/gi,
                    "указанных в источнике",
                  )
                : item.rule}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
