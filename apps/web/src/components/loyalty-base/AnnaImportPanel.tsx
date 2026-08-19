'use client';

import { ChangeEvent, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileJson, Loader2, UploadCloud } from 'lucide-react';
import {
  dryRunAnnaImport,
  publishAnnaImport,
  stageAnnaImport,
  type ImportStepResult,
} from '@/lib/loyalty-base-api';

type ImportStep = 'select' | 'dry-run' | 'staged' | 'published';

const stepLabels: Array<{ key: ImportStep; label: string }> = [
  { key: 'select', label: '1. JSON' },
  { key: 'dry-run', label: '2. Dry-run' },
  { key: 'staged', label: '3. Staging' },
  { key: 'published', label: '4. Publish' },
];

const stepIndex = (step: ImportStep) => stepLabels.findIndex((item) => item.key === step);

const coverageDimensionLabels: Record<string, string> = {
  records: 'записи',
  brokers: 'брокеры',
  agencies: 'агентства',
  uniqueNormalizedPhones: 'уникальные телефоны',
  externalIdentities: 'внешние ID',
  activities: 'активности',
  includedActivities: 'активности, включенные в KPI',
  includedFixations: 'фиксации, включенные в KPI',
  includedMeetings: 'встречи, включенные в KPI',
  includedDeals: 'сделки, включенные в KPI',
  includedBrokerTours: 'брокер-туры, включенные в KPI',
  includedCalls: 'звонки, включенные в KPI',
  includedDealAmount: 'сумма сделок, включенных в KPI',
};

