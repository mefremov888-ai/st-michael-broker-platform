'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPatch } from '@/lib/api';
import {
  DEFAULT_MATERIALS_LAYOUT,
  parseMaterialsLayout,
  type MaterialsFolderKind,
  type MaterialsFolderLayout,
} from '@shared/materials-folder-layout';
import { Eye, EyeOff, FolderTree, Plus, Save, Trash2 } from 'lucide-react';

const KINDS: { value: MaterialsFolderKind; label: string }[] = [
  { value: 'as_is', label: 'Как есть' },
  { value: 'split', label: 'Фото + видео' },
  { value: 'photo', label: 'В фото ЖК' },
  { value: 'video', label: 'В видео ЖК' },
];

type Props = {
  isAdmin: boolean;
  onMessage: (text: string) => void;
};

export function MaterialsFoldersAdmin({ isAdmin, onMessage }: Props) {
  const [layout, setLayout] = useState<MaterialsFolderLayout>(DEFAULT_MATERIALS_LAYOUT);
  const [diskFolders, setDiskFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDefault, setIsDefault] = useState(true);

  const load = () => {
    setLoading(true);
    apiGet('/admin/documents/folders')
      .then((data) => {
        setLayout(parseMaterialsLayout(data.layout || DEFAULT_MATERIALS_LAYOUT));
        setDiskFolders(Array.isArray(data.diskFolders) ? data.diskFolders : []);
        setIsDefault(!!data.isDefault);
      })
      .catch(() => onMessage('Не удалось загрузить папки материалов'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const save = async (next = layout) => {
    setSaving(true);
    try {
      const data = await apiPatch('/admin/documents/folders', { layout: next });
      setLayout(parseMaterialsLayout(data.layout));
      setDiskFolders(Array.isArray(data.diskFolders) ? data.diskFolders : []);
      setIsDefault(false);
      onMessage('Раскладка папок сохранена');
    } catch (e: any) {
      onMessage(e.message || 'Ошибка сохранения папок');
    }
    setSaving(false);
  };

  const resetDefault = async () => {
    if (!confirm('Вернуть группировку по умолчанию: условия отдельно, фото и видео внутри Зорге 9 и Квартала Серебряный Бор?')) return;
    await save(DEFAULT_MATERIALS_LAYOUT);
  };

  const updateGroup = (id: string, patch: Partial<MaterialsFolderLayout['groups'][number]>) => {
    setLayout({
      ...layout,
      groups: layout.groups.map((group) => (group.id === id ? { ...group, ...patch } : group)),
    });
  };

  const updateRule = (id: string, patch: Partial<MaterialsFolderLayout['rules'][number]>) => {
    setLayout({
      ...layout,
      rules: layout.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    });
  };

  const addGroup = () => {
    const title = window.prompt('Название ЖК (папка на лендинге)');
    if (!title?.trim()) return;
    const id = `zhk-${Date.now().toString(36)}`;
    setLayout({
      ...layout,
      groups: [
        ...layout.groups,
        {
          id,
          title: title.trim(),
          visibleOnLanding: true,
          visibleInCabinet: true,
          sortOrder: (layout.groups[layout.groups.length - 1]?.sortOrder || 50) + 10,
        },
      ],
    });
  };

  const removeGroup = (id: string) => {
    setLayout({
      ...layout,
      groups: layout.groups.filter((group) => group.id !== id),
      rules: layout.rules.map((rule) => (rule.groupId === id ? { ...rule, groupId: null, kind: 'as_is' } : rule)),
    });
  };

  const addRule = () => {
    const prefix = window.prompt('Путь папки на Диске, как в subcategory (например Видеоконтент/Зорге 9)');
    if (!prefix?.trim()) return;
    setLayout({
      ...layout,
      rules: [
        ...layout.rules,
        {
          id: `rule-${Date.now().toString(36)}`,
          prefix: prefix.trim(),
          groupId: null,
          kind: 'as_is',
          visibleOnLanding: true,
          visibleInCabinet: true,
          sortOrder: (layout.rules[layout.rules.length - 1]?.sortOrder || 90) + 1,
        },
      ],
    });
  };

  const removeRule = (id: string) => {
    setLayout({ ...layout, rules: layout.rules.filter((rule) => rule.id !== id) });
  };

  if (loading) {
    return <div className="card mb-6 text-text-muted">Загрузка раскладки папок...</div>;
  }

  return (
    <div className="card mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <FolderTree className="w-5 h-5 text-accent" />
          Папки материалов
        </h2>
        <span className="text-xs text-text-muted sm:ml-auto">
          {isDefault ? 'Сейчас дефолт: условия отдельно, фото/видео внутри Зорге 9 и Квартала Серебряный Бор' : 'Сохранено в админке, ночной синк Диска это не затирает'}
        </span>
      </div>
      <p className="text-sm text-text-muted mb-4">
        На лендинге и в кабинете показываем группы ЖК, а не сырые папки Яндекс.Диска.
        Скрытая папка пропадает с витрины, файлы на диске остаются.
      </p>

      <h3 className="text-sm font-semibold mb-2">Жилые комплексы</h3>
      <div className="space-y-2 mb-4">
        {layout.groups.map((group) => (
          <div key={group.id} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
            <input
              className="input md:col-span-4"
              value={group.title}
              disabled={!isAdmin}
              onChange={(e) => updateGroup(group.id, { title: e.target.value })}
            />
            <input
              className="input md:col-span-2"
              type="number"
              title="Порядок"
              value={group.sortOrder}
              disabled={!isAdmin}
              onChange={(e) => updateGroup(group.id, { sortOrder: Number(e.target.value) })}
            />
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={group.visibleOnLanding}
                disabled={!isAdmin}
                onChange={(e) => updateGroup(group.id, { visibleOnLanding: e.target.checked })}
              />
              Лендинг
            </label>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={group.visibleInCabinet}
                disabled={!isAdmin}
                onChange={(e) => updateGroup(group.id, { visibleInCabinet: e.target.checked })}
              />
              Кабинет
            </label>
            {isAdmin && (
              <button className="btn btn-secondary text-error text-xs md:col-span-2" onClick={() => removeGroup(group.id)}>
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>
      {isAdmin && (
        <button className="btn btn-secondary text-sm mb-5" onClick={addGroup}>
          <Plus className="w-4 h-4" /> Добавить ЖК
        </button>
      )}

      <h3 className="text-sm font-semibold mb-2">Папки с Диска</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="py-2 pr-2 font-medium">Путь</th>
              <th className="py-2 pr-2 font-medium">ЖК</th>
              <th className="py-2 pr-2 font-medium">Внутри</th>
              <th className="py-2 pr-2 font-medium">Лендинг</th>
              <th className="py-2 pr-2 font-medium">Кабинет</th>
              <th className="py-2 pr-2 font-medium">Порядок</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {layout.rules.map((rule) => (
              <tr key={rule.id} className="border-t border-white/5">
                <td className="py-2 pr-2">
                  <input
                    className="input text-sm min-w-[180px]"
                    value={rule.prefix}
                    disabled={!isAdmin}
                    list="disk-folder-prefixes"
                    onChange={(e) => updateRule(rule.id, { prefix: e.target.value })}
                  />
                </td>
                <td className="py-2 pr-2">
                  <select
                    className="input text-sm"
                    value={rule.groupId || ''}
                    disabled={!isAdmin}
                    onChange={(e) => updateRule(rule.id, { groupId: e.target.value || null })}
                  >
                    <option value="">Отдельно</option>
                    {layout.groups.map((group) => (
                      <option key={group.id} value={group.id}>{group.title}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <select
                    className="input text-sm"
                    value={rule.kind}
                    disabled={!isAdmin || !rule.groupId}
                    onChange={(e) => updateRule(rule.id, { kind: e.target.value as MaterialsFolderKind })}
                  >
                    {KINDS.map((kind) => (
                      <option key={kind.value} value={kind.value}>{kind.label}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <button
                    type="button"
                    className="text-text-muted"
                    disabled={!isAdmin}
                    onClick={() => updateRule(rule.id, { visibleOnLanding: !rule.visibleOnLanding })}
                    title={rule.visibleOnLanding ? 'Видно на лендинге' : 'Скрыто на лендинге'}
                  >
                    {rule.visibleOnLanding ? <Eye className="w-4 h-4 text-accent" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                </td>
                <td className="py-2 pr-2">
                  <button
                    type="button"
                    className="text-text-muted"
                    disabled={!isAdmin}
                    onClick={() => updateRule(rule.id, { visibleInCabinet: !rule.visibleInCabinet })}
                    title={rule.visibleInCabinet ? 'Видно в кабинете' : 'Скрыто в кабинете'}
                  >
                    {rule.visibleInCabinet ? <Eye className="w-4 h-4 text-accent" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                </td>
                <td className="py-2 pr-2">
                  <input
                    className="input w-20 text-sm"
                    type="number"
                    value={rule.sortOrder}
                    disabled={!isAdmin}
                    onChange={(e) => updateRule(rule.id, { sortOrder: Number(e.target.value) })}
                  />
                </td>
                <td className="py-2">
                  {isAdmin && (
                    <button className="btn btn-secondary text-error text-xs" onClick={() => removeRule(rule.id)}>
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <datalist id="disk-folder-prefixes">
        {diskFolders.map((folder) => (
          <option key={folder} value={folder} />
        ))}
      </datalist>

      {isAdmin && (
        <div className="flex flex-wrap gap-2 mt-4">
          <button className="btn btn-secondary text-sm" onClick={addRule}>
            <Plus className="w-4 h-4" /> Добавить папку Диска
          </button>
          <button className="btn btn-primary text-sm" onClick={() => save()} disabled={saving}>
            <Save className="w-4 h-4" /> {saving ? 'Сохранение...' : 'Сохранить раскладку'}
          </button>
          <button className="btn btn-secondary text-sm" onClick={resetDefault} disabled={saving}>
            Сбросить к Зорге 9 / Квартал Серебряный Бор
          </button>
        </div>
      )}
    </div>
  );
}
