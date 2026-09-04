'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiGet, apiPost, apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  FileText, Upload, Link2, Plus, Trash2, Save, ExternalLink,
  Search, Cloud, HardDrive, Globe, Lock, Pencil, X, RefreshCw, ChevronDown,
} from 'lucide-react';
import { MaterialsFoldersAdmin } from './MaterialsFoldersAdmin';

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

// Публичная шара Я.Диска, откуда ночной синк тянет материалы.
const YANDEX_DISK_SHARE = 'https://disk.yandex.ru/d/8_w-xQ8PR3uz3w';

const GROUPS: { category: string; title: string; hint: string }[] = [
  {
    category: 'materials',
    title: 'Материалы для брокеров',
    hint: 'Секция «Материалы» на лендинге и «Материалы для работы» в кабинете. Большинство файлов приезжает с Яндекс.Диска автоматически каждую ночь — менять их нужно там, а не здесь.',
  },
  {
    category: 'cooperation',
    title: 'Сотрудничество',
    hint: 'Кнопка «Условия вознаграждения» на главной открывает файл с бейджем «⭐ Кнопка на главной» — назначается кнопкой «⭐ На кнопку главной» у любого файла этого раздела. Остальные файлы показываются в «Документах» кабинета.',
  },
  {
    category: 'analytics',
    title: 'Аналитика',
    hint: 'Секция «Аналитика» на лендинге. Она появляется на сайте только если здесь есть хотя бы один публичный файл.',
  },
  {
    category: 'marketing',
    title: 'Маркетинг (устаревшее)',
    hint: 'Эта категория больше нигде не показывается — ни на лендинге, ни в кабинете.',
  },
];

type Origin =
  | { kind: 'yandex'; path: string }
  | { kind: 'seed' }
  | { kind: 'external' }
  | { kind: 'manual' };

function getOrigin(d: DocItem): Origin {
  const desc = d.description || '';
  const m = desc.match(/^\[(?:yandex-local|yandex-disk):([^\]]*)\]/);
  if (m) return { kind: 'yandex', path: m[1] };
  if (desc.startsWith('[seed:')) return { kind: 'seed' };
  if (d.type === 'URL') return { kind: 'external' };
  return { kind: 'manual' };
}

function cleanDescription(desc: string | null): string {
  if (!desc) return '';
  return desc.replace(/^\[[^\]]*\]\s*/, '');
}

// Маркер «этот файл открывает кнопка "Условия вознаграждения" на главной».
// Лендинг ищет его в description (LandingClient), назначается кнопкой ниже.
const REWARDS_MARKER = '[landing-rewards-button]';
const isRewardsDoc = (d: DocItem) => (d.description || '').includes(REWARDS_MARKER);

function whereShown(d: DocItem): string {
  if (d.category === 'marketing') return 'Нигде не показывается';
  if (d.category === 'cooperation') {
    return d.isPublic
      ? 'Лендинг (блок «Сотрудничество») + кабинет («Документы»)'
      : 'Только кабинет («Документы»)';
  }
  if (d.category === 'analytics') {
    return d.isPublic ? 'Лендинг (секция «Аналитика»)' : 'Скрыт (не публичный)';
  }
  const folder = d.subcategory ? `папка «${d.subcategory}»` : 'без папки';
  return d.isPublic
    ? `Лендинг + кабинет, «Материалы» → ${folder}`
    : `Только кабинет, «Материалы» → ${folder}`;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function OriginBadge({ origin }: { origin: Origin }) {
  if (origin.kind === 'yandex') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-warning/15 text-warning text-xs whitespace-nowrap" title={`Приезжает с Яндекс.Диска: ${origin.path}`}>
        <Cloud className="w-3 h-3" /> Яндекс.Диск (авто)
      </span>
    );
  }
  if (origin.kind === 'external') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-info/15 text-info text-xs whitespace-nowrap">
        <Globe className="w-3 h-3" /> Внешняя ссылка
      </span>
    );
  }
  if (origin.kind === 'seed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-secondary text-text-muted text-xs whitespace-nowrap" title="Системный файл, залит при настройке">
        <Lock className="w-3 h-3" /> Системный
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-success/15 text-success text-xs whitespace-nowrap">
      <HardDrive className="w-3 h-3" /> Загружен вручную
    </span>
  );
}

