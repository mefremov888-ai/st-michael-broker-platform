'use client';

import Link from 'next/link';
import { ArrowLeft, Building2, CalendarDays, ExternalLink, Mail, Phone, UserRound, X } from 'lucide-react';
import { formatRubles, type LoyaltyBaseKey, type LoyaltyEntityType, type LoyaltyRecord } from '@/lib/loyalty-base-api';

const baseLabels: Record<LoyaltyBaseKey, string> = {
  anna: 'База Анны Скибицкой',
  ours: 'Наша база',
};

const formatDate = (value: string) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ru-RU');
};

const formatCount = (value: number | null) => value === null ? '—' : String(value);

function DetailBody({ record, base, showFullLink = true }: { record: LoyaltyRecord; base: LoyaltyBaseKey; showFullLink?: boolean }) {
  const detailHref = `/admin/loyalty-base/${base}/${record.entityType}/${encodeURIComponent(record.id)}`;
  const phoneHref = record.phone ? `tel:+${record.phone.replace(/\D/g, '')}` : '';

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-xs font-medium rounded-full bg-accent/10 text-accent px-2.5 py-1">
            {baseLabels[base]}
          </span>
          {record.archived && <span className="text-xs rounded-full bg-warning/15 text-warning px-2.5 py-1">В архиве</span>}
          {record.status && <span className="text-xs rounded-full bg-success/10 text-success px-2.5 py-1">{record.status}</span>}
        </div>
        <h2 className="text-2xl font-bold text-text">{record.name}</h2>
        <p className="text-sm text-text-muted mt-1">
          {record.entityType === 'brokers' ? record.company || 'Частный брокер' : record.company || 'Агентство'}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          ['Фиксации', record.fixations],
          ['Встречи', record.meetings],
          ['Сделки', record.deals],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-border bg-background p-3">
            <div className="text-xs text-text-muted">{label}</div>
            <div className="text-xl font-semibold mt-1">{formatCount(value as number | null)}</div>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-border p-4 space-y-3">
        <h3 className="font-semibold">Контакт и контекст</h3>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div className="flex gap-2"><Phone className="w-4 h-4 text-text-muted mt-0.5" />{record.phone ? <a className="hover:text-accent" href={phoneHref}>{record.phone}</a> : 'Не указан'}</div>
          <div className="flex gap-2"><Mail className="w-4 h-4 text-text-muted mt-0.5" />{record.email ? <a className="hover:text-accent break-all" href={`mailto:${record.email}`}>{record.email}</a> : 'Не указан'}</div>
          <div className="flex gap-2"><Building2 className="w-4 h-4 text-text-muted mt-0.5" /><span>{record.city || 'География не указана'}</span></div>
          <div className="flex gap-2"><UserRound className="w-4 h-4 text-text-muted mt-0.5" /><span>{record.assignee || 'Не назначен'}</span></div>
        </div>
        <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm pt-2 border-t border-border">
          <div><dt className="text-text-muted">Стадия</dt><dd>{record.stage || '—'}</dd></div>
          <div><dt className="text-text-muted">Качество данных</dt><dd>{record.dataQuality || '—'}</dd></div>
          <div><dt className="text-text-muted">Формат работы</dt><dd>{record.workFormat || '—'}</dd></div>
          <div><dt className="text-text-muted">Специализация</dt><dd>{record.specialization || '—'}</dd></div>
          <div><dt className="text-text-muted">Последний звонок</dt><dd>{formatDate(record.lastCallAt)}</dd></div>
          <div><dt className="text-text-muted">Последняя активность</dt><dd>{formatDate(record.lastActivityAt)}</dd></div>
          <div><dt className="text-text-muted">Сумма ДДУ</dt><dd>{formatRubles(record.dealAmount)}</dd></div>
          <div><dt className="text-text-muted">amoCRM</dt><dd>{record.hasAmo === null ? 'Нет данных' : record.hasAmo ? 'Связь найдена' : 'Не найдено'}</dd></div>
        </dl>
        {record.nextTask && <div className="rounded-lg bg-accent/5 p-3 text-sm"><span className="text-text-muted">Следующий шаг: </span>{record.nextTask}</div>}
      </section>

      {record.entityType === 'agencies' && record.contacts.length > 0 && (
        <section>
          <h3 className="font-semibold mb-2">Контактные лица</h3>
          <div className="space-y-2">
            {record.contacts.map((contact, index) => (
              <div key={contact.id || `${contact.name}-${index}`} className="rounded-lg border border-border p-3 text-sm">
                <div className="font-medium">{contact.name || 'Имя не указано'}</div>
                <div className="text-text-muted">{[contact.role, contact.phone, contact.email].filter(Boolean).join(' · ') || 'Контакты не указаны'}</div>
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
              <li key={event.id || `${event.type}-${event.occurredAt}-${index}`} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{event.title || event.type || 'Событие'}</span>
                  <span className="text-xs text-text-muted whitespace-nowrap">{formatDate(event.occurredAt)}</span>
                </div>
                {event.description && <p className="text-text-muted mt-1">{event.description}</p>}
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-text-muted rounded-lg border border-dashed border-border p-4">История пока не передана API.</p>}
      </section>

      {record.provenance.length > 0 && (
        <section>
          <h3 className="font-semibold mb-2">Источники полей</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead><tr className="bg-surface-secondary text-left"><th className="p-2">Поле</th><th className="p-2">Источник</th><th className="p-2">Обновлено</th></tr></thead>
              <tbody>{record.provenance.map((item, index) => <tr className="border-t border-border" key={`${item.field}-${index}`}><td className="p-2">{item.field}</td><td className="p-2">{item.source}</td><td className="p-2">{formatDate(item.updatedAt)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}

      {showFullLink && (
        <Link href={detailHref} className="btn btn-secondary inline-flex items-center gap-2">
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
    <div className="fixed inset-0 z-50 bg-black/50 flex justify-end" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="h-full w-full max-w-2xl bg-surface shadow-xl overflow-y-auto" role="dialog" aria-modal="true" aria-label="Карточка контакта">
        <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur border-b border-border px-5 py-4 flex justify-between items-center">
          <span className="font-semibold">Карточка</span>
          <button type="button" className="p-2 rounded-lg hover:bg-surface-secondary" onClick={onClose} aria-label="Закрыть"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5">
          {loading ? <div className="py-16 text-center text-text-muted">Загружаем карточку…</div>
            : error ? <div className="rounded-lg bg-error/10 text-error p-4">{error}</div>
              : record ? <DetailBody record={record} base={base} />
                : <div className="py-16 text-center text-text-muted">Карточка не найдена.</div>}
        </div>
      </aside>
    </div>
  );
}

export function LoyaltyRecordPage({ record, base }: { record: LoyaltyRecord; base: LoyaltyBaseKey }) {
  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <Link href="/admin/loyalty-base" className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-accent">
        <ArrowLeft className="w-4 h-4" /> Назад к базе лояльности
      </Link>
      <div className="card"><DetailBody record={record} base={base} showFullLink={false} /></div>
    </div>
  );
}
