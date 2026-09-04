export function splitMaterialPath(subcategory: string | null | undefined): string[] {
  return String(subcategory || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function decodeMaterialsSegments(
  subcategory: string | string[] | undefined,
): string[] {
  const raw = Array.isArray(subcategory) ? subcategory : subcategory ? [subcategory] : [];
  return raw
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .filter(Boolean);
}

export function fileCountUnder<T extends { subcategory?: string | null }>(
  docs: T[],
  prefix: string[],
): number {
  if (prefix.length === 0) return docs.length;
  const key = prefix.join('/');
  return docs.filter((doc) => {
    const path = splitMaterialPath(doc.subcategory).join('/');
    return path === key || path.startsWith(`${key}/`);
  }).length;
}

export function foldersAndFilesAt<T extends { subcategory?: string | null }>(
  docs: T[],
  prefix: string[],
) {
  const prefixKey = prefix.join('/');
  const folders = new Set<string>();
  const files: T[] = [];

  for (const doc of docs) {
    const parts = splitMaterialPath(doc.subcategory);
    if (prefix.length === 0) {
      if (parts[0]) folders.add(parts[0]);
      if (parts.length === 0) files.push(doc);
      continue;
    }
    if (parts.slice(0, prefix.length).join('/') !== prefixKey) continue;
    if (parts.length === prefix.length) files.push(doc);
    else if (parts[prefix.length]) folders.add(parts[prefix.length]);
  }

  return {
    folders: [...folders].sort((a, b) => a.localeCompare(b, 'ru')),
    files,
  };
}

export function materialHref(parts: string[]): string {
  return `/materials/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
}

// 2026-09-04: медиа-счётчики для превью-карточек папок (лендинг + /materials).
const PHOTO_RE = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|avi|mkv)$/i;

export function filesUnder<T extends { subcategory?: string | null }>(
  docs: T[],
  prefix: string[],
): T[] {
  const key = prefix.join('/');
  return docs.filter((doc) => {
    const path = splitMaterialPath(doc.subcategory).join('/');
    return path === key || path.startsWith(`${key}/`);
  });
}

export function isPhotoDoc(doc: { fileUrl?: string | null; type?: string | null }): boolean {
  return PHOTO_RE.test(String(doc.fileUrl || '')) || doc.type === 'JPG' || doc.type === 'PNG';
}

export function mediaCountsUnder(
  docs: Array<{ subcategory?: string | null; fileUrl?: string | null; type?: string | null; name?: string | null }>,
  prefix: string[],
): { photos: number; videos: number; other: number } {
  let photos = 0, videos = 0, other = 0;
  for (const d of filesUnder(docs, prefix)) {
    const u = String(d.fileUrl || d.name || '');
    if (isPhotoDoc(d)) photos++;
    else if (VIDEO_RE.test(u) || d.type === 'MP4' || d.type === 'MOV') videos++;
    else other++;
  }
  return { photos, videos, other };
}

export function mediaCountsLabel(c: { photos: number; videos: number; other: number }): string {
  const parts: string[] = [];
  if (c.photos) parts.push(`${c.photos} фото`);
  if (c.videos) parts.push(`${c.videos} видео`);
  if (!parts.length) return `${c.other} файлов`;
  if (c.other) parts.push(`${c.other} док.`);
  return parts.join(' · ');
}
