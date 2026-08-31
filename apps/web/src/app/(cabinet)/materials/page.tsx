'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { Building2, Folder } from 'lucide-react';
import { foldersAndFilesAt, materialHref } from '@/lib/materials-folder-tree';
import {
  DEFAULT_MATERIALS_LAYOUT,
  parseMaterialsLayout,
  sortMaterialsRootFolders,
  withDisplaySubcategory,
  type MaterialsFolderLayout,
} from '@shared/materials-folder-layout';

interface DocItem {
  id: string;
  name: string;
  type: string;
  category: string;
  subcategory: string | null;
  fileUrl: string;
  fileSize: number | null;
}

export default function MaterialsPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [layout, setLayout] = useState<MaterialsFolderLayout>(DEFAULT_MATERIALS_LAYOUT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet('/documents?category=materials&limit=2000'),
      fetch('/api/public/documents/layout', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([docsRes, publicLayout]) => {
        setDocs(docsRes?.documents || []);
        if (publicLayout?.layout) setLayout(parseMaterialsLayout(publicLayout.layout));
      })
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }, []);

  const mapped = useMemo(
    () => withDisplaySubcategory(docs, layout, 'cabinet'),
    [docs, layout],
  );
  const { folders } = useMemo(() => foldersAndFilesAt(mapped, []), [mapped]);
  const roots = useMemo(() => sortMaterialsRootFolders(folders, layout), [folders, layout]);
  const groupTitles = layout.groups.map((group) => group.title);
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const folder of roots) {
      result[folder] = mapped.filter((doc) => {
        const path = (doc.subcategory || '').split('/');
        return path[0] === folder;
      }).length;
    }
    return result;
  }, [mapped, roots]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Материалы для брокеров</h1>
        <p className="text-text-muted text-sm mt-1">Условия и презентации отдельно. Фото и видео — внутри ЖК Зорге и Берарина.</p>
      </div>

      {loading ? (
        <div className="card text-center py-8 text-text-muted">Загрузка...</div>
      ) : roots.length === 0 ? (
        <div className="card text-center py-8 text-text-muted">Материалы ещё не загружены</div>
      ) : (
        <div data-tour="materials-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {roots.map((folder) => (
            <button
              key={folder}
              onClick={() => router.push(materialHref([folder]))}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                padding: '36px 16px 28px',
                background: '#f5efe8',
                border: '1px solid rgba(180,147,111,0.25)',
                borderRadius: 16,
                cursor: 'pointer',
                transition: 'background 0.15s',
                color: '#1a1a1a',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#ede2d4')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#f5efe8')}
            >
              <div style={{ color: '#B4936F' }}>
                {groupTitles.includes(folder)
                  ? <Building2 size={40} strokeWidth={1.2} />
                  : <Folder size={40} strokeWidth={1.2} />}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, textAlign: 'center' }}>{folder}</div>
              {counts[folder] > 0 && (
                <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.4)' }}>{counts[folder]} файлов</div>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="card mt-6 text-center py-6 bg-surface-secondary">
        <p className="text-text-muted text-sm">
          По вопросам получения материалов:&nbsp;
          <a href="tel:+74992262249" className="text-accent font-medium">+7 (499) 226-22-49</a>
          <span className="text-text-muted mx-3">•</span>
          <a href="mailto:info@zorge9.com" className="text-accent font-medium">info@zorge9.com</a>
        </p>
      </div>
    </div>
  );
}
