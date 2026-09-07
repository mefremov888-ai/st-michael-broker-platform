'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, apiGet, apiPost } from '@/lib/api';
import { Search, ChevronLeft, ChevronRight, Shield, Download, FileSpreadsheet, BarChart3, X, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';

const roleLabels: Record<string, string> = { BROKER: 'Брокер', MANAGER: 'Менеджер', ADMIN: 'Админ' };
const statusLabels: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: 'Активен', cls: 'bg-success/20 text-success' },
  PENDING: { label: 'Ожидает', cls: 'bg-warning/20 text-warning' },
  BLOCKED: { label: 'Заблокирован', cls: 'bg-error/20 text-error' },
};

export default function AdminBrokersPage() {
  const { broker } = useAuth();
  const [brokers, setBrokers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // 2026-07-06: фильтр по специализации (COMM/RESIDENTIAL/BOTH/UNSET).
  const [specializationFilter, setSpecializationFilter] = useState('');
  // 2026-07-23: фильтр «только Telegram-контакты» (импорт из TG-чатов без телефона)
  const [contactFilter, setContactFilter] = useState('');
  // 2026-06-29 (refactor): фильтр по координаторам удалён — флаг убран.
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string>('');
  const [coverageJob, setCoverageJob] = useState<any | null>(null);
  const [coverageResult, setCoverageResult] = useState<any | null>(null);
  const [coverageError, setCoverageError] = useState<string>('');

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }

  const fetchBrokers = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (search) params.set('search', search);
    if (roleFilter) params.set('role', roleFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (specializationFilter) params.set('specialization', specializationFilter);
    if (contactFilter) params.set('contact', contactFilter);
    apiGet(`/admin/brokers?${params}`)
      .then((data) => {
        setBrokers(data.brokers || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      })
      .catch(() => setBrokers([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchBrokers(); }, [page, roleFilter, statusFilter, specializationFilter, contactFilter]);

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); setPage(1); fetchBrokers(); };

  const handleImport = async () => {
    if (!confirm('Импортировать брокеров из воронки брокеров amoCRM? Существующие будут обновлены.')) return;
    setImporting(true);
    setImportResult('');
    try {
      const r: any = await apiPost('/admin/brokers/import-from-amo', {});
      setImportResult(`Найдено лидов: ${r.foundLeads}, уникальных контактов: ${r.uniqueContacts}. Добавлено: ${r.created}, обновлено: ${r.updated}, пропущено: ${r.skipped}`);
      fetchBrokers();
    } catch (e: any) {
      setImportResult(e.message || 'Ошибка импорта');
    }
    setImporting(false);
  };

  const handleAmoCoverage = async () => {
    setCoverageError('');
    setCoverageResult(null);
    try {
      const r: any = await apiPost('/admin/brokers/amo-coverage', {});
      setCoverageJob({ id: r.jobId, status: 'queued', step: 'queued', progress: { current: 0, total: 0 } });
      pollCoverageJob(r.jobId);
    } catch (e: any) {
      setCoverageError(e?.message || 'Не удалось запустить анализ');
    }
  };

  const pollCoverageJob = async (jobId: string) => {
    try {
      const j: any = await apiGet(`/admin/brokers/import-jobs/${jobId}`);
      setCoverageJob(j);
      if (j.status === 'done') {
        setCoverageResult(j.result);
        return;
      }
      if (j.status === 'failed') {
        setCoverageError(j.error || 'Ошибка анализа');
        return;
      }
      setTimeout(() => pollCoverageJob(jobId), 2500);
    } catch (e: any) {
      setCoverageError(e?.message || 'Ошибка polling');
    }
  };

  const coverageProgressPct = coverageJob?.progress?.total
    ? Math.round((coverageJob.progress.current / coverageJob.progress.total) * 100)
    : 0;
  const coverageInProgress = coverageJob && (coverageJob.status === 'queued' || coverageJob.status === 'running');
  const closeCoverage = () => { setCoverageJob(null); setCoverageResult(null); setCoverageError(''); };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2"><Shield className="w-7 h-7 text-accent" />Брокеры</h1>
          <span className="text-text-muted text-sm">Всего в системе: {total}</span>
        </div>
        {broker?.role === 'ADMIN' && (
          <div className="flex gap-2 flex-wrap">
            <button onClick={handleAmoCoverage} disabled={!!coverageInProgress} className="btn btn-secondary flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              {coverageInProgress ? 'Анализ…' : 'Анализ amoCRM vs база'}
            </button>
            <Link href="/admin/brokers/import" className="btn btn-secondary flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4" />
              Импорт из xlsx
            </Link>
            <button onClick={handleImport} disabled={importing} className="btn btn-primary flex items-center gap-2">
              <Download className={`w-4 h-4 ${importing ? 'animate-pulse' : ''}`} />
              {importing ? 'Импорт...' : 'Импорт из amoCRM'}
            </button>
          </div>
        )}
      </div>

      {importResult && (
        <div className="mb-4 p-3 bg-info/20 text-info rounded-lg text-sm">{importResult}</div>
      )}

      <div className="card mb-6">
        {/* КБ6 #46: на моб в столбик */}
        <div className="flex flex-col md:flex-row md:flex-wrap gap-2 md:gap-4">
          <form onSubmit={handleSearch} className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input className="input pl-10" placeholder="ФИО, телефон или email..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </form>
          <select className="input w-auto" value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}>
            <option value="">Все роли</option>
            <option value="BROKER">Брокер</option>
            <option value="MANAGER">Менеджер</option>
            <option value="ADMIN">Админ</option>
          </select>
          <select className="input w-auto" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="">Все статусы</option>
            <option value="ACTIVE">Активен</option>
            <option value="PENDING">Ожидает</option>
            <option value="BLOCKED">Заблокирован</option>
          </select>
          {/* 2026-07-06: фильтр «Специализация». COMM ставится автоматически
              при импорте из Google по ключевым словам в комментарии
              (комм/офис/склад/торговый/нежилой/ритейл и т.п.). UNSET — брокер
              без указанной специализации. */}
          <select className="input w-auto" value={specializationFilter} onChange={(e) => { setSpecializationFilter(e.target.value); setPage(1); }}>
            <option value="">Все специализации</option>
            <option value="COMM">Коммерция</option>
            <option value="RESIDENTIAL">Жилая</option>
            <option value="BOTH">Обе</option>
            {/* 2026-07-09: региональный — отдельный признак, но фильтр
                живёт в том же селекте (по решению пользователя). */}
            <option value="REGIONAL">Региональный</option>
            <option value="UNSET">Не указана</option>
          </select>
          {/* 2026-07-23: контакты из TG-чатов без телефона (phone='tg:<ник>').
              TG_ONLY — только они; WITH_PHONE — скрыть их. */}
          <select className="input w-auto" value={contactFilter} onChange={(e) => { setContactFilter(e.target.value); setPage(1); }}>
            <option value="">Все контакты</option>
            <option value="TG_ONLY">Только Telegram (без телефона)</option>
            <option value="WITH_PHONE">Только с телефоном</option>
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : brokers.length === 0 ? (
          <div className="text-center py-8 text-text-muted">Брокеры не найдены</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="text-text-muted text-left border-b border-border">
                    <th className="pb-3 font-medium">ФИО</th>
                    <th className="pb-3 font-medium">Телефон</th>
                    <th className="pb-3 font-medium">Email</th>
                    <th className="pb-3 font-medium">Роль</th>
                    <th className="pb-3 font-medium">Статус</th>
                    <th className="pb-3 font-medium" title="Договор-оферта о сотрудничестве">Оферта</th>
                    <th className="pb-3 font-medium text-right">Клиенты</th>
                    <th className="pb-3 font-medium text-right">Сделки</th>
                    <th className="pb-3 font-medium text-right">Встречи</th>
                  </tr>
                </thead>
                <tbody>
                  {brokers.map((b: any) => (
                    <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface-secondary cursor-pointer">
                      <td className="py-3 font-medium">
                        <Link href={`/admin/brokers/${b.id}`} className="hover:text-accent">{b.fullName}</Link>
                      </td>
                      <td className="py-3 text-text-muted">{b.phone}</td>
                      <td className="py-3 text-text-muted text-xs">{b.email || '—'}</td>
                      <td className="py-3" onClick={(e) => e.stopPropagation()}>
                        {broker?.role === 'ADMIN' ? (
                          <select
                            className={`text-xs px-2 py-1 rounded border-0 cursor-pointer ${b.role === 'ADMIN' ? 'bg-accent/20 text-accent' : b.role === 'MANAGER' ? 'bg-info/20 text-info' : 'bg-text-muted/20 text-text-muted'}`}
                            value={b.role}
                            onChange={async (e) => {
                              const newRole = e.target.value;
                              if (newRole === b.role) return;
                              if (!confirm(`Сменить роль "${b.fullName}" с ${roleLabels[b.role]} на ${roleLabels[newRole]}?`)) return;
                              try {
                                await api(`/admin/brokers/${b.id}/role`, { method: 'PATCH', body: JSON.stringify({ role: newRole }) });
                                fetchBrokers();
                              } catch (err: any) {
                                alert(`Ошибка смены роли: ${err?.message || err}`);
                              }
                            }}
                          >
                            <option value="BROKER">Брокер</option>
                            <option value="MANAGER">Менеджер</option>
                            <option value="ADMIN">Админ</option>
                          </select>
                        ) : (
                          <span className={`text-xs px-2 py-1 rounded ${b.role === 'ADMIN' ? 'bg-accent/20 text-accent' : b.role === 'MANAGER' ? 'bg-info/20 text-info' : 'bg-text-muted/20 text-text-muted'}`}>
                            {roleLabels[b.role] || b.role}
                          </span>
                        )}
                      </td>
                      <td className="py-3">
                        <span className={`text-xs px-2 py-1 rounded ${statusLabels[b.status]?.cls || ''}`}>
                          {statusLabels[b.status]?.label || b.status}
                        </span>
                      </td>
                      <td className="py-3" title={b._count?.offerAcceptances ? 'Оферта подписана' : 'Не подписана'}>
                        {b._count?.offerAcceptances > 0
                          ? <span className="text-xs px-2 py-1 rounded bg-success/20 text-success">✓ подписана</span>
                          : <span className="text-xs px-2 py-1 rounded bg-warning/20 text-warning">⚠ нет</span>}
                      </td>
                      <td className="py-3 text-right">{b._count?.clients ?? 0}</td>
                      <td className="py-3 text-right">{b._count?.deals ?? 0}</td>
                      <td className="py-3 text-right">{b._count?.meetings ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-sm text-text-muted">Стр. {page} из {totalPages}</span>
                <div className="flex gap-2">
                  <button className="btn btn-secondary" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}><ChevronLeft className="w-4 h-4" /></button>
                  <button className="btn btn-secondary" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}><ChevronRight className="w-4 h-4" /></button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {coverageJob && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={closeCoverage}>
          <div className="bg-surface rounded-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6 relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={closeCoverage} className="absolute top-4 right-4 text-text-muted hover:text-text">
              <X className="w-5 h-5" />
            </button>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              {coverageInProgress && <Loader2 className="w-5 h-5 animate-spin text-accent" />}
              <BarChart3 className="w-6 h-6 text-accent" />
              Анализ amoCRM vs база
            </h2>

            {coverageError && (
              <div className="p-3 bg-error/10 text-error rounded text-sm mb-4">{coverageError}</div>
            )}

            {coverageInProgress && coverageJob.progress?.total > 0 && (
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span>Обработано контактов: {coverageJob.progress.current} / {coverageJob.progress.total}</span>
                  <span>{coverageProgressPct}%</span>
                </div>
                <div className="w-full bg-surface-secondary rounded-full h-2 overflow-hidden">
                  <div className="bg-accent h-full transition-all" style={{ width: `${coverageProgressPct}%` }} />
                </div>
                <p className="text-xs text-text-muted mt-3">
                  Это занимает несколько минут — каждый контакт амо запрашивается отдельно. Можно не закрывать вкладку.
                </p>
              </div>
            )}

            {coverageResult && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <KpiCard title="Лидов в воронке амо" value={coverageResult.totalLeadsInAmo} />
                  <KpiCard title="Уникальных контактов" value={coverageResult.uniqueContactsInAmo} />
                  <KpiCard title="Брокеров в нашей БД" value={coverageResult.totalBrokersInDb} />
                  <KpiCard title="Из них в базе КЦ" value={coverageResult.brokersInDbBase} />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <KpiCard title="🆕 В амо но НЕТ у нас" value={coverageResult.inAmoNotInDb} cls="bg-warning/10 text-warning" big />
                  <KpiCard title="✓ И там и там (по телефону)" value={coverageResult.inBoth} cls="bg-success/10 text-success" big />
                  <KpiCard title="📋 У нас (база КЦ) но НЕТ в амо" value={coverageResult.inDbBaseNotInAmo} cls="bg-info/10 text-info" big />
                </div>

                <div className="text-xs text-text-muted bg-surface-secondary p-3 rounded space-y-1">
                  <div>Без флага IS_BROKER пропущено: {coverageResult.notBrokerFlag}</div>
                  <div>С невалидным телефоном пропущено: {coverageResult.invalidPhone}</div>
                  <div>Ошибок amo-API: {coverageResult.amoErrors}</div>
                  <div>Уникальных нормализованных телефонов из амо: {coverageResult.uniquePhonesInAmo}</div>
                </div>

                {coverageResult.examplesAmoOnly?.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-2">Примеры брокеров из амо, которых нет у нас (первые {coverageResult.examplesAmoOnly.length}):</h3>
                    <div className="text-xs space-y-1 font-mono max-h-64 overflow-y-auto border border-border rounded p-2">
                      {coverageResult.examplesAmoOnly.map((e: any, i: number) => (
                        <div key={i} className="flex gap-3 py-0.5 border-b border-border/50 last:border-0">
                          <span className="text-text-muted">amo#{e.amoContactId}</span>
                          <span className="text-accent">{e.phone}</span>
                          <span className="flex-1">{e.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ title, value, cls = '', big = false }: { title: string; value: number; cls?: string; big?: boolean }) {
  return (
    <div className={`p-3 rounded ${cls || 'bg-surface-secondary'}`}>
      <div className="text-xs text-text-muted">{title}</div>
      <div className={`font-bold ${big ? 'text-2xl' : 'text-lg'} mt-1`}>{value}</div>
    </div>
  );
}
