'use client';

// КБ6 (2026-05-25): редизайн материалов.
// — Категории — аккордеон, по умолчанию свёрнуты, раскрываются только по клику.
// — Документы — обычный список со ссылкой.
// — Фотографии (image/* + jpg/png/webp) — плитка превью; клик открывает
//   модальный просмотрщик с навигацией prev/next.

import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '@/lib/api';
import { BookOpen, ExternalLink, ChevronDown, ChevronUp, X, ChevronLeft, ChevronRight, Image as ImageIcon, FileText, Play, FileType } from 'lucide-react';

interface DocItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  category: string;
  subcategory: string | null;
  fileUrl: string;
  fileSize: number | null;
}

// 2026-05-28: regex match расширение в конце строки ИЛИ перед ?/#/&
const IMAGE_RE = /\.(jpe?g|png|webp|gif|svg|heic|avif|bmp|tiff?)(\?|#|$)/i;
const VIDEO_RE = /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i;
const PDF_RE = /\.pdf(\?|#|$)/i;
const isImage = (d: DocItem) =>
  /^image\//i.test(d.type || '') ||
  /^(jpe?g|png|webp|gif|svg|heic|avif|bmp|tiff?)$/i.test(d.type || '') ||
  IMAGE_RE.test(d.fileUrl || '') ||
  IMAGE_RE.test(d.name || '');
const isVideo = (d: DocItem) =>
  /^video\//i.test(d.type || '') ||
  /^(mp4|mov|webm|m4v|avi|mkv)$/i.test(d.type || '') ||
  VIDEO_RE.test(d.fileUrl || '') ||
  VIDEO_RE.test(d.name || '');
const isPdf = (d: DocItem) =>
  /pdf/i.test(d.type || '') ||
  PDF_RE.test(d.fileUrl || '') ||
  PDF_RE.test(d.name || '');

function PhotoViewer({
  items,
  index,
  onClose,
  onIndex,
}: {
  items: DocItem[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const cur = items[index];
  if (!cur) return null;
  const prev = () => onIndex((index - 1 + items.length) % items.length);
  const next = () => onIndex((index + 1) % items.length);

  return (
    <div
      className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 text-white/80 hover:text-white"
        onClick={onClose}
        aria-label="Закрыть"
      >
        <X className="w-6 h-6" />
      </button>
      {items.length > 1 && (
        <>
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-2 rounded-full bg-black/40"
            onClick={(e) => { e.stopPropagation(); prev(); }}
            aria-label="Назад"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-2 rounded-full bg-black/40"
            onClick={(e) => { e.stopPropagation(); next(); }}
            aria-label="Вперёд"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </>
      )}
      <div className="max-w-[90vw] max-h-[90vh] w-full" onClick={(e) => e.stopPropagation()}>
        {isVideo(cur) ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={cur.fileUrl} controls autoPlay className="max-w-full max-h-[80vh] mx-auto block" />
        ) : isPdf(cur) ? (
          <iframe src={cur.fileUrl} className="w-full bg-white" style={{ height: '80vh' }} title={cur.name} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cur.fileUrl} alt={cur.name} className="max-w-full max-h-[80vh] object-contain mx-auto" />
        )}
        <div className="mt-2 text-center text-white/80 text-sm">
          {cur.name} <span className="text-white/40">· {index + 1} / {items.length}</span>
        </div>
      </div>
    </div>
  );
}

export default function MaterialsPage() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [viewer, setViewer] = useState<{ items: DocItem[]; index: number } | null>(null);

  useEffect(() => {
    Promise.all([
      apiGet('/documents?category=marketing&limit=200').catch(() => ({ documents: [] })),
      apiGet('/documents?category=materials&limit=200').catch(() => ({ documents: [] })),
    ])
      .then(([a, b]) => setDocs([...(a.documents || []), ...(b.documents || [])]))
      .finally(() => setLoading(false));
  }, []);

  const groups = useMemo(() => {
    const g: Record<string, DocItem[]> = {};
    for (const d of docs) {
      const key = d.subcategory || 'Без категории';
      if (!g[key]) g[key] = [];
      g[key].push(d);
    }
    return g;
  }, [docs]);

  const groupNames = Object.keys(groups).sort();

  const toggle = (g: string) => setOpenGroups((s) => ({ ...s, [g]: !s[g] }));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Материалы для брокеров</h1>
        <p className="text-text-muted text-sm mt-1">
          Готовый контент для продвижения проектов ST Michael
        </p>
      </div>

      {loading ? (
        <div className="card text-center py-8 text-text-muted">Загрузка...</div>
      ) : docs.length === 0 ? (
        <div className="card text-center py-12 text-text-muted">
          <BookOpen className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
          <p>Материалы пока не добавлены</p>
          <p className="text-xs mt-2">По вопросам обращайтесь в отдел партнёров: <a href="tel:+74992262249" className="text-accent">+7 (499) 226-22-49</a></p>
        </div>
      ) : (
        <div className="space-y-3">
          {groupNames.map((groupName) => {
            const items = groups[groupName];
            const images = items.filter(isImage);
            const videos = items.filter(isVideo);
            const pdfs = items.filter(isPdf);
            const docsList = items.filter((d) => !isImage(d) && !isVideo(d) && !isPdf(d));
            const isOpen = !!openGroups[groupName];
            return (
              <div key={groupName} className="card p-0 overflow-hidden">
                <button
                  className="w-full flex items-center justify-between p-4 hover:bg-surface-secondary transition text-left"
                  onClick={() => toggle(groupName)}
                >
                  <div>
                    <h3 className="font-semibold">{groupName}</h3>
                    <p className="text-xs text-text-muted mt-0.5">
                      {items.length} {items.length === 1 ? 'элемент' : items.length < 5 ? 'элемента' : 'элементов'}
                      {images.length > 0 && ` · ${images.length} фото`}
                      {videos.length > 0 && ` · ${videos.length} видео`}
                      {pdfs.length > 0 && ` · ${pdfs.length} PDF`}
                    </p>
                  </div>
                  {isOpen ? <ChevronUp className="w-5 h-5 text-text-muted" /> : <ChevronDown className="w-5 h-5 text-text-muted" />}
                </button>
                {isOpen && (
                  <div className="p-4 border-t border-border space-y-4">
                    {images.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-text-muted mb-2 flex items-center gap-1">
                          <ImageIcon className="w-3 h-3" /> Фотографии
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                          {images.map((img, i) => (
                            <button
                              key={img.id}
                              className="bg-surface-secondary rounded-lg overflow-hidden aspect-square hover:ring-2 hover:ring-accent/50 transition"
                              onClick={() => setViewer({ items: images, index: i })}
                              title={img.name}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={img.fileUrl}
                                alt={img.name}
                                className="w-full h-full object-cover"
                                loading="lazy"
                              />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {videos.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-text-muted mb-2 flex items-center gap-1">
                          <Play className="w-3 h-3" /> Видео
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                          {videos.map((v, i) => (
                            <button
                              key={v.id}
                              className="bg-black rounded-lg overflow-hidden aspect-square hover:ring-2 hover:ring-accent/50 transition relative group"
                              onClick={() => setViewer({ items: videos, index: i })}
                              title={v.name}
                            >
                              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                              <video
                                src={v.fileUrl}
                                className="w-full h-full object-cover"
                                preload="metadata"
                                muted
                              />
                              <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/10 transition">
                                <Play className="w-10 h-10 text-white fill-white" />
                              </div>
                              <div className="absolute bottom-0 left-0 right-0 text-white text-xs px-2 py-1 bg-gradient-to-t from-black/80 to-transparent truncate text-left">
                                {v.name}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {pdfs.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-text-muted mb-2 flex items-center gap-1">
                          <FileType className="w-3 h-3" /> PDF
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {pdfs.map((p, i) => (
                            <button
                              key={p.id}
                              className="flex items-center gap-3 p-3 rounded-lg bg-surface-secondary hover:ring-2 hover:ring-accent/50 transition text-left"
                              onClick={() => setViewer({ items: pdfs, index: i })}
                              title={p.name}
                            >
                              <div className="w-12 h-14 bg-error/20 rounded flex items-center justify-center flex-shrink-0">
                                <FileType className="w-6 h-6 text-error" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate">{p.name}</div>
                                <div className="text-xs text-text-muted">PDF</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {docsList.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-text-muted mb-2 flex items-center gap-1">
                          <FileText className="w-3 h-3" /> Документы
                        </div>
                        <div className="space-y-1">
                          {docsList.map((d) => (
                            <a
                              key={d.id}
                              href={d.fileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-surface-secondary cursor-pointer transition"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate">{d.name}</div>
                                {d.description && <div className="text-xs text-text-muted truncate">{d.description}</div>}
                              </div>
                              <ExternalLink className="w-4 h-4 text-text-muted flex-shrink-0 ml-2" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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

      {viewer && (
        <PhotoViewer
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onIndex={(i) => setViewer({ items: viewer.items, index: i })}
        />
      )}
    </div>
  );
}
