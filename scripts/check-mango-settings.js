#!/usr/bin/env node
/**
 * 2026-08-19: read-only проверка — пройдут ли текущие сохранённые на проде
 * значения MANGO_API_URL/MANGO_CALLBACK_URL новую строгую валидацию из
 * PR #288 (packages/integrations/src/mango.adapter.ts). Логика проверки
 * скопирована сюда, а не импортирована из dist — на проде пока крутится
 * старый образ без этих функций (проверка выполняется ДО деплоя PR #288).
 * Если проверка провалится — после деплоя интеграция Mango молча перестанет
 * грузить конфиг из БД (см. code-review PR #288, finding про allowlist).
 *
 * Запуск в контейнере api:
 *   node /app/scripts/check-mango-settings.js
 */

const DEFAULT_MANGO_URL = 'https://app.mango-office.ru/vpbx';
const MANGO_API_HOST = 'app.mango-office.ru';
const MANGO_API_PATH = '/vpbx';
const MANGO_CALLBACK_HOST = 'integration-webhook.mango-office.ru';
const MANGO_CALLBACK_PATH = '/webhookapp/common';
const MANGO_EMPLOYEE_PLACEHOLDER = '{{Ответственный}}';
const MANGO_PHONE_PLACEHOLDER = '{{Телефон}}';

function parseHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label}: указан некорректный URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) {
    throw new Error(`${label}: разрешён только HTTPS URL без credentials, порта и fragment`);
  }
  return parsed;
}

function normalizeMangoApiUrl(value) {
  const candidate = String(value || '').trim() || DEFAULT_MANGO_URL;
  const parsed = parseHttpsUrl(candidate, 'MANGO_API_URL');
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (parsed.hostname.toLowerCase() !== MANGO_API_HOST || path !== MANGO_API_PATH || parsed.search) {
    throw new Error(`MANGO_API_URL: разрешён только https://${MANGO_API_HOST}${MANGO_API_PATH}`);
  }
  return DEFAULT_MANGO_URL;
}

function normalizeMangoCallbackUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  const parsed = parseHttpsUrl(candidate, 'MANGO_CALLBACK_URL');
  if (parsed.hostname.toLowerCase() !== MANGO_CALLBACK_HOST || parsed.pathname !== MANGO_CALLBACK_PATH) {
    throw new Error(`MANGO_CALLBACK_URL: разрешён только https://${MANGO_CALLBACK_HOST}${MANGO_CALLBACK_PATH}`);
  }
  const employeeValues = parsed.searchParams.getAll('EmployeeNUM');
  const phoneValues = parsed.searchParams.getAll('TelNumbr');
  if (employeeValues.length !== 1 || employeeValues[0] !== MANGO_EMPLOYEE_PLACEHOLDER || phoneValues.length !== 1 || phoneValues[0] !== MANGO_PHONE_PLACEHOLDER) {
    throw new Error('MANGO_CALLBACK_URL: должен содержать ровно EmployeeNUM={{Ответственный}} и TelNumbr={{Телефон}}');
  }
  return candidate;
}

(async () => {
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ['MANGO_API_URL', 'MANGO_CALLBACK_URL', 'MANGO_OUTBOUND_LINE'] } },
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    console.log('MANGO_API_URL в БД:', byKey.MANGO_API_URL || '(не задано, будет дефолт)');
    console.log('MANGO_CALLBACK_URL в БД:', byKey.MANGO_CALLBACK_URL ? '(задано, скрыто)' : '(не задано, будет пусто)');
    console.log('MANGO_OUTBOUND_LINE в БД:', byKey.MANGO_OUTBOUND_LINE || '(не задано)');

    try {
      normalizeMangoApiUrl(byKey.MANGO_API_URL || '');
      console.log('MANGO_API_URL: OK, пройдёт новую проверку');
    } catch (e) {
      console.log('MANGO_API_URL: FAIL —', e.message);
    }
    try {
      normalizeMangoCallbackUrl(byKey.MANGO_CALLBACK_URL || '');
      console.log('MANGO_CALLBACK_URL: OK, пройдёт новую проверку');
    } catch (e) {
      console.log('MANGO_CALLBACK_URL: FAIL —', e.message);
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
