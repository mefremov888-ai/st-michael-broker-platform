"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bookmark, Loader2, Save, Trash2 } from "lucide-react";
import type { LoyaltyBaseKey, LoyaltyEntityType } from "@/lib/loyalty-base-api";
import {
  createLoyaltySavedView,
  deleteLoyaltySavedView,
  getLoyaltySavedViews,
  updateLoyaltySavedView,
  type LoyaltySavedView,
} from "@/lib/loyalty-workflow-api";

export function LoyaltySavedViews({
  base,
  entityType,
  currentSnapshot,
  currentUserId,
  canManageShared,
  isAdmin,
  onApply,
}: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  currentSnapshot: Record<string, unknown>;
  currentUserId: string;
  canManageShared: boolean;
  isAdmin: boolean;
  onApply: (snapshot: Record<string, unknown>) => void;
}) {
  const [views, setViews] = useState<LoyaltySavedView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const selected = useMemo(
    () => views.find((view) => view.id === selectedId) || null,
    [selectedId, views],
  );
  const canEditSelected = Boolean(
    selected &&
    (isAdmin || selected.owner?.id === currentUserId) &&
    (!selected.isShared || canManageShared),
  );

  const load = useCallback(async () => {
    setBusy("load");
    setError("");
    try {
      const next = await getLoyaltySavedViews({ base, entityType });
      setViews(next);
      setSelectedId((current) =>
        next.some((view) => view.id === current) ? current : "",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить сохранённые представления",
      );
    } finally {
      setBusy("");
    }
  }, [base, entityType]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const save = async () => {
    const name = window.prompt("Название представления")?.trim();
    if (!name) return;
    setBusy("save");
    setError("");
    try {
      await createLoyaltySavedView({
        name,
        base,
        entityType,
        filters: currentSnapshot,
        shared: canManageShared && shared,
      });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Не удалось сохранить",
      );
      setBusy("");
    }
  };

  const rename = async () => {
    if (!selected || !canEditSelected) return;
    const name = window.prompt("Новое название", selected.name)?.trim();
    if (!name || name === selected.name) return;
    setBusy(selected.id);
    try {
      await updateLoyaltySavedView(selected.id, { name });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Не удалось переименовать",
      );
      setBusy("");
    }
  };

  const replace = async () => {
    if (!selected || !canEditSelected) return;
    setBusy(selected.id);
    try {
      await updateLoyaltySavedView(selected.id, { filters: currentSnapshot });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Не удалось обновить",
      );
      setBusy("");
    }
  };

  const remove = async () => {
    if (!selected || !canEditSelected) return;
    if (!window.confirm(`Удалить представление «${selected.name}»?`)) return;
    setBusy(selected.id);
    try {
      await deleteLoyaltySavedView(selected.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось удалить");
      setBusy("");
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Bookmark className="h-4 w-4 text-accent" />
        <select
          className="input min-w-64 flex-1"
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
          aria-label="Сохранённое представление"
        >
          <option value="">Сохранённые представления</option>
          {views.map((view) => (
            <option key={view.id} value={view.id}>
              {view.isShared ? "Общее · " : "Моё · "}
              {view.name}
            </option>
          ))}
        </select>
        <button
          className="btn btn-secondary"
          disabled={!selected}
          onClick={() => selected && onApply(selected.filterSnapshot)}
        >
          Применить
        </button>
        <button
          className="btn btn-secondary"
          disabled={busy === "save"}
          onClick={() => void save()}
        >
          {busy === "save" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Сохранить
        </button>
        {canManageShared && (
          <label className="flex items-center gap-1 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={shared}
              onChange={(event) => setShared(event.target.checked)}
            />
            общее
          </label>
        )}
        {canEditSelected && (
          <>
            <button
              className="text-xs underline"
              onClick={() => void replace()}
            >
              Обновить текущими фильтрами
            </button>
            <button className="text-xs underline" onClick={() => void rename()}>
              Переименовать
            </button>
            <button
              className="flex items-center gap-1 text-xs text-error underline"
              onClick={() => void remove()}
            >
              <Trash2 className="h-3 w-3" /> Удалить
            </button>
          </>
        )}
      </div>
      <p className="mt-2 text-xs text-text-muted">
        Строка поиска не сохраняется: это защищает телефоны, почту и другие
        персональные данные.
      </p>
      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </div>
  );
}
