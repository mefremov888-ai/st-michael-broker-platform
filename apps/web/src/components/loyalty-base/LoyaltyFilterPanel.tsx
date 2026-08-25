"use client";

import { ChevronDown, Filter, RotateCcw } from "lucide-react";
import {
  getLoyaltyCallResultOptions,
  type LoyaltyBaseKey,
  type LoyaltyEntityType,
  type LoyaltyFacets,
} from "@/lib/loyalty-base-api";
import {
  AGENCY_SCENARIOS,
  BROKER_SCENARIOS,
  type LoyaltyFilterFormState,
} from "@/lib/loyalty-ui-model";
import type {
  LoyaltyCampaign,
  LoyaltyOperator,
} from "@/lib/loyalty-workflow-api";
import { loyaltyStatusLabel } from "@/lib/loyalty-status";
import { LoyaltyCallResultBadge } from "./LoyaltyCallResultBadge";
import { LoyaltyStatusBadge } from "./LoyaltyStatusBadges";

const BROKER_STAGES = [
  "Новый",
  "Звонили",
  "Приглашён на БТ",
  "Был на БТ",
  "Фиксация",
  "Встреча",
  "Сделка",
  "Повторные сделки / VIP",
] as const;

const AGENCY_PARTNERSHIP = [
  "VIP_PARTNER",
  "SELLING_PARTNER",
  "ACTIVE_PARTNER",
  "FIXATING_PARTNER",
  "WARM_PARTNER",
  "STARTING_PARTNER",
  "DORMANT_PARTNER",
  "NEW_AGENCY",
] as const;

const BROKER_STATUSES = [
  "TOP_SELLER",
  "SELLER",
  "OFFERING",
  "FIXATING",
  "BROKER_TOUR",
  "DORMANT",
  "NEW",
] as const;

const QUALITY = [
  ["FULL", "Полные"],
  ["NEEDS_COMPLETION", "Требуют заполнения"],
  ["NOT_FOUND_IN_CRM", "Не найден в CRM"],
  ["CONFLICT", "Конфликт"],
] as const;

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1 text-xs text-text-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TriSelect({
  value,
  onChange,
  disabled,
  title,
  any = "Неважно",
  yes = "Да",
  no = "Нет",
}: {
  value: "" | "true" | "false";
  onChange: (value: "" | "true" | "false") => void;
  disabled?: boolean;
  title?: string;
  any?: string;
  yes?: string;
  no?: string;
}) {
  return (
    <select
      className="input"
      value={value}
      disabled={disabled}
      title={title}
      onChange={(event) =>
        onChange(event.target.value as "" | "true" | "false")
      }
    >
      <option value="">{any}</option>
      <option value="true">{yes}</option>
      <option value="false">{no}</option>
    </select>
  );
}

