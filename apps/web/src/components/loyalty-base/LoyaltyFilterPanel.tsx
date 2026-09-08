"use client";

import { Filter, RotateCcw } from "lucide-react";
import {
  getLoyaltyCallResultOptions,
  type LoyaltyBaseKey,
  type LoyaltyEntityType,
  type LoyaltyFacets,
} from "@/lib/loyalty-base-api";
import {
  loyaltyFilterCapabilities,
  sanitizeLoyaltyFilterState,
  type LoyaltyFilterFormState,
} from "@/lib/loyalty-ui-model";
import type {
  LoyaltyCampaign,
  LoyaltyOperator,
} from "@/lib/loyalty-workflow-api";
import {
  ANNA_AGENCY_PARTNERSHIP_OPTIONS,
  ANNA_APPLY_FILTERS_LABEL,
  ANNA_BROKER_STATUS_OPTIONS,
  ANNA_DATA_AND_AMO_OPTIONS,
  ANNA_EMPTY_OPTIONS,
  ANNA_GEOGRAPHY_OPTIONS,
  ANNA_RELATIONSHIP_STAGES,
  ANNA_RESET_FILTERS_LABEL,
  ANNA_SEARCH_PLACEHOLDER,
  ANNA_WORK_FORMATS,
  annaSpecializationOptions,
} from "@/lib/loyalty-anna-filter-contract";

type DealPreset =
  | ""
  | "HAS"
  | "NONE"
  | "3_PLUS"
  | "5_PLUS"
  | "1_2"
  | "3_4"
  | "5_9"
  | "10_PLUS"
  | "IN_PERIOD"
  | "NONE_IN_PERIOD";

function dealPresetFromDraft(draft: LoyaltyFilterFormState): DealPreset {
  if (draft.dealsInPeriod === "true") return "IN_PERIOD";
  if (draft.dealsInPeriod === "false") return "NONE_IN_PERIOD";
  if (draft.dealsMin === "0" && draft.dealsMax === "0") return "NONE";
  if (draft.dealsMin === "1" && draft.dealsMax === "2") return "1_2";
  if (draft.dealsMin === "3" && draft.dealsMax === "4") return "3_4";
  if (draft.dealsMin === "5" && draft.dealsMax === "9") return "5_9";
  if (draft.dealsMin === "10" && draft.dealsMax === "") return "10_PLUS";
  if (draft.dealsMin === "3" && draft.dealsMax === "") return "3_PLUS";
  if (draft.dealsMin === "5" && draft.dealsMax === "") return "5_PLUS";
  if (draft.dealsMin === "1" && draft.dealsMax === "") return "HAS";
  return "";
}

function dealPatchFromPreset(
  preset: DealPreset,
): Pick<LoyaltyFilterFormState, "dealsMin" | "dealsMax" | "dealsInPeriod"> {
  switch (preset) {
    case "HAS":
      return { dealsMin: "1", dealsMax: "", dealsInPeriod: "" };
    case "NONE":
      return { dealsMin: "0", dealsMax: "0", dealsInPeriod: "" };
    case "3_PLUS":
      return { dealsMin: "3", dealsMax: "", dealsInPeriod: "" };
    case "5_PLUS":
      return { dealsMin: "5", dealsMax: "", dealsInPeriod: "" };
    case "1_2":
      return { dealsMin: "1", dealsMax: "2", dealsInPeriod: "" };
    case "3_4":
      return { dealsMin: "3", dealsMax: "4", dealsInPeriod: "" };
    case "5_9":
      return { dealsMin: "5", dealsMax: "9", dealsInPeriod: "" };
    case "10_PLUS":
      return { dealsMin: "10", dealsMax: "", dealsInPeriod: "" };
    case "IN_PERIOD":
      return { dealsMin: "", dealsMax: "", dealsInPeriod: "true" };
    case "NONE_IN_PERIOD":
      return { dealsMin: "", dealsMax: "", dealsInPeriod: "false" };
    default:
      return { dealsMin: "", dealsMax: "", dealsInPeriod: "" };
  }
}

type AmoQualityPreset = "" | "FOUND_AMO" | "NOT_FOUND_AMO" | "FULL" | "NEEDS_COMPLETION";

function amoQualityFromDraft(draft: LoyaltyFilterFormState): AmoQualityPreset {
  if (draft.hasAmo === "true") return "FOUND_AMO";
  if (draft.hasAmo === "false") return "NOT_FOUND_AMO";
  if (draft.dataQuality === "FULL") return "FULL";
  if (draft.dataQuality === "NEEDS_COMPLETION") return "NEEDS_COMPLETION";
  return "";
}

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

