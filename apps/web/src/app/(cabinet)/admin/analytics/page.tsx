'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { BarChart3, TrendingUp, Users, DollarSign, Building, Trophy } from 'lucide-react';

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный Бор',
};

const dealStatusLabels: Record<string, string> = {
  PENDING: 'В работе',
  SIGNED: 'Договор подписан',
  PAID: 'Клиент оплатил',
  COMMISSION_PAID: 'Комиссия выплачена',
  CANCELLED: 'Отменена',
};

const stageLabels: Record<string, string> = {
  NEW_BROKER: 'Новый брокер',
  BROKER_TOUR: 'Брокер-тур',
  FIXATION: 'Фиксация',
  MEETING: 'Встреча',
  DEAL: 'Сделка',
};

interface Overview {
  period: { from: string; to: string };
  brokers: {
    total: number;
    active: number;
    blocked: number;
    newInPeriod: number;
    registrationTrend: Array<{ date: string; count: number }>;
    funnelByStage: Array<{ stage: string; count: number }>;
  };
  fixations: {
    total: number;
    conditionallyUnique: number;
    rejected: number;
    underReview: number;
    expired: number;
    uniqueRatio: number;
  };
  deals: { funnel: Array<{ status: string; count: number; totalAmount: number; totalCommission: number }> };
  topBrokers: Array<{ brokerId: string; fullName: string; phone: string; dealsCount: number; totalAmount: number; totalCommission: number }>;
  brokerTourFunnel: {
    tourVisited: number;
    withFixation: number;
    withDeal: number;
    toFixationPct: number;
    toDealPct: number;
  };
  topFixationBrokers: Array<{ brokerId: string; fullName: string; phone: string; uniqueFixations: number }>;
  bySource: Array<{ source: string; count: number }>;
  projects: Array<{ project: string; totalDeals: number; paidDeals: number; totalAmount: number; totalCommission: number; totalSqm: number }>;
}

// 2026-07-08: подписи источников для нового блока «Аналитика по источникам».
const sourceLabels: Record<string, string> = {
  CRM_MANUAL: 'Внесён вручную',
  BROKER_CABINET: 'Регистрация через кабинет',
  PHONE_CALL: 'Позвонил на линию',
  LANDING_BROKER_TOUR: 'Лендинг: брокер-тур',
  LANDING_FORM: 'Лендинг: форма',
  CLOSED_AS_BROKER: 'Закрыт как брокер',
};

function fmtRub(n: number) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

