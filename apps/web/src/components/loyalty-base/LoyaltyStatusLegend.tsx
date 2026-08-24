"use client";

import { RotateCcw } from "lucide-react";
import type {
  LoyaltyAgencyStatus,
  LoyaltyBrokerStatus,
  LoyaltyFacets,
} from "@/lib/loyalty-base-api";

const brokerLegend: ReadonlyArray<{
  value: LoyaltyBrokerStatus;
  title: string;
  rule: string;
  color: string;
}> = [
  {
    value: "TOP_SELLER",
    title: "Топ-продавец",
    rule: "3 и более подтверждённых сделок",
    color: "bg-emerald-500",
  },
  {
    value: "SELLER",
    title: "Продавец",
    rule: "1–2 подтверждённые сделки",
    color: "bg-green-600",
  },
  {
    value: "OFFERING",
    title: "Предлагающий",
    rule: "Сделок нет, есть встреча",
    color: "bg-orange-500",
  },
  {
    value: "FIXATING",
    title: "Фиксирующий",
    rule: "Встреч нет, есть фиксация",
    color: "bg-purple-500",
  },
  {
    value: "BROKER_TOUR",
    title: "Был на брокер-туре",
    rule: "БТ подтверждён полем или датой amoCRM",
    color: "bg-yellow-400",
  },
  {
    value: "DORMANT",
    title: "Спящий",
    rule: "Раньше был активен, более 90 дней без активности",
    color: "bg-red-400",
  },
  {
    value: "NEW",
    title: "Новый",
    rule: "Не достиг БТ и нет подтверждённой активности",
    color: "bg-blue-500",
  },
];

const agencyLegend: ReadonlyArray<{
  value: LoyaltyAgencyStatus;
  title: string;
  rule: string;
  color: string;
}> = [
  {
    value: "VIP_PARTNER",
    title: "VIP-партнёр",
    rule: "5 и более подтверждённых сделок",
    color: "bg-emerald-500",
  },
  {
    value: "SELLING_PARTNER",
    title: "Продающий партнёр",
    rule: "1–4 подтверждённые сделки",
    color: "bg-green-600",
  },
  {
    value: "ACTIVE_PARTNER",
    title: "Активный партнёр",
    rule: "Сделок нет, есть встречи",
    color: "bg-orange-500",
  },
  {
    value: "FIXATING_PARTNER",
    title: "Фиксирующий партнёр",
    rule: "Есть фиксации, встреч нет",
    color: "bg-purple-500",
  },
  {
    value: "WARM_PARTNER",
    title: "Тёплый партнёр",
    rule: "Был БТ, фиксаций нет",
    color: "bg-yellow-400",
  },
  {
    value: "STARTING_PARTNER",
    title: "Начинающий партнёр",
    rule: "Идут переговоры о сотрудничестве",
    color: "bg-blue-500",
  },
  {
    value: "DORMANT_PARTNER",
    title: "Спящий партнёр",
    rule: "Более 90 дней нет активности",
    color: "bg-red-400",
  },
  {
    value: "NEW_AGENCY",
    title: "Новое агентство",
    rule: "Работа ещё не началась",
    color: "bg-slate-400",
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
                <span className={`h-3 w-3 rounded-full ${item.color}`} />{" "}
                {item.title}
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