export function LoyaltyFilterPanel({
  base,
  entityType,
  draft,
  onChange,
  onApply,
  onReset,
  campaigns,
  operators,
  facets,
  loading,
}: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  draft: LoyaltyFilterFormState;
  onChange: (next: LoyaltyFilterFormState) => void;
  onApply: () => void;
  onReset: () => void;
  campaigns: LoyaltyCampaign[];
  operators: LoyaltyOperator[];
  facets: LoyaltyFacets | null;
  loading: boolean;
}) {
  const update = <K extends keyof LoyaltyFilterFormState>(
    key: K,
    value: LoyaltyFilterFormState[K],
  ) => onChange({ ...draft, [key]: value });
  const isBroker = entityType === "brokers";
  const callResults = getLoyaltyCallResultOptions(entityType);
  const scenarios = isBroker ? BROKER_SCENARIOS : AGENCY_SCENARIOS;
  const statusOptions = isBroker ? BROKER_STATUSES : AGENCY_PARTNERSHIP;
  const unavailableForOurAgency = base === "ours" && !isBroker;

  return (
    <details className="card group" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-semibold">
          <Filter className="h-4 w-4 text-accent" /> Фильтры{" "}
          {isBroker ? "брокеров" : "агентств"}
        </span>
        <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
      </summary>

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onApply();
        }}
      >
        {unavailableForOurAgency && (
          <p className="rounded-lg bg-warning/10 p-3 text-xs text-warning">
            В «Нашей базе» нет полей размера агентства, сайта и размещения
            проектов. Эти фильтры отключены: неизвестные значения не считаются
            отрицательными.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field
            label={
              isBroker
                ? "ФИО, агентство, телефон или email"
                : "Название, контакт, телефон или email"
            }
          >
            <input
              className="input"
              value={draft.search}
              onChange={(event) => update("search", event.target.value)}
              autoComplete="off"
              placeholder="Поиск"
            />
          </Field>
          <Field label="Город">
            <input
              className="input"
              value={draft.city}
              list={`loyalty-cities-${base}-${entityType}`}
              onChange={(event) => update("city", event.target.value)}
              autoComplete="off"
              placeholder="Все города"
            />
            <datalist id={`loyalty-cities-${base}-${entityType}`}>
              {facets?.cities.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.matches} записей
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="Связь с amoCRM">
            <TriSelect
              value={draft.hasAmo}
              onChange={(value) => update("hasAmo", value)}
              any="Любая"
              yes="Связана"
              no="Не связана"
            />
          </Field>
          <Field label="Звонки с">
            <input
              className="input"
              type="date"
              value={draft.callFrom}
              max={draft.callTo}
              onChange={(event) => update("callFrom", event.target.value)}
            />
          </Field>
          <Field label="Звонки по">
            <input
              className="input"
              type="date"
              value={draft.callTo}
              min={draft.callFrom}
              onChange={(event) => update("callTo", event.target.value)}
            />
          </Field>
          <Field label="Встречи и сделки с">
            <input
              className="input"
              type="date"
              value={draft.activityFrom}
              max={draft.activityTo}
              onChange={(event) => update("activityFrom", event.target.value)}
            />
          </Field>
          <Field label="Встречи и сделки по">
            <input
              className="input"
              type="date"
              value={draft.activityTo}
              min={draft.activityFrom}
              onChange={(event) => update("activityTo", event.target.value)}
            />
          </Field>
          <Field label="Кампания обзвона">
            <select
              className="input"
              value={draft.campaignId}
              onChange={(event) => update("campaignId", event.target.value)}
            >
              <option value="">Все кампании</option>
              {campaigns.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Последний результат звонка">
            <select
              className="input"
              value={draft.lastCallResult}
              onChange={(event) =>
                update(
                  "lastCallResult",
                  event.target
                    .value as LoyaltyFilterFormState["lastCallResult"],
                )
              }
            >
              <option value="">Любой результат</option>
              {callResults.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            {draft.lastCallResult && (
              <LoyaltyCallResultBadge
                result={draft.lastCallResult}
                entityType={entityType}
                className="mt-1"
              />
            )}
          </Field>
          <Field label="Сценарий">
            <select
              className="input"
              value={draft.scenario}
              onChange={(event) =>
                update(
                  "scenario",
                  event.target.value as LoyaltyFilterFormState["scenario"],
                )
              }
            >
              <option value="">Все сценарии</option>
              {scenarios.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ответственный">
            <select
              className="input"
              value={draft.assigneeId}
              disabled={draft.unassigned}
              onChange={(event) => update("assigneeId", event.target.value)}
            >
              <option value="">Все сотрудники</option>
              {operators.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
              {!operators.length &&
                facets?.assignees.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.value} ({item.matches})
                  </option>
                ))}
            </select>
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={draft.unassigned}
              onChange={(event) => {
                update("unassigned", event.target.checked);
              }}
            />
            Не назначен
          </label>

          {isBroker ? (
            <>
              <Field label="Специализация">
                <select
                  className="input"
                  value={draft.specialization}
                  onChange={(event) =>
                    update("specialization", event.target.value)
                  }
                >
                  <option value="">Все специализации</option>
                  {[
                    "Бизнес / премиум",
                    "Коммерция — аренда",
                    "Коммерция — продажа",
                    "Вторичка",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="География">
                <select
                  className="input"
                  value={draft.geography}
                  onChange={(event) =>
                    update(
                      "geography",
                      event.target.value as LoyaltyFilterFormState["geography"],
                    )
                  }
                >
                  <option value="">Москва и регионы</option>
                  <option value="MOSCOW">Москва</option>
                  <option value="REGION">Регион</option>
                </select>
              </Field>
              <Field label="Формат работы">
                <select
                  className="input"
                  value={draft.workFormat}
                  onChange={(event) =>
                    update(
                      "workFormat",
                      event.target
                        .value as LoyaltyFilterFormState["workFormat"],
                    )
                  }
                >
                  <option value="">Все форматы</option>
                  <option value="Агентство">Агентство</option>
                  <option value="Частный брокер">Частный брокер</option>
                  <option value="Координатор">Координатор</option>
                </select>
              </Field>
              <Field label="Стадия отношений">
                <select
                  className="input"
                  value={draft.relationshipStage}
                  onChange={(event) =>
                    update("relationshipStage", event.target.value)
                  }
                >
                  <option value="">Все стадии</option>
                  {BROKER_STAGES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <>
              <Field label="Размер агентства">
                <select
                  className="input"
                  value={draft.agencySize}
                  disabled={unavailableForOurAgency}
                  title={
                    unavailableForOurAgency
                      ? "Нет авторитетного поля в модели Нашей базы"
                      : undefined
                  }
                  onChange={(event) =>
                    update(
                      "agencySize",
                      event.target
                        .value as LoyaltyFilterFormState["agencySize"],
                    )
                  }
                >
                  <option value="">Любой размер</option>
                  <option value="Крупное">Крупное</option>
                  <option value="Среднее">Среднее</option>
                  <option value="Небольшое">Небольшое</option>
                </select>
              </Field>
              <Field label="Статус партнёрства из источника">
                <input
                  className="input"
                  list="loyalty-agency-partnership-stages"
                  value={draft.partnershipStatus}
                  onChange={(event) =>
                    update("partnershipStatus", event.target.value)
                  }
                  placeholder="Все статусы"
                />
                <datalist id="loyalty-agency-partnership-stages">
                  {facets?.stages.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.matches} записей
                    </option>
                  ))}
                </datalist>
              </Field>
              <Field label="Размещение сайта">
                <select
                  className="input"
                  value={draft.projectsOnSite}
                  disabled={unavailableForOurAgency}
                  title={
                    unavailableForOurAgency
                      ? "Нет авторитетного поля в модели Нашей базы"
                      : undefined
                  }
                  onChange={(event) =>
                    update(
                      "projectsOnSite",
                      event.target
                        .value as LoyaltyFilterFormState["projectsOnSite"],
                    )
                  }
                >
                  <option value="">Любое</option>
                  <option value="YES">Размещены</option>
                  <option value="IN_PROGRESS">В процессе</option>
                  <option value="NO">Не размещены</option>
                </select>
              </Field>
              <Field label="Есть сайт">
                <TriSelect
                  value={draft.websitePresent}
                  onChange={(value) => update("websitePresent", value)}
                  disabled={unavailableForOurAgency}
                  title={
                    unavailableForOurAgency
                      ? "Нет авторитетного поля в модели Нашей базы"
                      : undefined
                  }
                />
              </Field>
              <Field label="Индивидуальные условия">
                <TriSelect
                  value={draft.individualTerms}
                  onChange={(value) => update("individualTerms", value)}
                  yes="Есть"
                  no="Нет"
                />
              </Field>
              <Field label="Предложены специальные условия">
                <TriSelect
                  value={draft.specialTermsProposed}
                  onChange={(value) => update("specialTermsProposed", value)}
                  yes="Предложены"
                  no="Не предложены"
                />
              </Field>
              <Field label="Награждены">
                <TriSelect
                  value={draft.rewardPresent}
                  onChange={(value) => update("rewardPresent", value)}
                  yes="Да"
                  no="Нет"
                />
              </Field>
            </>
          )}

          <Field label="Качество данных">
            <select
              className="input"
              value={draft.dataQuality}
              onChange={(event) =>
                update(
                  "dataQuality",
                  event.target.value as LoyaltyFilterFormState["dataQuality"],
                )
              }
            >
              <option value="">Любое качество</option>
              {QUALITY.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>

          <Field label={isBroker ? "Статус брокера" : "Уровень партнёрства"}>
            <select
              className="input"
              value={draft.status}
              onChange={(event) =>
                update(
                  "status",
                  event.target.value as LoyaltyFilterFormState["status"],
                )
              }
            >
              <option value="">Все</option>
              {statusOptions.map((value) => (
                <option key={value} value={value}>
                  {loyaltyStatusLabel(value)}
                </option>
              ))}
            </select>
            {draft.status && (
              <LoyaltyStatusBadge
                status={draft.status}
                title={
                  isBroker
                    ? "Выбранный статус брокера"
                    : "Выбранный уровень партнёрства"
                }
                className="mt-1"
              />
            )}
          </Field>
          <Field label="Был БТ">
            <TriSelect
              value={draft.bt}
              onChange={(value) => update("bt", value)}
            />
          </Field>
          <Field label="Встречи">
            <TriSelect
              value={draft.meetings}
              onChange={(value) =>
                onChange({
                  ...draft,
                  meetings: value,
                  meetingsMin: "",
                  meetingsMax: "",
                })
              }
              yes="Есть"
              no="Нет"
            />
          </Field>
          <Field label="Встреч от">
            <input
              className="input"
              type="number"
              min="0"
              value={draft.meetingsMin}
              onChange={(event) =>
                onChange({
                  ...draft,
                  meetings: "",
                  meetingsMin: event.target.value,
                })
              }
            />
          </Field>
          <Field label="Встреч до">
            <input
              className="input"
              type="number"
              min="0"
              value={draft.meetingsMax}
              onChange={(event) =>
                onChange({
                  ...draft,
                  meetings: "",
                  meetingsMax: event.target.value,
                })
              }
            />
          </Field>
          <Field label="Сделки в выбранном периоде">
            <TriSelect
              value={draft.dealsInPeriod}
              onChange={(value) => update("dealsInPeriod", value)}
              yes="Есть сделки"
              no="Нет сделок"
            />
          </Field>
          {!isBroker && (
            <Field label="Количество сделок">
              <select
                className="input"
                value={
                  draft.dealsMin === "0" && draft.dealsMax === "0"
                    ? "0"
                    : draft.dealsMin === "1" && draft.dealsMax === "4"
                      ? "1_4"
                      : draft.dealsMin === "5" && draft.dealsMax === ""
                        ? "5_PLUS"
                        : draft.dealsMin || draft.dealsMax
                          ? "CUSTOM"
                          : ""
                }
                onChange={(event) => {
                  const preset = event.target.value;
                  onChange({
                    ...draft,
                    dealsMin:
                      preset === "0"
                        ? "0"
                        : preset === "1_4"
                          ? "1"
                          : preset === "5_PLUS"
                            ? "5"
                            : "",
                    dealsMax:
                      preset === "0" ? "0" : preset === "1_4" ? "4" : "",
                  });
                }}
              >
                <option value="">Любое количество</option>
                <option value="0">Нет сделок</option>
                <option value="1_4">1–4 сделки</option>
                <option value="5_PLUS">5 и больше</option>
                <option value="CUSTOM">Свой диапазон ниже</option>
              </select>
            </Field>
          )}
          <Field label="Сделок от">
            <input
              className="input"
              type="number"
              min="0"
              value={draft.dealsMin}
              onChange={(event) => update("dealsMin", event.target.value)}
            />
          </Field>
          <Field label="Сделок до">
            <input
              className="input"
              type="number"
              min="0"
              value={draft.dealsMax}
              onChange={(event) => update("dealsMax", event.target.value)}
            />
          </Field>
          <Field label="Давно не связывались, дней">
            <input
              className="input"
              type="number"
              min="1"
              value={draft.staleDays}
              onChange={(event) => update("staleDays", event.target.value)}
              placeholder="Например, 90"
            />
          </Field>
          <Field label="Архив">
            <select
              className="input"
              value={draft.archived}
              onChange={(event) =>
                update(
                  "archived",
                  event.target.value as LoyaltyFilterFormState["archived"],
                )
              }
            >
              <option value="exclude">Только активные</option>
              <option value="only">Только архив</option>
              <option value="include">Активные и архив</option>
            </select>
          </Field>
          <Field label="Сортировка">
            <div className="flex gap-1">
              <select
                className="input"
                value={draft.sortBy}
                onChange={(event) =>
                  update(
                    "sortBy",
                    event.target.value as LoyaltyFilterFormState["sortBy"],
                  )
                }
              >
                <option value="name">Имя / название</option>
                <option value="lastCallAt">Последний звонок</option>
                <option value="fixations">Фиксации</option>
                <option value="meetings">Встречи</option>
                <option value="deals">Сделки</option>
                <option value="dealAmount">Сумма ДДУ</option>
                <option value="updatedAt">Обновление</option>
              </select>
              <select
                className="input w-20"
                aria-label="Направление сортировки"
                value={draft.sortOrder}
                onChange={(event) =>
                  update(
                    "sortOrder",
                    event.target.value as LoyaltyFilterFormState["sortOrder"],
                  )
                }
              >
                <option value="asc">↑</option>
                <option value="desc">↓</option>
              </select>
            </div>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <button className="btn btn-primary" type="submit" disabled={loading}>
            <Filter className="h-4 w-4" /> Применить фильтры
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={onReset}
            disabled={loading}
          >
            <RotateCcw className="h-4 w-4" /> Сбросить фильтры
          </button>
          <span className="text-xs text-text-muted">
            Изменения применятся только после кнопки «Применить фильтры».
          </span>
        </div>
      </form>
    </details>
  );
}
