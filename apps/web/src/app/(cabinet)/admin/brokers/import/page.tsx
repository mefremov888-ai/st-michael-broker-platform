'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ArrowLeft, Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

type CommonStats = {
  total: number;
  invalidPhone: number;
  duplicatesInSheet: number;
  duplicatesMerged: number;
  afterFilter: number;
  coordRows: number;
  byCategory: Record<string, number>;
  byCallFlag: Record<string, number>;
  unknownResults: Record<string, number>;
  unknownZorge: Record<string, number>;
};

type DryRunResult = {
  dryRun: true;
  stats: CommonStats & {
    wouldCreate: number;
    wouldUpdate: number;
    wouldCreateCallLogs: number;
  };
  preview: Array<{ phone: string; name: string; category: string; resultStr: string; zorgeStr: string }>;
};

type RealStartResponse = {
  dryRun: false;
  jobId: string;
  status: 'queued';
  message: string;
};

type JobState = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  step: string;
  startedAt: string;
  finishedAt?: string;
  progress: { current: number; total: number };
  result?: {
    stats: CommonStats;
    dbStats: { created: number; updated: number; callLogsCreated: number; callLogsSkipped: number; errors: number; coordCreated: number; coordUpdated: number };
    errors: Array<{ phone: string; error: string }>;
  };
  error?: string;
};

const stepLabels: Record<string, string> = {
  queued: 'В очереди…',
  parsing: 'Парсинг файла…',
  'writing-brokers': 'Запись брокеров',
  'writing-call-logs': 'История звонков',
  'writing-coords': 'Координаторы',
  done: 'Готово',
  failed: 'Ошибка',
};

