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
