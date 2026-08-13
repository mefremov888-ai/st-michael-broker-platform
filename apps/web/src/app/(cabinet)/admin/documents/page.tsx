'use client';

import { useEffect, useRef, useState } from 'react';
import { api, apiGet, apiPost, apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { FileText, Upload, Link2, Plus, Trash2, Save, ExternalLink } from 'lucide-react';

type DocItem = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  category: string;
  subcategory: string | null;
  project: string | null;
  fileUrl: string;
  fileSize: number | null;
  isPublic: boolean;
  sortOrder: number;
  createdAt: string;
};

const CATEGORIES = [
  { value: 'cooperation', label: 'Сотрудничество (на лендинге)' },
  { value: 'analytics', label: 'Аналитика (на лендинге)' },
  { value: 'marketing', label: 'Маркетинг (реклама/планировки)' },
  { value: 'materials', label: 'Материалы (для брокеров)' },
];

function formatSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function AdminDocumentsPage() {
  const { broker } = useAuth();
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState('');

  // upload form
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadDraft, setUploadDraft] = useState({
    name: '', description: '', category: 'cooperation', subcategory: '', isPublic: true, sortOrder: 0,
  });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // external url form
  const [extDraft, setExtDraft] = useState({
    name: '', description: '', url: '', category: 'cooperation', subcategory: '', isPublic: true, sortOrder: 0,
  });
  const [extSaving, setExtSaving] = useState(false);

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = broker?.role === 'ADMIN';

  const load = () => {
    setLoading(true);
    const q = filter ? `?category=${filter}&limit=200` : '?limit=200';
    apiGet(`/admin/documents${q}`)
      .then((d) => setDocs(d.documents || []))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [filter]);

  const handleUpload = async () => {
    if (!uploadFile) return;
    setUploading(true); setMessage('');
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('category', uploadDraft.category);
      if (uploadDraft.name) fd.append('name', uploadDraft.name);
      if (uploadDraft.description) fd.append('description', uploadDraft.description);
      if (uploadDraft.subcategory) fd.append('subcategory', uploadDraft.subcategory);
      fd.append('isPublic', String(uploadDraft.isPublic));
      fd.append('sortOrder', String(uploadDraft.sortOrder));
      await apiUpload('/admin/documents/upload', fd);
      setUploadFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setUploadDraft({ ...uploadDraft, name: '', description: '', subcategory: '' });
      load();
      setMessage('Файл загружен');
      setTimeout(() => setMessage(''), 2000);
    } catch (e: any) { setMessage(e.message || 'Ошибка загрузки'); }
    setUploading(false);
  };

  const handleAddExternal = async () => {
    if (!extDraft.url || !extDraft.name) return;
    setExtSaving(true); setMessage('');
    try {
      await apiPost('/admin/documents/external', extDraft);
      setExtDraft({ ...extDraft, name: '', description: '', url: '', subcategory: '' });
      load();
      setMessage('Ссылка добавлена');
      setTimeout(() => setMessage(''), 2000);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
    setExtSaving(false);
  };

  const handleSave = async (d: DocItem) => {
    try {
      await api(`/admin/documents/${d.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: d.name, description: d.description, category: d.category,
          subcategory: d.subcategory, project: d.project || null, isPublic: d.isPublic, sortOrder: d.sortOrder,
        }),
      });
      setMessage('Сохранено'); setTimeout(() => setMessage(''), 1500);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить файл? Это удалит и физический файл с диска.')) return;
    try {
      await api(`/admin/documents/${id}`, { method: 'DELETE' });
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const updateLocal = (idx: number, patch: Partial<DocItem>) => {
    const next = [...docs];
    next[idx] = { ...next[idx], ...patch };
    setDocs(next);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <FileText className="w-7 h-7 text-accent" />Файлы и документы
          </h1>
          <span className="text-text-muted text-sm">Загрузка файлов на сервер + внешние ссылки</span>
        </div>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      {isAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Upload file */}
          <div className="card">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Upload className="w-5 h-5" /> Загрузить файл
            </h2>
            <div className="space-y-3">
              <div>
                <label className="label">Файл (до 200 MB)</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="input"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                />
                {uploadFile && <div className="text-xs text-text-muted mt-1">{uploadFile.name} · {formatSize(uploadFile.size)}</div>}
              </div>
              <div>
                <label className="label">Название (если пусто — взять из имени файла)</label>
                <input className="input" value={uploadDraft.name} onChange={(e) => setUploadDraft({ ...uploadDraft, name: e.target.value })} />
              </div>
              <div>
                <label className="label">Описание (опционально)</label>
                <input className="input" value={uploadDraft.description} onChange={(e) => setUploadDraft({ ...uploadDraft, description: e.target.value })} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Категория</label>
                  <select className="input" value={uploadDraft.category} onChange={(e) => setUploadDraft({ ...uploadDraft, category: e.target.value })}>
                    {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Подкатегория (для группировки)</label>
                  <input className="input" placeholder="Напр. Презентации" value={uploadDraft.subcategory} onChange={(e) => setUploadDraft({ ...uploadDraft, subcategory: e.target.value })} />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={uploadDraft.isPublic} onChange={(e) => setUploadDraft({ ...uploadDraft, isPublic: e.target.checked })} />
                  Публично (видно на лендинге)
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-muted">Порядок:</span>
                  <input type="number" className="input w-20" value={uploadDraft.sortOrder} onChange={(e) => setUploadDraft({ ...uploadDraft, sortOrder: Number(e.target.value) })} />
                </div>
              </div>
              <button className="btn btn-primary flex items-center gap-2" onClick={handleUpload} disabled={uploading || !uploadFile}>
                <Upload className="w-4 h-4" /> {uploading ? 'Загрузка...' : 'Загрузить'}
              </button>
            </div>
          </div>

          {/* External URL */}
          <div className="card">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Link2 className="w-5 h-5" /> Добавить внешнюю ссылку
            </h2>
            <div className="space-y-3">
              <div>
                <label className="label">URL (например, ссылка на YouTube, Google Drive)</label>
                <input className="input" placeholder="https://..." value={extDraft.url} onChange={(e) => setExtDraft({ ...extDraft, url: e.target.value })} />
              </div>
              <div>
                <label className="label">Название</label>
                <input className="input" value={extDraft.name} onChange={(e) => setExtDraft({ ...extDraft, name: e.target.value })} />
              </div>
              <div>
                <label className="label">Описание (опционально)</label>
                <input className="input" value={extDraft.description} onChange={(e) => setExtDraft({ ...extDraft, description: e.target.value })} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Категория</label>
                  <select className="input" value={extDraft.category} onChange={(e) => setExtDraft({ ...extDraft, category: e.target.value })}>
                    {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Подкатегория</label>
                  <input className="input" value={extDraft.subcategory} onChange={(e) => setExtDraft({ ...extDraft, subcategory: e.target.value })} />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={extDraft.isPublic} onChange={(e) => setExtDraft({ ...extDraft, isPublic: e.target.checked })} />
                  Публично
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-muted">Порядок:</span>
                  <input type="number" className="input w-20" value={extDraft.sortOrder} onChange={(e) => setExtDraft({ ...extDraft, sortOrder: Number(e.target.value) })} />
                </div>
              </div>
              <button className="btn btn-primary flex items-center gap-2" onClick={handleAddExternal} disabled={extSaving || !extDraft.url || !extDraft.name}>
                <Plus className="w-4 h-4" /> {extSaving ? 'Сохранение...' : 'Добавить'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card mb-4">
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-muted">Фильтр:</span>
          <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Все категории</option>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <span className="text-sm text-text-muted ml-auto">Всего: {docs.length}</span>
        </div>
      </div>

      <div className="space-y-2">
        {loading ? (
          <div className="text-center py-8 text-text-muted card">Загрузка...</div>
        ) : docs.length === 0 ? (
          <div className="card text-center py-8 text-text-muted">
            <FileText className="w-10 h-10 mx-auto mb-2 text-text-muted/50" />
            Документы не найдены
          </div>
        ) : (
          docs.map((d, idx) => (
            <div key={d.id} className="card">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center mb-2">
                <input className="input md:col-span-3" value={d.name} onChange={(e) => updateLocal(idx, { name: e.target.value })} disabled={!isAdmin} />
                <input className="input md:col-span-3 text-sm" placeholder="Описание" value={d.description || ''} onChange={(e) => updateLocal(idx, { description: e.target.value })} disabled={!isAdmin} />
                <select className="input md:col-span-2 text-sm" value={d.category} onChange={(e) => updateLocal(idx, { category: e.target.value })} disabled={!isAdmin}>
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.value}</option>)}
                </select>
                <input className="input md:col-span-1 text-sm" placeholder="Подкат." value={d.subcategory || ''} onChange={(e) => updateLocal(idx, { subcategory: e.target.value })} disabled={!isAdmin} />
                <select className="input md:col-span-2 text-sm" value={d.project || ''} onChange={(e) => updateLocal(idx, { project: e.target.value || null })} disabled={!isAdmin} title="Проект">
                  <option value="">— Проект —</option>
                  <option value="ZORGE9">Зорге 9</option>
                  <option value="SILVER_BOR">Серебряный Бор</option>
                </select>
                <input className="input md:col-span-1 text-sm" type="number" value={d.sortOrder} onChange={(e) => updateLocal(idx, { sortOrder: Number(e.target.value) })} disabled={!isAdmin} title="Порядок" />
                <label className="flex items-center gap-1 text-xs md:col-span-1">
                  <input type="checkbox" checked={d.isPublic} onChange={(e) => updateLocal(idx, { isPublic: e.target.checked })} disabled={!isAdmin} />
                  Public
                </label>
              </div>
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span className="px-2 py-0.5 rounded bg-surface-secondary">{d.type}</span>
                <span>{formatSize(d.fileSize)}</span>
                <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-accent hover:underline">
                  <ExternalLink className="w-3 h-3" /> Открыть
                </a>
                <span className="text-text-muted/60 truncate">{d.fileUrl}</span>
                {isAdmin && (
                  <div className="ml-auto flex gap-1">
                    <button onClick={() => handleSave(d)} className="btn btn-primary text-xs"><Save className="w-3 h-3" /></button>
                    <button onClick={() => handleDelete(d.id)} className="btn btn-secondary text-error text-xs"><Trash2 className="w-3 h-3" /></button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
