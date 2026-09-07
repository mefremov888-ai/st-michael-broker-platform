"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Trash2, X } from "lucide-react";
import {
  LOYALTY_PERMISSIONS,
  createLoyaltyGrant,
  getLoyaltyGrantTargets,
  getLoyaltyGrants,
  replaceLoyaltyGrantProfile,
  revokeLoyaltyGrant,
  type LoyaltyGrant,
  type LoyaltyOperator,
  type LoyaltyPermission,
} from "@/lib/loyalty-workflow-api";

const LABELS: Record<LoyaltyPermission, string> = {
  READ_ALL: "Чтение всей базы",
  READ_OWN_QUEUE: "Своя очередь",
  CALL_EXECUTE: "Выполнение звонков",
  CALL_ASSIGN: "Назначение звонков",
  ENTITY_EDIT: "Изменение записей",
  REFERENCE_MANAGE: "Справочники и представления",
  EXPORT: "Экспорт",
  IMPORT: "Импорт",
  RECONCILE: "Сверка",
  AUDIT_READ: "Чтение аудита",
  ANALYTICS_SYNC: "Проверка источников",
};

const PROFILE_BUNDLES = {
  OBSERVER: {
    label: "Наблюдатель",
    description: "Только просмотр базы без звонков и изменений.",
    permissions: ["READ_ALL"],
  },
  OPERATOR: {
    label: "Оператор колл-центра",
    description: "Только своя очередь и сохранение результатов звонков.",
    permissions: ["READ_OWN_QUEUE", "CALL_EXECUTE"],
  },
  ANALYST: {
    label: "Аналитик",
    description:
      "Просмотр, аудит, экспорт и безопасные проверки источников без звонков.",
    permissions: [
      "READ_ALL",
      "EXPORT",
      "IMPORT",
      "RECONCILE",
      "AUDIT_READ",
      "ANALYTICS_SYNC",
    ],
  },
  LEADER: {
    label: "Руководитель колл-центра",
    description: "Полное управление рабочими списками и сотрудниками.",
    permissions: [...LOYALTY_PERMISSIONS],
  },
} as const satisfies Record<
  string,
  {
    label: string;
    description: string;
    permissions: readonly LoyaltyPermission[];
  }
>;

type LoyaltyProfile = keyof typeof PROFILE_BUNDLES;

const date = (value: string) => {
  const parsed = new Date(value);
  return value && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleString("ru-RU")
    : "Нет данных";
};

