'use client';

import { useEffect, useRef, useState } from 'react';
import { api, apiGet, apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Megaphone, Plus, Trash2, Save, Eye, EyeOff, Pencil, X, Upload } from 'lucide-react';

interface Promo {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  tag: string | null;
  imageUrl: string | null;
  imagePosition: string | null;
  ctaText: string | null;
  ctaHref: string | null;
  project: 'ZORGE9' | 'SILVER_BOR' | null;
  sortOrder: number;
  isActive: boolean;
  expiresAt: string | null;
}

const EMPTY_DRAFT: Partial<Promo> = {
  title: '', subtitle: '', description: '', tag: '',
  imageUrl: '', imagePosition: 'center', ctaText: '', ctaHref: '',
  project: null, sortOrder: 0, isActive: true, expiresAt: null,
};

// 3×3 grid: row=top/center/bottom, col=left/center/right
const POS_GRID = [
  ['top left',    'top center',    'top right'],
  ['center left', 'center',        'center right'],
  ['bottom left', 'bottom center', 'bottom right'],
];

function PositionPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const pos = value || 'center';
  return (
    <div>
      <div className="label mb-1">Фокус картинки</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 32px)', gap: 4 }}>
        {POS_GRID.flat().map((p) => {
          const active = pos === p;
          return (
            <button
              key={p}
              type="button"
              title={p}
              onClick={() => onChange(p)}
              style={{
                width: 32, height: 32, borderRadius: 6, cursor: 'pointer',
                border: `2px solid ${active ? '#B4936F' : 'transparent'}`,
                background: active ? 'rgba(180,147,111,0.15)' : 'rgba(0,0,0,0.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
            >
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: active ? '#B4936F' : '#aaa',
              }} />
            </button>
          );
        })}
      </div>
      <div className="text-xs text-text-muted mt-1">{pos}</div>
    </div>
  );
}

