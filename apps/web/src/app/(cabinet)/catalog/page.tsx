'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Building, RefreshCw, ChevronLeft, ChevronRight, X, SlidersHorizontal, Heart, Printer, CalendarDays, Bookmark } from 'lucide-react';
import { useFavorites } from '@/lib/favorites';

const statusLabels: Record<string, { label: string; cls: string }> = {
  AVAILABLE: { label: 'Свободен', cls: 'bg-success/20 text-success' },
  BOOKED: { label: 'Бронь', cls: 'bg-warning/20 text-warning' },
  SOLD: { label: 'Продан', cls: 'bg-error/20 text-error' },
};

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный бор',
};

// КБ6 (2026-05-25): «Сдан» если срок сдачи уже наступил.
// Если на конец указанного квартала прошедшая дата — пишем «Сдан».
// Иначе — «N кв YYYY» (как раньше).
function formatReadiness(lot: { builtYear?: number | null; readyQuarter?: number | null }): string {
  if (!lot.builtYear) return '—';
  const now = new Date();
  const curY = now.getFullYear();
  const curQ = Math.floor(now.getMonth() / 3) + 1;
  const ly = Number(lot.builtYear);
  const lq = lot.readyQuarter ? Number(lot.readyQuarter) : 4; // если квартала нет — считаем по концу года
  const isDone = ly < curY || (ly === curY && lq < curQ);
  if (isDone) return 'Сдан';
  return `${lot.readyQuarter ? `${lot.readyQuarter} кв. ` : ''}${lot.builtYear}`;
}