export function LoyaltyGrantsPanel({ onClose }: { onClose: () => void }) {
  const [managers, setManagers] = useState<LoyaltyOperator[]>([]);
  const [userId, setUserId] = useState("");
  const [permission, setPermission] = useState<LoyaltyPermission>("READ_ALL");
  const [profile, setProfile] = useState<LoyaltyProfile>("OPERATOR");
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [grants, setGrants] = useState<LoyaltyGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextGrants, nextManagers] = await Promise.all([
        getLoyaltyGrants(includeRevoked),
        getLoyaltyGrantTargets(),
      ]);
      setGrants(nextGrants);
      setManagers(nextManagers);
      setUserId((current) =>
        current && nextManagers.some((item) => item.id === current)
          ? current
          : nextManagers[0]?.id || "",
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Не удалось загрузить права",
      );
    } finally {
      setLoading(false);
    }
  }, [includeRevoked]);
  useEffect(() => {
    void load();
  }, [load]);
  const grant = async () => {
    if (!userId) return setError("Выберите сотрудника.");
    setBusy("create");
    setError("");
    try {
      await createLoyaltyGrant(userId, permission);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Не удалось выдать право",
      );
    } finally {
      setBusy("");
    }
  };
  const revoke = async (id: string) => {
    if (!window.confirm("Отозвать это право у сотрудника?")) return;
    setBusy(id);
    setError("");
    try {
      await revokeLoyaltyGrant(id);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Не удалось отозвать право",
      );
    } finally {
      setBusy("");
    }
  };
  const applyProfile = async () => {
    if (!userId) return setError("Выберите сотрудника.");
    const selected = PROFILE_BUNDLES[profile];
    if (
      !window.confirm(
        `Назначить профиль «${selected.label}»? Текущий набор прав сотрудника будет заменён.`,
      )
    )
      return;
    setBusy("profile");
    setError("");
    try {
      await replaceLoyaltyGrantProfile(userId, selected.permissions);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось назначить профиль",
      );
    } finally {
      setBusy("");
    }
  };
  return (
    <section
      className="card space-y-4"
      aria-label="Управление правами базы лояльности"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <KeyRound className="h-5 w-5 text-accent" /> Права сотрудников
          </h2>
          <p className="text-sm text-text-muted">
            Права выдаются только активным менеджерам и записываются в аудит.
            Роль администратора не меняется.
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Закрыть права">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
        <label className="text-sm">
          <span className="mb-1 block text-text-muted">Сотрудник</span>
          <select
            className="input w-full"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          >
            <option value="">Выберите сотрудника</option>
            {managers.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-text-muted">Право</span>
          <select
            className="input w-full"
            value={permission}
            onChange={(event) =>
              setPermission(event.target.value as LoyaltyPermission)
            }
          >
            {LOYALTY_PERMISSIONS.map((item) => (
              <option value={item} key={item}>
                {LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn btn-primary"
          disabled={!userId || Boolean(busy)}
          onClick={() => void grant()}
        >
          {busy === "create" && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
          Выдать
        </button>
      </div>
      <div className="rounded-xl border border-border bg-surface-secondary p-4">
        <div className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
          <label className="text-sm">
            <span className="mb-1 block text-text-muted">Готовый профиль</span>
            <select
              className="input w-full"
              value={profile}
              onChange={(event) =>
                setProfile(event.target.value as LoyaltyProfile)
              }
            >
              {Object.entries(PROFILE_BUNDLES).map(([code, item]) => (
                <option value={code} key={code}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm text-text-muted">
            {PROFILE_BUNDLES[profile].description}
          </p>
          <button
            className="btn btn-secondary"
            disabled={!userId || Boolean(busy)}
            onClick={() => void applyProfile()}
          >
            {busy === "profile" && <Loader2 className="h-4 w-4 animate-spin" />}
            Назначить профиль
          </button>
        </div>
      </div>
      {error && (
        <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{error}</p>
      )}
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">Выданные права</h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeRevoked}
            onChange={(event) => setIncludeRevoked(event.target.checked)}
          />{" "}
          Показать отозванные
        </label>
      </div>
      {loading ? (
        <div className="flex gap-2 py-8 text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Загружаем права…
        </div>
      ) : !grants.length ? (
        <p className="rounded-xl bg-surface-secondary p-4 text-sm text-text-muted">
          Отдельных прав пока нет.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-surface-secondary text-left">
              <tr>
                <th className="p-3">Сотрудник</th>
                <th className="p-3">Право</th>
                <th className="p-3">Выдал</th>
                <th className="p-3">Дата</th>
                <th className="p-3">Статус</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {grants.map((item) => (
                <tr className="border-t border-border" key={item.id}>
                  <td className="p-3">{item.user?.name || item.userId}</td>
                  <td className="p-3">
                    {LABELS[item.permission] || item.permission}
                  </td>
                  <td className="p-3">{item.grantedBy?.name || "Система"}</td>
                  <td className="p-3">{date(item.grantedAt)}</td>
                  <td className="p-3">
                    {item.revokedAt
                      ? `Отозвано ${date(item.revokedAt)}`
                      : "Активно"}
                  </td>
                  <td className="p-3 text-right">
                    {!item.revokedAt && (
                      <button
                        className="text-error"
                        disabled={Boolean(busy)}
                        onClick={() => void revoke(item.id)}
                        aria-label="Отозвать право"
                      >
                        {busy === item.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
