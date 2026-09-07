'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import {
  ActiveCommissionPolicy,
  buildPaymentTermsText,
  resolveCommissionText,
} from '@/lib/commission-display';
import { TrendingUp, Wallet, Award, CreditCard, Building2 } from 'lucide-react';

const levelNames: Record<string, string> = {
  START: 'Старт',
  BASIC: 'Базовый',
  STRONG: 'Продвинутый',
  PREMIUM: 'Премиум',
  ELITE: 'Элит',
  CHAMPION: 'Чемпион',
  LEGEND: 'Легенда',
};

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный бор',
};

const statusLabels: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'В работе', cls: 'bg-warning/20 text-warning' },
  SIGNED: { label: 'Договор подписан', cls: 'bg-info/20 text-info' },
  PAID: { label: 'Клиент оплатил', cls: 'bg-success/20 text-success' },
  COMMISSION_PAID: { label: 'Комиссия выплачена', cls: 'bg-accent/20 text-accent' },
  CANCELLED: { label: 'Отменена', cls: 'bg-error/20 text-error' },
};

// 2026-07-01: карточки условий комиссии теперь тянутся из CMS
// (commission.cards в /admin/content → «Комиссия»). Если админ не наполнил CMS
// или запрос упал — используется этот fallback. Иконки/цвета выбираются по
// индексу карточки из палитры ниже.
const FALLBACK_COMMISSION_CARDS = [
  { title: 'Условия выплаты', text: 'Вознаграждение выплачивается после оплаты клиентом в срок, установленный агентским договором.' },
  { title: 'Квартальный бонус', text: 'При уровне Strong и выше несколько кварталов подряд: +0,1% — +0,15% — +0,2% — +0,25% (максимум). Обнуляется при отсутствии продаж в квартале.' },
  { title: 'Коммерческие помещения', text: 'Продажа — 3%. Фитнес — 3%. Отдельные здания — 2%. Аренда ритейл — 100% месячного платежа. Аренда фитнес — 50%.' },
];

// Tailwind не поддерживает динамические классы вида `bg-${color}/10` — все
// строки должны быть статическими, иначе JIT их не подхватит и стиль пропадёт.
const CARD_PALETTE = [
  { Icon: Wallet,     bg: 'bg-success/10', text: 'text-success', title: 'text-success' },
  { Icon: Award,      bg: 'bg-accent/10',  text: 'text-accent',  title: 'text-accent' },
  { Icon: CreditCard, bg: 'bg-info/10',    text: 'text-info',    title: 'text-info' },
  { Icon: Building2,  bg: 'bg-warning/10', text: 'text-warning', title: 'text-warning' },
  { Icon: TrendingUp, bg: 'bg-accent/10',  text: 'text-accent',  title: 'text-accent' },
];

