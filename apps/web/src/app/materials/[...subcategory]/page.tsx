'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  FileText,
  Image as ImageIcon,
  Play,
  FileType,
  Download,
  X,
  ChevronLeft,
  ChevronRight,
  Folder,
} from 'lucide-react';
import {
  decodeMaterialsSegments,
  fileCountUnder,
  filesUnder,
  foldersAndFilesAt,
  isPhotoDoc,
  materialHref,
  mediaCountsLabel,
  mediaCountsUnder,
} from '@/lib/materials-folder-tree';
import { materialsThumbUrl } from '@/lib/materials-thumb';
import {
  DEFAULT_MATERIALS_LAYOUT,
  parseMaterialsLayout,
  withDisplaySubcategory,
  type MaterialsFolderLayout,
} from '@shared/materials-folder-layout';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

interface DocItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  category: string;
  subcategory: string | null;
  project: string | null;
  fileUrl: string;
  fileSize: number | null;
}

const IMAGE_RE = /\.(jpe?g|png|webp|gif|svg|heic|avif|bmp|tiff?)(\?|#|$)/i;
const VIDEO_RE = /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i;
const PDF_RE = /\.pdf(\?|#|$)/i;

function ThumbImage({ src, alt }: { src: string; alt: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={materialsThumbUrl(src)}
      alt={alt}
      style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0, transition: 'opacity 0.2s' }}
      loading="lazy"
      decoding="async"
      onLoad={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '1'; }}
      onError={(e) => {
        const el = e.currentTarget as HTMLImageElement;
        el.style.opacity = '1';
        el.style.background = 'rgba(255,255,255,0.06)';
        el.removeAttribute('src');
      }}
    />
  );
}

const isImage = (d: DocItem) =>
  /^image\//i.test(d.type || '') || IMAGE_RE.test(d.fileUrl || '') || IMAGE_RE.test(d.name || '');
const isVideo = (d: DocItem) =>
  /^video\//i.test(d.type || '') || VIDEO_RE.test(d.fileUrl || '') || VIDEO_RE.test(d.name || '');
const isPdf = (d: DocItem) =>
  /pdf/i.test(d.type || '') || PDF_RE.test(d.fileUrl || '') || PDF_RE.test(d.name || '');

