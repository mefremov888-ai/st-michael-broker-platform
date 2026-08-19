'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { ChevronLeft, ChevronRight, HeartHandshake, TrendingUp, Wallet } from 'lucide-react';

const statusLabels: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'В работе', cls: 'bg-warning/20 text-warning' },
  SIGNED: { label: 'Договор подписан', cls: 'bg-info/20 text-info' },
  PAID: { label: 'Клиент оплатил', cls: 'bg-success/20 text-success' },
  COMMISSION_PAID: { label: 'Комиссия выплачена', cls: 'bg-accent/20 text-accent' },
  CANCELLED: { label: 'Отменён', cls: 'bg-error/20 text-error' },
};

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный Бор',
};

// Форматирование телефона +7 (XXX) XXX-XX-XX (правка 2026-05-13).
function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  let d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && !d.startsWith('7')) d = '7' + d.slice(1);
  if (d.length !== 11) return phone;
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`;
}

interface DealsSummary {
  total: number;
  totalAmount: number;
  totalCommission: number;
  payable: number;
}

export default function DealsPage() {
  const [deals, setDeals] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<DealsSummary>({ total: 0, totalAmount: 0, totalCommission: 0, payable: 0 });

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '15' });
    if (statusFilter) params.set('status', statusFilter);
    apiGet(`/deals?${params}`)
      .then((data) => {
        setDeals(data.deals || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      })
      .catch(() => setDeals([]))
      .finally(() => setLoading(false));
  }, [page, statusFilter]);

  // KPI-сводка по ВСЕМ сделкам — теперь через специальный endpoint,
  // не limit=100 (правка #2 из аудита 2026-05-22: у активного брокера
  // с >100 сделок цифра была искажена).
  useEffect(() => {
    apiGet('/deals/summary')
      .then((s: any) => {
        setSummary({
          total: Number(s.total || 0),
          totalAmount: Number(s.totalAmount || 0),
          totalCommission: Number(s.totalCommission || 0),
          payable: Number(s.paidCommission || 0),
        });
      })
      .catch(() => {});
  }, []);

  const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU') + ' ₽';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Сделки</h1>
        <span className="text-text-muted text-sm">Всего: {total}</span>
      </div>

      {/* Summary KPIs (ТЗ §5 — сводные показатели) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6" data-tour="deals-summary">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-text-muted">Всего сделок</span>
            <HeartHandshake className="w-5 h-5 text-accent" />
          </div>
          <div className="text-2xl font-bold">{summary.total}</div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-text-muted">Общая сумма сделок</span>
            {/* Bug fix 2026-06-02: была иконка DollarSign ($). Lucide 0.294
                не имеет RussianRuble — используем текстовый символ ₽. */}
            <span className="w-5 h-5 text-accent text-xl font-bold leading-none flex items-center justify-center">₽</span>
          </div>
          <div className="text-xl font-bold">{fmt(summary.totalAmount)}</div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-text-muted">Начисленная комиссия</span>
            <TrendingUp className="w-5 h-5 text-accent" />
          </div>
          <div className="text-xl font-bold text-accent">{fmt(summary.totalCommission)}</div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-text-muted">К выплате</span>
            <Wallet className="w-5 h-5 text-accent" />
          </div>
          <div className="text-xl font-bold text-success">{fmt(summary.payable)}</div>
        </div>
      </div>

      <div className="card mb-6">
        <select
          className="input w-auto"
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
        >
          <option value="">Все сделки</option>
          <option value="SIGNED">Договор подписан</option>
          <option value="PAID">Клиент оплатил</option>
          <option value="COMMISSION_PAID">Комиссия выплачена</option>
        </select>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : deals.length === 0 ? (
          <div className="text-center py-8 text-text-muted">Сделки не найдены</div>
        ) : (
          <>
            <div className="overflow-x-auto -mx-2 sm:mx-0">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="text-text-muted text-left border-b border-border">
                    <th className="pb-3 font-medium">Клиент</th>
                    <th className="pb-3 font-medium">Проект</th>
                    <th className="pb-3 font-medium">Помещение</th>
                    <th className="pb-3 font-medium">Сумма</th>
                    <th className="pb-3 font-medium">Комиссия</th>
                    <th className="pb-3 font-medium">Статус</th>
                    <th className="pb-3 font-medium" title="Дата подписания договора в amoCRM (если есть). Если ещё не подписан — дата создания сделки.">Дата подписания</th>
                  </tr>
                </thead>
                <tbody>
                  {deals.map((deal: any) => (
                    <tr key={deal.id} className="border-b border-border last:border-0 hover:bg-surface-secondary">
                      <td className="py-3">
                        <div className="font-medium">{deal.client?.fullName}</div>
                        <div className="text-xs text-text-muted">{formatPhone(deal.client?.phone)}</div>
                      </td>
                      <td className="py-3">{projectLabels[deal.project] || deal.project}</td>
                      <td className="py-3 text-text-muted">{(() => {
                        if (!deal.lot) return '—';
                        const parts: string[] = [];
                        if (deal.lot.building) parts.push(deal.lot.building);
                        if (deal.lot.floor != null) parts.push(`${deal.lot.floor} эт.`);
                        if (deal.lot.rooms != null) parts.push(`${deal.lot.rooms} комн.`);
                        if (parts.length === 0 && deal.lot.number) return deal.lot.number;
                        return parts.length > 0 ? parts.join(', ') : (deal.lot.number || '—');
                      })()}</td>
                      <td className="py-3">{Math.round(Number(deal.amount)).toLocaleString('ru-RU')} ₽</td>
                      <td className="py-3 text-accent">
                        {Math.round(Number(deal.commissionAmount)).toLocaleString('ru-RU')} ₽
                      </td>
                      <td className="py-3">
                        <span className={`text-xs px-2 py-1 rounded ${statusLabels[deal.status]?.cls || ''}`}>
                          {statusLabels[deal.status]?.label || deal.status}
                        </span>
                      </td>
                      <td className="py-3 text-text-muted" title={deal.signedAt ? `Подписана ${new Date(deal.signedAt).toLocaleDateString('ru-RU')}` : `Сделка создана ${new Date(deal.createdAt).toLocaleDateString('ru-RU')}, ещё не подписана`}>
                        {new Date(deal.signedAt || deal.createdAt).toLocaleDateString('ru-RU')}
                        {!deal.signedAt && <span className="text-[10px] text-warning ml-1">(черновик)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-sm text-text-muted">Стр. {page} из {totalPages}</span>
                <div className="flex gap-2">
                  <button className="btn btn-secondary" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button className="btn btn-secondary" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
