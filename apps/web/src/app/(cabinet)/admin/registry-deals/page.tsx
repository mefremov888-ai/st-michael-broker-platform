'use client';

// 2026-09-04: «Реестр сделок» — видимая аналитика агентств по таблице
// registry_deals (реестр ДДУ, сшитый с amoCRM). Только чтение:
// карточки-итоги из GET /admin/registry-deals/summary и таблица агентств
// из GET /admin/registry-deals/agencies. Роли ADMIN|MANAGER — как и API.

import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ArrowDown, ArrowUp, FileSpreadsheet } from 'lucide-react';
import RegistrySeriesPanel from '@/components/registry/RegistrySeriesPanel';

type RegistryAgencyRow = {
  agencyCanonical: string;
  deals: number;
  amountSum: number;
  firstDeal: string | null;
  lastDeal: string | null;
  linkedLeads: number;
  paidBookings: number;
};

type RegistrySummary = {
  total: number;
  bySource: Record<string, number>;
  withBroker: number;
  withAgency: number;
  paidDeals: number;
  unpaidRows: number;
  paidBookings: number;
};

type SortKey = 'agencyCanonical' | 'deals' | 'amountSum' | 'firstDeal' | 'lastDeal' | 'linkedLeads' | 'paidBookings';

const fmtDate = (value: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU');
};

const fmtAmount = (value: number) =>
  Number.isFinite(value) && value > 0
    ? `${Math.round(value).toLocaleString('ru-RU')} ₽`
    : '—';

export default function RegistryDealsPage() {
  const { broker } = useAuth();
  const [rows, setRows] = useState<RegistryAgencyRow[]>([]);
  const [summary, setSummary] = useState<RegistrySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('deals');
  const [sortDesc, setSortDesc] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiGet<RegistrySummary>('/admin/registry-deals/summary'),
      apiGet<RegistryAgencyRow[]>('/admin/registry-deals/agencies'),
    ])
      .then(([summaryData, agencyRows]) => {
        if (cancelled) return;
        setSummary(summaryData || null);
        setRows(Array.isArray(agencyRows) ? agencyRows : []);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message || 'Ошибка загрузки');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const left = a[sortKey];
      const right = b[sortKey];
      let compare: number;
      if (typeof left === 'number' && typeof right === 'number') {
        compare = left - right;
      } else {
        compare = String(left ?? '').localeCompare(String(right ?? ''), 'ru');
      }
      return sortDesc ? -compare : compare;
    });
    return copy;
  }, [rows, sortKey, sortDesc]);

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((value) => !value);
    } else {
      setSortKey(key);
      setSortDesc(key !== 'agencyCanonical');
    }
  };

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (
      sortDesc ? (
        <ArrowDown className="w-3.5 h-3.5 inline-block ml-1" />
      ) : (
        <ArrowUp className="w-3.5 h-3.5 inline-block ml-1" />
      )
    ) : null;

  const headerCell = (key: SortKey, label: string, alignRight = false) => (
    <th
      className={`pb-3 font-medium cursor-pointer select-none whitespace-nowrap ${alignRight ? 'text-right' : 'text-left'}`}
      onClick={() => toggleSort(key)}
      title="Сортировать"
    >
      {label}
      {sortIcon(key)}
    </th>
  );

  const summaryCards = summary
    ? [
        { label: 'Сделок (оплаченных ДДУ)', value: summary.paidDeals ?? 0 },
        { label: 'Платных броней (ДВОУ)', value: summary.paidBookings ?? 0 },
        { label: 'Строк без даты оплаты', value: summary.unpaidRows ?? 0 },
        { label: 'Всего строк реестра', value: summary.total },
        { label: 'Только amo', value: summary.bySource?.AMO_ONLY || 0 },
        { label: 'С брокером', value: summary.withBroker },
        { label: 'С агентством', value: summary.withAgency },
      ]
    : [];

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-2">
        <FileSpreadsheet className="w-7 h-7 text-accent" /> Реестр сделок · аналитика агентств
      </h1>
      <p className="text-sm text-text-muted mb-6">
        Сквозная аналитика ДДУ из реестра сделок, сшитого с amoCRM: сколько сделок
        закрывает каждое агентство, на какую сумму и в какой период. Сделка — договор с
        «Датой оплаты ДДУ» (комиссия считается по факту оплаты); строки без даты оплаты в
        сделки не входят. Платная бронь — оплаченный ДВОУ.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-error/20 text-error rounded text-sm">{error}</div>
      )}

      {loading && <div className="card">Загрузка…</div>}

      {!loading && summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
          {summaryCards.map((cardItem) => (
            <div key={cardItem.label} className="card !p-4">
              <div className="text-2xl font-bold">
                {cardItem.value.toLocaleString('ru-RU')}
              </div>
              <div className="text-xs text-text-muted mt-1">{cardItem.label}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && (
        <div className="mb-6">
          <RegistrySeriesPanel />
        </div>
      )}

      {!loading && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg">Агентства</h2>
            <span className="text-sm text-text-muted">{rows.length} агентств</span>
          </div>
          {sorted.length === 0 ? (
            <div className="text-center py-8 text-text-muted">
              В реестре пока нет сделок с агентствами
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr className="text-text-muted border-b border-border">
                    {headerCell('agencyCanonical', 'Агентство')}
                    {headerCell('deals', 'Сделок (оплач. ДДУ)', true)}
                    {headerCell('amountSum', 'Сумма ₽', true)}
                    {headerCell('paidBookings', 'Платных броней', true)}
                    {headerCell('firstDeal', 'Первая оплата')}
                    {headerCell('lastDeal', 'Последняя оплата')}
                    {headerCell('linkedLeads', 'Связано с amo', true)}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => (
                    <tr
                      key={row.agencyCanonical}
                      className="border-b border-border last:border-0 hover:bg-surface-secondary"
                    >
                      <td className="py-3 font-medium">{row.agencyCanonical}</td>
                      <td className="py-3 text-right">{row.deals.toLocaleString('ru-RU')}</td>
                      <td className="py-3 text-right whitespace-nowrap">{fmtAmount(row.amountSum)}</td>
                      <td className="py-3 text-right">{(row.paidBookings ?? 0).toLocaleString('ru-RU')}</td>
                      <td className="py-3">{fmtDate(row.firstDeal)}</td>
                      <td className="py-3">{fmtDate(row.lastDeal)}</td>
                      <td className="py-3 text-right">
                        {row.linkedLeads.toLocaleString('ru-RU')}
                        {row.deals > 0 && (
                          <span className="text-xs text-text-muted ml-1">
                            ({Math.round((row.linkedLeads / row.deals) * 100)}%)
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
