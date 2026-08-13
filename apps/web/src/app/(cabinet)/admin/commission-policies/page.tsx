'use client';

import { useEffect, useState } from 'react';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Plus, Edit2, Trash2, X } from 'lucide-react';

// CRUD политик комиссии. Admin only.
// Правка 2026-05-13: добавлена возможность переключения PROGRESSIVE/FLAT для проекта.

const projectLabels: Record<string, string> = { ZORGE9: 'Зорге 9', SILVER_BOR: 'Серебряный Бор' };
const modeLabels: Record<string, string> = { PROGRESSIVE: 'Прогрессивная', FLAT: 'Фиксированная' };

const DEFAULT_LEVELS_ZORGE9 = [
  { level: 'START', minSqm: 0, rate: 5.0 },
  { level: 'BASIC', minSqm: 60, rate: 5.5 },
  { level: 'STRONG', minSqm: 120, rate: 6.0 },
  { level: 'PREMIUM', minSqm: 200, rate: 6.5 },
  { level: 'ELITE', minSqm: 320, rate: 7.0 },
  { level: 'CHAMPION', minSqm: 500, rate: 7.5 },
  { level: 'LEGEND', minSqm: 700, rate: 8.0 },
];
const DEFAULT_LEVELS_SILVER_BOR = [
  { level: 'START', minSqm: 0, rate: 5.0 },
  { level: 'BASIC', minSqm: 48, rate: 5.25 },
  { level: 'STRONG', minSqm: 96, rate: 5.5 },
  { level: 'PREMIUM', minSqm: 171, rate: 5.75 },
  { level: 'ELITE', minSqm: 280, rate: 6.0 },
  { level: 'CHAMPION', minSqm: 400, rate: 6.25 },
];

interface Policy {
  id: string;
  project: string;
  mode: 'PROGRESSIVE' | 'FLAT';
  flatRate: string | null;
  levels: any[] | null;
  installmentEnabled: boolean | null;
  installmentDiscount: number | string | null;
  subsidizedMortgageEnabled: boolean | null;
  subsidizedMortgageRate: number | string | null;
  displayNote: string | null;
  paymentSettingsSource?: 'POLICY' | 'LEGACY_CMS';
  startDate: string;
  endDate: string;
  isActive: boolean;
  notes: string | null;
}

