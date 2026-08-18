'use client';

import { useState } from 'react';
import {
  X,
  UserCheck,
  Users,
  CalendarPlus,
  Building,
  HeartHandshake,
  Calculator,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';

interface Step {
  icon: LucideIcon;
  title: string;
  text: string;
}

const baseSteps: Step[] = [
  {
    icon: UserCheck,
    title: 'Добро пожаловать в кабинет St Michael',
    text: 'Покажем за минуту, что где находится и как работать с клиентами.',
  },
  {
    icon: UserCheck,
    title: 'Проверить клиента на уникальность',
    text: 'Прежде чем работать с клиентом — всегда проверяйте его здесь первым. Если клиента ещё никто не приводил, он закрепится за вами.',
  },
  {
    icon: Users,
    title: 'Мои клиенты / заявки',
    text: 'Здесь все зафиксированные вами клиенты и их статус: «Уникален» — можно работать, «На проверке» — ждите решения менеджера, «Истёк» — уникальность нужно проверить заново (действует 30 дней), «Не уникален» — клиент уже закреплён за кем-то другим.',
  },
  {
    icon: CalendarPlus,
    title: 'Встречи и подбор квартир',
    text: 'В разделе «Записаться на встречу» назначьте показ клиенту. В «Подбор квартир» — каталог всех лотов, понравившиеся сохраняйте в «Избранное».',
  },
  {
    icon: Calculator,
    title: 'Комиссия',
    text: 'Здесь условия вознаграждения и как считается ваша комиссия по проектам.',
  },
  {
    icon: BookOpen,
    title: 'Материалы и документы',
    text: 'В «Материалах для работы» — презентации и буклеты для клиентов. В «Документах» — договоры и бумаги по сделкам.',
  },
  {
    icon: HeartHandshake,
    title: 'Готово!',
    text: 'Это всё, что нужно знать для начала. Вернуться к этой инструкции можно в любой момент — кнопка со знаком вопроса вверху экрана.',
  },
];

const dealsStep: Step = {
  icon: Building,
  title: 'Мои сделки',
  text: 'Здесь видно все ваши сделки: сумму, статус и комиссию к выплате.',
};

export function getOnboardingSteps(showDeals: boolean): Step[] {
  if (!showDeals) return baseSteps;
  return [...baseSteps.slice(0, 4), dealsStep, ...baseSteps.slice(4)];
}

export function OnboardingTour({
  steps,
  open,
  onClose,
}: {
  steps: Step[];
  open: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);

  if (!open) return null;

  const isLast = step === steps.length - 1;
  const current = steps[step];
  const Icon = current.icon;

  const close = () => {
    setStep(0);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4"
      onClick={close}
    >
      <div
        className="card max-w-md w-full min-w-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-end -mt-2 -mr-2">
          <button
            onClick={close}
            className="p-1 hover:bg-surface-secondary rounded-lg text-text-muted"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col items-center text-center px-2 pb-2">
          <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center mb-4">
            <Icon className="w-6 h-6 text-accent" />
          </div>
          <h2 className="text-lg font-semibold mb-2">{current.title}</h2>
          <p className="text-sm text-text-muted leading-relaxed">{current.text}</p>
        </div>

        <div className="flex items-center justify-center gap-1.5 my-4">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? 'w-6 bg-accent' : 'w-1.5 bg-border'
              }`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={close}
            className="text-sm text-text-muted hover:text-text px-3 py-2"
          >
            Пропустить
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="btn-secondary px-3 py-2 text-sm"
              >
                Назад
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
    </div>
  );
}