function SlidePreview({ value }: { value: Partial<Promo> }) {
  const pos = value.imagePosition || 'center';
  const hasContent = value.title || value.tag;
  return (
    <div style={{ position: 'sticky', top: 24 }}>
      <div className="label mb-2">Превью слайда</div>
      <div style={{
        position: 'relative', width: '100%', aspectRatio: '16 / 7',
        borderRadius: 12, overflow: 'hidden', background: '#1a1a1a',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      }}>
        {/* Background image */}
        {value.imageUrl ? (
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `linear-gradient(95deg, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.48) 55%, rgba(0,0,0,0.1) 100%), url(${value.imageUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: pos,
            transition: 'background-position 0.3s ease',
          }} />
        ) : (
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, #2c2c2a 0%, #1a1a1a 100%)' }} />
        )}

        {/* Content overlay */}
        <div style={{ position: 'absolute', inset: 0, padding: '20px 28px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          {value.tag && (
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '2.5px', textTransform: 'uppercase',
              color: '#B4936F', marginBottom: 10, padding: '4px 10px',
              border: '1px solid rgba(180,147,111,0.6)', borderRadius: 6,
              background: 'rgba(0,0,0,0.25)', backdropFilter: 'blur(8px)',
            }}>
              {value.tag}
            </div>
          )}
          {value.title && (
            <div style={{ fontSize: 'clamp(15px, 2.2vw, 26px)', fontWeight: 300, color: '#fff', lineHeight: 1.1, marginBottom: 7, letterSpacing: '-0.3px' }}>
              {value.title}
            </div>
          )}
          {value.subtitle && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', marginBottom: 4, lineHeight: 1.45 }}>
              {value.subtitle}
            </div>
          )}
          {value.description && (
            <div style={{
              fontSize: 10, color: 'rgba(255,255,255,0.65)', lineHeight: 1.5,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            } as React.CSSProperties}>
              {value.description}
            </div>
          )}
          {value.ctaText && (
            <div style={{
              marginTop: 12, padding: '7px 14px', background: '#B4936F', color: '#fff',
              fontSize: 9, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', borderRadius: 6,
            }}>
              {value.ctaText}
            </div>
          )}
          {!hasContent && (
            <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: 12, margin: 'auto', textAlign: 'center', width: '100%' }}>
              Заполните поля — превью обновится
            </div>
          )}
        </div>
        <div style={{ position: 'absolute', bottom: 6, right: 10, fontSize: 8, color: 'rgba(255,255,255,0.25)', fontWeight: 700, letterSpacing: 1 }}>
          PREVIEW
        </div>
      </div>

      {/* Position visualizer */}
      {value.imageUrl && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(180,147,111,0.08)', borderRadius: 8, border: '1px solid rgba(180,147,111,0.2)' }}>
          <div className="text-xs text-text-muted mb-2">Позиция картинки: <strong style={{ color: '#B4936F' }}>{pos}</strong></div>
          {/* Mini image with crosshair showing position */}
          <div style={{ position: 'relative', height: 60, borderRadius: 6, overflow: 'hidden' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: pos, display: 'block' }} />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.2)' }}>
              <div style={{ width: 12, height: 12, border: '2px solid #B4936F', borderRadius: '50%', background: 'rgba(180,147,111,0.5)' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminPromosPage() {
  const { broker } = useAuth();
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Partial<Promo>>({ ...EMPTY_DRAFT });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<Promo>>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = broker?.role === 'ADMIN';

  const load = () => {
    setLoading(true);
    apiGet('/admin/cms/promos')
      .then((d: any) => setPromos(Array.isArray(d) ? d : []))
      .catch(() => setPromos([]))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const create = async () => {
    if (!draft.title?.trim()) return setMessage('Заголовок обязателен');
    setCreating(true); setMessage('');
    try {
      await api('/admin/cms/promos', { method: 'POST', body: JSON.stringify(draft) });
      setDraft({ ...EMPTY_DRAFT });
      load();
      setMessage('Создано');
      setTimeout(() => setMessage(''), 2000);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
    setCreating(false);
  };

  const update = async (id: string, patch: Partial<Promo>) => {
    try {
      await api(`/admin/cms/promos/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      load(); setMessage('Сохранено'); setTimeout(() => setMessage(''), 1500);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const remove = async (id: string) => {
    if (!confirm('Удалить акцию? Это необратимо.')) return;
    try { await api(`/admin/cms/promos/${id}`, { method: 'DELETE' }); load(); }
    catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const startEdit = (p: Promo) => { setEditingId(p.id); setEditDraft({ ...p }); };
  const cancelEdit = () => { setEditingId(null); setEditDraft({}); };
  const saveEdit = async () => {
    if (!editingId || !editDraft.title?.trim()) return setMessage('Заголовок обязателен');
    setSaving(true);
    await update(editingId, editDraft);
    setSaving(false); setEditingId(null); setEditDraft({});
  };

  const uploadImg = async (file: File, onChange: (patch: Partial<Promo>) => void) => {
    setUploading(true); setMessage('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('category', 'marketing');
      fd.append('name', file.name.replace(/\.[^.]+$/, ''));
      const doc: any = await apiUpload('/admin/documents/upload', fd);
      onChange({ imageUrl: doc.fileUrl });
      setMessage('Фото загружено');
      setTimeout(() => setMessage(''), 2000);
    } catch (e: any) { setMessage(e.message || 'Ошибка загрузки'); }
    setUploading(false);
  };

  const renderForm = (
    value: Partial<Promo>,
    onChange: (patch: Partial<Promo>) => void,
    inputRef: React.RefObject<HTMLInputElement | null>,
  ) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24, alignItems: 'start' }}>
      {/* LEFT: fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <label className="label">Заголовок *</label>
          <input className="input" placeholder="Старт продаж" value={value.title || ''} onChange={(e) => onChange({ title: e.target.value })} />
        </div>
        <div>
          <label className="label">Подзаголовок</label>
          <input className="input" placeholder="Приоритетный проект Зорге 9" value={value.subtitle || ''} onChange={(e) => onChange({ subtitle: e.target.value })} />
        </div>
        <div>
          <label className="label">Тег (золотой сверху)</label>
          <input className="input" placeholder="СПЕЦИАЛЬНЫЕ УСЛОВИЯ" value={value.tag || ''} onChange={(e) => onChange({ tag: e.target.value })} />
        </div>
        <div className="md:col-span-2">
          <label className="label">Описание</label>
          <textarea className="input" rows={2} placeholder="Краткое описание акции..." value={value.description || ''} onChange={(e) => onChange({ description: e.target.value })} />
        </div>
        <div>
          <label className="label">Текст кнопки</label>
          <input className="input" placeholder="Подробнее" value={value.ctaText || ''} onChange={(e) => onChange({ ctaText: e.target.value })} />
        </div>
        <div>
          <label className="label">Ссылка кнопки</label>
          <input className="input" placeholder="#projects или https://..." value={value.ctaHref || ''} onChange={(e) => onChange({ ctaHref: e.target.value })} />
        </div>
        <div className="md:col-span-2">
          <label className="label">Картинка (URL или загрузить)</label>
          <div className="flex gap-2 items-center">
            <input
              className="input flex-1"
              placeholder="/files/marketing/xxx.jpg или https://..."
              value={value.imageUrl || ''}
              onChange={(e) => onChange({ imageUrl: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-secondary flex items-center gap-1 whitespace-nowrap"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="w-3 h-3" /> {uploading ? 'Загрузка...' : 'Загрузить'}
            </button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImg(f, onChange); if (inputRef.current) inputRef.current.value = ''; }}
          />
        </div>
        <div className="flex items-end gap-6">
          <PositionPicker value={value.imagePosition || 'center'} onChange={(v) => onChange({ imagePosition: v })} />
        </div>
        <div className="grid grid-cols-1 gap-3">
          <div>
            <label className="label">Проект</label>
            <select className="input" value={value.project || ''} onChange={(e) => onChange({ project: (e.target.value || null) as any })}>
              <option value="">Без привязки</option>
              <option value="ZORGE9">Зорге 9</option>
              <option value="SILVER_BOR">Серебряный Бор</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Действует до</label>
              <input className="input" type="date" value={(value.expiresAt || '').slice(0, 10)} onChange={(e) => onChange({ expiresAt: e.target.value || null })} />
            </div>
            <div>
              <label className="label">Порядок</label>
              <input className="input" type="number" value={value.sortOrder ?? 0} onChange={(e) => onChange({ sortOrder: Number(e.target.value) || 0 })} />
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: live preview */}
      <SlidePreview value={value} />
    </div>
  );

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6 flex items-center gap-2">
        <Megaphone className="w-7 h-7 text-accent" /> Слайдер акций — герой
      </h1>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      {/* Create new */}
      <div className="card mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2"><Plus className="w-5 h-5" /> Новый слайд</h2>
        {renderForm(draft, (patch) => setDraft({ ...draft, ...patch }), fileInputRef)}
        <div className="mt-4">
          <button className="btn btn-primary" onClick={create} disabled={creating || !isAdmin || !draft.title?.trim()}>
            {creating ? 'Создание...' : 'Создать слайд'}
          </button>
          {!isAdmin && <span className="ml-3 text-xs text-text-muted">Только админ может создавать</span>}
        </div>
      </div>

      {/* List */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-3">Все слайды ({promos.length})</h2>
        {loading ? (
          <div className="text-text-muted">Загрузка…</div>
        ) : promos.length === 0 ? (
          <div className="text-text-muted text-center py-8">
            <Megaphone className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            Слайдов пока нет. Создай первый через форму выше.
          </div>
        ) : (
          <div className="space-y-3">
            {promos.map((p) => (
              <div key={p.id} className={`border rounded-lg p-4 ${p.isActive ? 'border-border' : 'border-border opacity-50 bg-surface-secondary'}`}>
                {editingId === p.id ? (
                  <div>
                    {renderForm(editDraft, (patch) => setEditDraft({ ...editDraft, ...patch }), editFileInputRef)}
                    <div className="mt-4 flex gap-2">
                      <button className="btn btn-primary" onClick={saveEdit} disabled={saving || !editDraft.title?.trim()}>
                        <Save className="w-4 h-4 mr-1 inline" /> {saving ? 'Сохранение...' : 'Сохранить'}
                      </button>
                      <button className="btn btn-secondary" onClick={cancelEdit} disabled={saving}>
                        <X className="w-4 h-4 mr-1 inline" /> Отмена
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-4">
                    {p.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.imageUrl}
                        alt={p.title}
                        style={{ width: 80, height: 50, objectFit: 'cover', objectPosition: p.imagePosition || 'center', borderRadius: 6, flexShrink: 0 }}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      {p.tag && <div className="text-[10px] font-bold tracking-widest uppercase text-accent mb-1">{p.tag}</div>}
                      <div className="font-semibold text-base mb-1">{p.title}</div>
                      {p.subtitle && <div className="text-sm text-text-muted mb-1">{p.subtitle}</div>}
                      {p.description && <div className="text-xs text-text-muted line-clamp-2">{p.description}</div>}
                      <div className="flex flex-wrap gap-2 mt-2 text-xs text-text-muted">
                        {p.project && <span className="px-2 py-0.5 bg-surface-secondary rounded">{p.project === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}</span>}
                        {p.ctaText && <span className="px-2 py-0.5 bg-surface-secondary rounded">CTA: {p.ctaText}</span>}
                        {p.imagePosition && p.imagePosition !== 'center' && <span className="px-2 py-0.5 bg-surface-secondary rounded">📍 {p.imagePosition}</span>}
                        {p.expiresAt && <span className="px-2 py-0.5 bg-warning/20 text-warning rounded">До {new Date(p.expiresAt).toLocaleDateString('ru-RU')}</span>}
                        <span className="px-2 py-0.5 bg-surface-secondary rounded">#{p.sortOrder}</span>
                      </div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <button className="btn btn-secondary p-2" title="Редактировать" onClick={() => startEdit(p)} disabled={!isAdmin}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button className="btn btn-secondary p-2" title={p.isActive ? 'Скрыть' : 'Показать'} onClick={() => update(p.id, { isActive: !p.isActive })}>
                        {p.isActive ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>
                      <button className="btn btn-secondary text-error p-2" title="Удалить" onClick={() => remove(p.id)} disabled={!isAdmin}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
