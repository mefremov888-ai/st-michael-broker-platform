'use client';

import { useEffect, useState } from 'react';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { FileText, Save, Plus, Trash2, History, RotateCcw, X } from 'lucide-react';

type ContentMap = Record<string, any>;

const BLOCKS: { key: string; label: string }[] = [
  { key: 'hero', label: 'Hero (главный экран)' },
  { key: 'howto', label: 'Как начать' },
  { key: 'projectsSection', label: 'Заголовок «Наши проекты»' },
  { key: 'advantages', label: 'Преимущества' },
  { key: 'commission', label: 'Комиссия' },
  { key: 'cooperation', label: 'Условия сотрудничества' },
  { key: 'contact', label: 'Контакты' },
];

const ADVANTAGE_ICON_OPTIONS = [
  { value: '', label: '— нет —' },
  { value: 'headphones', label: 'Наушники' },
  { value: 'phone-call', label: 'Телефон' },
  { value: 'wallet', label: 'Кошелёк' },
  { value: 'trending-up', label: 'График вверх' },
  { value: 'users', label: 'Люди' },
  { value: 'graduation-cap', label: 'Шапка выпускника' },
  { value: 'shield', label: 'Щит (защита)' },
  { value: 'sparkles', label: 'Искры (гибкость)' },
];

