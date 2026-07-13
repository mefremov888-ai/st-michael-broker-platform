'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, apiPost } from '@/lib/api';
import { Calendar, ChevronLeft, ChevronRight, CheckCircle2, Pencil, X, Ban, Check, Phone } from 'lucide-react';

const statusLabels: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'Ожидает', cls: 'bg-warning/20 text-warning' },
  CONFIRMED: { label: 'Подтверждена', cls: 'bg-info/20 text-info' },
  COMPLETED: { label: 'Завершена', cls: 'bg-success/20 text-success' },
  CANCELLED: { label: 'Отменена', cls: 'bg-error/20 text-error' },
};

const typeLabels: Record<string, string> = {
  OFFICE_VISIT: 'В офисе',
  ONLINE: 'Онлайн',
  BROKER_TOUR: 'Брокер-тур',
};

// Bug fix 2026-06-02: в дропдаун выбора клиента для встречи попадали клиенты
// с истёкшей уникальностью. Встречу с таким клиентом нельзя планировать —
// нужно сначала продлить или зафиксировать. Фильтр держит:
//  - FIXED (фиксация принята менеджером) — встреча точно можно
//  - CONDITIONALLY_UNIQUE/UNDER_REVIEW + срок не истёк
const isUniquenessActive = (c: any): boolean => {
  if (c?.fixationStatus === 'FIXED') return true;
  if (!c?.uniquenessExpiresAt) return false;
  return new Date(c.uniquenessExpiresAt).getTime() > Date.now();
};

function extractExtraPhone(comment: string | null): string {
  if (!comment) return '';
  const m = comment.match(/Доп\. телефон:\s*([+\d\s\-()]+)/);
  return m ? m[1].trim() : '';
}

function stripExtraPhone(comment: string | null): string {
  if (!comment) return '';
  return comment.replace(/\.?\s*Доп\. телефон:.*$/, '').trim();
}

