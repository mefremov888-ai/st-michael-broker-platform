'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Loader2, RefreshCcw } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  getLoyaltyDetail,
  type LoyaltyBaseKey,
  type LoyaltyEntityType,
  type LoyaltyRecord,
} from '@/lib/loyalty-base-api';
import { LoyaltyRecordPage } from '@/components/loyalty-base/LoyaltyRecordDetail';

function validBase(value: string): value is LoyaltyBaseKey {
  return value === 'anna' || value === 'ours';
}

function validEntity(value: string): value is LoyaltyEntityType {
  return value === 'brokers' || value === 'agencies';
}

export default function LoyaltyBaseDetailRoute() {
  const { base, entity, id } = useParams<{ base: string; entity: string; id: string }>();
  const { broker } = useAuth();
  const [record, setRecord] = useState<LoyaltyRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const routeIsValid = validBase(base) && validEntity(entity) && Boolean(id);

  const load = useCallback(async () => {
    if (!routeIsValid) {
      setError('Неверный адрес карточки.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setRecord(await getLoyaltyDetail(base as LoyaltyBaseKey, entity as LoyaltyEntityType, id));
    } catch (reason) {
      setRecord(null);
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить карточку.');
    } finally {
      setLoading(false);
    }
  }, [base, entity, id, routeIsValid]);

  useEffect(() => { void load(); }, [load]);

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён.</div>;
  }

  if (loading) return <div className="card py-20 flex items-center justify-center gap-2 text-text-muted"><Loader2 className="w-5 h-5 animate-spin" />Загружаем карточку…</div>;

  if (error || !record || !validBase(base)) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Link href="/admin/loyalty-base" className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-accent"><ArrowLeft className="w-4 h-4" />Назад к базе</Link>
        <div className="card text-center py-12">
          <AlertCircle className="w-9 h-9 text-error mx-auto mb-3" />
          <h1 className="font-semibold">Карточка не загружена</h1>
          <p className="text-sm text-text-muted mt-2">{error || 'Запись не найдена.'}</p>
          {routeIsValid && <button className="btn btn-secondary inline-flex items-center gap-2 mt-4" onClick={() => void load()}><RefreshCcw className="w-4 h-4" />Повторить</button>}
        </div>
      </div>
    );
  }

  return <LoyaltyRecordPage record={record} base={base} />;
}