export default function AdminContentPage() {
  const { broker } = useAuth();
  const [content, setContent] = useState<ContentMap>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>('hero');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  // КБ6 #45: история правок текущего блока (Google Docs-стиль)
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const isAdmin = broker?.role === 'ADMIN';

  const load = () => {
    setLoading(true);
    apiGet('/admin/cms/content')
      .then((d) => setContent(d || {}))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const saveBlock = async (key: string) => {
    setSaving(true); setMessage('');
    try {
      await api(`/admin/cms/content/${key}`, {
        method: 'PATCH',
        body: JSON.stringify({ value: content[key] }),
      });
      // Перечитываем content с бэка — если value реально сохранилось,
      // в форме останется введённое значение; если что-то пошло не так,
      // форма откатится к старому, и пользователь это сразу увидит.
      const fresh = await apiGet('/admin/cms/content');
      setContent(fresh || {});
      setMessage('Сохранено · обнови лендинг в новой вкладке (Ctrl+F5) чтобы увидеть');
      setTimeout(() => setMessage(''), 4000);
    } catch (e: any) { setMessage(e.message || 'Ошибка'); }
    setSaving(false);
  };

  const updateField = (key: string, path: string, value: any) => {
    const next = { ...content };
    if (!next[key]) next[key] = {};
    const obj = { ...next[key] };
    obj[path] = value;
    next[key] = obj;
    setContent(next);
  };

  const updateArrayItem = (key: string, arrField: string, idx: number, patch: any) => {
    const next = { ...content };
    const arr = [...(next[key]?.[arrField] || [])];
    arr[idx] = { ...arr[idx], ...patch };
    next[key] = { ...next[key], [arrField]: arr };
    setContent(next);
  };

  const addArrayItem = (key: string, arrField: string, item: any) => {
    const next = { ...content };
    const arr = [...(next[key]?.[arrField] || []), item];
    next[key] = { ...next[key], [arrField]: arr };
    setContent(next);
  };

  const removeArrayItem = (key: string, arrField: string, idx: number) => {
    const next = { ...content };
    const arr = [...(next[key]?.[arrField] || [])];
    arr.splice(idx, 1);
    next[key] = { ...next[key], [arrField]: arr };
    setContent(next);
  };

  if (loading) return <div className="text-center py-8 text-text-muted">Загрузка...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <FileText className="w-7 h-7 text-accent" />Контент лендинга
          </h1>
          <span className="text-text-muted text-sm">Редактирование текстовых блоков</span>
        </div>
      </div>

      {message && <div className="mb-4 p-3 rounded-lg bg-info/20 text-info text-sm">{message}</div>}

      <div className="flex gap-2 mb-4 border-b border-border overflow-x-auto">
        {BLOCKS.map((b) => (
          <button
            key={b.key}
            onClick={() => setTab(b.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition whitespace-nowrap ${
              tab === b.key ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="card">
        {tab === 'hero' && <HeroEditor content={content.hero || {}} updateField={updateField} updateArrayItem={updateArrayItem} addArrayItem={addArrayItem} removeArrayItem={removeArrayItem} />}
        {tab === 'howto' && <HowtoEditor content={content.howto || {}} updateField={updateField} updateArrayItem={updateArrayItem} addArrayItem={addArrayItem} removeArrayItem={removeArrayItem} />}
        {tab === 'projectsSection' && <ProjectsSectionEditor content={content.projectsSection || {}} updateField={updateField} />}
        {tab === 'advantages' && <AdvantagesEditor content={content.advantages || {}} updateField={updateField} updateArrayItem={updateArrayItem} addArrayItem={addArrayItem} removeArrayItem={removeArrayItem} />}
        {tab === 'commission' && <CommissionEditor content={content.commission || {}} updateField={updateField} updateArrayItem={updateArrayItem} addArrayItem={addArrayItem} removeArrayItem={removeArrayItem} />}
        {tab === 'cooperation' && <CooperationEditor content={content.cooperation || {}} updateField={updateField} />}
        {tab === 'contact' && <ContactEditor content={content.contact || {}} updateField={updateField} />}

        <div className="mt-6 pt-4 border-t border-border flex gap-2 items-center flex-wrap">
          <button className="btn btn-primary flex items-center gap-2" onClick={() => saveBlock(tab)} disabled={saving || !isAdmin}>
            <Save className="w-4 h-4" /> {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
          <button
            className="btn btn-secondary flex items-center gap-2"
            onClick={async () => {
              setHistoryOpen(true);
              setHistoryLoading(true);
              try {
                const h = await apiGet(`/admin/cms/content/${tab}/history`);
                setHistory(Array.isArray(h) ? h : []);
              } catch { setHistory([]); }
              setHistoryLoading(false);
            }}
          >
            <History className="w-4 h-4" /> История правок
          </button>
          {!isAdmin && <span className="text-xs text-text-muted self-center">Только админ может сохранять</span>}
        </div>
      </div>

      {historyOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setHistoryOpen(false)}>
          <div className="bg-surface rounded-xl max-w-3xl w-full max-h-[88vh] overflow-y-auto p-6 relative" onClick={(e) => e.stopPropagation()}>
            <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={() => setHistoryOpen(false)}>
              <X className="w-5 h-5" />
            </button>
            <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
              <History className="w-5 h-5 text-accent" /> История правок: {BLOCKS.find((b) => b.key === tab)?.label || tab}
            </h2>
            <p className="text-xs text-text-muted mb-4">
              Каждое сохранение блока создаёт запись. Кнопка «Восстановить» откатит блок к этому состоянию.
            </p>

            {historyLoading && <div className="text-text-muted text-sm">Загрузка…</div>}
            {!historyLoading && history.length === 0 && <div className="text-text-muted text-sm">Правок пока нет.</div>}

            <div className="space-y-3">
              {history.map((rev) => (
                <div key={rev.id} className="border border-border rounded-lg p-3">
                  <div className="flex justify-between items-start gap-3 mb-2">
                    <div>
                      <div className="text-sm font-medium">{rev.editorName || 'Система'}</div>
                      <div className="text-xs text-text-muted">{new Date(rev.createdAt).toLocaleString('ru-RU')}</div>
                    </div>
                    {isAdmin && (
                      <button
                        className="btn btn-secondary inline-flex items-center gap-1 text-xs"
                        onClick={async () => {
                          if (!confirm(`Восстановить блок «${tab}» к этому состоянию?`)) return;
                          try {
                            await api(`/admin/cms/content/revisions/${rev.id}/restore`, { method: 'POST' });
                            const fresh = await apiGet('/admin/cms/content');
                            setContent(fresh || {});
                            setMessage(`Восстановлено из revision от ${new Date(rev.createdAt).toLocaleString('ru-RU')}`);
                            setHistoryOpen(false);
                            setTimeout(() => setMessage(''), 4000);
                          } catch (e: any) { setMessage(e.message || 'Ошибка восстановления'); }
                        }}
                      >
                        <RotateCcw className="w-3 h-3" /> Восстановить
                      </button>
                    )}
                  </div>
                  <pre className="text-xs bg-surface-secondary p-2 rounded max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(rev.value, null, 2).slice(0, 1500)}
                    {JSON.stringify(rev.value, null, 2).length > 1500 && '\n…'}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── HERO ──────────────────────────────────────────────
function HeroEditor({ content, updateField, updateArrayItem, addArrayItem, removeArrayItem }: any) {
  const stats = content.stats || [];
  return (
    <div className="space-y-4">
      <FieldText label="Тег (надзаголовок)" value={content.tag || ''} onChange={(v) => updateField('hero', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('hero', 'title', v)} />
      <FieldText label="Акцент в заголовке (часть выделится золотым)" value={content.titleAccent || ''} onChange={(v) => updateField('hero', 'titleAccent', v)} hint="Подстрока из заголовка, например: 8% комиссии" />
      <FieldTextarea label="Описание" value={content.description || ''} onChange={(v) => updateField('hero', 'description', v)} />

      <div>
        <label className="label">Цифры внизу (4 блока)</label>
        <div className="space-y-2">
          {stats.map((s: any, i: number) => (
            <div key={i} className="flex gap-2 items-start">
              <input className="input" placeholder="Число (напр. 5–8%)" value={s.number || ''} onChange={(e) => updateArrayItem('hero', 'stats', i, { number: e.target.value })} />
              <input className="input flex-2" placeholder="Подпись" value={s.label || ''} onChange={(e) => updateArrayItem('hero', 'stats', i, { label: e.target.value })} />
              <button className="btn btn-secondary text-error" onClick={() => removeArrayItem('hero', 'stats', i)}><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
        <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={() => addArrayItem('hero', 'stats', { number: '', label: '' })}>
          <Plus className="w-4 h-4" /> Добавить цифру
        </button>
      </div>
    </div>
  );
}

// ── ADVANTAGES ────────────────────────────────────────
function AdvantagesEditor({ content, updateField, updateArrayItem, addArrayItem, removeArrayItem }: any) {
  const items = content.items || [];
  return (
    <div className="space-y-4">
      <FieldText label="Тег" value={content.tag || ''} onChange={(v) => updateField('advantages', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('advantages', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('advantages', 'titleAccent', v)} />
      <FieldTextarea label="Подзаголовок" value={content.subtitle || ''} onChange={(v) => updateField('advantages', 'subtitle', v)} />

      <div>
        <label className="label">Карточки преимуществ</label>
        <div className="space-y-3">
          {items.map((it: any, i: number) => (
            <div key={i} className="border border-border rounded p-3">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs text-text-muted">Карточка #{i + 1}</span>
                <button onClick={() => removeArrayItem('advantages', 'items', i)} className="text-error hover:text-error/80"><Trash2 className="w-4 h-4" /></button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-2 mb-2">
                <div>
                  <label className="text-xs text-text-muted block mb-1">Иконка</label>
                  <select
                    className="input"
                    value={it.icon || ''}
                    onChange={(e) => updateArrayItem('advantages', 'items', i, { icon: e.target.value || null })}
                  >
                    {ADVANTAGE_ICON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-text-muted block mb-1">Заголовок</label>
                  <input className="input" placeholder="Заголовок" value={it.title || ''} onChange={(e) => updateArrayItem('advantages', 'items', i, { title: e.target.value })} />
                </div>
              </div>
              <textarea className="input" placeholder="Описание" rows={2} value={it.description || ''} onChange={(e) => updateArrayItem('advantages', 'items', i, { description: e.target.value })} />
            </div>
          ))}
        </div>
        <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={() => addArrayItem('advantages', 'items', { icon: '', title: '', description: '' })}>
          <Plus className="w-4 h-4" /> Добавить карточку
        </button>
        <p className="text-xs text-text-muted mt-2">
          Если иконка не выбрана — лендинг попробует подобрать её по заголовку (для старых дефолтов). Если не нашёл — карточка без иконки.
        </p>
      </div>
    </div>
  );
}

// ── HOWTO ─────────────────────────────────────────────
function HowtoEditor({ content, updateField, updateArrayItem, addArrayItem, removeArrayItem }: any) {
  const steps = content.steps || [];
  return (
    <div className="space-y-4">
      <FieldText label="Тег (надзаголовок)" value={content.tag || ''} onChange={(v) => updateField('howto', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('howto', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('howto', 'titleAccent', v)} />
      <FieldTextarea label="Подзаголовок" value={content.subtitle || ''} onChange={(v) => updateField('howto', 'subtitle', v)} />

      <div>
        <label className="label">Шаги</label>
        <div className="space-y-3">
          {steps.map((s: any, i: number) => (
            <div key={i} className="border border-border rounded p-3">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs text-text-muted">Шаг #{i + 1}</span>
                <button onClick={() => removeArrayItem('howto', 'steps', i)} className="text-error hover:text-error/80"><Trash2 className="w-4 h-4" /></button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[80px_1fr] gap-2 mb-2">
                <input className="input" placeholder="01" value={s.num || ''} onChange={(e) => updateArrayItem('howto', 'steps', i, { num: e.target.value })} />
                <input className="input" placeholder="Заголовок шага" value={s.title || ''} onChange={(e) => updateArrayItem('howto', 'steps', i, { title: e.target.value })} />
              </div>
              <textarea className="input" placeholder="Описание" rows={2} value={s.description || ''} onChange={(e) => updateArrayItem('howto', 'steps', i, { description: e.target.value })} />
            </div>
          ))}
        </div>
        <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={() => addArrayItem('howto', 'steps', { num: String(steps.length + 1).padStart(2, '0'), title: '', description: '' })}>
          <Plus className="w-4 h-4" /> Добавить шаг
        </button>
      </div>

      <FieldText label="Текст под шагами (мелкий)" value={content.footer || ''} onChange={(v) => updateField('howto', 'footer', v)} hint="Например: «Агентский договор оформляется при первой сделке»" />
      <FieldText label="Текст кнопки" value={content.ctaText || ''} onChange={(v) => updateField('howto', 'ctaText', v)} />
    </div>
  );
}

// ── PROJECTS SECTION ──────────────────────────────────
function ProjectsSectionEditor({ content, updateField }: any) {
  return (
    <div className="space-y-4">
      <FieldText label="Тег" value={content.tag || ''} onChange={(v) => updateField('projectsSection', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('projectsSection', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('projectsSection', 'titleAccent', v)} />
      <FieldTextarea label="Подзаголовок (можно пустым)" value={content.subtitle || ''} onChange={(v) => updateField('projectsSection', 'subtitle', v)} />
      <div className="text-xs text-text-muted">
        Сами карточки проектов — в разделе <code>/admin/projects</code>. Здесь только заголовок и подзаголовок над ними.
      </div>
    </div>
  );
}

// ── COOPERATION ────────────────────────────────────────
// 2026-06-01: блок «Условия сотрудничества» на лендинге (между «Как начать»
// и футером). Документы (.pdf условий) — в разделе /admin/documents,
// категория = cooperation. Здесь только тексты.
function CooperationEditor({ content, updateField }: any) {
  return (
    <div className="space-y-4">
      <FieldText label="Тег (надзаголовок)" value={content.tag || ''} onChange={(v) => updateField('cooperation', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('cooperation', 'title', v)} />
      <FieldText label="Акцент в заголовке (выделится золотым)" value={content.titleAccent || ''} onChange={(v) => updateField('cooperation', 'titleAccent', v)} />
      <FieldTextarea label="Подзаголовок" value={content.subtitle || ''} onChange={(v) => updateField('cooperation', 'subtitle', v)} />
      <FieldTextarea label="Описание (основной текст слева)" value={content.description || ''} onChange={(v) => updateField('cooperation', 'description', v)} />
      <FieldText label="Текст кнопки" value={content.ctaText || ''} onChange={(v) => updateField('cooperation', 'ctaText', v)} hint="по умолчанию «Стать партнёром»" />
      <div className="text-xs text-text-muted">
        Документы (PDF условий) — в разделе <code>/admin/documents</code> с категорией <code>cooperation</code>.
      </div>
    </div>
  );
}

// ── COMMISSION ────────────────────────────────────────
function CommissionEditor({ content, updateField, updateArrayItem, addArrayItem, removeArrayItem }: any) {
  const cards = content.cards || [];
  const levelsByProject = content.levelsByProject || {};
  const [activeProject, setActiveProject] = useState<'ZORGE9' | 'SILVER_BOR'>('ZORGE9');
  const projectLevels = levelsByProject[activeProject] || [];

  const updateProjectLevel = (idx: number, patch: any) => {
    const next = { ...content };
    const lp = { ...(next.levelsByProject || {}) };
    const arr = [...(lp[activeProject] || [])];
    arr[idx] = { ...arr[idx], ...patch };
    lp[activeProject] = arr;
    updateField('commission', 'levelsByProject', lp);
  };
  const addProjectLevel = () => {
    const next = { ...content };
    const lp = { ...(next.levelsByProject || {}) };
    const arr = [...(lp[activeProject] || []), { name: '', range: '', rate: '', active: false }];
    lp[activeProject] = arr;
    updateField('commission', 'levelsByProject', lp);
  };
  const removeProjectLevel = (idx: number) => {
    const next = { ...content };
    const lp = { ...(next.levelsByProject || {}) };
    const arr = [...(lp[activeProject] || [])];
    arr.splice(idx, 1);
    lp[activeProject] = arr;
    updateField('commission', 'levelsByProject', lp);
  };

  // 2026-06-16: переключатель FLAT/PROGRESSIVE по проекту + поля для FLAT.
  const modeByProject = content.modeByProject || {};
  const flatRateByProject = content.flatRateByProject || {};
  const flatNoteByProject = content.flatNoteByProject || {};
  const currentMode: 'FLAT' | 'PROGRESSIVE' = modeByProject[activeProject] || 'PROGRESSIVE';
  const setProjectMode = (mode: 'FLAT' | 'PROGRESSIVE') => {
    updateField('commission', 'modeByProject', { ...modeByProject, [activeProject]: mode });
  };
  const setProjectFlatRate = (rate: string) => {
    const n = parseFloat(rate.replace(',', '.'));
    updateField('commission', 'flatRateByProject', { ...flatRateByProject, [activeProject]: isNaN(n) ? 0 : n });
  };
  const setProjectFlatNote = (note: string) => {
    updateField('commission', 'flatNoteByProject', { ...flatNoteByProject, [activeProject]: note });
  };

  return (
    <div className="space-y-4">
      <FieldText label="Тег" value={content.tag || ''} onChange={(v) => updateField('commission', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('commission', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('commission', 'titleAccent', v)} />
      <FieldTextarea label="Подзаголовок" value={content.subtitle || ''} onChange={(v) => updateField('commission', 'subtitle', v)} />

      <div className="border-t border-border pt-4 mt-2">
        <label className="label flex items-center justify-between">
          <span>Шкалы по проектам</span>
          <span className="text-xs text-text-muted font-normal">переключатель Зорге 9 / Серебряный Бор на лендинге</span>
        </label>
        <div className="flex gap-2 mb-3">
          {(['ZORGE9', 'SILVER_BOR'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setActiveProject(p)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                activeProject === p ? 'bg-accent text-white' : 'bg-surface-secondary text-text-muted hover:text-text'
              }`}
            >
              {p === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}
              <span className="ml-2 text-xs opacity-70">
                ({(modeByProject[p] || 'PROGRESSIVE') === 'FLAT' ? `FLAT ${flatRateByProject[p] ?? '—'}%` : `${(levelsByProject[p] || []).length} уровней`})
              </span>
            </button>
          ))}
        </div>

        {/* 2026-06-16: режим комиссии для выбранного проекта */}
        <div className="flex gap-3 mb-4 p-3 bg-surface-secondary rounded">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={`mode-${activeProject}`}
              checked={currentMode === 'PROGRESSIVE'}
              onChange={() => setProjectMode('PROGRESSIVE')}
              className="accent-accent"
            />
            <span className="text-sm">Прогрессивная шкала</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={`mode-${activeProject}`}
              checked={currentMode === 'FLAT'}
              onChange={() => setProjectMode('FLAT')}
              className="accent-accent"
            />
            <span className="text-sm">Фиксированная ставка</span>
          </label>
        </div>

        {currentMode === 'FLAT' ? (
          <div className="space-y-2">
            <div className="flex gap-2 items-center">
              <label className="text-sm w-32">Ставка %</label>
              <input
                className="input w-32"
                placeholder="4.0"
                value={flatRateByProject[activeProject] ?? ''}
                onChange={(e) => setProjectFlatRate(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm">Пояснение (опционально)</label>
              <textarea
                className="input"
                rows={2}
                placeholder="Единая ставка по проекту..."
                value={flatNoteByProject[activeProject] || ''}
                onChange={(e) => setProjectFlatNote(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {projectLevels.map((lv: any, i: number) => (
                <div key={i} className="flex gap-2 items-center">
                  <input className="input flex-1" placeholder="Название (Start)" value={lv.name || ''} onChange={(e) => updateProjectLevel(i, { name: e.target.value })} />
                  <input className="input flex-1" placeholder="Объём (0–59 м²)" value={lv.range || ''} onChange={(e) => updateProjectLevel(i, { range: e.target.value })} />
                  <input className="input w-24" placeholder="Ставка (5,0%)" value={lv.rate || ''} onChange={(e) => updateProjectLevel(i, { rate: e.target.value })} />
                  <label className="flex items-center gap-1 text-xs whitespace-nowrap">
                    <input type="checkbox" checked={!!lv.active} onChange={(e) => updateProjectLevel(i, { active: e.target.checked })} /> active
                  </label>
                  <button className="btn btn-secondary text-error" onClick={() => removeProjectLevel(i)}><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
            <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={addProjectLevel}>
              <Plus className="w-4 h-4" /> Добавить уровень в {activeProject === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}
            </button>
            <p className="text-xs text-text-muted mt-2">
              Серебряный Бор по новому ТЗ имеет только 6 уровней (без Legend), максимум — Champion 6,25%.
            </p>
          </>
        )}
      </div>

      {/* 2026-07-02: параметры калькулятора теперь свои для каждого проекта.
          Общие поля installmentEnabled / installmentDiscount /
          subsidizedMortgageEnabled / subsidizedMortgageRate остаются как
          fallback для старых значений — при первой правке переезжают в
          *ByProject[activeProject]. */}
      <div className="border-t border-border pt-4 mt-2">
        <label className="label flex items-center justify-between">
          <span>Параметры калькулятора — {activeProject === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}</span>
          <span className="text-xs text-text-muted font-normal">используется калькулятором в кабинете брокера · переключается кнопками выше</span>
        </label>
        {(() => {
          const iep = content.installmentEnabledByProject || {};
          const idp = content.installmentDiscountByProject || {};
          const sep = content.subsidizedMortgageEnabledByProject || {};
          const srp = content.subsidizedMortgageRateByProject || {};
          const legacyIe = content.installmentEnabled;
          const legacyId = content.installmentDiscount;
          const legacySe = content.subsidizedMortgageEnabled;
          const legacySr = content.subsidizedMortgageRate;
          const instEnabled = iep[activeProject] !== undefined ? iep[activeProject] !== false : legacyIe !== false;
          const instDiscount = idp[activeProject] ?? legacyId ?? '';
          const subEnabled = sep[activeProject] !== undefined ? sep[activeProject] !== false : legacySe !== false;
          const subRate = srp[activeProject] ?? legacySr ?? '';
          const setInstEnabled = (v: boolean) => updateField('commission', 'installmentEnabledByProject', { ...iep, [activeProject]: v });
          const setInstDiscount = (v: any) => updateField('commission', 'installmentDiscountByProject', { ...idp, [activeProject]: v });
          const setSubEnabled = (v: boolean) => updateField('commission', 'subsidizedMortgageEnabledByProject', { ...sep, [activeProject]: v });
          const setSubRate = (v: any) => updateField('commission', 'subsidizedMortgageRateByProject', { ...srp, [activeProject]: v });
          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="border border-border rounded-lg p-3">
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input
                    type="checkbox"
                    checked={instEnabled}
                    onChange={(e) => setInstEnabled(e.target.checked)}
                  />
                  <span className="text-sm font-medium">«Рассрочка» активна</span>
                </label>
                <label className="text-sm text-text-muted block mb-1">Скидка при рассрочке, %</label>
                <input
                  className="input"
                  type="number"
                  step="0.05"
                  placeholder="0.5"
                  disabled={!instEnabled}
                  value={instDiscount}
                  onChange={(e) => setInstDiscount(e.target.value === '' ? null : Number(e.target.value))}
                />
                <p className="text-xs text-text-muted mt-1">
                  На сколько % уменьшается ставка при выборе «Рассрочка» для этого проекта.
                  {!instEnabled && ' Вариант скрыт на калькуляторе.'}
                </p>
              </div>
              <div className="border border-border rounded-lg p-3">
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input
                    type="checkbox"
                    checked={subEnabled}
                    onChange={(e) => setSubEnabled(e.target.checked)}
                  />
                  <span className="text-sm font-medium">«Субсидированная ипотека» активна</span>
                </label>
                <label className="text-sm text-text-muted block mb-1">Ставка при субс. ипотеке, %</label>
                <input
                  className="input"
                  type="number"
                  step="0.05"
                  placeholder="4"
                  disabled={!subEnabled}
                  value={subRate}
                  onChange={(e) => setSubRate(e.target.value === '' ? null : Number(e.target.value))}
                />
                <p className="text-xs text-text-muted mt-1">
                  Фиксированная ставка при выборе «Субсидированная ипотека» для этого проекта.
                  {!subEnabled && ' Вариант скрыт на калькуляторе.'}
                </p>
              </div>
            </div>
          );
        })()}
      </div>

      {/* 2026-07-03: карточки условий тоже по проекту. Раньше был общий
          массив content.cards на оба проекта — теперь cardsByProject[project].
          Fallback: если в новом cardsByProject[project] пусто, показываем
          старый общий cards (совместимость с уже сохранённым контентом). */}
      <div>
        <label className="label flex items-center justify-between">
          <span>Карточки условий (рядом со шкалой) — {activeProject === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}</span>
          <span className="text-xs text-text-muted font-normal">переключается кнопками выше</span>
        </label>
        {(() => {
          const cardsByProject = content.cardsByProject || {};
          const projectCards: any[] = Array.isArray(cardsByProject[activeProject])
            ? cardsByProject[activeProject]
            : (Array.isArray(cards) ? cards : []); // fallback на старый общий cards
          const setProjectCards = (next: any[]) => {
            updateField('commission', 'cardsByProject', { ...cardsByProject, [activeProject]: next });
          };
          const updateCard = (idx: number, patch: any) => {
            const next = [...projectCards];
            next[idx] = { ...next[idx], ...patch };
            setProjectCards(next);
          };
          const addCard = () => setProjectCards([...projectCards, { title: '', text: '' }]);
          const removeCard = (idx: number) => {
            const next = [...projectCards];
            next.splice(idx, 1);
            setProjectCards(next);
          };
          return (
            <>
              <div className="space-y-3">
                {projectCards.map((c: any, i: number) => (
                  <div key={i} className="border border-border rounded p-3">
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-xs text-text-muted">Карточка #{i + 1}</span>
                      <button onClick={() => removeCard(i)} className="text-error hover:text-error/80"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    <input className="input mb-2" placeholder="Заголовок" value={c.title || ''} onChange={(e) => updateCard(i, { title: e.target.value })} />
                    <textarea className="input" placeholder="Текст" rows={2} value={c.text || ''} onChange={(e) => updateCard(i, { text: e.target.value })} />
                  </div>
                ))}
              </div>
              <button className="btn btn-secondary mt-2 flex items-center gap-2 text-sm" onClick={addCard}>
                <Plus className="w-4 h-4" /> Добавить карточку в {activeProject === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}
              </button>
            </>
          );
        })()}
      </div>
    </div>
  );
}

// ── CONTACT ───────────────────────────────────────────
function ContactEditor({ content, updateField }: any) {
  const manager = content.manager || {};
  const updateManager = (field: string, value: string) => {
    updateField('contact', 'manager', { ...manager, [field]: value });
  };
  return (
    <div className="space-y-4">
      <FieldText label="Тег" value={content.tag || ''} onChange={(v) => updateField('contact', 'tag', v)} />
      <FieldText label="Заголовок" value={content.title || ''} onChange={(v) => updateField('contact', 'title', v)} />
      <FieldText label="Акцент в заголовке" value={content.titleAccent || ''} onChange={(v) => updateField('contact', 'titleAccent', v)} />
      <FieldTextarea label="Описание" value={content.description || ''} onChange={(v) => updateField('contact', 'description', v)} />

      <div className="border-t border-border pt-4 mt-2">
        <h4 className="text-sm font-semibold mb-3">Горячая линия</h4>
        <FieldText label="Заголовок блока контактов" value={content.blockTitle || ''} onChange={(v) => updateField('contact', 'blockTitle', v)} />
        <FieldText label="Телефон" value={content.phone || ''} onChange={(v) => updateField('contact', 'phone', v)} />
        <FieldText label="Часы работы (необязательно)" value={content.phoneHours || ''} onChange={(v) => updateField('contact', 'phoneHours', v)} hint="Например: Ежедневно с 9:00 до 21:00" />
        <FieldText label="Email" value={content.email || ''} onChange={(v) => updateField('contact', 'email', v)} />
        <FieldText label="Telegram-канал (URL)" value={content.telegram || ''} onChange={(v) => updateField('contact', 'telegram', v)} />
      </div>

      <div className="border-t border-border pt-4 mt-2">
        <h4 className="text-sm font-semibold mb-3">Персональный менеджер (необязательно)</h4>
        <FieldText label="Имя менеджера" value={manager.name || ''} onChange={(v) => updateManager('name', v)} />
        <FieldText label="Должность" value={manager.role || ''} onChange={(v) => updateManager('role', v)} hint="Например: Руководитель отдела по работе с партнёрами" />
        <FieldText label="Телефон менеджера" value={manager.phone || ''} onChange={(v) => updateManager('phone', v)} />
      </div>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────
function FieldText({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <div className="text-xs text-text-muted mt-1">{hint}</div>}
    </div>
  );
}

function FieldTextarea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="label">{label}</label>
      <textarea className="input" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
