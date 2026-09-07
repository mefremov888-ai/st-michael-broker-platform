'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { Users, Shield, HeartHandshake, Calculator } from 'lucide-react';
import PushPromptBanner from '@/components/PushPromptBanner';

interface DashboardData {
  clients: { total: number; activeFixations: number; expiringFixations: number };
  deals: { total: number; pending: number; paid: number; totalAmount: number };
  commission: { totalEarned: number };
  meetings: { upcoming: number };
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [clients, setClients] = useState<any[]>([]);
  const [deals, setDeals] = useState<any[]>([]);

  useEffect(() => {
    apiGet('/analytics/dashboard').then(setData).catch(() => {});
    apiGet('/clients?limit=5').then((r) => setClients(r.clients || [])).catch(() => {});
    apiGet('/deals?limit=5').then((r) => setDeals(r.deals || [])).catch(() => {});
  }, []);

  const stats = [
    {
      name: 'Клиенты',
      value: data?.clients.total ?? 0,
      sub: `${data?.clients.activeFixations ?? 0} активных фиксаций`,
      icon: Users,
    },
    {
      name: 'Фиксации',
      value: data?.clients.activeFixations ?? 0,
      sub: data?.clients.expiringFixations
        ? `${data.clients.expiringFixations} истекают скоро`
        : 'Все в порядке',
      icon: Shield,
      warn: (data?.clients.expiringFixations ?? 0) > 0,
    },
    {
      name: 'Сделки',
      value: data?.deals.total ?? 0,
      sub: `${data?.deals.pending ?? 0} в работе`,
      icon: HeartHandshake,
    },
    {
      name: 'Комиссия',
      value: `${Math.round(data?.commission.totalEarned ?? 0).toLocaleString('ru-RU')} ₽`,
      sub: `${data?.deals.paid ?? 0} оплаченных сделок`,
      icon: Calculator,
    },
  ];

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6">Дашборд</h1>

      <PushPromptBanner />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {stats.map((stat) => (
          <div key={stat.name} className="card">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-text-muted">{stat.name}</h3>
              <stat.icon className="w-5 h-5 text-accent" />
            </div>
            <p className="text-2xl font-bold text-accent">{stat.value}</p>
            <p className={`text-xs mt-1 ${stat.warn ? 'text-warning' : 'text-text-muted'}`}>
              {stat.sub}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Недавние клиенты</h3>
          {clients.length === 0 ? (
            <p className="text-text-muted">Нет данных</p>
          ) : (
            <div className="space-y-3">
              {clients.map((client: any) => (
                <div key={client.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div>
                    <div className="font-medium text-sm">{client.fullName}</div>
                    <div className="text-xs text-text-muted">{client.phone}</div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded ${
                    client.uniquenessStatus === 'CONDITIONALLY_UNIQUE'
                      ? 'bg-success/20 text-success'
                      : client.uniquenessStatus === 'REJECTED'
                      ? 'bg-error/20 text-error'
                      : 'bg-warning/20 text-warning'
                  }`}>
                    {client.uniquenessStatus === 'CONDITIONALLY_UNIQUE' ? 'Уникален' :
                     client.uniquenessStatus === 'REJECTED' ? 'Отклонён' :
                     client.uniquenessStatus === 'EXPIRED' ? 'Истёк' : 'На проверке'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Активные сделки</h3>
          {deals.length === 0 ? (
            <p className="text-text-muted">Нет данных</p>
          ) : (
            <div className="space-y-3">
              {deals.map((deal: any) => (
                <div key={deal.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div>
                    <div className="font-medium text-sm">{deal.client?.fullName}</div>
                    <div className="text-xs text-text-muted">{deal.project}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium text-accent">
                      {Math.round(Number(deal.amount)).toLocaleString('ru-RU')} ₽
                    </div>
                    <div className="text-xs text-text-muted">{deal.status}</div>
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
