'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { Film, BarChart2, Camera, Box, FileText } from 'lucide-react';

interface DocItem {
  id: string;
  name: string;
  type: string;
  category: string;
  subcategory: string | null;
  fileUrl: string;
  fileSize: number | null;
}

const CANONICAL_CATS = ['Reels', 'Презентации', 'Фотографии', 'Рендеры', 'Тексты'] as const;
type CanonicalCat = typeof CANONICAL_CATS[number];

const SUBCATEGORY_MAP: Record<CanonicalCat, string[]> = {
  'Reels': ['Reels', 'Для роликов сторис reels'],
  'Презентации': ['Презентации', 'Презентация Квартал Серебряный Бор'],
  'Фотографии': ['Фотографии', 'Зорге9 (фото)', 'Зорге 9 (фото)'],
  'Рендеры': ['Рендеры'],
  'Тексты': ['Тексты', 'Условия вознаграждения', 'Актуальные условия рассрочки'],
};

const CAT_ICONS: Record<CanonicalCat, React.ReactNode> = {
  'Reels': <Film size={40} strokeWidth={1.2} />,
  'Презентации': <BarChart2 size={40} strokeWidth={1.2} />,
  'Фотографии': <Camera size={40} strokeWidth={1.2} />,
  'Рендеры': <Box size={40} strokeWidth={1.2} />,
  'Тексты': <FileText size={40} strokeWidth={1.2} />,
};

export default function MaterialsPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet('/documents?category=marketing&limit=200').catch(() => ({ documents: [] })),
      apiGet('/documents?category=materials&limit=200').catch(() => ({ documents: [] })),
    ])
      .then(([a, b]: any[]) => setDocs([...(a.documents || []), ...(b.documents || [])]))
      .finally(() => setLoading(false));
  }, []);

  const counts = useMemo(() => {
    const result: Record<CanonicalCat, number> = { Reels: 0, Презентации: 0, Фотографии: 0, Рендеры: 0, Тексты: 0 };
    for (const d of docs) {
      const sub = (d.subcategory || '').trim().toLowerCase();
      for (const cat of CANONICAL_CATS) {
        if (SUBCATEGORY_MAP[cat].some((alias) => alias.toLowerCase() === sub)) {
          result[cat]++;
          break;
        }
      }
    }
    return result;
  }, [docs]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Материалы для брокеров</h1>
        <p className="text-text-muted text-sm mt-1">Готовый контент для продвижения проектов ST Michael</p>
      </div>

      {loading ? (
        <div className="card text-center py-8 text-text-muted">Загрузка...</div>
      ) : (
        <div data-tour="materials-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {CANONICAL_CATS.map((cat) => (
            <button
              key={cat}
              onClick={() => router.push(`/materials/${encodeURIComponent(cat)}`)}
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
              <div style={{ color: '#B4936F' }}>{CAT_ICONS[cat]}</div>
              <div style={{ fontSize: 14, fontWeight: 600, textAlign: 'center' }}>{cat}</div>
              {counts[cat] > 0 && (
                <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.4)' }}>{counts[cat]} файлов</div>
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