export default function AdminDocumentsPage() {
  const { broker } = useAuth();
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForms, setShowAddForms] = useState(false);
  const [showFolders, setShowFolders] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [replaceTarget, setReplaceTarget] = useState<DocItem | null>(null);
  const [replacing, setReplacing] = useState(false);

  // upload form
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadDraft, setUploadDraft] = useState({
    name: '', description: '', category: 'cooperation', subcategory: '', project: '', isPublic: true, sortOrder: 0,
  });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // external url form
  const [extDraft, setExtDraft] = useState({
    name: '', description: '', url: '', category: 'cooperation', subcategory: '', project: '', isPublic: true, sortOrder: 0,
  });
  const [extSaving, setExtSaving] = useState(false);

  const allowed = !broker || broker.role === 'ADMIN' || broker.role === 'MANAGER';
  const isAdmin = broker?.role === 'ADMIN';

  const load = () => {
    if (!allowed) return;
    setLoading(true);
    const q = filter ? `?category=${filter}&limit=200` : '?limit=200';
    apiGet(`/admin/documents${q}`)
      .then((d) => setDocs(d.documents || []))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [filter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) =>
      d.name.toLowerCase().includes(q) ||
      (d.subcategory || '').toLowerCase().includes(q) ||
      cleanDescription(d.description).toLowerCase().includes(q),
    );
  }, [docs, search]);

  const grouped = useMemo(() => {
    return GROUPS
      .map((g) => ({ ...g, items: filtered.filter((d) => d.category === g.category) }))
      .filter((g) => g.items.length > 0 || (!search && (!filter || filter === g.category)));
  }, [filtered, search, filter]);

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
      if (uploadDraft.project) fd.append('project', uploadDraft.project);
      fd.append('isPublic', String(uploadDraft.isPublic));
      fd.append('sortOrder', String(uploadDraft.sortOrder));
      await apiUpload('/admin/documents/upload', fd);
      setUploadFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setUploadDraft({ ...uploadDraft, name: '', description: '', subcategory: '', project: '' });
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
      // Ручное редактирование описания не должно стирать маркер кнопки.
      const marker = isRewardsDoc(d) ? `${REWARDS_MARKER} ` : '';
      await api(`/admin/documents/${d.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: d.name, description: `${marker}${cleanDescription(d.description)}`.trim() || null, category: d.category,
          subcategory: d.subcategory, project: d.project || null, isPublic: d.isPublic, sortOrder: d.sortOrder,
        }),
      });
      setEditingId(null);
      setMessage('Сохранено'); setTimeout(() => setMessage(''), 1500);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const handleSetRewardsDoc = async (d: DocItem) => {
    if (!confirm(`Кнопка «Условия вознаграждения» на главной странице будет открывать «${d.name}». Продолжить?`)) return;
    try {
      for (const other of docs.filter((x) => x.id !== d.id && isRewardsDoc(x))) {
        await api(`/admin/documents/${other.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ description: cleanDescription(other.description) || null }),
        });
      }
      await api(`/admin/documents/${d.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          description: `${REWARDS_MARKER} ${cleanDescription(d.description)}`.trim(),
          isPublic: true,
        }),
      });
      load();
      setMessage('Готово — кнопка на главной теперь открывает этот файл');
      setTimeout(() => setMessage(''), 3000);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const handleToggleVisibility = async (d: DocItem) => {
    try {
      await api(`/admin/documents/${d.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isPublic: !d.isPublic }),
      });
      setDocs((prev) => prev.map((x) => (x.id === d.id ? { ...x, isPublic: !d.isPublic } : x)));
      setMessage(!d.isPublic ? 'Файл снова показывается' : 'Файл скрыт с витрины');
      setTimeout(() => setMessage(''), 2000);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить файл? Это удалит и физический файл с диска.')) return;
    try {
      await api(`/admin/documents/${id}`, { method: 'DELETE' });
      load();
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
  };

  const startReplace = (d: DocItem) => {
    setReplaceTarget(d);
    replaceInputRef.current?.click();
  };

  const handleReplaceFile = async (file: File | null) => {
    const target = replaceTarget;
    if (replaceInputRef.current) replaceInputRef.current.value = '';
    setReplaceTarget(null);
    if (!file || !target) return;
    if (!confirm(`Заменить «${target.name}» файлом «${file.name}»? Название и место на сайте сохранятся, старый файл будет удалён.`)) return;
    setReplacing(true); setMessage('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('category', target.category);
      fd.append('name', target.name);
      const desc = cleanDescription(target.description);
      if (desc) fd.append('description', desc);
      if (target.subcategory) fd.append('subcategory', target.subcategory);
      if (target.project) fd.append('project', target.project);
      fd.append('isPublic', String(target.isPublic));
      fd.append('sortOrder', String(target.sortOrder));
      await apiUpload('/admin/documents/upload', fd);
      await api(`/admin/documents/${target.id}`, { method: 'DELETE' });
      load();
      setMessage('Файл заменён — на сайте уже новая версия');
      setTimeout(() => setMessage(''), 3000);
    } catch (e: any) { setMessage(e.message || 'Ошибка замены'); }
    setReplacing(false);
  };

  const updateLocal = (id: string, patch: Partial<DocItem>) => {
    setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  if (!allowed) {
    return <div className="card">Доступ запрещён</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <FileText className="w-7 h-7 text-accent" />Файлы и документы
          </h1>
          <span className="text-text-muted text-sm">Всё, что скачивают брокеры на лендинге и в кабинете</span>
        </div>
      </div>

      {/* Как тут всё устроено */}
      <div className="card mb-4 text-sm space-y-1.5">
        <div className="font-semibold">Как заменить файл на сайте</div>
        <div className="flex items-start gap-2">
          <Cloud className="w-4 h-4 text-warning mt-0.5 shrink-0" />
          <span>
            Файлы с меткой <b>«Яндекс.Диск (авто)»</b> — например, условия рассрочки — приезжают с{' '}
            <a href={YANDEX_DISK_SHARE} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Яндекс.Диска</a>{' '}
            автоматически каждую ночь. Чтобы заменить такой файл — положите новую версию в ту же папку на Диске (старую удалите), сайт обновится сам.
          </span>
        </div>
        <div className="flex items-start gap-2">
          <HardDrive className="w-4 h-4 text-success mt-0.5 shrink-0" />
          <span>Файлы <b>«Загружен вручную»</b> меняются здесь: кнопка <RefreshCw className="w-3 h-3 inline" /> «Заменить» у файла — выбираете новый, место на сайте сохраняется.</span>
        </div>
        <div className="flex items-start gap-2">
          <Search className="w-4 h-4 text-text-muted mt-0.5 shrink-0" />
          <span>Не можете найти файл — введите часть названия в поиск ниже (например, «рассрочк»). У каждого файла написано, где именно он показывается.</span>
        </div>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      {/* Раскладка папок Я.Диска — свёрнута по умолчанию */}
      <div className="card mb-4 p-0 overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface-secondary/50"
          onClick={() => setShowFolders(!showFolders)}
        >
          <span className="font-semibold flex items-center gap-2">
            <Cloud className="w-5 h-5 text-warning" /> Папки материалов с Яндекс.Диска
            <span className="text-text-muted text-sm font-normal">— что и в каком порядке видно на витрине</span>
          </span>
          <ChevronDown className={`w-5 h-5 transition-transform ${showFolders ? 'rotate-180' : ''}`} />
        </button>
        {showFolders && (
          <div className="px-4 pb-4">
            <MaterialsFoldersAdmin isAdmin={isAdmin} onMessage={setMessage} />
          </div>
        )}
      </div>

      {/* Добавление — свёрнуто по умолчанию */}
      {isAdmin && (
        <div className="card mb-4 p-0 overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface-secondary/50"
            onClick={() => setShowAddForms(!showAddForms)}
          >
            <span className="font-semibold flex items-center gap-2">
              <Plus className="w-5 h-5 text-accent" /> Добавить новый файл или ссылку
            </span>
            <ChevronDown className={`w-5 h-5 transition-transform ${showAddForms ? 'rotate-180' : ''}`} />
          </button>
          {showAddForms && (
            <div className="px-4 pb-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Upload file */}
              <div>
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
                      <label className="label">Раздел сайта</label>
                      <select className="input" value={uploadDraft.category} onChange={(e) => setUploadDraft({ ...uploadDraft, category: e.target.value })}>
                        {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label">Папка (для группировки)</label>
                      <input className="input" placeholder="Напр. Презентации" value={uploadDraft.subcategory} onChange={(e) => setUploadDraft({ ...uploadDraft, subcategory: e.target.value })} />
                    </div>
                  </div>
                  <div>
                    <label className="label">Проект (объект)</label>
                    <select className="input" value={uploadDraft.project} onChange={(e) => setUploadDraft({ ...uploadDraft, project: e.target.value })}>
                      <option value="">— Все проекты —</option>
                      <option value="ZORGE9">Зорге 9</option>
                      <option value="SILVER_BOR">Серебряный Бор</option>
                    </select>
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
              <div>
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
                      <label className="label">Раздел сайта</label>
                      <select className="input" value={extDraft.category} onChange={(e) => setExtDraft({ ...extDraft, category: e.target.value })}>
                        {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label">Папка</label>
                      <input className="input" value={extDraft.subcategory} onChange={(e) => setExtDraft({ ...extDraft, subcategory: e.target.value })} />
                    </div>
                  </div>
                  <div>
                    <label className="label">Проект (объект)</label>
                    <select className="input" value={extDraft.project} onChange={(e) => setExtDraft({ ...extDraft, project: e.target.value })}>
                      <option value="">— Все проекты —</option>
                      <option value="ZORGE9">Зорге 9</option>
                      <option value="SILVER_BOR">Серебряный Бор</option>
                    </select>
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
        </div>
      )}

      {/* Поиск и фильтр */}
      <div className="card mb-4">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              className="input pl-9 w-full"
              placeholder="Поиск по названию — например «рассрочк» или «презентация»"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Все разделы</option>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <span className="text-sm text-text-muted whitespace-nowrap">Найдено: {filtered.length}</span>
        </div>
      </div>

      {/* скрытый input для замены файла */}
      <input
        ref={replaceInputRef}
        type="file"
        className="hidden"
        onChange={(e) => handleReplaceFile(e.target.files?.[0] || null)}
      />

      {loading ? (
        <div className="text-center py-8 text-text-muted card">Загрузка...</div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-8 text-text-muted">
          <FileText className="w-10 h-10 mx-auto mb-2 text-text-muted/50" />
          {search ? <>По запросу «{search}» ничего не найдено</> : 'Документы не найдены'}
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((g) => (
            <div key={g.category}>
              <div className="mb-2">
                <h2 className="text-lg font-semibold">{g.title} <span className="text-text-muted font-normal text-sm">({g.items.length})</span></h2>
                <p className="text-xs text-text-muted">{g.hint}</p>
              </div>
              <div className="space-y-2">
                {g.items.map((d) => {
                  const origin = getOrigin(d);
                  const isYandex = origin.kind === 'yandex';
                  const editing = editingId === d.id;
                  return (
                    <div key={d.id} className="card">
                      {!editing ? (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium truncate max-w-full">{d.name}</span>
                            <OriginBadge origin={origin} />
                            {isRewardsDoc(d) && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/15 text-accent text-xs whitespace-nowrap" title="Этот файл открывается кнопкой «Условия вознаграждения» в шапке главной страницы">
                                ⭐ Кнопка на главной
                              </span>
                            )}
                            <span className="px-2 py-0.5 rounded bg-surface-secondary text-xs">{d.type}</span>
                            <span className="text-xs text-text-muted">{formatSize(d.fileSize)}</span>
                            {!d.isPublic && (
                              <span className="px-2 py-0.5 rounded bg-error/15 text-error text-xs">Скрыт</span>
                            )}
                            <div className="ml-auto flex items-center gap-1">
                              <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary text-xs flex items-center gap-1">
                                <ExternalLink className="w-3 h-3" /> Открыть
                              </a>
                              {isAdmin && d.category === 'cooperation' && !isRewardsDoc(d) && (
                                <button
                                  onClick={() => handleSetRewardsDoc(d)}
                                  className="btn btn-secondary text-xs whitespace-nowrap"
                                  title="Кнопка «Условия вознаграждения» в шапке главной страницы будет открывать этот файл"
                                >
                                  ⭐ На кнопку главной
                                </button>
                              )}
                              {isAdmin && origin.kind === 'manual' && (
                                <button
                                  onClick={() => startReplace(d)}
                                  disabled={replacing}
                                  className="btn btn-secondary text-xs flex items-center gap-1"
                                  title="Загрузить новую версию вместо этой — место на сайте сохранится"
                                >
                                  <RefreshCw className="w-3 h-3" /> Заменить
                                </button>
                              )}
                              {isAdmin && (
                                <button
                                  onClick={() => handleToggleVisibility(d)}
                                  className="btn btn-secondary text-xs"
                                  title={d.isPublic ? 'Скрыть с витрины (файл останется)' : 'Показать на витрине'}
                                >
                                  {d.isPublic ? 'Скрыть' : 'Показать'}
                                </button>
                              )}
                              {isAdmin && !isYandex && origin.kind !== 'seed' && (
                                <>
                                  <button onClick={() => setEditingId(d.id)} className="btn btn-secondary text-xs" title="Изменить название и место">
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                  <button onClick={() => handleDelete(d.id)} className="btn btn-secondary text-error text-xs" title="Удалить">
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="mt-1.5 text-xs text-text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span>📍 {whereShown(d)}</span>
                            {cleanDescription(d.description) && <span className="truncate">{cleanDescription(d.description)}</span>}
                          </div>
                          {isYandex && isAdmin && (
                            <div className="mt-1.5 text-xs text-warning/90">
                              Чтобы заменить этот файл — обновите его в папке{' '}
                              <a href={YANDEX_DISK_SHARE} target="_blank" rel="noopener noreferrer" className="underline">
                                «{origin.path.split('/').filter(Boolean)[0] || 'на Яндекс.Диске'}»
                              </a>{' '}
                              на Яндекс.Диске. Ночью сайт обновится автоматически.
                            </div>
                          )}
                        </>
                      ) : (
                        <div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                            <div>
                              <label className="label">Название</label>
                              <input className="input" value={d.name} onChange={(e) => updateLocal(d.id, { name: e.target.value })} />
                            </div>
                            <div>
                              <label className="label">Описание</label>
                              <input className="input" value={cleanDescription(d.description)} onChange={(e) => updateLocal(d.id, { description: e.target.value })} />
                            </div>
                            <div>
                              <label className="label">Раздел сайта</label>
                              <select className="input" value={d.category} onChange={(e) => updateLocal(d.id, { category: e.target.value })}>
                                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="label">Папка (группировка)</label>
                              <input className="input" value={d.subcategory || ''} onChange={(e) => updateLocal(d.id, { subcategory: e.target.value })} />
                            </div>
                            <div>
                              <label className="label">Проект</label>
                              <select className="input" value={d.project || ''} onChange={(e) => updateLocal(d.id, { project: e.target.value || null })}>
                                <option value="">— Все проекты —</option>
                                <option value="ZORGE9">Зорге 9</option>
                                <option value="SILVER_BOR">Серебряный Бор</option>
                              </select>
                            </div>
                            <div className="flex items-end gap-4">
                              <label className="flex items-center gap-2 cursor-pointer pb-2">
                                <input type="checkbox" checked={d.isPublic} onChange={(e) => updateLocal(d.id, { isPublic: e.target.checked })} />
                                Публично
                              </label>
                              <div>
                                <label className="label">Порядок</label>
                                <input type="number" className="input w-24" value={d.sortOrder} onChange={(e) => updateLocal(d.id, { sortOrder: Number(e.target.value) })} />
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => handleSave(d)} className="btn btn-primary text-sm flex items-center gap-1">
                              <Save className="w-4 h-4" /> Сохранить
                            </button>
                            <button onClick={() => { setEditingId(null); load(); }} className="btn btn-secondary text-sm flex items-center gap-1">
                              <X className="w-4 h-4" /> Отмена
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
