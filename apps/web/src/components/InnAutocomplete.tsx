'use client';

import { useEffect, useRef, useState } from 'react';

// 2026-06-26: автодополнение поля ИНН через Dadata Suggestions API
// (бэк-эндпоинт /api/public/agencies/suggest). При вводе 4+ цифр
// показывает выпадающий список юр.лиц/ИП; клик подставляет ИНН и
// дёргает onSelect с названием — родительская форма автозаполняет
// поле «Название агентства». Поле НЕ блокируется после выбора —
// пользователь может вручную поправить или стереть и выбрать другое.

export interface InnSuggestion {
  inn: string;
  name: string;
  fullName: string;
  type: 'LEGAL' | 'INDIVIDUAL';
  status: string;
  address: string;
}

interface Props {
  value: string;
  onChange: (inn: string) => void;
  onSelect?: (s: InnSuggestion) => void;
  placeholder?: string;
  inputClassName?: string;
  inputMode?: 'text' | 'numeric';
  maxLength?: number;
  inputStyle?: React.CSSProperties;
}

export function InnAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = 'ИНН (10 или 12 цифр)',
  inputClassName = 'input',
  inputMode = 'numeric',
  maxLength = 12,
  inputStyle,
}: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InnSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [justPicked, setJustPicked] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Debounced fetch
  useEffect(() => {
    // Сразу после клика по подсказке не перезапускаем поиск (избегаем
    // мгновенного "повторного" dropdown с теми же вариантами).
    if (justPicked) {
      setJustPicked(false);
      return;
    }
    const trimmed = (value || '').trim();
    if (trimmed.length < 4) {
      setItems([]);
      setOpen(false);
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/public/agencies/suggest?q=${encodeURIComponent(trimmed)}`);
        if (!res.ok) {
          setItems([]);
          return;
        }
        const data = (await res.json()) as InnSuggestion[];
        setItems(Array.isArray(data) ? data : []);
        setOpen(Array.isArray(data) && data.length > 0);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [value, justPicked]);

  // Клик вне компонента закрывает dropdown
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const handlePick = (s: InnSuggestion) => {
    setJustPicked(true);
    setOpen(false);
    setItems([]);
    onChange(s.inn);
    if (onSelect) onSelect(s);
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <input
        type="text"
        inputMode={inputMode}
        className={inputClassName}
        placeholder={placeholder}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, maxLength))}
        onFocus={() => { if (items.length > 0) setOpen(true); }}
        autoComplete="off"
        style={inputStyle}
      />
      {open && items.length > 0 && (
        <ul
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 50,
            marginTop: 4,
            background: 'var(--surface, #fff)',
            border: '1px solid var(--border, rgba(0,0,0,0.12))',
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
            maxHeight: 320,
            overflowY: 'auto',
            listStyle: 'none',
            padding: 4,
            margin: 0,
          }}
        >
          {items.map((s) => (
            <li key={s.inn + '|' + s.name}>
              <button
                type="button"
                onClick={() => handlePick(s)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  borderRadius: 4,
                  fontSize: 13,
                  lineHeight: 1.4,
                  color: 'inherit',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,0,0,0.04)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ fontWeight: 500 }}>
                  {s.name}
                  {s.status && s.status !== 'ACTIVE' && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: '#c0392b' }}>
                      ({s.status === 'LIQUIDATED' ? 'ликвидировано' : s.status.toLowerCase()})
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                  ИНН {s.inn}
                  {s.address && <span> · {s.address}</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && open && items.length === 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, fontSize: 12, color: '#888' }}>
          Поиск…
        </div>
      )}
    </div>
  );
}
