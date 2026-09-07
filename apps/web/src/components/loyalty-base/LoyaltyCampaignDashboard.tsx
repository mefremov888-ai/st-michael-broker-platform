"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Download,
  Loader2,
  Megaphone,
  Play,
  RefreshCcw,
  X,
} from "lucide-react";
import {
  downloadBlob,
  type LoyaltyBaseKey,
  type LoyaltyEntityType,
} from "@/lib/loyalty-base-api";
import {
  activateLoyaltyCampaign,
  archiveLoyaltyCampaign,
  assignLoyaltyCampaign,
  exportLoyaltyCampaign,
  getLoyaltyCampaign,
  getLoyaltyCampaigns,
  previewLoyaltyCampaignAssignments,
  type LoyaltyCampaign,
  type LoyaltyCampaignDetail,
  type LoyaltyOperator,
} from "@/lib/loyalty-workflow-api";
import { LoyaltyCallResultBadge } from "./LoyaltyCallResultBadge";

const statusLabels: Record<LoyaltyCampaign["status"], string> = {
  DRAFT: "Черновик",
  ACTIVE: "Активна",
  COMPLETED: "Завершена",
  ARCHIVED: "В архиве",
};

const assignmentLabels: Record<string, string> = {
  PENDING: "Ожидает",
  IN_PROGRESS: "В работе",
  COMPLETED: "Завершено",
  CANCELLED: "Отменено",
};

const displayDate = (value: string) =>
  value
    ? new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";

