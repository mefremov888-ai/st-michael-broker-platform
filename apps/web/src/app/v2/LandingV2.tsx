'use client';

// 2026-09-28: новый лендинг кабинета брокера по макету Figma «Кабинет брокера»
// (Ринат Габитов), фрейм 1920×6228. Вёрстка один в один под 1920; ниже 1440
// страница масштабируется целиком. Мобильная версия — после финальных правок
// (решение владельца 28.09). Данные — те же публичные API, что у старого
// лендинга; «Стать партнёром» = заявка «перезвоним за 1 час», которая уходит
// в amoCRM задачей в воронку КЦ (source landing-callback).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

export interface LandingV2Data {
  content: any;
  projects: any[];
  events: any[];
  promos: any[];
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
const PROJECT_FALLBACK: Record<string, { name: string; address: string; floors?: string; ready?: string; classType?: string }> = {
  zorge9: { name: 'ЖК «Зорге 9»', address: 'ул. Зорге, 9А, корп. 1', floors: '23 эт.', classType: 'Бизнес-класс', ready: 'Дом готов' },
  'silver-bor': { name: 'Квартал Серебряный Бор', address: 'ул. Берзарина, 37', floors: '16-25 эт.', classType: 'Премиум-класс', ready: 'II кв. 2027' },
};

const STEPS = [
  { title: 'Проверка на уникальность', text: 'Проверьте клиента в кабинете перед сделкой' },
  { title: 'Встреча в офисе продаж', text: 'Запишите клиента на встречу в офис продаж' },
  { title: 'Фиксация клиента', text: 'После встречи клиент закреплён за вами на 30 дней' },
  { title: 'Сделка и выплата', text: 'После оплаты клиентом, вознаграждение приходит за 7 рабочих дней' },
];

const REASONS = [
  { title: 'Выделенный отдел по работе с партнёрами', sub: 'Сопровождение на всех этапах сделки' },
  { title: 'Не уводим ваших клиентов', sub: 'С клиентами, которые пришли через вас, мы не работаем напрямую' },
  { title: 'Быстрые выплаты', sub: 'Вознаграждение — до 7 рабочих дней' },
  { title: 'Высокая комиссия', sub: 'Выплаты до 6%' },
  { title: 'Не цепляемся за формальности', sub: 'Гибкий регламент работы. Подтверждаем работу с клиентом, даже когда другие отказали бы' },
  { title: 'Выделенный отдел по работе с партнёрами', sub: 'Сопровождение на всех этапах сделки' },
];

const ROMAN = ['', 'I', 'II', 'III', 'IV'];
const DOW_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DEFAULT_PROMO = { id: 'default', title: 'Комиссия за сделку до 6%', imageUrl: '/v2/img/promo-commission.webp' };

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

function normalizePhone(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (!d) return '';
  if (d.length === 10) return '+7' + d;
  return (d.startsWith('7') || d.startsWith('8')) ? '+7' + d.slice(1) : '+' + d;
}

// ─── модалки ────────────────────────────────────────────────────────────────

function Modal({ onClose, wide, children }: { onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="v2-overlay" onClick={onClose}>
      <div className={`v2-modal${wide ? ' v2-modal--wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <button className="v2-modal-close" aria-label="Закрыть" onClick={onClose}>×</button>
        {children}
      </div>
    </div>
  );
}

function LeadForm({ source, title, subtitle, buttonText, withMessage, onClose }: { source: 'landing-callback' | 'broker-tour'; title: string; subtitle: string; buttonText: string; withMessage?: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async () => {
    setError('');
    if (name.trim().length < 2) return setError('Введите имя');
    const p = normalizePhone(phone);
    if (!/^\+7\d{10}$/.test(p)) return setError('Введите телефон — 10 цифр после +7');
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
          <input className="v2-input" type="tel" placeholder="Телефон, +7…" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
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

function MonthModal({ events, onClose }: { events: any[]; onClose: () => void }) {
  const weeks = [0, 1, 2, 3].map((w) => workWeek(w));
  const todayKey = dayKey(new Date());
  return (
    <Modal onClose={onClose} wide>
      <h3>Расписание брокер-туров на месяц</h3>
      <p className="v2-modal-sub">Запись — по кнопке «Записаться на брокер-тур» или по телефону</p>
      {weeks.map((week, wi) => (
        <div className="v2-month" key={wi}>
          {week.map((day) => {
            const slots = slotsForDay(day, events);
            const isToday = dayKey(day) === todayKey;
            return (
              <div key={dayKey(day)} className={`v2-month-day${slots.length ? ' v2-month-day--has' : ''}${isToday ? ' v2-month-day--today' : ''}`}>
                <div className="v2-month-date">{fmtDay(day)}</div>
                {slots.map((s) => (
                  <div className="v2-month-slot" key={s.time}><b>{s.time}</b> · {s.projects.join(' · ')}</div>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </Modal>
  );
}

// 2026-09-28 (обновление макета): карусель «Акции» — фото на всю ширину
// контейнера 1360×600, заголовок белым, стрелки по бокам, точки слева внизу.
// Данные — CMS-акции; если их нет — один слайд из макета.
function PromoCarousel({ promos }: { promos: any[] }) {
  const slides = promos.length ? promos : [DEFAULT_PROMO];
  const [index, setIndex] = useState(0);
  const count = slides.length;
  useEffect(() => {
    if (count < 2) return;
    const timer = setInterval(() => setIndex((v) => (v + 1) % count), 6000);
    return () => clearInterval(timer);
  }, [count]);
  const slide = slides[index % count] || slides[0];
  const image = slide.imageUrl || DEFAULT_PROMO.imageUrl;
  return (
    <section className="v2-section" id="promos">
      <div className="v2-container">
        <div className="v2-promo" style={{ backgroundImage: `url(${image})` }}>
          <h2 className="v2-promo-title">{slide.title}</h2>
          {slide.subtitle && <p className="v2-promo-sub">{slide.subtitle}</p>}
          {slide.ctaHref && (
            <a className="v2-btn v2-btn--cta v2-promo-cta" href={slide.ctaHref} target="_blank" rel="noopener noreferrer">{slide.ctaText || 'Подробнее'}</a>
          )}
          {count > 1 && (
            <>
              <button className="v2-promo-arrow v2-promo-arrow--prev" aria-label="Предыдущая акция" onClick={() => setIndex((index - 1 + count) % count)} />
              <button className="v2-promo-arrow v2-promo-arrow--next" aria-label="Следующая акция" onClick={() => setIndex((index + 1) % count)} />
            </>
          )}
          <div className="v2-promo-dots">
            {slides.map((s: any, k: number) => (
              <button key={s.id || k} className={`v2-promo-dot${k === index % count ? ' v2-promo-dot--active' : ''}`} aria-label={`Акция ${k + 1}`} onClick={() => setIndex(k)} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── страница ───────────────────────────────────────────────────────────────

export default function LandingV2({ data }: { data: LandingV2Data }) {
  const [modal, setModal] = useState<null | 'callback' | 'tour' | 'conditions' | 'month'>(null);
  const [menu, setMenu] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const apply = () => setZoom(window.innerWidth < 1440 ? Math.max(0.5, window.innerWidth / 1440) : 1);
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  const contact = data.content?.contact || {};
  const phone: string = contact.phone || '+7 (499) 226-22-49';
  const phoneHref = 'tel:' + String(phone).replace(/[^\d+]/g, '');
  const email: string = contact.email || 'broker@stmichael.ru';
  const telegram: string = contact.telegram || 'https://t.me/stmichaelBroker';
  const telegramLabel = telegram.replace(/^https?:\/\//, '');
  const manager = contact.manager || contact.managers?.[0] || { name: 'Дарья Великанова', role: 'Менеджер по работе с брокерами', phone: '+7 (930) 012-94-52' };
  const hours: string = contact.phoneHours || 'Ежедневно с 9:00 до 21:00';

  const projects = useMemo(() => {
    const list = (data.projects || []).filter((p) => p.isActive !== false && PROJECT_FALLBACK[p.slug]);
    const order = ['zorge9', 'silver-bor'];
    return list.sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
  }, [data.projects]);

  const week = useMemo(() => workWeek(0), []);
  const todayKey = dayKey(new Date());
  const activeEvents = useMemo(() => (data.events || []).filter((e) => e.isActive !== false), [data.events]);
  const promos = useMemo(
    () => (data.promos || []).filter((p) => p.isActive !== false && (!p.expiresAt || new Date(p.expiresAt) > new Date())),
    [data.promos],
  );

  const matCount = (key: string) => {
    const g = data.materials?.[key];
    if (!g || !g.total) return 'Фото, видео и документы';
    const parts: string[] = [];
    if (g.photo) parts.push(`${g.photo} фото`);
    if (g.video) parts.push(`${g.video} видео`);
    if (g.doc) parts.push(`${g.doc} док.`);
    return parts.join(' · ');
  };
  const condCount = data.cooperationDocs.length;

  return (
    <div className="v2" style={{ zoom } as React.CSSProperties}>
      {/* ── шапка ── */}
      <header className="v2-header">
        <div className="v2-container">
          <a className="v2-brand" href="#top" aria-label="St Michael">
            <img src="/v2/svg/logo.svg" alt="St Michael" />
            <span>Кабинет брокера</span>
          </a>
          <div className="v2-header-right">
            <a className="v2-header-phone" href={phoneHref}>{phone}</a>
            <button className="v2-btn v2-btn--outline" onClick={() => setModal('tour')}>Записаться на брокер-тур</button>
            {/* 28.09 (владелец): две кнопки — «Войти» и «Зарегистрироваться» */}
            <Link className="v2-btn v2-btn--outline" href="/login">Войти</Link>
            <Link className="v2-btn v2-btn--gold" href="/register">Зарегистрироваться</Link>
            <button className="v2-burger" aria-label="Меню" onClick={() => setMenu((v) => !v)}><i /><i /><i /></button>
          </div>
          {menu && (
            <nav className="v2-menu" onClick={() => setMenu(false)}>
              <a href="#projects">Наши проекты</a>
              <a href="#how">Как начать</a>
              <a href="#materials">Материалы</a>
              <a href="#events">Брокер-туры</a>
              <a href="#reasons">Почему St Michael</a>
              <a href="#contacts">Контакты</a>
              <button onClick={() => setModal('conditions')}>Условия вознаграждения</button>
              <Link href="/register">Регистрация</Link>
            </nav>
          )}
        </div>
      </header>

      <main id="top">
        {/* ── акции ── */}
        <PromoCarousel promos={promos} />

        {/* ── наши проекты ── */}
        <section className="v2-section" id="projects">
          <div className="v2-container">
            <div className="v2-title-row">
              <div>
                <h2 className="v2-title">Наши проекты</h2>
                <p className="v2-subtitle">Два эксклюзивных адреса Москвы</p>
              </div>
              <button className="v2-btn v2-btn--dark" onClick={() => setModal('conditions')}>Условия вознаграждения</button>
            </div>
            <div className={`v2-projects${projects.length >= 3 ? ' v2-projects--3' : ''}`}>
              {projects.map((p) => {
                const fb = PROJECT_FALLBACK[p.slug];
                const ready = p.readyYear ? `${ROMAN[Number(p.readyQuarter) || 0] ? ROMAN[Number(p.readyQuarter)] + ' кв. ' : ''}${p.readyYear}` : fb.ready;
                const cls = p.classType ? String(p.classType).replace(/^./, (c: string) => c.toUpperCase()) : fb.classType;
                const floors = p.floorsTotal ? `${p.floorsTotal} эт.` : fb.floors;
                const address = String(p.address || fb.address).replace(/^Москва,\s*/i, '');
                return (
                  <article className="v2-pcard" key={p.slug}>
                    <img className="v2-pcard-photo" src={PROJECT_PHOTOS[p.slug]} alt={fb.name} />
                    <div className="v2-pcard-body">
                      <div className="v2-tags">
                        {ready && <span className={`v2-tag${/готов/i.test(ready) ? ' v2-tag--dark' : ''}`}>{ready}</span>}
                        {cls && <span className="v2-tag">{cls}</span>}
                        {floors && <span className="v2-tag">{floors}</span>}
                      </div>
                      <div className="v2-pcard-name">{fb.name}<span>{address}</span></div>
                      <p className="v2-pcard-desc">{p.description}</p>
                      <a className="v2-pcard-more" href={PROJECT_PAGES[p.slug]} target="_blank" rel="noopener noreferrer">Подробнее →</a>
                    </div>
                    <a className="v2-btn v2-btn--dark" href={p.ctaHref || PROJECT_PAGES[p.slug]} target="_blank" rel="noopener noreferrer">Выбрать апартаменты</a>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── как начать ── */}
        <section className="v2-section" id="how">
          <div className="v2-container">
            <div className="v2-title-row">
              <div>
                <h2 className="v2-title">Как начать сотрудничать с St Michael</h2>
                <p className="v2-subtitle">Начать можно с первой же сделки — даже если ваше ИП открыто вчера</p>
              </div>
              <button className="v2-btn v2-btn--dark" onClick={() => setModal('callback')}>Стать партнёром</button>
            </div>
            <div className="v2-steps">
              {STEPS.map((s, i) => (
                <div key={i}>
                  <div className="v2-step-num">0{i + 1}</div>
                  <div className="v2-step-title">{s.title}</div>
                  <div className="v2-step-text">{s.text}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── материалы ── */}
        <section className="v2-section" id="materials">
          <div className="v2-container">
            <div className="v2-title-row">
              <div>
                <h2 className="v2-title">Материалы для продвижения</h2>
                <p className="v2-subtitle">Фото и видео — внутри ЖК Зорге 9 и Квартала Серебряный Бор</p>
              </div>
            </div>
            <div className="v2-materials">
              <Link className="v2-mcard" href="/materials/Фотографии">
                <img className="v2-mcard-photo" src="/v2/img/materials-zorge9.webp" alt="Зорге 9" />
                <div className="v2-mcard-name">Зорге 9</div>
                <div className="v2-mcard-meta">{matCount('zorge9')}</div>
                <img className="v2-mcard-arrow" src="/v2/svg/arrow-card.svg" alt="" />
              </Link>
              <Link className="v2-mcard" href="/materials/Рендеры">
                <img className="v2-mcard-photo" src="/v2/img/materials-silver-bor.webp" alt="Квартал Серебряный Бор" />
                <div className="v2-mcard-name">Квартал Серебряный Бор</div>
                <div className="v2-mcard-meta">{matCount('silver-bor')}</div>
                <img className="v2-mcard-arrow" src="/v2/svg/arrow-card.svg" alt="" />
              </Link>
              <a className="v2-mcard" href="#conditions" onClick={(e) => { e.preventDefault(); setModal('conditions'); }}>
                <img className="v2-mcard-photo" src="/v2/img/materials-conditions.webp" alt="Актуальные условия" />
                <div className="v2-mcard-name">Актуальные условия</div>
                <div className="v2-mcard-meta">{condCount ? `${condCount} ${plural(condCount, 'файл', 'файла', 'файлов')}` : 'Условия сотрудничества'}</div>
                <img className="v2-mcard-arrow" src="/v2/svg/arrow-card.svg" alt="" />
              </a>
            </div>
          </div>
        </section>

        {/* ── мероприятия ── */}
        <section className="v2-section" id="events">
          <div className="v2-container">
            <div className="v2-title-row">
              <div>
                <h2 className="v2-title">Ближайшие мероприятия</h2>
                <p className="v2-subtitle">Расписание брокер-туров</p>
              </div>
              <div className="v2-filter">
                <span className="v2-btn v2-btn--dark">Неделя</span>
                <button className="v2-btn v2-btn--ghost" onClick={() => setModal('month')}>Месяц</button>
              </div>
            </div>
            <div className="v2-days">
              {week.map((day) => {
                const slots = slotsForDay(day, activeEvents);
                const isToday = dayKey(day) === todayKey;
                return (
                  <div key={dayKey(day)} className={`v2-day${isToday ? ' v2-day--today' : ''}`}>
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
          </div>
        </section>

        {/* ── шесть причин ── */}
        <section className="v2-section" id="reasons">
          <div className="v2-container">
            <div className="v2-title-row">
              <div className="v2-reasons-head">
                <h2 className="v2-title">Шесть причин, ради которых брокеры остаются с St Michael</h2>
                <p className="v2-subtitle">Мы выстроили сотрудничество так, чтобы вы могли начать работать сразу, с первой сделки. Без дополнительных условий.</p>
              </div>
              <button className="v2-btn v2-btn--dark" onClick={() => setModal('callback')}>Стать партнёром</button>
            </div>
            <div className="v2-reasons">
              {REASONS.map((r, i) => (
                <div className="v2-rcard" key={i}>
                  <div className="v2-rcard-num">0{i + 1}</div>
                  <div className="v2-rcard-icon"><img src={`/v2/svg/reason-0${i + 1}.svg`} alt="" /></div>
                  <div className="v2-rcard-text">
                    <div className="v2-rcard-title">{r.title}</div>
                    <div className="v2-rcard-sub">{r.sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 2026-09-28: блок «Новости» из макета убран (обновление Рината). */}

        {/* ── заявка + контакты ── */}
        <section id="contacts">
          <div className="v2-container">
            <div className="v2-cta">
              <div className="v2-cta-left">
                <h2>Оставьте заявку перезвоним за 1 час</h2>
                <button className="v2-btn v2-btn--cta" onClick={() => setModal('callback')}>Стать партнёром</button>
              </div>
              <div className="v2-cta-right">
                <h2>Всегда<br />на связи</h2>
                <div className="v2-contact-block" style={{ top: 294 }}>
                  <div className="v2-contact-main">{contact.blockTitle || 'Горячая линия по работе с партнёрами'}<br /><a href={phoneHref}>{phone}</a></div>
                  <div className="v2-contact-sub">{hours}</div>
                </div>
                <div className="v2-contact-block" style={{ top: 436 }}>
                  <div className="v2-contact-main">{manager.name}<br /><a href={'tel:' + String(manager.phone || '').replace(/[^\d+]/g, '')}>{manager.phone}</a></div>
                  <div className="v2-contact-sub">{manager.role}</div>
                </div>
                <div className="v2-divider" style={{ top: 550 }} />
                <div className="v2-contact-block v2-contact-links" style={{ top: 582 }}>
                  <a href={'mailto:' + email}>{email}</a>
                  <a href={telegram} target="_blank" rel="noopener noreferrer">{telegramLabel}</a>
                </div>
              </div>
            </div>

            {/* ── подвал ── */}
            <footer className="v2-footer">
              <div className="v2-footer-brand">
                <img src="/v2/svg/logo.svg" alt="St Michael" />
                <span>Кабинет брокера</span>
              </div>
              <div className="v2-footer-col v2-footer-col--1">
                <div>Условия</div>
                <button onClick={() => setModal('conditions')}>Условия сотрудничества</button>
                <a href="#events">Календарь событий</a>
                <button onClick={() => setModal('conditions')}>Комиссия</button>
              </div>
              <div className="v2-footer-col v2-footer-col--2">
                <div>Проекты</div>
                <a href="#projects">Зорге 9</a>
                <a href="#projects">Квартал Серебряный Бор</a>
              </div>
              <div className="v2-footer-col v2-footer-col--3">
                <div>Партнёрам</div>
                <a href={phoneHref}>{phone.replace(/[()]/g, '')}</a>
                <a href={'mailto:' + email}>{email}</a>
                <a href={telegram} target="_blank" rel="noopener noreferrer">{telegramLabel}</a>
              </div>
              <div className="v2-footer-btns">
                <button className="v2-btn v2-btn--light" onClick={() => setModal('callback')}>Стать партнёром</button>
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
        <LeadForm source="broker-tour" title="Записаться на брокер-тур" subtitle="Менеджер подтвердит дату и время" buttonText="Записаться" withMessage onClose={() => setModal(null)} />
      )}
      {modal === 'conditions' && <ConditionsModal docs={data.cooperationDocs} onClose={() => setModal(null)} />}
      {modal === 'month' && <MonthModal events={activeEvents} onClose={() => setModal(null)} />}
    </div>
  );
}
