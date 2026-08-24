"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RefreshCcw,
  Scale,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import {
  LOYALTY_RECONCILIATION_GROUPS,
  decideLoyaltyReconciliation,
  exportLoyaltyReconciliationGroup,
  getLoyaltyReconciliationCoverage,
  getLoyaltyReconciliationDefinitions,
  searchLoyaltyReconciliationGroup,
  type LoyaltyReconciliationAction,
  type LoyaltyReconciliationBase,
  type LoyaltyReconciliationCoverage,
  type LoyaltyReconciliationDefinitionItem,
  type LoyaltyReconciliationEntityType,
  type LoyaltyReconciliationParty,
  type LoyaltyReconciliationRow,
  type LoyaltyReconciliationStatus,
} from "@/lib/loyalty-reconciliation-v2-api";
import {
  downloadBlob,
  getLoyaltyList,
  type LoyaltyRecord,
} from "@/lib/loyalty-base-api";

const GROUP_FALLBACK: Record<
  (typeof LOYALTY_RECONCILIATION_GROUPS)[number],
  string
> = {
  PHONE_MATCHED: "Телефон совпал",
  ANNA_ONLY: "Только у Анны",
  CABINET_ONLY: "Только в кабинете",
  PHONE_TO_MULTIPLE_CARDS: "Телефон у нескольких карточек",
  INVALID_PHONE: "Нет корректного телефона",
  NAME_OR_AGENCY_CONFLICT: "Расхождение ФИО или агентства",
  EXCLUDED_OR_STALE: "Исключено или устарело",
};

const ACTION_LABELS: Record<LoyaltyReconciliationAction, string> = {
  LINK: "Связать",
  KEEP_SEPARATE: "Оставить раздельно",
  SUPPLEMENT: "Дополнить связь",
  ARCHIVE: "Архивировать контакт в базе Анны",
  UNLINK: "Разорвать связь",
};

const STATUS_LABELS: Record<LoyaltyReconciliationStatus, string> = {
  OPEN: "Открыто",
  RESOLVED: "Решено",
  DISMISSED: "Отклонено",
};

const formatDate = (value: string | null | undefined) => {
  if (!value) return "Нет данных";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("ru-RU");
};

function PartyCard({
  title,
  party,
}: {
  title: string;
  party: LoyaltyReconciliationParty | null;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-secondary p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
        {title}
      </p>
      {party ? (
        <div className="mt-2 space-y-1 text-sm">
          <b className="block">{party.displayName || "Нет данных"}</b>
          <span className="block text-text-muted">
            {party.entityType === "BROKER" ? "Брокер" : "Агентство"}
            {party.city ? ` · ${party.city}` : ""}
            {party.archived ? " · архив" : ""}
          </span>
          {party.maskedContacts.length ? (
            party.maskedContacts.map((contact, index) => (
              <span
                className="block font-mono text-xs"
                key={`${contact.type}-${index}`}
              >
                {contact.type}: {contact.value}
              </span>
            ))
          ) : (
            <span className="block text-xs text-text-muted">
              Контакты: нет данных
            </span>
          )}
        </div>
      ) : (
        <p className="mt-2 text-sm text-text-muted">Запись отсутствует</p>
      )}
    </div>
  );
}