export default function CommissionPage() {
  const [commission, setCommission] = useState<any>(null);
  const [deals, setDeals] = useState<any[]>([]);
  const [selectedProject, setSelectedProject] = useState<'ZORGE9' | 'SILVER_BOR'>('ZORGE9');
  const [calcResult, setCalcResult] = useState<any>(null);
  const [calcForm, setCalcForm] = useState<{ amount: string; project: string; paymentMode: 'FULL' | 'INSTALLMENT' | 'SUBSIDIZED_MORTGAGE' }>({
    amount: '',
    project: 'ZORGE9',
    paymentMode: 'FULL',
  });
  const [calcError, setCalcError] = useState('');
  // 2026-07-02/03: держим сырой CMS-value; параметры калькулятора и
  // карточки условий вычисляются ниже по selectedProject.
  const [cmsCommission, setCmsCommission] = useState<any>({});

  useEffect(() => {
    apiGet('/commission/my').then(setCommission).catch(() => {});
    apiGet('/commission/deals').then(setDeals).catch(() => {});
    apiGet('/public/cms/content/commission')
      .then((res: any) => setCmsCommission(res?.value || {}))
      .catch(() => {});
  }, []);

  const selectedPaymentTerms = commission?.paymentTerms?.[selectedProject];
  const calculatorPaymentTerms = commission?.paymentTerms?.[calcForm.project];
  const activeDisplayPolicies = useMemo<ActiveCommissionPolicy[]>(() => {
    if (!commission) return [];
    return (['ZORGE9', 'SILVER_BOR'] as const).map((project) => ({
      project,
      mode: commission?.modes?.[project] === 'FLAT' ? 'FLAT' : 'PROGRESSIVE',
      flatRate: commission?.flatRates?.[project],
      levels: commission?.scales?.[project],
      displayNote: commission?.displayNotes?.[project],
      ...commission?.paymentTerms?.[project],
    }));
  }, [commission]);

  // Редакционные карточки остаются в CMS, но числовая карточка условий оплаты
  // всегда генерируется ниже из активной CommissionPolicy.
  const termsCards = useMemo<Array<{ title: string; text: string }>>(() => {
    const byProject = cmsCommission?.cardsByProject?.[selectedProject];
    const source = Array.isArray(byProject)
      ? byProject
      : (Array.isArray(cmsCommission?.cards) && cmsCommission.cards.length > 0
          ? cmsCommission.cards
          : FALLBACK_COMMISSION_CARDS);
    const editorial = source
      .filter((c: any) =>
        c
        && (c.title || c.text)
        && !/рассроч|ипотек/i.test(String(c.title || '')),
      )
      .map((c: any) => ({
        title: resolveCommissionText(String(c.title || ''), activeDisplayPolicies, selectedProject),
        text: resolveCommissionText(String(c.text || ''), activeDisplayPolicies, selectedProject),
      }));
    if (!selectedPaymentTerms) return editorial;
    const paymentText = buildPaymentTermsText(selectedPaymentTerms);
    if (paymentText) {
      editorial.push({ title: 'Рассрочка и ипотека', text: paymentText });
    }
    return editorial;
  }, [activeDisplayPolicies, cmsCommission, selectedProject, selectedPaymentTerms]);

  const installmentEnabled = calculatorPaymentTerms?.installmentEnabled !== false;
  const subsidizedMortgageEnabled = calculatorPaymentTerms?.subsidizedMortgageEnabled !== false;

  const projectDeals = useMemo(
    () => deals.filter((d) => d.project === selectedProject),
    [deals, selectedProject],
  );

  const projectEarned = useMemo(
    () =>
      projectDeals
        .filter((d) => d.status === 'PAID' || d.status === 'COMMISSION_PAID')
        .reduce((sum, d) => sum + Number(d.commission || 0), 0),
    [projectDeals],
  );

  // Ставка и шкала приходят только из API, который читает активную политику.
  const currentProjectState = commission?.byProject?.[selectedProject] || {
    level: commission?.level,
    progress: commission?.progress,
    nextLevel: commission?.nextLevel,
    nextLevelSqm: commission?.nextLevelSqm,
    totalSqmSold: commission?.totalSqmSold,
  };
  const currentRate = commission?.rates?.[selectedProject] ?? null;
  const currentRateLabel = currentRate == null ? '—' : `${String(currentRate).replace('.', ',')}%`;
  const currentMode = commission?.modes?.[selectedProject];
  const isFlat = currentMode === 'FLAT';
  const currentDisplayNote = commission?.displayNotes?.[selectedProject]
    ? resolveCommissionText(
        commission.displayNotes[selectedProject],
        activeDisplayPolicies,
        selectedProject,
      )
    : null;

  const currentScale: Array<{ level: string; minSqm: number; rate: number }> =
    commission?.scales?.[selectedProject] ?? [];

  const handleCalculate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCalcError('');
    const amountNum = Number(calcForm.amount);
    if (!amountNum || amountNum <= 0) {
      setCalcError('Введите сумму сделки');
      return;
    }
    try {
      const result = await apiPost('/commission/calculate', {
        amount: amountNum,
        project: calcForm.project,
        paymentMode: calcForm.paymentMode,
      });
      setCalcResult(result);
    } catch (err: any) {
      setCalcError(err?.message || 'Ошибка расчёта');
    }
  };

  return (
    <div>
      {/* Переключатель Зорге/Сер.Бор слева сверху, заголовок ниже. Правка 2026-05-14. */}
      <div className="mb-6">
        <div className="inline-flex bg-surface-secondary rounded-lg p-1 mb-3">
          {(Object.keys(projectLabels) as Array<'ZORGE9' | 'SILVER_BOR'>).map((p) => (
            <button
              key={p}
              onClick={() => {
                setSelectedProject(p);
                setCalcForm((current) => ({ ...current, project: p, paymentMode: 'FULL' }));
                setCalcResult(null);
              }}
              className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                selectedProject === p ? 'bg-accent text-white' : 'text-text-muted hover:text-text'
              }`}
            >
              {projectLabels[p]}
            </button>
          ))}
        </div>
        <h1 className="text-2xl md:text-3xl font-bold">Комиссия</h1>
      </div>

      {commission && !isFlat && (
        <h2 className="text-lg font-semibold mb-3 text-text-muted">Прогрессивная комиссия</h2>
      )}

      {commission && currentDisplayNote && (
        <div className="mb-4 rounded-lg border border-accent/20 bg-accent/10 px-4 py-3 text-sm text-text-muted">
          {currentDisplayNote}
        </div>
      )}

      {commission && (
        <div className={`grid grid-cols-1 gap-6 mb-8 ${isFlat ? 'md:grid-cols-2' : 'md:grid-cols-3'}`}>
          <div className="card" data-tour="commission-card">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm text-text-muted">
                {isFlat ? 'Текущая ставка' : 'Текущий уровень'}
              </h3>
              <TrendingUp className="w-5 h-5 text-accent" />
            </div>
            {isFlat ? (
              <>
                <p className="text-4xl font-bold text-accent">{currentRateLabel}</p>
                <p className="text-sm text-text-muted mt-1">
                  Фиксированная ставка по {projectLabels[selectedProject]}
                </p>
              </>
            ) : (
              <>
                <p className="text-2xl font-bold text-accent">
                  {levelNames[currentProjectState.level] || currentProjectState.level}
                </p>
                <p className="text-sm text-text-muted mt-1">
                  Ставка {projectLabels[selectedProject]}: <span className="text-accent font-bold">{currentRateLabel}</span>
                </p>
                {currentProjectState.nextLevel && (
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-text-muted mb-1">
                      <span>Прогресс до {levelNames[currentProjectState.nextLevel]}</span>
                      <span>{currentProjectState.progress}%</span>
                    </div>
                    <div className="w-full bg-surface-secondary rounded-full h-2">
                      <div
                        className="bg-accent rounded-full h-2 transition-all"
                        style={{ width: `${currentProjectState.progress}%` }}
                      />
                    </div>
                    <p className="text-xs text-text-muted mt-1">
                      {currentProjectState.totalSqmSold} / {currentProjectState.nextLevelSqm} м²
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="card">
            <h3 className="text-sm text-text-muted mb-2">Заработано по проекту</h3>
            <p className="text-2xl font-bold text-accent">
              {Math.round(projectEarned).toLocaleString('ru-RU')} ₽
            </p>
            <p className="text-xs text-text-muted mt-1">{projectLabels[selectedProject]}</p>
            {commission.quarterlyBonusStreak > 0 && (
              <p className="text-xs text-success mt-2">
                Бонусная серия: {commission.quarterlyBonusStreak} кв.
              </p>
            )}
          </div>

          {!isFlat && (
            <div className="card">
              <h3 className="text-sm text-text-muted mb-2">Шкала ставок — {projectLabels[selectedProject]}</h3>
              <div className="space-y-1">
                {/* Шкала приходит из активной политики в /admin/commission-policies. */}
                {currentScale.map((s) => {
                  const active = s.level === currentProjectState.level;
                  return (
                    <div
                      key={s.level}
                      className={`flex items-center justify-between text-sm py-2 px-3 rounded transition-all ${
                        active
                          ? 'bg-accent/20 text-accent font-bold border-l-4 border-accent ring-1 ring-accent/30'
                          : 'border-l-4 border-transparent'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {active && <span aria-hidden>▶</span>}
                        {levelNames[s.level] || s.level}
                        {active && <span className="text-[10px] uppercase tracking-wide opacity-80">← вы здесь</span>}
                      </span>
                      <span>{s.rate}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Условия комиссии — тянутся из CMS (см. useEffect выше). Админ правит в /admin/content → «Комиссия» → Карточки условий. */}
      {termsCards.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {termsCards.map((card, i) => {
            const palette = CARD_PALETTE[i % CARD_PALETTE.length];
            const { Icon } = palette;
            return (
              <div key={i} className="card">
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-lg ${palette.bg} flex items-center justify-center flex-shrink-0`}>
                    <Icon className={`w-5 h-5 ${palette.text}`} />
                  </div>
                  <div className="flex-1">
                    <div className={`text-xs font-bold uppercase tracking-wider ${palette.title} mb-1`}>{card.title}</div>
                    <p className="text-sm text-text-muted leading-relaxed whitespace-pre-line">{card.text}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Калькулятор комиссии</h3>
          <form onSubmit={handleCalculate} className="space-y-4">
            <div>
              <label className="label">Сумма сделки (₽)</label>
              {/* КБ6: форматируем поле с пробелами между разрядами тысяч.
                  Реальное число хранится в state как digits-only-строка. */}
              <input
                type="text"
                inputMode="numeric"
                className="input"
                placeholder="10 000 000"
                value={calcForm.amount ? calcForm.amount.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : ''}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, '');
                  setCalcForm({ ...calcForm, amount: digits });
                }}
                required
              />
            </div>
            <div>
              <label className="label">Проект</label>
              <select
                className="input"
                value={calcForm.project}
                onChange={(e) => {
                  setCalcForm({ ...calcForm, project: e.target.value, paymentMode: 'FULL' });
                  setCalcResult(null);
                }}
              >
                <option value="ZORGE9">Зорге 9</option>
                <option value="SILVER_BOR">Серебряный бор</option>
              </select>
            </div>
            <div>
              <label className="label">Тип оплаты</label>
              <div className="grid grid-cols-1 gap-2">
                {([
                  { value: 'FULL',                 label: 'Полная оплата',           enabled: true },
                  { value: 'INSTALLMENT',          label: 'Рассрочка',                enabled: installmentEnabled },
                  { value: 'SUBSIDIZED_MORTGAGE',  label: 'Субсидированная ипотека',  enabled: subsidizedMortgageEnabled },
                ] as const).filter((opt) => opt.enabled).map((opt) => (
                  <label
                    key={opt.value}
                    className={`cursor-pointer text-sm py-2 px-3 rounded-lg border transition ${
                      calcForm.paymentMode === opt.value ? 'border-accent bg-accent/10 text-accent' : 'border-border hover:bg-surface-secondary'
                    }`}
                  >
                    <input
                      type="radio"
                      name="paymentMode"
                      value={opt.value}
                      checked={calcForm.paymentMode === opt.value}
                      onChange={() => setCalcForm({ ...calcForm, paymentMode: opt.value })}
                      className="hidden"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
            {calcError && (
              <div className="p-2 bg-error/10 text-error rounded text-sm">{calcError}</div>
            )}
            <button type="submit" className="btn btn-primary w-full">Рассчитать</button>
          </form>

          {calcResult && (
            <div className="mt-4 p-4 bg-surface-secondary rounded-lg">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-text-muted">Сумма:</span>
                <span>{Math.round(Number(calcResult.amount)).toLocaleString('ru-RU')} ₽</span>
              </div>
              {calcResult.level && calcResult.mode !== 'FLAT' && calcResult.paymentMode !== 'SUBSIDIZED_MORTGAGE' && (
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-text-muted">Уровень:</span>
                  <span>{levelNames[calcResult.level] || calcResult.level}</span>
                </div>
              )}
              <div className="flex justify-between text-sm mb-2">
                <span className="text-text-muted">Ставка:</span>
                <span>{calcResult.rate}%</span>
              </div>
              {calcResult.paymentMode === 'INSTALLMENT' && (
                <div className="flex justify-between text-xs mb-2 text-text-muted">
                  <span>Рассрочка:</span>
                  <span>−{calcResult.installmentDiscount}%</span>
                </div>
              )}
              {calcResult.paymentMode === 'SUBSIDIZED_MORTGAGE' && (
                <div className="flex justify-between text-xs mb-2 text-text-muted">
                  <span>Субс. ипотека:</span>
                  <span>фиксированные {calcResult.subsidizedMortgageRate}%</span>
                </div>
              )}
              <div className="flex justify-between text-lg font-bold border-t border-border pt-2 mt-2">
                <span>Комиссия:</span>
                <span className="text-accent">{Math.round(Number(calcResult.commission)).toLocaleString('ru-RU')} ₽</span>
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-4">
            История комиссий — {projectLabels[selectedProject]}
          </h3>
          {projectDeals.length === 0 ? (
            <p className="text-text-muted">Нет сделок по этому проекту</p>
          ) : (
            <div className="space-y-3">
              {projectDeals.map((deal: any) => (
                <div key={deal.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div>
                    <div className="font-medium text-sm">{deal.clientName}</div>
                    <div className="text-xs text-text-muted">
                      {projectLabels[deal.project] || deal.project} · {deal.rate}%
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-accent">
                      {Math.round(Number(deal.commission)).toLocaleString('ru-RU')} ₽
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded inline-block mt-1 ${statusLabels[deal.status]?.cls || 'text-text-muted'}`}>
                      {statusLabels[deal.status]?.label || deal.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
