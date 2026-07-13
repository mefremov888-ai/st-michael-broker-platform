'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { useFavorites } from '@/lib/favorites';
import { Heart, ArrowRight } from 'lucide-react';

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный бор',
};

const statusLabels: Record<string, { label: string; cls: string }> = {
  AVAILABLE: { label: 'Свободен', cls: 'bg-success/20 text-success' },
  BOOKED: { label: 'Бронь', cls: 'bg-warning/20 text-warning' },
  SOLD: { label: 'Продан', cls: 'bg-error/20 text-error' },
};

export default function FavoritesPage() {
  const { toggle } = useFavorites();
  const [items, setItems] = useState<{ id: string; addedAt: string; lot: any }[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ id: string; addedAt: string; lot: any }[]>('/favorites');
      setItems(data || []);
    } catch {
      setItems([]);
    }
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  const handleRemove = async (lotId: string) => {
    await toggle(lotId);
    setItems((prev) => prev.filter((i) => i.lot.id !== lotId));
  };

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6">
      <h1 className="text-2xl md:text-3xl font-bold mb-6 flex items-center gap-2">
        <Heart className="w-6 h-6 text-error fill-current" /> Избранные лоты
      </h1>

      {loading ? (
        <div className="text-text-muted">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="card text-center py-12">
          <Heart className="w-12 h-12 text-text-muted/40 mx-auto mb-4" />
          <p className="text-text-muted mb-4">Пока ничего не добавлено в избранное.</p>
          <Link href="/catalog" className="btn btn-primary inline-flex items-center gap-2">
            Перейти в подбор квартир <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map(({ lot, addedAt }) => (
            <div key={lot.id} className="card hover:shadow-md transition">
              {lot.planImageUrl && (
                <div className="mb-3 bg-surface-secondary rounded-lg p-3 flex justify-center">
                  <img src={lot.planImageUrl} alt="" className="max-h-32 object-contain" />
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium">{lot.number}</h3>
                <span className={`text-xs px-2 py-1 rounded ${statusLabels[lot.status]?.cls || 'bg-text-muted/20'}`}>
                  {statusLabels[lot.status]?.label || lot.status}
                </span>
              </div>
              {lot.propertyType && <div className="text-xs text-accent mb-2">{lot.propertyType}</div>}
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-text-muted">Проект:</span><span>{projectLabels[lot.project] || lot.project}</span></div>
                <div className="flex justify-between"><span className="text-text-muted">Корпус:</span><span>{lot.building}</span></div>
                <div className="flex justify-between"><span className="text-text-muted">Этаж:</span><span>{lot.floor}{lot.floorsTotal ? ` / ${lot.floorsTotal}` : ''}</span></div>
                <div className="flex justify-between"><span className="text-text-muted">Комнат:</span><span>{lot.rooms}</span></div>
                <div className="flex justify-between"><span className="text-text-muted">Площадь:</span><span>{Number(lot.sqm)} м²</span></div>
                <div className="flex justify-between pt-2 border-t border-border"><span className="text-text-muted">Цена:</span><span className="font-bold text-accent">{Math.round(Number(lot.discountPrice || lot.price)).toLocaleString('ru-RU')} ₽</span></div>
              </div>
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-border text-xs">
                <span className="text-text-muted">Добавлено {new Date(addedAt).toLocaleDateString('ru-RU')}</span>
                <button
                  onClick={() => handleRemove(lot.id)}
                  className="text-error hover:underline"
                >
                  Убрать
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