function DecisionModal({
  row,
  onClose,
  onDone,
}: {
  row: LoyaltyReconciliationRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [action, setAction] = useState<LoyaltyReconciliationAction>(
    row.allowedActions[0] || "KEEP_SEPARATE",
  );
  const [reason, setReason] = useState("");
  const [targetId, setTargetId] = useState(row.ours?.id || "");
  const [targetSearch, setTargetSearch] = useState(
    row.ours?.displayName || row.anna?.displayName || "",
  );
  const [targetOptions, setTargetOptions] = useState<
    Array<Pick<LoyaltyRecord, "id" | "name" | "city" | "company" | "phone">>
  >(
    row.ours
      ? [
          {
            id: row.ours.id,
            name: row.ours.displayName,
            city: row.ours.city || "",
            company: "",
            phone: row.ours.maskedContacts[0]?.value || "",
          },
        ]
      : [],
  );
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetError, setTargetError] = useState("");
  const [useDisplayName, setUseDisplayName] = useState(false);
  const [displayName, setDisplayName] = useState(
    row.ours?.displayName || row.anna?.displayName || "",
  );
  const [useCity, setUseCity] = useState(false);
  const [city, setCity] = useState(row.ours?.city || row.anna?.city || "");
  const [useAttributes, setUseAttributes] = useState(false);
  const [attributes, setAttributes] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requiresTarget = action === "LINK" || action === "SUPPLEMENT";
  const canSubmit = Boolean(
    row.caseId &&
    row.expectedVersion &&
    reason.trim().length >= 3 &&
    (!requiresTarget || targetId) &&
    (action !== "SUPPLEMENT" ||
      (useDisplayName && displayName.trim()) ||
      (useCity && city.trim()) ||
      useAttributes),
  );
  const searchTargets = async () => {
    const entityType =
      (row.anna?.entityType || row.ours?.entityType) === "AGENCY"
        ? "agencies"
        : "brokers";
    setTargetLoading(true);
    setTargetError("");
    try {
      const result = await getLoyaltyList("ours", entityType, {
        page: 1,
        pageSize: 20,
        search: targetSearch.trim(),
        archived: "exclude",
        filter: {},
      });
      setTargetOptions(result.items);
      if (!result.items.some((item) => item.id === targetId)) setTargetId("");
      if (!result.items.length)
        setTargetError("В нашей базе совпадений не найдено.");
    } catch (reasonValue) {
      setTargetError(
        reasonValue instanceof Error
          ? reasonValue.message
          : "Не удалось найти запись в нашей базе",
      );
    } finally {
      setTargetLoading(false);
    }
  };
  const submit = async () => {
    if (!row.caseId || !row.expectedVersion || !canSubmit) return;
    setLoading(true);
    setError("");
    try {
      let fieldResolutions: Record<string, unknown> | undefined;
      if (action === "SUPPLEMENT") {
        fieldResolutions = {};
        if (useDisplayName) fieldResolutions.displayName = displayName.trim();
        if (useCity) fieldResolutions.city = city.trim();
        if (useAttributes) {
          const parsed = JSON.parse(attributes);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(
              "Дополнительные атрибуты должны быть JSON-объектом",
            );
          }
          fieldResolutions.attributes = parsed;
        }
      }
      if (action === "ARCHIVE") {
        if (
          !window.confirm(
            "Будет архивирован весь контакт в базе Анны, а его активные связи будут отозваны. Продолжить?",
          ) ||
          window.prompt("Введите АРХИВИРОВАТЬ для подтверждения")?.trim() !==
            "АРХИВИРОВАТЬ"
        )
          return;
      }
      await decideLoyaltyReconciliation({
        caseId: row.caseId,
        action,
        expectedVersion: row.expectedVersion,
        reason: reason.trim(),
        ...(fieldResolutions ? { fieldResolutions } : {}),
        ...(targetId.trim() ? { targetId: targetId.trim() } : {}),
      });
      onDone();
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : "Не удалось сохранить решение",
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-2xl bg-surface p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Решение по сверке</h3>
            <p className="text-sm text-text-muted">
              Версия {row.expectedVersion ?? "Нет данных"}; данные двух баз не
              объединяются автоматически.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Закрыть">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-4 grid gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-text-muted">Действие</span>
            <select
              className="input w-full"
              value={action}
              onChange={(event) =>
                setAction(event.target.value as LoyaltyReconciliationAction)
              }
            >
              {row.allowedActions.map((item) => (
                <option key={item} value={item}>
                  {ACTION_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
          {action === "SUPPLEMENT" && (
            <div className="space-y-2 rounded-xl border border-border p-3">
              <p className="text-sm font-medium">
                Какие поля дополнить в записи Анны
              </p>
              <label className="grid gap-1 text-sm">
                <span>
                  <input
                    type="checkbox"
                    checked={useDisplayName}
                    onChange={(event) =>
                      setUseDisplayName(event.target.checked)
                    }
                  />{" "}
                  Имя / название
                </span>
                <input
                  className="input"
                  disabled={!useDisplayName}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={`Анна: ${row.anna?.displayName || "нет"}; кабинет: ${row.ours?.displayName || "нет"}`}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span>
                  <input
                    type="checkbox"
                    checked={useCity}
                    onChange={(event) => setUseCity(event.target.checked)}
                  />{" "}
                  Город
                </span>
                <input
                  className="input"
                  disabled={!useCity}
                  value={city}
                  onChange={(event) => setCity(event.target.value)}
                  placeholder={`Анна: ${row.anna?.city || "нет"}; кабинет: ${row.ours?.city || "нет"}`}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span>
                  <input
                    type="checkbox"
                    checked={useAttributes}
                    onChange={(event) => setUseAttributes(event.target.checked)}
                  />{" "}
                  Дополнительные атрибуты (JSON)
                </span>
                <textarea
                  className="input min-h-20 font-mono text-xs"
                  disabled={!useAttributes}
                  value={attributes}
                  onChange={(event) => setAttributes(event.target.value)}
                />
              </label>
            </div>
          )}
          {requiresTarget && (
            <div className="space-y-2 rounded-xl border border-border p-3">
              <div>
                <span className="block text-sm font-medium">
                  Целевая запись в нашей базе *
                </span>
                <span className="text-xs text-text-muted">
                  Связь будет создана только с выбранным брокером или
                  агентством.
                </span>
              </div>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void searchTargets();
                }}
              >
                <input
                  className="input min-w-0 flex-1"
                  value={targetSearch}
                  onChange={(event) => setTargetSearch(event.target.value)}
                  placeholder="Имя, телефон или агентство"
                />
                <button
                  className="btn btn-secondary"
                  type="submit"
                  disabled={targetLoading}
                >
                  {targetLoading && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  Найти
                </button>
              </form>
              <select
                className="input w-full"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                <option value="">Выберите целевую запись</option>
                {targetOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || "Без названия"}
                    {[item.company, item.city, item.phone].filter(Boolean)
                      .length
                      ? ` · ${[item.company, item.city, item.phone].filter(Boolean).join(" · ")}`
                      : ""}
                  </option>
                ))}
              </select>
              {targetError && (
                <p className="text-xs text-error">{targetError}</p>
              )}
            </div>
          )}
          <label className="text-sm">
            <span className="mb-1 block text-text-muted">
              Обоснование (обязательно)
            </span>
            <textarea
              className="input min-h-24 w-full"
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Почему принято это решение"
            />
          </label>
          {error && (
            <p className="rounded-lg bg-error/10 p-3 text-sm text-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={onClose}
            >
              Отмена
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={!canSubmit || loading}
              onClick={() => void submit()}
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
              Сохранить решение
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LoyaltyReconciliationV2({
  canDecide,
  canExport,
}: {
  canDecide: boolean;
  canExport: boolean;
}) {
  const [base, setBase] = useState<LoyaltyReconciliationBase>("anna");
  const [entityType, setEntityType] = useState<
    "" | LoyaltyReconciliationEntityType
  >("");
  const [category, setCategory] =
    useState<(typeof LOYALTY_RECONCILIATION_GROUPS)[number]>("PHONE_MATCHED");
  const [status, setStatus] = useState<"" | LoyaltyReconciliationStatus>(
    "OPEN",
  );
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [definitions, setDefinitions] = useState<
    LoyaltyReconciliationDefinitionItem[]
  >([]);
  const [coverage, setCoverage] =
    useState<LoyaltyReconciliationCoverage | null>(null);
  const [rows, setRows] = useState<Awaited<
    ReturnType<typeof searchLoyaltyReconciliationGroup>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [decisionRow, setDecisionRow] =
    useState<LoyaltyReconciliationRow | null>(null);
  const definitionMap = useMemo(
    () => new Map(definitions.map((item) => [item.code, item])),
    [definitions],
  );
  const request = useMemo(
    () => ({
      base,
      ...(entityType ? { entityType } : {}),
      category,
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
      page,
      pageSize: 30,
    }),
    [base, category, entityType, page, search, status],
  );
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextDefinitions, nextCoverage, nextRows] = await Promise.all([
        definitions.length
          ? Promise.resolve(definitions)
          : getLoyaltyReconciliationDefinitions(),
        getLoyaltyReconciliationCoverage(base, entityType || undefined),
        searchLoyaltyReconciliationGroup(request),
      ]);
      setDefinitions(nextDefinitions);
      setCoverage(nextCoverage);
      setRows(nextRows);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить сверку",
      );
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [base, definitions, entityType, request]);
  useEffect(() => {
    void load();
  }, [load]);
  const changeScope = (next: () => void) => {
    next();
    setPage(1);
  };
  const exportCsv = async () => {
    setExporting(true);
    setError("");
    try {
      const result = await exportLoyaltyReconciliationGroup({
        ...request,
        maxRows: 10000,
      });
      downloadBlob(result.blob, result.filename);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось экспортировать группу",
      );
    } finally {
      setExporting(false);
    }
  };
  return (
    <section className="space-y-4" aria-label="Расширенная сверка двух баз">
      <div className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <Scale className="h-5 w-5 text-accent" /> Сверка v2
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Семь непересекающихся представлений доступны отдельно для базы
              Анны и кабинета. Счётчики групп могут пересекаться; записи не
              объединяются автоматически.
            </p>
          </div>
          <div className="flex gap-2">
            {canExport && (
              <button
                className="btn btn-secondary"
                disabled={exporting || loading}
                onClick={() => void exportCsv()}
              >
                {exporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}{" "}
                Экспорт группы
              </button>
            )}
            <button
              className="btn btn-secondary"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCcw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />{" "}
              Обновить
            </button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">
            <span className="mb-1 block text-text-muted">База</span>
            <select
              className="input w-full"
              value={base}
              onChange={(event) =>
                changeScope(() =>
                  setBase(event.target.value as LoyaltyReconciliationBase),
                )
              }
            >
              <option value="anna">База Анны</option>
              <option value="ours">Наша база</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-text-muted">Тип записи</span>
            <select
              className="input w-full"
              value={entityType}
              onChange={(event) =>
                changeScope(() =>
                  setEntityType(
                    event.target.value as "" | LoyaltyReconciliationEntityType,
                  ),
                )
              }
            >
              <option value="">Все типы</option>
              <option value="BROKER">Брокеры</option>
              <option value="AGENCY">Агентства</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-text-muted">Статус решения</span>
            <select
              className="input w-full"
              value={status}
              onChange={(event) =>
                changeScope(() =>
                  setStatus(
                    event.target.value as "" | LoyaltyReconciliationStatus,
                  ),
                )
              }
            >
              <option value="">Все статусы</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <form
            className="text-sm"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchDraft.trim());
              setPage(1);
            }}
          >
            <span className="mb-1 block text-text-muted">
              Поиск (уходит только в POST)
            </span>
            <div className="flex gap-2">
              <input
                className="input min-w-0 flex-1"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Имя, телефон, агентство"
              />
              <button className="btn btn-primary" type="submit">
                Найти
              </button>
            </div>
          </form>
        </div>
      </div>
      {error && (
        <div className="rounded-xl bg-error/10 p-4 text-error">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {error}
        </div>
      )}
      {coverage && (
        <div className="card space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Всего", coverage.total],
              ["Классифицировано", coverage.classified],
              ["Без группы", coverage.unclassified],
              ["В нескольких группах", coverage.overlapEntities],
              [
                "Покрытие",
                `${coverage.coveragePercent.toLocaleString("ru-RU")}%`,
              ],
            ].map(([label, value]) => (
              <div className="rounded-xl border border-border p-3" key={label}>
                <span className="text-xs text-text-muted">{label}</span>
                <b className="mt-1 block text-xl">
                  {typeof value === "number"
                    ? value.toLocaleString("ru-RU")
                    : value}
                </b>
              </div>
            ))}
          </div>
          <p className="text-xs text-text-muted">
            Снимок: {coverage.snapshotId || "Нет данных"}. Группы могут
            пересекаться; «классифицировано» считает уникальные записи.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {coverage.groups.map((group) => (
              <button
                type="button"
                key={group.category}
                onClick={() => changeScope(() => setCategory(group.category))}
                className={`rounded-xl border p-3 text-left transition ${category === group.category ? "border-accent bg-accent/10" : "border-border hover:border-accent/50"}`}
                title={group.definition.calculation}
              >
                <span className="text-sm font-medium">
                  {group.definition.label}
                </span>
                <b className="mt-1 block text-lg">
                  {group.count.toLocaleString("ru-RU")}
                </b>
                <small className="line-clamp-2 text-text-muted">
                  {group.definition.calculation}
                </small>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">
              {rows?.definition.label ||
                definitionMap.get(category)?.label ||
                GROUP_FALLBACK[category]}
            </h3>
            <p className="text-xs text-text-muted">
              {rows?.definition.calculation ||
                definitionMap.get(category)?.calculation ||
                "Формула загружается с сервера"}
            </p>
          </div>
          <span className="rounded-full bg-accent/10 px-3 py-1 text-sm text-accent">
            {rows
              ? `${rows.total.toLocaleString("ru-RU")} записей`
              : "Количество уточняется"}
          </span>
        </div>
        {loading ? (
          <div className="flex justify-center gap-2 py-16 text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" /> Загружаем группу…
          </div>
        ) : !rows?.items.length ? (
          <div className="py-14 text-center text-text-muted">
            <Users className="mx-auto h-9 w-9" />
            <b className="mt-2 block text-text">Записи не найдены</b>
            <p className="text-sm">
              Измените группу, статус или поисковый запрос.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.items.map((row) => (
              <article
                key={row.key}
                className="rounded-xl border border-border p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full bg-surface-secondary px-2 py-1">
                      {STATUS_LABELS[row.status]}
                    </span>
                    {row.score !== null && <span>оценка: {row.score}</span>}
                    {row.matchCodes.map((code) => (
                      <span
                        className="rounded-full bg-accent/10 px-2 py-1 text-accent"
                        key={code}
                      >
                        {code}
                      </span>
                    ))}
                  </div>
                  {canDecide && row.allowedActions.length > 0 && (
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => setDecisionRow(row)}
                    >
                      <ShieldCheck className="h-4 w-4" /> Принять решение
                    </button>
                  )}
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <PartyCard title="База Анны" party={row.anna} />
                  <PartyCard title="Наша база" party={row.ours} />
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  <div>
                    <p className="text-xs font-medium text-text-muted">
                      Основания
                    </p>
                    <p className="text-sm">
                      {row.reasons.length
                        ? row.reasons.join(" · ")
                        : "Нет данных"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-text-muted">
                      Решение
                    </p>
                    <p className="text-sm">{row.decision || "Не принято"}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {rows && rows.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm text-text-muted">
              Страница {rows.page} из {rows.totalPages}
            </span>
            <div className="flex gap-2">
              <button
                className="btn btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                className="btn btn-secondary"
                disabled={page >= rows.totalPages}
                onClick={() =>
                  setPage((value) => Math.min(rows.totalPages, value + 1))
                }
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="text-xs text-text-muted">
        Даты решений и запусков отображаются по данным сервера. Последняя
        загрузка интерфейса: {formatDate(new Date().toISOString())}.
      </p>
      {decisionRow && (
        <DecisionModal
          row={decisionRow}
          onClose={() => setDecisionRow(null)}
          onDone={() => {
            setDecisionRow(null);
            void load();
          }}
        />
      )}
    </section>
  );
}
