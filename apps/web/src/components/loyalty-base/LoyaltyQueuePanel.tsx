"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Phone, RefreshCcw, X } from "lucide-react";
import {
  getLoyaltyCallResultOptions,
  type LoyaltyCallResult,
} from "@/lib/loyalty-base-api";
import {
  getMyLoyaltyQueue,
  localDateTimeInputToIso,
  submitLoyaltyCall,
  type LoyaltyOperator,
  type LoyaltyQueueItem,
} from "@/lib/loyalty-workflow-api";
import { LoyaltyCallResultBadge } from "./LoyaltyCallResultBadge";

type Draft = {
  result: LoyaltyCallResult | "";
  comment: string;
  nextStep: string;
  nextActionAt: string;
};

const emptyDraft = (): Draft => ({
  result: "",
  comment: "",
  nextStep: "",
  nextActionAt: "",
});

export function LoyaltyQueuePanel({
  isAdmin,
  canViewAllQueues,
  currentUserId,
  operators,
  onClose,
}: {
  isAdmin: boolean;
  canViewAllQueues: boolean;
  currentUserId: string;
  operators: LoyaltyOperator[];
  onClose: () => void;
}) {
  const [assigneeId, setAssigneeId] = useState("");
  const [rows, setRows] = useState<LoyaltyQueueItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [submissionIds, setSubmissionIds] = useState<Record<string, string>>(
    {},
  );
  const [saving, setSaving] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (requestedPage = 1, append = false) => {
      setLoading(true);
      setError("");
      try {
        const result = await getMyLoyaltyQueue({
          assigneeId: assigneeId || undefined,
          page: requestedPage,
          pageSize: 100,
        });
        setRows((current) =>
          append
            ? [
                ...current,
                ...result.items.filter(
                  (item) => !current.some((row) => row.id === item.id),
                ),
              ]
            : result.items,
        );
        setPage(result.page);
        setTotal(result.total);
        setRemaining(result.remaining);
        setTotalPages(result.totalPages);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Не удалось загрузить очередь",
        );
      } finally {
        setLoading(false);
      }
    },
    [assigneeId],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  const draft = (id: string) => drafts[id] || emptyDraft();
  const patch = (id: string, value: Partial<Draft>) =>
    setDrafts((current) => ({
      ...current,
      [id]: { ...draft(id), ...value },
    }));

  const save = async (row: LoyaltyQueueItem) => {
    const value = draft(row.id);
    if (!value.result) {
      setError("Выберите результат звонка.");
      return;
    }
    if (row.entityType === "agencies" && !value.comment.trim()) {
      setError(
        value.result === "AGREEMENTS_EXIST"
          ? "Для результата «Есть договорённости» укажите содержание договорённости."
          : "Для звонка агентству укажите краткий комментарий.",
      );
      return;
    }
    setSaving(row.id);
    setError("");
    const submissionId = submissionIds[row.id] || crypto.randomUUID();
    if (!submissionIds[row.id]) {
      setSubmissionIds((current) => ({ ...current, [row.id]: submissionId }));
    }
    try {
      const response = await submitLoyaltyCall({
        assignmentId: row.id,
        expectedVersion: row.version,
        submissionId,
        result: value.result,
        comment: value.comment.trim(),
        nextStep: value.nextStep.trim() || undefined,
        nextActionAt: value.nextActionAt
          ? localDateTimeInputToIso(value.nextActionAt)
          : undefined,
      });
      // Optimistic removal is deliberate: a completed row must immediately
      // leave the active queue. The API's idempotency key protects retries.
      setRows((current) => current.filter((item) => item.id !== row.id));
      setRemaining(response.remaining);
      setTotal((current) => Math.max(0, current - 1));
      setDrafts((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      setSubmissionIds((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      await load(1, false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить звонок",
      );
    } finally {
      setSaving("");
    }
  };

  return (
    <div className="fixed inset-0 z-[65] overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-surface/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">Мой список на обзвон</h1>
            <p className="text-sm text-text-muted">
              Осталось позвонить: <b>{remaining}</b>
              {total > remaining ? ` · всего назначено: ${total}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canViewAllQueues && (
              <select
                className="input w-56"
                value={assigneeId}
                onChange={(event) => setAssigneeId(event.target.value)}
                aria-label="Список сотрудника"
              >
                <option value="">Моя очередь</option>
                {operators.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn btn-secondary"
              onClick={() => void load(1, false)}
              disabled={loading}
            >
              <RefreshCcw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />{" "}
              Обновить
            </button>
            <button className="btn btn-secondary" onClick={onClose}>
              <X className="h-4 w-4" /> Закрыть
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-3 p-4">
        {error && (
          <div className="rounded-lg bg-error/10 p-3 text-error">{error}</div>
        )}
        {loading ? (
          <div className="card flex items-center justify-center gap-2 py-20 text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" /> Загружаем очередь…
          </div>
        ) : rows.length === 0 && remaining === 0 ? (
          <div className="card py-20 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
            <h2 className="mt-3 text-lg font-semibold">Обзвон завершён</h2>
            <p className="text-sm text-text-muted">
              В активной очереди больше нет контактов.
            </p>
          </div>
        ) : (
          <>
            {rows.length === 0 && remaining > 0 && (
              <div className="card py-12 text-center text-sm text-text-muted">
                В очереди осталось {remaining}, загрузите актуальную страницу.
              </div>
            )}
            {rows.map((row) => {
              const value = draft(row.id);
              const readOnly = Boolean(
                assigneeId && !isAdmin && assigneeId !== currentUserId,
              );
              const resultOptions = getLoyaltyCallResultOptions(
                row.entityType,
              );
              return (
                <article key={row.id} className="card space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">{row.targetName}</h2>
                      <p className="text-sm text-text-muted">
                        {row.company ||
                          row.context ||
                          "Нет дополнительного контекста"}
                      </p>
                    </div>
                    {row.phone ? (
                      <a
                        className="btn btn-primary"
                        href={`tel:${row.phone.replace(/[^+\d]/g, "")}`}
                      >
                        <Phone className="h-4 w-4" /> {row.phone}
                      </a>
                    ) : (
                      <span className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
                        Телефон не указан
                      </span>
                    )}
                  </div>
                  <div className="rounded-xl border border-accent/25 bg-accent/5 p-3">
                    <div className="font-semibold">
                      {row.campaign.name || "Обзвон"}
                    </div>
                    <p className="mt-1 text-sm">
                      {row.campaign.message || "Посыл кампании не указан"}
                    </p>
                  </div>
                  {readOnly && (
                    <p className="rounded-lg bg-warning/10 p-2 text-xs text-warning">
                      Очередь коллеги открыта только для просмотра.
                    </p>
                  )}
                  <fieldset
                    className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
                    disabled={readOnly}
                  >
                    <label className="text-xs text-text-muted">
                      Результат *
                      <select
                        className="input mt-1"
                        value={value.result}
                        onChange={(event) =>
                          patch(row.id, {
                            result: event.target.value as LoyaltyCallResult,
                          })
                        }
                      >
                        <option value="">Выберите результат</option>
                        {resultOptions.map(({ code, label }) => (
                          <option key={code} value={code}>
                            {label}
                          </option>
                        ))}
                      </select>
                      {value.result && (
                        <LoyaltyCallResultBadge
                          result={value.result}
                          entityType={row.entityType}
                          className="mt-1"
                        />
                      )}
                    </label>
                    <label className="text-xs text-text-muted md:col-span-1 xl:col-span-2">
                      Комментарий / договорённость
                      {row.entityType === "agencies" ? " *" : ""}
                      <input
                        className="input mt-1"
                        value={value.comment}
                        maxLength={1000}
                        onChange={(event) =>
                          patch(row.id, { comment: event.target.value })
                        }
                      />
                    </label>
                    <label className="text-xs text-text-muted">
                      Следующее действие
                      <input
                        className="input mt-1"
                        type="datetime-local"
                        value={value.nextActionAt}
                        onChange={(event) =>
                          patch(row.id, { nextActionAt: event.target.value })
                        }
                      />
                    </label>
                    <label className="text-xs text-text-muted md:col-span-2 xl:col-span-3">
                      Следующий шаг
                      <input
                        className="input mt-1"
                        value={value.nextStep}
                        maxLength={500}
                        onChange={(event) =>
                          patch(row.id, { nextStep: event.target.value })
                        }
                      />
                    </label>
                    <button
                      className="btn btn-primary self-end"
                      disabled={saving === row.id}
                      onClick={() => void save(row)}
                    >
                      {saving === row.id && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      Сохранить
                    </button>
                  </fieldset>
                </article>
              );
            })}
            {page < totalPages && (
              <div className="flex justify-center py-4">
                <button
                  className="btn btn-secondary"
                  disabled={loading}
                  onClick={() => void load(page + 1, true)}
                >
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  Показать ещё
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
