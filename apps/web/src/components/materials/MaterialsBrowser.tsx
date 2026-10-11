'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownRight, ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, Download, FileText, Folder, Image as ImageIcon, Play, X } from 'lucide-react';
import { PublicHeader } from '@/components/public/PublicHeader';
import { apiGet } from '@/lib/api';
import { findInstallmentCalculator, materialDownloadAttributes, safeMaterialUrl } from '@/lib/materials-actions';
import { foldersAndFilesAt, materialHref, mediaCountsLabel, mediaCountsUnder } from '@/lib/materials-folder-tree';
import { materialsThumbUrl } from '@/lib/materials-thumb';
import {
  MATERIALS_CATALOG_HREF, MATERIALS_CONDITIONS_HREF, MATERIALS_CONTACT_EMAIL,
  isMaterialImage, isMaterialPdf, isMaterialVideo, materialsFolderCover,
  materialsParentHref, materialsProjectCover, standaloneMaterials, uniqueMaterials,
  currentMaterials,
  type MaterialCover, type MaterialDocument,
} from '@/lib/materials-browser';
import { DEFAULT_MATERIALS_LAYOUT, parseMaterialsLayout, withDisplaySubcategory, type MaterialsFolderLayout } from '@shared/materials-folder-layout';
import './materials-browser.css';

function Thumbnail({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="mb-card-placeholder"><ImageIcon size={36} aria-hidden="true" /><span>Предпросмотр недоступен</span></div>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function Cover({ cover, title }: { cover: MaterialCover | null; title: string }) {
  const [animate, setAnimate] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAnimate(!preference.matches);
    update(); preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  if (!cover) return <div className="mb-card-placeholder"><Folder size={48} aria-hidden="true" /></div>;
  if (cover.kind === 'image' || failed) return <Thumbnail src={cover.poster || cover.src} alt={title} />;
  return <video src={animate ? cover.src : undefined} poster={cover.poster} autoPlay={animate} muted loop playsInline preload="none" aria-hidden="true" onError={() => setFailed(true)} />;
}

function FolderCard({ title, meta, href, cover }: { title: string; meta: string; href: string; cover: MaterialCover | null }) {
  return <Link href={href} className="mb-card" data-material-folder={title}>
    <div className="mb-card-heading"><div><h2 className="mb-card-title">{title}</h2><p className="mb-card-meta">{meta}</p></div><ArrowDownRight className="mb-card-arrow" size={22} aria-hidden="true" /></div>
    <div className="mb-card-media"><Cover key={cover?.src || title} cover={cover} title={title} /></div>
  </Link>;
}

function DownloadLink({ doc }: { doc: MaterialDocument }) {
  const action = materialDownloadAttributes(doc, typeof window === 'undefined' ? undefined : window.location.origin);
  if (!action) return <span className="mb-unavailable">Файл недоступен</span>;
  const { label, ...attributes } = action;
  return <a {...attributes} className="mb-button mb-download" data-material-download={doc.id} aria-label={`${label}: ${doc.name}`}>
    <Download size={18} aria-hidden="true" /><span>{label}</span>
  </a>;
}

function MaterialViewer({ items, index, onClose, onIndex }: { items: MaterialDocument[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const current = items[index];
  const mediaUrl = current && safeMaterialUrl(current.fileUrl, typeof window === 'undefined' ? undefined : window.location.origin)?.href;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; closeRef.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],video[controls],iframe') || []);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (event.target instanceof HTMLVideoElement) return;
      if (event.key === 'ArrowLeft' && items.length > 1) { event.preventDefault(); onIndex((index - 1 + items.length) % items.length); }
      if (event.key === 'ArrowRight' && items.length > 1) { event.preventDefault(); onIndex((index + 1) % items.length); }
    };
    document.addEventListener('keydown', keyDown);
    return () => document.removeEventListener('keydown', keyDown);
  }, [index, items.length, onClose, onIndex]);
  if (!current || typeof document === 'undefined') return null;
  return createPortal(<div className="mb-viewer" ref={dialogRef} role="dialog" aria-modal="true" aria-label={current.name}>
    <div className="mb-viewer-backdrop" onClick={onClose} />
    <div className="mb-viewer-panel">
      <div className="mb-viewer-toolbar"><span className="mb-viewer-counter" aria-live="polite">{index + 1} / {items.length}</span><button type="button" className="mb-viewer-close" ref={closeRef} onClick={onClose} aria-label="Закрыть"><X size={24} /></button></div>
      <div className="mb-viewer-body">
        {!mediaUrl || failedId === current.id ? <div className="mb-viewer-unavailable" role="status"><FileText size={36} aria-hidden="true" /><p>Предпросмотр недоступен. Оригинальный файл можно скачать ниже.</p></div>
          : isMaterialVideo(current) ? <video key={current.id} src={mediaUrl} controls autoPlay playsInline preload="metadata" tabIndex={0} onError={() => setFailedId(current.id)} />
          : isMaterialPdf(current) ? <iframe key={current.id} src={mediaUrl} title={current.name} tabIndex={0} />
            // eslint-disable-next-line @next/next/no-img-element
            : <img key={current.id} src={mediaUrl} alt={current.name} onError={() => setFailedId(current.id)} />}
      </div>
      <footer className="mb-viewer-actions">
        <div className="mb-viewer-file-name">{current.name}</div>
        <div className="mb-viewer-action-buttons"><DownloadLink doc={current} />{items.length > 1 && <div className="mb-viewer-pagination"><button type="button" className="mb-viewer-nav" onClick={() => onIndex((index - 1 + items.length) % items.length)} aria-label="Предыдущий файл"><ChevronLeft size={22} /></button><button type="button" className="mb-viewer-nav" onClick={() => onIndex((index + 1) % items.length)} aria-label="Следующий файл"><ChevronRight size={22} /></button></div>}</div>
      </footer>
    </div>
  </div>, document.body);
}

