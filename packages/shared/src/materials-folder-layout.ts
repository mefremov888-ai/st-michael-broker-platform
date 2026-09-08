export type MaterialsSurface = 'landing' | 'cabinet';

export type MaterialsFolderKind = 'as_is' | 'photo' | 'video' | 'split';

export type MaterialsFolderGroup = {
  id: string;
  title: string;
  visibleOnLanding: boolean;
  visibleInCabinet: boolean;
  sortOrder: number;
};

export type MaterialsFolderRule = {
  id: string;
  prefix: string;
  displayName?: string;
  groupId: string | null;
  kind: MaterialsFolderKind;
  visibleOnLanding: boolean;
  visibleInCabinet: boolean;
  sortOrder: number;
};

export type MaterialsFolderLayout = {
  version: 1;
  groups: MaterialsFolderGroup[];
  rules: MaterialsFolderRule[];
  // 2026-09-08 (владелец): обложки папок — путь папки как на сайте
  // («Зорге 9», «Зорге 9/Видео», «Презентации») → fileUrl фото из материалов.
  covers?: Record<string, string>;
  // 2026-09-08 (владелец): файлы, лежащие прямо в папке (без подпапки), показывать
  // в виртуальной подпапке с этим именем: путь папки как на сайте → имя подпапки.
  looseFolders?: Record<string, string>;
};

