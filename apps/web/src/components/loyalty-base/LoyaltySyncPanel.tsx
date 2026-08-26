"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseZap,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  getLoyaltySyncRuns,
  runAmoLoyaltyDryRun,
  runGoogleLoyaltyDryRun,
  type LoyaltySyncRun,
  type LoyaltySyncSource,
} from "@/lib/loyalty-sync-api";

const sourceLabel = (source: LoyaltySyncSource) =>
  source === "GOOGLE_SHEETS"
    ? "Google Sheets · 4 вкладки"
    : "amoCRM · полный обход сущностей";

const formatDate = (value: string | null) => {
  if (!value) return "Нет данных";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("ru-RU");
};

const shortHash = (value: string | null) =>
  value ? `${value.slice(0, 12)}…${value.slice(-6)}` : "Нет данных";

const countSummary = (counts: Record<string, unknown> | null) => {
  if (!counts) return "Нет данных";
  const pairs = Object.entries(counts)
    .filter(([, value]) =>
      ["string", "number", "boolean"].includes(typeof value),
    )
    .slice(0, 8);
  return pairs.length
    ? pairs.map(([key, value]) => `${key}: ${String(value)}`).join(" · ")
    : "Детализация доступна в структурированном результате запуска";
};

export function LoyaltySyncPanel({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState<"" | LoyaltySyncSource>("");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [maxPages, setMaxPages] = useState(2000);
  const [runs, setRuns] = useState<LoyaltySyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<"" | LoyaltySyncSource>("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRuns(await getLoyaltySyncRuns(source || undefined, 30));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить историю проверок",
      );
    } finally {
      setLoading(false);
    }
  }, [source]);
  useEffect(() => {
    void load();
  }, [load]);
  const dryRun = async (nextSource: LoyaltySyncSource) => {
    setRunning(nextSource);
    setError("");
    setSuccess("");
    try {
      const result =
        nextSource === "GOOGLE_SHEETS"
          ? await runGoogleLoyaltyDryRun(spreadsheetId.trim() || undefined)
          : await runAmoLoyaltyDryRun(maxPages);
      setSuccess(
        `${sourceLabel(nextSource)} проверен. Хэш ${shortHash(result.contentHash)}. Публикация: нет.`,
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Проверка источника завершилась ошибкой",
      );
    } finally {
      setRunning("");
    }
  };
  return (
    <section
      className="card space-y-4"
      aria-label="Проверка источников только для чтения"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <DatabaseZap className="h-5 w-5 text-accent" /> Проверка источников
          </h2>
          <p className="mt-1 flex items-center gap-1 text-sm text-text-muted">
            <ShieldCheck className="h-4 w-4" /> Только чтение: проверка не
            публикует снимок и не изменяет Google Sheets, amoCRM или базу
            кабинета.
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Закрыть проверки">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <h3 className="font-semibold">Google Sheets</h3>
          <p className="mt-1 text-xs text-text-muted">
            Читает все четыре утверждённые вкладки, проверяет полноту, структуру
            и телефоны. Оставьте ID пустым для настроенного источника.
          </p>
          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-text-muted">
              ID таблицы (необязательно)
            </span>
            <input
              className="input w-full"
              value={spreadsheetId}
              onChange={(event) => setSpreadsheetId(event.target.value)}
              placeholder="Настроенный на сервере источник"
            />
          </label>
          <button
            className="btn btn-secondary mt-3"
            disabled={Boolean(running)}
            onClick={() => void dryRun("GOOGLE_SHEETS")}
          >
            {running === "GOOGLE_SHEETS" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="h-4 w-4" />
            )}{" "}
            Проверить 4 вкладки
          </button>
        </div>
        <div className="rounded-xl border border-border p-4">
          <h3 className="font-semibold">amoCRM</h3>
          <p className="mt-1 text-xs text-text-muted">
            Последовательно читает доступные контакты, компании и сделки.
            Частичный перечень не считается успешным. Полный обход сущностей не
            подтверждает историю событий, звонков или точность KPI.
          </p>
          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-text-muted">
              Предельное число страниц (1–2000)
            </span>
            <input
              className="input w-full"
              type="number"
              min={1}
              max={2000}
              value={maxPages}
              onChange={(event) =>
                setMaxPages(
                  Math.max(1, Math.min(2000, Number(event.target.value) || 1)),
                )
              }
            />
          </label>
          <button
            className="btn btn-secondary mt-3"
            disabled={Boolean(running)}
            onClick={() => void dryRun("AMOCRM")}
          >
            {running === "AMOCRM" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="h-4 w-4" />
            )}{" "}
            Проверить перечень сущностей
          </button>
        </div>
      </div>
      {success && (
        <p className="rounded-lg bg-success/10 p-3 text-sm text-success">
          <CheckCircle2 className="mr-2 inline h-4 w-4" />
          {success}
        </p>
      )}
      {error && (
        <p className="rounded-lg bg-error/10 p-3 text-sm text-error">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {error}
        </p>
      )}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">История проверок</h3>
          <select
            className="input w-auto"
            value={source}
            onChange={(event) =>
              setSource(event.target.value as "" | LoyaltySyncSource)
            }
          >
            <option value="">Все источники</option>
            <option value="GOOGLE_SHEETS">Google Sheets</option>
            <option value="AMOCRM">amoCRM</option>
          </select>
        </div>
        {loading ? (
          <div className="flex gap-2 py-6 text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Загружаем историю…
          </div>
        ) : !runs.length ? (
          <p className="rounded-xl bg-surface-secondary p-4 text-sm text-text-muted">
            Проверки ещё не запускались.
          </p>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <article
                className="rounded-xl border border-border p-3"
                key={run.id}
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <div>
                    <b>{sourceLabel(run.source)}</b>
                    <p className="text-xs text-text-muted">
                      Начало: {formatDate(run.startedAt)} · завершение:{" "}
                      {formatDate(run.completedAt)}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs ${run.status === "SUCCEEDED" ? "bg-success/10 text-success" : run.status === "FAILED" ? "bg-error/10 text-error" : "bg-accent/10 text-accent"}`}
                  >
                    {run.status === "SUCCEEDED"
                      ? "Успешно"
                      : run.status === "FAILED"
                        ? "Ошибка"
                        : "Выполняется"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-text-muted">
                  Правило: {run.ruleVersion} · хэш содержимого:{" "}
                  {shortHash(run.contentHash)}
                  {run.errorCode ? ` · код ошибки: ${run.errorCode}` : ""}
                </p>
                <p className="mt-1 text-xs">{countSummary(run.counts)}</p>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
