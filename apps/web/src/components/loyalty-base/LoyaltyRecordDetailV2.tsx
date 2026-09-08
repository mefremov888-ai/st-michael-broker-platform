"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Gift,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  formatRubles,
  getLoyaltyCallResultOptions,
  getAnnaLoyaltyChanges,
  loyaltyActivityEvidenceCompleteness,
  loyaltyAvailabilityLabelRu,
  loyaltyExactnessLabelRu,
  loyaltyMetricSourceLabelRu,
  updateAnnaLoyaltyRecord,
  updateOurBrokerDisplayName,
  type LoyaltyBaseKey,
  type LoyaltyCallResult,
  type LoyaltyChangeEntry,
  type LoyaltyRecord,
} from "@/lib/loyalty-base-api";
import {
  archiveLoyaltyEvent,
  archiveLoyaltyEventAttachment,
  agencyContactPointsPatch,
  agencyContactPersonRoleValue,
  correctLoyaltyCall,
  correctLoyaltyEvent,
  createLoyaltyAgencyContactPerson,
  createLoyaltyManualContactPoint,
  createLoyaltyEvent,
  createLoyaltyTask,
  downloadLoyaltyEventAttachment,
  getLoyaltyAgencyContactPeople,
  getLoyaltyEffectivePermissions,
  getLoyaltyEvents,
  getLoyaltyManualContactPoints,
  getLoyaltyOperators,
  getLoyaltyTasks,
  localDateTimeInputToIso,
  restoreLoyaltyEvent,
  toLocalDateInput,
  toLocalDateTimeInput,
  uploadLoyaltyEventAttachment,
  updateLoyaltyTask,
  updateLoyaltyAgencyContactPerson,
  updateLoyaltyManualContactPoint,
  type LoyaltyEngagementEvent,
  type LoyaltyAgencyContactPerson,
  type LoyaltyEffectivePermissions,
  type LoyaltyManualContactPoint,
  type LoyaltyManualContactType,
  type LoyaltyOperator,
  type LoyaltyTask,
} from "@/lib/loyalty-workflow-api";
import { loyaltyStatusLabel } from "@/lib/loyalty-status";
import { meetingAmoMarkLabel } from "@/lib/meeting-amo-marks";
import { LoyaltyStatusBadges } from "./LoyaltyStatusBadges";
import { LoyaltyCallResultBadge } from "./LoyaltyCallResultBadge";

type Tab =
  | "summary"
  | "contacts"
  | "activity"
  | "calls"
  | "tasks"
  | "loyalty"
  | "provenance";
const tabs: ReadonlyArray<readonly [Tab, string]> = [
  ["summary", "Обзор"],
  ["contacts", "Контакты"],
  ["activity", "Активность"],
  ["calls", "Звонки"],
  ["tasks", "Задачи"],
  ["loyalty", "Лояльность"],
  ["provenance", "Происхождение"],
];
const date = (text: string) => {
  if (!text) return "Нет данных";
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? text
    : parsed.toLocaleString("ru-RU", {
        dateStyle: "medium",
        timeStyle: "short",
      });
};
const count = (number: number | null) =>
  number === null ? "Нет данных" : number.toLocaleString("ru-RU");
const text = (value: string) => value || "Нет данных";
const stageLabel = (value: string) =>
  ({
    NEW_BROKER: "Новый",
    CALLED: "Звонили",
    BT_INVITED: "Приглашён на брокер-тур",
    BROKER_TOUR: "Был на брокер-туре",
    BT_ATTENDED: "Был на брокер-туре",
    FIXATION: "Фиксация",
    MEETING: "Встреча",
    DEAL: "Сделка",
    REPEAT_VIP: "Повторные сделки / VIP",
    NEW_AGENCY: "Новое агентство",
    CONTACT_ESTABLISHED: "Установлен контакт",
    MEETING_SCHEDULED: "Назначена встреча",
    BT_AGREED: "Согласован брокер-тур",
    BT_COMPLETED: "Брокер-тур проведён",
    SITE_PLACEMENT: "Размещение на сайте",
    ACTIVE_PARTNER: "Активный партнёр",
    VIP_PARTNER: "VIP-партнёр",
  })[value] || value;
const eventLabels: Record<LoyaltyEngagementEvent["type"], string> = {
  GIFT: "Подарок",
  AWARD: "Награждение",
  PRIVATE_EVENT: "Закрытое мероприятие",
  INDIVIDUAL_TERMS: "Индивидуальные условия",
  PERSONAL_DISCOUNT: "Личная скидка",
  PERSONAL_COMMISSION: "Личная комиссия",
};

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-1 font-semibold break-words">{children}</dd>
    </div>
  );
}

function safeHttpUrl(value: string) {
  if (!value) return "";
  try {
    const href = new URL(value).toString();
    return href.startsWith("http://") || href.startsWith("https://")
      ? href
      : "";
  } catch {
    return "";
  }
}

function Website({ value }: { value: string }) {
  if (!value) return <>Нет данных</>;
  const href = safeHttpUrl(value);
  if (!href) return <>{value}</>;
  return (
    <a className="text-accent" href={href} target="_blank" rel="noreferrer">
      {value}
    </a>
  );
}