function EditMeetingModal({ meeting, onClose, onSaved }: { meeting: any; onClose: () => void; onSaved: () => void }) {
  const toLocalInput = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const [type, setType] = useState(meeting.type);
  const [date, setDate] = useState(toLocalInput(meeting.date));
  const [extraPhone, setExtraPhone] = useState(extractExtraPhone(meeting.comment));
  const [comment, setComment] = useState(stripExtraPhone(meeting.comment));
  const [status, setStatus] = useState(meeting.status);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const handleSave = async () => {
    setSaving(true); setErr('');
    try {
      await api(`/meetings/${meeting.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          type,
          date: new Date(date).toISOString(),
          comment: comment || undefined,
          extraPhone: extraPhone || undefined,
          status,
        }),
      });
      onSaved();
      onClose();
    } catch (e: any) { setErr(e.message || 'Ошибка сохранения'); }
    setSaving(false);
  };

  const handleCancel = async () => {
    if (!confirm('Отменить встречу?')) return;
    setSaving(true); setErr('');
    try {
      await api(`/meetings/${meeting.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'CANCELLED' }),
      });
      onSaved();
      onClose();
    } catch (e: any) { setErr(e.message || 'Ошибка отмены'); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={onClose}>
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-xl font-bold mb-1">Редактировать встречу</h2>
        <p className="text-text-muted text-sm mb-4">{meeting.client?.fullName} · {meeting.client?.phone}</p>

        {err && <div className="mb-3 p-3 bg-error/20 text-error rounded-lg text-sm">{err}</div>}

        <div className="space-y-4">
          <div>
            <label className="label">Тип визита</label>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(typeLabels).map(([key, label]) => (
                <label key={key} className={`cursor-pointer text-center py-2 px-3 rounded-lg border text-sm transition ${type === key ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:bg-surface-secondary'}`}>
                  <input type="radio" name="edit-type" value={key} checked={type === key} onChange={(e) => setType(e.target.value)} className="hidden" />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="label">Дата и время</label>
            <input type="datetime-local" className="input" value={date} onChange={(e) => setDate(e.target.value)} step="3600" />
          </div>

          <div>
            <label className="label">Доп. телефон</label>
            <input type="tel" className="input" placeholder="+79991234567" value={extraPhone} onChange={(e) => setExtraPhone(e.target.value)} />
          </div>

          <div>
            <label className="label">Комментарий</label>
            <textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>

          <div>
            <label className="label">Статус</label>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="PENDING">Ожидает</option>
              <option value="CONFIRMED">Подтверждена</option>
              <option value="COMPLETED">Завершена</option>
              <option value="CANCELLED">Отменена</option>
            </select>
          </div>

          <div className="flex gap-2 pt-2 border-t border-border">
            <button className="btn btn-primary flex items-center justify-center gap-2 flex-1" onClick={handleSave} disabled={saving}>
              <Check className="w-4 h-4" /> Сохранить
            </button>
            <button className="btn btn-secondary text-error" onClick={handleCancel} disabled={saving} title="Отменить встречу">
              <Ban className="w-4 h-4" /> Отменить встречу
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({
    clientId: '',
    type: 'OFFICE_VISIT',
    date: '',
    slotId: '',
    extraPhone: '',
    comment: '',
    notifySms: true,
    notifyEmail: true,
    notifyReminder: true,
  });
  const [useSlots, setUseSlots] = useState(true);
  const [slotDate, setSlotDate] = useState('');
  const [slots, setSlots] = useState<Array<{ id: string; startsAt: string; durationMin: number; available: number; capacity: number; type: string | null }>>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [editingMeeting, setEditingMeeting] = useState<any | null>(null);

  const fetchMeetings = () => {
    setLoading(true);
    apiGet(`/meetings?page=${page}&limit=15`)
      .then((data) => {
        setMeetings(data.meetings || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      })
      .catch(() => setMeetings([]))
      .finally(() => setLoading(false));
  };

  const fetchClients = () => {
    apiGet('/clients?page=1&limit=100')
      .then((data) => setClients(data.clients || []))
      .catch(() => setClients([]));
  };

  useEffect(() => { fetchMeetings(); }, [page]);
  useEffect(() => { fetchClients(); }, []);

  // 2026-06-18: пока форма создания встречи дорабатывается, показываем брокеру
  // телефон горячей линии для брокеров (из CMS-блока «contact»). Админ правит
  // блок через /admin/content → «Команда».
  // 2026-07-01: тут именно горячая линия отдела (contact.phone + blockTitle),
  // а не персональный номер менеджера — чтобы брокер понимал, что звонит на
  // общий телефон.
  const [hotline, setHotline] = useState<{ blockTitle?: string; phone?: string; phoneHours?: string }>({});
  useEffect(() => {
    apiGet('/public/cms/content/contact')
      .then((d: any) => {
        const v = d?.value || {};
        setHotline({
          blockTitle: v.blockTitle,
          phone: v.phone,
          phoneHours: v.phoneHours,
        });
      })
      .catch(() => {});
  }, []);

  // 2026-07-02: блок «Календарь из amoCRM» убран по просьбе Ксении.
  // Соответствующий useState/useEffect удалены.

  // Load slots whenever date or type changes (in slots mode)
  useEffect(() => {
    if (!useSlots || !slotDate) { setSlots([]); return; }
    setSlotsLoading(true);
    apiGet(`/meetings/slots/available?date=${slotDate}&type=${form.type}`)
      .then((d: any) => Array.isArray(d) ? setSlots(d) : setSlots([]))
      .catch(() => setSlots([]))
      .finally(() => setSlotsLoading(false));
  }, [useSlots, slotDate, form.type]);

  const resetForm = () => {
    setForm({ clientId: '', type: 'OFFICE_VISIT', date: '', slotId: '', extraPhone: '', comment: '', notifySms: true, notifyEmail: true, notifyReminder: true });
    setSlotDate('');
    setSlots([]);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setSubmitting(true);
    try {
      const payload: any = {
        clientId: form.clientId,
        type: form.type,
        comment: form.comment || undefined,
        extraPhone: form.extraPhone || undefined,
        notifySms: form.notifySms,
        notifyEmail: form.notifyEmail,
        notifyReminder: form.notifyReminder,
      };
      if (useSlots && form.slotId) {
        payload.slotId = form.slotId;
      } else if (!useSlots && form.date) {
        payload.date = new Date(form.date).toISOString();
      } else {
        throw new Error('Выберите слот или укажите дату');
      }
      await apiPost('/meetings', payload);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      resetForm();
      fetchMeetings();
    } catch (err: any) {
      setFormError(err.message || 'Ошибка при создании встречи');
    }
    setSubmitting(false);
  };

  const selectedClient = clients.find((c) => c.id === form.clientId);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Записаться на встречу</h1>
        <span className="text-text-muted text-sm">Запланировано: {total}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-6">
        {/* 2026-06-18: форма временно скрыта — показываем брокеру телефон
            менеджера по работе с брокерами для записи. Форма вернётся когда
            доработаем (см. project_pending_tasks). */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-3">Записаться на встречу</h2>
          {/* 2026-07-02: подпись «раздел дорабатывается» убрана + блок «Календарь из amoCRM» убран. */}
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
            <div className="text-xs text-text-muted mb-2">
              {hotline.blockTitle || 'Горячая линия по работе с партнёрами'}
            </div>
            {hotline.phone ? (
              <a
                href={`tel:${hotline.phone.replace(/[^\d+]/g, '')}`}
                className="inline-flex items-center gap-2 text-accent font-semibold text-lg hover:underline"
              >
                <Phone className="w-5 h-5" /> {hotline.phone}
              </a>
            ) : (
              <div className="text-sm text-text-muted">Телефон не задан — обратитесь в админ-панель CMS</div>
            )}
            {hotline.phoneHours && (
              <div className="text-xs text-text-muted mt-1">{hotline.phoneHours}</div>
            )}
          </div>
        </div>

        {/* Старая форма скрыта — оставляем заглушку для div'а который никогда не рендерится */}
        <div className="hidden">
          {success && (
            <div className="mb-4 p-3 bg-success/20 text-success rounded-lg text-sm flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Встреча создана, уведомления отправлены
            </div>
          )}
          {formError && <div className="mb-3 p-3 bg-error/20 text-error rounded-lg text-sm">{formError}</div>}

          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="label">Клиент *</label>
              <select
                className="input"
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                required
              >
                <option value="">Выберите клиента</option>
                {clients.filter(isUniquenessActive).map((c) => (
                  <option key={c.id} value={c.id}>{c.fullName} — {c.phone}</option>
                ))}
              </select>
              {clients.filter(isUniquenessActive).length === 0 && (
                <div className="text-xs text-text-muted mt-1">
                  {clients.length === 0
                    ? 'Сначала добавьте клиента в разделе "Клиенты"'
                    : 'Нет клиентов с активной уникальностью. Продлите уникальность в разделе "Клиенты".'}
                </div>
              )}
            </div>

            <div>
              <label className="label">Тип визита *</label>
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(typeLabels).map(([key, label]) => (
                  <label
                    key={key}
                    className={`cursor-pointer text-center py-2 px-3 rounded-lg border text-sm transition ${form.type === key ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:bg-surface-secondary'}`}
                  >
                    <input
                      type="radio"
                      name="type"
                      value={key}
                      checked={form.type === key}
                      onChange={(e) => setForm({ ...form, type: e.target.value })}
                      className="hidden"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="label mb-0">Дата и время *</label>
                <button
                  type="button"
                  className="text-xs text-accent hover:underline"
                  onClick={() => { setUseSlots(!useSlots); setForm({ ...form, slotId: '', date: '' }); }}
                >
                  {useSlots ? 'Указать вручную' : 'Выбрать из доступных слотов'}
                </button>
              </div>

              {useSlots ? (
                <>
                  <input
                    type="date"
                    className="input mb-3"
                    value={slotDate}
                    onChange={(e) => { setSlotDate(e.target.value); setForm({ ...form, slotId: '' }); }}
                    min={new Date().toISOString().slice(0, 10)}
                  />
                  {slotDate && (
                    <div>
                      {slotsLoading ? (
                        <div className="text-text-muted text-sm">Загрузка слотов…</div>
                      ) : slots.length === 0 ? (
                        <div className="text-sm text-text-muted">
                          На эту дату слоты ещё не подгрузились — укажите удобное время вручную.
                          {' '}
                          <button
                            type="button"
                            className="text-accent hover:underline font-medium"
                            onClick={() => { setUseSlots(false); setForm({ ...form, slotId: '', date: '' }); }}
                          >
                            Указать вручную
                          </button>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                          {slots.map((s) => {
                            const time = new Date(s.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
                            const disabled = s.available === 0;
                            const selected = form.slotId === s.id;
                            return (
                              <button
                                key={s.id}
                                type="button"
                                disabled={disabled}
                                onClick={() => setForm({ ...form, slotId: s.id })}
                                className={`py-2 px-2 rounded-lg border text-sm transition ${
                                  selected ? 'border-accent bg-accent/10 text-accent' :
                                  disabled ? 'border-border opacity-40 cursor-not-allowed' :
                                  'border-border hover:bg-surface-secondary'
                                }`}
                              >
                                <div className="font-medium">{time}</div>
                                <div className="text-[10px] text-text-muted">
                                  {disabled ? 'занято' : `${s.available}/${s.capacity}`}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <input
                  type="datetime-local"
                  className="input"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  min={new Date().toISOString().slice(0, 16)}
                  step="3600"
                  required={!useSlots}
                />
              )}
            </div>

            <div>
              <label className="label">Доп. телефон</label>
              <input
                type="tel"
                className="input"
                placeholder="+79991234567"
                value={form.extraPhone}
                onChange={(e) => setForm({ ...form, extraPhone: e.target.value })}
              />
              <div className="text-xs text-text-muted mt-1">
                {selectedClient ? `Основной телефон клиента: ${selectedClient.phone}` : 'Дополнительный контакт для связи'}
              </div>
            </div>

            <div>
              <label className="label">Комментарий</label>
              <textarea
                className="input"
                rows={3}
                placeholder="Дополнительная информация о встрече..."
                value={form.comment}
                onChange={(e) => setForm({ ...form, comment: e.target.value })}
              />
            </div>

            <div className="pt-2 border-t border-border">
              <div className="label">Уведомления</div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={form.notifySms}
                    onChange={(e) => setForm({ ...form, notifySms: e.target.checked })}
                  />
                  SMS брокеру
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={form.notifyEmail}
                    onChange={(e) => setForm({ ...form, notifyEmail: e.target.checked })}
                  />
                  Email брокеру
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={form.notifyReminder}
                    onChange={(e) => setForm({ ...form, notifyReminder: e.target.checked })}
                  />
                  Напоминание за 2 часа до встречи
                </label>
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={submitting || !form.clientId || (useSlots ? !form.slotId : !form.date)}
            >
              {submitting ? 'Создание...' : 'Запланировать встречу'}
            </button>
          </form>
        </div>

        {/* Meetings list */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Запланированные встречи</h2>

          {loading ? (
            <div className="text-center py-8 text-text-muted">Загрузка...</div>
          ) : meetings.length === 0 ? (
            <div className="text-center py-8 text-text-muted">
              <Calendar className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
              Встречи не запланированы
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {meetings.map((m: any) => (
                  <div key={m.id} className="flex items-start justify-between gap-3 py-3 border-b border-border last:border-0">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="w-12 h-12 bg-surface-secondary rounded-lg flex flex-col items-center justify-center text-xs flex-shrink-0">
                        <span className="font-bold">{new Date(m.date).toLocaleDateString('ru-RU', { day: '2-digit', timeZone: 'Europe/Moscow' })}</span>
                        <span className="text-text-muted">{new Date(m.date).toLocaleDateString('ru-RU', { month: 'short', timeZone: 'Europe/Moscow' })}</span>
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{m.client?.fullName}</div>
                        <div className="text-xs text-text-muted">
                          {typeLabels[m.type] || m.type} · {new Date(m.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}
                        </div>
                        {m.comment && <div className="text-xs text-text-muted mt-1 whitespace-pre-wrap break-words">{m.comment}</div>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span className={`text-xs px-2 py-1 rounded whitespace-nowrap ${statusLabels[m.status]?.cls || ''}`}>
                        {statusLabels[m.status]?.label || m.status}
                      </span>
                      {m.status !== 'CANCELLED' && m.status !== 'COMPLETED' && (
                        <button
                          className="text-xs text-accent hover:underline flex items-center gap-1"
                          onClick={() => setEditingMeeting(m)}
                        >
                          <Pencil className="w-3 h-3" /> Изменить
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                  <span className="text-sm text-text-muted">Стр. {page} из {totalPages}</span>
                  <div className="flex gap-2">
                    <button className="btn btn-secondary" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button className="btn btn-secondary" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {editingMeeting && (
        <EditMeetingModal
          meeting={editingMeeting}
          onClose={() => setEditingMeeting(null)}
          onSaved={fetchMeetings}
        />
      )}
    </div>
  );
}
