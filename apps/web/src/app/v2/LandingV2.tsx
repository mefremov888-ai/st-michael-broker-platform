'use client';

// 2026-09-28: новый лендинг кабинета брокера по макету Figma «Кабинет брокера»
// (Ринат Габитов), фрейм 1920×7004 (версия от 28.09, вечер). Вёрстка один в один под 1920; ниже 1440
// страница масштабируется целиком. Мобильная версия — после финальных правок
// (решение владельца 28.09). Данные — те же публичные API, что у старого
// лендинга; «Стать партнёром» = заявка «перезвоним за 1 час», которая уходит
// в amoCRM задачей в воронку КЦ (source landing-callback).

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

export interface LandingV2Data {
  content: any;
  projects: any[];
  events: any[];
  promos: any[];
  news: any[];
  cooperationDocs: any[];
  materials: Record<string, { photo: number; video: number; doc: number; total: number }>;
}

const PROJECT_PAGES: Record<string, string> = {
  zorge9: 'https://stmichael.ru/projects/zorge-9/',
  'silver-bor': 'https://stmichael.ru/projects/kvartal-serebryanyj-bor/',
};
const PROJECT_PHOTOS: Record<string, string> = {
  zorge9: '/v2/img/project-zorge9.webp',
  'silver-bor': '/v2/img/project-silver-bor.webp',
};
// Тексты карточек — буква в букву из макета (28.09, фрейм 7004); описание из CMS
// имеет приоритет, константа — фолбэк. cta — текст кнопки: в Зорге 9 продаются
// апартаменты, в Серебряном Бору — квартиры (правка владельца 29.09).
const PROJECT_FALLBACK: Record<string, { name: string; address: string; floors?: string; ready?: string; classType?: string; description: string; cta: string }> = {
  zorge9: {
    name: 'ЖК «Зорге 9»', address: 'ул. Зорге, 9А, корп. 1', floors: '23 эт.', classType: 'Бизнес-класс', ready: 'Дом готов', cta: 'Выбрать апартаменты',
    description: 'Апартаменты бизнес-класса у метро Полежаевская. Высотный корпус с авторским гранд-лобби, парком 2 га и фитнесом 3000 м² с бассейном 25 м. Архитектура — лауреат European Property Awards.',
  },
  'silver-bor': {
    name: 'Квартал Серебряный Бор', address: 'ул. Берзарина, 37', floors: '16-25 эт.', classType: 'Премиум-класс', ready: 'II кв. 2027', cta: 'Выбрать квартиры',
    description: 'Квартиры премиум-класса рядом с природным заповедником Серебряный Бор. Архитектурное решение от Apex Project Bureau — современные формы, эстетика, гармония с природой.',
  },
};
// Третья карточка макета — «Маршала Толбухина 3»: проекта в кабинете нет,
// продажи не стартовали, поэтому карточка статическая (кнопка некликабельная).
const TOLBUKHINA = {
  name: 'Маршала Толбухина 3', address: 'ул. Толбухина, вл. 3', tags: ['II кв. 2029', 'МФК', '14 эт.'], photo: '/v2/img/project-tolbukhina.webp',
  description: 'Проект станет знаковым в сохранение культурного наследия Москвы. В архитектурный ансамбль органично интегрировано историческое здание дачи маршала СССР Федора Толбухина.',
};

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const fmtNewsDate = (iso: string) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS_RU[d.getMonth()]} ${d.getFullYear()}`; };

// Переносы строк (\n) — как в макете: браузер считает текст на ~1 px уже Figma
// и у границы блока переносил бы иначе; выводим через white-space: pre-line.
const STEPS = [
  { title: 'Проверка на уникальность', text: 'Проверьте клиента в кабинете\nперед сделкой' },
  { title: 'Встреча в офисе продаж', text: 'Запишите клиента на встречу\nв офис продаж' },
  { title: 'Фиксация клиента', text: 'После встречи клиент закреплён\nза вами на 30 дней' },
  { title: 'Сделка и выплата', text: 'После оплаты клиентом, вознаграждение\nприходит за 7 рабочих дней' },
];

// icon — номер svg в /v2/svg/reason-0N.svg (порядок файлов остался от первой
// версии макета: 02 = стрелка роста, 03 = щит, 04 = искры, 05 = кошелёк).

const ROMAN = ['', 'I', 'II', 'III', 'IV'];
const DOW_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
// Слайды «Акций» по умолчанию (тексты утверждены владельцем 29.09) — показываются,
// когда в CMS нет активных акций с картинкой. Перенос заголовка задан явно (\n).
// 30.09 (владелец): затемнение фото (shade) убрано — под текстом мягкая тень. Кадры 2720×1200.
// 01.10 (мобильная версия): imageUrlMobile — вертикальный кадр 3:4 (600×800) из той же полосы.
const DEFAULT_PROMOS = [
  { id: 'default-commission', title: 'Комиссия\nза сделку до 6%', imageUrl: '/v2/img/promo-1b.webp', imageUrlMobile: '/v2/img/promo-m-1.webp' },
  { id: 'default-payout', title: 'Выплата\nза 7 рабочих дней', imageUrl: '/v2/img/promo-2.webp', imageUrlMobile: '/v2/img/promo-m-2.webp' },
  { id: 'default-fixation', title: 'Клиент закреплён\nза вами на 30 дней', imageUrl: '/v2/img/promo-3b.webp', imageUrlMobile: '/v2/img/promo-m-3.webp' },
  { id: 'default-tours', title: 'Брокер-туры\nкаждый будний день', imageUrl: '/v2/img/promo-4.webp', imageUrlMobile: '/v2/img/promo-m-4.webp' },
];

// ─── мобильная версия (решения владельца 01.10) ─────────────────────────────
// Ширина ≤ 768: отдельная раскладка медиа-запросами в v2.css (zoom выключен),
// в разметке отличаются только меню (полноэкранная панель), календарь месяца
// (список дней вместо сетки) и свайпы. До гидрации считаем, что это десктоп —
// внешний вид задаёт CSS, поэтому «прыжка» раскладки нет.
const MOBILE_MQ = '(max-width: 768px)';

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return mobile;
}

/** Свайп по горизонтали (touch): dx > 40px → onLeft/onRight. Вертикальный жест не трогаем. */
function useSwipe(onLeft: () => void, onRight: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent) => { const t = e.touches[0]; start.current = t ? { x: t.clientX, y: t.clientY } : null; },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = start.current;
      start.current = null;
      const t = e.changedTouches[0];
      if (!s || !t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) <= 40 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) onLeft(); else onRight();
    },
  };
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const fmtDay = (d: Date) => `${DOW_RU[d.getDay()]}. ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
const fmtTime = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** «Брокер-тур: Зорге 9 + Серебряный Бор» → ['Зорге 9', 'Квартал Серебряный Бор'] */
function projectsFromTitle(title: string): string[] {
  const raw = String(title || '').replace(/^\s*брокер-тур\s*:?\s*/i, '');
  const parts = raw.split(/\s*[+,\/]\s*/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const v = p.toLowerCase();
    if (v.includes('коммерц')) out.push('Коммерция Зорге 9');
    else if (v.includes('зорге') || v.includes('zorge')) out.push('Зорге 9');
    else if (v.includes('сереб') || v.includes('берзар') || v.includes('silver') || v.includes('ксб')) out.push('Квартал Серебряный Бор');
    else if (p) out.push(p);
  }
  return out.length ? out : [raw || 'Брокер-тур'];
}