export function AnnaImportPanel({ onPublished }: { onPublished: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<ImportStep>('select');
  const [result, setResult] = useState<ImportStepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [coverageDropConfirmed, setCoverageDropConfirmed] = useState(false);
  const [contentHash, setContentHash] = useState('');
  const dryRunIsValid = step === 'dry-run'
    && result?.publishable === true
    && result.issues.length === 0
    && result.summary.issueCount === 0;
  const coverageDropRequiresConfirmation = result?.summary.coverageDropRequiresConfirmation === true;
  const hasDryRunSnapshotBinding = result?.hasExpectedActiveSnapshotBinding === true;
  const canStage = dryRunIsValid
    && hasDryRunSnapshotBinding
    && (!coverageDropRequiresConfirmation || coverageDropConfirmed);

  const reset = () => {
    setFileName('');
    setFile(null);
    setStep('select');
    setResult(null);
    setError('');
    setPublishConfirmed(false);
    setCoverageDropConfirmed(false);
    setContentHash('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    reset();
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError('Файл больше 10 МБ — это лимит multipart-импорта.');
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Корнем импортного JSON должен быть объект. Массив backend не принимает.');
      }
      const document = parsed as Record<string, unknown>;
      const expectedRecords = document.expectedRecords;
      if (!Number.isInteger(expectedRecords) || Number(expectedRecords) < 1 || Number(expectedRecords) > 10_000) {
        throw new Error('Поле expectedRecords обязательно и должно быть целым числом от 1 до 10 000.');
      }
      const manifestFields: Array<[string, number, string]> = [
        ['expectedUniquePhones', 10_000, 'уникальных телефонов'],
        ['expectedActivities', 20_000_000, 'активностей'],
        ['expectedExternalIdentities', 500_000, 'внешних ID'],
        ['expectedIncludedFixations', 20_000_000, 'включённых фиксаций'],
        ['expectedIncludedMeetings', 20_000_000, 'включённых встреч'],
        ['expectedIncludedDeals', 20_000_000, 'включённых сделок'],
        ['expectedIncludedBrokerTours', 20_000_000, 'включённых брокер-туров'],
        ['expectedIncludedCalls', 20_000_000, 'включённых звонков'],
      ];
      for (const [field, max, label] of manifestFields) {
        const value = document[field];
        if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) {
          throw new Error(`Поле ${field} обязательно: укажите ожидаемое число ${label} от 0 до ${max.toLocaleString('ru-RU')}.`);
        }
      }
      if (typeof document.expectedIncludedDealAmount !== 'string'
        || !/^\d{1,16}(?:\.\d{1,2})?$/.test(document.expectedIncludedDealAmount)) {
        throw new Error('Поле expectedIncludedDealAmount обязательно: укажите точную сумму включённых сделок строкой в рублях, например "4722766207.00".');
      }
      setFileName(file.name);
      setFile(file);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Некорректный JSON');
    }
  };

  const runDryRun = async () => {
    if (!file || !fileName) return;
    setBusy(true);
    setError('');
    try {
      const next = await dryRunAnnaImport(file);
      if (!next.contentHash) throw new Error('Backend не вернул contentHash; staging заблокирован.');
      setResult(next);
      setContentHash(next.contentHash);
      setCoverageDropConfirmed(false);
      setStep('dry-run');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось выполнить dry-run');
    } finally {
      setBusy(false);
    }
  };

  const stage = async () => {
    if (!file || !contentHash || !canStage || !result) {
      setError(!hasDryRunSnapshotBinding
        ? 'Backend не вернул expectedActiveSnapshotId для привязки dry-run → staging. Повторите dry-run.'
        : coverageDropRequiresConfirmation && !coverageDropConfirmed
        ? 'Подтвердите уменьшение покрытия базы перед staging.'
        : 'Для staging нужен успешный dry-run исходного файла.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await stageAnnaImport(
        file,
        contentHash,
        result.expectedActiveSnapshotId,
        coverageDropConfirmed,
      );
      setResult(next);
      if (next.contentHash) setContentHash(next.contentHash);
      setStep('staged');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось создать staged snapshot');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    const snapshotId = result?.snapshotId || result?.id;
    if (!snapshotId || !contentHash || !publishConfirmed) return;
    if (!result.hasExpectedActiveSnapshotBinding) {
      setError('Backend не вернул expectedActiveSnapshotId для привязки publish. Повторите dry-run и staging.');
      return;
    }
    if (!window.confirm('Опубликовать staged snapshot в «Базу Анны Скибицкой»? Данные «Нашей базы» не будут изменены.')) return;
    setBusy(true);
    setError('');
    try {
      const published = await publishAnnaImport(
        snapshotId,
        contentHash,
        result.expectedActiveSnapshotId,
        coverageDropConfirmed,
      );
      setResult(published);
      setStep('published');
      onPublished();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось опубликовать snapshot');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-4" aria-labelledby="anna-import-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="anna-import-title" className="font-semibold flex items-center gap-2"><UploadCloud className="w-5 h-5 text-accent" />Импорт базы Анны</h2>
          <p className="text-sm text-text-muted mt-1">JSON проходит dry-run и staging. Publish доступен только после явного подтверждения.</p>
        </div>
        {(fileName || step !== 'select') && <button type="button" className="btn btn-secondary" disabled={busy} onClick={reset}>Начать заново</button>}
      </div>

      <ol className="grid grid-cols-2 md:grid-cols-4 gap-2" aria-label="Этапы импорта">
        {stepLabels.map((item, index) => (
          <li key={item.key} className={`rounded-lg px-3 py-2 text-xs font-medium border ${index <= stepIndex(step) ? 'bg-accent/10 text-accent border-accent/20' : 'bg-background text-text-muted border-border'}`}>{item.label}</li>
        ))}
      </ol>

      <label className="block rounded-xl border-2 border-dashed border-border hover:border-accent/50 p-5 cursor-pointer">
        <input ref={fileRef} className="sr-only" type="file" accept="application/json,.json" onChange={chooseFile} disabled={busy || step !== 'select'} />
        <span className="flex items-center gap-3">
          <FileJson className="w-8 h-8 text-accent" />
          <span><b>{fileName || 'Выбрать JSON-файл'}</b><small className="block text-text-muted mt-1">Файл читается в память текущей сессии и не сохраняется в localStorage.</small></span>
        </span>
      </label>

      {error && <div className="rounded-lg bg-error/10 text-error p-3 flex gap-2 text-sm"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{error}</div>}

      {step === 'dry-run' && !dryRunIsValid && (
        <div className="rounded-lg bg-warning/10 text-warning p-3 flex gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          Dry-run не разрешил публикацию. Исправьте указанные ошибки в исходном файле и запустите импорт заново.
        </div>
      )}

      {step === 'dry-run' && dryRunIsValid && !hasDryRunSnapshotBinding && (
        <div className="rounded-lg bg-error/10 text-error p-3 flex gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          Backend не вернул привязку к активному snapshot. Staging заблокирован: повторите dry-run.
        </div>
      )}

      {step === 'dry-run' && dryRunIsValid && coverageDropRequiresConfirmation && (
        <label className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
          <input className="mt-1" type="checkbox" checked={coverageDropConfirmed} onChange={(event) => setCoverageDropConfirmed(event.target.checked)} />
          <span>
            <b>Подтверждаю уменьшение покрытия базы</b>
            <span className="block text-text-muted mt-1">
              Уменьшаются: {result.summary.coverageDrops.length > 0
                ? result.summary.coverageDrops.map((drop) => `${coverageDimensionLabels[drop.dimension] || drop.dimension}: ${drop.current} → ${drop.staged}`).join('; ')
                : `${result.summary.currentPublishedRecords ?? '—'} → ${result.summary.records} записей`}.
              {' '}Staging и publish будут заблокированы без подтверждения для этого перехода.
            </span>
          </span>
        </label>
      )}

      {result && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-4 py-3 bg-surface-secondary font-medium">Результат этапа {result.status ? `· ${result.status}` : ''}</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border-y border-border text-sm">
            {([
              ['Записей', result.summary.records],
              ['Брокеров', result.summary.brokers],
              ['Агентств', result.summary.agencies],
              ['Контактов', result.summary.contactPoints],
              ['Уникальных телефонов', result.summary.uniqueNormalizedPhones],
              ['Внешних ID', result.summary.externalIdentities],
              ['Активностей', result.summary.activities],
              ['Ролей в агентствах', result.summary.organizationRoles],
              ['Кандидатов на сверку', result.summary.candidateCount],
              ['Дубли ключей', result.summary.duplicateSourceKeys],
              ['Некорректные контакты', result.summary.invalidContactPoints],
              ['Неоднозначные записи', result.summary.ambiguousRecords],
              ['Ошибки', result.summary.issueCount],
              ...(result.summary.includedActivities === null ? [] : [['Активностей в KPI', result.summary.includedActivities]]),
              ...(result.summary.includedFixations === null ? [] : [['Фиксаций в KPI', result.summary.includedFixations]]),
              ...(result.summary.includedMeetings === null ? [] : [['Встреч в KPI', result.summary.includedMeetings]]),
              ...(result.summary.includedDeals === null ? [] : [['Сделок в KPI', result.summary.includedDeals]]),
              ...(result.summary.includedBrokerTours === null ? [] : [['Брокер-туров в KPI', result.summary.includedBrokerTours]]),
              ...(result.summary.includedCalls === null ? [] : [['Звонков в KPI', result.summary.includedCalls]]),
              ...(result.summary.includedDealAmount === null ? [] : [['Сумма сделок в KPI', `${result.summary.includedDealAmount} ₽`]]),
              ...(result.summary.excludedActivities === null ? [] : [['Исключено из KPI', result.summary.excludedActivities]]),
              ...(result.summary.currentPublishedRecords === null ? [] : [['Сейчас опубликовано', result.summary.currentPublishedRecords]]),
            ] as Array<[string, string | number]>).map(([label, value]) => (
              <div key={String(label)} className="bg-surface p-3">
                <div className="text-xs text-text-muted">{label}</div>
                <div className="font-semibold mt-1">{value}</div>
              </div>
            ))}
          </div>
          {result.issues.length > 0 && (
            <ul className="p-3 text-sm text-warning list-disc pl-8">
              {result.issues.slice(0, 10).map((issue, index) => (
                <li key={`${issue.row ?? 'document'}-${issue.code}-${index}`}>
                  {issue.row === null || issue.row === 0 ? 'Документ' : `Строка ${issue.row}`}: {issue.code}
                </li>
              ))}
            </ul>
          )}
          {result.summary.unknownActivities !== null && result.summary.unknownActivities > 0 && (
            <div className="border-t border-warning/25 bg-warning/10 text-warning p-3 text-sm flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              Требуют проверки (не входят в KPI): {result.summary.unknownActivities}
            </div>
          )}
        </div>
      )}

      {step === 'staged' && (
        <label className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm">
          <input className="mt-1" type="checkbox" checked={publishConfirmed} onChange={(event) => setPublishConfirmed(event.target.checked)} />
          <span><b>Подтверждаю publish</b><span className="block text-text-muted mt-1">Публикуется только staged snapshot для базы Анны. «Наша база» и источные записи не перезаписываются.</span></span>
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        {step === 'select' && <button type="button" className="btn btn-primary inline-flex items-center gap-2" disabled={!file || busy} onClick={runDryRun}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}1. Запустить dry-run</button>}
        {step === 'dry-run' && <button type="button" className="btn btn-primary inline-flex items-center gap-2" disabled={busy || !canStage} onClick={stage}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}2. Создать staged snapshot</button>}
        {step === 'staged' && <button type="button" className="btn btn-primary inline-flex items-center gap-2" disabled={busy || !publishConfirmed} onClick={publish}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}3. Опубликовать</button>}
        {step === 'published' && <div className="inline-flex items-center gap-2 text-success font-medium"><CheckCircle2 className="w-5 h-5" />Snapshot опубликован</div>}
      </div>
    </section>
  );
}
