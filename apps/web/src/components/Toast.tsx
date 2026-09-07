'use client';

import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  title?: string;
}

interface ToastContextValue {
  toast: (message: string, kind?: ToastKind, title?: string) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // No-op fallback if provider missing — won't crash
    return {
      toast: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
      warning: () => {},
    };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((p) => p.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, kind: ToastKind = 'info', title?: string) => {
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    setToasts((p) => [...p, { id, kind, message, title }]);
    setTimeout(() => remove(id), 5000);
  }, [remove]);

  const value: ToastContextValue = {
    toast,
    success: (m, t) => toast(m, 'success', t),
    error: (m, t) => toast(m, 'error', t),
    info: (m, t) => toast(m, 'info', t),
    warning: (m, t) => toast(m, 'warning', t),
  };

  const Icon = ({ kind }: { kind: ToastKind }) => {
    const cls = 'w-5 h-5 flex-shrink-0';
    if (kind === 'success') return <CheckCircle2 className={`${cls} text-success`} />;
    if (kind === 'error') return <XCircle className={`${cls} text-error`} />;
    if (kind === 'warning') return <AlertTriangle className={`${cls} text-warning`} />;
    return <Info className={`${cls} text-info`} />;
  };

  const bgFor = (k: ToastKind) =>
    k === 'success' ? 'bg-success/10 border-success/40'
    : k === 'error' ? 'bg-error/10 border-error/40'
    : k === 'warning' ? 'bg-warning/10 border-warning/40'
    : 'bg-info/10 border-info/40';

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed top-20 right-4 z-[1100] flex flex-col gap-2 pointer-events-none max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 p-3 pr-8 rounded-lg border shadow-md backdrop-blur ${bgFor(t.kind)}`}
            role="alert"
          >
            <Icon kind={t.kind} />
            <div className="flex-1 min-w-0">
              {t.title && <div className="font-semibold text-sm">{t.title}</div>}
              <div className="text-sm">{t.message}</div>
            </div>
            <button
              onClick={() => remove(t.id)}
              className="absolute top-2 right-2 text-text-muted hover:text-text"
              aria-label="Закрыть"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
