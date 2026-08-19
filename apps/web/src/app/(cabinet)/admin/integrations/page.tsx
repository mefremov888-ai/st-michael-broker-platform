'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Plug, Save, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';

// 2026-06-04: страница админ-настроек интеграций. Сейчас только Morekit URL,
// но архитектура расширяема — добавляй ключи в SETTINGS_META, в whitelist
// admin.service.INTEGRATION_KEYS и описание ниже.

interface SettingRow {
  key: string;
  dbValue: string | null;
  envValue: string;
  currentValue: string;
  updatedAt: string | null;
  updatedBy: string | null;
  isSecret?: boolean;
}

const SETTINGS_META: Record<string, { label: string; description: string; placeholder: string }> = {
  MOREKIT_WEBHOOK_URL: {
    label: 'Morekit URL',
    description:
      'Endpoint Morekit\'а для прямой отправки фиксаций (без Salesbot в amoCRM). ' +
      'Анна периодически даёт новый URL («копия предыдущего процесса») — поэтому правится из UI без релиза.',
    placeholder: 'https://ep.morekit.io/...',
  },
  AMO_ACCESS_TOKEN: {
    label: 'amoCRM access token',
    description:
      'Долгоживущий токен для запросов в amoCRM API. JWT-строка из настроек интеграции amoCRM. ' +
      'При 401 адаптер сам пытается обновить через refresh_token — но если refresh нет, надо ввести access вручную.',
    placeholder: 'eyJ0eXAiOiJKV1Qi...',
  },
  AMO_REFRESH_TOKEN: {
    label: 'amoCRM refresh token',
    description:
      'Refresh-токен для авто-обновления access_token. Получается при первичной OAuth-авторизации. ' +
      'Если задан + есть AMO_CLIENT_ID/SECRET в env, адаптер сам обновит access при 401 без участия человека.',
    placeholder: 'def502...',
  },
  MANGO_API_KEY: {
    label: 'Mango VPBX — уникальный код АТС',
    description:
      '«Уникальный код вашей АТС» из ЛК Mango (vpbx_api_key). Используется как идентификатор приложения и часть SHA-256 подписи каждого запроса.',
    placeholder: 'vpbx_api_key',
  },
  MANGO_API_SALT: {
    label: 'Mango VPBX — ключ для подписи',
    description:
      '«Ключ для создания подписи» из ЛК Mango (vpbx_api_salt). SHA-256 от точной строки (api_key + json + salt) идёт в параметр sign.',
    placeholder: '64-символьный ключ подписи',
  },
  MANGO_API_URL: {
    label: 'Mango VPBX — API URL',
    description:
      'Разрешён только официальный базовый URL VPBX API: https://app.mango-office.ru/vpbx. Другие host и path backend отклонит.',
    placeholder: 'https://app.mango-office.ru/vpbx',
  },
  MANGO_CALLBACK_URL: {
    label: 'Mango — Callback URL (integration-webhook)',
    description:
      'Полный URL шаблона от Mango с плейсхолдерами {{Ответственный}} и {{Телефон}}. ' +
      'Используется для click-to-call вместо VPBX API. Например: ' +
      'https://integration-webhook.mango-office.ru/webhookapp/common?code=...&Source=Other&API_key=...&Action=Callback&EmployeeNUM={{Ответственный}}&TelNumbr={{Телефон}}. ' +
      'Лимит 20 звонков/мин (проверяется в коде).',
    placeholder: 'https://integration-webhook.mango-office.ru/webhookapp/common?code=...&EmployeeNUM={{Ответственный}}&TelNumbr={{Телефон}}',
  },
  MANGO_OUTBOUND_LINE: {
    label: 'Mango — исходящая линия',
    description:
      'Caller ID для исходящих callback-звонков. Укажите 10–15 цифр; форматирование и знак + будут удалены. ' +
      'Если поле пустое, Mango использует линию аккаунта по умолчанию.',
    placeholder: '74990000000',
  },
  GSHEETS_BROKERS_URL: {
    label: 'Google Sheets — URL CSV-экспорта базы брокеров',
    description:
      'Публичная Google Sheet (расшарена «по ссылке: любой может смотреть») с базой брокеров. ' +
      'Формат URL: https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<GID>. ' +
      'Каждые 30 минут scheduler скачивает и upsert\'ит брокеров по телефону. Колонки: Имя | Телефон брокера | Кол-во заявок | Встречи | Сделки | ЗВОНОК | Результат звонка | Обзвон по Зорге | Комментарий.',
    placeholder: 'https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=0',
  },
};