function toDateInput(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function PolicyForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Policy | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [project, setProject] = useState(initial?.project || 'ZORGE9');
  const [mode, setMode] = useState<'PROGRESSIVE' | 'FLAT'>(initial?.mode || 'FLAT');
  const [flatRate, setFlatRate] = useState(initial?.flatRate ? String(initial.flatRate) : '4');
  const [levels, setLevels] = useState<any[]>(
    initial?.levels || (project === 'ZORGE9' ? DEFAULT_LEVELS_ZORGE9 : DEFAULT_LEVELS_SILVER_BOR),
  );
  const [installmentEnabled, setInstallmentEnabled] = useState(initial?.installmentEnabled ?? true);
  const [installmentDiscount, setInstallmentDiscount] = useState(
    initial?.installmentDiscount != null ? String(initial.installmentDiscount) : '0.5',
  );
  const [subsidizedMortgageEnabled, setSubsidizedMortgageEnabled] = useState(
    initial?.subsidizedMortgageEnabled ?? true,
  );
  const [subsidizedMortgageRate, setSubsidizedMortgageRate] = useState(
    initial?.subsidizedMortgageRate != null ? String(initial.subsidizedMortgageRate) : '4',
  );
  const [displayNote, setDisplayNote] = useState(initial?.displayNote || '');
  // Дефолтная дата начала — сегодня, окончание — через год.
  // 2099 в дефолте раньше ломал UX: date picker открывался на 2099 году и
  // приходилось мотать назад. Если нужна «бессрочная» политика — кнопка ниже.
  const today = new Date().toISOString().slice(0, 10);
  const inOneYear = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const [startDate, setStartDate] = useState(initial ? toDateInput(initial.startDate) : today);
  const [endDate, setEndDate] = useState(initial ? toDateInput(initial.endDate) : inOneYear);

  const addYearsToStart = (years: number) => {
    const d = new Date(startDate || today);
    d.setFullYear(d.getFullYear() + years);
    return d.toISOString().slice(0, 10);
  };
  const endYear = (endDate || '').slice(0, 4);
  const setEndYear = (year: string) => {
    const y = year.replace(/\D/g, '').slice(0, 4);
    if (y.length !== 4) return;
    setEndDate(`${y}${(endDate || '2026-12-31').slice(4)}`);
  };
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [notes, setNotes] = useState(initial?.notes || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // При смене проекта подгружаем дефолтные уровни (если режим PROGRESSIVE и форма новая)
  useEffect(() => {
    if (initial) return;
    if (mode === 'PROGRESSIVE') {
      setLevels(project === 'ZORGE9' ? DEFAULT_LEVELS_ZORGE9 : DEFAULT_LEVELS_SILVER_BOR);
    }
  }, [project, mode, initial]);

  const handleSave = async () => {
    setErr('');
    setSaving(true);
    try {
      const payload: any = {
        project,
        mode,
        startDate: new Date(startDate + 'T00:00:00Z').toISOString(),
        endDate: new Date(endDate + 'T23:59:59Z').toISOString(),
        isActive,
        notes: notes || null,
        installmentEnabled,
        installmentDiscount: Number(installmentDiscount),
        subsidizedMortgageEnabled,
        subsidizedMortgageRate: Number(subsidizedMortgageRate),
        displayNote: displayNote || null,
      };
      if (mode === 'FLAT') {
        payload.flatRate = Number(flatRate);
        payload.levels = null;
      } else {
        payload.levels = levels;
        payload.flatRate = null;
      }
      if (initial) {
        await api(`/admin/commission-policies/${initial.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/admin/commission-policies', { method: 'POST', body: JSON.stringify(payload) });
      }
      onSave();
    } catch (e: any) {
      setErr(e?.message || 'Ошибка');
    } finally {
      setSaving(false);
    }
  };

  const updateLevel = (idx: number, key: 'minSqm' | 'rate', val: string) => {
    setLevels((prev) => prev.map((l, i) => (i === idx ? { ...l, [key]: Number(val) } : l)));
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        className="bg-surface rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="absolute top-4 right-4 text-text-muted hover:text-text" onClick={onCancel}>
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-xl font-bold mb-4">{initial ? 'Редактировать политику' : 'Создать политику'}</h2>

        {err && (
          <div className="p-3 bg-error/10 text-error rounded-lg text-sm mb-4">{err}</div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-sm text-text-muted block mb-1">Проект</label>
            <select className="input w-full" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="ZORGE9">Зорге 9</option>
              <option value="SILVER_BOR">Серебряный Бор</option>
            </select>
          </div>
          <div>
            <label className="text-sm text-text-muted block mb-1">Режим</label>
            <select className="input w-full" value={mode} onChange={(e) => setMode(e.target.value as any)}>
              <option value="PROGRESSIVE">Прогрессивная</option>
              <option value="FLAT">Фиксированная</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-sm text-text-muted block mb-1">Начало</label>
            <input type="date" className="input w-full" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="text-sm text-text-muted block mb-1">Конец</label>
            <div className="flex gap-2">
              <input type="date" className="input flex-1" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              <input
                type="text"
                inputMode="numeric"
                maxLength={4}
                className="input w-20 text-center"
                value={endYear}
                onChange={(e) => setEndYear(e.target.value)}
                placeholder="год"
                title="Можно ввести год вручную"
              />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs">
              <button type="button" className="text-accent hover:underline" onClick={() => setEndDate(addYearsToStart(1))}>+1 год</button>
              <button type="button" className="text-accent hover:underline" onClick={() => setEndDate(addYearsToStart(3))}>+3 года</button>
              <button type="button" className="text-accent hover:underline" onClick={() => setEndDate(addYearsToStart(5))}>+5 лет</button>
              <button type="button" className="text-accent hover:underline" onClick={() => setEndDate('2099-12-31')}>Бессрочно</button>
            </div>
          </div>
        </div>

        {mode === 'FLAT' && (
          <div className="mb-4">
            <label className="text-sm text-text-muted block mb-1">Ставка (%)</label>
            <input
              type="number"
              step="0.01"
              className="input w-full"
              value={flatRate}
              onChange={(e) => setFlatRate(e.target.value)}
              placeholder="4.00"
            />
          </div>
        )}

        {mode === 'PROGRESSIVE' && (
          <div className="mb-4">
            <label className="text-sm text-text-muted block mb-2">Шкала уровней</label>
            <div className="space-y-2">
              {levels.map((lvl, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center text-sm">
                  <div className="col-span-3 font-medium">{lvl.level}</div>
                  <div className="col-span-4">
                    <input
                      type="number"
                      className="input w-full"
                      value={lvl.minSqm}
                      onChange={(e) => updateLevel(i, 'minSqm', e.target.value)}
                      placeholder="от м²"
                    />
                  </div>
                  <div className="col-span-1 text-text-muted">м²</div>
                  <div className="col-span-3">
                    <input
                      type="number"
                      step="0.01"
                      className="input w-full"
                      value={lvl.rate}
                      onChange={(e) => updateLevel(i, 'rate', e.target.value)}
                      placeholder="ставка"
                    />
                  </div>
                  <div className="col-span-1 text-text-muted">%</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-4 border-t border-border pt-4">
          <h3 className="font-semibold mb-1">Условия оплаты</h3>
          <p className="text-xs text-text-muted mb-3">
            Эти значения одновременно используются калькулятором, кабинетом брокера и лендингом.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="border border-border rounded-lg p-3">
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={installmentEnabled}
                  onChange={(e) => setInstallmentEnabled(e.target.checked)}
                />
                <span className="text-sm font-medium">Рассрочка доступна</span>
              </label>
              <label className="text-sm text-text-muted block mb-1">Снижение комиссии, п. п.</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.05"
                className="input w-full"
                value={installmentDiscount}
                disabled={!installmentEnabled}
                onChange={(e) => setInstallmentDiscount(e.target.value)}
              />
            </div>
            <div className="border border-border rounded-lg p-3">
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={subsidizedMortgageEnabled}
                  onChange={(e) => setSubsidizedMortgageEnabled(e.target.checked)}
                />
                <span className="text-sm font-medium">Субсидированная ипотека доступна</span>
              </label>
              <label className="text-sm text-text-muted block mb-1">Фиксированная комиссия, %</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.05"
                className="input w-full"
                value={subsidizedMortgageRate}
                disabled={!subsidizedMortgageEnabled}
                onChange={(e) => setSubsidizedMortgageRate(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="mb-4">
          <label className="text-sm text-text-muted block mb-1">Публичное пояснение (необязательно)</label>
          <textarea
            className="input w-full"
            rows={2}
            value={displayNote}
            onChange={(e) => setDisplayNote(e.target.value)}
            placeholder="Например: единая ставка при 100% оплате или ипотеке"
          />
        </div>

        <div className="mb-4">
          <label className="text-sm text-text-muted block mb-1">Комментарий (необязательно)</label>
          <textarea
            className="input w-full"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Например: новая акция с 7 мая"
          />
        </div>

        <div className="mb-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span className="text-sm">Активна</span>
          </label>
        </div>

        <div className="flex gap-3 justify-end">
          <button className="btn btn-secondary" onClick={onCancel} disabled={saving}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CommissionPoliciesPage() {
  const { broker } = useAuth();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [editPolicy, setEditPolicy] = useState<Policy | null>(null);
  const [creating, setCreating] = useState(false);

  if (broker && broker.role !== 'ADMIN') {
    return <div className="card">Доступ только для администраторов</div>;
  }

  const fetchPolicies = () => {
    setLoading(true);
    apiGet('/admin/commission-policies')
      .then(setPolicies)
      .catch(() => setPolicies([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchPolicies();
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить политику безвозвратно?')) return;
    try {
      await api(`/admin/commission-policies/${id}`, { method: 'DELETE' });
      fetchPolicies();
    } catch (e: any) {
      alert(e?.message || 'Ошибка');
    }
  };

  const today = new Date();
  const isActiveNow = (p: Policy) =>
    p.isActive && new Date(p.startDate) <= today && new Date(p.endDate) >= today;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Комиссия и рассрочка</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus className="w-4 h-4 mr-1" />
          Создать политику
        </button>
      </div>

      <p className="text-sm text-text-muted mb-4">
        Единое место для ставки, шкалы и условий оплаты. Сохранённая активная политика сразу используется в расчёте, кабинете и на лендинге. Перекрытие активных периодов одного проекта запрещено.
      </p>

      {loading ? (
        <div className="card">Загрузка...</div>
      ) : policies.length === 0 ? (
        <div className="card text-text-muted">Политик ещё нет. Создайте первую через кнопку выше.</div>
      ) : (
        <div className="card">
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="text-text-muted text-left border-b border-border">
                <th className="pb-3 font-medium">Проект</th>
                <th className="pb-3 font-medium">Режим</th>
                <th className="pb-3 font-medium">Ставка</th>
                <th className="pb-3 font-medium">Условия оплаты</th>
                <th className="pb-3 font-medium">Период</th>
                <th className="pb-3 font-medium">Статус</th>
                <th className="pb-3 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="py-3 font-medium">{projectLabels[p.project] || p.project}</td>
                  <td className="py-3">{modeLabels[p.mode] || p.mode}</td>
                  <td className="py-3">
                    {p.mode === 'FLAT'
                      ? `${Number(p.flatRate).toFixed(2)}%`
                      : p.levels
                      ? `${p.levels[0]?.rate}% — ${p.levels[p.levels.length - 1]?.rate}%`
                      : '—'}
                  </td>
                  <td className="py-3 text-xs text-text-muted">
                    <div>{p.installmentEnabled ? `Рассрочка: −${String(p.installmentDiscount).replace('.', ',')} п. п.` : 'Рассрочка выключена'}</div>
                    <div>{p.subsidizedMortgageEnabled ? `Субс. ипотека: ${String(p.subsidizedMortgageRate).replace('.', ',')}%` : 'Субс. ипотека выключена'}</div>
                    {p.paymentSettingsSource === 'LEGACY_CMS' && (
                      <div className="text-warning mt-1">Будут перенесены в политику при сохранении</div>
                    )}
                  </td>
                  <td className="py-3 text-text-muted">
                    {toDateInput(p.startDate)} — {toDateInput(p.endDate)}
                  </td>
                  <td className="py-3">
                    {!p.isActive ? (
                      <span className="text-xs px-2 py-1 rounded bg-text-muted/20 text-text-muted">Отключена</span>
                    ) : isActiveNow(p) ? (
                      <span className="text-xs px-2 py-1 rounded bg-success/20 text-success">Действует</span>
                    ) : new Date(p.startDate) > today ? (
                      <span className="text-xs px-2 py-1 rounded bg-info/20 text-info">В будущем</span>
                    ) : (
                      <span className="text-xs px-2 py-1 rounded bg-warning/20 text-warning">Закончилась</span>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    <button
                      className="p-2 hover:bg-surface-secondary rounded-lg text-text-muted hover:text-accent"
                      onClick={() => setEditPolicy(p)}
                      title="Редактировать"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      className="p-2 hover:bg-surface-secondary rounded-lg text-text-muted hover:text-error"
                      onClick={() => handleDelete(p.id)}
                      title="Удалить"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {creating && (
        <PolicyForm onSave={() => { setCreating(false); fetchPolicies(); }} onCancel={() => setCreating(false)} />
      )}
      {editPolicy && (
        <PolicyForm
          initial={editPolicy}
          onSave={() => { setEditPolicy(null); fetchPolicies(); }}
          onCancel={() => setEditPolicy(null)}
        />
      )}
    </div>
  );
}
