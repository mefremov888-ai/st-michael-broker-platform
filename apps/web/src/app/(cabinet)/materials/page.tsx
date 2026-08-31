'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { Folder } from 'lucide-react';
import { foldersAndFilesAt, materialHref } from '@/lib/materials-folder-tree';

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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet('/documents?category=materials&limit=2000')
      .then((res: any) => setDocs(res?.documents || []))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }, []);

  const { folders } = useMemo(() => foldersAndFilesAt(docs, []), [docs]);
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const folder of folders) {
      result[folder] = foldersAndFilesAt(docs, [folder]).files.length
        + docs.filter((d) => (d.subcategory || '').startsWith(`${folder}/`)).length;
    }
    return result;
  }, [docs, folders]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Материалы для брокеров</h1>
        <p className="text-text-muted text-sm mt-1">Папки как на Яндекс.Диске: проект → альбом → файлы</p>
      </div>

      {loading ? (
        <div className="card text-center py-8 text-text-muted">Загрузка...</div>
      ) : folders.length === 0 ? (
        <div className="card text-center py-8 text-text-muted">Материалы ещё не загружены</div>
      ) : (
        <div data-tour="materials-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {folders.map((folder) => (
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
              <div style={{ color: '#B4936F' }}><Folder size={40} strokeWidth={1.2} /></div>
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
