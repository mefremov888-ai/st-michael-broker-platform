'use client';

// 2026-05-25: быстрая диагностика amoCRM для админа.
// Если ok=false — показываем красный баннер с ошибкой (типично: 401
// «истёк access_token», 429 rate-limit, timeout).

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';

type Health = {
  ok: boolean;
  tokenConfigured: boolean;
  accountName?: string | null;
  error?: string;
  latencyMs?: number;
};

export default function AmoHealthBanner() {
  const [data, setData] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    apiGet<Health>('/admin/amo-health')
      .then(setData)
      .catch((e) => setData({ ok: false, tokenConfigured: true, error: e?.message || 'fetch failed' }))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (!data) {
    return <div className="mb-4 p-2 text-xs text-text-muted">Проверка amoCRM…</div>;
  }

  const cls = data.ok ? 'bg-success/15 text-success border-success/30' : 'bg-error/15 text-error border-error/30';
  const Icon = data.ok ? CheckCircle2 : AlertTriangle;

  return (
    <div className={`mb-4 p-3 rounded border ${cls} text-sm flex items-start gap-2`}>
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        {data.ok ? (
          <>amoCRM на связи: <b>{data.accountName || 'OK'}</b> ({data.latencyMs}ms)</>
        ) : (
          <>
            amoCRM недоступен: <code className="text-xs">{data.error || 'unknown error'}</code>
            <div className="text-xs mt-1 opacity-80">
              Фиксации продолжат сохраняться в БД, но в amo попадут позже (когда восстановится связь / обновится токен).
            </div>
          </>
        )}
      </div>
      <button
        className="text-xs underline opacity-70 hover:opacity-100 inline-flex items-center gap-1"
        onClick={load}
        disabled={loading}
      >
        <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> проверить
      </button>
    </div>
  );
}