export default function AdminBrokersImportPage() {
  const { broker } = useAuth();

  if (broker && broker.role !== 'ADMIN') {
    return (
      <div className="card">
        <h2 className="text-xl font-bold mb-2">Доступ запрещён</h2>
        <p className="text-text-muted text-sm">Импорт базы брокеров доступен только администраторам.</p>
      </div>
    );
  }

  const [file, setFile] = useState<File | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [callFlag, setCallFlag] = useState('да');
  const [limit, setLimit] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [includeCoords, setIncludeCoords] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dryResult, setDryResult] = useState<DryRunResult | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => () => stopPolling(), []);

  const pollJob = async (jobId: string) => {
    try {
      const j: JobState = await apiGet(`/admin/brokers/import-jobs/${jobId}`);
      setJob(j);
      if (j.status === 'done' || j.status === 'failed') {
        stopPolling();
        return;
      }
    } catch (e: any) {
      setError(e?.message || 'Не удалось получить статус джобы');
      stopPolling();
      return;
    }
    pollRef.current = setTimeout(() => pollJob(jobId), 2000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Сначала выбери xlsx-файл');
      return;
    }
    if (!dryRun) {
      const ok = confirm(
        `РЕАЛЬНЫЙ ИМПОРТ в БД.\n\nФайл: ${file.name}\nФильтр: ${filter}\nЗВОНОК: ${callFlag || '(все)'}\nLimit: ${limit || '(нет)'}\n\nПродолжить?`,
      );
      if (!ok) return;
    }

    setLoading(true);
    setError(null);
    setDryResult(null);
    setJob(null);
    stopPolling();

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('filter', filter);
      if (callFlag) fd.append('callFlag', callFlag);
      if (limit) fd.append('limit', limit);
      fd.append('dryRun', String(dryRun));
      fd.append('includeCoords', String(includeCoords));
      const r = await apiUpload<DryRunResult | RealStartResponse>('/admin/brokers/import-from-xlsx', fd);

      if ((r as DryRunResult).dryRun === true) {
        setDryResult(r as DryRunResult);
      } else {
        const startRes = r as RealStartResponse;
        setJob({
          id: startRes.jobId,
          status: 'queued',
          step: 'queued',
          startedAt: new Date().toISOString(),
          progress: { current: 0, total: 0 },
        });
        pollJob(startRes.jobId);
      }
    } catch (e: any) {
      setError(e?.message || 'Ошибка импорта');
    } finally {
      setLoading(false);
    }
  };

  const isProcessing = job && (job.status === 'queued' || job.status === 'running');
  const jobDone = job && job.status === 'done';
  const jobFailed = job && job.status === 'failed';
  const jobStats = job?.result?.stats;
  const dbStats = job?.result?.dbStats;
  const jobErrors = job?.result?.errors;
  const progressPct = job?.progress.total ? Math.round((job.progress.current / job.progress.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/brokers" className="btn btn-secondary flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" /> Назад
        </Link>
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <FileSpreadsheet className="w-7 h-7 text-accent" />
          Импорт брокеров из xlsx
        </h1>
      </div>

      <div className="card text-sm text-text-muted space-y-1">
        <p>Источник — экспорт Google-таблицы колл-центра (Файл → Скачать → Microsoft Excel).</p>
        <p>Скрипт идемпотентен по полю <code>phone</code> (upsert), а CallLog защищён от дубликатов: при повторном импорте того же файла история звонков не удваивается.</p>
        <p>При дублях телефона в xlsx — строки <strong>мерджатся</strong> (берём наиболее полную информацию), а не отбрасываются.</p>
      </div>

      <form onSubmit={handleSubmit} className="card space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">XLSX-файл</label>
          <input
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="input"
            required
            disabled={!!isProcessing}
          />
          {file && <p className="text-xs text-text-muted mt-1">Выбран: {file.name} ({Math.round(file.size / 1024)} КБ)</p>}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2">Категории (BrokerCategory)</label>
            <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)} disabled={!!isProcessing}>
              <option value="ALL">ALL — все категории</option>
              <option value="COLD">COLD — НДЗ, новый</option>
              <option value="WARM">WARM — проинформирован</option>
              <option value="HOT">HOT — запись на БТ / в работе</option>
              <option value="CONVERTED">CONVERTED — был на встрече / сделке</option>
              <option value="ON_BOT_REVIEW">ON_BOT_REVIEW — 2НДЗ / отказ от связи</option>
              <option value="BLACKLIST">BLACKLIST — не брокер / неверный номер</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Фильтр по ЗВОНОК (col F)</label>
            <select className="input" value={callFlag} onChange={(e) => setCallFlag(e.target.value)} disabled={!!isProcessing}>
              <option value="">Без фильтра</option>
              <option value="да">да — звонок завершён</option>
              <option value="в работе">в работе</option>
              <option value="обработан">обработан</option>
              <option value="да,обработан">да + обработан</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Limit (для тестов)</label>
            <input
              className="input"
              type="number"
              placeholder="пусто = без лимита"
              min={1}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              disabled={!!isProcessing}
            />
          </div>

          <div className="flex flex-col gap-3 justify-end">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={!!isProcessing} />
              <span className="text-sm">Dry-run — ничего не пишет, только показывает план (Recommended на первый запуск)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={includeCoords} onChange={(e) => setIncludeCoords(e.target.checked)} disabled={!!isProcessing} />
              <span className="text-sm">Импортировать также лист координаторов (если есть)</span>
            </label>
          </div>
        </div>

        <button type="submit" disabled={loading || !file || !!isProcessing} className="btn btn-primary flex items-center gap-2">
          <Upload className={`w-4 h-4 ${loading ? 'animate-pulse' : ''}`} />
          {loading ? 'Запуск…' : isProcessing ? 'Импорт в фоне…' : dryRun ? 'Проверить (dry-run)' : 'РЕАЛЬНЫЙ ИМПОРТ'}
        </button>
      </form>

      {error && (
        <div className="card bg-error/10 border-error/30 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-error mt-0.5" />
          <div>
            <p className="font-medium text-error">Ошибка</p>
            <p className="text-sm text-text-muted">{error}</p>
          </div>
        </div>
      )}

      {/* DRY-RUN РЕЗУЛЬТАТ */}
      {dryResult && <DryRunPanel result={dryResult} />}

      {/* РЕАЛЬНЫЙ ИМПОРТ — прогресс или итог */}
      {job && (
        <div className="card space-y-4">
          <div className="flex items-center gap-2">
            {isProcessing && <Loader2 className="w-6 h-6 animate-spin text-accent" />}
            {jobDone && <CheckCircle2 className="w-6 h-6 text-success" />}
            {jobFailed && <AlertCircle className="w-6 h-6 text-error" />}
            <h2 className="text-xl font-bold">
              {isProcessing && 'Импорт в фоне'}
              {jobDone && 'Импорт завершён'}
              {jobFailed && 'Импорт упал'}
            </h2>
          </div>

          <div className="text-sm text-text-muted">
            Job ID: <code>{job.id}</code> · Этап: <strong>{stepLabels[job.step] || job.step}</strong>
          </div>

          {isProcessing && job.progress.total > 0 && (
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>{job.progress.current} / {job.progress.total}</span>
                <span>{progressPct}%</span>
              </div>
              <div className="w-full bg-surface-secondary rounded-full h-2 overflow-hidden">
                <div className="bg-accent h-full transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              <p className="text-xs text-text-muted mt-2">
                Можно закрыть страницу — импорт идёт на сервере. Открой страницу снова, прогресс восстановится по Job ID на час.
              </p>
            </div>
          )}

          {jobFailed && (
            <div className="bg-error/10 p-3 rounded text-sm">
              <p className="text-error font-medium">{job.error}</p>
            </div>
          )}

          {jobDone && dbStats && jobStats && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-success/10 p-3 rounded"><div className="text-text-muted">Создано</div><div className="text-2xl font-bold text-success">{dbStats.created}</div></div>
                <div className="bg-info/10 p-3 rounded"><div className="text-text-muted">Обновлено</div><div className="text-2xl font-bold text-info">{dbStats.updated}</div></div>
                <div className="bg-accent/10 p-3 rounded"><div className="text-text-muted">CallLog +</div><div className="text-2xl font-bold text-accent">{dbStats.callLogsCreated}</div></div>
                <div className="bg-warning/10 p-3 rounded"><div className="text-text-muted">CallLog пропущено (дубли)</div><div className="text-2xl font-bold text-warning">{dbStats.callLogsSkipped}</div></div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Координаторы созд.</div><div className="text-lg font-bold">{dbStats.coordCreated}</div></div>
                <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Координаторы обнов.</div><div className="text-lg font-bold">{dbStats.coordUpdated}</div></div>
                <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Дубли смерджено</div><div className="text-lg font-bold">{jobStats.duplicatesMerged}</div></div>
                <div className="bg-error/10 p-3 rounded"><div className="text-text-muted">Ошибок</div><div className="text-2xl font-bold text-error">{dbStats.errors}</div></div>
              </div>
              {jobErrors && jobErrors.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-error mb-2">Ошибки (первые 20):</h3>
                  <div className="text-xs space-y-1 font-mono">
                    {jobErrors.map((e, i) => (
                      <div key={i} className="border-b border-border py-1">
                        {e.phone} — {e.error}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DryRunPanel({ result }: { result: DryRunResult }) {
  const unknownResultsCount = Object.values(result.stats.unknownResults || {}).reduce((s, v) => s + v, 0);
  const unknownZorgeCount = Object.values(result.stats.unknownZorge || {}).reduce((s, v) => s + v, 0);

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="w-6 h-6 text-success" />
        <h2 className="text-xl font-bold">Результат проверки (dry-run)</h2>
      </div>

      <div>
        <h3 className="text-sm font-medium text-text-muted mb-2">Статистика обхода</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Всего строк</div><div className="text-lg font-bold">{result.stats.total}</div></div>
          <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Невалидный телефон</div><div className="text-lg font-bold">{result.stats.invalidPhone}</div></div>
          <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Дубли в листе</div><div className="text-lg font-bold">{result.stats.duplicatesInSheet}</div></div>
          <div className="bg-surface-secondary p-3 rounded"><div className="text-text-muted">Из них смерджено</div><div className="text-lg font-bold text-info">{result.stats.duplicatesMerged}</div></div>
          <div className="bg-surface-secondary p-3 rounded col-span-2 md:col-span-1"><div className="text-text-muted">Под фильтр</div><div className="text-lg font-bold text-accent">{result.stats.afterFilter}</div></div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <div className="bg-info/10 p-3 rounded">
          <div className="text-text-muted">Будет создано</div>
          <div className="text-2xl font-bold text-info">{result.stats.wouldCreate}</div>
        </div>
        <div className="bg-warning/10 p-3 rounded">
          <div className="text-text-muted">Будет обновлено</div>
          <div className="text-2xl font-bold text-warning">{result.stats.wouldUpdate}</div>
        </div>
        <div className="bg-success/10 p-3 rounded">
          <div className="text-text-muted">Новых CallLog</div>
          <div className="text-2xl font-bold text-success">{result.stats.wouldCreateCallLogs}</div>
        </div>
      </div>

      {/* НЕРАСПОЗНАННЫЕ ЗНАЧЕНИЯ — критично для бизнес-логики */}
      {(unknownResultsCount > 0 || unknownZorgeCount > 0) && (
        <div className="bg-warning/10 border border-warning/30 p-4 rounded space-y-3">
          <div className="font-semibold text-warning flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            Внимание: в таблице есть нераспознанные значения
          </div>
          <p className="text-xs text-text-muted">
            Эти значения не маппятся ни в одно из 11 ожидаемых — брокеры с ними попадут в дефолтный <code>COLD</code> без записи в CallLog.
            Если значений много — стоит поправить опечатки в исходной Google-таблице или попросить добавить их в маппинг.
          </p>

          {unknownResultsCount > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-1">«Результат звонка» — нераспознано: {unknownResultsCount}</h4>
              <div className="text-xs space-y-1">
                {Object.entries(result.stats.unknownResults).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-border/50 py-0.5">
                    <span className="font-mono">«{k}»</span><span>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unknownZorgeCount > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-1">«Обзвон по Зорге» — нераспознано: {unknownZorgeCount}</h4>
              <div className="text-xs space-y-1">
                {Object.entries(result.stats.unknownZorge).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-border/50 py-0.5">
                    <span className="font-mono">«{k}»</span><span>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium text-text-muted mb-2">Категории (после нормализации телефона)</h3>
        <div className="text-sm space-y-1">
          {Object.entries(result.stats.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-border py-1">
              <span>{k}</span><span className="font-mono">{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-text-muted mb-2">Распределение по ЗВОНОК (col F)</h3>
        <div className="text-sm space-y-1">
          {Object.entries(result.stats.byCallFlag).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-border py-1">
              <span>{k}</span><span className="font-mono">{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-text-muted mb-2">Превью первых 10 кандидатов</h3>
        <div className="text-xs space-y-1 font-mono">
          {result.preview.map((p, i) => (
            <div key={i} className="border-b border-border py-1">
              {i + 1}. {p.phone} · {p.category.padEnd(13)} · {p.name} · {p.resultStr}{p.zorgeStr ? ` | Zorge: ${p.zorgeStr}` : ''}
            </div>
          ))}
        </div>
      </div>

      <div className="bg-warning/10 p-3 rounded text-sm">
        <p className="font-medium">Если цифры адекватные — сними галку «Dry-run» и нажми «РЕАЛЬНЫЙ ИМПОРТ».</p>
      </div>
    </div>
  );
}
