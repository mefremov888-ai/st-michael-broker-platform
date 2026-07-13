'use client';

import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';

// 2026-06-29: универсальный значок-уведомление i с подсказкой.
// Работает корректно и на desktop (hover), и на мобильных (tap):
// - hover: показывает подсказку (mouseenter/mouseleave)
// - click: переключает (open/close) — мобильный путь
// - tap по странице снаружи: закрывает (mousedown + touchstart listeners)
// - ширина: на узких экранах прижимается к ширине окна минус padding
// - touch target: 32x32 (через invisible padding), visible icon 16x16

interface Props {
  children: React.ReactNode;
  ariaLabel?: string;
}

export function HintIcon({ children, ariaLabel = 'Подсказка' }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={{
          padding: 8,
          margin: -8,
          background: 'transparent',
          border: 'none',
          cursor: 'help',
          color: '#888',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Info style={{ width: 16, height: 16 }} />
      </button>
      {open && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            zIndex: 30,
            width: 'min(280px, calc(100vw - 32px))',
            padding: 12,
            fontSize: 12,
            lineHeight: 1.45,
            color: '#1a1a1a',
            background: '#fff',
            border: '1px solid rgba(0,0,0,0.12)',
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
          }}
        >
          {children}
        </div>
      )}
    </span>
  );
}