export function LoyaltyCampaignDashboard({
  base,
  entityType,
  canAssign,
  canExport,
  operators,
  onClose,
  onChanged,
}: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  canAssign: boolean;
  canExport: boolean;
  operators: LoyaltyOperator[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [campaigns, setCampaigns] = useState<LoyaltyCampaign[]>([]);
  const [status, setStatus] = useState<LoyaltyCampaign["status"] | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<LoyaltyCampaignDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailPage, setDetailPage] = useState(1);
  const [busyAction, setBusyAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [assigneeId, setAssigneeId] = useState(operators[0]?.id || "");

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setCampaigns(
        await getLoyaltyCampaigns({
          base,
          entityType,
          status: status || undefined,
          limit: 200,
        }),
      );
    } catch (reason) {
      setCampaigns([]);
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить кампании",
      );
    } finally {
      setLoading(false);
    }
  }, [base, entityType, status]);

  const loadDetail = useCallback(async (id: string, page = 1) => {
    setSelectedId(id);
    setDetailPage(page);
    setDetailLoading(true);
    setDetailError("");
    setActionError("");
    try {
      const next = await getLoyaltyCampaign(id, { page, pageSize: 200 });
      setDetail(next);
      const existingAssignee = next.assignments.find((item) => item.assignedTo)
        ?.assignedTo?.id;
      if (existingAssignee) setAssigneeId(existingAssignee);
    } catch (reason) {
      setDetail(null);
      setDetailError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить кампанию",
      );
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  const counts = useMemo(
    () =>
      detail?.assignmentCounts || {
        PENDING: 0,
        IN_PROGRESS: 0,
        COMPLETED: 0,
        CANCELLED: 0,
      },
    [detail],
  );

  const refreshAll = async (id = selectedId, page = detailPage) => {
    await loadCampaigns();
    if (id) await loadDetail(id, page);
    onChanged();
  };

  const resumeDraft = async () => {
    if (!detail || detail.status !== "DRAFT" || !detail.selection) return;
    if (!assigneeId) {
      setActionError("Выберите сотрудника для недостающих назначений.");
      return;
    }
    setBusyAction("resume");
    setActionError("");
    try {
      const assignment = { assigneeId, selection: detail.selection };
      await previewLoyaltyCampaignAssignments(detail.id, assignment);
      await assignLoyaltyCampaign(detail.id, assignment);
      try {
        await activateLoyaltyCampaign(detail.id, detail.version);
      } catch (activationError) {
        const current = await getLoyaltyCampaign(detail.id).catch(() => null);
        if (!current || !["ACTIVE", "COMPLETED"].includes(current.status)) {
          throw activationError;
        }
      }
      await refreshAll(detail.id, detailPage);
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Не удалось продолжить черновик",
      );
      await loadDetail(detail.id, detailPage);
    } finally {
      setBusyAction("");
    }
  };

  const archive = async () => {
    if (!detail || detail.status === "ARCHIVED") return;
    if (
      !window.confirm(
        `Архивировать кампанию «${detail.name}»? Открытые назначения будут отменены.`,
      )
    )
      return;
    setBusyAction("archive");
    setActionError("");
    try {
      await archiveLoyaltyCampaign(detail.id, detail.version);
      await refreshAll(detail.id, detailPage);
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Не удалось архивировать кампанию",
      );
      await loadDetail(detail.id, detailPage);
    } finally {
      setBusyAction("");
    }
  };

  const exportProgress = async () => {
    if (!detail) return;
    setBusyAction("export");
    setActionError("");
    try {
      const result = await exportLoyaltyCampaign(detail.id);
      downloadBlob(result.blob, result.filename);
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Не удалось экспортировать прогресс",
      );
    } finally {
      setBusyAction("");
    }
  };

  return (
    <div className="fixed inset-0 z-[65] bg-black/50 p-3 md:p-6">
      <div className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-surface shadow-xl">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <Megaphone className="h-5 w-5 text-accent" /> Кампании обзвона
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Черновики сохраняются и доступны для продолжения или архивации.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="input min-w-40"
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as LoyaltyCampaign["status"] | "")
              }
            >
              <option value="">Все статусы</option>
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className="btn btn-secondary"
              onClick={() => void loadCampaigns()}
            >
              <RefreshCcw className="h-4 w-4" /> Обновить
            </button>
            <button
              className="rounded-lg p-2 hover:bg-surface-secondary"
              onClick={onClose}
              aria-label="Закрыть"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(300px,0.85fr)_minmax(0,1.5fr)]">
          <section className="overflow-y-auto border-b border-border p-4 md:border-b-0 md:border-r">
            {loading && (
              <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Загружаем кампании…
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-error/10 p-3 text-sm text-error">
                {error}
                <button
                  className="btn btn-secondary mt-3"
                  onClick={() => void loadCampaigns()}
                >
                  Повторить
                </button>
              </div>
            )}
            {!loading && !error && !campaigns.length && (
              <p className="py-8 text-sm text-text-muted">Кампаний пока нет.</p>
            )}
            <div className="space-y-2">
              {campaigns.map((item) => {
                const completed = Math.max(
                  0,
                  item.expectedCount - item.remainingCount,
                );
                const percent = item.expectedCount
                  ? Math.round((completed / item.expectedCount) * 100)
                  : 0;
                return (
                  <button
                    key={item.id}
                    className={`w-full rounded-xl border p-3 text-left ${selectedId === item.id ? "border-accent bg-accent/5" : "border-border hover:bg-surface-secondary"}`}
                    onClick={() => void loadDetail(item.id, 1)}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <b className="break-words">{item.name}</b>
                      <span className="shrink-0 rounded-full bg-surface-secondary px-2 py-1 text-xs">
                        {statusLabels[item.status]}
                      </span>
                    </span>
                    <span className="mt-2 block text-xs text-text-muted">
                      {item.status === "DRAFT"
                        ? `Выбрано: ${item.expectedCount}`
                        : `Обработано: ${completed} из ${item.expectedCount} (${percent}%)`}
                    </span>
                    <span className="mt-1 block text-xs text-text-muted">
                      {displayDate(item.createdAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="min-h-0 overflow-y-auto p-4 md:p-5">
            {!selectedId && (
              <p className="py-12 text-center text-sm text-text-muted">
                Выберите кампанию слева, чтобы увидеть прогресс и назначения.
              </p>
            )}
            {detailLoading && (
              <div className="flex items-center gap-2 py-12 text-text-muted">
                <Loader2 className="h-5 w-5 animate-spin" /> Загружаем кампанию…
              </div>
            )}
            {detailError && (
              <div className="rounded-lg bg-error/10 p-3 text-sm text-error">
                {detailError}
                <button
                  className="btn btn-secondary mt-3"
                  onClick={() => void loadDetail(selectedId, detailPage)}
                >
                  Повторить
                </button>
              </div>
            )}
            {detail && !detailLoading && !detailError && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">{detail.name}</h3>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-text-muted">
                      {detail.message}
                    </p>
                    <p className="mt-2 text-xs text-text-muted">
                      Создал: {detail.createdBy?.name || "—"} ·{" "}
                      {displayDate(detail.createdAt)}
                    </p>
                  </div>
                  <span className="rounded-full bg-surface-secondary px-3 py-1 text-sm">
                    {statusLabels[detail.status]}
                  </span>
                </div>

                <div className="grid gap-2 sm:grid-cols-4">
                  {Object.entries(counts).map(([key, value]) => (
                    <div
                      className="rounded-xl bg-surface-secondary p-3"
                      key={key}
                    >
                      <b className="text-xl">{value}</b>
                      <p className="text-xs text-text-muted">
                        {assignmentLabels[key] || key}
                      </p>
                    </div>
                  ))}
                </div>

                {detail.status === "DRAFT" && canAssign && (
                  <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                    <b>Восстановление черновика</b>
                    <p className="mt-1 text-sm text-text-muted">
                      Уже созданные назначения не дублируются; будут добавлены
                      только недостающие.
                    </p>
                    {!detail.selection && (
                      <p className="mt-2 text-sm text-error">
                        Сохранённая выборка недоступна. Такой черновик можно
                        только архивировать.
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <select
                        className="input min-w-64"
                        value={assigneeId}
                        onChange={(event) => setAssigneeId(event.target.value)}
                      >
                        <option value="">Выберите сотрудника</option>
                        {operators.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-primary"
                        disabled={!detail.selection || busyAction !== ""}
                        onClick={() => void resumeDraft()}
                      >
                        {busyAction === "resume" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                        Назначить недостающее и активировать
                      </button>
                    </div>
                  </div>
                )}

                {actionError && (
                  <div className="rounded-lg bg-error/10 p-3 text-sm text-error">
                    {actionError}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {canExport && (
                    <button
                      className="btn btn-secondary"
                      disabled={busyAction !== ""}
                      onClick={() => void exportProgress()}
                    >
                      {busyAction === "export" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}{" "}
                      Экспорт прогресса CSV
                    </button>
                  )}
                  {canAssign && detail.status !== "ARCHIVED" && (
                    <button
                      className="btn btn-secondary"
                      disabled={busyAction !== ""}
                      onClick={() => void archive()}
                    >
                      {busyAction === "archive" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Archive className="h-4 w-4" />
                      )}
                      Архивировать
                    </button>
                  )}
                </div>

                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-surface-secondary text-left text-xs text-text-muted">
                      <tr>
                        <th className="p-3">Запись</th>
                        <th className="p-3">Сотрудник</th>
                        <th className="p-3">Статус</th>
                        <th className="p-3">Результат</th>
                        <th className="p-3">Последняя попытка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.assignments.map((item) => (
                        <tr className="border-t border-border" key={item.id}>
                          <td className="p-3 font-mono text-xs">
                            {item.targetId || "—"}
                          </td>
                          <td className="p-3">
                            {item.assignedTo?.name || "—"}
                          </td>
                          <td className="p-3">
                            {assignmentLabels[item.status] || item.status}
                          </td>
                          <td className="p-3">
                            <LoyaltyCallResultBadge
                              result={item.lastResult}
                              entityType={detail.entityType}
                              emptyLabel="Результат не указан"
                            />
                          </td>
                          <td className="p-3">
                            {displayDate(item.lastAttemptAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!detail.assignments.length && (
                    <p className="p-6 text-center text-sm text-text-muted">
                      Назначений ещё нет.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-text-muted">
                    Назначений: {detail.assignmentPage.total} · страница{" "}
                    {detail.assignmentPage.page} из{" "}
                    {detail.assignmentPage.totalPages}
                  </span>
                  <div className="flex gap-2">
                    <button
                      className="btn btn-secondary"
                      disabled={detailLoading || detailPage <= 1}
                      onClick={() => void loadDetail(detail.id, detailPage - 1)}
                    >
                      Назад
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={
                        detailLoading ||
                        detailPage >= detail.assignmentPage.totalPages
                      }
                      onClick={() => void loadDetail(detail.id, detailPage + 1)}
                    >
                      Далее
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
