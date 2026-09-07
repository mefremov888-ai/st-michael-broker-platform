"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  ExternalLink,
  Mail,
  Phone,
  UserRound,
  X,
} from "lucide-react";
import {
  formatRubles,
  type LoyaltyBaseKey,
  type LoyaltyRecord,
} from "@/lib/loyalty-base-api";

const baseLabels: Record<LoyaltyBaseKey, string> = {
  anna: "База Анны Скибицкой",
  ours: "Наша база",
};

const formatDate = (value: string) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("ru-RU");
};

const formatCount = (value: number | null) =>
  value === null ? "—" : String(value);

const contactTypeLabel = (type: string) =>
  ({
    PHONE: "Телефон",
    EMAIL: "Email",
    TELEGRAM: "Telegram",
    WHATSAPP: "WhatsApp",
  })[type] ||
  type ||
  "Контакт";

function contactValue(point: LoyaltyRecord["contactPoints"][number]) {
  if (point.type === "PHONE")
    return (
      <a
        className="hover:text-accent"
        href={`tel:+${point.value.replace(/\D/g, "")}`}
      >
        {point.value}
      </a>
    );
  if (point.type === "EMAIL")
    return (
      <a className="hover:text-accent break-all" href={`mailto:${point.value}`}>
        {point.value}
      </a>
    );
  return <span className="break-all">{point.value}</span>;
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
  const detailHref = `/admin/loyalty-base/${base}/${record.entityType}/${encodeURIComponent(record.id)}`;
  const phoneHref = record.phone
    ? `tel:+${record.phone.replace(/\D/g, "")}`
    : "";
  const extraContactPoints = record.contactPoints.filter(
    (point) =>
      !(
        (point.type === "PHONE" && point.value === record.phone) ||
        (point.type === "EMAIL" && point.value === record.email)
      ),
  );
  const annaProfile = record.annaDetails;
  const agencyProfileRows = annaProfile
    ? [
        ["Размер агентства", annaProfile.agencySize],
        ["Брокеров по данным Анны", annaProfile.brokerCount],
        ["Активных брокеров", annaProfile.activeBrokers],
        ["Проекты на сайте", annaProfile.projectsOnSite],
        ["Требования к размещению", annaProfile.sitePlacementRequirements],
        ["Формат БТ агентства", annaProfile.agencyBtFormat],
        ["Статус партнёрства", annaProfile.partnershipStatus],
        ["Источник CRM", annaProfile.crmSource],
      ].filter(([, value]) => value !== null && value !== "")
    : [];
  const dealControlRows = annaProfile
    ? [
        ["Контроль оплаты", annaProfile.paymentControl],
        ["Успешные сделки", annaProfile.successfulDeals],
        ["Сделки Zorge", annaProfile.zorgeDeals],
        ["Сделки Берзарина", annaProfile.berzarinaDeals],
        ["Активные карточки CRM", annaProfile.activeCrmCards],
        ["Оценка CRM", annaProfile.crmScore],
        ["Сделки с указанной суммой", annaProfile.dealsWithAmount],
        [
          "Проверенные ID сделок — количество",
          annaProfile.verifiedDealIdsCount,
        ],
      ].filter(([, value]) => value !== null && value !== "")
    : [];

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-xs font-medium rounded-full bg-accent/10 text-accent px-2.5 py-1">
            {baseLabels[base]}
          </span>
          {record.archived && (
            <span className="text-xs rounded-full bg-warning/15 text-warning px-2.5 py-1">
              В архиве
            </span>
          )}
          {record.status && (
            <span className="text-xs rounded-full bg-success/10 text-success px-2.5 py-1">
              {record.status}
            </span>
          )}
        </div>
        <h2 className="text-2xl font-bold text-text">{record.name}</h2>
        <p className="text-sm text-text-muted mt-1">
          {record.entityType === "brokers"
            ? record.company || "Частный брокер"
            : record.company || "Агентство"}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          ["Фиксации", record.fixations],
          ["Встречи", record.meetings],
          ["Сделки", record.deals],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="rounded-lg border border-border bg-background p-3"
          >
            <div className="text-xs text-text-muted">{label}</div>
            <div className="text-xl font-semibold mt-1">
              {formatCount(value as number | null)}
            </div>
          </div>
        ))}
      </div>

      {record.sourceReportedMetrics &&
        record.metricSource?.kind !== "EXACT_ACTIVITIES" && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <div className="font-medium">
              Исторические показатели из среза Анны
            </div>
            <p className="mt-1 text-text-muted">
              Эти числа сохранены в том виде, как их подготовила Анна. В
              исходнике нет отдельных идентификаторов всех событий, поэтому
              данные не выдаются за подтверждённую периодную аналитику и не
              смешиваются с нашей базой.
            </p>
          </div>
        )}

      <section className="rounded-xl border border-border p-4 space-y-3">
        <h3 className="font-semibold">Контакт и контекст</h3>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div className="flex gap-2">
            <Phone className="w-4 h-4 text-text-muted mt-0.5" />
            {record.phone ? (
              <a className="hover:text-accent" href={phoneHref}>
                {record.phone}
              </a>
            ) : (
              "Не указан"
            )}
          </div>
          <div className="flex gap-2">
            <Mail className="w-4 h-4 text-text-muted mt-0.5" />
            {record.email ? (
              <a
                className="hover:text-accent break-all"
                href={`mailto:${record.email}`}
              >
                {record.email}
              </a>
            ) : (
              "Не указан"
            )}
          </div>
          <div className="flex gap-2">
            <Building2 className="w-4 h-4 text-text-muted mt-0.5" />
            <span>{record.city || "География не указана"}</span>
          </div>
          <div className="flex gap-2">
            <UserRound className="w-4 h-4 text-text-muted mt-0.5" />
            <span>{record.assignee || "Не назначен"}</span>
          </div>
        </div>
        <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm pt-2 border-t border-border">
          <div>
            <dt className="text-text-muted">Стадия</dt>
            <dd>{record.stage || "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Качество данных</dt>
            <dd>{record.dataQuality || "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Формат работы</dt>
            <dd>{record.workFormat || "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Специализация</dt>
            <dd>{record.specialization || "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Дата рождения</dt>
            <dd>{record.birthday || "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Последний звонок</dt>
            <dd>{formatDate(record.lastCallAt)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Последняя активность</dt>
            <dd>{formatDate(record.lastActivityAt)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Сумма ДДУ</dt>
            <dd>{formatRubles(record.dealAmount)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">amoCRM</dt>
            <dd>
              {record.amoContactUrl ? (
                <a
                  className="inline-flex items-center gap-1 hover:text-accent"
                  href={record.amoContactUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть контакт <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : record.hasAmo === null ? (
                "Нет данных"
              ) : record.hasAmo ? (
                "Связь найдена"
              ) : (
                "Не найдено"
              )}
            </dd>
          </div>
        </dl>
        {record.nextTask && (
          <div className="rounded-lg bg-accent/5 p-3 text-sm">
            <span className="text-text-muted">Следующий шаг: </span>
            {record.nextTask}
          </div>
        )}
      </section>

      {extraContactPoints.length > 0 && (
        <section className="rounded-xl border border-border p-4">
          <h3 className="font-semibold mb-2">Дополнительные контакты</h3>
          <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {extraContactPoints.map((point, index) => (
              <div key={point.id || `${point.type}-${point.value}-${index}`}>
                <dt className="text-text-muted">
                  {point.label || contactTypeLabel(point.type)}
                </dt>
                <dd>{contactValue(point)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {base === "anna" &&
        annaProfile &&
        (agencyProfileRows.length > 0 ||
          annaProfile.website ||
          annaProfile.lastAgencyMeetingDate ||
          annaProfile.lastContractDate) && (
          <section className="rounded-xl border border-border p-4 space-y-3">
            <h3 className="font-semibold">Профиль из базы Анны</h3>
            <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {agencyProfileRows.map(([label, value]) => (
                <div key={String(label)}>
                  <dt className="text-text-muted">{label}</dt>
                  <dd className="whitespace-pre-wrap">{String(value)}</dd>
                </div>
              ))}
              {annaProfile.website && (
                <div>
                  <dt className="text-text-muted">Сайт</dt>
                  <dd className="break-all">{annaProfile.website}</dd>
                </div>
              )}
              {annaProfile.lastAgencyMeetingDate && (
                <div>
                  <dt className="text-text-muted">
                    Последняя встреча с агентством
                  </dt>
                  <dd>{formatDate(annaProfile.lastAgencyMeetingDate)}</dd>
                </div>
              )}
              {annaProfile.lastContractDate && (
                <div>
                  <dt className="text-text-muted">Последний договор</dt>
                  <dd>{formatDate(annaProfile.lastContractDate)}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

      {base === "anna" && dealControlRows.length > 0 && (
        <section className="rounded-xl border border-border p-4 space-y-3">
          <div>
            <h3 className="font-semibold">Контроль сделок из базы Анны</h3>
            <p className="mt-1 text-xs text-text-muted">
              Сохранённые контрольные значения источника; они не заменяют
              подтверждённые события amoCRM.
            </p>
          </div>
          <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {dealControlRows.map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-text-muted">{label}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {(record.memberships.length > 0 ||
        record.aliases.length > 0 ||
        record.comment ||
        record.sourceIds.length > 0) && (
        <section className="rounded-xl border border-border p-4 space-y-3">
          <h3 className="font-semibold">Данные исходного среза</h3>
          {record.memberships.length > 0 && (
            <div>
              <div className="text-xs text-text-muted mb-1.5">Списки Анны</div>
              <div className="flex flex-wrap gap-1.5">
                {record.memberships.map((item) => (
                  <span
                    key={item}
                    className="rounded-full bg-accent/10 px-2.5 py-1 text-xs text-accent"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          )}
          {record.aliases.length > 0 && (
            <div className="text-sm">
              <span className="text-text-muted">Другие имена: </span>
              {record.aliases.join(", ")}
            </div>
          )}
          {record.comment && (
            <div className="rounded-lg bg-surface-secondary p-3 text-sm">
              <span className="text-text-muted">Комментарий Анны: </span>
              {record.comment}
            </div>
          )}
          {record.sourceIds.length > 0 && (
            <div className="text-xs break-all">
              <span className="text-text-muted">ID источников: </span>
              {record.sourceIds.join(", ")}
            </div>
          )}
        </section>
      )}

      {record.sourceReportedMetrics && (
        <section className="rounded-xl border border-border p-4 space-y-3">
          <div>
            <h3 className="font-semibold">Даты и разбивка из среза</h3>
            <p className="mt-1 text-xs text-text-muted">
              Источник:{" "}
              {record.sourceReportedMetrics.sourceLabel || "срез Анны"} ·
              точность:{" "}
              {record.sourceReportedMetrics.exactness || "не определена"}
            </p>
          </div>
          <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-text-muted">Последняя фиксация</dt>
              <dd>{formatDate(record.sourceReportedMetrics.lastFixationAt)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Последняя встреча</dt>
              <dd>{formatDate(record.sourceReportedMetrics.lastMeetingAt)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Последняя сделка</dt>
              <dd>{formatDate(record.sourceReportedMetrics.lastDealAt)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Последний звонок</dt>
              <dd>{formatDate(record.sourceReportedMetrics.lastCallAt)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">БТ по данным Анны</dt>
              <dd>
                {record.sourceReportedMetrics.brokerTourVisited === null
                  ? "Неизвестно"
                  : record.sourceReportedMetrics.brokerTourVisited
                    ? "Да"
                    : "Нет"}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Дата БТ</dt>
              <dd>{formatDate(record.sourceReportedMetrics.brokerTourAt)}</dd>
            </div>
          </dl>
          {Object.keys(record.sourceReportedMetrics.dealsByMonth).length >
            0 && (
            <div>
              <div className="text-xs text-text-muted mb-1.5">
                Сделки по месяцам
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(record.sourceReportedMetrics.dealsByMonth)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([month, count]) => (
                    <span
                      key={month}
                      className="rounded-lg border border-border px-2.5 py-1 text-sm"
                    >
                      {month}: <b>{count}</b>
                    </span>
                  ))}
              </div>
            </div>
          )}
        </section>
      )}

      {record.entityType === "agencies" && record.contacts.length > 0 && (
        <section>
          <h3 className="font-semibold mb-2">Контактные лица</h3>
          <div className="space-y-2">
            {record.contacts.map((contact, index) => (
              <div
                key={contact.id || `${contact.name}-${index}`}
                className="rounded-lg border border-border p-3 text-sm"
              >
                <div className="font-medium">
                  {contact.name || "Имя не указано"}
                </div>
                <div className="text-text-muted">
                  {[contact.role, contact.phone, contact.email]
                    .filter(Boolean)
                    .join(" · ") || "Контакты не указаны"}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {record.entityType === "agencies" && record.recognitions.length > 0 && (
        <section>
          <h3 className="font-semibold mb-2">Отметки и признания Анны</h3>
          <div className="space-y-2">
            {record.recognitions.map((item, index) => (
              <div
                key={item.id || `${item.type}-${item.date}-${index}`}
                className="rounded-lg border border-border p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.type || "Отметка"}</span>
                  <span className="text-xs text-text-muted whitespace-nowrap">
                    {formatDate(item.date)}
                  </span>
                </div>
                <div className="mt-1 text-text-muted">
                  {[
                    item.employee && `Сотрудник: ${item.employee}`,
                    item.amount && `Сумма: ${item.amount}`,
                    item.validUntil &&
                      `Действует до: ${formatDate(item.validUntil)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {item.note && (
                  <p className="mt-1 whitespace-pre-wrap">{item.note}</p>
                )}
                {item.hasAttachment && (
                  <p className="mt-1 text-xs text-text-muted">
                    В источнике отмечено вложение.
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="font-semibold mb-2">История</h3>
        {record.history.length ? (
          <ol className="space-y-2">
            {record.history.map((event, index) => (
              <li
                key={event.id || `${event.type}-${event.occurredAt}-${index}`}
                className="rounded-lg border border-border p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {event.title || event.type || "Событие"}
                  </span>
                  <span className="text-xs text-text-muted whitespace-nowrap">
                    {formatDate(event.occurredAt)}
                  </span>
                </div>
                {event.description && (
                  <p className="text-text-muted mt-1">{event.description}</p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-text-muted rounded-lg border border-dashed border-border p-4">
            История пока не передана API.
          </p>
        )}
      </section>

      {record.provenance.length > 0 && (
        <section>
          <h3 className="font-semibold mb-2">Источники полей</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-secondary text-left">
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
                    <td className="p-2">{formatDate(item.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showFullLink && (
        <Link
          href={detailHref}
          className="btn btn-secondary inline-flex items-center gap-2"
        >
          Открыть отдельно <ExternalLink className="w-4 h-4" />
        </Link>
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
      className="fixed inset-0 z-50 bg-black/50 flex justify-end"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        className="h-full w-full max-w-2xl bg-surface shadow-xl overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="Карточка контакта"
      >
        <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur border-b border-border px-5 py-4 flex justify-between items-center">
          <span className="font-semibold">Карточка</span>
          <button
            type="button"
            className="p-2 rounded-lg hover:bg-surface-secondary"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5">
          {loading ? (
            <div className="py-16 text-center text-text-muted">
              Загружаем карточку…
            </div>
          ) : error ? (
            <div className="rounded-lg bg-error/10 text-error p-4">{error}</div>
          ) : record ? (
            <DetailBody record={record} base={base} />
          ) : (
            <div className="py-16 text-center text-text-muted">
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
    <div className="max-w-4xl mx-auto space-y-5">
      <Link
        href="/admin/loyalty-base"
        className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-accent"
      >
        <ArrowLeft className="w-4 h-4" /> Назад к базе лояльности
      </Link>
      <div className="card">
        <DetailBody record={record} base={base} showFullLink={false} />
      </div>
    </div>
  );
}