/** Рабочая неделя (Пн–Пт) с понедельника текущей недели + смещение в неделях. */
function workWeek(offsetWeeks = 0): Date[] {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + offsetWeeks * 7);
  return Array.from({ length: 5 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
}

/** Расписание как на старом сайте: если в админке нет событий на неделю —
 *  типовые слоты (11:00 Квартал Серебряный Бор, 15:00 Зорге 9 + КСБ). */
function slotsForDay(day: Date, events: any[]): Array<{ time: string; projects: string[] }> {
  const key = dayKey(day);
  const own = events
    .map((e) => ({ e, d: new Date(e.date) }))
    .filter(({ d }) => dayKey(d) === key)
    .sort((a, b) => a.d.getTime() - b.d.getTime());
  if (own.length) {
    const byTime = new Map<string, string[]>();
    for (const { e, d } of own) {
      const t = fmtTime(d);
      const list = byTime.get(t) || [];
      for (const p of projectsFromTitle(e.title)) if (!list.includes(p)) list.push(p);
      byTime.set(t, list);
    }
    return [...byTime.entries()].map(([time, projects]) => ({ time, projects }));
  }
  const dow = day.getDay();
  if (dow === 0 || dow === 6) return [];
  return [
    { time: '11:00', projects: ['Квартал Серебряный Бор'] },
    { time: '15:00', projects: ['Зорге 9', 'Квартал Серебряный Бор'] },
  ];
}

// ─── телефон с маской (правка владельца 01.10) ──────────────────────────────
// Храним только 10 цифр после +7; показываем «+7 (912) 455-72-74». Разделители
// ставятся сразу, как только группа заполнена, — тогда Backspace по разделителю
// удаляет предыдущую цифру (см. onChange в PhoneInput). Вставка из буфера в любом
// формате (8…, 7…, +7…, 9…, с пробелами/скобками) сводится к тем же 10 цифрам.

/** Цифры номера из того, что лежит в поле: префикс «+7» отбрасываем, лишнюю ведущую 7/8 — тоже. */
function parsePhoneDigits(raw: string): string {
  const s = raw.startsWith('+7') ? raw.slice(2) : raw;
  let d = s.replace(/\D/g, '');
  if (d.length > 10 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
  return d.slice(0, 10);
}

function formatPhone(d: string, focused: boolean): string {
  if (!d) return focused ? '+7 ' : '';
  let s = '+7 (' + d.slice(0, 3);
  if (d.length >= 3) s += ') ' + d.slice(3, 6);
  if (d.length >= 6) s += '-' + d.slice(6, 8);
  if (d.length >= 8) s += '-' + d.slice(8, 10);
  return s;
}

/** Позиция каретки в отформатированной строке после n-й цифры номера
 *  (и после идущих следом разделителей — чтобы каретка стояла перед следующей цифрой). */
function caretAfterDigits(formatted: string, n: number): number {
  let seen = 0;
  let pos = formatted.length >= 4 ? 4 : formatted.length; // после «+7 (»
  if (n > 0) {
    for (let i = 2; i < formatted.length; i++) {
      if (/\d/.test(formatted[i])) { seen++; if (seen === n) { pos = i + 1; break; } }
    }
    if (seen < n) return formatted.length;
  }
  while (pos < formatted.length && !/\d/.test(formatted[pos])) pos++;
  return pos;
}

/** Нормализация «как раньше» — для значений не из PhoneInput (на всякий случай). */
function normalizePhone(v: string): string {
  const d = parsePhoneDigits(v);
  return d ? '+7' + d : '';
}

function PhoneInput({ digits, onChange, invalid, onEnter }: { digits: string; onChange: (digits: string) => void; invalid?: boolean; onEnter?: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const caretRef = useRef<number | null>(null);
  const display = formatPhone(digits, focused);

  useEffect(() => {
    const el = ref.current;
    if (!el || caretRef.current == null) return;
    const pos = Math.min(caretRef.current, el.value.length);
    caretRef.current = null;
    if (document.activeElement === el) el.setSelectionRange(pos, pos);
  }, [display]);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const raw = el.value;
    const caret = el.selectionStart ?? raw.length;
    let d = parsePhoneDigits(raw);
    let n = parsePhoneDigits(raw.slice(0, caret)).length;
    // удалили только разделитель (цифры те же, строка короче) — убираем цифру перед кареткой
    if (raw.length < display.length && d === digits && n > 0) {
      d = d.slice(0, n - 1) + d.slice(n);
      n -= 1;
    }
    const next = formatPhone(d, true);
    caretRef.current = caret >= raw.length || n >= d.length ? next.length : caretAfterDigits(next, n);
    onChange(d);
  };

  return (
    <input
      ref={ref}
      className={`v2-input${invalid ? ' v2-input--invalid' : ''}`}
      type="tel"
      inputMode="numeric"
      autoComplete="tel"
      placeholder="Телефон"
      value={display}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={handle}
      onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) onEnter(); }}
      aria-invalid={invalid || undefined}
    />
  );
}

// ─── модалки ────────────────────────────────────────────────────────────────

function Modal({ onClose, className, children }: { onClose: () => void; className?: string; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="v2-overlay" onClick={onClose}>
      <div className={`v2-modal${className ? ' ' + className : ''}`} onClick={(e) => e.stopPropagation()}>
        <button className="v2-modal-close" aria-label="Закрыть" onClick={onClose}>×</button>
        {children}
      </div>
    </div>
  );
}

