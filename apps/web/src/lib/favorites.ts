'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiDelete } from './api';

// 2026-06-15: хук избранных лотов брокера. Хранится в БД (FavoriteLot),
// синхронизируется между устройствами. Загружаем при монтировании,
// потом в памяти держим Set ID. Toggle — optimistic update + откат
// если API упало.

const STORAGE_KEY_LEGACY = 'catalog_favorites';

export function useFavorites() {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiGet<string[]>('/favorites/ids');
        if (!cancelled) {
          setIds(new Set(list || []));
          // Однократная миграция localStorage → API: если в кэше что-то
          // осталось со старой версии (до KB5) — переливаем в БД и чистим.
          try {
            const legacy = JSON.parse(localStorage.getItem(STORAGE_KEY_LEGACY) || '[]');
            if (Array.isArray(legacy) && legacy.length > 0) {
              for (const lotId of legacy) {
                if (typeof lotId === 'string' && !list?.includes(lotId)) {
                  await apiPost(`/favorites/${lotId}`, {}).catch(() => {});
                }
              }
              localStorage.removeItem(STORAGE_KEY_LEGACY);
              const fresh = await apiGet<string[]>('/favorites/ids');
              if (!cancelled) setIds(new Set(fresh || []));
            }
          } catch { /* ignore — миграция best-effort */ }
        }
      } catch {
        // Если не залогинены / 401 — оставляем пустой набор.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const isFavorite = useCallback((lotId: string) => ids.has(lotId), [ids]);

  const toggle = useCallback(async (lotId: string) => {
    const was = ids.has(lotId);
    const next = new Set(ids);
    if (was) next.delete(lotId); else next.add(lotId);
    setIds(next);  // optimistic
    try {
      if (was) await apiDelete(`/favorites/${lotId}`);
      else await apiPost(`/favorites/${lotId}`, {});
    } catch {
      setIds(ids);  // откат
    }
  }, [ids]);

  return { ids, isFavorite, toggle, loaded };
}
