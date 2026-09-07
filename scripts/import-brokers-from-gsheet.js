#!/usr/bin/env node
/**
 * Импорт базы брокеров напрямую из Google Sheets через Google Sheets API.
 *
 * TZ v3 §3 этап 1 (живой источник): альтернатива XLSX-снэпшоту.
 *
 * Аутентификация — через Google Service Account:
 *   - В env GOOGLE_SERVICE_ACCOUNT_JSON   — полное содержимое JSON-ключа (одной строкой)
 *   - ИЛИ через файл GOOGLE_SA_FILE       — путь к JSON-ключу
 *
 * Таблица должна быть расшарена на email service account'а (Editor/Viewer).
 *
 * Запуск (внутри контейнера api):
 *   node scripts/import-brokers-from-gsheet.js --filter ALL --call-flag "да" --dry-run
 *   node scripts/import-brokers-from-gsheet.js --filter ALL --call-flag "да"
 *   node scripts/import-brokers-from-gsheet.js --list-tabs   # показать листы таблицы и выйти
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { runImport, VALID_CATEGORIES, VALID_CALL_FLAGS } = require('./_lib/brokers-import');

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

const DEFAULT_SHEET_ID = '1HYiRxnRb0psYzKZmD7f34gdMgNR6gso8Swj8pj9cAC8';
const sheetId = arg('sheet-id') || process.env.BROKER_SHEET_ID || DEFAULT_SHEET_ID;
const mainTab = arg('main-tab') || process.env.BROKER_MAIN_TAB || null;   // null = первый лист
const coordTab = arg('coord-tab') || process.env.BROKER_COORD_TAB || null; // null = второй лист
const listTabsOnly = !!arg('list-tabs');

// ─── Auth ───────────────────────────────────────────────────────────────────

function getServiceAccountCreds() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (e) {
      console.error('ERR: GOOGLE_SERVICE_ACCOUNT_JSON не парсится как JSON:', e.message);
      process.exit(2);
    }
  }
  const filePath = process.env.GOOGLE_SA_FILE;
  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`ERR: GOOGLE_SA_FILE указан, но файл не найден: ${filePath}`);
      process.exit(2);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  console.error('ERR: нет креденшелов Google. Установи env GOOGLE_SERVICE_ACCOUNT_JSON (содержимое JSON) или GOOGLE_SA_FILE (путь к файлу).');
  process.exit(2);
}

async function makeSheetsClient() {
  const creds = getServiceAccountCreds();
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── Reading ────────────────────────────────────────────────────────────────

async function listTabs(sheets, sheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  return meta.data.sheets.map((s) => ({
    title: s.properties.title,
    index: s.properties.index,
    rowCount: s.properties.gridProperties.rowCount,
    colCount: s.properties.gridProperties.columnCount,
  }));
}

/**
 * Читает диапазон с листа и превращает в массив объектов { header → value }.
 * Первая строка — заголовки.
 */
async function readTabAsObjects(sheets, sheetId, tabTitle) {
  const range = `${tabTitle}!A:Z`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const values = resp.data.values || [];
  if (values.length < 2) return [];
  const headers = values[0].map((h) => String(h ?? ''));
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r || r.every((v) => v === '' || v === null || v === undefined)) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = r[c] !== undefined ? r[c] : null;
    }
    rows.push(obj);
  }
  return rows;
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
  const sheets = await makeSheetsClient();

  if (listTabsOnly) {
    const tabs = await listTabs(sheets, sheetId);
    console.log(`Spreadsheet: ${sheetId}`);
    console.log('Листы:');
    for (const t of tabs) {
      console.log(`  [${t.index}] "${t.title}"  rows=${t.rowCount}  cols=${t.colCount}`);
    }
    process.exit(0);
  }

  // CLI args — те же что у xlsx-скрипта
  const filterArg = arg('filter');
  if (!filterArg || filterArg === true) {
    console.error('ERR: --filter обязателен. Пример: --filter ALL  или  --filter COLD,WARM');
    console.error('Допустимо:', VALID_CATEGORIES.join(', '), 'ALL');
    process.exit(2);
  }
  const filter = filterArg.toUpperCase() === 'ALL'
    ? new Set(VALID_CATEGORIES)
    : new Set(filterArg.split(',').map((s) => s.trim().toUpperCase()));
  for (const c of filter) {
    if (!VALID_CATEGORIES.includes(c)) {
      console.error(`ERR: неизвестная категория в --filter: ${c}`);
      process.exit(2);
    }
  }

  const callFlagArg = arg('call-flag');
  let callFlagFilter = null;
  if (callFlagArg && callFlagArg !== true) {
    callFlagFilter = new Set(callFlagArg.split(',').map((s) => s.trim().toLowerCase()));
    for (const f of callFlagFilter) {
      if (!VALID_CALL_FLAGS.includes(f)) {
        console.error(`ERR: неизвестное значение --call-flag: ${f}`);
        process.exit(2);
      }
    }
  }

  const isDryRun = !!arg('dry-run');
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null;
  const includeCoords = !!arg('include-coords');

  // Резолвим имена листов: если не заданы — берём по индексу
  const tabs = await listTabs(sheets, sheetId);
  if (tabs.length === 0) {
    console.error('ERR: в таблице нет листов?');
    process.exit(2);
  }
  const mainTabTitle = mainTab || tabs[0].title;
  const coordTabTitle = includeCoords ? (coordTab || (tabs[1] && tabs[1].title)) : null;

  console.log(`Spreadsheet: ${sheetId}`);
  console.log(`Основной лист: "${mainTabTitle}"`);
  if (coordTabTitle) console.log(`Лист координаторов: "${coordTabTitle}"`);

  console.log('Читаю основной лист…');
  const rows = await readTabAsObjects(sheets, sheetId, mainTabTitle);
  console.log(`  получено строк: ${rows.length}`);

  let coordRows = [];
  if (coordTabTitle) {
    console.log('Читаю лист координаторов…');
    coordRows = await readTabAsObjects(sheets, sheetId, coordTabTitle);
    console.log(`  получено строк: ${coordRows.length}`);
  }

  await runImport({
    rows,
    coordRows,
    filter,
    callFlagFilter,
    limit,
    isDryRun,
    baseSource: 'google_sheet',
    includeCoords,
  });
})().catch((e) => {
  console.error('FATAL:', e?.message || e);
  if (e?.response?.data) console.error('Google API:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
