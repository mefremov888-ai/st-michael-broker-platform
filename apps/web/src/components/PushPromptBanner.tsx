'use client';

// КБ6 #76 (2026-05-25): авто-баннер на главной кабинета, который предлагает
// включить push-уведомления. Появляется, если permission='default'
// (ещё не спрашивали) и устройство поддерживает Push API. После отказа —
// 24 часа не показываем (через localStorage).

import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { subscribePush, getPushStatus } from '@/lib/push';

const DISMISS_KEY = 'push_prompt_dismissed_at';
const DISMISS_HOURS = 24;

export default function PushPromptBanner() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
        if (dismissedAt && Date.now() - dismissedAt < DISMISS_HOURS * 3600 * 1000) return;
        const st = await getPushStatus();
        if (!st.supported) return;
        if (st.permission !== 'default') return; // уже granted/denied — не дёргаем
        if (st.subscribed) return;
        setShow(true);
      } catch {}
    })();
  }, []);

  const enable = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await subscribePush();
      if (r.ok) {
        setMsg('Уведомления включены');
        setTimeout(() => setShow(false), 1500);
      } else {
        setMsg(
          r.reason === 'denied'
            ? 'Вы отклонили. Включить можно в настройках браузера.'
            : r.reason === 'insecure-context'
            ? 'Доступно только по HTTPS.'
            : 'Не удалось включить уведомления.'
        );
      }
    } catch (e: any) {
      setMsg(e?.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="mb-4 p-3 rounded-lg bg-accent/10 border border-accent/30 flex items-start gap-3">
      <Bell className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">Включите уведомления</div>
        <div className="text-xs text-text-muted mt-0.5">
          Чтобы не пропустить подтверждение встречи, решение по фиксации и важные сообщения от менеджера — даже когда сайт закрыт.
        </div>
        {msg && <div className="text-xs mt-2 text-accent">{msg}</div>}
        <div className="flex gap-2 mt-2 flex-wrap">
          <button
            className="btn btn-primary btn-sm text-xs px-3 py-1.5"
            onClick={enable}
            disabled={busy}
          >
            {busy ? 'Включаю…' : 'Включить'}
          </button>
          <button
            className="btn btn-secondary btn-sm text-xs px-3 py-1.5"
            onClick={dismiss}
          >
            Не сейчас
          </button>
        </div>
      </div>
      <button
        className="text-text-muted hover:text-text flex-shrink-0"
        onClick={dismiss}
        aria-label="Закрыть"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
