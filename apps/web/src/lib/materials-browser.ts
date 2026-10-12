import { resolveMaterialsCover, type MaterialsFolderLayout } from '@shared/materials-folder-layout';
import { materialsThumbUrl } from './materials-thumb';

// Public catalog is separate from the authenticated /materials page.
export const MATERIALS_CATALOG_HREF = '/materials/catalog';
export const MATERIALS_CONDITIONS_HREF = '/materials/conditions';
export const MATERIALS_CONTACT_EMAIL = 'broker@stmichael.ru';

export interface MaterialDocument {
  id: string;
  name: string;
  description?: string | null;
  type: string;
  category: string;
  subcategory: string | null;
  project?: string | null;
  fileUrl: string;
  fileSize?: number | null;
}
/** Hide explicitly superseded cooperation files only; private cabinet materials remain available. */
export function currentMaterials<T extends { description?: string | null }>(documents: T[]): T[] {
  return documents.filter(doc => !/^\s*\[archived:cooperation-current\]/i.test(doc.description || ''));
}
export type MaterialCover = { kind: 'image' | 'video'; src: string; poster?: string; objectPosition?: string };

function approvedVictoriaCover(layout: MaterialsFolderLayout, parts: string[]): MaterialCover | null {
  const url = layout.covers?.[parts.join('/')];
  if (!url?.startsWith('/files/materials-covers/victoria-20261012/')) return null;
  const portrait = parts.join('/') === 'Зорге 9/Звездные резиденты/Фото';
  return { kind: 'image', src: url, ...(portrait ? { objectPosition: '50% 33%' } : {}) };
}

export function materialsFolderCover(layout: MaterialsFolderLayout, docs: MaterialDocument[], parts: string[]): MaterialCover | null {
  const approved = approvedVictoriaCover(layout, parts);
  if (approved) return approved;
  const project = (parts[0] || '').toLocaleLowerCase('ru');
  const knownProject = project === 'зорге 9' || project === 'квартал серебряный бор';
  if (knownProject && parts.length === 2 && parts[1] === 'Презентации') {
    return { kind: 'image', src: '/v2/materials/presentations.webp' };
  }
  if (project === 'квартал серебряный бор' && parts.length === 2 && parts[1] === 'Видео') {
    return { kind: 'video', src: '/v2/materials/silver-bor-video.mp4', poster: '/v2/materials/silver-bor-video-poster.webp' };
  }
  const url = resolveMaterialsCover(layout, docs, parts);
  if (!url) return null;
  // Full-resolution movies can be gigabytes: use their generated cover frame.
  // Only the explicitly supplied lightweight Silver Bor cover animates above.
  return { kind: 'image', src: materialsThumbUrl(url) };
}

export function materialsProjectCover(title: string, layout?: MaterialsFolderLayout): MaterialCover {
  const approved = layout && approvedVictoriaCover(layout, [title]);
  if (approved) return approved;
  return { kind: 'image', src: title.toLocaleLowerCase('ru') === 'зорге 9' ? '/v2/img/materials-zorge9.webp' : '/v2/img/materials-silver-bor.webp' };
}
export function materialsParentHref(parts: string[], href: (parts: string[]) => string): string {
  return parts.length > 1 ? href(parts.slice(0, -1)) : MATERIALS_CATALOG_HREF;
}
/** Keep standalone legacy documents accessible without adding root cards. */
export function standaloneMaterials(docs: MaterialDocument[], layout: MaterialsFolderLayout): MaterialDocument[] {
  return docs.filter(d => !layout.groups.some(g => d.subcategory === g.title || d.subcategory?.startsWith(g.title + '/')));
}
export function uniqueMaterials(docs: MaterialDocument[]): MaterialDocument[] {
  const seen = new Set<string>();
  return docs.filter(doc => { const key = doc.fileUrl || doc.id; if (seen.has(key)) return false; seen.add(key); return true; });
}
const hasExtension = (d: MaterialDocument, pattern: RegExp) => {
  // Prefer the real resource type; use the filename for extensionless download URLs.
  const hasUrlExtension = /\.[a-z0-9]{2,5}(\?|#|$)/i.test(d.fileUrl || '');
  return pattern.test(hasUrlExtension ? d.fileUrl : d.name || '');
};
export const isMaterialImage = (d: MaterialDocument) => /^image\//i.test(d.type || '') || hasExtension(d, /\.(jpe?g|png|webp|gif|svg|heic|avif|bmp|tiff?)(\?|#|$)/i);
export const isMaterialVideo = (d: MaterialDocument) => /^video\//i.test(d.type || '') || hasExtension(d, /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i);
export const isMaterialPdf = (d: MaterialDocument) => /pdf/i.test(d.type || '') || hasExtension(d, /\.pdf(\?|#|$)/i);
