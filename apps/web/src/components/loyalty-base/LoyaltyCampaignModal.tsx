"use client";

import { useState } from "react";
import { Loader2, Megaphone, X } from "lucide-react";
import type {
  LoyaltyBaseKey,
  LoyaltyCanonicalFilter,
  LoyaltyColumnFilters,
  LoyaltyEntityType,
  LoyaltySegment,
  LoyaltySortField,
} from "@/lib/loyalty-base-api";
import {
  activateLoyaltyCampaign,
  assignLoyaltyCampaign,
  createLoyaltyCampaign,
  getLoyaltyCampaign,
  previewLoyaltyCampaignAssignments,
  type LoyaltyOperator,
} from "@/lib/loyalty-workflow-api";

export function LoyaltyCampaignModal({
  base,
  entityType,
  selection,
  selectedCount,
  operators,
  filterSnapshot,
  filterHash,
  snapshotId,
  onClose,
  onDone,
}: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  selection:
    | { mode: "IDS"; ids: string[] }
    | {
        mode: "FILTER";
        filterHash: string;
        expectedCount: number;
        excludedIds?: string[];
      };
  selectedCount: number;
  operators: LoyaltyOperator[];
  filterSnapshot: {
    search: string;
    city?: string;
    hasAmo?: boolean;
    archived: "exclude" | "include" | "only";
    sortBy?: LoyaltySortField;
    sortOrder?: "asc" | "desc";
    filter: LoyaltyCanonicalFilter;
    columns?: LoyaltyColumnFilters;
    segment?: LoyaltySegment;
  };
  filterHash: string;
  snapshotId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [assigneeId, setAssigneeId] = useState(operators[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{ id: string; version: number } | null>(
    null,
  );
  const [phase, setPhase] = useState<
    "create" | "preview" | "assign" | "activate"
  >("create");

  const submit = async () => {
    if (!name.trim() || !message.trim() || !assigneeId) {
      setError("Укажите название, посыл и сотрудника.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let campaign = draft;
      if (!campaign) {
        setPhase("create");
        campaign = await createLoyaltyCampaign({
          name: name.trim(),
          message: message.trim(),
          base,
          entityType,
          filterSnapshot,
          filterHash,
          snapshotId,
          selection,
        });
        setDraft(campaign);
      } else {
        const current = await getLoyaltyCampaign(campaign.id);
        if (["ACTIVE", "COMPLETED"].includes(current.status)) {
          onDone();
          return;
        }
        campaign = { id: current.id, version: current.version };
        setDraft(campaign);
      }
      const assignment = { assigneeId, selection };
      setPhase("preview");
      await previewLoyaltyCampaignAssignments(campaign.id, assignment);
      setPhase("assign");
      const assignedVersion = await assignLoyaltyCampaign(
        campaign.id,
        assignment,
      );
      const activationVersion = assignedVersion ?? campaign.version;
      setDraft({ id: campaign.id, version: activationVersion });
      setPhase("activate");
      try {
        await activateLoyaltyCampaign(campaign.id, activationVersion);
      } catch (activationError) {
        // If the response was lost, reconcile state instead of creating a duplicate.
        const current = await getLoyaltyCampaign(campaign.id).catch(() => null);
        if (current && ["ACTIVE", "COMPLETED"].includes(current.status)) {
          onDone();
          return;
        }
        if (current) setDraft({ id: current.id, version: current.version });
        throw activationError;
      }
      onDone();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сформировать список",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-xl rounded-2xl bg-surface p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Сформировать список на обзвон"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Megaphone className="h-5 w-5 text-accent" /> Сформировать список
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Будет назначено записей: <b>{selectedCount}</b>. Данные в amoCRM
              не изменяются.
            </p>
          </div>
          <button
            className="rounded-lg p-2 hover:bg-surface-secondary"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {draft && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
              Черновик сохранён: <b>{draft.id}</b>. Повтор продолжит этот же
              черновик с этапа «
              {phase === "preview"
                ? "проверка"
                : phase === "assign"
                  ? "назначение"
                  : "активация"}
              ».
            </div>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">
              Название обзвона *
            </span>
            <input
              className="input"
              value={name}
              disabled={Boolean(draft)}
              maxLength={160}
              onChange={(event) => setName(event.target.value)}
              placeholder="Например, Приглашение на индивидуальный БТ"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">
              Название и посыл обзвона *
            </span>
            <textarea
              className="input min-h-24 resize-y"
              value={message}
              disabled={Boolean(draft)}
              maxLength={1000}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Что предложить и что уточнить у контакта"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-text-muted">
              Назначить сотруднику *
            </span>
            <select
              className="input"
              value={assigneeId}
              disabled={Boolean(draft)}
              onChange={(event) => setAssigneeId(event.target.value)}
            >
              <option value="">Выберите сотрудника</option>
              {operators.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <div className="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {draft ? "Продолжить черновик" : `Назначить ${selectedCount}`}
          </button>
        </div>
      </div>
    </div>
  );
}
