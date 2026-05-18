'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { ChevronLeft, ChevronRight, HeartHandshake, DollarSign, TrendingUp, Wallet } from 'lucide-react';

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

  // Load aggregate summary across ALL deals (not just current page)
  useEffect(() => {
    apiGet('/deals?limit=1000')
      .then((data) => {
        const all = data.deals || [];
        const totalAmount = all.reduce((s: number, d: any) => s + Number(d.amount || 0), 0);
        const earned = all
          .filter((d: any) => d.status === 'PAID' || d.status === 'COMMISSION_PAID')
          .reduce((s: number, d: any) => s + Number(d.commissionAmount || 0), 0);
        const payable = all
          .filter((d: any) => d.status === 'PAID')
          .reduce((s: number, d: any) => s + Number(d.commissionAmount || 0), 0);
        setSummary({
          total: data.total || all.length,
          totalAmount,
          totalCommission: earned,
          payable,
        });
      })
      .catch(() => {});
  }, []);

  const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU') + ' ₽';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Сделки</h1>
        <span className="text-text-muted text-sm">Всего: {total}</span>
      </div>

      {/* Summary KPIs (ТЗ §5 — сводные показатели) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
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
            <DollarSign className="w-5 h-5 text-accent" />
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-muted text-left border-b border-border">
                    <th className="pb-3 font-medium">Клиент</th>
                    <th className="pb-3 font-medium">Проект</th>
                    <th className="pb-3 font-medium">Лот</th>
                    <th className="pb-3 font-medium">Сумма</th>
                    <th className="pb-3 font-medium">Комиссия</th>
                    <th className="pb-3 font-medium">Статус</th>
                    <th className="pb-3 font-medium">Дата</th>
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
                      <td className="py-3 text-text-muted">{deal.lot?.number || '—'}</td>
                      <td className="py-3">{Math.round(Number(deal.amount)).toLocaleString('ru-RU')} ₽</td>
                      <td className="py-3 text-accent">
                        {Math.round(Number(deal.commissionAmount)).toLocaleString('ru-RU')} ₽
                        <span className="text-xs text-text-muted ml-1">({Number(deal.commissionRate)}%)</span>
                      </td>
                      <td className="py-3">
                        <span className={`text-xs px-2 py-1 rounded ${statusLabels[deal.status]?.cls || ''}`}>
                          {statusLabels[deal.status]?.label || deal.status}
                        </span>
                      </td>
                      <td className="py-3 text-text-muted">
                        {/* signedAt — дата из amoCRM (правка 2026-05-13). */}
                        {new Date(deal.signedAt || deal.createdAt).toLocaleDateString('ru-RU')}
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