function LotDetail({ lot, onClose, onBook, onVisit }: { lot: any; onClose: () => void; onBook: (lot: any) => void; onVisit: (lot: any) => void }) {
  // 2026-06-15: избранное через API (БД), не localStorage. См. useFavorites.
  const { isFavorite: isFav, toggle: toggleFav } = useFavorites();
  const isFavorite = isFav(lot.id);
  const handleToggleFav = () => toggleFav(lot.id);

  const handlePrint = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    const priceDisplay = lot.discountPrice && Number(lot.discountPrice) > 0
      ? `${Math.round(Number(lot.discountPrice)).toLocaleString('ru-RU')} ₽ (было ${Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽)`
      : `${Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽`;
    w.document.write(`
      <html><head><title>Лот ${lot.number}</title>
      <style>
        body{font-family:Arial,sans-serif;padding:32px;color:#1a1a1a;max-width:800px;margin:0 auto}
        h1{border-bottom:2px solid #B4936F;padding-bottom:8px}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
        .row{padding:8px 12px;background:#f5f5f5;border-radius:4px}
        .label{font-size:11px;color:#888;text-transform:uppercase}
        .value{font-weight:600;margin-top:2px}
        .price{font-size:24px;color:#B4936F;font-weight:bold;padding:16px;background:#f5f5f5;border-radius:8px;margin-top:16px}
        img{max-width:100%;margin-top:16px}
      </style></head><body>
      <h1>Лот ${lot.number}</h1>
      <div><strong>${projectLabels[lot.project] || lot.project}</strong> — ${lot.propertyType || ''}</div>
      <div class="grid">
        <div class="row"><div class="label">Корпус</div><div class="value">${lot.building || '—'}</div></div>
        <div class="row"><div class="label">Этаж</div><div class="value">${lot.floor}${lot.floorsTotal ? ` / ${lot.floorsTotal}` : ''}</div></div>
        <div class="row"><div class="label">Комнат</div><div class="value">${lot.rooms}</div></div>
        <div class="row"><div class="label">Площадь</div><div class="value">${Number(lot.sqm)} м²</div></div>
        ${lot.builtYear ? `<div class="row"><div class="label">Срок сдачи</div><div class="value">${formatReadiness(lot)}</div></div>` : ''}
        ${lot.windowView ? `<div class="row"><div class="label">Вид из окна</div><div class="value">${lot.windowView}</div></div>` : ''}
      </div>
      <div class="price">Стоимость: ${priceDisplay}</div>
      ${lot.planImageUrl ? `<img src="${lot.planImageUrl}" alt="Планировка" />` : ''}
      </body></html>
    `);
    w.document.close();
    setTimeout(() => { w.print(); }, 500);
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={onClose}>
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center justify-between mb-4 pr-8">
          <h2 className="text-xl font-bold">{lot.number}</h2>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-1 rounded ${statusLabels[lot.status]?.cls || 'bg-text-muted/20'}`}>
              {statusLabels[lot.status]?.label || lot.status}
            </span>
            <button
              onClick={handleToggleFav}
              className={`p-2 rounded-lg transition ${isFavorite ? 'bg-error/20 text-error' : 'hover:bg-surface-secondary text-text-muted'}`}
              title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
            >
              <Heart className={`w-5 h-5 ${isFavorite ? 'fill-current' : ''}`} />
            </button>
          </div>
        </div>

        {lot.propertyType && <div className="text-sm text-accent mb-4">{lot.propertyType}</div>}

        {lot.planImageUrl && (
          <div className="mb-6 bg-surface-secondary rounded-lg p-3">
            <img src={lot.planImageUrl} alt="Планировка" className="w-full rounded max-h-80 object-contain" />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-sm mb-6">
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Проект</span><span className="font-medium">{projectLabels[lot.project] || lot.project}</span></div>
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Корпус</span><span className="font-medium">{lot.building}</span></div>
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Этаж</span><span className="font-medium">{lot.floor}{lot.floorsTotal ? ` / ${lot.floorsTotal}` : ''}</span></div>
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Комнат</span><span className="font-medium">{lot.rooms}</span></div>
          <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Площадь</span><span className="font-medium">{Number(lot.sqm)} м²</span></div>
          {lot.buildingSection && <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Секция</span><span className="font-medium">{lot.buildingSection}</span></div>}
          {lot.builtYear && <div className="bg-surface-secondary rounded-lg p-3"><span className="text-text-muted block text-xs">Срок сдачи</span><span className="font-medium">{formatReadiness(lot)}</span></div>}
          {lot.windowView && <div className="bg-surface-secondary rounded-lg p-3 col-span-2"><span className="text-text-muted block text-xs">Вид из окна</span><span className="font-medium">{lot.windowView}</span></div>}
        </div>

        {(lot.hasBalcony || lot.hasTerrace || lot.isPenthouse || lot.isCornerLayout || lot.hasStorage || lot.twoBathrooms || lot.hasMasterBedroom || lot.isUrbanVilla || lot.isViewLot || lot.isHighFlat) && (
          <div className="flex flex-wrap gap-2 mb-4">
            {lot.hasBalcony && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Балкон</span>}
            {lot.hasTerrace && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Терраса</span>}
            {lot.isPenthouse && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Пентхаус</span>}
            {lot.isCornerLayout && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Угловая</span>}
            {lot.hasStorage && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Кладовая</span>}
            {lot.twoBathrooms && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">2 санузла</span>}
            {lot.hasMasterBedroom && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Мастер-спальня</span>}
            {lot.isUrbanVilla && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Урбан-вилла</span>}
            {lot.isViewLot && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Видовая</span>}
            {lot.isHighFlat && <span className="text-xs px-2 py-1 rounded bg-accent/10 text-accent">Хайфлет 4м+</span>}
          </div>
        )}

        <div className="bg-surface-secondary rounded-lg p-4">
          {lot.discountPrice && Number(lot.discountPrice) > 0 ? (
            <>
              <div className="flex justify-between items-center mb-1">
                <span className="text-text-muted text-sm">Без скидки</span>
                <span className="text-sm text-text-muted line-through">{Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽</span>
              </div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-text-muted">Со скидкой{lot.discountPercent ? ` (-${Number(lot.discountPercent)}%)` : ''}</span>
                <span className="text-2xl font-bold text-accent">{Math.round(Number(lot.discountPrice)).toLocaleString('ru-RU')} ₽</span>
              </div>
              {lot.discountName && <div className="text-xs text-accent mt-1">{lot.discountName}</div>}
            </>
          ) : (
            <div className="flex justify-between items-center mb-2">
              <span className="text-text-muted">Стоимость</span>
              <span className="text-2xl font-bold text-accent">{Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽</span>
            </div>
          )}
          {Number(lot.pricePerSqm) > 0 && (
            <div className="flex justify-between items-center">
              <span className="text-text-muted text-sm">Цена за м²</span>
              <span className="text-sm">{Math.round(Number(lot.pricePerSqm)).toLocaleString('ru-RU')} ₽/м²</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
          <button
            className="btn btn-primary flex items-center justify-center gap-2"
            onClick={() => onBook(lot)}
            disabled={lot.status !== 'AVAILABLE'}
          >
            <Bookmark className="w-4 h-4" />
            Забронировать
          </button>
          <button
            className="btn btn-secondary flex items-center justify-center gap-2"
            onClick={() => onVisit(lot)}
          >
            <CalendarDays className="w-4 h-4" />
            Записаться в офис
          </button>
          <button
            className="btn btn-secondary flex items-center justify-center gap-2"
            onClick={handlePrint}
          >
            <Printer className="w-4 h-4" />
            Скачать PDF
          </button>
          <button
            className={`btn flex items-center justify-center gap-2 ${isFavorite ? 'bg-error/20 text-error hover:bg-error/30' : 'btn-secondary'}`}
            onClick={handleToggleFav}
          >
            <Heart className={`w-4 h-4 ${isFavorite ? 'fill-current' : ''}`} />
            {isFavorite ? 'В избранном' : 'В избранное'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ContactModal({ lot, kind, onClose }: { lot: any; kind: 'book' | 'visit'; onClose: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const title = kind === 'book' ? 'Забронировать лот' : 'Записаться на встречу в офис';

  const handleSend = async () => {
    setError(''); setSending(true);
    const lotInfo = `Лот №${lot.number} · ${projectLabels[lot.project] || lot.project} · корпус ${lot.building || '—'} · ${lot.rooms} · ${lot.sqm} м² · ${Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽`;
    const message = `${kind === 'book' ? 'БРОНИРОВАНИЕ' : 'ЗАПИСЬ В ОФИС'}\n${lotInfo}\nКлиент: ${name}\nТелефон клиента: ${phone}${comment ? '\nКомментарий: ' + comment : ''}`;
    try {
      const res = await fetch('/api/public/cms/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          phone,
          message,
          source: kind === 'book' ? 'catalog-booking' : 'catalog-office-visit',
        }),
      });
      if (res.ok) {
        setSent(true);
        setTimeout(onClose, 2500);
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.message || 'Ошибка отправки');
      }
    } catch { setError('Ошибка соединения'); }
    setSending(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface rounded-xl max-w-md w-full p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={onClose}>
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-xl font-bold mb-2">{title}</h2>
        <p className="text-text-muted text-sm mb-4">Лот {lot.number} — {projectLabels[lot.project] || lot.project}</p>

        {sent ? (
          <div className="p-4 bg-success/20 text-success rounded-lg text-sm text-center">
            ✓ Заявка отправлена в отдел продаж. Менеджер свяжется с вами в течение часа.
          </div>
        ) : (
          <div className="space-y-3">
            {error && <div className="p-3 bg-error/20 text-error rounded text-sm">{error}</div>}
            <input className="input" placeholder="Имя клиента *" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input" placeholder="Телефон клиента *" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <textarea className="input" rows={3} placeholder="Комментарий" value={comment} onChange={(e) => setComment(e.target.value)} />
            <p className="text-xs text-text-muted">
              Лот {lot.number} · {projectLabels[lot.project] || lot.project} · {Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽
            </p>
            <button
              className="btn btn-primary w-full"
              onClick={handleSend}
              disabled={!name || !phone || sending}
            >
              {sending ? 'Отправка...' : 'Отправить в отдел продаж'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CatalogPage() {
  const { isFavorite: isFav, toggle: toggleFav } = useFavorites();
  const [lots, setLots] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  // Filters
  const [projectFilter, setProjectFilter] = useState('');
  const [propertyTypeFilter, setPropertyTypeFilter] = useState('');
  const [roomsFilter, setRoomsFilter] = useState('');
  const [buildingFilter, setBuildingFilter] = useState('');
  const [viewFilter, setViewFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [sqmMin, setSqmMin] = useState('');
  const [sqmMax, setSqmMax] = useState('');
  const [floorMin, setFloorMin] = useState('');
  const [floorMax, setFloorMax] = useState('');
  const [hasBalcony, setHasBalcony] = useState(false);
  const [hasTerrace, setHasTerrace] = useState(false);
  const [isPenthouse, setIsPenthouse] = useState(false);
  const [isCornerLayout, setIsCornerLayout] = useState(false);
  const [hasStorage, setHasStorage] = useState(false);
  const [twoBathrooms, setTwoBathrooms] = useState(false);
  const [hasMasterBedroom, setHasMasterBedroom] = useState(false);
  const [isUrbanVilla, setIsUrbanVilla] = useState(false);
  const [isViewLot, setIsViewLot] = useState(false);
  const [isHighFlat, setIsHighFlat] = useState(false);

  // Filter options from API
  const [propertyTypes, setPropertyTypes] = useState<{ type: string; count: number }[]>([]);
  const [projects, setProjects] = useState<{ project: string; count: number }[]>([]);
  const [buildings, setBuildings] = useState<{ building: string; count: number }[]>([]);
  const [views, setViews] = useState<{ view: string; count: number }[]>([]);
  const [years, setYears] = useState<{ year: number; count: number }[]>([]);
  const [featureCounts, setFeatureCounts] = useState<Record<string, number>>({});

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [selectedLot, setSelectedLot] = useState<any>(null);
  const [contactModal, setContactModal] = useState<{ lot: any; kind: 'book' | 'visit' } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Reset building when project / propertyType / rooms changes —
  // выбранный корпус может не существовать в новой выборке (КБ6 fix).
  useEffect(() => {
    setBuildingFilter('');
  }, [projectFilter, propertyTypeFilter, roomsFilter]);

  const buildQuery = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: '18' });
    if (projectFilter) p.set('project', projectFilter);
    if (propertyTypeFilter) p.set('propertyType', propertyTypeFilter);
    if (roomsFilter) p.set('rooms', roomsFilter);
    if (buildingFilter) p.set('building', buildingFilter);
    if (viewFilter) p.set('windowView', viewFilter);
    if (yearFilter) p.set('readyYear', yearFilter);
    if (priceMin) p.set('priceMin', priceMin);
    if (priceMax) p.set('priceMax', priceMax);
    if (sqmMin) p.set('sqmMin', sqmMin);
    if (sqmMax) p.set('sqmMax', sqmMax);
    if (floorMin) p.set('floorMin', floorMin);
    if (floorMax) p.set('floorMax', floorMax);
    if (hasBalcony) p.set('hasBalcony', '1');
    if (hasTerrace) p.set('hasTerrace', '1');
    if (isPenthouse) p.set('isPenthouse', '1');
    if (isCornerLayout) p.set('isCornerLayout', '1');
    if (hasStorage) p.set('hasStorage', '1');
    if (twoBathrooms) p.set('twoBathrooms', '1');
    if (hasMasterBedroom) p.set('hasMasterBedroom', '1');
    if (isUrbanVilla) p.set('isUrbanVilla', '1');
    if (isViewLot) p.set('isViewLot', '1');
    if (isHighFlat) p.set('isHighFlat', '1');
    return p.toString();
  }, [page, projectFilter, propertyTypeFilter, roomsFilter, buildingFilter, viewFilter, yearFilter,
      priceMin, priceMax, sqmMin, sqmMax, floorMin, floorMax,
      hasBalcony, hasTerrace, isPenthouse,
      isCornerLayout, hasStorage, twoBathrooms, hasMasterBedroom, isUrbanVilla, isViewLot, isHighFlat]);

  const fetchLots = () => {
    setLoading(true);
    apiGet(`/lots?${buildQuery}`)
      .then((data) => {
        setLots(data.lots || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
        if (data.filters?.propertyTypes) setPropertyTypes(data.filters.propertyTypes);
        if (data.filters?.projects) setProjects(data.filters.projects);
        if (data.filters?.buildings) setBuildings(data.filters.buildings);
        if (data.filters?.views) setViews(data.filters.views);
        if (data.filters?.years) setYears(data.filters.years);
        if (data.filters?.featureCounts) setFeatureCounts(data.filters.featureCounts);
      })
      .catch(() => setLots([]))
      .finally(() => setLoading(false));
  };

  const handleSync = async () => {
    setSyncing(true); setSyncResult(null);
    try {
      const data = await apiPost('/lots/sync', {});
      setSyncResult(data);
      setPage(1);
      fetchLots();
    } catch (e: any) {
      alert(e.message || 'Ошибка синхронизации');
    }
    setSyncing(false);
  };

  useEffect(() => { fetchLots(); }, [buildQuery]);

  const resetFilters = () => {
    setProjectFilter(''); setPropertyTypeFilter(''); setRoomsFilter('');
    setBuildingFilter(''); setViewFilter(''); setYearFilter('');
    setPriceMin(''); setPriceMax(''); setSqmMin(''); setSqmMax('');
    setFloorMin(''); setFloorMax('');
    setHasBalcony(false); setHasTerrace(false); setIsPenthouse(false);
    setIsCornerLayout(false); setHasStorage(false); setTwoBathrooms(false);
    setHasMasterBedroom(false); setIsUrbanVilla(false); setIsViewLot(false); setIsHighFlat(false);
    setPage(1);
  };

  const activeFiltersCount = [
    projectFilter, propertyTypeFilter, roomsFilter, buildingFilter, viewFilter, yearFilter,
    priceMin, priceMax, sqmMin, sqmMax, floorMin, floorMax,
    hasBalcony, hasTerrace, isPenthouse,
    isCornerLayout, hasStorage, twoBathrooms, hasMasterBedroom, isUrbanVilla, isViewLot, isHighFlat,
  ].filter(Boolean).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Подбор квартир</h1>
          <span className="text-text-muted text-sm">Всего найдено: {total}</span>
        </div>
        <button
          className="btn btn-secondary p-2"
          onClick={handleSync}
          disabled={syncing}
          title="Обновить каталог"
          aria-label="Обновить каталог"
        >
          <RefreshCw className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {syncResult && (
        <div className="mb-4 p-4 rounded-lg bg-success/20 text-success text-sm">
          Синхронизация: добавлено {syncResult.created}, обновлено {syncResult.updated}, всего {syncResult.total}
        </div>
      )}

      {/* Filters */}
      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 font-medium"><SlidersHorizontal className="w-4 h-4" />Фильтры{activeFiltersCount > 0 && <span className="text-xs bg-accent text-white px-2 py-0.5 rounded-full">{activeFiltersCount}</span>}</div>
          <div className="flex gap-2">
            {activeFiltersCount > 0 && (
              <button className="btn btn-secondary text-xs" onClick={resetFilters}>Сбросить</button>
            )}
            <button className="btn btn-secondary text-xs" onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? 'Скрыть доп.' : 'Дополнительно'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-text-muted block mb-1">Проект</label>
            <select className="input" value={projectFilter} onChange={(e) => { setProjectFilter(e.target.value); setPage(1); }}>
              <option value="">Все проекты</option>
              {projects.map((p) => <option key={p.project} value={p.project}>{projectLabels[p.project] || p.project} ({p.count})</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Тип</label>
            <select className="input" value={propertyTypeFilter} onChange={(e) => { setPropertyTypeFilter(e.target.value); setPage(1); }}>
              <option value="">Все типы</option>
              {propertyTypes.map((pt) => <option key={pt.type} value={pt.type!}>{pt.type} ({pt.count})</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Комнатность</label>
            <select className="input" value={roomsFilter} onChange={(e) => { setRoomsFilter(e.target.value); setPage(1); }}>
              <option value="">Любая</option>
              <option value="Студия">Студия</option>
              <option value="1">1-комн.</option>
              <option value="2">2-комн.</option>
              <option value="3">3-комн.</option>
              <option value="4">4+ комн.</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Корпус</label>
            <select className="input" value={buildingFilter} onChange={(e) => { setBuildingFilter(e.target.value); setPage(1); }}>
              <option value="">Все корпуса</option>
              {buildings.map((b) => <option key={b.building} value={b.building}>{b.building} ({b.count})</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Площадь, м²</label>
            <div className="flex gap-2">
              <input type="number" className="input" placeholder="от" value={sqmMin} onChange={(e) => { setSqmMin(e.target.value); setPage(1); }} />
              <input type="number" className="input" placeholder="до" value={sqmMax} onChange={(e) => { setSqmMax(e.target.value); setPage(1); }} />
            </div>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Цена, ₽</label>
            <div className="flex gap-2">
              <input type="number" className="input" placeholder="от" value={priceMin} onChange={(e) => { setPriceMin(e.target.value); setPage(1); }} />
              <input type="number" className="input" placeholder="до" value={priceMax} onChange={(e) => { setPriceMax(e.target.value); setPage(1); }} />
            </div>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Этаж</label>
            <div className="flex gap-2">
              <input type="number" className="input" placeholder="от" value={floorMin} onChange={(e) => { setFloorMin(e.target.value); setPage(1); }} />
              <input type="number" className="input" placeholder="до" value={floorMax} onChange={(e) => { setFloorMax(e.target.value); setPage(1); }} />
            </div>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Срок сдачи</label>
            <select className="input" value={yearFilter} onChange={(e) => { setYearFilter(e.target.value); setPage(1); }}>
              <option value="">Любой</option>
              {(() => {
                // Bug fix 2026-06-02: прошедшие годы группируем в одну опцию
                // «Сдан». Зорге 9 уже сдан (2023/2024), брокеру нет смысла
                // выбирать между этими годами. Будущие годы показываются как
                // есть («2027»).
                const curY = new Date().getFullYear();
                let doneCount = 0;
                const future: typeof years = [];
                for (const y of years) {
                  if (y.year < curY) doneCount += y.count;
                  else future.push(y);
                }
                const opts: JSX.Element[] = [];
                if (doneCount > 0) {
                  opts.push(<option key="done" value="done">Сдан ({doneCount})</option>);
                }
                for (const y of future) {
                  opts.push(<option key={y.year} value={y.year}>{y.year} ({y.count})</option>);
                }
                return opts;
              })()}
            </select>
          </div>
        </div>

        {showAdvanced && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted block mb-1">Вид из окна</label>
                <select className="input" value={viewFilter} onChange={(e) => { setViewFilter(e.target.value); setPage(1); }}>
                  <option value="">Любой</option>
                  {views.map((v) => <option key={v.view} value={v.view}>{v.view} ({v.count})</option>)}
                </select>
              </div>
              <div></div>
            </div>

            <div className="mt-4">
              <div className="text-xs text-text-muted mb-2">Особенности планировки</div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {[
                  { label: 'Балкон / лоджия', state: hasBalcony, setter: setHasBalcony, key: 'hasBalcony' as const },
                  { label: 'Терраса', state: hasTerrace, setter: setHasTerrace, key: 'hasTerrace' as const },
                  { label: 'Пентхаус', state: isPenthouse, setter: setIsPenthouse, key: 'isPenthouse' as const },
                  { label: 'Угловая', state: isCornerLayout, setter: setIsCornerLayout, key: 'isCornerLayout' as const },
                  { label: 'Кладовая', state: hasStorage, setter: setHasStorage, key: 'hasStorage' as const },
                  { label: '2 санузла', state: twoBathrooms, setter: setTwoBathrooms, key: 'twoBathrooms' as const },
                  { label: 'Мастер-спальня', state: hasMasterBedroom, setter: setHasMasterBedroom, key: 'hasMasterBedroom' as const },
                  { label: 'Урбан-вилла', state: isUrbanVilla, setter: setIsUrbanVilla, key: 'isUrbanVilla' as const },
                  { label: 'Видовая', state: isViewLot, setter: setIsViewLot, key: 'isViewLot' as const },
                  { label: 'Хайфлет 4м+', state: isHighFlat, setter: setIsHighFlat, key: 'isHighFlat' as const },
                ].filter((f) => (featureCounts[f.key] ?? 0) > 0).map((f) => (
                  <label key={f.key} className={`flex items-center gap-2 cursor-pointer text-sm px-3 py-2 rounded-lg border transition ${f.state ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:bg-surface-secondary'}`}>
                    <input type="checkbox" checked={f.state} onChange={(e) => { f.setter(e.target.checked); setPage(1); }} />
                    {f.label} <span className="text-xs text-text-muted ml-auto">{featureCounts[f.key]}</span>
                  </label>
                ))}
              </div>
              {Object.values(featureCounts).every((v) => !v) && (
                <div className="text-xs text-text-muted">Нет лотов с особыми планировками для текущих фильтров</div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : lots.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <Building className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            <p>Лоты не найдены</p>
            <p className="text-sm mt-2">Попробуйте изменить фильтры</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {lots.map((lot: any) => (
                <div
                  key={lot.id}
                  className="p-4 bg-surface-secondary rounded-lg cursor-pointer hover:ring-2 hover:ring-accent/50 transition"
                  onClick={() => setSelectedLot(lot)}
                >
                  {/* КБ6 (2026-05-25): единый стиль картинок — фиксированная
                      высота 160px, object-contain, без скачков размера карточки.
                      Если картинки нет — серый плейсхолдер той же высоты,
                      чтобы карточки лотов были одинаковыми по высоте. */}
                  <div className="mb-3 bg-surface rounded-lg overflow-hidden" style={{ height: 160 }}>
                    {lot.planImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={lot.planImageUrl}
                        alt="Планировка"
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">
                        Без планировки
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium text-sm">{lot.number}</h3>
                    <div className="flex items-center gap-1">
                      <span className={`text-xs px-2 py-1 rounded ${statusLabels[lot.status]?.cls || 'bg-text-muted/20'}`}>
                        {statusLabels[lot.status]?.label || lot.status}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleFav(lot.id); }}
                        className={`p-1 rounded ${isFav(lot.id) ? 'text-error' : 'text-text-muted hover:text-text'}`}
                        title="В избранное"
                      >
                        <Heart className={`w-4 h-4 ${isFav(lot.id) ? 'fill-current' : ''}`} />
                      </button>
                    </div>
                  </div>
                  {lot.propertyType && <div className="text-xs text-accent mb-2">{lot.propertyType}</div>}
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-text-muted">Проект:</span><span>{projectLabels[lot.project] || lot.project}</span></div>
                    <div className="flex justify-between"><span className="text-text-muted">Корпус:</span><span className="text-right">{lot.building}</span></div>
                    <div className="flex justify-between"><span className="text-text-muted">Этаж:</span><span>{lot.floor}{lot.floorsTotal ? ` / ${lot.floorsTotal}` : ''}</span></div>
                    <div className="flex justify-between"><span className="text-text-muted">Комнат:</span><span>{lot.rooms}</span></div>
                    <div className="flex justify-between"><span className="text-text-muted">Площадь:</span><span>{Number(lot.sqm)} м²</span></div>
                    {lot.builtYear && (
                      <div className="flex justify-between"><span className="text-text-muted">Сдача:</span><span>{formatReadiness(lot)}</span></div>
                    )}
                    {lot.discountPrice && Number(lot.discountPrice) > 0 ? (
                      <div className="pt-2 border-t border-border">
                        <div className="flex justify-between items-center">
                          <span className="text-text-muted text-xs">Без скидки:</span>
                          <span className="text-xs text-text-muted line-through">{Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽</span>
                        </div>
                        <div className="flex justify-between items-center mt-0.5">
                          <span className="text-text-muted text-xs">Со скидкой{lot.discountPercent ? ` -${Number(lot.discountPercent)}%` : ''}:</span>
                          <span className="font-bold text-accent">{Math.round(Number(lot.discountPrice)).toLocaleString('ru-RU')} ₽</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-between pt-2 border-t border-border"><span className="text-text-muted">Цена:</span><span className="font-bold text-accent">{Math.round(Number(lot.price)).toLocaleString('ru-RU')} ₽</span></div>
                    )}
                  </div>
                  {(lot.hasBalcony || lot.hasTerrace || lot.isPenthouse) && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {lot.hasBalcony && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">Балкон</span>}
                      {lot.hasTerrace && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">Терраса</span>}
                      {lot.isPenthouse && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">Пентхаус</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
                <span className="text-sm text-text-muted">Стр. {page} из {totalPages}</span>
                <div className="flex gap-2">
                  <button className="btn btn-secondary" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}><ChevronLeft className="w-4 h-4" /></button>
                  <button className="btn btn-secondary" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}><ChevronRight className="w-4 h-4" /></button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {selectedLot && (
        <LotDetail
          lot={selectedLot}
          onClose={() => setSelectedLot(null)}
          onBook={(lot) => setContactModal({ lot, kind: 'book' })}
          onVisit={(lot) => setContactModal({ lot, kind: 'visit' })}
        />
      )}

      {contactModal && (
        <ContactModal
          lot={contactModal.lot}
          kind={contactModal.kind}
          onClose={() => setContactModal(null)}
        />
      )}
    </div>
  );
}