const VIDEO_RE = /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i;
const IMAGE_RE = /\.(jpe?g|png|webp|gif|svg|heic|avif|bmp|tiff?)(\?|#|$)/i;
const VIDEO_FOLDER_RE = /видео|video|reels|ролик|анимац|сторис|film/i;
const PHOTO_FOLDER_RE = /фото|рендер|photo|image/i;

export const MATERIALS_LAYOUT_SETTING_KEY = 'MATERIALS_FOLDER_LAYOUT';

export const DEFAULT_MATERIALS_LAYOUT: MaterialsFolderLayout = {
  version: 1,
  groups: [
    {
      id: 'zorge',
      title: 'Зорге 9',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 40,
    },
    {
      id: 'berarina',
      title: 'Квартал Серебряный Бор',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 50,
    },
  ],
  rules: [
    {
      id: 'installments',
      prefix: 'Актуальные условия рассрочки',
      groupId: null,
      kind: 'as_is',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 10,
    },
    {
      id: 'presentations',
      prefix: 'Презентации',
      groupId: null,
      kind: 'as_is',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 20,
    },
    {
      id: 'commission',
      prefix: 'Условия вознаграждения',
      groupId: null,
      kind: 'as_is',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 30,
    },
    {
      id: 'zorge-main',
      prefix: 'ЗОРГЕ 9',
      groupId: 'zorge',
      kind: 'split',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 41,
    },
    {
      id: 'zorge-photo-album',
      prefix: 'Зорге9 (фото)',
      groupId: 'zorge',
      kind: 'photo',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 42,
    },
    {
      id: 'zorge-video-pack',
      prefix: 'Видеоконтент/Зорге 9',
      groupId: 'zorge',
      kind: 'video',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 43,
    },
    {
      id: 'ksb-main',
      prefix: 'КСБ',
      groupId: 'berarina',
      kind: 'split',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 51,
    },
    {
      id: 'ksb-renders',
      prefix: 'Квартал Серебряный Бор рендеры',
      groupId: 'berarina',
      kind: 'photo',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 52,
    },
    {
      id: 'ksb-video-pack',
      prefix: 'Видеоконтент/Квартал Серебряный Бор',
      groupId: 'berarina',
      kind: 'video',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 53,
    },
    {
      id: 'video-root-leftover',
      prefix: 'Видеоконтент',
      groupId: null,
      kind: 'as_is',
      visibleOnLanding: false,
      visibleInCabinet: true,
      sortOrder: 90,
    },
  ],
};

export function splitMaterialPath(subcategory: string | null | undefined): string[] {
  return String(subcategory || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isValidMaterialsFolderLayout(value: unknown): value is MaterialsFolderLayout {
  if (!value || typeof value !== 'object') return false;
  const layout = value as MaterialsFolderLayout;
  if (layout.version !== 1 || !Array.isArray(layout.groups) || !Array.isArray(layout.rules)) {
    return false;
  }
  const kinds: MaterialsFolderKind[] = ['as_is', 'photo', 'video', 'split'];
  for (const map of [layout.covers, layout.looseFolders]) {
    if (
      map !== undefined &&
      (map === null ||
        typeof map !== 'object' ||
        Array.isArray(map) ||
        Object.values(map).some((value) => typeof value !== 'string'))
    ) {
      return false;
    }
  }
  return (
    layout.groups.every(
      (group) =>
        group &&
        typeof group.id === 'string' &&
        group.id.trim() &&
        typeof group.title === 'string' &&
        group.title.trim() &&
        typeof group.visibleOnLanding === 'boolean' &&
        typeof group.visibleInCabinet === 'boolean' &&
        Number.isFinite(group.sortOrder),
    ) &&
    layout.rules.every(
      (rule) =>
        rule &&
        typeof rule.id === 'string' &&
        rule.id.trim() &&
        typeof rule.prefix === 'string' &&
        rule.prefix.trim() &&
        (rule.groupId === null || typeof rule.groupId === 'string') &&
        kinds.includes(rule.kind) &&
        typeof rule.visibleOnLanding === 'boolean' &&
        typeof rule.visibleInCabinet === 'boolean' &&
        Number.isFinite(rule.sortOrder),
    )
  );
}

/** Old default titles → current names. Ids stay the same so Disk rules keep working. */
const GROUP_TITLE_UPGRADES: Record<string, Record<string, string>> = {
  zorge: { Зорге: 'Зорге 9' },
  berarina: { Берарина: 'Квартал Серебряный Бор' },
};

export function applyMaterialsGroupTitleUpgrades(layout: MaterialsFolderLayout): MaterialsFolderLayout {
  const next = cloneLayout(layout);
  for (const group of next.groups) {
    const renamed = GROUP_TITLE_UPGRADES[group.id]?.[group.title];
    if (renamed) group.title = renamed;
  }
  return next;
}

export function parseMaterialsLayout(raw: unknown): MaterialsFolderLayout {
  if (typeof raw === 'string') {
    try {
      return parseMaterialsLayout(JSON.parse(raw));
    } catch {
      return cloneLayout(DEFAULT_MATERIALS_LAYOUT);
    }
  }
  if (isValidMaterialsFolderLayout(raw)) return applyMaterialsGroupTitleUpgrades(raw);
  return cloneLayout(DEFAULT_MATERIALS_LAYOUT);
}

export function cloneLayout(layout: MaterialsFolderLayout): MaterialsFolderLayout {
  return JSON.parse(JSON.stringify(layout)) as MaterialsFolderLayout;
}

export function discoverDiskPrefixes(
  docs: Array<{ subcategory?: string | null }>,
): string[] {
  const first = new Set<string>();
  const nestedCount = new Map<string, Set<string>>();
  for (const doc of docs) {
    const parts = splitMaterialPath(doc.subcategory);
    if (!parts[0]) continue;
    first.add(parts[0]);
    if (parts[1]) {
      const children = nestedCount.get(parts[0]) || new Set<string>();
      children.add(parts[1]);
      nestedCount.set(parts[0], children);
    }
  }
  const prefixes = [...first];
  for (const [root, children] of nestedCount) {
    if (children.size < 2) continue;
    for (const child of children) prefixes.push(`${root}/${child}`);
  }
  return prefixes.sort((a, b) => a.localeCompare(b, 'ru'));
}

function ruleCoversPrefix(rulePrefix: string, diskPrefix: string): boolean {
  return (
    diskPrefix === rulePrefix ||
    diskPrefix.startsWith(`${rulePrefix}/`) ||
    rulePrefix.startsWith(`${diskPrefix}/`)
  );
}

export function mergeMaterialsLayout(
  saved: MaterialsFolderLayout,
  docs: Array<{ subcategory?: string | null }>,
): MaterialsFolderLayout {
  const layout = cloneLayout(saved);
  const seenRuleIds = new Set(layout.rules.map((rule) => rule.id));
  for (const prefix of discoverDiskPrefixes(docs)) {
    if (layout.rules.some((rule) => ruleCoversPrefix(rule.prefix, prefix))) continue;
    const id = `auto-${slugId(prefix)}`;
    if (seenRuleIds.has(id)) continue;
    layout.rules.push({
      id,
      prefix,
      groupId: null,
      kind: 'as_is',
      visibleOnLanding: true,
      visibleInCabinet: true,
      sortOrder: 100 + layout.rules.length,
    });
    seenRuleIds.add(id);
  }
  return layout;
}

function slugId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'folder';
}

export function classifyMaterialsMedia(
  doc: { type?: string | null; name?: string | null; fileUrl?: string | null; subcategory?: string | null },
): 'photo' | 'video' {
  const type = String(doc.type || '');
  const name = String(doc.name || '');
  const url = String(doc.fileUrl || '');
  const path = splitMaterialPath(doc.subcategory).join('/');
  if (/^video\//i.test(type) || VIDEO_RE.test(name) || VIDEO_RE.test(url) || VIDEO_FOLDER_RE.test(path)) {
    return 'video';
  }
  if (/^image\//i.test(type) || IMAGE_RE.test(name) || IMAGE_RE.test(url) || PHOTO_FOLDER_RE.test(path)) {
    return 'photo';
  }
  return 'photo';
}

function visibleOn(item: { visibleOnLanding: boolean; visibleInCabinet: boolean }, surface: MaterialsSurface): boolean {
  return surface === 'landing' ? item.visibleOnLanding : item.visibleInCabinet;
}

function stripMediaSegment(parts: string[]): string[] {
  if (parts.length === 0) return parts;
  if (VIDEO_FOLDER_RE.test(parts[0]) || PHOTO_FOLDER_RE.test(parts[0])) return parts.slice(1);
  return parts;
}

function matchRule(
  pathStr: string,
  layout: MaterialsFolderLayout,
  media: 'photo' | 'video',
): MaterialsFolderRule | null {
  const matches = layout.rules
    .filter((rule) => pathStr === rule.prefix || pathStr.startsWith(`${rule.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const rule of matches) {
    if (rule.kind === 'photo' && media !== 'photo') continue;
    if (rule.kind === 'video' && media !== 'video') continue;
    return rule;
  }
  return null;
}

export function withDisplaySubcategory<T extends {
  subcategory?: string | null;
  type?: string | null;
  name?: string | null;
  fileUrl?: string | null;
}>(
  docs: T[],
  layout: MaterialsFolderLayout,
  surface: MaterialsSurface,
): Array<T & { subcategory: string }> {
  const groups = new Map(layout.groups.map((group) => [group.id, group]));
  const out: Array<T & { subcategory: string }> = [];

  for (const doc of docs) {
    const parts = splitMaterialPath(doc.subcategory);
    const pathStr = parts.join('/');
    const media = classifyMaterialsMedia(doc);
    const rule = matchRule(pathStr, layout, media);
    if (!rule) {
      if (surface === 'landing') continue;
      if (!pathStr) continue;
      out.push({ ...doc, subcategory: pathStr });
      continue;
    }
    if (!visibleOn(rule, surface)) continue;

    const rest = pathStr === rule.prefix ? [] : splitMaterialPath(pathStr.slice(rule.prefix.length).replace(/^\//, ''));
    const leafName = rule.displayName || rule.prefix.split('/').pop() || rule.prefix;

    if (rule.groupId) {
      const group = groups.get(rule.groupId);
      if (!group || !visibleOn(group, surface)) continue;
      const kind = rule.kind === 'split' ? media : rule.kind;
      if (kind === 'photo' || kind === 'video') {
        const folder = kind === 'photo' ? 'Фото' : 'Видео';
        out.push({ ...doc, subcategory: [group.title, folder, ...stripMediaSegment(rest)].join('/') });
      } else {
        out.push({ ...doc, subcategory: [group.title, leafName, ...rest].join('/') });
      }
      continue;
    }

    out.push({ ...doc, subcategory: [leafName, ...rest].join('/') });
  }

  return applyLooseFolders(out, layout);
}

/** Файлы прямо в папке → виртуальная подпапка (layout.looseFolders). */
function applyLooseFolders<T extends { subcategory: string }>(docs: T[], layout: MaterialsFolderLayout): T[] {
  const loose = layout.looseFolders || {};
  const keys = Object.keys(loose).filter((key) => key && String(loose[key] || '').trim());
  if (!keys.length) return docs;
  return docs.map((doc) => {
    const path = splitMaterialPath(doc.subcategory).join('/');
    const name = loose[path];
    if (!name) return doc;
    return { ...doc, subcategory: `${path}/${String(name).trim()}` };
  });
}

export function setMaterialsLooseFolder(
  layout: MaterialsFolderLayout,
  pathKey: string,
  folderName: string | null,
): MaterialsFolderLayout {
  const next = cloneLayout(layout);
  const map = { ...(next.looseFolders || {}) };
  const key = splitMaterialPath(pathKey).join('/');
  if (!key) return next;
  if (folderName && folderName.trim()) map[key] = folderName.trim();
  else delete map[key];
  next.looseFolders = map;
  return next;
}

const COVER_PHOTO_RE = /\.(jpe?g|png|webp)(\?|#|$)/i;

function isCoverPhoto(doc: { fileUrl?: string | null; type?: string | null; name?: string | null }): boolean {
  return (
    COVER_PHOTO_RE.test(String(doc.fileUrl || '')) ||
    COVER_PHOTO_RE.test(String(doc.name || '')) ||
    doc.type === 'JPG' ||
    doc.type === 'PNG'
  );
}

/**
 * 2026-09-08: обложка папки материалов (fileUrl оригинала, без превью).
 * Порядок: явная обложка из раскладки для этого пути → первое фото внутри
 * папки → обложка родительской папки (так у видеопапок без фото появляется
 * обложка ЖК) → null (иконка).
 */
export function resolveMaterialsCover(
  layout: MaterialsFolderLayout,
  docs: Array<{ subcategory?: string | null; fileUrl?: string | null; type?: string | null; name?: string | null }>,
  pathParts: string[],
): string | null {
  const covers = layout.covers || {};
  for (let depth = pathParts.length; depth >= 1; depth -= 1) {
    const parts = pathParts.slice(0, depth);
    const key = parts.join('/');
    const explicit = covers[key];
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    const first = docs.find((doc) => {
      const path = splitMaterialPath(doc.subcategory).join('/');
      return (path === key || path.startsWith(`${key}/`)) && isCoverPhoto(doc);
    });
    if (first?.fileUrl) return String(first.fileUrl);
  }
  return null;
}

export function setMaterialsCover(
  layout: MaterialsFolderLayout,
  pathKey: string,
  fileUrl: string | null,
): MaterialsFolderLayout {
  const next = cloneLayout(layout);
  const covers = { ...(next.covers || {}) };
  const key = splitMaterialPath(pathKey).join('/');
  if (!key) return next;
  if (fileUrl && fileUrl.trim()) covers[key] = fileUrl.trim();
  else delete covers[key];
  next.covers = covers;
  return next;
}

export function materialsRootSortKey(name: string, layout: MaterialsFolderLayout): number {
  const group = layout.groups.find((item) => item.title === name);
  if (group) return group.sortOrder;
  const rule = layout.rules.find((item) => (item.displayName || item.prefix.split('/').pop()) === name && !item.groupId);
  if (rule) return rule.sortOrder;
  return 500;
}

export function sortMaterialsRootFolders(names: string[], layout: MaterialsFolderLayout): string[] {
  return [...names].sort((a, b) => {
    const order = materialsRootSortKey(a, layout) - materialsRootSortKey(b, layout);
    return order !== 0 ? order : a.localeCompare(b, 'ru');
  });
}
