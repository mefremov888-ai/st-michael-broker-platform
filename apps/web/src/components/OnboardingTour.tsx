'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { X, ArrowLeft } from 'lucide-react';

interface Step {
  // route === null → шаг без перехода (вступление/финал), центрированная карточка.
  route: string | null;
  // data-tour атрибут элемента, который нужно подсветить на этой странице.
  selector: string | null;
  title: string;
  text: string;
}

const baseSteps: Step[] = [
  {
    route: null,
    selector: null,
    title: 'Добро пожаловать в кабинет St Michael',
    text: 'Проведём вас по кабинету и покажем, где что находится — переключим несколько вкладок, это займёт минуту.',
  },
  {
    route: '/fixation',
    selector: 'fixation-form',
    title: 'Проверить клиента на уникальность',
    text: 'Прежде чем работать с клиентом — всегда начинайте здесь. Если клиента ещё никто не приводил, он закрепится за вами.',
  },
  {
    route: '/clients',
    selector: 'clients-table',
    title: 'Мои клиенты / заявки',
    text: 'Здесь все зафиксированные вами клиенты и статус: «Уникален» — можно работать, «На проверке» — ждите менеджера, «Истёк» — проверяйте заново (30 дней), «Не уникален» — клиент уже закреплён за кем-то другим.',
  },
  {
    route: '/meetings',
    selector: 'meetings-section',
    title: 'Записаться на встречу',
    text: 'Отсюда назначаете показ клиенту.',
  },
  {
    route: '/catalog',
    selector: 'catalog-filters',
    title: 'Подбор квартир',
    text: 'Каталог всех лотов с фильтрами. Понравившиеся сохраняйте в «Избранное» — соседний пункт меню.',
  },
  {
    route: '/commission',
    selector: 'commission-card',
    title: 'Комиссия',
    text: 'Ваша текущая ставка и условия вознаграждения по проектам.',
  },
  {
    route: '/materials',
    selector: 'materials-grid',
    title: 'Материалы для работы',
    text: 'Презентации и буклеты для клиентов, по проектам.',
  },
  {
    route: '/documents',
    selector: 'documents-list',
    title: 'Документы',
    text: 'Договор-оферта и бумаги по сделкам.',
  },
  {
    route: null,
    selector: null,
    title: 'Готово!',
    text: 'Это всё, что нужно знать для начала. Вернуться к этой инструкции можно в любой момент — кнопка со знаком вопроса вверху экрана.',
  },
];

const dealsStep: Step = {
  route: '/deals',
  selector: 'deals-summary',
  title: 'Мои сделки',
  text: 'Сумма, статус и комиссия к выплате по вашим сделкам.',
};

export function getOnboardingSteps(showDeals: boolean): Step[] {
  if (!showDeals) return baseSteps;
  // Вставляем «Мои сделки» после каталога, перед комиссией.
  const catalogIdx = baseSteps.findIndex((s) => s.route === '/catalog');
  return [...baseSteps.slice(0, catalogIdx + 1), dealsStep, ...baseSteps.slice(catalogIdx + 1)];
}

const FIND_TIMEOUT_MS = 3000;
const CARD_WIDTH = 340;
const MARGIN = 16;