// initialMessage — предзаполненный комментарий (дата и время слота из календаря
// брокер-туров); уходит в amoCRM примечанием к лиду (поле message → note).
function LeadForm({ source, title, subtitle, buttonText, withMessage, initialMessage, onClose }: { source: 'landing-callback' | 'broker-tour'; title: string; subtitle: string; buttonText: string; withMessage?: boolean; initialMessage?: string; onClose: () => void }) {
  const [name, setName] = useState('');
  // 01.10: телефон — только 10 цифр после +7 (маска в PhoneInput); на сервер уходит +7XXXXXXXXXX
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [message, setMessage] = useState(initialMessage || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async () => {
    setError('');
    setPhoneError('');
    if (name.trim().length < 2) return setError('Введите имя');
    const p = '+7' + phone;
    if (!/^\+7\d{10}$/.test(p)) return setPhoneError('Введите 10 цифр номера');
    setLoading(true);
    try {
      const res = await fetch('/api/public/cms/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), phone: p, message: message.trim() || undefined, source }),
      });
      if (res.ok) setSent(true);
      else {
        const d = await res.json().catch(() => ({}));
        setError(d?.message || 'Не удалось отправить. Попробуйте ещё раз.');
      }
    } catch {
      setError('Ошибка соединения. Попробуйте ещё раз.');
    }
    setLoading(false);
  };

  return (
    <Modal onClose={onClose}>
      <h3>{title}</h3>
      <p className="v2-modal-sub">{subtitle}</p>
      {sent ? (
        <div className="v2-ok" style={{ marginTop: 24 }}>
          <b>Заявка принята.</b><br />
          {source === 'landing-callback' ? 'Перезвоним в течение часа.' : 'Менеджер свяжется с вами, чтобы подтвердить запись.'}
        </div>
      ) : (
        <div className="v2-form">
          {error && <div className="v2-error">{error}</div>}
          <input className="v2-input" placeholder="Ваше имя" value={name} onChange={(e) => setName(e.target.value)} />
          <PhoneInput digits={phone} invalid={!!phoneError} onChange={(d) => { setPhone(d); if (phoneError) setPhoneError(''); }} onEnter={submit} />
          {phoneError && <div className="v2-field-hint">{phoneError}</div>}
          {withMessage && (
            <textarea className="v2-input v2-textarea" placeholder="Какой проект и удобная дата" value={message} onChange={(e) => setMessage(e.target.value)} />
          )}
          <button className="v2-btn v2-btn--dark" onClick={submit} disabled={loading}>{loading ? 'Отправляем…' : buttonText}</button>
        </div>
      )}
    </Modal>
  );
}