export function LoyaltyFilterPanel({
  base,
  entityType,
  draft,
  onChange,
  onApply,
  onApplyDraft,
  dirty = false,
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
  // 2026-09-08 (владелец): выбор в списках применяется сразу, без кнопки.
  // Кнопка остаётся для поиска, дат и числовых полей (их вводят по частям).
  onApplyDraft?: (next: LoyaltyFilterFormState) => void;
  // Есть введённые, но не применённые изменения (поиск/даты/числа).
  dirty?: boolean;
  onReset: () => void;
  campaigns: LoyaltyCampaign[];
  operators: LoyaltyOperator[];
  facets: LoyaltyFacets | null;
  loading: boolean;
}) {
  // Поля, которые вводят по частям — применяются только кнопкой.
  const TYPED_KEYS: ReadonlyArray<keyof LoyaltyFilterFormState> = [
    "search",
    "callFrom",
    "callTo",
    "activityFrom",
    "activityTo",
    "dealsMin",
    "dealsMax",
    "meetingsMin",
    "meetingsMax",
    "staleDays",
  ];
  const commit = (
    next: LoyaltyFilterFormState,
    keys: ReadonlyArray<keyof LoyaltyFilterFormState>,
  ) => {
    onChange(next);
    if (onApplyDraft && !keys.some((key) => TYPED_KEYS.includes(key)))
      onApplyDraft(next);
  };
  const update = <K extends keyof LoyaltyFilterFormState>(
    key: K,
    value: LoyaltyFilterFormState[K],
  ) =>
    commit(
      sanitizeLoyaltyFilterState(base, entityType, {
        ...draft,
        [key]: value,
      }),
      [key],
    );
  const patch = (next: Partial<LoyaltyFilterFormState>) =>
    commit(
      sanitizeLoyaltyFilterState(base, entityType, {
        ...draft,
        ...next,
      }),
      Object.keys(next) as Array<keyof LoyaltyFilterFormState>,
    );
  const isBroker = entityType === "brokers";
  const callResults = getLoyaltyCallResultOptions(entityType);
  const capabilities = loyaltyFilterCapabilities(base, entityType);
  const scenarios = capabilities.scenarios;
  const statusOptions = isBroker
    ? ANNA_BROKER_STATUS_OPTIONS
    : ANNA_AGENCY_PARTNERSHIP_OPTIONS;
  const specializations = annaSpecializationOptions(draft.specialization);
  const assigneeValue = draft.unassigned ? "__unassigned__" : draft.assigneeId;

  return (
    <section className="filters-bar">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onApply();
        }}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Поиск">
            <input
              className="input"
              value={draft.search}
              onChange={(event) => update("search", event.target.value)}
              autoComplete="off"
              placeholder={ANNA_SEARCH_PLACEHOLDER}
            />
          </Field>
          <Field label="Период звонков">
            <div className="flex gap-1">
              <input
                className="input"
                type="date"
                aria-label="Звонки с"
                value={draft.callFrom}
                max={draft.callTo}
                onChange={(event) => update("callFrom", event.target.value)}
              />
              <input
                className="input"
                type="date"
                aria-label="Звонки по"
                value={draft.callTo}
                min={draft.callFrom}
                onChange={(event) => update("callTo", event.target.value)}
              />
            </div>
          </Field>
          <Field label="Обзвон">
            <select
              className="input"
              value={draft.campaignId}
              onChange={(event) => update("campaignId", event.target.value)}
            >
              <option value="">{ANNA_EMPTY_OPTIONS.campaigns}</option>
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
              <option value="">{ANNA_EMPTY_OPTIONS.callResults}</option>
              {callResults.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
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
              <option value="">{ANNA_EMPTY_OPTIONS.scenarios}</option>
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
              value={assigneeValue}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "__unassigned__") {
                  patch({ unassigned: true, assigneeId: "" });
                  return;
                }
                patch({ unassigned: false, assigneeId: value });
              }}
            >
              <option value="">{ANNA_EMPTY_OPTIONS.assignees}</option>
              <option value="__unassigned__">
                {ANNA_EMPTY_OPTIONS.unassigned}
              </option>
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

          <Field label="Направление">
            <select
              className="input"
              value={draft.specialization}
              onChange={(event) =>
                update("specialization", event.target.value)
              }
            >
              <option value="">{ANNA_EMPTY_OPTIONS.specializations}</option>
              {specializations.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>

          {isBroker && (
            <>
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
                  {ANNA_GEOGRAPHY_OPTIONS.map((item) => (
                    <option key={item.value || "all"} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
              {capabilities.dataQuality && (
                <Field label="Данные и amoCRM">
                  <select
                    className="input"
                    value={amoQualityFromDraft(draft)}
                    onChange={(event) => {
                      const value = event.target.value as AmoQualityPreset;
                      if (value === "FOUND_AMO") {
                        patch({ hasAmo: "true", dataQuality: "" });
                        return;
                      }
                      if (value === "NOT_FOUND_AMO") {
                        patch({ hasAmo: "false", dataQuality: "" });
                        return;
                      }
                      patch({
                        hasAmo: "",
                        dataQuality: value as LoyaltyFilterFormState["dataQuality"],
                      });
                    }}
                  >
                    {ANNA_DATA_AND_AMO_OPTIONS.map((item) => (
                      <option key={item.value || "all"} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
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
                  <option value="">{ANNA_EMPTY_OPTIONS.workFormats}</option>
                  {ANNA_WORK_FORMATS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
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
                  <option value="">
                    {ANNA_EMPTY_OPTIONS.relationshipStages}
                  </option>
                  {ANNA_RELATIONSHIP_STAGES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>
              {capabilities.doNotCall && (
                <Field label="«Не звонить»">
                  <select
                    className="input"
                    value={draft.doNotCall}
                    onChange={(event) =>
                      update(
                        "doNotCall",
                        event.target
                          .value as LoyaltyFilterFormState["doNotCall"],
                      )
                    }
                  >
                    <option value="">Все</option>
                    <option value="exclude">Без «не звонить»</option>
                    <option value="only">Только «не звонить»</option>
                  </select>
                </Field>
              )}
            </>
          )}

          {capabilities.cabinetSource && (
            <Field label="Источник фиксаций">
              <select
                className="input"
                value={draft.cabinetSource}
                onChange={(event) =>
                  update(
                    "cabinetSource",
                    event.target
                      .value as LoyaltyFilterFormState["cabinetSource"],
                  )
                }
              >
                <option value="">Оба кабинета</option>
                <option value="new">Только новый кабинет</option>
                <option value="old">Только старый кабинет</option>
              </select>
            </Field>
          )}

          {capabilities.linkedOurs && (
            <Field label="Сцепка с кабинетом">
              <select
                className="input"
                value={draft.linkedOurs}
                onChange={(event) =>
                  update(
                    "linkedOurs",
                    event.target.value as LoyaltyFilterFormState["linkedOurs"],
                  )
                }
              >
                <option value="">Все записи</option>
                <option value="linked">Есть карточка в кабинете</option>
                <option value="unlinked">Нет карточки в кабинете</option>
              </select>
            </Field>
          )}

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
              <option value="">{ANNA_EMPTY_OPTIONS.statuses}</option>
              {statusOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Количество сделок">
            <select
              className="input"
              value={dealPresetFromDraft(draft)}
              onChange={(event) =>
                patch(dealPatchFromPreset(event.target.value as DealPreset))
              }
            >
              <option value="">Все сделки</option>
              <option value="HAS">Есть сделки</option>
              <option value="NONE">Нет сделок</option>
              {isBroker ? (
                <>
                  <option value="3_PLUS">3+ сделки</option>
                  <option value="5_PLUS">5+ сделок</option>
                </>
              ) : (
                <>
                  <option value="1_2">1–2 сделки</option>
                  <option value="3_4">3–4 сделки</option>
                  <option value="5_9">5–9 сделок</option>
                  <option value="10_PLUS">10+ сделок</option>
                </>
              )}
              <option value="IN_PERIOD">Сделка в выбранном периоде</option>
              <option value="NONE_IN_PERIOD">
                Нет сделок в выбранном периоде
              </option>
            </select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <button className="btn btn-primary" type="submit" disabled={loading}>
            <Filter className="h-4 w-4" /> {ANNA_APPLY_FILTERS_LABEL}
          </button>
          {dirty && (
            <span className="rounded-full bg-warning/15 px-3 py-1 text-xs text-warning">
              Есть неприменённые изменения — нажмите «Применить фильтры»
            </span>
          )}
          {onApplyDraft && !dirty && (
            <span className="text-xs text-text-muted">
              Выбор в списках применяется сразу; кнопка нужна для поиска, дат и чисел.
            </span>
          )}
          <button
            className="btn btn-secondary"
            type="button"
            onClick={onReset}
            disabled={loading}
          >
            <RotateCcw className="h-4 w-4" /> {ANNA_RESET_FILTERS_LABEL}
          </button>
        </div>
      </form>
    </section>
  );
}