export function OnboardingTour({
  steps,
  open,
  onClose,
}: {
  steps: Step[];
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [step, setStep] = useState(0);
  // Прямоугольник подсвечиваемого элемента, null = центрированная карточка.
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [ready, setReady] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);

  const current = steps[step];
  const isLast = step === steps.length - 1;
  const arrivedOnTarget = !current.route || pathname === current.route;

  // Переход на страницу нужного шага.
  useEffect(() => {
    if (!open) return;
    if (current.route && pathname !== current.route) {
      setReady(false);
      setRect(null);
      router.push(current.route);
    }
  }, [open, step, current.route, pathname, router]);

  // Поиск и подсветка целевого элемента после того как страница открылась.
  useEffect(() => {
    if (!open || !arrivedOnTarget) return;
    if (!current.selector) {
      setRect(null);
      setReady(true);
      return;
    }
    setReady(false);
    let cancelled = false;
    const started = Date.now();

    const tryFind = () => {
      if (cancelled) return;
      const el = document.querySelector(`[data-tour="${current.selector}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
          if (cancelled) return;
          setRect(el.getBoundingClientRect());
          setReady(true);
        }, 300);
        return;
      }
      if (Date.now() - started > FIND_TIMEOUT_MS) {
        // Не нашли — показываем центрированную карточку вместо подсветки.
        setRect(null);
        setReady(true);
        return;
      }
      setTimeout(tryFind, 150);
    };
    tryFind();

    return () => {
      cancelled = true;
    };
  }, [open, step, arrivedOnTarget, current.selector]);

  // Пересчёт позиции при скролле/ресайзе, пока подсвечен реальный элемент.
  useEffect(() => {
    if (!open || !current.selector || !ready) return;
    const update = () => {
      const el = document.querySelector(`[data-tour="${current.selector}"]`) as HTMLElement | null;
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, current.selector, ready]);

  // Позиционирование карточки: рядом с подсвеченным элементом или по центру.
  useLayoutEffect(() => {
    if (!open || !ready) return;
    const cardH = cardRef.current?.offsetHeight || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(CARD_WIDTH, vw - MARGIN * 2);

    if (!rect) {
      setCardPos({ top: Math.max(MARGIN, vh / 2 - cardH / 2), left: Math.max(MARGIN, vw / 2 - width / 2) });
      return;
    }

    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.min(Math.max(left, MARGIN), vw - width - MARGIN);

    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    let top: number;
    if (spaceBelow >= cardH + 24) {
      top = rect.bottom + 12;
    } else if (spaceAbove >= cardH + 24) {
      top = rect.top - cardH - 12;
    } else {
      top = Math.max(MARGIN, vh / 2 - cardH / 2);
    }
    top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - cardH - MARGIN));

    setCardPos({ top, left });
  }, [open, ready, rect, step]);

  if (!open) return null;

  const close = () => {
    setStep(0);
    setRect(null);
    setReady(false);
    onClose();
  };

  const width = Math.min(CARD_WIDTH, (typeof window !== 'undefined' ? window.innerWidth : 400) - MARGIN * 2);

  return (
    <>
      {/* Затемнение. Пока едем на нужную страницу или ищем элемент — просто дим без выреза. */}
      <div
        className="fixed inset-0 bg-black/55 z-[60] transition-opacity"
        style={{ pointerEvents: rect ? 'none' : 'auto' }}
        onClick={rect ? undefined : close}
      />

      {/* Подсветка целевого элемента — вырез через огромный box-shadow. */}
      {rect && ready && (
        <div
          className="fixed z-[61] rounded-lg ring-2 ring-accent transition-all duration-200 pointer-events-none"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
        />
      )}

      {/* Карточка с текстом шага. */}
      <div
        ref={cardRef}
        className="card fixed z-[62] min-w-0"
        style={{
          width,
          top: cardPos?.top ?? '50%',
          left: cardPos?.left ?? '50%',
          visibility: ready && cardPos ? 'visible' : 'hidden',
          opacity: ready && cardPos ? 1 : 0,
        }}
      >
        <div className="flex justify-end -mt-2 -mr-2">
          <button onClick={close} className="p-1 hover:bg-surface-secondary rounded-lg text-text-muted" aria-label="Закрыть">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-1 pb-1">
          <h2 className="text-base font-semibold mb-1.5">{current.title}</h2>
          <p className="text-sm text-text-muted leading-relaxed">{current.text}</p>
        </div>

        <div className="flex items-center justify-center gap-1.5 my-3">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-accent' : 'w-1.5 bg-border'}`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button onClick={close} className="text-sm text-text-muted hover:text-text px-2 py-2">
            Пропустить
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="btn-secondary px-3 py-2 text-sm flex items-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Назад
              </button>
            )}
            <button
              onClick={() => (isLast ? close() : setStep((s) => s + 1))}
              className="btn-primary px-4 py-2 text-sm"
            >
              {isLast ? 'Готово' : 'Далее'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