function ConditionsModal({ docs, onClose }: { docs: any[]; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>Условия сотрудничества</h3>
      <p className="v2-modal-sub">Актуальные документы: комиссия, регламент, оферта</p>
      {docs.length === 0 ? (
        <div className="v2-ok" style={{ marginTop: 24, color: '#999', background: '#f6f6f6' }}>Документы появятся здесь после публикации в админке.</div>
      ) : (
        <div className="v2-doclist">
          {docs.map((d) => (
            <a key={d.id} href={d.fileUrl} target="_blank" rel="noopener noreferrer">
              {d.name || d.title || 'Документ'}
              <span>{String(d.type || '').toUpperCase()}</span>
            </a>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ─── календарь брокер-туров (правка владельца 29.09) ────────────────────────
// Настоящий календарь месяца: шапка с названием и стрелками (текущий месяц и
// два следующих), сетка Пн–Вс, выходные и прошедшие дни приглушены, сегодня —
// золотая ячейка. В ячейке до двух строк слотов «11:00 · КСБ»; клик по слоту
// или по дню открывает форму записи с предзаполненными датой и временем.

const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DOW_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_AHEAD = 2;
const WEEKS_AHEAD = 8; // листание недель на главной (01.10)
const PROJECT_ABBR: Record<string, string> = { 'Квартал Серебряный Бор': 'КСБ', 'Коммерция Зорге 9': 'Коммерция З9' };
const abbrProjects = (list: string[]) => list.map((p) => PROJECT_ABBR[p] || p).join(' + ');

/** Сетка месяца: недели с понедельника, дни соседних месяцев — null. */
function monthGrid(year: number, month: number): Array<Date | null> {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const total = new Date(year, month + 1, 0).getDate();
  const cells: Array<Date | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= total; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** Текст комментария в форму записи: «Брокер-тур 30.09.2026 в 11:00 — Квартал Серебряный Бор». */
function tourPresetText(day: Date, slot?: { time: string; projects: string[] }): string {
  const date = `${String(day.getDate()).padStart(2, '0')}.${String(day.getMonth() + 1).padStart(2, '0')}.${day.getFullYear()}`;
  if (!slot) return `Брокер-тур ${date}`;
  return `Брокер-тур ${date} в ${slot.time} — ${slot.projects.join(', ')}`;
}

const CalArrow = () => (
  <svg width="8" height="14" viewBox="0 0 8 14" fill="none" aria-hidden="true">
    <path d="M1.5 1.5 L6.5 7 L1.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function MonthModal({ events, onClose, onBook }: { events: any[]; onClose: () => void; onBook: (preset?: string) => void }) {
  const today = new Date();
  const todayKey = dayKey(today);
  const [offset, setOffset] = useState(0);
  const year = today.getFullYear();
  const month = today.getMonth() + offset;
  const shown = new Date(year, month, 1);
  const cells = monthGrid(shown.getFullYear(), shown.getMonth());
  // 01.10 (мобильная версия): вместо сетки 7 колонок — список дней с турами (прошедшие и пустые дни не показываем)
  const mobile = useIsMobile();
  const listDays = mobile
    ? cells.filter((d): d is Date => !!d && dayKey(d) >= todayKey && slotsForDay(d, events).length > 0)
    : [];

  return (
    <Modal onClose={onClose} className="v2-modal--calendar">
      <div className="v2-cal-head">
        <div>
          <h3>Расписание брокер-туров на месяц</h3>
          <p className="v2-modal-sub">Нажмите на день или время, чтобы записаться</p>
        </div>
        <div className="v2-cal-nav">
          <button className="v2-cal-arrow v2-cal-arrow--prev" aria-label="Предыдущий месяц" disabled={offset <= 0} onClick={() => setOffset((v) => Math.max(0, v - 1))}><CalArrow /></button>
          <div className="v2-cal-month">{MONTHS_NOM[shown.getMonth()]} {shown.getFullYear()}</div>
          <button className="v2-cal-arrow" aria-label="Следующий месяц" disabled={offset >= MONTHS_AHEAD} onClick={() => setOffset((v) => Math.min(MONTHS_AHEAD, v + 1))}><CalArrow /></button>
        </div>
      </div>
      {mobile ? (
        <div className="v2-cal-list">
          {listDays.length === 0 && <div className="v2-day-empty">В этом месяце туров нет</div>}
          {listDays.map((day) => {
            const key = dayKey(day);
            const slots = slotsForDay(day, events);
            return (
              <div key={key} className={`v2-cal-row${key === todayKey ? ' v2-cal-row--today' : ''}`}>
                <div className="v2-cal-row-date">{fmtDay(day)}</div>
                <div className="v2-cal-row-slots">
                  {slots.map((s) => (
                    <button key={s.time} type="button" className="v2-cal-slot" onClick={() => onBook(tourPresetText(day, s))}>
                      <b>{s.time}</b> · {s.projects.join(' + ')}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (<>
      <div className="v2-cal-dow">
        {DOW_SHORT.map((d, i) => <div key={d} className={i >= 5 ? 'v2-cal-dow--weekend' : ''}>{d}</div>)}
      </div>
      <div className="v2-cal-grid">
        {cells.map((day, i) => {
          if (!day) return <div key={'e' + i} className="v2-cal-cell v2-cal-cell--empty" />;
          const key = dayKey(day);
          const slots = slotsForDay(day, events);
          const isToday = key === todayKey;
          const isPast = key < todayKey;
          const isWeekend = day.getDay() === 0 || day.getDay() === 6;
          const clickable = !isPast && slots.length > 0;
          const cls = ['v2-cal-cell', isToday && 'v2-cal-cell--today', isPast && 'v2-cal-cell--past', isWeekend && 'v2-cal-cell--weekend', clickable && 'v2-cal-cell--active']
            .filter(Boolean).join(' ');
          const openDay = () => { if (clickable) onBook(tourPresetText(day, slots[0])); };
          return (
            <div key={key} className={cls} onClick={openDay} role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
              onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDay(); } }}>
              <div className="v2-cal-num">{day.getDate()}</div>
              {!isPast && slots.slice(0, 2).map((s) => {
                const full = `${s.time} · ${s.projects.join(' + ')}`;
                return (
                  <button key={s.time} type="button" className="v2-cal-slot" title={full}
                    onClick={(e) => { e.stopPropagation(); onBook(tourPresetText(day, s)); }}>
                    <b>{s.time}</b> · {abbrProjects(s.projects)}
                  </button>
                );
              })}
              {!isPast && slots.length > 2 && <div className="v2-cal-more">ещё {slots.length - 2}</div>}
            </div>
          );
        })}
      </div>
      </>)}
      <div className="v2-cal-foot">
        <p className="v2-modal-sub">Запись — по кнопке «Записаться на брокер-тур» или по телефону</p>
        <button className="v2-btn v2-btn--dark" onClick={() => onBook()}>Записаться на брокер-тур</button>
      </div>
    </Modal>
  );
}

// 2026-09-28 (обновление макета): карусель «Акции» — фото на всю ширину
// контейнера 1360×600, заголовок белым, стрелки по бокам, точки слева внизу.
// Данные — CMS-акции; если их нет — один слайд из макета.
// 30.09 (владелец): стрелки — белые полупрозрачные круги с тёмным шевроном (как на примере).
const PromoArrow = () => (
  <svg width="10" height="18" viewBox="0 0 10 18" fill="none" aria-hidden="true">
    <path d="M1.5 1.5 L8.5 9 L1.5 16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ─── карусель новостей (правка владельца 30.09) ─────────────────────────────
// Видно 4 карточки 322×360; листаем по одной с плавным сдвигом трека (300 мс).
// Стрелки — белые круги 40 на краю крайней карточки, по центру обложки;
// левая появляется, когда есть куда вернуться, правая — пока есть скрытые карточки.
const NEWS_VISIBLE = 4;
const NEWS_STEP = 322 + 24;

function NewsCarousel({ items }: { items: any[] }) {
  const [start, setStart] = useState(0);
  const maxStart = Math.max(0, items.length - NEWS_VISIBLE);
  const at = Math.min(start, maxStart);
  return (
    <div className="v2-news-wrap">
      <div className="v2-news-viewport">
        <div className="v2-news" style={{ transform: `translateX(${-at * NEWS_STEP}px)` }}>
          {items.map((n) => (
            <a className="v2-ncard v2-hcard" key={n.id} href={n.url || '#'} target="_blank" rel="noopener noreferrer">
              {n.imageUrl ? <img className="v2-ncard-cover" src={n.imageUrl} alt="" /> : <div className="v2-ncard-cover" />}
              <div className="v2-ncard-title">{n.title}</div>
              <div className="v2-ncard-meta">{n.publishedAt ? fmtNewsDate(n.publishedAt) : ''}{n.source ? ` · ${n.source}` : ''}</div>
            </a>
          ))}
        </div>
      </div>
      {at > 0 && (
        <button type="button" className="v2-news-arrow v2-news-arrow--prev" aria-label="Предыдущие новости" onClick={() => setStart(Math.max(0, at - 1))}><CalArrow /></button>
      )}
      {at < maxStart && (
        <button type="button" className="v2-news-arrow v2-news-arrow--next" aria-label="Следующие новости" onClick={() => setStart(Math.min(maxStart, at + 1))}><CalArrow /></button>
      )}
    </div>
  );
}

// onTour — мобильная кнопка «Записаться на брокер-тур» сразу под слайдером (01.10); на десктопе скрыта CSS.
function PromoCarousel({ promos, onTour }: { promos: any[]; onTour: () => void }) {
  // CMS-акции с фото имеют приоритет; без них — четыре типовых слайда
  const withImage = promos.filter((p) => p.imageUrl);
  const slides: any[] = withImage.length ? withImage : DEFAULT_PROMOS;
  const [index, setIndex] = useState(0);
  // 01.10 (владелец): ручной клик по стрелке/точке останавливает автопрокрутку;
  // через 4 с паузы она возобновляется с обычным интервалом 6 с. Каждый клик
  // увеличивает manualTick — эффект перезапускает таймеры заново.
  const [manualTick, setManualTick] = useState(0);
  const count = slides.length;
  useEffect(() => {
    if (count < 2) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    let pause: ReturnType<typeof setTimeout> | undefined;
    const start = () => { interval = setInterval(() => setIndex((v) => (v + 1) % count), 6000); };
    if (manualTick > 0) pause = setTimeout(start, 4000);
    else start();
    return () => { if (pause) clearTimeout(pause); if (interval) clearInterval(interval); };
  }, [count, manualTick]);
  const goTo = (k: number) => { setIndex(((k % count) + count) % count); setManualTick((t) => t + 1); };
  // 01.10 (мобильная версия): свайп влево/вправо листает так же, как стрелки (с паузой автопрокрутки)
  const swipe = useSwipe(() => goTo(index + 1), () => goTo(index - 1));
  // 29.09: подгружаем фото всех слайдов заранее — иначе при автопрокрутке
  // следующий слайд показывал тёмный фон, пока картинка качалась.
  // 01.10: на мобильном грузим вертикальные кадры (imageUrlMobile), если они есть.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mobile = window.matchMedia(MOBILE_MQ).matches;
    for (const s of slides) {
      const src = (mobile && s.imageUrlMobile) || s.imageUrl;
      if (!src) continue;
      const img = new window.Image();
      img.src = src;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);
  const active = index % count;
  // 30.09 (владелец): слайды лежат стопкой и сменяются через прозрачность
  // (fade in / fade out), точки «морфятся» из круга в пилюлю через CSS-transition.
  // Фон слайда — через CSS-переменные: --v2-slide (десктоп) и --v2-slide-m (вертикальный
  // кадр для ≤768, см. медиа-блок в v2.css); так картинка выбирается без JS и без «прыжка».
  return (
    <section className="v2-section" id="promos">
      <div className="v2-container">
        <div className="v2-promo" {...swipe}>
          {slides.map((s: any, k: number) => (
            <div
              key={s.id || k}
              className={`v2-promo-slide${k === active ? ' is-active' : ''}`}
              style={{ '--v2-slide': `url(${s.imageUrl || DEFAULT_PROMOS[0].imageUrl})`, '--v2-slide-m': `url(${s.imageUrlMobile || s.imageUrl || DEFAULT_PROMOS[0].imageUrl})` } as React.CSSProperties}
              aria-hidden={k !== active}
            >
              <h2 className="v2-promo-title">{String(s.title || '').split('\n').map((line: string, li: number) => <span key={li}><i>{line}</i></span>)}</h2>
              {s.subtitle && <p className="v2-promo-sub">{s.subtitle}</p>}
              {s.ctaHref && (
                <a className="v2-btn v2-btn--cta v2-promo-cta" href={s.ctaHref} target="_blank" rel="noopener noreferrer" tabIndex={k === active ? 0 : -1}>{s.ctaText || 'Подробнее'}</a>
              )}
            </div>
          ))}
          {/* стрелки есть в макете всегда; при одном слайде они просто ничего не листают */}
          <button className="v2-promo-arrow v2-promo-arrow--prev" aria-label="Предыдущая акция" onClick={() => goTo(index - 1)}><PromoArrow /></button>
          <button className="v2-promo-arrow v2-promo-arrow--next" aria-label="Следующая акция" onClick={() => goTo(index + 1)}><PromoArrow /></button>
          {/* 30.09: точки — один SVG, а не кнопки: на Windows/Chrome кнопки-точки
              рисовались дважды (задвоение при масштабировании). Морфинг — переход
              x/width у rect. */}
          <svg className="v2-promo-dots" width={count * 15 + (count - 1) * 12 + 31} height="15" viewBox={`0 0 ${count * 15 + (count - 1) * 12 + 31} 15`} role="tablist" aria-label="Акции">
            {slides.map((s: any, k: number) => {
              const x = k * 27 + (k > active ? 31 : 0);
              const w = k === active ? 46 : 15;
              return (
                <rect
                  key={s.id || k}
                  className={`v2-promo-dot${k === active ? ' v2-promo-dot--active' : ''}`}
                  x={x} y={0} width={w} height={15} rx={7.5}
                  role="tab" aria-selected={k === active} aria-label={`Акция ${k + 1}`} tabIndex={0}
                  onClick={() => goTo(k)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTo(k); } }}
                />
              );
            })}
          </svg>
        </div>
        {/* 01.10 (мобильная версия): золотая кнопка на всю ширину сразу под слайдером; на десктопе скрыта */}
        <div className="v2-promo-mcta">
          <button type="button" className="v2-btn v2-btn--gold" onClick={onTour}>Записаться на брокер-тур</button>
        </div>
      </div>
    </section>
  );
}

// ─── страница ───────────────────────────────────────────────────────────────

export default function LandingV2({ data }: { data: LandingV2Data }) {
  const [modal, setModal] = useState<null | 'callback' | 'tour' | 'conditions' | 'month'>(null);
  // предзаполненный комментарий формы записи на тур (из календаря: дата и время слота)
  const [tourPreset, setTourPreset] = useState('');
  const openTour = (preset?: string) => { setTourPreset(preset || ''); setModal('tour'); };
  const [menu, setMenu] = useState(false);
  const isMobile = useIsMobile();
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest('.v2-menu, .v2-burger')) return;
      setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // 01.10 (мобильная версия): пока открыта полноэкранная панель меню, страница под ней не прокручивается
    const prevOverflow = document.body.style.overflow;
    if (isMobile) document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; };
  }, [menu, isMobile]);
  const [zoom, setZoom] = useState(1);
  // 30.09 (владелец, по демо): анимации появления блоков. Включаются только
  // после гидрации и только без prefers-reduced-motion — без JS страница
  // отрисована полностью (скрытые состояния живут под .v2--motion).
  const [motion, setMotion] = useState(false);

  useEffect(() => {
    // 01.10 (владелец): ≤768 — своя раскладка без масштабирования (zoom 1); 768–1440 — как раньше
    const apply = () => { const w = window.innerWidth; setZoom(w > 768 && w < 1440 ? Math.max(0.5, w / 1440) : 1); };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setMotion(true);
  }, []);

  useEffect(() => {
    if (!motion) return;
    const root = document.querySelector('.v2');
    if (!root) return;
    const header = root.querySelector('.v2-header');
    const raf = requestAnimationFrame(() => header?.classList.add('is-in'));
    const animateCounters = (scope: Element) => {
      scope.querySelectorAll<HTMLElement>('.v2-mcard-meta').forEach((el) => {
        if (el.dataset.counted) return;
        el.dataset.counted = '1';
        const text = el.textContent || '';
        const parts = text.split(/(\d+)/);
        const t0 = performance.now();
        const tick = (t: number) => {
          const k = Math.min(1, (t - t0) / 1000);
          const e = 1 - Math.pow(1 - k, 3);
          el.textContent = parts.map((x) => (/^\d+$/.test(x) ? String(Math.round(Number(x) * e)) : x)).join('');
          if (k < 1) requestAnimationFrame(tick);
          else el.textContent = text;
        };
        requestAnimationFrame(tick);
      });
    };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
        if ((e.target as HTMLElement).classList.contains('v2-materials')) animateCounters(e.target);
      }
    }, { threshold: 0.15 });
    root.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el));
    // параллакс фото в блоке заявки
    const cta = root.querySelector<HTMLElement>('.v2-cta-left');
    const onScroll = () => {
      if (!cta) return;
      const r = cta.getBoundingClientRect();
      const c = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
      cta.style.backgroundPositionY = `${50 - c * 8}%`;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { cancelAnimationFrame(raf); io.disconnect(); window.removeEventListener('scroll', onScroll); };
  }, [motion]);

  const contact = data.content?.contact || {};
  const phone: string = contact.phone || '+7 (499) 226-22-49';
  const phoneHref = 'tel:' + String(phone).replace(/[^\d+]/g, '');
  const email: string = contact.email || 'broker@stmichael.ru';
  const telegram: string = contact.telegram || 'https://t.me/stmichaelBroker';
  const telegramLabel = telegram.replace(/^https?:\/\//, '');
  const manager = contact.manager || contact.managers?.[0] || { name: 'Дарья Великанова', role: 'Менеджер по работе с брокерами', phone: '+7 (930) 012-94-52' };
  const hours: string = contact.phoneHours || 'Ежедневно с 9:00 до 21:00';
  // Заголовок горячей линии в макете — две строки; если в CMS стандартный текст, переносим как в макете.
  const hotTitleRaw = String(contact.blockTitle || '').trim().replace(/\s+/g, ' ');
  const hotTitle = !hotTitleRaw || hotTitleRaw === 'Горячая линия по работе с партнёрами' ? 'Горячая линия\nпо работе с партнёрами' : hotTitleRaw;

  const projects = useMemo(() => {
    const list = (data.projects || []).filter((p) => p.isActive !== false && PROJECT_FALLBACK[p.slug]);
    const order = ['zorge9', 'silver-bor'];
    return list.sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
  }, [data.projects]);

  // 01.10 (владелец): листание недель стрелками — вперёд до WEEKS_AHEAD, назад
  // только до текущей недели; «Неделя» возвращает к текущей. После первого
  // листания карточки дней рисуются без data-reveal (наблюдатель появления
  // к новым узлам не привязан) — смена недели идёт с лёгким затуханием.
  const [weekOffset, setWeekOffset] = useState(0);
  const [weekDir, setWeekDir] = useState(0); // -1 назад, 1 вперёд, 0 — без анимации
  const week = useMemo(() => workWeek(weekOffset), [weekOffset]);
  const goWeek = (next: number) => {
    const clamped = Math.max(0, Math.min(WEEKS_AHEAD, next));
    if (clamped === weekOffset) return;
    setWeekDir(clamped > weekOffset ? 1 : -1);
    setWeekOffset(clamped);
  };
  const todayKey = dayKey(new Date());
  const activeEvents = useMemo(() => (data.events || []).filter((e) => e.isActive !== false), [data.events]);
  // 01.10 (мобильная версия): дни недели — лента со свайпом, один день на экран;
  // на текущей неделе лента открывается на сегодняшнем дне.
  const daysRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isMobile || weekOffset !== 0) return;
    const lane = daysRef.current;
    const today = lane?.querySelector<HTMLElement>('.v2-day--today');
    if (lane && today) lane.scrollLeft = today.offsetLeft - 16;
  }, [isMobile, weekOffset]);
  const promos = useMemo(
    () => (data.promos || []).filter((p) => p.isActive !== false && (!p.expiresAt || new Date(p.expiresAt) > new Date())),
    [data.promos],
  );
  // Новости: карточки 322×360 как в макете, карусель по 4 (30.09), API отдаёт до 20; без новостей блок скрыт.
  const news = useMemo(() => (data.news || []).filter((n) => n.isActive !== false).slice(0, 20), [data.news]);

  // 01.10 (владелец): без цифр — просто перечень видов материалов
  const matCount = (_key: string) => 'Фото · Видео · Презентации';
  const condCount = data.cooperationDocs.length; void condCount;

  return (
    <div className={`v2${motion ? ' v2--motion' : ''}`} style={{ zoom } as React.CSSProperties}>
      {/* ── шапка ── */}
      <header className="v2-header">
        <div className="v2-container">
          <a className="v2-brand" href="#top" aria-label="St Michael">
            <img src="/v2/svg/logo.svg" alt="St Michael" />
            <span>Кабинет брокера</span>
          </a>
          <div className="v2-header-right">
            {/* Макет 28.09 (7004): справа только «Регистрация» (контур 145×38),
                золотая «Войти в кабинет брокера» (238×38) и бургер. Телефон и
                «Записаться на брокер-тур» из шапки ушли — запись на тур в меню. */}
            <Link className="v2-btn v2-btn--outline v2-header-reg" href="/register">Регистрация</Link>
            <Link className="v2-btn v2-btn--gold v2-header-login" href="/login">Войти в кабинет брокера</Link>
            <button className="v2-burger" aria-label="Меню" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><img src="/v2/svg/burger.svg" alt="" width={40} height={16} /></button>
          </div>
          {menu && (
            /* 30.09 (владелец): пункты как в старом лендинге; закрывается кликом вне меню.
               01.10 (мобильная версия): на ≤768 это полноэкранная белая панель сверху вниз —
               крестик и кнопки «Регистрация»/«Войти» внизу видны только там (на десктопе скрыты CSS). */
            <nav className="v2-menu" onClick={() => setMenu(false)}>
              <button type="button" className="v2-menu-close" aria-label="Закрыть меню">×</button>
              <a href="#projects">Проекты</a>
              <a href="#events">Мероприятия</a>
              {/* 01.10: запись на тур из меню (в шапке кнопки нет с макета 28.09) */}
              <button onClick={() => openTour()}>Записаться на брокер-тур</button>
              <button onClick={() => setModal('conditions')}>Документы</button>
              <a href="#materials">Материалы</a>
              <a href="#contacts">Контакты</a>
              <div className="v2-menu-actions">
                <Link className="v2-btn v2-btn--outline" href="/register">Регистрация</Link>
                <Link className="v2-btn v2-btn--gold" href="/login">Войти в кабинет брокера</Link>
              </div>
            </nav>
          )}
        </div>
      </header>

      <main id="top">
        {/* ── акции ── */}
        <PromoCarousel promos={promos} onTour={() => openTour()} />

        {/* ── наши проекты ── */}
        <section className="v2-section" id="projects">
          <div className="v2-container">
            <div className="v2-title-row" data-reveal>
              <div>
                <h2 className="v2-title">Наши проекты</h2>
                <p className="v2-subtitle">Три эксклюзивных адреса Москвы</p>
              </div>
              <button className="v2-btn v2-btn--dark v2-btn--w238" onClick={() => setModal('conditions')}>Условия вознаграждения</button>
            </div>
            {/* Макет 28.09 (7004): три карточки 437×807 — Зорге 9, КСБ из CMS
                и статическая «Маршала Толбухина 3». Первый тег всегда тёмный. */}
            <div className="v2-projects">
              {projects.map((p, pi) => {
                const fb = PROJECT_FALLBACK[p.slug];
                const ready = p.readyYear ? `${ROMAN[Number(p.readyQuarter) || 0] ? ROMAN[Number(p.readyQuarter)] + ' кв. ' : ''}${p.readyYear}` : fb.ready;
                const cls = p.classType ? String(p.classType).replace(/^./, (c: string) => c.toUpperCase()) : fb.classType;
                const floors = p.floorsTotal ? `${p.floorsTotal} эт.` : fb.floors;
                const address = String(p.address || fb.address).replace(/^Москва,\s*/i, '');
                const tags = [ready, cls, floors].filter(Boolean) as string[];
                return (
                  <article className="v2-pcard" key={p.slug} data-reveal="scale" style={{ '--i': pi } as React.CSSProperties}>
                    <img className="v2-pcard-photo" src={PROJECT_PHOTOS[p.slug]} alt={fb.name} />
                    <div className="v2-pcard-body">
                      <div className="v2-tags">
                        {tags.map((t, i) => <span key={t} className={`v2-tag${i === 0 ? ' v2-tag--dark' : ''}`}>{t}</span>)}
                      </div>
                      <div className="v2-pcard-name"><b>{fb.name}</b><span>{address}</span></div>
                      <p className="v2-pcard-desc">{p.description || fb.description}</p>
                      <a className="v2-pcard-more" href={PROJECT_PAGES[p.slug]} target="_blank" rel="noopener noreferrer">Подробнее →</a>
                    </div>
                    <a className="v2-btn v2-btn--dark" href={p.ctaHref || PROJECT_PAGES[p.slug]} target="_blank" rel="noopener noreferrer">{fb.cta}</a>
                  </article>
                );
              })}
              <article className="v2-pcard v2-pcard--soon" data-reveal="scale" style={{ '--i': projects.length } as React.CSSProperties}>
                <img className="v2-pcard-photo" src={TOLBUKHINA.photo} alt={TOLBUKHINA.name} />
                <div className="v2-pcard-body">
                  <div className="v2-tags">
                    {TOLBUKHINA.tags.map((t, i) => <span key={t} className={`v2-tag${i === 0 ? ' v2-tag--dark' : ''}`}>{t}</span>)}
                  </div>
                  <div className="v2-pcard-name"><b>{TOLBUKHINA.name}</b><span>{TOLBUKHINA.address}</span></div>
                  <p className="v2-pcard-desc">{TOLBUKHINA.description}</p>
                  {/* 01.10 (владелец): «Подробнее» убрано — страницы проекта пока нет */}
                </div>
                <span className="v2-btn v2-btn--soon" aria-disabled="true">Скоро старт продаж</span>
              </article>
            </div>
          </div>
        </section>

        {/* ── как начать ── */}
        <section className="v2-section" id="how">
          <div className="v2-container">
            <div className="v2-title-row" data-reveal>
              <div>
                <h2 className="v2-title">Как начать сотрудничать с St Michael</h2>
                <p className="v2-subtitle">Начать можно с первой же сделки — даже если ваше ИП открыто вчера</p>
              </div>
              <button className="v2-btn v2-btn--dark" onClick={() => setModal('callback')}>Стать партнёром</button>
            </div>
            <div className="v2-steps" data-reveal="steps">
              {STEPS.map((s, i) => (
                <div key={i} className="v2-step" style={{ '--i': i } as React.CSSProperties}>
                  <div className="v2-step-num"><i>0{i + 1}</i></div>
                  <div className="v2-step-line"><b /></div>
                  <div className="v2-step-body">
                    <div className="v2-step-title">{s.title}</div>
                    <div className="v2-step-text">{s.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── материалы ── */}
        <section className="v2-section" id="materials">
          <div className="v2-container">
            <div className="v2-title-row" data-reveal>
              <div>
                <h2 className="v2-title">Материалы для продвижения</h2>
                <p className="v2-subtitle">Фото и видео — внутри ЖК Зорге 9 и Квартала Серебряный Бор</p>
              </div>
            </div>
            {/* 01.10 (владелец): hover карточки как у новостей. Анимация появления
                (data-reveal) живёт на обёртке — раньше её `transform: none` после
                появления перебивал подъём карточки при наведении. */}
            <div className="v2-materials" data-reveal="group">
              <div className="v2-mcard-wrap" data-reveal="left" style={{ '--i': 0 } as React.CSSProperties}>
                <Link className="v2-mcard v2-hcard" href="/materials/Фотографии">
                  <img className="v2-mcard-photo" src="/v2/img/materials-zorge9.webp" alt="Зорге 9" />
                  <div className="v2-mcard-name">Зорге 9</div>
                  <div className="v2-mcard-meta">{matCount('zorge9')}</div>
                  <img className="v2-mcard-arrow" src="/v2/svg/arrow-card.svg" alt="" />
                </Link>
              </div>
              <div className="v2-mcard-wrap" data-reveal="left" style={{ '--i': 1 } as React.CSSProperties}>
                <Link className="v2-mcard v2-hcard" href="/materials/Рендеры">
                  <img className="v2-mcard-photo" src="/v2/img/materials-silver-bor.webp" alt="Квартал Серебряный Бор" />
                  <div className="v2-mcard-name">Квартал Серебряный Бор</div>
                  <div className="v2-mcard-meta">{matCount('silver-bor')}</div>
                  <img className="v2-mcard-arrow" src="/v2/svg/arrow-card.svg" alt="" />
                </Link>
              </div>
              <div className="v2-mcard-wrap" data-reveal="left" style={{ '--i': 2 } as React.CSSProperties}>
                <a className="v2-mcard v2-hcard" href="#conditions" onClick={(e) => { e.preventDefault(); setModal('conditions'); }}>
                  <img className="v2-mcard-photo" src="/v2/img/materials-conditions.webp" alt="Актуальные условия" />
                  <div className="v2-mcard-name">Актуальные условия</div>
                  <div className="v2-mcard-meta">Условия сотрудничества · Калькулятор рассрочки</div>
                  <img className="v2-mcard-arrow" src="/v2/svg/arrow-card.svg" alt="" />
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ── мероприятия ── */}
        <section className="v2-section" id="events">
          <div className="v2-container">
            <div className="v2-title-row" data-reveal>
              <div>
                <h2 className="v2-title">Ближайшие мероприятия</h2>
                <p className="v2-subtitle">Расписание брокер-туров</p>
              </div>
              {/* 01.10 (мобильная версия): маленькие «‹ ›» листания недель в строке заголовка; на десктопе скрыты */}
              <div className="v2-week-nav">
                <button type="button" className="v2-week-arrow v2-week-arrow--prev" aria-label="Предыдущая неделя" disabled={weekOffset <= 0} onClick={() => goWeek(weekOffset - 1)}><CalArrow /></button>
                <button type="button" className="v2-week-arrow" aria-label="Следующая неделя" disabled={weekOffset >= WEEKS_AHEAD} onClick={() => goWeek(weekOffset + 1)}><CalArrow /></button>
              </div>
              <div className="v2-filter">
                <button className="v2-btn v2-btn--gold" onClick={() => openTour()}>Записаться на брокер-тур</button>
                <button className="v2-btn v2-btn--dark" onClick={() => goWeek(0)}>Неделя</button>
                <button className="v2-btn v2-btn--ghost" onClick={() => setModal('month')}>Месяц</button>
              </div>
            </div>
            <div className="v2-days-wrap">
              <div ref={daysRef} className={`v2-days${weekDir ? ' v2-days--anim' : ''}`} key={weekOffset} style={{ '--dir': weekDir } as React.CSSProperties}>
                {week.map((day, di) => {
                  const slots = slotsForDay(day, activeEvents);
                  const isToday = dayKey(day) === todayKey;
                  return (
                    <div key={dayKey(day)} className={`v2-day${isToday ? ' v2-day--today' : ''}`} data-reveal={weekDir ? undefined : 'scale'} style={{ '--i': di } as React.CSSProperties}>
                      <div className="v2-day-date">{fmtDay(day)}</div>
                      {slots.length === 0 && <div className="v2-day-empty">Туров нет</div>}
                      {slots.slice(0, 2).map((s) => (
                        <div className="v2-slot" key={s.time}>
                          <div className="v2-slot-time">{s.time}</div>
                          <div className="v2-slot-list">{s.projects.map((p) => <div key={p}>{p}</div>)}</div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
              {weekOffset > 0 && (
                <button type="button" className="v2-days-arrow v2-days-arrow--prev" aria-label="Предыдущая неделя" onClick={() => goWeek(weekOffset - 1)}><CalArrow /></button>
              )}
              {weekOffset < WEEKS_AHEAD && (
                <button type="button" className="v2-days-arrow v2-days-arrow--next" aria-label="Следующая неделя" onClick={() => goWeek(weekOffset + 1)}><CalArrow /></button>
              )}
            </div>
            {/* 29.09 (владелец): подпись под расписанием вместо подзаголовка слайда */}
            <p className="v2-events-note">Индивидуальный брокер-тур — по договорённости с менеджером</p>
          </div>
        </section>

        {/* 29.09 (владелец): блок «Шесть причин» убран. */}

        {/* ── новости (макет 28.09, 7004: 4 карточки 322×360; без новостей блок скрыт) ── */}
        {news.length > 0 && (
          <section className="v2-section" id="news">
            <div className="v2-container">
              <div className="v2-title-row" data-reveal>
                <div>
                  <h2 className="v2-title">Новости</h2>
                </div>
              </div>
              <NewsCarousel items={news} />
            </div>
          </section>
        )}

        {/* ── заявка + контакты ── */}
        <section id="contacts">
          <div className="v2-container">
            <div className="v2-cta">
              <div className="v2-cta-left" data-reveal style={{ '--i': 0 } as React.CSSProperties}>
                <h2>Оставьте заявку перезвоним за 1 час</h2>
                <button className="v2-btn v2-btn--cta" onClick={() => setModal('callback')}>Стать партнёром</button>
              </div>
              <div className="v2-cta-right" data-reveal style={{ '--i': 1 } as React.CSSProperties}>
                <h2>Всегда<br />на связи</h2>
                {/* 30.09 (макет Рината): иконки почты и Telegram в правом верхнем углу
                    вместо текстовых ссылок внизу; менеджер посередине, горячая линия внизу */}
                <div className="v2-contact-icons">
                  <a href={'mailto:' + email} aria-label="Написать на почту" title={email}><img src="/v2/svg/icon-mail.svg" alt="" /></a>
                  <a href={telegram} target="_blank" rel="noopener noreferrer" aria-label="Telegram" title={telegramLabel}><img src="/v2/svg/icon-telegram.svg" alt="" /></a>
                </div>
                <div className="v2-contact-block v2-contact-block--person">
                  <img className="v2-contact-photo" src="/v2/img/manager-daria.webp" alt="" />
                  <div>
                    <div className="v2-contact-main">{manager.name}<br /><a href={'tel:' + String(manager.phone || '').replace(/[^\d+]/g, '')}>{String(manager.phone || '').replace(/[()]/g, '')}</a></div>
                    <div className="v2-contact-sub">{manager.role}</div>
                  </div>
                </div>
                {/* 01.10 (владелец, по макету Рината): менеджер ниже, под ним разделитель, горячая линия у низа */}
                <div className="v2-divider v2-divider--contacts" aria-hidden="true" />
                <div className="v2-contact-block v2-contact-block--hot">
                  <div className="v2-contact-main v2-contact-main--hot">{hotTitle}<br /><a href={phoneHref}>{phone.replace(/[()]/g, '')}</a></div>
                  <div className="v2-contact-sub">{hours}</div>
                </div>
              </div>
            </div>

            {/* ── подвал ── */}
            <footer className="v2-footer">
              <div className="v2-footer-brand">
                <img src="/v2/svg/logo.svg" alt="St Michael" />
                <span>Кабинет брокера</span>
              </div>
              {/* 30.09 (правка владельца): три колонки меню вернулись; ряд кнопок снова внизу по центру. */}
              <div className="v2-footer-col v2-footer-col--1">
                <div>Условия</div>
                <button type="button" onClick={() => setModal('conditions')}>Условия сотрудничества</button>
                <a href="#events">Календарь событий</a>
                <button type="button" onClick={() => setModal('conditions')}>Комиссия</button>
              </div>
              <div className="v2-footer-col v2-footer-col--2">
                <div>Проекты</div>
                <a href={PROJECT_PAGES.zorge9} target="_blank" rel="noopener noreferrer">Зорге 9</a>
                <a href={PROJECT_PAGES['silver-bor']} target="_blank" rel="noopener noreferrer">Квартал Серебряный Бор</a>
                {/* страницы Толбухиной на stmichael.ru пока нет — без ссылки */}
                <span>Толбухина 3</span>
              </div>
              <div className="v2-footer-col v2-footer-col--3">
                <div>Партнёрам</div>
                <a href={phoneHref}>{phone.replace(/[()]/g, '')}</a>
                <a href={'mailto:' + email}>{email}</a>
                <a href={telegram} target="_blank" rel="noopener noreferrer">{telegramLabel}</a>
              </div>
              <div className="v2-footer-btns">
                <button className="v2-btn v2-btn--light" onClick={() => openTour()}>Записаться на брокер-тур</button>
                <Link className="v2-btn v2-btn--outline-white" href="/login">Войти в кабинет</Link>
                <a className="v2-btn v2-btn--outline-white" href={telegram} target="_blank" rel="noopener noreferrer">Telegram-канал</a>
              </div>
              <img className="v2-footer-watermark" src="/v2/svg/logo-big.svg" alt="" />
            </footer>
          </div>
        </section>
      </main>

      {modal === 'callback' && (
        <LeadForm source="landing-callback" title="Стать партнёром" subtitle="Оставьте номер — перезвоним в течение часа" buttonText="Жду звонка" onClose={() => setModal(null)} />
      )}
      {modal === 'tour' && (
        <LeadForm source="broker-tour" title="Записаться на брокер-тур" subtitle="Менеджер подтвердит дату и время" buttonText="Записаться" withMessage initialMessage={tourPreset} onClose={() => { setTourPreset(''); setModal(null); }} />
      )}
      {modal === 'conditions' && <ConditionsModal docs={data.cooperationDocs} onClose={() => setModal(null)} />}
      {modal === 'month' && <MonthModal events={activeEvents} onClose={() => setModal(null)} onBook={openTour} />}
    </div>
  );
}