export default function AdminIntegrationsPage() {
  const { broker } = useAuth();
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ key: string; ok: boolean; text: string } | null>(null);

  if (broker && broker.role !== 'ADMIN') {
    return <div className="card">Доступ запрещён (только ADMIN)</div>;
  }

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiGet<SettingRow[]>('/admin/integration-settings');
      setSettings(data || []);
      const init: Record<string, string> = {};
      // Для секретов в edits НЕ кладём dbValue (это маска вида «…abc123 (1024 симв.)»).
      // Иначе сохранение перетёрло бы реальный токен этой маской.
      (data || []).forEach((s) => { init[s.key] = s.isSecret ? '' : (s.dbValue ?? ''); });
      setEdits(init);
    } catch (e: any) {
      setMsg({ key: '', ok: false, text: e?.message || 'Не удалось загрузить настройки' });
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const save = async (key: string) => {
    setSavingKey(key);
    setMsg(null);
    try {
      await apiPatch(`/admin/integration-settings/${encodeURIComponent(key)}`, {
        value: edits[key] || '',
      });
      setMsg({ key, ok: true, text: 'Сохранено. Применится при следующей фиксации.' });
      await load();
    } catch (e: any) {
      setMsg({ key, ok: false, text: e?.message || 'Ошибка сохранения' });
    } finally {
      setSavingKey(null);
      setTimeout(() => setMsg((m) => (m?.key === key ? null : m)), 5000);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-6">
        <Plug className="w-6 h-6 text-accent" />
        <h1 className="text-2xl md:text-3xl font-bold">Интеграции</h1>
      </div>

      {loading ? (
        <div className="card text-text-muted">Загрузка…</div>
      ) : (
        <div className="space-y-4">
          {settings.map((s) => {
            const meta = SETTINGS_META[s.key] || { label: s.key, description: '', placeholder: '' };
            const editValue = edits[s.key] || '';
            // Для секрета: dirty если пользователь ввёл что-то непустое (любая новая
            // строка → перезапишет токен). Для обычных — dirty если значение поменялось
            // относительно того, что в БД.
            const dirty = s.isSecret ? editValue.length > 0 : editValue !== (s.dbValue ?? '');
            const usingEnvFallback = !s.dbValue && Boolean(s.envValue);
            const hasDbValue = Boolean(s.dbValue);
            return (
              <div key={s.key} className="card">
                <div className="flex items-start justify-between gap-4 mb-2">
                  <div>
                    <h2 className="text-lg font-semibold">{meta.label}</h2>
                    <div className="text-xs text-text-muted font-mono mt-0.5">{s.key}</div>
                  </div>
                  <div className="text-xs text-right text-text-muted">
                    {s.updatedAt ? (
                      <>
                        <div>Изменено: {new Date(s.updatedAt).toLocaleString('ru-RU')}</div>
                        {s.updatedBy && <div className="opacity-60">{s.updatedBy.slice(0, 8)}</div>}
                      </>
                    ) : (
                      <div className="opacity-60">не задано в БД</div>
                    )}
                  </div>
                </div>

                {meta.description && (
                  <p className="text-sm text-text-muted mb-3">{meta.description}</p>
                )}

                <div className="space-y-2">
                  {s.isSecret && hasDbValue && (
                    <div className="text-xs text-success flex items-center gap-1 mb-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Текущее значение: <span className="font-mono">{s.currentValue}</span>. Поле ниже пустое — введи только если нужно перезаписать.
                    </div>
                  )}
                  <input
                    type={s.isSecret ? 'password' : 'text'}
                    autoComplete="off"
                    className="input font-mono text-sm"
                    placeholder={meta.placeholder}
                    value={editValue}
                    onChange={(e) => setEdits({ ...edits, [s.key]: e.target.value })}
                  />

                  {usingEnvFallback && (
                    <div className="text-xs text-warning flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      Сейчас используется значение из env: <span className="font-mono">{s.envValue}</span>. Сохрани здесь, чтобы перезаписать.
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="btn btn-primary flex items-center gap-2"
                      onClick={() => save(s.key)}
                      disabled={!dirty || savingKey === s.key}
                    >
                      <Save className="w-4 h-4" />
                      {savingKey === s.key ? 'Сохраняю…' : 'Сохранить'}
                    </button>
                    {msg?.key === s.key && (
                      <div className={`text-sm flex items-center gap-1 ${msg.ok ? 'text-success' : 'text-error'}`}>
                        {msg.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                        {msg.text}
                      </div>
                    )}
                  </div>

                  {/* 2026-06-09: спец-кнопка ручного запуска синка Google Sheets
                      рядом с полем URL. Cron запускается сам каждые 30 мин, но
                      админу нужно дёрнуть сразу после сохранения URL. */}
                  {s.key === 'GSHEETS_BROKERS_URL' && (
                    <GSheetsSyncRow />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 2026-06-09: блок ручного триггера Google Sheets sync прямо из карточки
 * GSHEETS_BROKERS_URL. Полезен при первой настройке URL и для проверки.
 * Сам показывает результат последнего запуска (running / lastRunAt /
 * total / created / updated / errors).
 */
function GSheetsSyncRow() {
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<any>(null);

  const loadStatus = async () => {
    try {
      const r = await apiGet<any>('/admin/gsheets-brokers/status');
      setLast(r);
    } catch {}
  };
  useEffect(() => { loadStatus(); }, []);

  const trigger = async () => {
    setRunning(true);
    try {
      const r = await apiPost<any>('/admin/gsheets-brokers/sync-now', {});
      setLast({ lastRunAt: new Date().toISOString(), lastResult: r });
    } catch (e: any) {
      setLast({ lastResult: { ok: false, error: e?.message || 'Ошибка' } });
    } finally {
      setRunning(false);
    }
  };

  const r = last?.lastResult;
  return (
    <div className="mt-4 pt-3 border-t border-border">
      <div className="flex items-center gap-3 mb-2">
        <button
          type="button"
          className="btn btn-secondary flex items-center gap-2 text-sm"
          onClick={trigger}
          disabled={running}
        >
          <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} />
          {running ? 'Синкаю…' : 'Запустить синк сейчас'}
        </button>
        <span className="text-xs text-text-muted">
          Обычно ~5-15 сек. Cron в фоне дёргает каждые 30 мин.
        </span>
      </div>

      {r && (
        <div className={`text-sm rounded px-3 py-2 ${r.ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
          {r.ok ? (
            <>
              ✓ Синк ОК. Строк в таблице: <b>{r.total}</b> · создано: <b>{r.created}</b> · обновлено: <b>{r.updated}</b>
              {r.errors > 0 && <> · ошибок: <b>{r.errors}</b></>}
              {r.durationMs && <> · {Math.round(r.durationMs / 1000)} сек</>}
            </>
          ) : (
            <>✗ Ошибка: {r.error || 'неизвестная ошибка'}</>
          )}
        </div>
      )}

      {last?.lastRunAt && !r && (
        <div className="text-xs text-text-muted">
          Последний запуск: {new Date(last.lastRunAt).toLocaleString('ru-RU')}
        </div>
      )}
    </div>
  );
}