export default function AdminAnalyticsPage() {
  const { broker } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const applyPreset = (preset: 'today' | 'week' | 'month' | 'quarter' | 'year' | 'ytd' | 'all') => {
    const now = new Date();
    const toStr = now.toISOString().slice(0, 10);
    const back = (days: number) => {
      const d = new Date(); d.setDate(d.getDate() - days);
      return d.toISOString().slice(0, 10);
    };
    if (preset === 'today') { setFrom(toStr); setTo(toStr); }
    else if (preset === 'week') { setFrom(back(7)); setTo(toStr); }
    else if (preset === 'month') { setFrom(back(30)); setTo(toStr); }
    else if (preset === 'quarter') { setFrom(back(90)); setTo(toStr); }
    else if (preset === 'year') { setFrom(back(365)); setTo(toStr); }
    else if (preset === 'ytd') {
      setFrom(`${now.getFullYear()}-01-01`);
      setTo(toStr);
    } else if (preset === 'all') {
      setFrom('2020-01-01'); setTo(toStr);
    }
  };

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  useEffect(() => {
    setLoading(true);
    apiGet<Overview>(`/analytics/admin/overview?startDate=${from}T00:00:00.000Z&endDate=${to}T23:59:59.999Z`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [from, to]);

  const maxTrend = data ? Math.max(1, ...data.brokers.registrationTrend.map((p) => p.count)) : 1;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between mb-2 gap-3">
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <BarChart3 className="w-7 h-7 text-accent" /> Аналитика платформы
        </h1>
        <div className="flex items-center gap-2">
          <input className="input w-auto text-sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-text-muted">—</span>
          <input className="input w-auto text-sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mb-6 text-sm">
        <button className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('today')}>Сегодня</button>
        <button className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('week')}>Неделя</button>
        <button className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('month')}>Месяц</button>
        <button className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('quarter')}>Квартал</button>
        <button className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('year')}>Год</button>
        <button className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('ytd')}>С начала года</button>
        <button className="px-3 py-1 rounded border border-border hover:bg-surface-secondary" onClick={() => applyPreset('all')}>За всё время</button>
      </div>

      {loading && <div className="text-text-muted">Загрузка…</div>}
      {!loading && !data && <div className="text-error">Не удалось загрузить</div>}

      {data && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <KpiCard icon={Users} label="Всего брокеров" value={data.brokers.total} hint={`${data.brokers.active} активных, ${data.brokers.blocked} заблок.`} />
            <KpiCard icon={TrendingUp} label="Новых за период" value={data.brokers.newInPeriod} hint="регистрации" />
            <KpiCard icon={Building} label="Фиксаций" value={data.fixations.total} hint={`${data.fixations.uniqueRatio}% уникальных`} />
            <KpiCard
              icon={DollarSign}
              label="Комиссия выплачена"
              value={fmtRub(data.deals.funnel.find((d) => d.status === 'COMMISSION_PAID')?.totalCommission || 0)}
              hint="за всё время"
              isString
            />
          </div>

          {/* Registration trend */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4">Динамика регистраций</h2>
            {data.brokers.registrationTrend.length === 0 ? (
              <div className="text-text-muted text-sm">Нет регистраций в выбранном периоде</div>
            ) : (
              <div className="space-y-1">
                {data.brokers.registrationTrend.slice(-30).map((p) => (
                  <div key={p.date} className="flex items-center gap-3 text-sm">
                    <div className="w-24 text-text-muted text-xs">
                      {new Date(p.date).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })}
                    </div>
                    <div className="flex-1 bg-surface-secondary rounded-full h-3 overflow-hidden">
                      <div className="bg-accent h-full transition-all" style={{ width: `${(p.count / maxTrend) * 100}%` }} />
                    </div>
                    <div className="w-8 text-right font-medium">{p.count}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Fixations */}
            <div className="card">
              <h2 className="text-lg font-semibold mb-4">Фиксации: уникальные vs не уникальные</h2>
              <div className="space-y-3">
                <FixationRow label="✅ Уникальные" count={data.fixations.conditionallyUnique} total={data.fixations.total} color="bg-success" />
                <FixationRow label="⚠️ На проверке" count={data.fixations.underReview} total={data.fixations.total} color="bg-warning" />
                <FixationRow label="❌ Отклонены" count={data.fixations.rejected} total={data.fixations.total} color="bg-error" />
                <FixationRow label="⏰ Истекли" count={data.fixations.expired} total={data.fixations.total} color="bg-text-muted" />
              </div>
            </div>

            {/* Deals funnel */}
            <div className="card">
              <h2 className="text-lg font-semibold mb-4">Воронка сделок</h2>
              <div className="space-y-3">
                {data.deals.funnel.map((d) => {
                  const total = data.deals.funnel.reduce((s, x) => s + x.count, 0);
                  const pct = total > 0 ? Math.round((d.count / total) * 100) : 0;
                  return (
                    <div key={d.status}>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{dealStatusLabels[d.status] || d.status}</span>
                        <span className="text-text-muted">{d.count} · {pct}%</span>
                      </div>
                      <div className="bg-surface-secondary rounded-full h-2">
                        <div className="bg-accent h-full rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Broker funnel */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4">Воронка брокеров (этапы)</h2>
            <div className="space-y-2">
              {data.brokers.funnelByStage.map((f) => {
                const total = data.brokers.funnelByStage.reduce((s, x) => s + x.count, 0);
                const pct = total > 0 ? Math.round((f.count / total) * 100) : 0;
                return (
                  <div key={f.stage}>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{stageLabels[f.stage] || f.stage}</span>
                      <span className="text-text-muted">{f.count}</span>
                    </div>
                    <div className="bg-surface-secondary rounded-full h-2">
                      <div className="bg-info h-full rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2026-07-08: Аналитика по источникам брокеров.
              Broker.source в БД был, но в UI не показывался. Показывает
              эффективность каналов привлечения — лендинг vs холодный
              обзвон vs брокер-туры. */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Users className="w-5 h-5 text-accent" /> Новые брокеры по источникам
            </h2>
            {(!data.bySource || data.bySource.length === 0) ? (
              <div className="text-text-muted text-sm">В выбранном периоде нет новых брокеров с указанным источником</div>
            ) : (
              <div className="space-y-2">
                {(() => {
                  const maxCount = Math.max(...data.bySource.map((s) => s.count), 1);
                  return data.bySource.map((s) => (
                    <div key={s.source}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span>{sourceLabels[s.source] || s.source}</span>
                        <span className="font-bold text-accent">{s.count}</span>
                      </div>
                      <div className="w-full bg-surface-secondary rounded-full h-2">
                        <div
                          className="bg-accent rounded-full h-2"
                          style={{ width: `${Math.round((s.count / maxCount) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>

          {/* 2026-07-07: Сквозная воронка брокер-туров.
              Показывает, сколько брокеров, посетивших тур в выбранном
              периоде, потом сделали уникальную фиксацию и довели её до
              оплаченной сделки. Считается по Broker.brokerTourDate. */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-accent" /> Сквозная воронка: Брокер-тур → Фиксация → Сделка
            </h2>
            {data.brokerTourFunnel.tourVisited === 0 ? (
              <div className="text-text-muted text-sm">Нет брокеров, посетивших тур в выбранном периоде</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-lg bg-surface-secondary p-4">
                  <div className="text-sm text-text-muted mb-1">Посетили брокер-тур</div>
                  <div className="text-3xl font-bold">{data.brokerTourFunnel.tourVisited}</div>
                  <div className="text-xs text-text-muted mt-1">за выбранный период</div>
                </div>
                <div className="rounded-lg bg-surface-secondary p-4">
                  <div className="text-sm text-text-muted mb-1">Сделали уникальную фиксацию</div>
                  <div className="text-3xl font-bold">{data.brokerTourFunnel.withFixation}</div>
                  <div className="text-xs text-accent mt-1">{data.brokerTourFunnel.toFixationPct}% от тех, кто был на туре</div>
                </div>
                <div className="rounded-lg bg-surface-secondary p-4">
                  <div className="text-sm text-text-muted mb-1">Довели до оплаченной сделки</div>
                  <div className="text-3xl font-bold">{data.brokerTourFunnel.withDeal}</div>
                  <div className="text-xs text-accent mt-1">{data.brokerTourFunnel.toDealPct}% от тех, кто был на туре</div>
                </div>
              </div>
            )}
          </div>

          {/* 2026-07-07: Топ-10 по уникальным фиксациям — параллельно
              с топом по комиссии. Показывает, кто приносит фиксации,
              даже если сделки ещё не закрыты. */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Trophy className="w-5 h-5 text-accent" /> Топ-10 брокеров по уникальным фиксациям
            </h2>
            {data.topFixationBrokers.length === 0 ? (
              <div className="text-text-muted text-sm">Нет уникальных фиксаций в периоде</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-text-muted">
                      <th className="py-2 pr-2">#</th>
                      <th className="py-2 pr-2">Брокер</th>
                      <th className="py-2 pl-2 text-right">Уникальных фиксаций</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topFixationBrokers.map((b, i) => (
                      <tr key={b.brokerId} className="border-b border-border last:border-0">
                        <td className="py-2 pr-2 text-text-muted">{i + 1}</td>
                        <td className="py-2 pr-2">
                          <div className="font-medium">{b.fullName}</div>
                          <div className="text-xs text-text-muted">{b.phone}</div>
                        </td>
                        <td className="py-2 pl-2 text-right text-accent font-bold">{b.uniqueFixations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Top brokers */}
          <div className="card mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Trophy className="w-5 h-5 text-accent" /> Топ-10 брокеров (по комиссии)
            </h2>
            {data.topBrokers.length === 0 ? (
              <div className="text-text-muted text-sm">Нет оплаченных сделок в периоде</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-text-muted">
                      <th className="py-2 pr-2">#</th>
                      <th className="py-2 pr-2">Брокер</th>
                      <th className="py-2 px-2 text-right">Сделок</th>
                      <th className="py-2 px-2 text-right">Сумма сделок</th>
                      <th className="py-2 pl-2 text-right">Комиссия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topBrokers.map((b, i) => (
                      <tr key={b.brokerId} className="border-b border-border last:border-0">
                        <td className="py-2 pr-2 text-text-muted">{i + 1}</td>
                        <td className="py-2 pr-2">
                          <div className="font-medium">{b.fullName}</div>
                          <div className="text-xs text-text-muted">{b.phone}</div>
                        </td>
                        <td className="py-2 px-2 text-right">{b.dealsCount}</td>
                        <td className="py-2 px-2 text-right">{fmtRub(b.totalAmount)}</td>
                        <td className="py-2 pl-2 text-right text-accent font-bold">{fmtRub(b.totalCommission)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Per-project */}
          <div className="card">
            <h2 className="text-lg font-semibold mb-4">Статистика по проектам</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.projects.map((p) => (
                <div key={p.project} className="p-4 bg-surface-secondary rounded-lg">
                  <h3 className="font-semibold mb-3">{projectLabels[p.project] || p.project}</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <Stat label="Всего сделок" value={p.totalDeals} />
                    <Stat label="Оплачено" value={p.paidDeals} />
                    <Stat label="Метраж продан" value={`${Math.round(p.totalSqm)} м²`} />
                    <Stat label="Сумма продаж" value={fmtRub(p.totalAmount)} />
                    <Stat label="Комиссия" value={fmtRub(p.totalCommission)} highlight />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, hint, isString }: { icon: any; label: string; value: any; hint?: string; isString?: boolean }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span className="text-text-muted text-sm">{label}</span>
        <Icon className="w-5 h-5 text-accent" />
      </div>
      <div className={`font-bold ${isString ? 'text-xl' : 'text-2xl'}`}>{value}</div>
      {hint && <div className="text-xs text-text-muted mt-1">{hint}</div>}
    </div>
  );
}

function FixationRow({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span>{label}</span>
        <span className="text-text-muted">{count} · {pct}%</span>
      </div>
      <div className="bg-surface-secondary rounded-full h-2">
        <div className={`${color} h-full rounded-full`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: any; highlight?: boolean }) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`font-medium ${highlight ? 'text-accent text-lg' : ''}`}>{value}</div>
    </div>
  );
}
