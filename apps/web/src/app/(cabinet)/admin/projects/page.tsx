'use client';

import { useEffect, useState } from 'react';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Building, Plus, Trash2, Save } from 'lucide-react';

type ProjectItem = {
  id: string;
  slug: string;
  tag: string | null;
  name: string;
  subtitle: string | null;
  description: string;
  ctaText: string | null;
  ctaHref: string | null;
  classType: string | null;
  address: string | null;
  district: string | null;
  totalUnits: number | null;
  floorsTotal: number | null;
  readyQuarter: number | null;
  readyYear: number | null;
  sortOrder: number;
  isActive: boolean;
};

export default function AdminProjectsPage() {
  const { broker } = useAuth();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    slug: '', tag: '', name: '', subtitle: '', description: '',
    ctaText: 'Смотреть каталог', ctaHref: '', sortOrder: 0,
  });

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = broker?.role === 'ADMIN';

  const load = () => {
    setLoading(true);
    apiGet('/admin/cms/projects')
      .then((d) => setProjects(d || []))
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleCreate = async () => {
    if (!draft.slug || !draft.name || !draft.description) return;
    setCreating(true); setMessage('');
    try {
      await api('/admin/cms/projects', { method: 'POST', body: JSON.stringify(draft) });
      setDraft({ slug: '', tag: '', name: '', subtitle: '', description: '', ctaText: 'Смотреть каталог', ctaHref: '', sortOrder: 0 });
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
    setCreating(false);
  };

  const handleSave = async (p: ProjectItem) => {
    setMessage('');
    try {
      await api(`/admin/cms/projects/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          slug: p.slug, tag: p.tag, name: p.name, subtitle: p.subtitle,
          description: p.description, ctaText: p.ctaText, ctaHref: p.ctaHref,
          classType: p.classType, address: p.address, district: p.district,
          totalUnits: p.totalUnits === null || p.totalUnits === ('' as any) ? null : Number(p.totalUnits),
          floorsTotal: p.floorsTotal === null || p.floorsTotal === ('' as any) ? null : Number(p.floorsTotal),
          readyQuarter: p.readyQuarter === null || p.readyQuarter === ('' as any) ? null : Number(p.readyQuarter),
          readyYear: p.readyYear === null || p.readyYear === ('' as any) ? null : Number(p.readyYear),
          sortOrder: p.sortOrder, isActive: p.isActive,
        }),
      });
      setMessage('Сохранено');
      setTimeout(() => setMessage(''), 1500);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить проект из лендинга?')) return;
    try {
      await api(`/admin/cms/projects/${id}`, { method: 'DELETE' });
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка удаления'); }
  };

  const updateLocal = (idx: number, patch: Partial<ProjectItem>) => {
    const next = [...projects];
    next[idx] = { ...next[idx], ...patch };
    setProjects(next);
  };

  return (
    <div data-tour={'cms-projects-page'}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <Building className="w-7 h-7 text-accent" />Проекты на лендинге
          </h1>
          <span className="text-text-muted text-sm">Карточки проектов в блоке "Проекты"</span>
        </div>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      {isAdmin && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-3">Добавить проект</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="label">Slug (латиницей, уникальный)</label>
              <input className="input" placeholder="zorge9" value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
            </div>
            <div>
              <label className="label">Тег (надзаголовок)</label>
              <input className="input" placeholder="Приоритетный проект" value={draft.tag} onChange={(e) => setDraft({ ...draft, tag: e.target.value })} />
            </div>
            <div>
              <label className="label">Название (жирная часть)</label>
              <input className="input" placeholder="Зорге" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <label className="label">Подпись после названия</label>
              <input className="input" placeholder="9" value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <label className="label">Описание</label>
              <textarea className="input" rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            <div>
              <label className="label">Текст ссылки</label>
              <input className="input" value={draft.ctaText} onChange={(e) => setDraft({ ...draft, ctaText: e.target.value })} />
            </div>
            <div>
              <label className="label">URL (необязательно — иначе откроется кабинет)</label>
              <input className="input" placeholder="https://..." value={draft.ctaHref} onChange={(e) => setDraft({ ...draft, ctaHref: e.target.value })} />
            </div>
            <div>
              <label className="label">Порядок сортировки</label>
              <input className="input" type="number" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })} />
            </div>
          </div>
          <button className="btn btn-primary flex items-center gap-2" onClick={handleCreate} disabled={creating || !draft.slug || !draft.name || !draft.description}>
            <Plus className="w-4 h-4" /> {creating ? 'Создание...' : 'Создать'}
          </button>
        </div>
      )}

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Все проекты ({projects.length})</h2>
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : projects.length === 0 ? (
          <div className="card text-text-muted text-center py-6">Нет проектов</div>
        ) : (
          projects.map((p, idx) => (
            <div key={p.id} className="card">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <FieldText label="Slug" value={p.slug} onChange={(v) => updateLocal(idx, { slug: v })} disabled={!isAdmin} />
                <FieldText label="Тег" value={p.tag || ''} onChange={(v) => updateLocal(idx, { tag: v })} disabled={!isAdmin} />
                <FieldText label="Название (жирное)" value={p.name} onChange={(v) => updateLocal(idx, { name: v })} disabled={!isAdmin} />
                <FieldText label="Подпись" value={p.subtitle || ''} onChange={(v) => updateLocal(idx, { subtitle: v })} disabled={!isAdmin} />
                <div className="md:col-span-2">
                  <label className="label">Описание</label>
                  <textarea className="input" rows={2} value={p.description} onChange={(e) => updateLocal(idx, { description: e.target.value })} disabled={!isAdmin} />
                </div>
                <FieldText label="Текст ссылки" value={p.ctaText || ''} onChange={(v) => updateLocal(idx, { ctaText: v })} disabled={!isAdmin} />
                <FieldText label="URL (опционально)" value={p.ctaHref || ''} onChange={(v) => updateLocal(idx, { ctaHref: v })} disabled={!isAdmin} />
              </div>

              <div className="border-t border-border pt-3 mt-3 mb-3">
                <h4 className="text-xs font-semibold text-text-muted uppercase mb-2">Карточка проекта на лендинге</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  <FieldText label="Класс (бизнес/премиум…)" value={p.classType || ''} onChange={(v) => updateLocal(idx, { classType: v })} disabled={!isAdmin} />
                  <FieldText label="Адрес" value={p.address || ''} onChange={(v) => updateLocal(idx, { address: v })} disabled={!isAdmin} />
                  <FieldText label="Район" value={p.district || ''} onChange={(v) => updateLocal(idx, { district: v })} disabled={!isAdmin} />
                  <div>
                    <label className="label">Этажей всего</label>
                    <input className="input" type="number" min={1} value={p.floorsTotal ?? ''} onChange={(e) => updateLocal(idx, { floorsTotal: e.target.value === '' ? null : Number(e.target.value) })} disabled={!isAdmin} />
                  </div>
                  <div>
                    <label className="label">Лотов всего</label>
                    <input className="input" type="number" min={1} value={p.totalUnits ?? ''} onChange={(e) => updateLocal(idx, { totalUnits: e.target.value === '' ? null : Number(e.target.value) })} disabled={!isAdmin} />
                  </div>
                  <div>
                    <label className="label">Сдача — квартал (1-4)</label>
                    <input className="input" type="number" min={1} max={4} value={p.readyQuarter ?? ''} onChange={(e) => updateLocal(idx, { readyQuarter: e.target.value === '' ? null : Number(e.target.value) })} disabled={!isAdmin} />
                  </div>
                  <div>
                    <label className="label">Сдача — год</label>
                    <input className="input" type="number" min={2025} max={2099} value={p.readyYear ?? ''} onChange={(e) => updateLocal(idx, { readyYear: e.target.value === '' ? null : Number(e.target.value) })} disabled={!isAdmin} />
                  </div>
                  <div>
                    <label className="label">Порядок</label>
                    <input className="input" type="number" value={p.sortOrder} onChange={(e) => updateLocal(idx, { sortOrder: Number(e.target.value) })} disabled={!isAdmin} />
                  </div>
                  <label className="flex items-center gap-2 self-end pb-3">
                    <input type="checkbox" checked={p.isActive} onChange={(e) => updateLocal(idx, { isActive: e.target.checked })} disabled={!isAdmin} />
                    Активен
                  </label>
                </div>
                <p className="text-[10px] text-text-muted mt-2">
                  Эти поля показываются в карточке проекта на лендинге (под названием).
                  Комиссия подставляется автоматически из раздела{' '}
                  <a className="text-accent hover:underline" href="/admin/commission-policies">«Комиссия и рассрочка»</a>.
                </p>
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <button className="btn btn-primary flex items-center gap-2" onClick={() => handleSave(p)}>
                    <Save className="w-4 h-4" /> Сохранить
                  </button>
                  <button className="btn btn-secondary text-error flex items-center gap-2 ml-auto" onClick={() => handleDelete(p.id)}>
                    <Trash2 className="w-4 h-4" /> Удалить
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function FieldText({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
    </div>
  );
}
