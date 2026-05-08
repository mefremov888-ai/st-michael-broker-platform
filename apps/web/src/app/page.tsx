'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import {
  Headphones, PhoneCall, Wallet, TrendingUp, Users2, GraduationCap,
  FileText, Download as DownloadIcon, ChevronLeft, ChevronRight,
} from 'lucide-react';

// ─── мини-компоненты для оживления лендинга ──────────────────

// Анимирует число от 0 до конечного значения когда элемент попадает в viewport
function CountUp({ value, duration = 1400, suffix = '' }: { value: number; duration?: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(0);
  const fired = useRef(false);
  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || fired.current) return;
      fired.current = true;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        setN(Math.round(value * eased));
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [value, duration]);
  return <span ref={ref}>{n}{suffix}</span>;
}

// Парсит "до 8%", "7 дней", "30 дней", "2" → возвращает кортеж prefix/число/suffix для анимации
function StatNumber({ raw }: { raw: string }) {
  const m = raw.match(/^(до\s*)?(\d+)([\s\-–—]?\d*)?(.*)$/);
  if (!m) return <>{raw}</>;
  const prefix = m[1] || '';
  const num = Number(m[2]);
  const suffix = (m[3] || '') + (m[4] || '');
  return <>{prefix}<CountUp value={num} suffix={suffix} /></>;
}

// Появление элемента через scroll-triggered fade-up (только при первом попадании в viewport)
function Reveal({ children, delay = 0, as: Tag = 'div' }: { children: React.ReactNode; delay?: number; as?: any }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setTimeout(() => setShown(true), delay);
        obs.disconnect();
      }
    }, { threshold: 0.15 });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [delay]);
  return (
    <Tag
      ref={ref}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(24px)',
        transition: 'opacity .7s ease, transform .7s cubic-bezier(.2,.7,.3,1)',
      }}
    >
      {children}
    </Tag>
  );
}

const ADVANTAGE_ICONS: Record<string, any> = {
  'Выделенный отдел партнёров': Headphones,
  'Выделенная линия': PhoneCall,
  'Быстрые выплаты': Wallet,
  'Высокая комиссия': TrendingUp,
  'Партнёрство': Users2,
  'Обучение': GraduationCap,
};

function PhoneInput({ value, onChange, style }: { value: string; onChange: (v: string) => void; style?: React.CSSProperties }) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
    onChange(digits);
  };
  return (
    <div style={{display:'flex',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,overflow:'hidden',...style}}>
      <span style={{padding:'12px 12px 12px 16px',fontSize:14,color:'#8a8680',background:'rgba(0,0,0,0.03)',borderRight:'1px solid rgba(0,0,0,0.08)',userSelect:'none'}}>+7</span>
      <input
        type="tel"
        placeholder="9991234567"
        value={value}
        onChange={handleChange}
        maxLength={10}
        style={{flex:1,padding:'12px 16px',border:'none',fontSize:14,outline:'none',width:'100%'}}
      />
    </div>
  );
}