function Viewer({
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

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <button
        style={{ position: 'absolute', top: 16, right: 16, color: '#fff', background: 'none', border: 'none', cursor: 'pointer', fontSize: 24 }}
        onClick={onClose}
        aria-label="Закрыть"
      >
        <X size={28} />
      </button>
      {items.length > 1 && (
        <>
          <button
            style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: '#fff', background: 'rgba(0,0,0,0.4)', border: 'none', borderRadius: '50%', width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={(e) => { e.stopPropagation(); onIndex((index - 1 + items.length) % items.length); }}
          >
            <ChevronLeft size={24} />
          </button>
          <button
            style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', color: '#fff', background: 'rgba(0,0,0,0.4)', border: 'none', borderRadius: '50%', width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % items.length); }}
          >
            <ChevronRight size={24} />
          </button>
        </>
      )}
      <div style={{ maxWidth: '90vw', maxHeight: '90vh' }} onClick={(e) => e.stopPropagation()}>
        {isVideo(cur) ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={cur.fileUrl} controls autoPlay style={{ maxWidth: '100%', maxHeight: '80vh' }} />
        ) : isPdf(cur) ? (
          <iframe src={cur.fileUrl} style={{ width: '80vw', height: '80vh', background: '#fff' }} title={cur.name} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cur.fileUrl} alt={cur.name} style={{ maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain' }} />
        )}
        <div style={{ marginTop: 8, textAlign: 'center', color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
          {cur.name} <span style={{ color: 'rgba(255,255,255,0.4)' }}>· {index + 1} / {items.length}</span>
        </div>
      </div>
    </div>
  );
}

export default function MaterialsFolderPage() {
  const params = useParams<{ subcategory: string[] }>();
  const router = useRouter();
  const parts = decodeMaterialsSegments(params.subcategory);

  const [docs, setDocs] = useState<DocItem[]>([]);
  const [layout, setLayout] = useState<MaterialsFolderLayout>(DEFAULT_MATERIALS_LAYOUT);
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<{ items: DocItem[]; index: number } | null>(null);
  const [photoLimit, setPhotoLimit] = useState(30);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/api/public/documents?category=materials&limit=2000`).then((r) => r.json()),
      fetch(`${API_BASE}/api/public/documents/layout`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([data, layoutRes]) => {
        setDocs(Array.isArray(data) ? data : []);
        if (layoutRes?.layout) setLayout(parseMaterialsLayout(layoutRes.layout));
      })
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }, []);

  const mapped = useMemo(
    () => withDisplaySubcategory(docs, layout, 'landing'),
    [docs, layout],
  );
  const displayView = useMemo(() => foldersAndFilesAt(mapped, parts), [mapped, parts]);
  const rawView = useMemo(() => foldersAndFilesAt(docs, parts), [docs, parts]);
  const usingDisplay = displayView.folders.length > 0 || displayView.files.length > 0;
  const { folders, files } = usingDisplay ? displayView : rawView;
  const countDocs = usingDisplay ? mapped : docs;
  const images = files.filter(isImage);
  const videos = files.filter(isVideo);
  const pdfs = files.filter(isPdf);
  const other = files.filter((d) => !isImage(d) && !isVideo(d) && !isPdf(d));
  const title = parts[parts.length - 1] || 'Материалы';
  const parentHref = parts.length > 1 ? materialHref(parts.slice(0, -1)) : '/#materials';
  const empty = !loading && folders.length === 0 && files.length === 0;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0d0d0d)', color: 'var(--fg, #fff)', fontFamily: 'var(--font-body, sans-serif)', padding: '0 0 80px' }}>
      <div style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', padding: '20px 32px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <button
          onClick={() => router.push(parentHref)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'rgba(255,255,255,0.6)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: 0 }}
        >
          <ArrowLeft size={16} />
          Назад
        </button>
        <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
        <Folder size={20} color="var(--gold, #B4936F)" />
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{title}</h1>
      </div>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 32px 0' }}>
        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 28, fontSize: 13, color: 'rgba(255,255,255,0.45)' }}>
          <a href="/#materials" style={{ color: 'rgba(255,255,255,0.45)', textDecoration: 'none' }}>Материалы</a>
          {parts.map((part, index) => {
            const href = materialHref(parts.slice(0, index + 1));
            const last = index === parts.length - 1;
            return (
              <span key={href} style={{ display: 'flex', gap: 6 }}>
                <span>/</span>
                {last ? (
                  <span style={{ color: 'rgba(255,255,255,0.85)' }}>{part}</span>
                ) : (
                  <a href={href} style={{ color: 'rgba(255,255,255,0.45)', textDecoration: 'none' }}>{part}</a>
                )}
              </span>
            );
          })}
        </nav>

        {loading ? (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', padding: '80px 0', fontSize: 15 }}>Загрузка...</div>
        ) : empty ? (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', padding: '80px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📁</div>
            <div style={{ fontSize: 16, marginBottom: 8 }}>В этой папке пока нет файлов</div>
            <div style={{ fontSize: 13 }}>По вопросам: <a href="tel:+74992262249" style={{ color: 'var(--gold, #c9a96e)' }}>+7 (499) 226-22-49</a></div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
            {folders.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, color: 'rgba(255,255,255,0.5)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  <Folder size={14} /> Папки ({folders.length})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
                  {folders.map((folder, folderIdx) => {
                    const nested = [...parts, folder];
                    // 2026-09-04: превью-карточка в стиле медиатеки — номер,
                    // курсивное название, обложка из первого фото, счётчик.
                    const counts = mediaCountsUnder(countDocs, nested);
                    const coverDoc = filesUnder(countDocs, nested).find(isPhotoDoc);
                    const cover = coverDoc ? materialsThumbUrl((coverDoc as any).fileUrl) : null;
                    return (
                      <a
                        key={folder}
                        href={materialHref(nested)}
                        style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px 10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, textDecoration: 'none', color: '#fff' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                          <span style={{ fontFamily: 'Georgia,serif', fontStyle: 'italic', fontSize: 12, color: 'var(--gold, #B4936F)' }}>{String(folderIdx + 1).padStart(2, '0')}</span>
                          <span style={{ fontFamily: 'Georgia,serif', fontStyle: 'italic', fontSize: 15, lineHeight: 1.25, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{folder}</span>
                          <span style={{ color: 'var(--gold, #B4936F)', fontSize: 13 }}>↗</span>
                        </div>
                        {cover ? (
                          <div style={{ aspectRatio: '16/10', borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,0.06)' }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={cover} alt={folder} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          </div>
                        ) : (
                          <div style={{ aspectRatio: '16/10', borderRadius: 4, background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Folder size={30} color="var(--gold, #B4936F)" />
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{mediaCountsLabel(counts)}</div>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {images.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, color: 'rgba(255,255,255,0.5)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  <ImageIcon size={14} /> Фотографии ({images.length})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
                  {images.slice(0, photoLimit).map((img, i) => (
                    <button
                      key={img.id}
                      onClick={() => setViewer({ items: images, index: i })}
                      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden', aspectRatio: '1', cursor: 'pointer', padding: 0, position: 'relative' }}
                      title={img.name}
                    >
                      <ThumbImage src={img.fileUrl} alt={img.name} />
                    </button>
                  ))}
                </div>
                {images.length > photoLimit && (
                  <button
                    onClick={() => setPhotoLimit((prev) => prev + 30)}
                    style={{ marginTop: 16, width: '100%', padding: '12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'rgba(255,255,255,0.7)', fontSize: 13, cursor: 'pointer' }}
                  >
                    Загрузить ещё ({images.length - photoLimit} фото)
                  </button>
                )}
              </div>
            )}

            {videos.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, color: 'rgba(255,255,255,0.5)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  <Play size={14} /> Видео ({videos.length})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                  {videos.map((v, i) => (
                    <button
                      key={v.id}
                      onClick={() => setViewer({ items: videos, index: i })}
                      style={{ background: '#000', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden', aspectRatio: '16/9', cursor: 'pointer', padding: 0, position: 'relative' }}
                      title={v.name}
                    >
                      <ThumbImage src={v.fileUrl} alt={v.name} />
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
                        <Play size={36} color="#fff" fill="#fff" />
                      </div>
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '6px 8px', background: 'linear-gradient(transparent, rgba(0,0,0,0.8))', fontSize: 11, color: '#fff', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {v.name}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {pdfs.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, color: 'rgba(255,255,255,0.5)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  <FileType size={14} /> PDF ({pdfs.length})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
                  {pdfs.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setViewer({ items: pdfs, index: pdfs.indexOf(p) })}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, cursor: 'pointer', textAlign: 'left' }}
                    >
                      <div style={{ width: 40, height: 48, background: 'rgba(239,68,68,0.15)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <FileType size={20} color="#ef4444" />
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>PDF</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {other.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, color: 'rgba(255,255,255,0.5)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  <FileText size={14} /> Документы ({other.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {other.map((d) => (
                    <a
                      key={d.id}
                      href={d.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, textDecoration: 'none', color: '#fff' }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                        {d.description && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.description}</div>}
                      </div>
                      <Download size={14} color="rgba(255,255,255,0.4)" style={{ flexShrink: 0, marginLeft: 12 }} />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 60, padding: '20px 24px', background: 'rgba(255,255,255,0.04)', borderRadius: 12, textAlign: 'center', fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
          По вопросам получения материалов:&nbsp;
          <a href="tel:+74992262249" style={{ color: 'var(--gold, #c9a96e)' }}>+7 (499) 226-22-49</a>
          <span style={{ margin: '0 12px', color: 'rgba(255,255,255,0.2)' }}>•</span>
          <a href="mailto:info@zorge9.com" style={{ color: 'var(--gold, #c9a96e)' }}>info@zorge9.com</a>
        </div>
      </div>

      {viewer && (
        <Viewer
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onIndex={(i) => setViewer({ items: viewer.items, index: i })}
        />
      )}
    </div>
  );
}