async function publicJson(path: string, signal: AbortSignal) {
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('Materials request failed');
  return response.json();
}

export function MaterialsBrowser({ parts = [], surface = 'landing', embedded = false }: { parts?: string[]; surface?: 'landing' | 'cabinet'; embedded?: boolean }) {
  const catalog = parts.length === 0;
  const conditions = parts.length === 1 && parts[0] === 'conditions';
  const [docs, setDocs] = useState<MaterialDocument[]>([]);
  const [terms, setTerms] = useState<MaterialDocument[]>([]);
  const [termsError, setTermsError] = useState(false);
  const [layout, setLayout] = useState<MaterialsFolderLayout>(DEFAULT_MATERIALS_LAYOUT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [photoLimit, setPhotoLimit] = useState(30);
  const [viewer, setViewer] = useState<{ items: MaterialDocument[]; index: number } | null>(null);
  const topRef = useRef<HTMLHeadingElement>(null);
  const pathKey = parts.join('/');
  const [previousPath, setPreviousPath] = useState(pathKey);
  // Reset only folder-local state, keeping the already loaded catalog available.
  if (previousPath !== pathKey) {
    setPreviousPath(pathKey); setPhotoLimit(30); setViewer(null);
  }
  useEffect(() => {
    const controller = new AbortController();
    const documents = surface === 'cabinet'
      ? apiGet('/documents?category=materials&limit=2000').then(data => data.documents)
      : publicJson('/api/public/documents?category=materials&limit=2000', controller.signal);
    const cooperation = publicJson('/api/public/documents?category=cooperation', controller.signal)
      .then(data => { if (!Array.isArray(data)) throw new Error('Invalid document list'); return data; })
      .catch(err => { if (err.name !== 'AbortError' && !controller.signal.aborted) setTermsError(true); return []; });
    Promise.all([documents, publicJson('/api/public/documents/layout', controller.signal), cooperation])
      .then(([data, layoutData, termsData]) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(data) || !layoutData?.layout) throw new Error('Invalid materials response');
        setDocs(currentMaterials(data)); setTerms(termsData); setLayout(parseMaterialsLayout(layoutData.layout));
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, surface]);
  const mapped = useMemo(() => withDisplaySubcategory(docs, layout, surface), [docs, layout, surface]);
  const { folders, files } = useMemo(() => foldersAndFilesAt(mapped, parts), [mapped, parts]);
  const extraDocs = useMemo(() => uniqueMaterials(standaloneMaterials(mapped, layout)), [mapped, layout]);
  const conditionDocs = useMemo(() => uniqueMaterials(terms), [terms]);
  const calculatorHref = useMemo(() => findInstallmentCalculator([...conditionDocs, ...extraDocs]), [conditionDocs, extraDocs]);
  const title = catalog ? 'Материалы для брокеров' : conditions ? 'Актуальные условия' : parts[parts.length - 1];
  const projectGroups = layout.groups.filter(g => surface === 'landing' ? g.visibleOnLanding : g.visibleInCabinet)
    .filter(g => mapped.some(d => d.subcategory === g.title || d.subcategory.startsWith(g.title + '/')))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const parentHref = materialsParentHref(parts, materialHref);

  function retryLoading() {
    setLoading(true); setError(false); setTermsError(false); setReload(n => n + 1);
  }

  function scrollFolderTop() {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    topRef.current?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    topRef.current?.focus({ preventScroll: true });
  }

  function fileSection(sectionTitle: string, items: MaterialDocument[], kind: 'image' | 'video' | 'document') {
    if (!items.length) return null;
    const visibleItems = kind === 'image' ? items.slice(0, photoLimit) : items;
    return <section className="mb-section"><h2 className="mb-section-title">{sectionTitle} <span>({items.length})</span></h2>
      <div className={kind === 'image' ? 'mb-photo-grid' : 'mb-file-grid'}>{visibleItems.map(doc => {
        const heading = <div className="mb-card-heading"><div><h3 className="mb-card-title">{doc.name}</h3><p className="mb-card-meta">{kind === 'image' ? 'Фото' : kind === 'video' ? 'Видео' : isMaterialPdf(doc) ? 'PDF' : doc.type || 'Документ'}</p></div><ArrowDownRight size={20} className="mb-card-arrow" aria-hidden="true" /></div>;
        if (kind === 'document' && !isMaterialPdf(doc)) {
          const href = safeMaterialUrl(doc.fileUrl)?.href;
          return <article key={doc.id} className="mb-card mb-file-card">{href ? <a className="mb-file-preview" data-material-preview={doc.id} href={href} target="_blank" rel="noopener noreferrer">{heading}<div className="mb-card-placeholder"><FileText size={48} aria-hidden="true" /></div><span className="mb-preview-label">Открыть документ</span></a> : heading}<div className="mb-file-actions"><DownloadLink doc={doc} /></div></article>;
        }
        const viewerItems = kind === 'document' ? items.filter(isMaterialPdf) : items;
        return <article key={doc.id} className="mb-card mb-file-card"><button type="button" className="mb-file-preview" data-material-preview={doc.id} onClick={() => setViewer({ items: viewerItems, index: viewerItems.indexOf(doc) })} title={doc.name} aria-label={`Открыть ${doc.name}`}>{heading}
          <div className="mb-card-media mb-card-media--contain">
            {kind === 'document' ? <div className="mb-card-placeholder"><FileText size={48} aria-hidden="true" /></div> : <Thumbnail key={doc.fileUrl} src={materialsThumbUrl(doc.fileUrl)} alt={doc.name} />}
            {kind === 'video' && <span className="mb-card-play"><Play size={26} fill="currentColor" aria-hidden="true" /></span>}
          </div>
          <span className="mb-preview-label">{kind === 'video' ? 'Смотреть видео' : kind === 'document' ? 'Открыть PDF' : 'Открыть фото'}</span>
        </button><div className="mb-file-actions"><DownloadLink doc={doc} /></div></article>;
      })}</div>
      {kind === 'image' && items.length > photoLimit && <button className="mb-button" onClick={() => setPhotoLimit(n => n + 30)}>Показать ещё ({items.length - photoLimit} фото)</button>}
    </section>;
  }

  return <>{!embedded && <PublicHeader calculatorHref={calculatorHref} />}<div className={'mb-page' + (embedded ? ' mb-page--embedded' : '') + (parts.length >= 2 ? ' mb-page--nested' : '')}>
    <div className="mb-container">
      {!catalog && <Link href={parentHref} className="mb-back"><ArrowLeft size={18} aria-hidden="true" />Назад</Link>}
      <nav className="mb-breadcrumbs" aria-label="Путь к папке">
        {catalog ? <span aria-current="page">Материалы</span> : <Link href={MATERIALS_CATALOG_HREF}>Материалы</Link>}
        {parts.map((part, index) => <span key={index}><span aria-hidden="true">/</span>{index === parts.length - 1 ? <span aria-current="page">{conditions ? 'Актуальные условия' : part}</span> : <Link href={materialHref(parts.slice(0, index + 1))}>{part}</Link>}</span>)}
      </nav>
      <h1 className="mb-title" ref={topRef} tabIndex={-1}>{title}</h1>
      {catalog && <p className="mb-subtitle">Фото, видео и презентации проектов. Условия сотрудничества и калькулятор рассрочки.</p>}
      {loading ? <div className="mb-loading" role="status">Загрузка...</div> : error ? <div className="mb-empty" role="alert"><p>Не удалось загрузить материалы. Файлы не удалены — попробуйте обновить список.</p><button className="mb-button" onClick={retryLoading}>Повторить загрузку</button></div> : catalog ? (
        <div className="mb-grid mb-catalog-grid" data-tour="materials-grid" data-material-catalog>
          {projectGroups.map(g => <FolderCard key={g.id} title={g.title} meta="Фото · Видео · Презентации" href={materialHref([g.title])} cover={materialsProjectCover(g.title)} />)}
          <FolderCard title="Актуальные условия" meta="Условия сотрудничества · Калькулятор рассрочки" href={MATERIALS_CONDITIONS_HREF} cover={{ kind: 'image', src: '/v2/img/materials-conditions.webp' }} />
        </div>
      ) : conditions ? <>
        {termsError && <div className="mb-empty" role="alert"><p>Не удалось загрузить актуальные условия.</p><button className="mb-button" onClick={retryLoading}>Повторить загрузку</button></div>}
        {fileSection('Условия сотрудничества', conditionDocs, 'document')}
        {fileSection('Другие материалы и документы', extraDocs.filter(d => !conditionDocs.some(c => c.fileUrl === d.fileUrl)), 'document')}
      </> : <>
        {folders.length > 0 && <section className="mb-section"><h2 className="mb-section-title">Папки <span>({folders.length})</span></h2><div className="mb-grid">{folders.map(folder => { const nested = [...parts, folder]; return <FolderCard key={folder} title={folder} meta={mediaCountsLabel(mediaCountsUnder(mapped, nested))} href={materialHref(nested)} cover={materialsFolderCover(layout, mapped, nested)} />; })}</div></section>}
        {fileSection('Фотографии', files.filter(isMaterialImage), 'image')}
        {fileSection('Видео', files.filter(isMaterialVideo), 'video')}
        {fileSection('Документы и презентации', files.filter(d => !isMaterialImage(d) && !isMaterialVideo(d)), 'document')}
        {!folders.length && !files.length && <div className="mb-empty"><Folder size={48} aria-hidden="true" /><p>В этой папке пока нет файлов</p><Link className="mb-button" href={MATERIALS_CATALOG_HREF}>Открыть каталог материалов</Link></div>}
      </>}
      <footer className="mb-footer"><div className="mb-footer-contacts"><span>По вопросам получения материалов:</span><a href="tel:+74992262249">+7 (499) 226-22-49</a><a href={'mailto:' + MATERIALS_CONTACT_EMAIL}>{MATERIALS_CONTACT_EMAIL}</a></div><button type="button" className="mb-button mb-to-top" aria-label="Наверх" onClick={scrollFolderTop}><ArrowUp size={18} aria-hidden="true" />Наверх</button></footer>
    </div>
    {viewer && <MaterialViewer items={viewer.items} index={viewer.index} onClose={() => setViewer(null)} onIndex={index => setViewer({ items: viewer.items, index })} />}
  </div></>;
}
