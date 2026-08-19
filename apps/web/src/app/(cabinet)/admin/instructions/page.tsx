'use client';

import Link from 'next/link';
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Database,
  PhoneCall,
  RefreshCw,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';

const employeeNums = [
  ['Арефьева Юлия', '15'],
  ['Кириллова Ксения', '30'],
  ['Корнева Александра', '17'],
  ['Уланов Артём', '18'],
  ['Цветкова Надежда', '14'],
] as const;

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2 text-sm text-text-muted">
      {items.map((item, index) => (
        <li key={item} className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
            {index + 1}
          </span>
          <span className="pt-0.5">{item}</span>
        </li>
      ))}
    </ol>
  );
}

export default function InternalInstructionsPage() {
  const { broker, loading } = useAuth();

  if (loading) {
    return <div className="card text-center text-text-muted">Загрузка…</div>;
  }

  const isInternal = broker?.role === 'ADMIN' || broker?.role === 'MANAGER';
  const isAdmin = broker?.role === 'ADMIN';

  if (!isInternal) {
    return (
      <div className="card max-w-2xl">
        <div className="flex items-center gap-2 font-semibold text-error">
          <ShieldCheck className="h-5 w-5" /> Доступ запрещён
        </div>
        <p className="mt-2 text-sm text-text-muted">
          Раздел предназначен только для внутренних сотрудников с ролью MANAGER или ADMIN.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Инструкции сотрудникам</h1>
        <p className="mt-1 text-sm text-text-muted">
          Внутренний раздел колл-центра. Не пересылайте его содержимое и рабочие идентификаторы клиентам.
        </p>
      </div>

      <div className="card border-accent/30 bg-accent/5">
        <div className="flex flex-wrap items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-accent" />
          <div>
            <div className="font-semibold">Ваша роль: {broker?.role}</div>
            <div className="text-sm text-text-muted">
              {isAdmin
                ? 'ADMIN настраивает интеграции, сотрудников и распределяет очередь.'
                : 'MANAGER работает только со своей очередью колл-центра; настройки интеграций недоступны.'}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Link href="/admin/call-center" className="card transition hover:border-accent">
          <PhoneCall className="mb-3 h-6 w-6 text-accent" />
          <div className="font-semibold">Колл-центр</div>
          <div className="mt-1 text-sm text-text-muted">Очередь, звонок через Mango и результат разговора.</div>
        </Link>
        <Link href="/admin/broker-applications" className="card transition hover:border-accent">
          <RefreshCw className="mb-3 h-6 w-6 text-accent" />
          <div className="font-semibold">Заявки и amoCRM</div>
          <div className="mt-1 text-sm text-text-muted">Статус передачи, обновление списка и безопасный повтор.</div>
        </Link>
        <Link href="/admin/loyalty-base" className="card transition hover:border-accent">
          <Database className="mb-3 h-6 w-6 text-accent" />
          <div className="font-semibold">База лояльности</div>
          <div className="mt-1 text-sm text-text-muted">Отдельно база Анны Скибицкой и наша база.</div>
        </Link>
      </div>

      <section className="card">
        <div className="mb-4 flex items-center gap-2">
          <PhoneCall className="h-5 w-5 text-accent" />
          <h2 className="text-lg font-semibold">Ежедневная работа оператора в Mango</h2>
        </div>
        <Steps
          items={[
            'Откройте «Колл-центр». Для MANAGER очередь автоматически ограничена назначенными ему брокерами.',
            'Нажмите кнопку телефона только один раз и дождитесь звонка Mango на свой внутренний номер.',
            'Возьмите трубку: после ответа Mango начнёт звонить брокеру и соединит стороны.',
            'После разговора выберите результат, добавьте рабочий комментарий и при необходимости дату следующего звонка.',
            'Сохраните результат. Если Mango сообщает, что внутренний номер не задан, обратитесь к ADMIN.',
          ]}
        />
      </section>

      <section className="card">
        <div className="mb-4 flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-accent" />
          <h2 className="text-lg font-semibold">Заявки после сбоя amoCRM</h2>
        </div>
        <Steps
          items={[
            'Откройте «Все заявки от брокеров» и выберите фильтр «Ошибка».',
            'Кнопка «Обновить» перечитывает фактические статусы с сервера.',
            'Кнопка «Повторить» возвращает фиксацию в единую очередь; обработка обычно начинается в течение пяти минут.',
            'Не нажимайте повтор несколько раз. Если у заявки уже есть amoLeadId или ошибка неоднозначна, сначала сверьте лид в amoCRM, чтобы не создать дубль.',
            'После восстановления авторизации система сама возвращает в очередь заявки, исчерпавшие повторы из-за подтверждённых 401/403.',
          ]}
        />
      </section>

      <section className="card">
        <div className="mb-4 flex items-center gap-2">
          <Database className="h-5 w-5 text-accent" />
          <h2 className="text-lg font-semibold">Работа с базой лояльности</h2>
        </div>
        <div className="grid gap-4 text-sm text-text-muted md:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <div className="mb-2 font-semibold text-text">База Анны Скибицкой</div>
            Загружается отдельными проверяемыми снимками. Её записи не перезаписывают брокеров нашей базы автоматически.
          </div>
          <div className="rounded-lg border border-border p-4">
            <div className="mb-2 font-semibold text-text">Наша база</div>
            Показывает действующие карточки кабинета. Совпадения оформляются как обратимые связи, а не как автоматическое слияние.
          </div>
        </div>
      </section>

      {isAdmin && (
        <section className="card border-info/30">
          <div className="mb-4 flex items-center gap-2">
            <Settings className="h-5 w-5 text-info" />
            <h2 className="text-lg font-semibold">Только для ADMIN: первичная настройка</h2>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center gap-2 font-semibold">
                <Users className="h-4 w-4 text-info" /> Mango EmployeeNUM
              </div>
              <div className="overflow-hidden rounded-lg border border-border text-sm">
                {employeeNums.map(([name, number]) => (
                  <div key={name} className="flex justify-between border-b border-border px-3 py-2 last:border-b-0">
                    <span>{name}</span>
                    <span className="font-mono font-semibold">{number}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-text-muted">
                Путь: «Админка — Брокеры» → карточка сотрудника → Mango EmployeeNUM → «Сохранить Mango».
                Для Анны Скибицкой номер не передан — его нужно запросить у владельца ВАТС.
              </p>
            </div>

            <div className="space-y-4 text-sm text-text-muted">
              <div>
                <div className="mb-1 flex items-center gap-2 font-semibold text-text">
                  <CheckCircle2 className="h-4 w-4 text-success" /> Учётная запись сотрудника
                </div>
                Сотрудник сначала регистрируется и устанавливает пароль. Затем ADMIN проверяет личность, статус ACTIVE и назначает роль MANAGER. Не создавать сотрудников прямым SQL.
              </div>
              <div>
                <div className="mb-1 flex items-center gap-2 font-semibold text-text">
                  <BellRing className="h-4 w-4 text-warning" /> Telegram-мониторинг
                </div>
                Токен и chat ID хранятся только в GitHub Secrets. После настройки запустите тест в Actions → Monitor broker cabinet health. Не вставляйте токены в карточки и комментарии.
              </div>
              <div>
                <div className="mb-1 flex items-center gap-2 font-semibold text-text">
                  <Settings className="h-4 w-4 text-info" /> Интеграции
                </div>
                Mango key/salt, исходящая линия и разрешённые URL настраиваются в «Интеграции». Ключ, попавший в переписку, сначала отзывается и перевыпускается.
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="card border-warning/30 bg-warning/5">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="text-sm text-text-muted">
            <div className="font-semibold text-text">Нельзя</div>
            <div className="mt-1">
              Передавать токены и пароли в чатах; назначать роли или EmployeeNUM SQL-запросом по ФИО;
              копировать в технические алерты ФИО, телефоны и email клиентов; повторно создавать лид без проверки amoCRM.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