function AuthModal({ mode, onClose, onSwitch, onSuccess }: { mode: 'login' | 'register'; onClose: () => void; onSwitch: () => void; onSuccess: () => void }) {
  const [phoneDigits, setPhoneDigits] = useState('');
  const [password, setPassword] = useState('');
  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [email, setEmail] = useState('');
  const [agencyName, setAgencyName] = useState('');
  const [inn, setInn] = useState('');
  const [innType, setInnType] = useState<'PERSONAL' | 'AGENCY'>('AGENCY');
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();

  const fullPhone = '+7' + phoneDigits;

  const doLogin = async (phone: string, pw: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password: pw }),
    });
    const data = await res.json();
    if (res.ok) { login(data.accessToken, data.refreshToken); onSuccess(); }
    else throw new Error(data.message || 'Ошибка входа');
  };

  const handleLogin = async () => {
    setLoading(true); setError('');
    try { await doLogin(fullPhone, password); }
    catch (e: any) { setError(e.message || 'Ошибка соединения'); }
    setLoading(false);
  };

  const handleForgot = async () => {
    setLoading(true); setError('');
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setForgotSent(true);
    } catch { setError('Ошибка соединения'); }
    setLoading(false);
  };

  const handleRegister = async () => {
    if (password.length < 8) {
      setError('Пароль должен быть не менее 8 символов');
      return;
    }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: fullPhone,
          lastName, firstName, middleName: middleName || undefined,
          email: email || undefined,
          password,
          inn: inn || undefined,
          innType: inn ? innType : undefined,
          agencyName: agencyName || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) { await doLogin(fullPhone, password); }
      else setError(data.message || 'Ошибка регистрации');
    } catch (e: any) { setError(e.message || 'Ошибка соединения'); }
    setLoading(false);
  };

  return (
    <div className="lp-overlay" style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.5)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={onClose}>
      <div className="lp-popup" style={{background:'#fff',borderRadius:16,maxWidth:420,width:'100%',padding:'36px 32px',position:'relative'}} onClick={e=>e.stopPropagation()}>
        <button onClick={onClose} style={{position:'absolute',top:16,right:16,background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#8a8680'}}>&times;</button>
        <h2 style={{fontSize:24,fontWeight:700,marginBottom:4,color:'#1a1a1a'}}>
          {forgotMode ? 'Восстановление пароля' : mode === 'login' ? 'Вход в кабинет' : 'Регистрация'}
        </h2>
        <p style={{fontSize:13,color:'#8a8680',marginBottom:24}}>
          {forgotMode ? 'Введите email для получения ссылки' : mode === 'login' ? 'Введите данные для входа' : 'Создайте аккаунт партнёра'}
        </p>

        {error && <div style={{padding:'10px 14px',background:'rgba(220,60,60,0.1)',color:'#c33',borderRadius:4,fontSize:13,marginBottom:16}}>{error}</div>}

        {forgotMode ? (
          forgotSent ? (
            <div style={{padding:'14px',background:'rgba(60,140,80,0.1)',color:'#3a8a5c',borderRadius:4,fontSize:13}}>
              Если email зарегистрирован — на него отправлена ссылка для восстановления. Проверьте почту.
            </div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              <input placeholder="Email" type="email" value={email} onChange={e=>setEmail(e.target.value)}
                style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
              <button onClick={handleForgot} disabled={loading || !email}
                style={{padding:'14px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:50,fontSize:13,fontWeight:700,letterSpacing:1,cursor:'pointer',opacity:loading?0.6:1}}>
                {loading ? <><span className="lp-spinner" />Отправка</> : 'ПОЛУЧИТЬ ССЫЛКУ'}
              </button>
            </div>
          )
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            {mode === 'register' && (
              <>
                <input placeholder="Фамилия *" value={lastName} onChange={e=>setLastName(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <input placeholder="Имя *" value={firstName} onChange={e=>setFirstName(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <input placeholder="Отчество (необязательно)" value={middleName} onChange={e=>setMiddleName(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <PhoneInput value={phoneDigits} onChange={setPhoneDigits} />
                <input placeholder="Email" type="email" value={email} onChange={e=>setEmail(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <input placeholder="Название агентства" value={agencyName} onChange={e=>setAgencyName(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <input placeholder="ИНН (10 или 12 цифр)" inputMode="numeric" value={inn}
                  onChange={e=>setInn(e.target.value.replace(/\D/g,'').slice(0,12))}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <div style={{display:'flex',gap:16,fontSize:13,color:'#1a1a1a'}}>
                  <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer'}}>
                    <input type="radio" name="innType" checked={innType==='PERSONAL'} onChange={()=>setInnType('PERSONAL')} />
                    Личный ИНН
                  </label>
                  <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer'}}>
                    <input type="radio" name="innType" checked={innType==='AGENCY'} onChange={()=>setInnType('AGENCY')} />
                    ИНН агентства
                  </label>
                </div>
              </>
            )}
            {mode === 'login' && (
              <PhoneInput value={phoneDigits} onChange={setPhoneDigits} />
            )}
            <input placeholder={mode === 'register' ? 'Пароль (минимум 8 символов)' : 'Пароль'} type="password" value={password} onChange={e=>setPassword(e.target.value)}
              onKeyDown={e=>e.key==='Enter' && (mode==='login' ? handleLogin() : handleRegister())}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <button onClick={mode==='login' ? handleLogin : handleRegister}
              disabled={
                loading ||
                !password ||
                (mode === 'login'
                  ? phoneDigits.length !== 10
                  : (!firstName || !lastName || !email || phoneDigits.length !== 10 || (inn.length !== 10 && inn.length !== 12) || password.length < 8))
              }
              style={{padding:'14px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:50,fontSize:13,fontWeight:700,letterSpacing:1,cursor:'pointer',opacity:loading?0.6:1}}>
              {loading ? <><span className="lp-spinner" />{mode==='login' ? 'Вход' : 'Регистрация'}</> : mode==='login' ? 'ВОЙТИ' : 'ЗАРЕГИСТРИРОВАТЬСЯ'}
            </button>
          </div>
        )}

        <div style={{marginTop:20,textAlign:'center',fontSize:13,color:'#8a8680'}}>
          {forgotMode ? (
            <button onClick={()=>{ setForgotMode(false); setForgotSent(false); setError(''); }}
              style={{background:'none',border:'none',color:'#B4936F',cursor:'pointer',fontWeight:600,fontSize:13}}>
              ← Назад ко входу
            </button>
          ) : mode === 'login' ? (
            <>
              <div><span>Нет аккаунта? <button onClick={onSwitch} style={{background:'none',border:'none',color:'#B4936F',cursor:'pointer',fontWeight:600,fontSize:13}}>Регистрация</button></span></div>
              <div style={{marginTop:10}}>
                <button onClick={()=>{ setForgotMode(true); setError(''); }} style={{background:'none',border:'none',color:'#B4936F',cursor:'pointer',fontSize:13,textDecoration:'underline'}}>
                  Забыли пароль?
                </button>
              </div>
            </>
          ) : (
            <span>Уже есть аккаунт? <button onClick={onSwitch} style={{background:'none',border:'none',color:'#B4936F',cursor:'pointer',fontWeight:600,fontSize:13}}>Войти</button></span>
          )}
        </div>
      </div>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{borderBottom:'1px solid var(--bw)',background:'var(--white)'}}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width:'100%', padding:'18px 20px', display:'flex', alignItems:'center', justifyContent:'space-between',
          background:'none', border:'none', cursor:'pointer', textAlign:'left',
          fontSize:15, fontWeight:600, color:'var(--black)', fontFamily:'inherit',
        }}
        aria-expanded={open}
      >
        <span style={{paddingRight:16}}>{q}</span>
        <span style={{
          flexShrink:0, width:28, height:28, borderRadius:'50%', border:'1px solid var(--bw2)',
          display:'flex', alignItems:'center', justifyContent:'center',
          color:'var(--gold)', fontSize:18, lineHeight:1,
          transform: open ? 'rotate(45deg)' : 'none', transition:'transform .2s',
        }}>+</span>
      </button>
      {open && (
        <div style={{padding:'0 20px 20px',fontSize:14,color:'var(--light)',lineHeight:1.7,fontWeight:300}}>
          {a}
        </div>
      )}
    </div>
  );
}

// Модал-календарь брокер-туров — открывается из кнопки "Все события" в блоке Календарь.
// Сетка ПН-ПТ × 4 недели начиная с текущей недели. События подтягиваются из CMS.
function BrokerToursCalendarModal({ events, onClose }: { events: any[]; onClose: () => void }) {
  // Build a 4-week grid starting from this week's Monday.
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(today);
  monday.setDate(today.getDate() - dow);
  monday.setHours(0, 0, 0, 0);

  const weeks: Date[][] = [];
  for (let w = 0; w < 4; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 5; d++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + w * 7 + d);
      week.push(day);
    }
    weeks.push(week);
  }

  const eventsByDay: Record<string, any[]> = {};
  for (const e of events) {
    const d = new Date(e.date);
    const key = d.toISOString().slice(0, 10);
    if (!eventsByDay[key]) eventsByDay[key] = [];
    eventsByDay[key].push(e);
  }

  const monthsRu = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const fmtDate = (d: Date) => `${d.getDate()} ${monthsRu[d.getMonth()]}`;
  const fmtTime = (iso: string) => {
    const t = new Date(iso);
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  };
  const projectLabel = (raw: string) => {
    if (!raw) return '';
    const v = raw.toLowerCase();
    if (v.includes('зорге') || v.includes('zorge')) return 'Зорге 9';
    if (v.includes('сереб') || v.includes('silver') || v.includes('берз')) return 'Серебряный Бор';
    return raw;
  };

  return (
    <div className="lp-overlay" style={{position:'fixed',inset:0,zIndex:1100,background:'rgba(0,0,0,0.85)',display:'flex',alignItems:'center',justifyContent:'center',padding:20,overflowY:'auto'}} onClick={onClose}>
      <div className="lp-popup" style={{background:'#1d1e23',color:'#fff',borderRadius:24,maxWidth:1280,width:'100%',padding:'40px 48px 32px',position:'relative'}} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Закрыть" style={{position:'absolute',top:20,right:20,background:'none',border:'none',color:'#fff',fontSize:28,cursor:'pointer',opacity:0.6,lineHeight:1}}>&times;</button>

        {/* Шапка календаря: брендинг ST MICHAEL (раньше было "Зорге №9" — образец
            с другого сайта). Правка "Корректировка 2", 2026-05-07. */}
        <div style={{display:'grid',gridTemplateColumns:'auto 1fr auto',alignItems:'center',gap:24,marginBottom:32}}>
          <div style={{fontSize:13,fontWeight:700,letterSpacing:3,color:'#B4936F',textTransform:'uppercase'}}>ST MICHAEL</div>
          <h2 style={{fontSize:32,fontWeight:300,textAlign:'center',margin:0,letterSpacing:'-0.5px'}}>Расписание брокер-туров</h2>
          <div style={{fontSize:11,fontWeight:600,color:'rgba(255,255,255,0.5)',textAlign:'right',lineHeight:1.4}}>Зорге 9 · Серебряный Бор</div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:14,marginBottom:18}}>
          {['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ'].map((d) => (
            <div key={d} style={{textAlign:'center',fontSize:11,letterSpacing:3,color:'rgba(255,255,255,0.4)',paddingBottom:10,borderBottom:'1px solid rgba(255,255,255,0.1)'}}>{d}</div>
          ))}
        </div>

        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          {weeks.map((week, wi) => (
            <div key={wi} style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:14}}>
              {week.map((day, di) => {
                const key = day.toISOString().slice(0, 10);
                const evs = eventsByDay[key] || [];
                const isPast = day < new Date(today.toISOString().slice(0, 10));
                if (evs.length === 0) {
                  return (
                    <div key={di} style={{
                      borderRadius:16,
                      background: isPast ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.06)',
                      padding:16,
                      minHeight:96,
                      opacity: isPast ? 0.4 : 0.7,
                    }}>
                      <div style={{fontSize:18,fontWeight:600,marginBottom:8,color:'rgba(255,255,255,0.5)'}}>{fmtDate(day)}</div>
                    </div>
                  );
                }
                return (
                  <div key={di} style={{
                    borderRadius:16,
                    background:'#fff',
                    color:'#1d1e23',
                    padding:'16px 18px',
                    minHeight:96,
                  }}>
                    <div style={{fontSize:18,fontWeight:700,marginBottom:8,letterSpacing:'-0.3px'}}>{fmtDate(day)}</div>
                    {evs.slice(0, 2).map((e, i) => (
                      <div key={i} style={{display:'flex',alignItems:'baseline',gap:10,fontSize:13,marginBottom:i < evs.length - 1 ? 4 : 0}}>
                        <strong style={{fontSize:14,fontWeight:700}}>{fmtTime(e.date)}</strong>
                        <span style={{fontSize:11,color:'#8a8680',borderLeft:'1px solid #e8eaed',paddingLeft:8,lineHeight:1.3}}>{projectLabel(e.title || '') || e.title}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{textAlign:'center',marginTop:28,fontSize:12,color:'rgba(255,255,255,0.4)'}}>
          Запись на брокер-тур через личный кабинет или по телефону +7 (499) 226-22-49
        </div>
      </div>
    </div>
  );
}

// Раздел "Материалы для продвижения" — компактные группы по папкам Я.Диска.
// Каждая группа сворачивается в одну карточку: иконка + имя папки + счётчик +
// "Скачать с Я.Диска" (открывает родительскую папку). По клику разворачивается
// и показывает все файлы. Правка "Корректировка 16:06" 2026-05-07.
function MaterialsSection({ materials }: { materials: any[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const groups = materials.reduce((acc: Record<string, any[]>, d: any) => {
    const key = d.subcategory?.trim() || 'Материалы';
    (acc[key] = acc[key] || []).push(d);
    return acc;
  }, {});
  const groupNames = Object.keys(groups).sort();
  const toggle = (g: string) => setExpanded((e) => ({ ...e, [g]: !e[g] }));
  return (
    <section id="materials" style={{background:'var(--bg)'}}>
      <div className="sh"><div className="sh-tag">Реклама</div><h2>Материалы для <em>продвижения</em></h2><p className="sh-sub">Изображения, рендеры, видео и презентации — сгруппированы по папкам Яндекс.Диска. Кликните на группу, чтобы развернуть.</p></div>
      {materials.length === 0 ? (
        <div className="doc-item" style={{cursor:'default'}}><div className="doc-name" style={{color:'var(--muted)'}}>Скоро здесь появятся материалы</div></div>
      ) : (
        <div className="mat-groups">
          {groupNames.map((group) => {
            const docs = groups[group];
            const isOpen = !!expanded[group];
            // Берём первый publicUrl из группы — если все файлы из одной папки
            // Я.Диска, ссылка приведёт прямо в эту папку (можно "Скачать всё").
            const folderUrl = docs[0]?.fileUrl || '';
            return (
              <div key={group} className={`mat-group${isOpen ? ' open' : ''}`}>
                <button type="button" className="mat-group-header" onClick={() => toggle(group)}>
                  <div className="mat-group-icon"><FileText size={18} /></div>
                  <div className="mat-group-info">
                    <div className="mat-group-name">{group}</div>
                    <div className="mat-group-meta">{docs.length} {docs.length === 1 ? 'файл' : docs.length < 5 ? 'файла' : 'файлов'}</div>
                  </div>
                  <ChevronRight className="mat-group-chev" size={20} />
                </button>
                {isOpen && (
                  <div className="mat-group-body">
                    <div className="mat-grid">
                      {docs.map((d: any) => (
                        <a key={d.id} href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="mat-card">
                          <div className="mat-card-icon"><FileText size={18} /></div>
                          <div className="mat-card-body">
                            <div className="mat-card-name">{d.name}</div>
                            {d.type && <div className="mat-card-type">{d.type}</div>}
                          </div>
                          <DownloadIcon className="mat-card-dl" size={16} />
                        </a>
                      ))}
                    </div>
                    {folderUrl && (
                      <a href={folderUrl} target="_blank" rel="noopener noreferrer" className="btn-outline" style={{display:'inline-flex',marginTop:14,padding:'10px 22px',fontSize:11}}>
                        Открыть папку на Я.Диске →
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function HeroSlides({ slides }: { slides: Array<{ tag?: string; title: string; description?: string; imageUrl?: string; ctaText?: string; ctaHref?: string }> }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (slides.length <= 1) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % slides.length), 6000);
    return () => clearInterval(id);
  }, [slides.length]);
  // Правка от заказчика 2026-05-07 (после правок 16:06): возврат к
  // ПОЛНОШИРИННОЙ картинке-фону с тёмным градиентом и текстом-оверлеем.
  // Stone-style (текст-карточка слева + рендер справа) — отменён, заказчик
  // хочет картинки во всю ширину как раньше.
  return (
    <div className="hero-slides">
      {slides.map((s, i) => (
        <div
          key={i}
          className="hero-slide"
          style={{
            opacity: i === idx ? 1 : 0,
            zIndex: i === idx ? 2 : 1,
            visibility: i === idx ? 'visible' : 'hidden',
            backgroundImage: s.imageUrl
              ? `linear-gradient(95deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.45) 55%, rgba(0,0,0,0.1) 100%), url(${s.imageUrl})`
              : 'linear-gradient(135deg, var(--dark) 0%, var(--black) 100%)',
          }}
        >
          <div className="hero-slide-content">
            {s.tag && <div className="hero-slide-tag">{s.tag}</div>}
            <h2 className="hero-slide-title">{s.title}</h2>
            {s.description && <p className="hero-slide-desc">{s.description}</p>}
            {s.ctaText && s.ctaHref && (
              <a className="btn-gold btn-lg" href={s.ctaHref} target="_blank" rel="noopener noreferrer">{s.ctaText}</a>
            )}
          </div>
        </div>
      ))}
      {slides.length > 1 && (
        <>
          {/* Кнопки ручного листания. Правка "Корректировка 16:06". */}
          <button
            type="button"
            className="hero-slide-arrow hero-slide-arrow-prev"
            onClick={() => setIdx((i) => (i - 1 + slides.length) % slides.length)}
            aria-label="Предыдущий слайд"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            className="hero-slide-arrow hero-slide-arrow-next"
            onClick={() => setIdx((i) => (i + 1) % slides.length)}
            aria-label="Следующий слайд"
          >
            <ChevronRight size={20} />
          </button>
          <div className="hero-slide-dots">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIdx(i)}
                aria-label={`Слайд ${i + 1}`}
                style={{
                  width: i === idx ? 28 : 8,
                  height: 8,
                  borderRadius: 4,
                  background: i === idx ? 'var(--gold)' : 'rgba(255,255,255,0.45)',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all .25s',
                  padding: 0,
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ContactFormModal({ onClose, source = 'landing-contact', defaultMessage = '', eventId, title = 'Связаться с нами' }: { onClose: () => void; source?: string; defaultMessage?: string; eventId?: string; title?: string }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState(defaultMessage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const formatPhone = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (!d) return '';
    return (d.startsWith('7') || d.startsWith('8')) ? '+7' + d.slice(1) : '+' + d;
  };

  const submit = async () => {
    setError('');
    if (!name.trim() || name.trim().length < 2) return setError('Введите имя');
    if (!phone || phone.replace(/\D/g, '').length < 10) return setError('Введите телефон');

    setLoading(true);
    try {
      const res = await fetch('/api/public/cms/contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: formatPhone(phone),
          email: email || undefined,
          message: message || undefined,
          source,
          eventId,
        }),
      });
      if (res.ok) setSent(true);
      else {
        const d = await res.json().catch(() => ({}));
        setError(d.message || 'Ошибка отправки');
      }
    } catch { setError('Ошибка соединения'); }
    setLoading(false);
  };

  return (
    <div className="lp-overlay" style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.5)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={onClose}>
      <div className="lp-popup" style={{background:'#fff',borderRadius:16,maxWidth:460,width:'100%',padding:'36px 32px',position:'relative'}} onClick={e=>e.stopPropagation()}>
        <button onClick={onClose} style={{position:'absolute',top:16,right:16,background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#8a8680'}}>&times;</button>
        <h2 style={{fontSize:22,fontWeight:700,marginBottom:4,color:'#1a1a1a'}}>{title}</h2>
        <p style={{fontSize:13,color:'#8a8680',marginBottom:24}}>Менеджер свяжется с вами в течение часа</p>

        {error && <div style={{padding:'10px 14px',background:'rgba(220,60,60,0.1)',color:'#c33',borderRadius:4,fontSize:13,marginBottom:16}}>{error}</div>}

        {sent ? (
          <div style={{padding:'14px',background:'rgba(60,140,80,0.1)',color:'#3a8a5c',borderRadius:4,fontSize:14,textAlign:'center'}}>
            <div style={{fontWeight:700,marginBottom:4}}>✓ Заявка принята</div>
            <div style={{fontSize:13}}>Мы свяжемся с вами в ближайшее время.</div>
          </div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <input placeholder="Ваше имя *" value={name} onChange={e=>setName(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <input placeholder="Телефон * (+79991234567)" type="tel" value={phone} onChange={e=>setPhone(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <input placeholder="Email (необязательно)" type="email" value={email} onChange={e=>setEmail(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <textarea placeholder="Сообщение" rows={3} value={message} onChange={e=>setMessage(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none',resize:'vertical',fontFamily:'inherit'}} />
            <button onClick={submit} disabled={loading}
              style={{padding:'14px',background:'#B4936F',color:'#fff',border:'none',borderRadius:50,fontSize:13,fontWeight:700,letterSpacing:1,cursor:'pointer',opacity:loading?0.6:1}}>
              {loading ? <><span className="lp-spinner" />Отправка</> : 'ОТПРАВИТЬ'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function QuickFixModal({ onClose }: { onClose: () => void }) {
  const [clientPhone, setClientPhone] = useState('');
  const [clientFullName, setClientFullName] = useState('');
  const [brokerPhone, setBrokerPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  const formatPhone = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (!d) return '';
    return (d.startsWith('7') || d.startsWith('8')) ? '+7' + d.slice(1) : '+' + d;
  };

  const handleSubmit = async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/public/quick-fix', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPhone: formatPhone(clientPhone),
          clientFullName,
          brokerPhone: formatPhone(brokerPhone),
        }),
      });
      const data = await res.json();
      if (res.ok) setResult(data);
      else setError(data.message || 'Ошибка фиксации');
    } catch { setError('Ошибка соединения'); }
    setLoading(false);
  };

  return (
    <div className="lp-overlay" style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.5)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={onClose}>
      <div className="lp-popup" style={{background:'#fff',borderRadius:16,maxWidth:460,width:'100%',padding:'36px 32px',position:'relative'}} onClick={e=>e.stopPropagation()}>
        <button onClick={onClose} style={{position:'absolute',top:16,right:16,background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#8a8680'}}>&times;</button>
        <h2 style={{fontSize:24,fontWeight:700,marginBottom:4,color:'#1a1a1a'}}>Моментальная фиксация</h2>
        <p style={{fontSize:13,color:'#8a8680',marginBottom:24}}>Зафиксируйте клиента за собой прямо сейчас, без входа в кабинет</p>

        {error && <div style={{padding:'10px 14px',background:'rgba(220,60,60,0.1)',color:'#c33',borderRadius:4,fontSize:13,marginBottom:16}}>{error}</div>}

        {result ? (
          <div style={{padding:'14px',background:'rgba(60,140,80,0.1)',color:'#3a8a5c',borderRadius:4,fontSize:14,textAlign:'center'}}>
            <div style={{fontWeight:700,marginBottom:4}}>✓ {result.status === 'EXISTS' ? 'Клиент уже зафиксирован за вами' : 'Клиент успешно зафиксирован'}</div>
            <div style={{fontSize:13}}>{result.message}</div>
          </div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <input placeholder="Телефон клиента (+79991234567)" type="tel" value={clientPhone}
              onChange={e=>setClientPhone(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <input placeholder="ФИО клиента" value={clientFullName}
              onChange={e=>setClientFullName(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <input placeholder="Ваш телефон (+79991234567)" type="tel" value={brokerPhone}
              onChange={e=>setBrokerPhone(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <button onClick={handleSubmit}
              disabled={loading || !clientPhone || !clientFullName || !brokerPhone}
              style={{padding:'14px',background:'#B4936F',color:'#fff',border:'none',borderRadius:50,fontSize:13,fontWeight:700,letterSpacing:1,cursor:'pointer',opacity:loading?0.6:1}}>
              {loading ? <><span className="lp-spinner" />Фиксация</> : 'ЗАФИКСИРОВАТЬ'}
            </button>
            <p style={{fontSize:12,color:'#8a8680',textAlign:'center',marginTop:4}}>
              Ваш номер должен быть зарегистрирован в ЛК. Уникальность действует 30 дней.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function renderAccent(text: string | undefined | null, accent?: string | null): React.ReactNode {
  if (!text) return null;
  // Поддержка \n в тексте — рендерится как <br/> (нужно чтобы редактор/CMS
  // мог жёстко задать переносы строк, например для H1-треугольника).
  const renderWithLineBreaks = (s: string): React.ReactNode => {
    if (!s.includes('\n')) return s;
    const parts = s.split('\n');
    return parts.map((p, i) => (
      <React.Fragment key={i}>{p}{i < parts.length - 1 && <br/>}</React.Fragment>
    ));
  };
  if (!accent || !text.includes(accent)) return renderWithLineBreaks(text);
  const i = text.indexOf(accent);
  return (<>{renderWithLineBreaks(text.slice(0, i))}<em>{renderWithLineBreaks(accent)}</em>{renderWithLineBreaks(text.slice(i + accent.length))}</>);
}

const DEFAULT_HERO = {
  tag: 'Партнёрская программа',
  // Жёсткие переносы (\n) задают форму "треугольника": каждая строка чуть
  // длиннее предыдущей. Правка заказчика (корректировка 2 от 2026-05-07).
  // Акцентная строка с em — самая длинная.
  title: 'Доход растёт\nвместе с объёмом\nпродаж агентства',
  titleAccent: 'продаж агентства',
  // Правка заказчика 2026-05-08: "Мы не суммируем сделки между проектами".
  // Метраж считается в рамках одного проекта. Текст переписан: фокус на
  // ставке вознаграждения, а не на суммировании.
  description: 'Прогрессивная шкала комиссии: до 8% по Зорге 9 и до 6,25% по Кварталу Серебряный Бор. Чем больше квадратных метров продаёте в одном проекте — тем выше ваша ставка.',
  stats: [
    { number: 'до 8%', label: 'Максимальная ставка по Зорге 9' },
    { number: '7 дней', label: 'Выплата вознаграждения' },
    { number: '30 дней', label: 'Срок уникальности клиента' },
    { number: '2', label: 'Активных проекта' },
  ],
  // Слайдер УТП — контент с реального сайта https://зорге9.рф/br (2026-05-06).
  // 4 слайда, авто-смена 5с. Картинки с tildacdn (хостинг сайта-источника).
  // Редактируется через /admin/content (вкладка Hero, поле slides).
  slides: [
    {
      tag: 'Активное строительство Большого Сити',
      title: 'Доходность до 25%',
      description: 'Спрос на аренду и рост стоимости объекта. Опция доверительного управления.',
      imageUrl: 'https://optim.tildacdn.com/tild3439-6364-4532-b563-663530663865/-/format/webp/__1_-4_1.jpg.webp',
    },
    {
      tag: 'Клубная инфраструктура',
      title: 'Премиальные сервисы',
      description: 'Беллмен и консьерж. Фитнес 3000 м² с бассейном 25 м. Широкий выбор ритейла.',
      imageUrl: 'https://optim.tildacdn.com/tild6336-3562-4638-b166-623430323566/-/format/webp/2026-04-16_152634.jpg.webp',
    },
    {
      tag: 'Готовый дом бизнес-класса · м. Полежаевская',
      title: 'Апартаменты от 12 млн ₽',
      description: 'Комиссия до 8%, выплаты вознаграждения до 7 рабочих дней.',
      imageUrl: 'https://optim.tildacdn.com/tild3333-6538-4231-a437-613537353665/-/format/webp/2026-05-04_145437.jpg.webp',
    },
    {
      tag: 'Рассрочка 0% — ПВ 30%, 0,5%/мес на 12 мес',
      title: 'Платеж от 65 тыс ₽/мес',
      description: 'Индивидуальные программы рассрочки с ПВ от 10% и сроком до 18 месяцев.',
      imageUrl: 'https://optim.tildacdn.com/tild3436-3066-4862-b537-393363373965/-/format/webp/15.jpg.webp',
    },
  ],
};
const DEFAULT_ADVANTAGES = {
  tag: 'Преимущества',
  title: 'Почему брокеры выбирают нас',
  titleAccent: 'выбирают нас',
  subtitle: 'Мы выстроили сотрудничество так, чтобы вы могли начать работать сразу — с первой сделки и с первого дня существования вашего ИП. Без дополнительных условий.',
  items: [
    { title: 'Выделенный отдел партнёров', description: 'Сопровождение на всех этапах сделки.' },
    { title: 'Выделенная линия', description: 'Ответ без ожидания с 9:00 до 21:00.' },
    { title: 'Быстрые выплаты', description: 'Вознаграждение — до 7 рабочих дней.' },
    { title: 'Высокая комиссия', description: 'До 8% — одна из лучших на рынке.' },
    { title: 'Партнёрство', description: 'Работаем на общий результат.' },
    { title: 'Обучение', description: 'Брокер-туры для быстрого старта продаж.' },
  ],
};
const DEFAULT_COMMISSION = {
  tag: 'Комиссия и условия выплаты',
  title: 'Прогрессивная шкала вознаграждения',
  titleAccent: 'шкала',
  // Подзаголовок переписан 2026-05-07 (корректировка 2): метраж суммируется
  // в рамках одного проекта, не по обоим. Сообщение под клиента: больше
  // продаёшь — выше ставка.
  subtitle: 'Чем больше квадратных метров продаёте в рамках одного проекта — тем выше ваша ставка комиссии. Действует с 1 января по 30 июня 2026 года.',
  // Per-project levels (preferred). Fallback to "levels" if absent.
  levelsByProject: {
    ZORGE9: [
      { name: 'Start', range: '0–59 м²', rate: '5,0%', active: false },
      { name: 'Basic', range: '60–119 м²', rate: '5,5%', active: false },
      { name: 'Strong', range: '120–199 м²', rate: '6,0%', active: false },
      { name: 'Premium', range: '200–319 м²', rate: '6,5%', active: false },
      { name: 'Elite', range: '320–499 м²', rate: '7,0%', active: false },
      { name: 'Champion', range: '500–699 м²', rate: '7,5%', active: false },
      { name: 'Legend', range: '700+ м²', rate: '8,0%', active: false },
    ],
    SILVER_BOR: [
      { name: 'Start', range: '0–47 м²', rate: '5,0%', active: false },
      { name: 'Basic', range: '48–95 м²', rate: '5,25%', active: false },
      { name: 'Strong', range: '96–170 м²', rate: '5,5%', active: false },
      { name: 'Premium', range: '171–279 м²', rate: '5,75%', active: false },
      { name: 'Elite', range: '280–399 м²', rate: '6,0%', active: false },
      { name: 'Champion', range: '400+ м²', rate: '6,25%', active: false },
    ],
  },
  // Legacy fallback
  levels: [
    { name: 'Start', range: '0–59 м²', rate: '5,0%', active: false },
    { name: 'Basic', range: '60–119 м²', rate: '5,5%', active: false },
    { name: 'Strong', range: '120–199 м²', rate: '6,0%', active: true },
    { name: 'Premium', range: '200–319 м²', rate: '6,5%', active: false },
    { name: 'Elite', range: '320–499 м²', rate: '7,0%', active: false },
    { name: 'Champion', range: '500–699 м²', rate: '7,5%', active: false },
    { name: 'Legend', range: '700+ м²', rate: '8,0%', active: false },
  ],
  // Карточки правой колонки — содержание из "Условия вознаграждения.docx"
  // (правка 2026-05-06): только 3 ключевых блока, без перегруза.
  cards: [
    { title: 'Условия выплаты', text: 'Вознаграждение выплачивается в течение 7 рабочих дней после оплаты клиентом.' },
    { title: 'Квартальный бонус', text: 'Дополнительный рост ставки при уровне Strong+: +0,1% → +0,15% → +0,2% → +0,25%. Ставка увеличивается при стабильных продажах.' },
    { title: 'Годовой бонус', text: 'За продуктивную работу в течение года: 100 000 ₽ + памятный кубок.' },
  ],
};
const DEFAULT_CONTACT = {
  tag: 'Команда',
  title: 'Всегда на связи',
  titleAccent: 'на связи',
  description: 'В наши бизнес-процессы заложена тесная коммуникация с партнёрами. Горячая линия по работе с партнёрами работает каждый день с 9:00 до 21:00.',
  blockTitle: 'Горячая линия по работе с партнёрами',
  phone: '+7 (499) 226-22-49',
  phoneHours: 'Ежедневно с 9:00 до 21:00',
  email: 'broker@stmichael.ru',
  telegram: 'https://t.me/stmichaelBroker',
  managers: [
    {
      name: 'Ксения Цепляева',
      role: 'Руководитель отдела по работе с партнёрами',
      phone: '+7 (906) 061-78-00',
    },
    {
      name: 'Дарья Великанова',
      role: 'Менеджер по работе с брокерами',
      phone: '+7 (930) 012-94-52',
    },
  ],
};
const DEFAULT_PROJECTS = [
  { id: 'p1', slug: 'zorge9', tag: null, name: 'Зорге', subtitle: '9', description: '', ctaText: 'Смотреть каталог', ctaHref: 'https://stmichael.ru/lots?property_type=apartments' },
  { id: 'p2', slug: 'silver-bor', tag: null, name: 'Квартал', subtitle: 'Серебряный Бор', description: '', ctaText: 'Смотреть каталог', ctaHref: 'https://stmichael.ru/lots?property_type=flat' },
];

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function formatEventDate(iso: string): { day: string; mon: string } {
  const d = new Date(iso);
  return { day: String(d.getDate()).padStart(2, '0'), mon: MONTHS_RU[d.getMonth()] };
}
function formatEventMeta(iso: string, location: string | null, isOnline: boolean): string {
  const d = new Date(iso);
  const day = d.getDate();
  const mon = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][d.getMonth()];
  const dow = ['вс','пн','вт','ср','чт','пт','сб'][d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const where = isOnline ? 'Онлайн' : (location || '');
  const base = `${day} ${mon}, ${dow}, ${hh}:${mm}`;
  return where ? `${base}. ${where}` : base;
}

export default function LandingPage() {
  const [authModal, setAuthModal] = useState<'login' | 'register' | null>(null);
  const [quickFixOpen, setQuickFixOpen] = useState(false);
  const [burgerOpen, setBurgerOpen] = useState(false);
  const [contactModal, setContactModal] = useState<{ open: boolean; source?: string; eventId?: string; title?: string; defaultMessage?: string }>({ open: false });
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [commissionProject, setCommissionProject] = useState<'ZORGE9' | 'SILVER_BOR'>('ZORGE9');
  const [hero, setHero] = useState<any>(DEFAULT_HERO);
  const [advantages, setAdvantages] = useState<any>(DEFAULT_ADVANTAGES);
  const [commission, setCommission] = useState<any>(DEFAULT_COMMISSION);
  const [contact, setContact] = useState<any>(DEFAULT_CONTACT);
  const [projects, setProjects] = useState<any[]>(DEFAULT_PROJECTS);
  const [events, setEvents] = useState<any[]>([]);
  const [promos, setPromos] = useState<any[]>([]);
  const [promoIdx, setPromoIdx] = useState(0);
  const [cooperationDocs, setCooperationDocs] = useState<any[]>([]);
  const [analyticsDocs, setAnalyticsDocs] = useState<any[]>([]);
  const [marketingDocs, setMarketingDocs] = useState<any[]>([]);
  const [materialsDocs, setMaterialsDocs] = useState<any[]>([]);
  const [news, setNews] = useState<any[]>([]);
  const { broker } = useAuth();
  const router = useRouter();

  const handleCabinet = () => { if (broker) router.push('/fixation'); else setAuthModal('login'); };
  const handleRegister = () => { if (broker) router.push('/fixation'); else setAuthModal('register'); };
  const handleProjectClick = (p: any) => { if (p.ctaHref) window.open(p.ctaHref, '_blank'); else handleCabinet(); };

  useEffect(() => {
    const prev = document.body.style.cssText;
    document.body.style.background = '#ffffff';
    document.body.style.color = '#1a1a1a';
    return () => { document.body.style.cssText = prev; };
  }, []);

  useEffect(() => {
    // cache: 'no-store' — гарантирует свежие данные после правок в /admin/content,
    // без необходимости рестартов или жёсткого Ctrl+F5
    const safeFetch = async (url: string) => {
      try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? await r.json() : null; }
      catch { return null; }
    };
    (async () => {
      const [content, evs, prjs, prms, coop, anal, mark, mat, nws] = await Promise.all([
        safeFetch('/api/public/cms/content'),
        safeFetch('/api/public/cms/events'),
        safeFetch('/api/public/cms/projects'),
        safeFetch('/api/public/cms/promos'),
        safeFetch('/api/public/documents?category=cooperation'),
        safeFetch('/api/public/documents?category=analytics'),
        safeFetch('/api/public/documents?category=marketing'),
        safeFetch('/api/public/documents?category=materials'),
        safeFetch('/api/public/cms/news'),
      ]);
      if (Array.isArray(nws)) setNews(nws);
      if (content) {
        if (content.hero) setHero({ ...DEFAULT_HERO, ...content.hero });
        if (content.advantages) setAdvantages({ ...DEFAULT_ADVANTAGES, ...content.advantages });
        if (content.commission) setCommission({ ...DEFAULT_COMMISSION, ...content.commission });
        if (content.contact) setContact({ ...DEFAULT_CONTACT, ...content.contact });
      }
      if (Array.isArray(evs)) setEvents(evs);
      if (Array.isArray(prjs) && prjs.length) {
        // Merge: если в БД ctaHref/ctaText null/пусто — берём из DEFAULT_PROJECTS
        // (по slug). Раньше seed-from-stmichael записывал ctaHref:null →
        // кнопка "Смотреть каталог" не вела на stmichael.ru/lots.
        // Правка "Корректировка 16:06" 2026-05-07.
        const merged = prjs.map((p: any) => {
          const def = DEFAULT_PROJECTS.find((d) => d.slug === p.slug);
          return {
            ...p,
            ctaHref: p.ctaHref || def?.ctaHref || null,
            ctaText: p.ctaText || def?.ctaText || 'Смотреть каталог',
          };
        });
        setProjects(merged);
      }
      if (Array.isArray(prms)) setPromos(prms);
      if (Array.isArray(coop)) setCooperationDocs(coop);
      if (Array.isArray(anal)) setAnalyticsDocs(anal);
      if (Array.isArray(mark)) setMarketingDocs(mark);
      if (Array.isArray(mat)) setMaterialsDocs(mat);
    })();
  }, []);

  // Auto-advance promo slider every 6 seconds
  useEffect(() => {
    if (promos.length <= 1) return;
    const id = setInterval(() => setPromoIdx((i) => (i + 1) % promos.length), 6000);
    return () => clearInterval(id);
  }, [promos.length]);

  return (
    <>
      <style dangerouslySetInnerHTML={{__html: `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700;800&display=swap');
html{scroll-behavior:smooth}
@keyframes popupIn{from{opacity:0;transform:scale(0.96) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}
@keyframes overlayIn{from{opacity:0}to{opacity:1}}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.lp-overlay{animation:overlayIn .25s ease both}
.lp-popup{animation:popupIn .35s cubic-bezier(.2,.7,.3,1) both}
.lp-spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:8px}
:root{--white:#ffffff;--bg:#f8f7f5;--bg2:#f0eeeb;--bg3:#e8e5e0;--black:#1a1a1a;--dark:#2c2c2a;--dark2:#3d3d3a;--gold:#B4936F;--gold2:#a07e5c;--gold3:#8c6b4a;--gold-bg:rgba(180,147,111,0.07);--gold-border:rgba(180,147,111,0.2);--gold-light:#f5efe8;--muted:#8a8680;--muted2:#a09b95;--light:#6b6660;--bw:rgba(0,0,0,0.08);--bw2:rgba(0,0,0,0.12);--green:#3a8a5c;--r:4px;--r-card:16px;--r-card-lg:16px;--r-tag:8px;--r-pill:50px;--fs-h1:clamp(40px,4.6vw,64px);--fs-h2:clamp(28px,3.2vw,40px);--fs-h3:clamp(18px,1.8vw,22px);--t:.2s ease}
body{background:var(--white);color:var(--black);font-family:'Inter',sans-serif;font-size:15px;line-height:1.7;overflow-x:hidden}
.lp a{text-decoration:none;color:inherit}
.lp header{position:sticky;top:0;z-index:200;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--bw);display:flex;align-items:center;justify-content:space-between;padding:0 60px;height:64px}
.logo{display:flex;align-items:center;gap:10px}.logo-img{height:18px;width:auto;display:block}.logo-sub{font-size:9px;color:var(--muted);letter-spacing:1px;border-left:1px solid var(--bw);padding-left:10px;margin-left:2px;text-transform:uppercase;font-weight:600}
.h-right{display:flex;align-items:center;gap:14px;margin-left:auto}.h-phone{font-size:13px;color:var(--black);font-weight:600;white-space:nowrap}
.h-burger{display:flex;width:38px;height:38px;border:1px solid var(--bw2);border-radius:10px;background:transparent;cursor:pointer;padding:0;flex-direction:column;align-items:center;justify-content:center;gap:4px;transition:all var(--t)}.h-burger:hover{background:var(--bg);border-color:var(--bw2)}.h-burger span{display:block;width:16px;height:2px;background:var(--black);border-radius:2px}
.h-burger-menu{position:absolute;top:100%;right:60px;margin-top:8px;background:#fff;border:1px solid var(--bw);border-radius:var(--r-card);box-shadow:0 16px 40px rgba(0,0,0,0.10);padding:8px 0;display:flex;flex-direction:column;min-width:240px;animation:popupIn .25s ease both;z-index:300}.h-burger-menu a{padding:12px 24px;font-size:13px;font-weight:500;color:var(--black);transition:background .15s}.h-burger-menu a:hover{background:var(--bg);color:var(--gold)}
.btn-enter{display:inline-flex;align-items:center;gap:8px;padding:11px 28px;background:var(--black);color:var(--white);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:var(--r-pill);transition:all var(--t);border:none;cursor:pointer}.btn-enter:hover{background:var(--dark);transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,0.15)}
.btn-gold{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;background:var(--gold);color:var(--white);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:var(--r-pill);transition:all var(--t);border:none;cursor:pointer;position:relative;overflow:hidden}.btn-gold::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);transform:translateX(-100%);transition:transform .6s ease}.btn-gold:hover::after{transform:translateX(100%)}.btn-gold:hover{background:var(--gold2);transform:translateY(-2px);box-shadow:0 12px 28px rgba(180,147,111,0.32)}
.btn-outline{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;background:transparent;color:var(--black);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:var(--r-pill);border:1px solid var(--bw2);transition:all var(--t);cursor:pointer}.btn-outline:hover{border-color:var(--black);background:rgba(0,0,0,0.04)}
.btn-tertiary{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;background:var(--bg);color:var(--black);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:var(--r-pill);transition:all var(--t);border:none;cursor:pointer}.btn-tertiary:hover{background:var(--bg2)}
.btn-white{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;background:var(--white);color:var(--black);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:var(--r-pill);transition:all var(--t);border:none;cursor:pointer}.btn-white:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.15)}
.hero-banner{padding:0 60px;margin-top:20px}
/* Полноширинный стиль с картинкой и тёмным градиентом, текст поверх.
   align-items:flex-start — текст всегда начинается СВЕРХУ.
   Высота 420px (раньше 380) + уплотнённые margin'ы — кнопка "Подробнее"
   на длинных промо теперь помещается. Правка заказчика 2026-05-08. */
.hero-slides{position:relative;width:100%;height:420px;border-radius:var(--r-card);overflow:hidden;background:var(--bg2)}
.hero-slide{position:absolute;inset:0;display:flex;align-items:flex-start;padding:36px 48px;background-size:cover;background-position:center;transition:opacity .6s ease}
.hero-slide-content{max-width:680px;color:#fff;display:flex;flex-direction:column;align-items:flex-start;gap:0}
.hero-slide-tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--gold);margin-bottom:10px;padding:6px 14px;border:1px solid rgba(180,147,111,0.6);border-radius:var(--r-pill);background:rgba(0,0,0,0.25);backdrop-filter:blur(8px)}
.hero-slide-title{font-size:clamp(24px,2.8vw,36px);font-weight:300;line-height:1.1;margin:0 0 8px;letter-spacing:-0.5px;color:#fff}
.hero-slide-title strong{font-weight:700}
.hero-slide-desc{font-size:13px;line-height:1.5;color:rgba(255,255,255,0.9);font-weight:300;max-width:560px;margin:0 0 12px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.hero-slide-content .btn-gold{padding:12px 24px;font-size:11px;margin-top:4px}
.hero-slide-dots{position:absolute;bottom:18px;left:0;right:0;display:flex;justify-content:center;gap:6px;z-index:3}
.hero-slide-arrow{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:50%;background:rgba(255,255,255,0.92);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--black);box-shadow:0 4px 16px rgba(0,0,0,0.18);transition:all var(--t);z-index:4}
.hero-slide-arrow:hover{background:var(--gold);color:var(--white);box-shadow:0 6px 20px rgba(180,147,111,0.4)}
.hero-slide-arrow-prev{left:18px}.hero-slide-arrow-next{right:18px}
/* Hero компактный + по левому краю заголовка (правка 2026-05-08).
   Раньше был text-align:center + margin:0 auto. Теперь содержимое
   прижато к левому краю; padding/margin уменьшены. */
.hero{padding:40px 60px 36px}
.hero-compact{max-width:920px;margin:0 auto;text-align:left}
.hero-tag{display:inline-flex;align-items:center;gap:10px;margin-bottom:14px}.hero-tag::before{content:'';width:28px;height:1px;background:var(--gold)}.hero-tag span{font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--gold)}
/* H1 "треугольник" — каждая строка чуть длиннее предыдущей. \n в title
   рендерится как <br/>. line-height:1 уплотняет блок. */
.hero h1{font-size:var(--fs-h1);font-weight:300;line-height:1;letter-spacing:-1.5px;margin-bottom:18px;text-wrap:balance}
.hero h1 strong{font-weight:700}.hero h1 em{font-style:normal;color:var(--gold);font-weight:700}
.hero-desc{font-size:15px;color:var(--light);line-height:1.6;font-weight:400;margin-bottom:22px;max-width:640px}
.hero-btns{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.btn-lg{padding:18px 40px;font-size:12px}
.stats-band{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--bw);border-bottom:1px solid var(--bw);background:var(--white);margin:0 60px}.hst{padding:32px 24px;text-align:center;border-right:1px solid var(--bw)}.hst:last-child{border-right:none}.hst-n{font-size:32px;font-weight:700;line-height:1;margin-bottom:8px;letter-spacing:-0.8px;color:var(--black)}.hst-l{font-size:11px;color:var(--muted);line-height:1.4;font-weight:500;letter-spacing:0.3px}
.quick{display:grid;grid-template-columns:repeat(3,1fr);border-radius:var(--r-card);overflow:hidden;margin:0 60px;background:var(--bg)}.qa{padding:28px 32px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:background var(--t);border-right:1px solid rgba(0,0,0,0.04)}.qa:last-child{border-right:none}.qa:hover{background:var(--bg2)}.qa-title{font-size:15px;font-weight:500}.qa-sub{font-size:12px;color:var(--muted);margin-top:3px}.qa-arrow{width:36px;height:36px;border-radius:50%;background:var(--white);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px;transition:all var(--t);flex-shrink:0}.qa:hover .qa-arrow{background:var(--black);color:var(--white)}
.lp section{padding:80px 60px}.sep{border:none;border-top:1px solid var(--bw);margin:0 60px}
.sh{margin-bottom:48px}.sh-center{text-align:center}.sh-tag{font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--gold);margin-bottom:14px}.sh h2{font-size:var(--fs-h2);font-weight:300;line-height:1.1;letter-spacing:-0.5px}.sh h2 strong{font-weight:700}.sh h2 em{font-style:normal;color:var(--gold);font-weight:700}.sh-sub{color:var(--muted);font-size:15px;max-width:560px;margin-top:14px;line-height:1.7;font-weight:400}.sh-center .sh-sub{margin-left:auto;margin-right:auto}
.proj-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}.proj-card{border-radius:var(--r-card);padding:36px 32px;display:flex;flex-direction:column;justify-content:flex-end;min-height:240px;transition:all .3s ease;cursor:pointer;background:var(--bg)}.proj-card:hover{transform:translateY(-3px);box-shadow:0 12px 32px rgba(0,0,0,0.06)}.proj-tag{font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:var(--gold);margin-bottom:10px}.proj-name{font-size:28px;font-weight:300;margin-bottom:8px;letter-spacing:-0.3px}.proj-name strong{font-weight:700}.proj-info{font-size:13px;color:var(--muted);margin-bottom:16px;line-height:1.7}.proj-link{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--gold);display:inline-flex;align-items:center;gap:6px}
.comm-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:28px;align-items:start}.comm-table{border-radius:var(--r-card);overflow:hidden;background:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,0.04)}.ct-head{display:grid;grid-template-columns:1fr 1.2fr 0.8fr;padding:14px 22px;background:var(--bg);gap:8px}.ct-head span{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted)}.ct-row{display:grid;grid-template-columns:1fr 1.2fr 0.8fr;padding:14px 22px;border-top:1px solid var(--bw);gap:8px;transition:background var(--t)}.ct-row:hover{background:var(--gold-bg)}.ct-level{font-size:14px;font-weight:500}.ct-range{font-size:13px;color:var(--muted)}.ct-rate{font-size:14px;font-weight:600;text-align:right}
.comm-info{display:flex;flex-direction:column;gap:10px}.comm-card{padding:18px 22px;background:var(--bg);border-radius:var(--r-card);transition:background var(--t)}.comm-card:hover{background:var(--gold-bg)}.comm-card-title{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--gold);margin-bottom:8px}.comm-card p{font-size:13px;color:var(--light);line-height:1.6;font-weight:400;margin:0}
.s-adv{background:var(--black);color:var(--white);padding:64px 60px;position:relative;overflow:hidden}.s-adv .sh{margin-bottom:32px}.s-adv .sh-tag{color:var(--gold)}.s-adv h2{color:var(--white)}.s-adv h2 em{color:var(--gold)}.adv-bg-glow{position:absolute;inset:0;background:radial-gradient(circle at 20% 30%,rgba(180,147,111,0.18),transparent 45%),radial-gradient(circle at 85% 80%,rgba(180,147,111,0.12),transparent 50%);pointer-events:none;z-index:0}.s-adv .sh,.s-adv .adv-grid{position:relative;z-index:1}.adv-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:rgba(255,255,255,0.08);border-radius:var(--r-card);overflow:hidden}.adv-card{padding:24px 24px;background:var(--black)}.adv-icon{width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:center;margin-bottom:12px}.adv-title{font-size:15px;font-weight:600;color:var(--white);margin-bottom:6px}.adv-desc{font-size:12px;color:rgba(255,255,255,0.5);line-height:1.55;font-weight:300}
.s-comm{background:var(--gold);padding:80px 60px;position:relative;overflow:hidden}.s-comm .sh-tag{color:rgba(255,255,255,0.6)}.s-comm h2{color:var(--white)}.comm-content{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:28px}.comm-desc{font-size:15px;color:rgba(255,255,255,0.8);line-height:1.8;font-weight:300;margin-bottom:24px}.comm-list{display:flex;flex-direction:column;gap:10px}.comm-list-item{display:flex;align-items:flex-start;gap:10px;font-size:14px;color:rgba(255,255,255,0.9)}.comm-list-dot{width:6px;height:6px;border-radius:50%;background:var(--white);flex-shrink:0;margin-top:7px}
.s-cta{text-align:center;padding:100px 60px}
.news-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.news-card{display:flex;flex-direction:column;border-radius:var(--r-card);overflow:hidden;background:var(--bg);transition:all var(--t);text-decoration:none;color:inherit;box-shadow:0 1px 2px rgba(0,0,0,0.04)}.news-card:hover{transform:translateY(-3px);box-shadow:0 12px 28px rgba(0,0,0,0.08)}.news-img{height:160px;background-size:cover;background-position:center;background-color:var(--bg2)}.news-body{padding:18px 20px;display:flex;flex-direction:column;gap:6px;flex:1}.news-source{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--gold)}.news-title{font-size:14px;font-weight:500;line-height:1.45}.news-meta{font-size:11px;color:var(--muted);margin-top:auto;padding-top:8px}
.lp footer{padding:40px 60px;border-top:1px solid var(--bw);background:var(--bg)}.foot-grid{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:40px;margin-bottom:28px}.foot-logo{font-size:14px;font-weight:700;letter-spacing:2.5px;margin-bottom:2px}.foot-logo-sub{font-size:10px;color:var(--muted);letter-spacing:1px}.foot-col-title{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--gold);margin-bottom:12px}.foot-link{display:block;font-size:13px;color:var(--muted);margin-bottom:7px;transition:color .2s}.foot-link:hover{color:var(--black)}.foot-bottom{display:flex;justify-content:space-between;align-items:center;padding-top:18px;border-top:1px solid var(--bw);font-size:12px;color:var(--muted2)}
.float-btn{position:fixed;bottom:28px;right:28px;z-index:100;padding:14px 28px;background:var(--black);color:var(--white);font-size:12px;font-weight:700;letter-spacing:1px;border-radius:50px;cursor:pointer;border:none;box-shadow:0 4px 20px rgba(0,0,0,0.2);transition:all .25s}.float-btn:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(0,0,0,0.3)}
.ev-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.ev-card{padding:24px 26px;border-radius:var(--r-card);display:flex;align-items:center;gap:20px;cursor:pointer;transition:all var(--t);background:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,0.04)}.ev-card:hover{background:var(--gold-bg);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.06)}.ev-date{width:54px;height:54px;border-radius:var(--r-tag);background:var(--white);display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0}.ev-day{font-size:22px;font-weight:700;line-height:1}.ev-mon{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}.ev-info{flex:1}.ev-title{font-size:15px;font-weight:500;margin-bottom:3px}.ev-meta{font-size:12px;color:var(--muted)}
.coop-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:start}.coop-left p{font-size:15px;color:var(--muted);line-height:1.8;font-weight:300;margin-bottom:24px}.doc-list{display:flex;flex-direction:column;gap:8px}.doc-item{display:flex;align-items:center;gap:14px;padding:16px 20px;background:var(--white);border-radius:var(--r-card);cursor:pointer;transition:all var(--t);box-shadow:0 1px 2px rgba(0,0,0,0.04)}.doc-item:hover{background:var(--gold-bg);transform:translateX(4px);box-shadow:0 4px 16px rgba(0,0,0,0.06)}.doc-icon{width:36px;height:36px;border-radius:10px;background:var(--gold-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0}.doc-name{font-size:13px;flex:1;font-weight:500}.doc-dl{color:var(--muted);display:flex;align-items:center}
.mat-groups{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.mat-group{background:var(--white);border-radius:var(--r-card);overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.04);transition:box-shadow var(--t)}.mat-group.open{box-shadow:0 6px 24px rgba(0,0,0,0.08)}
.mat-group-header{width:100%;display:flex;align-items:center;gap:14px;padding:18px 22px;background:transparent;border:none;cursor:pointer;text-align:left;transition:background var(--t)}.mat-group-header:hover{background:var(--gold-bg)}
.mat-group-icon{width:42px;height:42px;border-radius:10px;background:var(--gold-bg);display:flex;align-items:center;justify-content:center;color:var(--gold);flex-shrink:0}
.mat-group-info{flex:1;min-width:0}.mat-group-name{font-size:14px;font-weight:600;color:var(--black);margin-bottom:2px}.mat-group-meta{font-size:11px;color:var(--muted);font-weight:500}
.mat-group-chev{color:var(--muted);transition:transform var(--t)}.mat-group.open .mat-group-chev{transform:rotate(90deg);color:var(--gold)}
.mat-group-body{padding:0 22px 22px;border-top:1px solid var(--bw);padding-top:18px}
.mat-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.mat-card{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg);border-radius:10px;cursor:pointer;transition:all var(--t);text-decoration:none;color:inherit}.mat-card:hover{background:var(--gold-bg);transform:translateX(2px)}.mat-card-icon{width:32px;height:32px;border-radius:8px;background:var(--white);display:flex;align-items:center;justify-content:center;color:var(--gold);flex-shrink:0}.mat-card-body{flex:1;min-width:0}.mat-card-name{font-size:12px;font-weight:500;color:var(--black);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mat-card-type{font-size:9px;font-weight:600;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-top:2px}.mat-card-dl{color:var(--muted);flex-shrink:0}.mat-card:hover .mat-card-dl{color:var(--gold)}
@media(max-width:1279px){.lp section{padding:72px 40px}.s-adv,.s-comm,.s-cta{padding-left:40px;padding-right:40px}.lp header{padding:0 40px}.hero{padding:48px 40px 40px}.hero-banner{padding:0 40px}.lp footer{padding:40px 40px}.quick,.sep,.stats-band{margin-left:40px;margin-right:40px}}
@media(max-width:1023px){.adv-grid,.proj-grid{grid-template-columns:repeat(2,1fr)}.mat-groups{grid-template-columns:1fr}.foot-grid{grid-template-columns:1fr 1fr;gap:32px}.news-grid{grid-template-columns:repeat(2,1fr)}.hero-slides{height:360px}.hero-slide{padding:30px 36px}.h-burger-menu{right:40px}}
@media(max-width:767px){.lp header{padding:0 20px;height:60px}.lp section{padding:56px 20px}.s-adv,.s-comm,.s-cta{padding-left:20px;padding-right:20px}.hero{padding:28px 20px 28px}.hero-banner{padding:0 20px;margin-top:16px}.lp footer{padding:32px 20px}.quick,.sep,.stats-band{margin-left:20px;margin-right:20px}.stats-band{grid-template-columns:repeat(2,1fr)}.hst{padding:24px 16px}.hst:nth-child(2){border-right:none}.hst:nth-child(1),.hst:nth-child(2){border-bottom:1px solid var(--bw)}.quick,.proj-grid,.ev-grid,.comm-content,.coop-grid,.comm-grid,.adv-grid,.news-grid,.mat-grid,.mat-groups{grid-template-columns:1fr}.foot-grid{grid-template-columns:1fr 1fr;gap:24px}.qa{padding:22px 24px;border-right:none;border-bottom:1px solid rgba(0,0,0,0.04)}.proj-card{padding:28px 24px;min-height:200px}.sh{margin-bottom:28px}.hero-slides{height:280px}.hero-slide{padding:24px 22px}.hero-slide-title{font-size:clamp(20px,5vw,28px)}.hero h1{font-size:clamp(28px,8vw,40px)}.h-burger-menu{right:20px}.h-phone{display:none}}
@media(max-width:499px){.stats-band{grid-template-columns:1fr 1fr}.foot-grid{grid-template-columns:1fr}.proj-card{min-height:180px;padding:24px 20px}.proj-name{font-size:24px}.adv-card{padding:28px 22px}.comm-grid{gap:24px}.h-phone{font-size:12px}}
@media(max-width:374px){.hero-btns{flex-direction:column;align-items:stretch}.hero-btns .btn-gold{width:100%;justify-content:center}}
      `}} />

      <div className="lp">
        <header>
          <a className="logo" href="#">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/stmichael-logo.png"
              alt="ST Michael"
              className="logo-img"
            />
            <div className="logo-sub">Кабинет брокера</div>
          </a>
          {/* Шапка по правке "Корректировка 2" (2026-05-07):
              - Лого уменьшено (логотип перебивал размер H1)
              - Меню целиком в бургере справа от телефона/кнопки (на ВСЕХ экранах)
                — раньше центральный inline-nav конкурировал с лого */}
          <div className="h-right">
            <a className="h-phone" href="tel:+74992262249">+7 (499) 226-22-49</a>
            <button className="btn-enter" onClick={handleCabinet}>{broker ? 'КАБИНЕТ' : 'ВОЙТИ'}</button>
            <button
              type="button"
              className="h-burger"
              aria-label="Меню"
              aria-expanded={burgerOpen}
              onClick={() => setBurgerOpen(v => !v)}
            >
              <span /><span /><span />
            </button>
          </div>
          {burgerOpen && (
            <div className="h-burger-menu" onClick={() => setBurgerOpen(false)}>
              <a href="#projects">Проекты</a>
              <a href="#commission">Комиссия</a>
              <a href="#events">Мероприятия</a>
              <a href="#cooperation">Документы</a>
              <a href="#materials">Материалы</a>
              <a href="#contact">Контакты</a>
            </div>
          )}
        </header>

        {/* HERO v3 — структура по правке заказчика 2026-05-06 (второй проход):
            1) НАВЕРХУ — слайдер с текстом-оверлеем (стартовая точка сайта)
            2) НИЖЕ — компактный единый блок: H1 + описание + 2 кнопки
            3) ПОТОМ — stats band с цифрами
            Без 2-колонного грида — Hero стал стандартной вертикальной формой. */}
        {Array.isArray(hero.slides) && hero.slides.length > 0 && (
          <div className="hero-banner">
            <HeroSlides slides={hero.slides} />
          </div>
        )}

        <div className="hero hero-compact">
          <div className="hero-tag"><span>{hero.tag}</span></div>
          <h1><strong>{renderAccent(hero.title, hero.titleAccent)}</strong></h1>
          <p className="hero-desc">{hero.description}</p>
          <div className="hero-btns">
            <button className="btn-gold btn-lg" onClick={handleRegister}>Стать партнёром</button>
            <button
              type="button"
              className="btn-outline btn-lg"
              onClick={() => setContactModal({
                open: true,
                source: 'broker-tour',
                title: 'Запись на брокер-тур',
                defaultMessage: 'Хочу записаться на ближайший брокер-тур',
              })}
            >Записаться на брокер-тур</button>
          </div>
        </div>

        <Reveal>
          <div className="stats-band">
            {(hero.stats || []).map((s: any, i: number) => (
              <div key={i} className="hst"><div className="hst-n"><StatNumber raw={s.number} /></div><div className="hst-l">{s.label}</div></div>
            ))}
          </div>
        </Reveal>

        {/* PROJECTS — по правке Рената (2026-05-06):
            - заголовок изменён: "Проекты — одна программа" → "Наш проект"
              (комиссия суммируется только в рамках одного проекта, не общая)
            - убран фоновой полупрозрачный image на карточках (устарело,
              не несёт смысла, перегружает текст). Карточки чистые. */}
        <section id="projects">
          <div className="sh"><div className="sh-tag">Проекты</div><h2><em>Наши проекты</em></h2><p className="sh-sub">Зорге 9 и Квартал Серебряный Бор. Каждый проект — отдельная прогрессивная шкала комиссии.</p></div>
          <div className="proj-grid">
            {projects.map((p: any, i: number) => (
              <Reveal key={p.id} delay={i * 120}>
              <div className="proj-card" onClick={() => handleProjectClick(p)}>
                {p.tag && <div className="proj-tag">{p.tag}</div>}
                <div className="proj-name"><strong>{p.name}</strong>{p.subtitle ? ` ${p.subtitle}` : ''}</div>
                {p.description && <div className="proj-info">{p.description}</div>}

                {(p.classType || p.address || p.readyYear || p.totalUnits || p.commissionFrom) && (
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px 16px',fontSize:11,color:'var(--muted)',marginTop:8,marginBottom:12}}>
                    {p.classType && <div><span style={{color:'var(--muted2)'}}>Класс:</span> <strong style={{color:'var(--black)'}}>{p.classType}</strong></div>}
                    {p.address && <div><span style={{color:'var(--muted2)'}}>Адрес:</span> <strong style={{color:'var(--black)'}}>{p.address}</strong></div>}
                    {p.readyYear && <div><span style={{color:'var(--muted2)'}}>Сдача:</span> <strong style={{color:'var(--black)'}}>{p.readyQuarter ? `${p.readyQuarter} кв. ` : ''}{p.readyYear}</strong></div>}
                    {p.floorsTotal && <div><span style={{color:'var(--muted2)'}}>Этажей:</span> <strong style={{color:'var(--black)'}}>{p.floorsTotal}</strong></div>}
                    {p.totalUnits && <div><span style={{color:'var(--muted2)'}}>Лотов:</span> <strong style={{color:'var(--black)'}}>{p.totalUnits}</strong></div>}
                    {(p.commissionFrom || p.commissionTo) && <div><span style={{color:'var(--muted2)'}}>Комиссия:</span> <strong style={{color:'var(--gold)'}}>{p.commissionFrom}{p.commissionTo && p.commissionTo !== p.commissionFrom ? `–${p.commissionTo}` : ''}%</strong></div>}
                  </div>
                )}

                <div className="proj-link">{p.ctaText || 'Смотреть каталог'} &rarr;</div>
              </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* PROMO SLIDER — full-width стиль с картинкой во весь блок.
            Если у промо нет imageUrl — fallback на дефолтное здание Зорге 9
            (правка 2026-05-07: каждый слайд должен быть с картинкой). */}
        {promos.length > 0 && (
          <section id="promos" style={{padding:'40px 60px'}}>
            <div className="hero-slides" style={{height:340}}>
              {promos.map((p, i) => {
                const FALLBACK = 'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bd2e855b408722fb61fa362b50d7f83282d3a86e.jpg';
                const img = p.imageUrl || FALLBACK;
                return (
                <div key={p.id} className="hero-slide" style={{
                  opacity: i === promoIdx ? 1 : 0,
                  zIndex: i === promoIdx ? 2 : 1,
                  visibility: i === promoIdx ? 'visible' : 'hidden',
                  backgroundImage: `linear-gradient(95deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.45) 55%, rgba(0,0,0,0.1) 100%), url(${img})`,
                }}>
                  <div className="hero-slide-content">
                    {p.tag && <div className="hero-slide-tag">{p.tag}</div>}
                    <h3 className="hero-slide-title">{p.title}</h3>
                    {p.subtitle && <p className="hero-slide-desc" style={{marginBottom:6}}>{p.subtitle}</p>}
                    {p.description && <p className="hero-slide-desc">{p.description}</p>}
                    {(p.ctaText || p.ctaHref) && (
                      <a
                        href={p.ctaHref || '#projects'}
                        className="btn-gold btn-lg"
                        target={p.ctaHref?.startsWith('http') ? '_blank' : undefined}
                        rel="noopener noreferrer"
                        style={{padding:'12px 24px',fontSize:11}}
                      >
                        {p.ctaText || 'Подробнее'}
                      </a>
                    )}
                  </div>
                </div>
                );
              })}
              {promos.length > 1 && (
                <>
                  <button
                    type="button"
                    className="hero-slide-arrow hero-slide-arrow-prev"
                    onClick={() => setPromoIdx((i) => (i - 1 + promos.length) % promos.length)}
                    aria-label="Предыдущий слайд"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <button
                    type="button"
                    className="hero-slide-arrow hero-slide-arrow-next"
                    onClick={() => setPromoIdx((i) => (i + 1) % promos.length)}
                    aria-label="Следующий слайд"
                  >
                    <ChevronRight size={20} />
                  </button>
                  <div className="hero-slide-dots">
                    {promos.map((_, i) => (
                      <button key={i} onClick={() => setPromoIdx(i)} style={{
                        width: i === promoIdx ? 24 : 8, height: 8, borderRadius: 4,
                        background: i === promoIdx ? 'var(--gold)' : 'rgba(255,255,255,0.45)',
                        border: 'none', cursor: 'pointer', transition: 'all .25s', padding: 0,
                      }} aria-label={`Слайд ${i+1}`} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        <hr className="sep" />

        {/* COMMISSION */}
        <section id="commission">
          <div className="sh"><div className="sh-tag">{commission.tag}</div><h2>{renderAccent(commission.title, commission.titleAccent)}</h2>{commission.subtitle && <p className="sh-sub">{commission.subtitle}</p>}</div>

          {commission.levelsByProject && (
            <div style={{display:'flex',justifyContent:'center',gap:8,marginBottom:24}}>
              {(['ZORGE9', 'SILVER_BOR'] as const).map((proj) => (
                <button
                  key={proj}
                  onClick={() => setCommissionProject(proj)}
                  style={{
                    padding: '10px 24px',
                    background: commissionProject === proj ? 'var(--gold)' : 'var(--bg)',
                    color: commissionProject === proj ? 'var(--white)' : 'var(--muted)',
                    border: '1px solid ' + (commissionProject === proj ? 'var(--gold)' : 'var(--bw)'),
                    borderRadius: 50,
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 1.5,
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                    transition: 'all .2s',
                  }}
                >
                  {proj === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}
                </button>
              ))}
            </div>
          )}

          <div className="comm-grid">
            <div>
              <div className="comm-table">
                <div className="ct-head"><span>Уровень</span><span>Объём м2/кв.</span><span>Ставка</span></div>
                {((commission.levelsByProject?.[commissionProject]) || commission.levels || []).map((lv: any, i: number) => (
                  <div key={i} className={`ct-row${lv.active ? ' active' : ''}`}>
                    <span className="ct-level">{lv.name}</span>
                    <span className="ct-range">{lv.range}</span>
                    <span className="ct-rate">{lv.rate}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="comm-info">
              {(commission.cards || []).map((c: any, i: number) => (
                <div key={i} className="comm-card">
                  <div className="comm-card-title">{c.title}</div>
                  <p>{c.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <hr className="sep" />

        {/* EVENTS */}
        <section id="events" style={{background:'var(--bg)'}}>
          <div className="sh" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:24}}>
            <div>
              <div className="sh-tag">Календарь событий</div>
              <h2>Ближайшие <em>мероприятия</em></h2>
            </div>
            <button
              type="button"
              onClick={() => setCalendarOpen(true)}
              className="btn-outline"
              style={{padding:'10px 24px',fontSize:10,marginBottom:4,whiteSpace:'nowrap'}}
            >
              Все события &rarr;
            </button>
          </div>
          {events.length === 0 ? (
            <div style={{textAlign:'center',padding:'24px 0',display:'flex',flexDirection:'column',alignItems:'center',gap:14}}>
              <div style={{color:'var(--muted)',fontSize:14}}>В ближайшее время мероприятий не запланировано</div>
              <button
                type="button"
                className="btn-gold"
                onClick={() => setCalendarOpen(true)}
              >Расписание брокер-туров</button>
            </div>
          ) : (
            <div className="ev-grid">
              {events.map((ev: any) => {
                const d = formatEventDate(ev.date);
                const eventDate = new Date(ev.date).toLocaleString('ru-RU', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
                return (
                  <div
                    key={ev.id}
                    className="ev-card"
                    onClick={() => setContactModal({
                      open: true,
                      source: 'event-signup',
                      eventId: ev.id,
                      title: `Запись: ${ev.title}`,
                      defaultMessage: `Хочу записаться на «${ev.title}» — ${eventDate}`,
                    })}
                  >
                    <div className="ev-date"><div className="ev-day">{d.day}</div><div className="ev-mon">{d.mon}</div></div>
                    <div className="ev-info">
                      <div className="ev-title">{ev.title}</div>
                      <div className="ev-meta">{formatEventMeta(ev.date, ev.location, ev.isOnline)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <hr className="sep" />

        {/* HOW TO START — 4 шага старта */}
        <section id="how-to-start">
          <div className="sh sh-center"><div className="sh-tag">Старт</div><h2>Как начать сотрудничать с <em>ST Michael</em></h2><p className="sh-sub">Можно начать сотрудничество с первой сделки — даже с первого дня существования вашего ИП. Без дополнительных условий.</p></div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4, 1fr)',gap:16,maxWidth:1100,margin:'0 auto'}}>
            {[
              { n: '01', title: 'ИП или ООО', desc: 'Достаточно зарегистрированного юр. лица — ИП, ООО, АО.' },
              { n: '02', title: 'Регистрация в кабинете', desc: 'Заполните анкету за 2 минуты — становитесь партнёром сразу.' },
              { n: '03', title: 'Проверка клиента', desc: 'Зафиксируйте клиента в кабинете и получите статус уникальности.' },
              { n: '04', title: 'Запись на встречу', desc: 'Запишите клиента на встречу — горячая линия +7 (499) 226-22-49.' },
            ].map((s, i) => (
              <div key={i} style={{padding:'24px 22px',background:'var(--bg)',borderRadius:'var(--r-card)',boxShadow:'0 1px 2px rgba(0,0,0,0.04)'}}>
                <div style={{fontSize:32,fontWeight:200,color:'var(--gold)',marginBottom:12,lineHeight:1}}>{s.n}</div>
                <div style={{fontSize:15,fontWeight:600,marginBottom:6,color:'var(--black)'}}>{s.title}</div>
                <div style={{fontSize:13,color:'var(--muted)',lineHeight:1.6}}>{s.desc}</div>
              </div>
            ))}
          </div>
          <p style={{textAlign:'center',fontSize:13,color:'var(--muted)',marginTop:20,maxWidth:700,marginLeft:'auto',marginRight:'auto',lineHeight:1.7}}>
            Агентский договор заключается под конкретную сделку. Полные условия партнёрства — в кабинете брокера.
          </p>
          <div style={{textAlign:'center',marginTop:24}}>
            <button className="btn-gold" onClick={handleRegister}>Стать партнёром</button>
          </div>
        </section>

        {/* ADVANTAGES */}
        <section className="s-adv">
          <div className="adv-bg-glow" />
          <div className="sh"><div className="sh-tag">{advantages.tag}</div><h2>{renderAccent(advantages.title, advantages.titleAccent)}</h2>{advantages.subtitle && <p className="sh-sub" style={{color:'rgba(255,255,255,0.6)'}}>{advantages.subtitle}</p>}</div>
          <div className="adv-grid">
            {(advantages.items || []).map((it: any, i: number) => {
              const Icon = ADVANTAGE_ICONS[it.title];
              return (
                <Reveal key={i} delay={i * 80}>
                  <div className="adv-card">
                    {Icon && (
                      <div className="adv-icon" style={{ borderColor: 'rgba(180,147,111,0.3)' }}>
                        <Icon style={{ width: 20, height: 20, color: 'var(--gold)' }} />
                      </div>
                    )}
                    <div className="adv-title">{it.title}</div>
                    <div className="adv-desc">{it.description}</div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </section>

        <hr className="sep" />

        {/* DOCUMENTS — Все прозрачно */}
        <section id="cooperation" style={{background:'var(--bg)'}}>
          <div className="sh"><div className="sh-tag">Условия сотрудничества</div><h2>Всё прозрачно — <em>документы</em></h2><p className="sh-sub">Брокер может заранее ознакомиться с условиями партнёрства до регистрации</p></div>
          <div className="coop-grid">
            <div className="coop-left">
              <p>Мы рассматриваем сотрудничество с позиции «выиграл-выиграл». Все условия зафиксированы в документах и доступны в личном кабинете.</p>
              <button className="btn-gold" onClick={handleRegister}>Стать партнёром</button>
            </div>
            <div className="doc-list">
              {cooperationDocs.length === 0 ? (
                <div className="doc-item" style={{cursor:'default'}}>
                  <div className="doc-icon"><FileText style={{width:18,height:18,color:'var(--gold)'}} /></div>
                  <div className="doc-name" style={{color:'var(--muted)'}}>Скоро здесь появятся документы</div>
                </div>
              ) : (
                cooperationDocs.map((d: any) => (
                  <a key={d.id} href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="doc-item">
                    <div className="doc-icon"><FileText style={{width:18,height:18,color:'var(--gold)'}} /></div>
                    <div className="doc-name">{d.name}</div>
                    <div className="doc-dl"><DownloadIcon style={{width:16,height:16}} /></div>
                  </a>
                ))
              )}
            </div>
          </div>
        </section>

        {/* ANALYTICS — скрыт с лендинга по правке заказчика 2026-05-06.
            Блок появляется только если в /admin/documents (category=analytics)
            добавлены документы. Иначе секция не рендерится вообще. */}
        {analyticsDocs.length > 0 && (
          <>
            <hr className="sep" />
            <section id="analytics">
              <div className="sh"><div className="sh-tag">Аналитика</div><h2>Инструменты <em>инвестирования</em></h2><p className="sh-sub">Калькуляторы, презентации и аналитика для работы с клиентами-инвесторами</p></div>
              <div className="ads-grid" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                {analyticsDocs.map((d: any) => (
                  <a key={d.id} href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="doc-item">
                    <div className="doc-name">{d.name}</div>
                    <div className="doc-dl">&rarr;</div>
                  </a>
                ))}
              </div>
            </section>
          </>
        )}

        <hr className="sep" />

        {/* MARKETING — Материалы для продвижения.
            По правке Рената (2026-05-06): оформлено как сетка карточек
            с hover-выделением, как в advantages. Источник — Яндекс.Диск
            (sync-yandex-disk.js, category=materials), плюс fallback на
            старые marketing-документы (если есть). Группируется по подкатегории. */}
        <MaterialsSection materials={[...materialsDocs, ...marketingDocs]} />


        <hr className="sep" />

        {/* FAQ — Часто задаваемые вопросы */}
        <section id="faq">
          <div className="sh sh-center"><div className="sh-tag">Вопросы</div><h2>Часто задаваемые <em>вопросы</em></h2></div>
          <div style={{maxWidth:820,margin:'0 auto'}}>
            {[
              {
                q: 'Как стать партнёром?',
                a: 'Начать работу можно без заключения общего агентского договора. Достаточно зарегистрироваться в кабинете брокера, проверить клиента на уникальность и записать его на встречу. Агентский договор заключается под конкретную сделку. Для сотрудничества нужно зарегистрированное юр. лицо (ИП, ООО, АО).',
              },
              {
                q: 'Как проверить клиента на уникальность?',
                a: 'В личном кабинете во вкладке «Зафиксировать клиента» заполните данные и нажмите «Отправить». Получите статус «Условно уникален» (можно работать) или «Отклонён» (клиент уже в базе). Для дополнительных номеров (ЛПР, супруг, родители) используйте функцию «Дополнительные номера».',
              },
              {
                q: 'Что делать, если статус «Отклонён»?',
                a: 'Это значит клиент уже зарегистрирован другим брокером или обращался самостоятельно. Статус может быть изменён на «Условно уникален» после ручной проверки. Мы можем запросить подтверждение взаимодействия с клиентом (переписка, записи звонков, посещения офиса). Уведомление о решении придёт в WhatsApp / Telegram.',
              },
              {
                q: 'Какой срок действия фиксации?',
                a: 'Фиксация проходит в два этапа: до встречи с клиентом — 30 календарных дней, после встречи до сделки — ещё 30 дней. В обоих случаях возможна пролонгация по запросу через горячую линию +7 (499) 226-22-49. Брокер сам отслеживает сроки фиксации.',
              },
              {
                q: 'Как записать клиента на встречу?',
                a: 'Через горячую линию для брокеров: +7 (499) 226-22-49 (ежедневно с 9:00 до 21:00). Менеджер подберёт удобное время и проконсультирует по проектам. Клиент закрепляется за брокером после посещения офиса (или онлайн-встречи) и подписания акта осмотра.',
              },
              {
                q: 'Как происходит выплата комиссии?',
                a: 'Выплата производится после завершения сделки и полной оплаты со стороны клиента — в течение 7 рабочих дней. После сделки направьте информацию менеджеру — отправим инструкцию по получению выплаты.',
              },
            ].map((item, i) => (
              <FaqItem key={i} q={item.q} a={item.a} />
            ))}
          </div>
        </section>

        {/* COMMUNITY — Партнёрская программа */}
        <section className="s-comm">
          <div><div className="sh-tag">Партнёрская программа</div><h2><strong>ST MICHAEL</strong> Партнёры</h2></div>
          <div className="comm-content">
            <div>
              <p className="comm-desc">Сообщество, объединяющее активных профессионалов рынка недвижимости. Приоритетные условия и доступ к закрытым мероприятиям.</p>
              <button className="btn-white" onClick={handleRegister}>Стать частью сообщества</button>
            </div>
            <div className="comm-list">
              <div className="comm-list-item"><div className="comm-list-dot" />Специальные гибкие условия для участников</div>
              <div className="comm-list-item"><div className="comm-list-dot" />Приоритетное информирование о стартах продаж</div>
              <div className="comm-list-item"><div className="comm-list-dot" />Образовательные встречи и мастер-классы</div>
              <div className="comm-list-item"><div className="comm-list-dot" />Тематические мероприятия и нетворкинг</div>
              <div className="comm-list-item"><div className="comm-list-dot" />Самые свежие новости и события компании</div>
            </div>
          </div>
        </section>

        <hr className="sep" />

        {/* CONTACT — Всегда на связи */}
        <section id="contact">
          <div className="sh"><div className="sh-tag">{contact.tag}</div><h2>{renderAccent(contact.title, contact.titleAccent)}</h2></div>
          <div className="coop-grid" style={{alignItems:'stretch'}}>
            <div className="coop-left" style={{display:'flex',flexDirection:'column',gap:12}}>
              <p style={{marginBottom:0}}>{contact.description}</p>
              <div style={{padding:'18px 20px',background:'var(--bg)',borderRadius:'var(--r-card)',border:'1px solid var(--bw)'}}>
                <div style={{fontSize:11,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'var(--gold)',marginBottom:10}}>{contact.blockTitle}</div>
                {contact.phone && <div style={{fontSize:18,marginBottom:4,fontWeight:700}}><a href={`tel:${contact.phone.replace(/\D/g,'')}`} style={{color:'var(--black)'}}>{contact.phone}</a></div>}
                {contact.phoneHours && <div style={{fontSize:12,color:'var(--muted)',marginBottom:8}}>{contact.phoneHours}</div>}
                {contact.email && <div style={{fontSize:14,marginBottom:4}}><a href={`mailto:${contact.email}`} style={{color:'var(--black)'}}>{contact.email}</a></div>}
                {contact.telegram && <div style={{fontSize:14}}><a href={contact.telegram} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>Telegram-канал</a></div>}
              </div>

              {/* Персональные менеджеры — массив, поддерживает legacy одиночный manager */}
              {(() => {
                const list = Array.isArray(contact.managers) && contact.managers.length > 0
                  ? contact.managers
                  : (contact.manager ? [contact.manager] : []);
                if (list.length === 0) return null;
                return (
                  <div style={{display:'grid',gridTemplateColumns: list.length > 1 ? '1fr 1fr' : '1fr',gap:10}}>
                    {list.map((m: any, i: number) => (
                      <div key={i} style={{padding:'14px 16px',background:'var(--white)',borderRadius:'var(--r-card)',border:'1px solid var(--gold-border)'}}>
                        <div style={{fontSize:9,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'var(--muted)',marginBottom:6}}>Персональный контакт</div>
                        <div style={{fontSize:15,fontWeight:600,color:'var(--black)',marginBottom:2}}>{m.name}</div>
                        {m.role && <div style={{fontSize:11,color:'var(--muted)',marginBottom:6,lineHeight:1.5}}>{m.role}</div>}
                        {m.phone && <div style={{fontSize:13}}><a href={`tel:${m.phone.replace(/\D/g,'')}`} style={{color:'var(--black)',fontWeight:600}}>{m.phone}</a></div>}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div style={{padding:'32px 32px',background:'var(--bg)',borderRadius:'var(--r-card-lg)',border:'1px solid var(--bw)',display:'flex',flexDirection:'column',justifyContent:'center'}}>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'var(--gold)',marginBottom:14}}>Связаться с менеджером</div>
              <h3 style={{fontSize:24,fontWeight:200,marginBottom:14,lineHeight:1.2}}>Оставьте заявку — <strong style={{fontWeight:700}}>перезвоним за час</strong></h3>
              <p style={{fontSize:13,color:'var(--muted)',marginBottom:20,lineHeight:1.7}}>Менеджер партнёрской программы ответит на любые вопросы по проектам, фиксации клиентов и условиям комиссии.</p>
              <button className="btn-gold" style={{alignSelf:'flex-start'}} onClick={() => setContactModal({ open: true, source: 'landing-contact', title: 'Связаться с нами' })}>
                Оставить заявку
              </button>
            </div>
          </div>
        </section>

        {/* NEWS — упоминания / статьи (как у Stone). Скрыт если БД пуста. */}
        {news.length > 0 && (
          <>
            <hr className="sep" />
            <section id="news" style={{background:'var(--bg)'}}>
              <div className="sh" style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:24}}>
                <div>
                  <div className="sh-tag">СМИ о нас</div>
                  <h2>Новости</h2>
                </div>
                <a href="https://t.me/stmichaelBroker" target="_blank" rel="noopener noreferrer" className="btn-outline" style={{padding:'10px 24px',fontSize:10,marginBottom:4,whiteSpace:'nowrap'}}>
                  Все новости &rarr;
                </a>
              </div>
              <div className="news-grid">
                {news.slice(0, 6).map((n: any) => (
                  <a key={n.id} href={n.url} target="_blank" rel="noopener noreferrer" className="news-card">
                    {n.imageUrl && <div className="news-img" style={{backgroundImage:`url(${n.imageUrl})`}} />}
                    <div className="news-body">
                      {n.source && <div className="news-source">{n.source}</div>}
                      <div className="news-title">{n.title}</div>
                      <div className="news-meta">
                        {n.publishedAt && new Date(n.publishedAt).toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric'})}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </section>
          </>
        )}

        <hr className="sep" />

        {/* FINAL CTA */}
        <section className="s-cta">
          <div className="sh sh-center" style={{marginBottom:0}}><div className="sh-tag">Начните сегодня</div><h2>Присоединяйтесь к <em>партнёрской программе</em></h2><p className="sh-sub">Регистрация за 2 минуты. Личный кабинет, прозрачные условия, быстрые выплаты.</p></div>
          <div style={{display:'flex',justifyContent:'center',gap:12,flexWrap:'wrap',marginTop:36}}>
            <button className="btn-gold" onClick={handleRegister}>Стать партнёром</button>
            <button className="btn-outline" onClick={handleCabinet}>Войти в кабинет</button>
            <a href="https://t.me/stmichaelBroker" target="_blank" rel="noopener noreferrer" className="btn-outline">Telegram-канал</a>
          </div>
        </section>

        {/* FOOTER */}
        <footer>
          <div className="foot-grid">
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/stmichael-logo.png"
                alt="ST Michael"
                style={{ height: 28, width: 'auto', display: 'block', marginBottom: 8 }}
              />
              <div className="foot-logo-sub">Кабинет брокера</div>
            </div>
            <div><div className="foot-col-title">Условия</div><a className="foot-link" href="#cooperation">Условия сотрудничества</a><a className="foot-link" href="#events">Календарь событий</a><a className="foot-link" href="#commission">Комиссия</a></div>
            <div><div className="foot-col-title">Проекты</div>{projects.map((p: any) => (<span key={p.id} className="foot-link" onClick={() => handleProjectClick(p)} style={{cursor:'pointer'}}>{p.name}{p.subtitle ? ` ${p.subtitle}` : ''}</span>))}</div>
            <div><div className="foot-col-title">Партнёрам</div>{contact.phone && <a className="foot-link" href={`tel:${contact.phone.replace(/\D/g,'')}`}>{contact.phone}</a>}{contact.email && <a className="foot-link" href={`mailto:${contact.email}`}>{contact.email}</a>}{contact.telegram && <a className="foot-link" href={contact.telegram}>Telegram</a>}</div>
          </div>
          <div className="foot-bottom"><span>&copy; 2026 ST MICHAEL. Все права защищены.</span><span>Данные носят ориентировочный характер.</span></div>
        </footer>

        <button className="float-btn" onClick={()=>window.open('https://wa.me/74992262249','_blank')}>Связаться с нами</button>
      </div>

      {authModal && (
        <AuthModal
          mode={authModal}
          onClose={() => setAuthModal(null)}
          onSwitch={() => setAuthModal(authModal === 'login' ? 'register' : 'login')}
          onSuccess={() => { setAuthModal(null); router.push('/fixation'); }}
        />
      )}

      {quickFixOpen && <QuickFixModal onClose={() => setQuickFixOpen(false)} />}

      {calendarOpen && (
        <BrokerToursCalendarModal
          events={events}
          onClose={() => setCalendarOpen(false)}
        />
      )}

      {contactModal.open && (
        <ContactFormModal
          onClose={() => setContactModal({ open: false })}
          source={contactModal.source}
          eventId={contactModal.eventId}
          title={contactModal.title}
          defaultMessage={contactModal.defaultMessage}
        />
      )}
    </>
  );
}