function BrokerProfile({ record }: { record: LoyaltyRecord }) {
  const bt = record.sourceReportedMetrics?.brokerTourVisited;
  return (
    <div className="space-y-3">
      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Роль в агентстве">{text(record.role)}</Metric>
        <Metric label="География">
          {text([record.geography, record.city].filter(Boolean).join(" · "))}
        </Metric>
        <Metric label="Формат работы">{text(record.workFormat)}</Metric>
        <Metric label="Специализации">{text(record.specialization)}</Metric>
        <Metric label="День рождения">{text(record.birthday)}</Metric>
        <Metric label="Брокер-тур · срез источника">
          {bt === null || bt === undefined
            ? "Нет данных"
            : bt
              ? "Указано: был · не подтверждено событиями"
              : "Указано: не был · не подтверждено событиями"}
        </Metric>
        <Metric label="Дата БТ · срез, не подтверждено">
          {date(record.sourceReportedMetrics?.brokerTourAt || "")}
        </Metric>
        <Metric label="Дней без контакта">
          {count(record.daysWithoutContact)}
        </Metric>
        <Metric label="Последний результат звонка">
          <LoyaltyCallResultBadge
            result={record.lastCallResult}
            entityType={record.entityType}
          />
        </Metric>
        <Metric label="Следующая задача">{text(record.nextTask)}</Metric>
        <Metric label="Срок следующей задачи">{date(record.nextTaskAt)}</Metric>
        <Metric label="Исполнитель задачи">{text(record.taskAssignee)}</Metric>
      </dl>
      <section>
        <h3 className="mb-2 font-semibold">Агентства и роли</h3>
        {record.agencies.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {record.agencies.map((agency, index) => (
              <div
                className="rounded-xl border border-border p-3 text-sm"
                key={agency.id || `${agency.name}-${index}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <b>{text(agency.name)}</b>
                  {agency.isPrimary && (
                    <span className="rounded-full bg-accent/10 px-2 py-1 text-xs text-accent">
                      Основное
                    </span>
                  )}
                </div>
                <p className="mt-1 text-text-muted">{text(agency.role)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-muted">
            Связи с агентствами не переданы.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * 2026-09-07: блок «Наша карточка по сцепке» в карточке базы Анны —
 * телефон, email, amoCRM, метрики кабинета и профиль нашей записи.
 */
function LinkedOurRecordSummary({ linked }: { linked: LoyaltyRecord }) {
  const counts = [
    linked.fixations === null ? "—" : String(linked.fixations),
    linked.meetings === null ? "—" : String(linked.meetings),
    linked.deals === null ? "—" : String(linked.deals),
  ].join(" / ");
  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-xs uppercase tracking-wide text-text-muted">
            Наша база · сцепка подтверждена
          </span>
          <h3 className="font-semibold">{linked.name}</h3>
          {linked.cabinetFullName && (
            <p className="text-xs text-text-muted">
              в кабинете: {linked.cabinetFullName}
            </p>
          )}
        </div>
        {linked.amoContactUrl && (
          <a
            className="btn btn-secondary"
            href={linked.amoContactUrl}
            target="_blank"
            rel="noreferrer"
          >
            amoCRM <ExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>
      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Телефон">{text(linked.phone)}</Metric>
        <Metric label="Email">{text(linked.email)}</Metric>
        <Metric label="Фиксации / встречи / сделки">{counts}</Metric>
        <Metric label="Сумма ДДУ">
          {formatRubles(linked.dealAmount ?? null).replace("—", "Нет данных")}
        </Metric>
      </dl>
      {linked.entityType === "brokers" ? (
        <BrokerProfile record={linked} />
      ) : (
        <AgencyProfile record={linked} />
      )}
      <p className="text-xs text-text-muted">
        Данные кабинета по подтверждённой сцепке: телефоны, юрназвание,
        ссылки amoCRM и события берутся из нашей базы и обновляются вместе с ней.
      </p>
    </div>
  );
}

function AgencyProfile({ record }: { record: LoyaltyRecord }) {
  const details = record.annaDetails;
  return (
    <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Юридическое название">
        {text(details?.legalName || "")}
      </Metric>
      <Metric label="Размер агентства">
        {text(details?.agencySize || "")}
      </Metric>
      <Metric label="Брокеров всего">
        {count(details?.brokerCount ?? null)}
      </Metric>
      <Metric label="Активных брокеров">
        {count(details?.activeBrokers ?? null)}
      </Metric>
      <Metric label="Сайт">
        <Website value={details?.website || ""} />
      </Metric>
      <Metric label="Размещение проектов">
        {text(details?.projectsOnSite || "")}
      </Metric>
      <Metric label="Требования для размещения">
        {text(details?.sitePlacementRequirements || "")}
      </Metric>
      <Metric label="Последняя встреча">
        {date(details?.lastAgencyMeetingDate || "")}
      </Metric>
      <Metric label="Индивидуальный / выездной БТ">
        {text(details?.agencyBtFormat || "")}
      </Metric>
      <Metric label="Дата БТ">{date(details?.agencyBtDate || "")}</Metric>
      <Metric label="Последнее соглашение">
        {date(details?.lastContractDate || "")}
      </Metric>
      <Metric label="Следующая договорённость">
        {text(details?.nextAgreement || record.nextTask)}
      </Metric>
      <Metric label="Специальные условия">
        {text(details?.specialTerms || "")}
      </Metric>
      <Metric label="Статус специальных условий">
        {text(details?.specialTermsStatus || "")}
      </Metric>
      <Metric label="Условия действуют до">
        {date(details?.specialTermsValidUntil || "")}
      </Metric>
      <Metric label="Уровень партнёрства">
        {text(loyaltyStatusLabel(details?.partnershipStatus || record.status))}
      </Metric>
    </dl>
  );
}

function ActivityMetrics({ record }: { record: LoyaltyRecord }) {
  const source = record.sourceReportedMetrics;
  const period = record.periodMetrics;
  return (
    <div className="space-y-4">
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">
            За выбранный период
            {period?.period
              ? ` · ${period.period.from} — ${period.period.to}`
              : ""}
          </h3>
          <span className="text-xs text-text-muted">
            {period?.availability === "LOCAL_PRELIMINARY"
              ? "Данные кабинета за выбранный период"
              : period?.availability === "EXACT"
                ? "Точные события за выбранный период"
                : "Периодные данные недоступны"}
          </span>
        </div>
        <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Фиксации">{count(period?.fixations ?? null)}</Metric>
          <Metric label="Встречи">{count(period?.meetings ?? null)}</Metric>
          <Metric label="Сделки">{count(period?.deals ?? null)}</Metric>
          <Metric label="Сумма ДДУ">
            {period
              ? formatRubles(period.dealAmount).replace("—", "Нет данных")
              : "Нет данных"}
          </Metric>
        </dl>
        <dl className="mt-2 grid gap-2 sm:grid-cols-3">
          <Metric label="Последняя фиксация в периоде">
            {date(period?.lastFixationAt || "")}
          </Metric>
          <Metric label="Последняя встреча в периоде">
            {date(period?.lastMeetingAt || "")}
          </Metric>
          <Metric label="Последняя сделка в периоде">
            {date(period?.lastDealAt || "")}
          </Metric>
        </dl>
      </section>
      <section>
        <h3 className="mb-2 font-semibold">
          Срез источника · не подтверждено событиями кабинета
        </h3>
        <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Фиксации">{count(source?.fixations ?? null)}</Metric>
          <Metric label="Встречи">{count(source?.meetings ?? null)}</Metric>
          <Metric label="Сделки">{count(source?.deals ?? null)}</Metric>
          <Metric label="Сумма ДДУ">
            {formatRubles(source?.dealAmount ?? null).replace(
              "—",
              "Нет данных",
            )}
          </Metric>
        </dl>
      </section>
    </div>
  );
}
function ActivityEvidenceCompleteness({
  evidence,
}: {
  evidence: LoyaltyRecord["activityEvidence"];
}) {
  const completeness = loyaltyActivityEvidenceCompleteness(evidence);
  const limit =
    evidence.limit === null ? "" : ` Лимит сервера: ${evidence.limit}.`;
  const summary =
    completeness === "complete"
      ? `История загружена полностью: ${evidence.loadedCount} из ${evidence.count} событий.`
      : completeness === "truncated"
        ? evidence.count === null
          ? `История загружена частично: получено ${evidence.loadedCount} событий; общее количество неизвестно.${limit}`
          : `История загружена частично: ${evidence.loadedCount} из ${evidence.count} событий.${limit}`
        : `Полнота истории не подтверждена. Загружено событий: ${evidence.loadedCount}.`;
  return (
    <aside
      className="rounded-xl border border-border bg-surface-secondary p-3 text-sm"
      data-activity-evidence-completeness={completeness}
    >
      <p>{summary}</p>
      {(evidence.availability || evidence.exactness) && (
        <p className="mt-1 text-xs text-text-muted">
          {[
            loyaltyAvailabilityLabelRu(evidence.availability) &&
              `Источник: ${loyaltyAvailabilityLabelRu(evidence.availability)}`,
            loyaltyExactnessLabelRu(evidence.exactness) &&
              `точность: ${loyaltyExactnessLabelRu(evidence.exactness)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {evidence.methodology && (
        <details className="mt-2 text-xs text-text-muted">
          <summary className="cursor-pointer">
            Методика формирования истории
          </summary>
          <p className="mt-1 whitespace-pre-wrap">{evidence.methodology}</p>
        </details>
      )}
    </aside>
  );
}

function Timeline({
  items,
  empty,
  entityType,
  evidence,
  onCorrect,
  canCorrect,
}: {
  items: LoyaltyRecord["history"];
  empty: string;
  entityType: LoyaltyRecord["entityType"];
  evidence?: LoyaltyRecord["activityEvidence"];
  onCorrect?: (item: LoyaltyRecord["history"][number]) => void;
  canCorrect?: (item: LoyaltyRecord["history"][number]) => boolean;
}) {
  return (
    <div className="space-y-3">
      {evidence !== undefined && (
        <ActivityEvidenceCompleteness evidence={evidence} />
      )}
      {!items.length ? (
        <p className="rounded-xl border border-dashed border-border p-5 text-sm text-text-muted">
          {empty}
        </p>
      ) : (
        <ol className="space-y-2">
          {items.map((item, index) => (
            <li
              key={item.id || `${item.type}-${index}`}
              className="rounded-xl border border-border p-3 text-sm"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <b>{item.title || item.type || "Событие"}</b>
                <span className="text-xs text-text-muted">
                  {date(item.occurredAt)}
                </span>
              </div>
              {item.description && (
                <p className="mt-1 whitespace-pre-wrap text-text-muted">
                  {item.description}
                </p>
              )}
              {/* 2026-09-07: разворот «Детали записи» — все поля, которые
                  уже приходят с бэка (клиент, проект, статус, сумма...). */}
              {item.details && item.details.length > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-text-muted">
                    Детали записи
                  </summary>
                  <dl className="mt-1 grid gap-1 sm:grid-cols-2">
                    {item.details.map((detail) => (
                      <div key={detail.label}>
                        <dt className="inline text-text-muted">
                          {detail.label}:{" "}
                        </dt>
                        <dd className="inline">
                          {/* 2026-09-07: лид/сделка amoCRM — внешняя ссылка */}
                          {detail.href ? (
                            <a
                              href={detail.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline decoration-dotted underline-offset-2 hover:text-accent"
                            >
                              {detail.value} ↗
                            </a>
                          ) : (
                            detail.value
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
              {/* 2026-09-07: встреча PENDING, статус из amo вернуть не
                  удалось (метка backfill-а) — явный оранжевый бейдж,
                  чтобы не сливалась с обычным «запланирована». */}
              {item.amoMark && (
                <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-orange-300 bg-orange-50 px-2 py-1 text-xs font-medium text-orange-900">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-orange-600"
                    aria-hidden
                  />
                  {meetingAmoMarkLabel(item.amoMark)}
                </span>
              )}
              {item.result && (
                <LoyaltyCallResultBadge
                  result={item.result}
                  entityType={entityType}
                  className="mt-2"
                />
              )}
              {(item.campaignName ||
                item.employeeName ||
                item.nextStep ||
                item.nextActionAt) && (
                <p className="mt-2 text-xs text-text-muted">
                  {[
                    item.campaignName && `Кампания: ${item.campaignName}`,
                    item.employeeName && `Сотрудник: ${item.employeeName}`,
                    item.nextStep && `Следующий шаг: ${item.nextStep}`,
                    item.nextActionAt && `Срок: ${date(item.nextActionAt)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {item.correctionReason && (
                <p className="mt-1 text-xs text-warning">
                  Причина исправления: {item.correctionReason}
                </p>
              )}
              {item.superseded && (
                <span className="mt-2 inline-flex rounded-full bg-surface-secondary px-2 py-1 text-xs text-text-muted">
                  Заменено исправлением
                </span>
              )}
              {onCorrect &&
                (!canCorrect || canCorrect(item)) &&
                item.assignmentId &&
                item.id &&
                item.effective !== false && (
                  <button
                    className="mt-2 text-xs underline"
                    type="button"
                    onClick={() => onCorrect(item)}
                  >
                    Исправить результат звонка
                  </button>
                )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CallCorrectionModal({
  call,
  entityType,
  onClose,
  onDone,
}: {
  call: LoyaltyRecord["history"][number];
  entityType: LoyaltyRecord["entityType"];
  onClose: () => void;
  onDone: () => void;
}) {
  const options = getLoyaltyCallResultOptions(entityType);
  const initialResult = options.some(({ code }) => code === call.result)
    ? (call.result as LoyaltyCallResult)
    : "";
  const [result, setResult] = useState<LoyaltyCallResult | "">(initialResult);
  const [comment, setComment] = useState(call.comment || "");
  const [nextStep, setNextStep] = useState(call.nextStep || "");
  const [nextActionAt, setNextActionAt] = useState(
    call.nextActionAt ? toLocalDateTimeInput(call.nextActionAt) : "",
  );
  const [submissionId] = useState(() => crypto.randomUUID());
  const [correctionReason, setCorrectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!call.assignmentId || !call.id || !result)
      return setError("Не удалось определить исходный звонок или результат.");
    if (entityType === "agencies" && !comment.trim())
      return setError("Для звонка агентству укажите краткий комментарий.");
    if (correctionReason.trim().length < 3)
      return setError("Укажите причину исправления.");
    setBusy(true);
    setError("");
    try {
      await correctLoyaltyCall(call.assignmentId, call.id, {
        submissionId,
        correctionReason: correctionReason.trim(),
        result,
        comment: comment.trim(),
        nextStep: nextStep.trim() || undefined,
        nextActionAt: nextActionAt
          ? localDateTimeInputToIso(nextActionAt)
          : undefined,
      });
      onDone();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось исправить результат звонка",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Исправить результат звонка" onClose={onClose}>
      <p className="rounded-lg bg-warning/10 p-2 text-xs text-warning">
        Исходная попытка останется в истории; будет добавлена отдельная запись
        исправления.
      </p>
      <label className="block text-sm">
        Результат *
        <select
          className="input mt-1"
          value={result}
          onChange={(event) =>
            setResult(event.target.value as LoyaltyCallResult)
          }
        >
          <option value="">Выберите результат</option>
          {options.map(({ code, label }) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        {result && (
          <LoyaltyCallResultBadge
            result={result}
            entityType={entityType}
            className="mt-1"
          />
        )}
      </label>
      <label className="block text-sm">
        Комментарий
        <textarea
          className="input mt-1 min-h-20"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Следующий шаг
        <input
          className="input mt-1"
          value={nextStep}
          onChange={(event) => setNextStep(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Дата следующего действия
        <input
          className="input mt-1"
          type="datetime-local"
          value={nextActionAt}
          onChange={(event) => setNextActionAt(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Причина исправления *
        <textarea
          className="input mt-1 min-h-16"
          value={correctionReason}
          onChange={(event) => setCorrectionReason(event.target.value)}
        />
      </label>
      {error && (
        <p className="rounded-lg bg-error/10 p-2 text-sm text-error">{error}</p>
      )}
      <button
        className="btn btn-primary w-full"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Сохранить
        исправление
      </button>
    </Modal>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-lg space-y-3 rounded-2xl bg-surface p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="p-2" onClick={onClose} aria-label="Закрыть">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ContactPointModal({
  record,
  point,
  onClose,
  onDone,
}: {
  record: LoyaltyRecord;
  point?: LoyaltyManualContactPoint;
  onClose: () => void;
  onDone: () => void;
}) {
  const [type, setType] = useState<LoyaltyManualContactType>(
    point?.type || "PHONE",
  );
  const [value, setValue] = useState(point?.value || "");
  const [label, setLabel] = useState(point?.label || "");
  const [isPrimary, setIsPrimary] = useState(point?.isPrimary || false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!value.trim()) return setError("Укажите контакт.");
    setBusy(true);
    setError("");
    try {
      if (point) {
        await updateLoyaltyManualContactPoint(
          record.entityType,
          record.id,
          point.id,
          {
            expectedVersion: point.version,
            value: value.trim(),
            label: label.trim(),
            isPrimary,
          },
        );
      } else {
        await createLoyaltyManualContactPoint(record.entityType, record.id, {
          type,
          value: value.trim(),
          label: label.trim() || undefined,
          isPrimary,
        });
      }
      onDone();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить контакт",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={point ? "Изменить ручной контакт" : "Добавить ручной контакт"}
      onClose={onClose}
    >
      <p className="rounded-lg bg-accent/10 p-2 text-xs text-text-muted">
        Изменение сохраняется в отдельном ручном дополнении и не переписывает
        подписанный снимок Анны.
      </p>
      <label className="block text-sm">
        Тип
        <select
          className="input mt-1"
          disabled={Boolean(point)}
          value={type}
          onChange={(event) =>
            setType(event.target.value as LoyaltyManualContactType)
          }
        >
          <option value="PHONE">Телефон</option>
          <option value="EMAIL">Email</option>
          <option value="TELEGRAM">Telegram</option>
          <option value="WHATSAPP">WhatsApp</option>
          <option value="OTHER">Другое</option>
        </select>
      </label>
      <label className="block text-sm">
        Значение *
        <input
          className="input mt-1"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Подпись
        <input
          className="input mt-1"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Например, рабочий"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isPrimary}
          onChange={(event) => setIsPrimary(event.target.checked)}
        />{" "}
        Основной контакт этого типа
      </label>
      {error && (
        <p className="rounded-lg bg-error/10 p-2 text-sm text-error">{error}</p>
      )}
      <button
        className="btn btn-primary w-full"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Сохранить контакт
      </button>
    </Modal>
  );
}

function AgencyContactPersonModal({
  agencyId,
  person,
  seed,
  onClose,
  onDone,
}: {
  agencyId: string;
  person?: LoyaltyAgencyContactPerson;
  seed?: LoyaltyRecord["contacts"][number];
  onClose: () => void;
  onDone: () => void;
}) {
  const initialPoints = person?.contactPoints || seed?.contactPoints || [];
  const [displayName, setDisplayName] = useState(
    person?.displayName || seed?.name || "",
  );
  const [role, setRole] = useState(person?.role || seed?.role || "");
  const [status, setStatus] = useState<"CURRENT" | "FORMER" | "UNKNOWN">(
    person?.actualityStatus ||
      (seed?.status === "Бывший сотрудник"
        ? "FORMER"
        : seed?.status === "Неизвестно"
          ? "UNKNOWN"
          : "CURRENT"),
  );
  const existing = (type: LoyaltyManualContactType) =>
    initialPoints
      .filter((point) => point.type === type)
      .map((point) => point.value)
      .join("\n");
  const initialPhones = existing("PHONE");
  const initialEmails = existing("EMAIL");
  const [phones, setPhones] = useState(initialPhones);
  const [emails, setEmails] = useState(initialEmails);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const values = (value: string) =>
    value
      .split(/[\n,;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  const contactKey = (type: LoyaltyManualContactType, value: string) =>
    type === "PHONE"
      ? `${type}:${value.replace(/\D/g, "")}`
      : `${type}:${value.trim().toLocaleLowerCase("ru-RU")}`;
  const typedPoints = (type: "PHONE" | "EMAIL", rawValues: string[]) => {
    const used = new Set<string>();
    const next = rawValues.map((value) => {
      const key = contactKey(type, value);
      const original = initialPoints.find(
        (point) =>
          !used.has(point.id) &&
          point.type === type &&
          contactKey(point.type, point.value) === key,
      );
      if (original) used.add(original.id);
      return {
        ...(person && original?.id ? { id: original.id } : {}),
        type,
        value,
        label: original?.label || undefined,
        isPrimary: Boolean(original?.isPrimary),
      };
    });
    if (next.length && !next.some((point) => point.isPrimary)) {
      next[0].isPrimary = true;
    }
    return next;
  };
  const save = async () => {
    if (!displayName.trim()) return setError("Укажите имя контактного лица.");
    const contactPoints = [
      ...typedPoints("PHONE", values(phones)),
      ...typedPoints("EMAIL", values(emails)),
      ...initialPoints
        .filter((point) => !["PHONE", "EMAIL"].includes(point.type))
        .filter((point) =>
          ["TELEGRAM", "WHATSAPP", "OTHER"].includes(point.type),
        )
        .map((point) => ({
          ...(person && point.id ? { id: point.id } : {}),
          type: point.type as LoyaltyManualContactType,
          value: point.value,
          label: point.label || undefined,
          isPrimary: Boolean(point.isPrimary),
        })),
    ];
    setBusy(true);
    setError("");
    try {
      const body = {
        displayName: displayName.trim(),
        role: agencyContactPersonRoleValue({ isNew: !person, role }),
        actualityStatus: status,
        ...agencyContactPointsPatch({
          isNew: !person,
          initialPhones,
          initialEmails,
          phones,
          emails,
          contactPoints,
        }),
      };
      if (person) {
        await updateLoyaltyAgencyContactPerson(agencyId, person.id, {
          expectedVersion: person.version,
          ...body,
        });
      } else {
        await createLoyaltyAgencyContactPerson(agencyId, body);
      }
      onDone();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить контактное лицо",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={person ? "Изменить контактное лицо" : "Добавить контактное лицо"}
      onClose={onClose}
    >
      <label className="block text-sm">
        Имя *
        <input
          className="input mt-1"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Роль / должность
        <input
          className="input mt-1"
          value={role}
          onChange={(event) => setRole(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Актуальность
        <select
          className="input mt-1"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          <option value="CURRENT">Актуален</option>
          <option value="FORMER">Бывший сотрудник</option>
          <option value="UNKNOWN">Неизвестно</option>
        </select>
      </label>
      <label className="block text-sm">
        Телефоны, по одному в строке
        <textarea
          className="input mt-1 min-h-20"
          value={phones}
          onChange={(event) => setPhones(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Email, по одному в строке
        <textarea
          className="input mt-1 min-h-20"
          value={emails}
          onChange={(event) => setEmails(event.target.value)}
        />
      </label>
      {error && (
        <p className="rounded-lg bg-error/10 p-2 text-sm text-error">{error}</p>
      )}
      <button
        className="btn btn-primary w-full"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Сохранить
        контактное лицо
      </button>
    </Modal>
  );
}
function TaskModal({
  record,
  base,
  task,
  operators,
  onClose,
  onDone,
}: {
  record: LoyaltyRecord;
  base: LoyaltyBaseKey;
  task?: LoyaltyTask;
  operators: LoyaltyOperator[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(task?.title || "");
  const [description, setDescription] = useState(task?.description || "");
  const [dueAt, setDueAt] = useState(
    task?.dueAt ? toLocalDateTimeInput(task.dueAt) : "",
  );
  const [assignedToId, setAssignedToId] = useState(task?.assignedTo?.id || "");
  const [status, setStatus] = useState<LoyaltyTask["status"]>(
    task?.status || "OPEN",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!title.trim()) return setError("Укажите задачу.");
    setBusy(true);
    try {
      if (task) {
        await updateLoyaltyTask(task.id, {
          expectedVersion: task.version,
          title: title.trim(),
          description: description.trim() || null,
          dueAt: dueAt ? localDateTimeInputToIso(dueAt) : null,
          assignedToId: assignedToId || undefined,
          status,
        });
      } else {
        await createLoyaltyTask({
          base,
          entityType: record.entityType,
          ownerId: record.id,
          title: title.trim(),
          description: description.trim() || undefined,
          dueAt: dueAt ? localDateTimeInputToIso(dueAt) : undefined,
          assignedToId: assignedToId || undefined,
        });
      }
      onDone();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить задачу",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={task ? "Редактировать задачу" : "Новая задача"}
      onClose={onClose}
    >
      <label className="block text-sm">
        Задача *
        <input
          className="input mt-1"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Описание
        <textarea
          className="input mt-1 min-h-20"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Срок
        <input
          className="input mt-1"
          type="datetime-local"
          value={dueAt}
          onChange={(event) => setDueAt(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Исполнитель
        <select
          className="input mt-1"
          value={assignedToId}
          onChange={(event) => setAssignedToId(event.target.value)}
        >
          <option value="">
            {task ? "Не менять исполнителя" : "Не назначен"}
          </option>
          {operators.map((operator) => (
            <option value={operator.id} key={operator.id}>
              {operator.name}
            </option>
          ))}
        </select>
      </label>
      {task && (
        <label className="block text-sm">
          Статус
          <select
            className="input mt-1"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as LoyaltyTask["status"])
            }
          >
            <option value="OPEN">Открыта</option>
            <option value="COMPLETED">Выполнена</option>
            <option value="CANCELLED">Отменена</option>
          </select>
        </label>
      )}
      {error && (
        <p className="rounded-lg bg-error/10 p-2 text-sm text-error">{error}</p>
      )}
      <button
        className="btn btn-primary w-full"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {task ? "Сохранить задачу" : "Создать задачу"}
      </button>
    </Modal>
  );
}
function EventModal({
  record,
  base,
  event,
  onClose,
  onDone,
}: {
  record: LoyaltyRecord;
  base: LoyaltyBaseKey;
  event?: LoyaltyEngagementEvent;
  onClose: () => void;
  onDone: () => void;
}) {
  const [type, setType] = useState<LoyaltyEngagementEvent["type"]>(
    event?.type || "GIFT",
  );
  const [occurredAt, setOccurredAt] = useState(
    event?.occurredAt ? toLocalDateInput(event.occurredAt) : toLocalDateInput(),
  );
  const [comment, setComment] = useState(event?.comment || "");
  const [amount, setAmount] = useState(event?.amount || "");
  const [eventValue, setEventValue] = useState(event?.value || "");
  const [validUntil, setValidUntil] = useState(
    event?.validUntil?.slice(0, 10) || "",
  );
  const [basisUrl, setBasisUrl] = useState(event?.basisUrl || "");
  const [attachmentUrl, setAttachmentUrl] = useState(
    event?.attachmentUrl || "",
  );
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [pendingAttachmentEventId, setPendingAttachmentEventId] = useState<
    string | null
  >(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (pendingAttachmentEventId) {
      if (!attachmentFile)
        return setError("Выберите файл для повторной защищённой загрузки.");
      if (attachmentFile.size > 5 * 1024 * 1024)
        return setError("Размер файла не должен превышать 5 МиБ.");
      setBusy(true);
      setError("");
      try {
        await uploadLoyaltyEventAttachment(
          pendingAttachmentEventId,
          attachmentFile,
        );
        setPendingAttachmentEventId(null);
        onDone();
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Событие сохранено, но файл снова не удалось загрузить.",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!comment.trim()) return setError("Укажите комментарий.");
    if (attachmentFile && attachmentFile.size > 5 * 1024 * 1024)
      return setError("Размер защищённого файла не должен превышать 5 МБ.");
    setBusy(true);
    try {
      let saved: LoyaltyEngagementEvent;
      if (event) {
        if (!correctionReason.trim()) {
          setBusy(false);
          return setError("Укажите причину исправления.");
        }
        saved = await correctLoyaltyEvent(event.id, {
          type,
          occurredAt,
          comment: comment.trim() || undefined,
          amount: amount || undefined,
          value: eventValue || undefined,
          validUntil: validUntil || undefined,
          basisUrl: basisUrl || undefined,
          attachmentUrl: attachmentUrl || undefined,
          correctionReason: correctionReason.trim(),
        });
      } else {
        saved = await createLoyaltyEvent({
          base,
          entityType: record.entityType,
          ownerId: record.id,
          type,
          occurredAt,
          comment: comment.trim(),
          amount: amount || undefined,
          value: eventValue || undefined,
          validUntil: validUntil || undefined,
          basisUrl: basisUrl || undefined,
          attachmentUrl: attachmentUrl || undefined,
        });
      }
      if (attachmentFile) {
        try {
          await uploadLoyaltyEventAttachment(saved.id, attachmentFile);
        } catch (reason) {
          setPendingAttachmentEventId(saved.id);
          setError(
            `Событие уже сохранено, но файл не загружен. Повторная кнопка не создаст дубль: ${
              reason instanceof Error ? reason.message : "ошибка загрузки"
            }`,
          );
          return;
        }
      }
      onDone();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить событие",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={event ? "Исправить событие лояльности" : "Событие лояльности"}
      onClose={onClose}
    >
      <fieldset
        className="space-y-3"
        disabled={Boolean(pendingAttachmentEventId)}
      >
        <label className="block text-sm">
          Тип *
          <select
            className="input mt-1"
            value={type}
            onChange={(event) =>
              setType(event.target.value as LoyaltyEngagementEvent["type"])
            }
          >
            <option value="GIFT">Подарок</option>
            <option value="AWARD">Награждение</option>
            <option value="PRIVATE_EVENT">Закрытое мероприятие</option>
            <option value="INDIVIDUAL_TERMS">Индивидуальные условия</option>
            <option value="PERSONAL_DISCOUNT">Личная скидка</option>
            <option value="PERSONAL_COMMISSION">Личная комиссия</option>
          </select>
        </label>
        <label className="block text-sm">
          Дата *
          <input
            className="input mt-1"
            type="date"
            value={occurredAt}
            onChange={(event) => setOccurredAt(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          Комментарий *
          <textarea
            className="input mt-1 min-h-20"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">
            Сумма
            <input
              className="input mt-1"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Значение
            <input
              className="input mt-1"
              value={eventValue}
              onChange={(event) => setEventValue(event.target.value)}
            />
          </label>
        </div>
        <label className="block text-sm">
          Действует до
          <input
            className="input mt-1"
            type="date"
            value={validUntil}
            onChange={(event) => setValidUntil(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          Ссылка на основание
          <input
            className="input mt-1"
            type="url"
            value={basisUrl}
            onChange={(event) => setBasisUrl(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          Ссылка на вложение
          <input
            className="input mt-1"
            type="url"
            value={attachmentUrl}
            onChange={(event) => setAttachmentUrl(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          Защищённый файл (PDF, JPG, PNG или DOCX; до 5 МБ)
          <input
            className="input mt-1"
            type="file"
            accept="application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(changeEvent) =>
              setAttachmentFile(changeEvent.target.files?.[0] || null)
            }
          />
        </label>
        {event && (
          <label className="block text-sm">
            Причина исправления *
            <textarea
              className="input mt-1 min-h-16"
              value={correctionReason}
              onChange={(changeEvent) =>
                setCorrectionReason(changeEvent.target.value)
              }
            />
          </label>
        )}
      </fieldset>
      {pendingAttachmentEventId && (
        <label className="block text-sm">
          Выбрать другой файл для повторной загрузки
          <input
            className="input mt-1"
            type="file"
            accept="application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(changeEvent) =>
              setAttachmentFile(changeEvent.target.files?.[0] || null)
            }
          />
        </label>
      )}
      {error && (
        <p className="rounded-lg bg-error/10 p-2 text-sm text-error">{error}</p>
      )}
      <button
        className="btn btn-primary w-full"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {pendingAttachmentEventId
          ? "Повторить загрузку файла"
          : "Сохранить событие"}
      </button>
      {pendingAttachmentEventId && (
        <button
          className="btn btn-secondary w-full"
          disabled={busy}
          onClick={() => {
            setPendingAttachmentEventId(null);
            onDone();
          }}
          type="button"
        >
          Завершить без файла
        </button>
      )}
    </Modal>
  );
}

function ResourceLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-secondary p-3 text-sm text-text-muted">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

function ResourceError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-lg bg-error/10 p-3 text-sm text-error" role="alert">
      <p>{message}</p>
      <button
        className="btn btn-secondary mt-2"
        onClick={onRetry}
        type="button"
      >
        <RotateCcw className="h-4 w-4" /> Повторить
      </button>
    </div>
  );
}

function DetailBody({
  record,
  base,
  showFullLink = true,
}: {
  record: LoyaltyRecord;
  base: LoyaltyBaseKey;
  showFullLink?: boolean;
}) {
  const { broker: me } = useAuth();
  const [tab, setTab] = useState<Tab>("summary");
  const [tasks, setTasks] = useState<LoyaltyTask[]>([]);
  const [events, setEvents] = useState<LoyaltyEngagementEvent[]>([]);
  const [operators, setOperators] = useState<LoyaltyOperator[]>([]);
  const [manualPoints, setManualPoints] = useState<LoyaltyManualContactPoint[]>(
    [],
  );
  const [agencyPeople, setAgencyPeople] = useState<
    LoyaltyAgencyContactPerson[]
  >([]);
  const [effective, setEffective] =
    useState<LoyaltyEffectivePermissions | null>(null);
  const [changes, setChanges] = useState<LoyaltyChangeEntry[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [permissionsError, setPermissionsError] = useState("");
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState("");
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState("");
  const [operatorsLoading, setOperatorsLoading] = useState(false);
  const [operatorsError, setOperatorsError] = useState("");
  const [manualPointsLoading, setManualPointsLoading] = useState(false);
  const [manualPointsError, setManualPointsError] = useState("");
  const [agencyPeopleLoading, setAgencyPeopleLoading] = useState(false);
  const [agencyPeopleError, setAgencyPeopleError] = useState("");
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState("");
  const [taskOpen, setTaskOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [editTask, setEditTask] = useState<LoyaltyTask | null>(null);
  const [editEvent, setEditEvent] = useState<LoyaltyEngagementEvent | null>(
    null,
  );
  const [editCall, setEditCall] = useState<
    LoyaltyRecord["history"][number] | null
  >(null);
  const [contactPointOpen, setContactPointOpen] = useState(false);
  const [editContactPoint, setEditContactPoint] =
    useState<LoyaltyManualContactPoint | null>(null);
  const [agencyPersonOpen, setAgencyPersonOpen] = useState(false);
  const [editAgencyPerson, setEditAgencyPerson] =
    useState<LoyaltyAgencyContactPerson | null>(null);
  const [agencyPersonSeed, setAgencyPersonSeed] = useState<
    LoyaltyRecord["contacts"][number] | null
  >(null);
  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState(record.name);
  const [city, setCity] = useState(record.city);
  const [editBusy, setEditBusy] = useState(false);
  // 2026-09-07: «Исправить имя» брокера «Нашей базы» — правит только
  // «имя для работы» (displayName); самоназвание в кабинете брокера
  // не меняется.
  const [displayNameOpen, setDisplayNameOpen] = useState(false);
  const [displayNameValue, setDisplayNameValue] = useState(record.name);
  const [displayNameBusy, setDisplayNameBusy] = useState(false);
  const [displayNameError, setDisplayNameError] = useState("");
  const [eventAction, setEventAction] = useState("");
  const [contactAction, setContactAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [editError, setEditError] = useState("");
  const canReadAll = Boolean(effective?.permissions.includes("READ_ALL"));
  const canEdit = Boolean(effective?.permissions.includes("ENTITY_EDIT"));
  const canAudit = Boolean(effective?.permissions.includes("AUDIT_READ"));
  const canExecuteCalls = Boolean(
    effective?.permissions.includes("CALL_EXECUTE"),
  );
  const owner = useMemo(
    () => ({ base, entityType: record.entityType, ownerId: record.id }),
    [base, record.entityType, record.id],
  );
  const currentUserId = me?.id;
  const currentUserRole = me?.role;
  const loadPermissions = useCallback(async () => {
    if (
      !currentUserId ||
      !currentUserRole ||
      !["ADMIN", "MANAGER"].includes(currentUserRole)
    ) {
      setPermissionsLoading(false);
      return;
    }
    setPermissionsLoading(true);
    setPermissionsError("");
    try {
      setEffective(await getLoyaltyEffectivePermissions());
    } catch (reason) {
      setEffective(null);
      setPermissionsError(
        reason instanceof Error
          ? reason.message
          : "Не удалось проверить права карточки",
      );
    } finally {
      setPermissionsLoading(false);
    }
  }, [currentUserId, currentUserRole]);
  useEffect(() => {
    void loadPermissions();
  }, [loadPermissions]);
  const loadTasks = useCallback(async () => {
    if (!canReadAll) return;
    setTasksLoading(true);
    setTasksError("");
    try {
      setTasks(await getLoyaltyTasks(owner));
    } catch (reason) {
      setTasks([]);
      setTasksError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить задачи",
      );
    } finally {
      setTasksLoading(false);
    }
  }, [canReadAll, owner]);
  const loadEvents = useCallback(async () => {
    if (!canReadAll) return;
    setEventsLoading(true);
    setEventsError("");
    try {
      setEvents(await getLoyaltyEvents({ ...owner, includeArchived: canEdit }));
    } catch (reason) {
      setEvents([]);
      setEventsError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить события и вложения",
      );
    } finally {
      setEventsLoading(false);
    }
  }, [canEdit, canReadAll, owner]);
  const loadOperators = useCallback(async () => {
    if (!canReadAll) return;
    setOperatorsLoading(true);
    setOperatorsError("");
    try {
      setOperators(await getLoyaltyOperators());
    } catch (reason) {
      setOperators([]);
      setOperatorsError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить сотрудников",
      );
    } finally {
      setOperatorsLoading(false);
    }
  }, [canReadAll]);
  const loadWorkflow = useCallback(async () => {
    await Promise.all([loadTasks(), loadEvents(), loadOperators()]);
  }, [loadEvents, loadOperators, loadTasks]);
  useEffect(() => {
    void loadWorkflow();
  }, [loadWorkflow]);
  const loadManualPoints = useCallback(async () => {
    if (base !== "anna" || !canReadAll) return;
    setManualPointsLoading(true);
    setManualPointsError("");
    try {
      setManualPoints(
        await getLoyaltyManualContactPoints(record.entityType, record.id, true),
      );
    } catch (reason) {
      setManualPoints([]);
      setManualPointsError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить ручные контакты",
      );
    } finally {
      setManualPointsLoading(false);
    }
  }, [base, canReadAll, record.entityType, record.id]);
  useEffect(() => {
    void loadManualPoints();
  }, [loadManualPoints]);
  const loadAgencyPeople = useCallback(async () => {
    if (base !== "anna" || record.entityType !== "agencies" || !canReadAll)
      return;
    setAgencyPeopleLoading(true);
    setAgencyPeopleError("");
    try {
      setAgencyPeople(await getLoyaltyAgencyContactPeople(record.id, true));
    } catch (reason) {
      setAgencyPeople([]);
      setAgencyPeopleError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить контактных лиц",
      );
    } finally {
      setAgencyPeopleLoading(false);
    }
  }, [base, canReadAll, record.entityType, record.id]);
  useEffect(() => {
    void loadAgencyPeople();
  }, [loadAgencyPeople]);
  const loadChanges = useCallback(async () => {
    if (base !== "anna" || !canAudit) return;
    setChangesLoading(true);
    setChangesError("");
    try {
      setChanges(await getAnnaLoyaltyChanges(record.entityType, record.id));
    } catch (reason) {
      setChanges([]);
      setChangesError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить журнал изменений",
      );
    } finally {
      setChangesLoading(false);
    }
  }, [base, canAudit, record.entityType, record.id]);
  useEffect(() => {
    if (base === "anna" && canAudit && tab === "provenance") void loadChanges();
  }, [base, canAudit, loadChanges, tab]);
  const calls = record.history.filter((item) =>
    /call|звон/i.test(`${item.type} ${item.title}`),
  );
  const activities = record.history.filter(
    (item) => !/call|звон/i.test(`${item.type} ${item.title}`),
  );
  const saveEdit = async () => {
    if (!record.updatedAt)
      return setEditError(
        "Нет версии записи для безопасного сохранения. Обновите карточку.",
      );
    setEditBusy(true);
    setEditError("");
    try {
      await updateAnnaLoyaltyRecord(record.entityType, record.id, {
        expectedUpdatedAt: record.updatedAt,
        displayName: name.trim(),
        city: city.trim(),
      });
      setEditOpen(false);
      window.location.reload();
    } catch (reason) {
      setEditError(
        reason instanceof Error ? reason.message : "Не удалось сохранить",
      );
    } finally {
      setEditBusy(false);
    }
  };
  const saveDisplayName = async () => {
    setDisplayNameBusy(true);
    setDisplayNameError("");
    try {
      await updateOurBrokerDisplayName(record.id, displayNameValue);
      setDisplayNameOpen(false);
      window.location.reload();
    } catch (reason) {
      setDisplayNameError(
        reason instanceof Error ? reason.message : "Не удалось сохранить имя",
      );
    } finally {
      setDisplayNameBusy(false);
    }
  };
  const toggleRecordArchive = async () => {
    if (!record.updatedAt) {
      setActionError("Нет версии записи для безопасного изменения архива.");
      return;
    }
    const restoring = record.archived;
    const action = restoring ? "восстановить" : "архивировать";
    const consequence = restoring
      ? "Запись снова появится в активной базе Анны."
      : "Запись будет скрыта из активной базы Анны; подтверждённые связи сверки будут отозваны.";
    if (
      !window.confirm(
        `Вы действительно хотите ${action} запись?\n\n${consequence}`,
      )
    )
      return;
    const phrase = restoring ? "ВОССТАНОВИТЬ" : "АРХИВИРОВАТЬ";
    if (window.prompt(`Для подтверждения введите ${phrase}`)?.trim() !== phrase)
      return;
    setEditBusy(true);
    setActionError("");
    try {
      await updateAnnaLoyaltyRecord(record.entityType, record.id, {
        expectedUpdatedAt: record.updatedAt,
        archived: !restoring,
      });
      window.location.reload();
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : `Не удалось ${action} запись`,
      );
    } finally {
      setEditBusy(false);
    }
  };
  const completeTask = async (task: LoyaltyTask) => {
    setActionError("");
    try {
      await updateLoyaltyTask(task.id, {
        status: "COMPLETED",
        expectedVersion: task.version,
      });
      await loadWorkflow();
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "Не удалось обновить задачу",
      );
    }
  };
  const setEventArchived = async (event: LoyaltyEngagementEvent) => {
    const restoring = Boolean(event.archivedAt);
    if (
      !window.confirm(
        restoring
          ? "Восстановить событие лояльности?"
          : "Архивировать событие лояльности?",
      )
    )
      return;
    if (
      !restoring &&
      window.prompt("Для подтверждения введите АРХИВИРОВАТЬ")?.trim() !==
        "АРХИВИРОВАТЬ"
    )
      return;
    setEventAction(event.id);
    setActionError("");
    try {
      if (restoring) await restoreLoyaltyEvent(event.id, event.version);
      else await archiveLoyaltyEvent(event.id, event.version);
      await loadWorkflow();
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Не удалось архивировать событие",
      );
    } finally {
      setEventAction("");
    }
  };
  const downloadAttachment = async (
    attachment: LoyaltyEngagementEvent["attachments"][number],
  ) => {
    setEventAction(attachment.id);
    setActionError("");
    try {
      const { blob, filename } = await downloadLoyaltyEventAttachment(
        attachment.id,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename || attachment.fileName || "attachment";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Не удалось скачать вложение",
      );
    } finally {
      setEventAction("");
    }
  };
  const archiveAttachment = async (
    attachment: LoyaltyEngagementEvent["attachments"][number],
  ) => {
    if (!window.confirm(`Архивировать вложение «${attachment.fileName}»?`))
      return;
    setEventAction(attachment.id);
    setActionError("");
    try {
      await archiveLoyaltyEventAttachment(attachment.id, attachment.version);
      await loadWorkflow();
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Не удалось архивировать вложение",
      );
    } finally {
      setEventAction("");
    }
  };
  const toggleManualPoint = async (point: LoyaltyManualContactPoint) => {
    const restoring = Boolean(point.archivedAt);
    if (
      !window.confirm(
        restoring
          ? "Восстановить этот ручной контакт?"
          : "Архивировать этот ручной контакт?",
      )
    )
      return;
    setContactAction(point.id);
    setActionError("");
    try {
      await updateLoyaltyManualContactPoint(
        record.entityType,
        record.id,
        point.id,
        { expectedVersion: point.version, archived: !restoring },
      );
      await loadManualPoints();
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Не удалось изменить контакт",
      );
    } finally {
      setContactAction("");
    }
  };
  const toggleAgencyPerson = async (person: LoyaltyAgencyContactPerson) => {
    const restoring = Boolean(person.archivedAt);
    if (
      !window.confirm(
        restoring
          ? `Восстановить контактное лицо «${person.displayName}»?`
          : `Архивировать контактное лицо «${person.displayName}»?`,
      )
    )
      return;
    setContactAction(person.id);
    setActionError("");
    try {
      await updateLoyaltyAgencyContactPerson(record.id, person.id, {
        expectedVersion: person.version,
        archived: !restoring,
      });
      await loadAgencyPeople();
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Не удалось изменить контактное лицо",
      );
    } finally {
      setContactAction("");
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="text-xs uppercase tracking-wide text-text-muted">
            {base === "anna" ? "База Анны Скибицкой" : "Наша база"} ·{" "}
            {record.entityType === "brokers" ? "Брокер" : "Агентство"}
          </span>
          <h1 className="mt-1 text-2xl font-bold">{record.name}</h1>
          {/* Самоназвание брокера из кабинета — серым, когда КЦ/бэкфилл
              исправили «имя для работы». */}
          {record.cabinetFullName && (
            <p className="text-sm text-text-muted">
              в кабинете: {record.cabinetFullName}
            </p>
          )}
          <p className="text-sm text-text-muted">
            {record.company ||
              record.city ||
              "Дополнительные данные не указаны"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {base === "ours" && record.entityType === "brokers" && (
            <button
              className="btn btn-secondary"
              onClick={() => {
                setDisplayNameValue(record.name);
                setDisplayNameError("");
                setDisplayNameOpen(true);
              }}
            >
              <Pencil className="h-4 w-4" /> Исправить имя
            </button>
          )}
          {base === "anna" && canEdit && (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="h-4 w-4" /> Изменить имя и город
              </button>
              <button
                className={
                  record.archived ? "btn btn-primary" : "btn btn-secondary"
                }
                disabled={editBusy}
                onClick={() => void toggleRecordArchive()}
              >
                {record.archived
                  ? "Восстановить запись"
                  : "Архивировать запись"}
              </button>
            </>
          )}
          {record.amoContactUrl && (
            <a
              className="btn btn-secondary"
              href={record.amoContactUrl}
              target="_blank"
              rel="noreferrer"
            >
              amoCRM <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
      </div>
      <div
        className="flex gap-1 overflow-x-auto border-b border-border"
        role="tablist"
      >
        {tabs.map(([tabValue, label]) => (
          <button
            key={tabValue}
            role="tab"
            aria-selected={tab === tabValue}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === tabValue ? "border-accent font-semibold text-accent" : "border-transparent text-text-muted"}`}
            onClick={() => setTab(tabValue)}
          >
            {label}
          </button>
        ))}
      </div>
      {actionError && (
        <p className="rounded-lg bg-error/10 p-3 text-sm text-error">
          {actionError}
        </p>
      )}
      {permissionsLoading && (
        <ResourceLoading label="Проверяем права карточки…" />
      )}
      {permissionsError && (
        <ResourceError
          message={permissionsError}
          onRetry={() => void loadPermissions()}
        />
      )}
      {tab === "summary" && (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Статус / уровень">
              <LoyaltyStatusBadges record={record} />
            </Metric>
            <Metric label="Стадия отношений">
              {text(stageLabel(record.stage))}
            </Metric>
            {/* 2026-09-07: пустое качество данных не показываем вовсе —
                плитка «Качество: Нет данных» только пугала. */}
            {record.dataQuality && (
              <Metric label="Качество данных">{text(record.dataQuality)}</Metric>
            )}
            <Metric label="Последний контакт">
              {date(record.lastActivityAt)}
            </Metric>
          </div>
          {record.entityType === "brokers" ? (
            <BrokerProfile record={record} />
          ) : (
            <AgencyProfile record={record} />
          )}
          {/* 2026-09-07: данные нашей карточки по сцепке (сверка → LINK):
              всё, что найдено/дополнено для нашей базы (телефоны,
              юрназвание, amoCRM, сделки), видно и в карточке Анны. */}
          {record.linkedOurRecord && (
            <LinkedOurRecordSummary linked={record.linkedOurRecord} />
          )}
          {/* 2026-09-08: обратная сцепка — у нашей карточки ссылка на запись
              базы Анны, чтобы связь была видна в обе стороны. */}
          {base === "ours" && record.linkedAnna && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3">
              <div>
                <span className="text-xs uppercase tracking-wide text-text-muted">
                  База Анны · сцепка подтверждена
                </span>
                <p className="font-semibold">
                  {record.linkedAnna.name || "Запись базы Анны"}
                  {record.linkedAnna.city ? (
                    <span className="ml-2 text-xs font-normal text-text-muted">
                      {record.linkedAnna.city}
                    </span>
                  ) : null}
                </p>
              </div>
              <Link
                href={`/admin/loyalty-base/anna/${record.linkedAnna.entityType}/${encodeURIComponent(record.linkedAnna.id)}`}
                className="btn btn-secondary inline-flex"
              >
                <ExternalLink className="h-4 w-4" /> Открыть в базе Анны
              </Link>
            </div>
          )}
          {record.metricSource && (
            <div className="rounded-xl border border-accent/25 bg-accent/5 p-3 text-sm">
              {/* 2026-09-07: источник и точность — по-русски; пустое
                  качество не показываем. */}
              <b>Источник:</b>{" "}
              {text(loyaltyMetricSourceLabelRu(record.metricSource.label))} ·
              точность:{" "}
              {loyaltyExactnessLabelRu(record.metricSource.exactness) ||
                "нет данных"}
              {record.metricSource.quality
                ? ` · качество: ${record.metricSource.quality}`
                : ""}
              {/* Плашка о периоде — только когда период действительно выбран
                  (periodMetrics.period). Если периодные метрики посчитаны,
                  это спокойная подсказка; если нет — предупреждение. */}
              {record.metricSource.periodFilterApplied === false &&
                record.periodMetrics?.period &&
                (record.periodMetrics.availability === "UNAVAILABLE" ? (
                  <p className="mt-1 text-warning">
                    Выбранный период к этим цифрам применить нельзя — данные
                    источника не разложены по датам, показатели за всё время.
                  </p>
                ) : (
                  <p className="mt-1 text-text-muted">
                    Цифры в этом блоке — за всё время. Выбранный период
                    применён в блоке «За выбранный период» (вкладка «Метрики»).
                  </p>
                ))}
            </div>
          )}
        </div>
      )}
      {tab === "contacts" && (
        <div className="space-y-4">
          <p className="rounded-xl border border-border bg-surface-secondary p-3 text-sm text-text-muted">
            Контакты исходного снимка доступны только для чтения. Администратор
            может добавить отдельный ручной телефон/email/мессенджер в базе Анны
            — подписанный снимок при этом не меняется. Контактные лица агентства
            остаются read-only; в нашей базе исправления выполняются через
            штатные разделы «Админка — Брокеры/Агентства».
          </p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Основной телефон">
              {record.phone ? (
                <a
                  href={`tel:${record.phone.replace(/[^+\d]/g, "")}`}
                  className="text-accent"
                >
                  {record.phone}
                </a>
              ) : (
                "Нет данных"
              )}
            </Metric>
            <Metric label="Основной email">
              {record.email ? (
                <a href={`mailto:${record.email}`} className="text-accent">
                  {record.email}
                </a>
              ) : (
                "Нет данных"
              )}
            </Metric>
            <Metric label="География">{text(record.geography)}</Metric>
            <Metric label="Город / регион">{text(record.city)}</Metric>
            <Metric label="Связь amoCRM">
              {record.hasAmo === null
                ? "Нет данных"
                : record.hasAmo
                  ? "Найдена"
                  : "Не найдена"}
            </Metric>
          </div>
          <section>
            <h3 className="mb-2 font-semibold">
              Все телефоны, email и социальные сети
            </h3>
            {record.contactPoints.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {record.contactPoints.map((point, index) => (
                  <div
                    className="rounded-xl border border-border p-3 text-sm"
                    key={point.id || index}
                  >
                    <div className="text-xs text-text-muted">
                      {point.label || point.type}
                      {point.isPrimary ? " · основной" : ""}
                    </div>
                    <div className="mt-1 break-all">{point.value}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                Дополнительные контакты не переданы.
              </p>
            )}
          </section>
          {base === "anna" && canReadAll && (
            <section className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-semibold">Ручное дополнение контактов</h3>
                  <p className="text-xs text-text-muted">
                    Отдельный аудируемый overlay; архивные контакты можно
                    восстановить.
                  </p>
                </div>
                {canEdit && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => setContactPointOpen(true)}
                  >
                    <Plus className="h-4 w-4" /> Добавить контакт
                  </button>
                )}
              </div>
              {manualPointsLoading ? (
                <div className="mt-3">
                  <ResourceLoading label="Загружаем ручные контакты…" />
                </div>
              ) : manualPointsError ? (
                <div className="mt-3">
                  <ResourceError
                    message={manualPointsError}
                    onRetry={() => void loadManualPoints()}
                  />
                </div>
              ) : !manualPoints.length ? (
                <p className="mt-3 text-sm text-text-muted">
                  Ручных контактов нет.
                </p>
              ) : (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {manualPoints.map((point) => (
                    <div
                      className={`rounded-xl border p-3 text-sm ${point.archivedAt ? "border-dashed border-border opacity-65" : "border-border"}`}
                      key={point.id}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className="text-xs text-text-muted">
                            {point.type}
                            {point.isPrimary ? " · основной" : ""}
                            {point.archivedAt ? " · архив" : ""}
                          </span>
                          <b className="mt-1 block break-all">
                            {point.value || point.maskedValue || "Нет данных"}
                          </b>
                          <span className="text-xs text-text-muted">
                            {point.label || "Без подписи"}
                          </span>
                        </div>
                        <span className="text-xs text-text-muted">
                          v{point.version}
                        </span>
                      </div>
                      {canEdit && (
                        <div className="mt-2 flex gap-3 text-xs">
                          <button
                            className="underline"
                            disabled={Boolean(point.archivedAt)}
                            onClick={() => setEditContactPoint(point)}
                          >
                            Изменить
                          </button>
                          <button
                            className="underline"
                            disabled={contactAction === point.id}
                            onClick={() => void toggleManualPoint(point)}
                          >
                            {contactAction === point.id
                              ? "Сохраняем…"
                              : point.archivedAt
                                ? "Восстановить"
                                : "Архивировать"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          {record.entityType === "agencies" && (
            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">Контактные лица агентства</h3>
                {base === "anna" && canEdit && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => setAgencyPersonOpen(true)}
                  >
                    <Plus className="h-4 w-4" /> Добавить контактное лицо
                  </button>
                )}
              </div>
              {agencyPeopleLoading && (
                <ResourceLoading label="Загружаем контактных лиц…" />
              )}
              {agencyPeopleError && (
                <ResourceError
                  message={agencyPeopleError}
                  onRetry={() => void loadAgencyPeople()}
                />
              )}
              {base === "anna" && canReadAll && agencyPeople.length > 0 && (
                <div className="mb-3 space-y-2">
                  {agencyPeople.map((person) => (
                    <div
                      key={person.id}
                      className={`rounded-xl border p-3 ${person.archivedAt ? "border-dashed border-border opacity-65" : "border-border"}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <b>{person.displayName}</b>
                          <p className="text-sm text-text-muted">
                            {person.role || "Роль не указана"} ·{" "}
                            {person.actualityStatus}
                          </p>
                          <p className="text-sm">
                            {person.contactPoints
                              .map((point) => point.value || point.maskedValue)
                              .filter(Boolean)
                              .join(" · ") || "Нет контактных данных"}
                          </p>
                        </div>
                        <span className="text-xs text-text-muted">
                          v{person.version}
                          {person.archivedAt ? " · архив" : ""}
                        </span>
                      </div>
                      {canEdit && (
                        <div className="mt-2 flex gap-3 text-xs">
                          <button
                            className="underline"
                            disabled={Boolean(person.archivedAt)}
                            onClick={() => setEditAgencyPerson(person)}
                          >
                            Изменить
                          </button>
                          <button
                            className="underline"
                            disabled={contactAction === person.id}
                            onClick={() => void toggleAgencyPerson(person)}
                          >
                            {contactAction === person.id
                              ? "Сохраняем…"
                              : person.archivedAt
                                ? "Восстановить"
                                : "Архивировать"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {record.contacts.length ? (
                <div className="space-y-2">
                  {record.contacts.map((contact, index) => {
                    const managed = agencyPeople.some(
                      (person) => person.id === contact.id,
                    );
                    return (
                      <div
                        key={contact.id || index}
                        className="rounded-xl border border-border p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <b>{text(contact.name)}</b>
                          <span className="text-xs text-text-muted">
                            {text(contact.status)}
                          </span>
                        </div>
                        <p className="text-sm text-text-muted">
                          {contact.role || "Роль не указана"}
                        </p>
                        {contact.contactPoints.length ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {contact.contactPoints.map((point, pointIndex) => (
                              <span
                                className="rounded-md bg-surface-secondary px-2 py-1 text-xs"
                                key={point.id || `${point.type}-${pointIndex}`}
                              >
                                {point.label || point.type}: {point.value}
                                {point.isPrimary ? " · основной" : ""}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-1 text-sm text-text-muted">
                            Нет контактных данных
                          </p>
                        )}
                        {base === "anna" && canEdit && !managed && (
                          <button
                            className="mt-2 text-xs underline"
                            onClick={() => setAgencyPersonSeed(contact)}
                          >
                            Дополнить вручную
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-muted">
                  Контактные лица не переданы.
                </p>
              )}
            </section>
          )}
        </div>
      )}
      {tab === "activity" && (
        <div className="space-y-4">
          <ActivityMetrics record={record} />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Последняя фиксация · срез источника">
              {date(record.sourceReportedMetrics?.lastFixationAt || "")}
            </Metric>
            <Metric label="Последняя встреча · срез источника">
              {date(record.sourceReportedMetrics?.lastMeetingAt || "")}
            </Metric>
            <Metric label="Последняя сделка · срез источника">
              {date(record.sourceReportedMetrics?.lastDealAt || "")}
            </Metric>
            <Metric label="Брокер-тур · срез источника">
              {record.sourceReportedMetrics?.brokerTourVisited === null ||
              record.sourceReportedMetrics?.brokerTourVisited === undefined
                ? "Нет данных"
                : record.sourceReportedMetrics.brokerTourVisited
                  ? "Указано: был · не подтверждено событиями"
                  : "Указано: не был · не подтверждено событиями"}
            </Metric>
          </div>
          {record.sourceReportedMetrics &&
            Object.keys(record.sourceReportedMetrics.dealsByMonth).length >
              0 && (
              <div>
                <h3 className="mb-2 font-semibold">Сделки по месяцам</h3>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(record.sourceReportedMetrics.dealsByMonth)
                    .filter(([, number]) => number > 0)
                    .map(([month, number]) => (
                      <span
                        key={month}
                        className="rounded-lg border border-border px-3 py-2 text-sm"
                      >
                        {month}: <b>{number}</b>
                      </span>
                    ))}
                </div>
              </div>
            )}
          <h3 className="font-semibold">События и карточки-основания</h3>
          <Timeline
            items={activities}
            entityType={record.entityType}
            evidence={record.activityEvidence}
            empty="События-основания в ответе отсутствуют."
          />
          {/* 2026-09-07: события нашей карточки по сцепке — фиксации,
              встречи, сделки кабинета и реестра ДДУ, ссылки на amoCRM. */}
          {record.linkedOurRecord && (
            <>
              <h3 className="font-semibold">
                События нашей карточки по сцепке ·{" "}
                {record.linkedOurRecord.name}
              </h3>
              <Timeline
                items={record.linkedOurRecord.history.filter(
                  (item) => !/call|звон/i.test(`${item.type} ${item.title}`),
                )}
                entityType={record.linkedOurRecord.entityType}
                evidence={record.linkedOurRecord.activityEvidence}
                empty="В нашей карточке событий пока нет."
              />
            </>
          )}
        </div>
      )}
      {tab === "calls" && (
        <div className="space-y-3">
          <dl className="grid gap-2 sm:grid-cols-3">
            <Metric label="Последний звонок">{date(record.lastCallAt)}</Metric>
            <Metric label="Результат">
              <LoyaltyCallResultBadge
                result={record.lastCallResult}
                entityType={record.entityType}
              />
            </Metric>
            <Metric label="Дней без контакта">
              {count(record.daysWithoutContact)}
            </Metric>
          </dl>
          <Timeline
            items={calls}
            entityType={record.entityType}
            empty="История звонков пока не передана API."
            onCorrect={canExecuteCalls ? setEditCall : undefined}
            canCorrect={(item) =>
              effective?.role === "ADMIN" ||
              effective?.defaults.ownAttempts === false ||
              Boolean(me?.id && item.employeeId === me.id)
            }
          />
        </div>
      )}
      {tab === "tasks" && (
        <div className="space-y-3">
          {operatorsLoading && (
            <ResourceLoading label="Загружаем сотрудников…" />
          )}
          {operatorsError && (
            <ResourceError
              message={operatorsError}
              onRetry={() => void loadOperators()}
            />
          )}
          {canEdit && (
            <div className="flex justify-end">
              <button
                className="btn btn-primary"
                onClick={() => setTaskOpen(true)}
              >
                <Plus className="h-4 w-4" /> Добавить задачу
              </button>
            </div>
          )}
          {tasksLoading ? (
            <ResourceLoading label="Загружаем задачи…" />
          ) : tasksError ? (
            <ResourceError
              message={tasksError}
              onRetry={() => void loadTasks()}
            />
          ) : tasks.length ? (
            tasks.map((item) => (
              <div
                className="rounded-xl border border-border p-3"
                key={item.id}
              >
                <div className="flex justify-between gap-2">
                  <b>{item.title}</b>
                  <span className="text-xs text-text-muted">{item.status}</span>
                </div>
                <p className="text-sm text-text-muted">
                  {item.description || "Без описания"}
                </p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-xs">
                    Срок: {date(item.dueAt)} ·{" "}
                    {item.assignedTo?.name || "Не назначена"}
                  </p>
                  <div className="flex gap-2">
                    {canEdit && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => setEditTask(item)}
                      >
                        <Pencil className="h-4 w-4" /> Изменить
                      </button>
                    )}
                    {canEdit && item.status === "OPEN" && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => void completeTask(item)}
                      >
                        Выполнено
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="rounded-xl border border-dashed border-border p-5 text-sm text-text-muted">
              Задач нет.
            </p>
          )}
        </div>
      )}
      {tab === "loyalty" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-text-muted">
              Основание можно указать HTTPS-ссылкой. Файлы PDF, JPG, PNG и DOCX
              хранятся в защищённом контуре и скачиваются только после проверки
              прав.
            </p>
            {canEdit && (
              <button
                className="btn btn-primary"
                onClick={() => setEventOpen(true)}
              >
                <Gift className="h-4 w-4" /> Добавить событие
              </button>
            )}
          </div>
          {eventsLoading ? (
            <ResourceLoading label="Загружаем события и вложения…" />
          ) : eventsError ? (
            <ResourceError
              message={eventsError}
              onRetry={() => void loadEvents()}
            />
          ) : events.length ? (
            events.map((item) => (
              <div
                className="rounded-xl border border-border p-3"
                key={item.id}
              >
                <div className="flex justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <b>{eventLabels[item.type]}</b>
                    {item.archivedAt && (
                      <span className="rounded-full bg-warning/10 px-2 py-1 text-xs text-warning">
                        В архиве
                      </span>
                    )}
                    {item.superseded && (
                      <span className="rounded-full bg-surface-secondary px-2 py-1 text-xs text-text-muted">
                        Заменено исправлением
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-text-muted">
                    {date(item.occurredAt)}
                  </span>
                </div>
                <p className="mt-1 text-sm">{item.comment}</p>
                {item.correctionReason && (
                  <p className="mt-1 text-xs text-text-muted">
                    Причина исправления: {item.correctionReason}
                  </p>
                )}
                <p className="mt-1 text-xs text-text-muted">
                  {[
                    item.employee,
                    item.amount && formatRubles(item.amount),
                    item.value,
                    item.validUntil && `до ${date(item.validUntil)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {(safeHttpUrl(item.basisUrl) ||
                  safeHttpUrl(item.attachmentUrl)) && (
                  <div className="mt-2 flex flex-wrap gap-3 text-xs">
                    {safeHttpUrl(item.basisUrl) && (
                      <a
                        className="text-accent"
                        href={safeHttpUrl(item.basisUrl)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Основание
                      </a>
                    )}
                    {safeHttpUrl(item.attachmentUrl) && (
                      <a
                        className="text-accent"
                        href={safeHttpUrl(item.attachmentUrl)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Вложение
                      </a>
                    )}
                  </div>
                )}
                {item.attachments.length > 0 && (
                  <div className="mt-3 space-y-2 rounded-lg bg-surface-secondary p-2">
                    <p className="flex items-center gap-1 text-xs font-medium">
                      <Paperclip className="h-3.5 w-3.5" /> Защищённые вложения
                    </p>
                    {item.attachments.map((attachment) => (
                      <div
                        className="flex flex-wrap items-center justify-between gap-2 text-xs"
                        key={attachment.id}
                      >
                        <span className="min-w-0 break-all">
                          {attachment.fileName} ·{" "}
                          {Math.max(1, Math.ceil(attachment.size / 1024))} КБ
                        </span>
                        <span className="flex gap-2">
                          <button
                            className="inline-flex items-center gap-1 text-accent underline"
                            disabled={eventAction === attachment.id}
                            onClick={() => void downloadAttachment(attachment)}
                            type="button"
                          >
                            <Download className="h-3.5 w-3.5" /> Скачать
                          </button>
                          {canEdit && (
                            <button
                              className="inline-flex items-center gap-1 text-text-muted underline"
                              disabled={eventAction === attachment.id}
                              onClick={() => void archiveAttachment(attachment)}
                              type="button"
                            >
                              <Trash2 className="h-3.5 w-3.5" /> Архивировать
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {canEdit && item.current && (
                  <div className="mt-2 flex gap-3 text-xs">
                    {!item.archivedAt && (
                      <button
                        className="text-text-muted underline"
                        onClick={() => setEditEvent(item)}
                      >
                        Исправить с аудитом
                      </button>
                    )}
                    <button
                      className="text-text-muted underline"
                      disabled={eventAction === item.id}
                      onClick={() => void setEventArchived(item)}
                    >
                      {eventAction === item.id
                        ? item.archivedAt
                          ? "Восстанавливаем…"
                          : "Архивируем…"
                        : item.archivedAt
                          ? "Восстановить"
                          : "Архивировать"}
                    </button>
                  </div>
                )}
              </div>
            ))
          ) : record.recognitions.length ? (
            record.recognitions.map((item, index) => (
              <div
                className="rounded-xl border border-border p-3"
                key={item.id || index}
              >
                <b>{item.type || "Событие"}</b>
                <p className="text-sm">{item.note || "Без комментария"}</p>
                <p className="text-xs text-text-muted">
                  {date(item.date)} · {item.employee || "Сотрудник не указан"}
                </p>
              </div>
            ))
          ) : (
            <p className="rounded-xl border border-dashed border-border p-5 text-sm text-text-muted">
              Событий лояльности нет.
            </p>
          )}
        </div>
      )}
      {tab === "provenance" && (
        <div className="space-y-4">
          <section>
            <h3 className="mb-2 font-semibold">Идентификаторы источников</h3>
            <div className="rounded-xl border border-border p-3 text-sm break-all">
              {record.sourceIds.length
                ? record.sourceIds.join(" · ")
                : "Нет данных"}
            </div>
          </section>
          <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <Metric label="Альтернативные имена">
              {record.aliases.length
                ? record.aliases.join(" · ")
                : "Нет данных"}
            </Metric>
            <Metric label="Наборы / источники">
              {record.memberships.length
                ? record.memberships.join(" · ")
                : "Нет данных"}
            </Metric>
            <Metric label="Комментарий источника">
              {text(record.comment)}
            </Metric>
          </dl>
          <section>
            <h3 className="mb-2 font-semibold">Источники полей</h3>
            {record.provenance.length ? (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-secondary text-left">
                    <tr>
                      <th className="p-2">Поле</th>
                      <th className="p-2">Источник</th>
                      <th className="p-2">Обновлено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.provenance.map((item, index) => (
                      <tr
                        className="border-t border-border"
                        key={`${item.field}-${index}`}
                      >
                        <td className="p-2">{item.field}</td>
                        <td className="p-2">{item.source}</td>
                        <td className="p-2">{date(item.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                Provenance пока не передан.
              </p>
            )}
          </section>
          {canAudit && base === "anna" && (
            <section>
              <h3 className="mb-2 font-semibold">Журнал изменений</h3>
              {changesLoading ? (
                <ResourceLoading label="Загружаем журнал изменений…" />
              ) : changesError ? (
                <ResourceError
                  message={changesError}
                  onRetry={() => void loadChanges()}
                />
              ) : changes.length ? (
                <div className="space-y-2">
                  {changes.map((item) => (
                    <div
                      className="rounded-xl border border-border p-3 text-sm"
                      key={item.id}
                    >
                      <b>{item.action}</b>
                      <span className="ml-2 text-text-muted">
                        {date(item.occurredAt)} · {item.actor || "Система"}
                      </span>
                      {(item.before || item.after) && (
                        <details className="mt-2 rounded-lg bg-surface-secondary p-2 text-xs">
                          <summary className="cursor-pointer font-medium">
                            Поля до и после изменения, включая статус/стадию
                          </summary>
                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <div>
                              <b>До</b>
                              <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all">
                                {item.before
                                  ? JSON.stringify(item.before, null, 2)
                                  : "Нет данных"}
                              </pre>
                            </div>
                            <div>
                              <b>После</b>
                              <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all">
                                {item.after
                                  ? JSON.stringify(item.after, null, 2)
                                  : "Нет данных"}
                              </pre>
                            </div>
                          </div>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-text-muted">
                  Изменений нет или журнал недоступен.
                </p>
              )}
            </section>
          )}
          {base === "ours" && (
            <p className="rounded-xl border border-dashed border-border p-3 text-sm text-text-muted">
              Отдельная история изменений статуса и стадии для нашей базы этим
              API не передаётся. Показаны только текущее значение и provenance,
              без реконструкции отсутствующих событий.
            </p>
          )}
        </div>
      )}
      {showFullLink && (
        <Link
          href={`/admin/loyalty-base/${base}/${record.entityType}/${encodeURIComponent(record.id)}`}
          className="btn btn-secondary inline-flex"
        >
          <ExternalLink className="h-4 w-4" /> Открыть отдельно
        </Link>
      )}
      {taskOpen && (
        <TaskModal
          record={record}
          base={base}
          operators={operators}
          onClose={() => setTaskOpen(false)}
          onDone={() => {
            setTaskOpen(false);
            void loadWorkflow();
          }}
        />
      )}
      {contactPointOpen && (
        <ContactPointModal
          record={record}
          onClose={() => setContactPointOpen(false)}
          onDone={() => {
            setContactPointOpen(false);
            void loadManualPoints();
          }}
        />
      )}
      {editContactPoint && (
        <ContactPointModal
          record={record}
          point={editContactPoint}
          onClose={() => setEditContactPoint(null)}
          onDone={() => {
            setEditContactPoint(null);
            void loadManualPoints();
          }}
        />
      )}
      {agencyPersonOpen && (
        <AgencyContactPersonModal
          agencyId={record.id}
          onClose={() => setAgencyPersonOpen(false)}
          onDone={() => {
            setAgencyPersonOpen(false);
            void loadAgencyPeople();
          }}
        />
      )}
      {editAgencyPerson && (
        <AgencyContactPersonModal
          agencyId={record.id}
          person={editAgencyPerson}
          onClose={() => setEditAgencyPerson(null)}
          onDone={() => {
            setEditAgencyPerson(null);
            void loadAgencyPeople();
          }}
        />
      )}
      {agencyPersonSeed && (
        <AgencyContactPersonModal
          agencyId={record.id}
          seed={agencyPersonSeed}
          onClose={() => setAgencyPersonSeed(null)}
          onDone={() => {
            setAgencyPersonSeed(null);
            void loadAgencyPeople();
          }}
        />
      )}
      {editTask && (
        <TaskModal
          record={record}
          base={base}
          task={editTask}
          operators={operators}
          onClose={() => setEditTask(null)}
          onDone={() => {
            setEditTask(null);
            void loadWorkflow();
          }}
        />
      )}
      {eventOpen && (
        <EventModal
          record={record}
          base={base}
          onClose={() => setEventOpen(false)}
          onDone={() => {
            setEventOpen(false);
            void loadWorkflow();
          }}
        />
      )}
      {editEvent && (
        <EventModal
          record={record}
          base={base}
          event={editEvent}
          onClose={() => setEditEvent(null)}
          onDone={() => {
            setEditEvent(null);
            void loadWorkflow();
          }}
        />
      )}
      {editCall && (
        <CallCorrectionModal
          call={editCall}
          entityType={record.entityType}
          onClose={() => setEditCall(null)}
          onDone={() => window.location.reload()}
        />
      )}
      {displayNameOpen && (
        <Modal title="Исправить имя" onClose={() => setDisplayNameOpen(false)}>
          <label className="block text-sm">
            Имя для работы
            <input
              className="input mt-1"
              value={displayNameValue}
              onChange={(event) => setDisplayNameValue(event.target.value)}
            />
          </label>
          <p className="text-xs text-text-muted">
            Имя видит только колл-центр в «Нашей базе». Брокер в своём
            кабинете продолжит видеть своё имя
            {record.cabinetFullName ? ` («${record.cabinetFullName}»)` : ""}.
            Пустое поле — вернуть имя из кабинета.
          </p>
          {displayNameError && (
            <p className="rounded-lg bg-error/10 p-2 text-sm text-error">
              {displayNameError}
            </p>
          )}
          <button
            className="btn btn-primary w-full"
            disabled={displayNameBusy}
            onClick={() => void saveDisplayName()}
          >
            {displayNameBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Сохранить
          </button>
        </Modal>
      )}
      {editOpen && (
        <Modal title="Изменить имя и город" onClose={() => setEditOpen(false)}>
          <label className="block text-sm">
            Имя / название
            <input
              className="input mt-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Город
            <input
              className="input mt-1"
              value={city}
              onChange={(event) => setCity(event.target.value)}
            />
          </label>
          {editError && (
            <p className="rounded-lg bg-error/10 p-2 text-sm text-error">
              {editError}
            </p>
          )}
          <button
            className="btn btn-primary w-full"
            disabled={editBusy}
            onClick={() => void saveEdit()}
          >
            {editBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Сохранить
          </button>
        </Modal>
      )}
    </div>
  );
}
export function LoyaltyRecordDrawer({
  record,
  base,
  loading,
  error,
  onClose,
}: {
  record: LoyaltyRecord | null;
  base: LoyaltyBaseKey;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        className="h-full w-full max-w-4xl overflow-y-auto bg-surface shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-surface/95 px-5 py-3 backdrop-blur">
          <span className="font-semibold">Карточка контакта</span>
          <button
            className="rounded-lg p-2 hover:bg-surface-secondary"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5">
          {loading ? (
            <div className="flex justify-center gap-2 py-20 text-text-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
              Загружаем карточку…
            </div>
          ) : error ? (
            <div className="rounded-lg bg-error/10 p-4 text-error">{error}</div>
          ) : record ? (
            <DetailBody record={record} base={base} />
          ) : (
            <div className="py-20 text-center text-text-muted">
              Карточка не найдена.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
export function LoyaltyRecordPage({
  record,
  base,
}: {
  record: LoyaltyRecord;
  base: LoyaltyBaseKey;
}) {
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Link
        href="/admin/loyalty-base"
        className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-accent"
      >
        <ArrowLeft className="h-4 w-4" /> Назад к базе лояльности
      </Link>
      <div className="card">
        <DetailBody record={record} base={base} showFullLink={false} />
      </div>
    </div>
  );
}
