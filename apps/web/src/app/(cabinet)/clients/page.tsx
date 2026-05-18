'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { Search, ChevronLeft, ChevronRight, X, AlertTriangle } from 'lucide-react';

const statusLabels: Record<string, { label: string; cls: string }> = {
  CONDITIONALLY_UNIQUE: { label: 'Уникален', cls: 'bg-success/20 text-success' },
  REJECTED: { label: 'Отклонён', cls: 'bg-error/20 text-error' },
  UNDER_REVIEW: { label: 'На проверке', cls: 'bg-warning/20 text-warning' },
  EXPIRED: { label: 'Истёк', cls: 'bg-text-muted/20 text-text-muted' },
};

const projectLabels: Record<string, string> = {
  ZORGE9: 'Зорге 9',
  SILVER_BOR: 'Серебряный бор',
};

// Форматирование телефона в формат +7 (XXX) XXX-XX-XX.
// Правка 2026-05-13: нормализуем перед форматированием (раньше `09251234567`
// показывался как «+0 (925)...» — теперь всегда +7).
function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  let d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && !d.startsWith('7')) d = '7' + d.slice(1);
  if (d.length !== 11) return phone;
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`;
}

function daysUntilExpiry(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function ClientDetail({ client, onClose }: { client: any; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={onClose}>
          <X className="w-5 h-5" />
        </button>

        <h2 className="text-xl font-bold mb-1">{client.fullName}</h2>
        <p className="text-text-muted text-sm mb-4">{formatPhone(client.phone)}</p>

        <div className="flex gap-2 mb-4">
          <span className={`text-xs px-2 py-1 rounded ${statusLabels[client.uniquenessStatus]?.cls || 'bg-text-muted/20'}`}>
            {statusLabels[client.uniquenessStatus]?.label || client.uniquenessStatus}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm mb-4">
          {client.email && (
            <div className="bg-surface-secondary rounded-lg p-3 col-span-2">
              <span className="text-text-muted block text-xs">Email</span>
              <span className="font-medium">{client.email}</span>
            </div>
          )}
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Проект</span>
            <span className="font-medium">{projectLabels[client.project] || client.project}</span>
          </div>
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Статус</span>
            <span className="font-medium">{client.status}</span>
          </div>
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Дата создания</span>
            <span className="font-medium">{new Date(client.createdAt).toLocaleDateString('ru-RU')}</span>
          </div>
          <div className="bg-surface-secondary rounded-lg p-3">
            <span className="text-text-muted block text-xs">Обновлён</span>
            <span className="font-medium">{new Date(client.updatedAt).toLocaleDateString('ru-RU')}</span>
          </div>
        </div>

        {client.comment && (
          <div className="bg-surface-secondary rounded-lg p-3 mb-4">
            <span className="text-text-muted block text-xs mb-1">Комментарий</span>
            <span className="text-sm whitespace-pre-wrap">{client.comment}</span>
          </div>
        )}

        {client.deals && client.deals.length > 0 && (
          <div>
            <h3 className="text-sm font-medium mb-2">Сделки</h3>
            <div className="space-y-2">
              {client.deals.map((deal: any) => (
                <div key={deal.id} className="bg-surface-secondary rounded-lg p-3 flex justify-between text-sm">
                  <span>Статус: {deal.status}</span>
                  {deal.amount && <span className="font-medium">{Math.round(Number(deal.amount)).toLocaleString('ru-RU')} ₽</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClientsPage() {
  const [clients, setClients] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedClient, setSelectedClient] = useState<any>(null);

  const fetchClients = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '15' });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (projectFilter) params.set('project', projectFilter);
      const data = await apiGet(`/clients?${params}`);
      setClients(data.clients || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
    } catch {
      setClients([]);
    }
    setLoading(false);
  };

  useEffect(() => { fetchClients(); }, [page, statusFilter, projectFilter]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchClients();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Клиенты</h1>
        <span className="text-text-muted text-sm">Всего: {total}</span>
      </div>

      {/* Expiring fixations banner */}
      {(() => {
        const expiring = clients.filter((c) => {
          if (c.uniquenessStatus !== 'CONDITIONALLY_UNIQUE') return false;
          const d = daysUntilExpiry(c.uniquenessExpiresAt);
          return d !== null && d >= 0 && d <= 7;
        });
        if (expiring.length === 0) return null;
        return (
          <div className="mb-6 p-4 rounded-lg bg-warning/10 border border-warning/40 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-warning">
                У {expiring.length} {expiring.length === 1 ? 'клиента' : 'клиентов'} скоро истекает фиксация
              </div>
              <div className="text-sm text-text-muted mt-1">
                {expiring.slice(0, 3).map((c) => `${c.fullName} — ${daysUntilExpiry(c.uniquenessExpiresAt)} дн.`).join(' · ')}
                {expiring.length > 3 && ` · и ещё ${expiring.length - 3}`}
              </div>
            </div>
          </div>
        );
      })()}

      <div className="card mb-6">
        <div className="flex flex-wrap gap-4">
          <form onSubmit={handleSearch} className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              className="input pl-10"
              placeholder="Поиск по имени или телефону..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
          <select
            className="input w-auto"
            value={projectFilter}
            onChange={(e) => { setProjectFilter(e.target.value); setPage(1); }}
          >
            <option value="">Все проекты</option>
            <option value="ZORGE9">Зорге 9</option>
            <option value="SILVER_BOR">Серебряный бор</option>
          </select>
          <select
            className="input w-auto"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          >
            <option value="">Все статусы</option>
            <option value="CONDITIONALLY_UNIQUE">Уникален</option>
            <option value="UNDER_REVIEW">На проверке</option>
            <option value="REJECTED">Отклонён</option>
            <option value="EXPIRED">Истёк</option>
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : clients.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            Клиенты появятся после синхронизации с amoCRM
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-muted text-left border-b border-border">
                    <th className="pb-3 font-medium">ФИО</th>
                    <th className="pb-3 font-medium">Телефон</th>
                    <th className="pb-3 font-medium">Проект</th>
                    <th className="pb-3 font-medium">Уникальность</th>
                    <th className="pb-3 font-medium">Дата</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c: any) => (
                    <tr
                      key={c.id}
                      className="border-b border-border last:border-0 hover:bg-surface-secondary cursor-pointer transition"
                      onClick={() => setSelectedClient(c)}
                    >
                      <td className="py-3 font-medium">{c.fullName}</td>
                      <td className="py-3 text-text-muted">{formatPhone(c.phone)}</td>
                      <td className="py-3">{projectLabels[c.project] || c.project}</td>
                      <td className="py-3">
                        <span className={`text-xs px-2 py-1 rounded ${statusLabels[c.uniquenessStatus]?.cls || ''}`}>
                          {statusLabels[c.uniquenessStatus]?.label || c.uniquenessStatus}
                        </span>
                        {(() => {
                          if (c.uniquenessStatus !== 'CONDITIONALLY_UNIQUE') return null;
                          const d = daysUntilExpiry(c.uniquenessExpiresAt);
                          if (d === null || d > 7 || d < 0) return null;
                          return (
                            <div className={`text-[10px] mt-1 ${d <= 1 ? 'text-error' : 'text-warning'}`}>
                              ⚠ истекает через {d} дн.
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-3 text-text-muted">
                        {new Date(c.createdAt).toLocaleDateString('ru-RU')}
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

      {selectedClient && <ClientDetail client={selectedClient} onClose={() => setSelectedClient(null)} />}
    </div>
  );
}
