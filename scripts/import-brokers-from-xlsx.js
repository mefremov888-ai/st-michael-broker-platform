#!/usr/bin/env node
/**
 * Импорт базы брокеров из XLSX-экспорта Google Sheets в нашу БД.
 *
 * TZ v3 §3 этап 1: миграция 10 837 строк + начальные CallLog записи.
 * Источник: "скриншоты и файлы для корректировки/Для кабинета брокера/корректировка КБ3/БАЗА брокеров.xlsx"
 *
 * Запуск (локально, не в Docker):
 *   node scripts/import-brokers-from-xlsx.js --filter COLD --dry-run
 *   node scripts/import-brokers-from-xlsx.js --filter COLD,WARM --limit 100
 *   node scripts/import-brokers-from-xlsx.js --filter ALL
 *
 * Фильтр обязателен — указывает какие BrokerCategory импортировать.
 * Допустимые значения: COLD, WARM, HOT, CONVERTED, ON_BOT_REVIEW, BLACKLIST, ALL
 *
 * Требует переменную DATABASE_URL в env.
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return true; // flag
  return next;
}

const VALID_CATEGORIES = ['COLD', 'WARM', 'HOT', 'CONVERTED', 'ON_BOT_REVIEW', 'BLACKLIST'];

const filterArg = arg('filter');
if (!filterArg || filterArg === true) {
  console.error('ERR: --filter обязателен. Пример: --filter COLD  или  --filter ALL  или  --filter COLD,WARM');
  console.error('Допустимо:', VALID_CATEGORIES.join(', '), 'ALL');
  process.exit(2);
}
const filter = filterArg.toUpperCase() === 'ALL'
  ? new Set(VALID_CATEGORIES)
  : new Set(filterArg.split(',').map(s => s.trim().toUpperCase()));
for (const c of filter) {
  if (!VALID_CATEGORIES.includes(c)) {
    console.error(`ERR: неизвестная категория в --filter: ${c}`);
    console.error('Допустимо:', VALID_CATEGORIES.join(', '));
    process.exit(2);
  }
}

const isDryRun = !!arg('dry-run');
const limit = arg('limit') ? parseInt(arg('limit'), 10) : null;
const xlsxPath = arg('xlsx') || path.join(
  __dirname, '..',
  'docs',
  'БАЗА брокеров (2).xlsx'
);
const baseSource = arg('source') || 'google_sheet';
const includeCoords = !!arg('include-coords');

// --call-flag — фильтр по столбцу F (ЗВОНОК): 'да' | 'в работе' | 'обработан'
// Можно через запятую: --call-flag "да,обработан"   Без флага = пропустить все.
const VALID_CALL_FLAGS = ['да', 'в работе', 'обработан'];
const callFlagArg = arg('call-flag');
let callFlagFilter = null; // null = не фильтруем
if (callFlagArg && callFlagArg !== true) {
  callFlagFilter = new Set(callFlagArg.split(',').map(s => s.trim().toLowerCase()));
  for (const f of callFlagFilter) {
    if (!VALID_CALL_FLAGS.includes(f)) {
      console.error(`ERR: неизвестное значение --call-flag: ${f}`);
      console.error('Допустимо:', VALID_CALL_FLAGS.map(s => `"${s}"`).join(', '));
      process.exit(2);
    }
  }
}

if (!fs.existsSync(xlsxPath)) {
  console.error(`ERR: XLSX не найден: ${xlsxPath}`);
  process.exit(2);
}

// ─── Phone normalization (TZ v3 §2.11) ────────────────────────────────────────

function normalizePhone(input) {
  if (input === null || input === undefined || input === '') {
    return { ok: false, reason: 'empty' };
  }
  const digits = String(input).replace(/\D/g, '');
  const n = digits.length;
  if (n < 10) return { ok: false, reason: 'too_short', raw: digits };
  if (n === 10) return { ok: true, phone: '+7' + digits };
  if (n === 11) {
    if (digits[0] === '7' && digits[1] === '7') {
      // 11 digits, starts 77 — TZ говорит truncated, last digit lost → INVALID
      return { ok: false, reason: 'truncated_77', raw: digits };
    }
    if (digits[0] === '7') return { ok: true, phone: '+' + digits };
    if (digits[0] === '8') return { ok: true, phone: '+7' + digits.slice(1) };
    // 11 digits с другой первой цифрой — иностранный, оставляем
    return { ok: true, phone: '+' + digits, foreign: true };
  }
  if (n === 12) {
    if (digits.startsWith('77')) {
      // дубль +7 — отбрасываем первую 7
      return { ok: true, phone: '+' + digits.slice(1) };
    }
    return { ok: true, phone: '+' + digits, foreign: true };
  }
  // 13+ — иностранный с кодом страны
  return { ok: true, phone: '+' + digits, foreign: true };
}

// ─── Mappings (TZ v3 §2.2 + §5) ───────────────────────────────────────────────

const RESULT_MAP = {
  'НДЗ': { category: 'COLD', result: 'NDZ' },
  '2 НДЗ': { category: 'ON_BOT_REVIEW', result: 'DOUBLE_NDZ' },
  'Проинформирован о новых условиях': { category: 'WARM', result: 'INFORMED' },
  'Уже был, на ТГ подписан': { category: 'WARM', result: 'ALREADY_KNOWS' },
  'Некорректный номер': { category: 'BLACKLIST', result: 'WRONG_NUMBER' },
  'Отказ от коммуникации': { category: 'ON_BOT_REVIEW', result: 'REFUSED_COMMUNICATION' },
  'НЕ брокер': { category: 'BLACKLIST', result: 'NOT_A_BROKER' },
  'Запись на БТ': { category: 'HOT', result: 'SCHEDULED_TOUR' },
  'Только отправить инфо': { category: 'WARM', result: 'ONLY_SEND_INFO' },
  'В работе': { category: 'HOT', result: 'IN_PROGRESS' },
  'Отказ от БТ': { category: 'WARM', result: 'REFUSED_TOUR' },
};

const ZORGE_MAP = {
  'НДЗ': 'NDZ',
  'Проинформирован': 'INFORMED',
  'Бросил трубку': 'HUNG_UP',
  'неактуально/не интересно': 'NOT_RELEVANT',
  'Только отправить инфо': 'ONLY_SEND_INFO',
  'Запись на БТ': 'SCHEDULED_TOUR',
  'Некорректный номер': 'WRONG_NUMBER',
  'уже не брокер': 'NOT_BROKER_ANYMORE',
  'Просил не звонить': 'ASKED_NOT_TO_CALL',
  'Негатив на звонок': 'NEGATIVE',
};

function mapRow(row) {
  // row keys per header: 'Имя', 'Телефон брокера', 'Кол-во заявок на уникальность',
  //   'Встречи', 'Сделки', 'ЗВОНОК', 'Результат звонка', 'Обзвон по Зорге ', 'Комментарий'
  const name = (row['Имя'] || '').toString().trim();
  const phoneRaw = row['Телефон брокера'];
  const meetings = Number(row['Встречи'] || 0);
  const deals = Number(row['Сделки'] || 0);
  const callFlag = (row['ЗВОНОК'] || '').toString().trim().toLowerCase();
  const resultStr = (row['Результат звонка'] || '').toString().trim();
  const zorgeStr = (row['Обзвон по Зорге '] || row['Обзвон по Зорге'] || '').toString().trim();
  const comment = (row['Комментарий'] || '').toString().trim() || null;

  const mapped = RESULT_MAP[resultStr] || { category: 'COLD', result: null };
  const zorgeResult = ZORGE_MAP[zorgeStr] || null;

  // CONVERTED overrides если есть встречи/сделки
  let category = mapped.category;
  if (deals > 0 || meetings > 0) category = 'CONVERTED';

  // doNotCall true для тех, кого нельзя звонить
  const doNotCall = ['BLACKLIST', 'ON_BOT_REVIEW'].includes(category)
    || resultStr === 'Отказ от коммуникации'
    || zorgeStr === 'Просил не звонить';

  return { name, phoneRaw, callFlag, category, callResult: mapped.result, zorgeResult, comment, doNotCall, resultStr, zorgeStr };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('━'.repeat(70));
  console.log('Импорт базы брокеров из XLSX');
  console.log('━'.repeat(70));
  console.log(`XLSX:     ${xlsxPath}`);
  console.log(`Фильтр BrokerCategory: ${[...filter].join(', ')}`);
  console.log(`Фильтр ЗВОНОК (col F): ${callFlagFilter ? [...callFlagFilter].join(', ') : '(нет — все)'}`);
  console.log(`Источник: ${baseSource}`);
  console.log(`Dry-run:  ${isDryRun ? 'ДА' : 'нет'}`);
  if (limit) console.log(`Limit:    ${limit}`);
  console.log(`Координаторы (sheet 2): ${includeCoords ? 'ДА' : 'нет'}`);
  console.log('━'.repeat(70));

  const wb = XLSX.readFile(xlsxPath);
  const sheet1 = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet1, { defval: null });
  console.log(`Всего строк в '${wb.SheetNames[0]}': ${rows.length}`);

  // ─── Pass 1: stats & filtering ────────────────────────────────────────────
  const stats = {
    total: rows.length,
    invalidPhone: 0,
    byCategory: {},
    byCallFlag: {},
    afterFilter: 0,
    duplicatesInSheet: 0,
  };

  const seenPhones = new Set();
  const allValid = []; // все валидные после нормализации (без фильтра, без limit)
  for (const row of rows) {
    const m = mapRow(row);
    const norm = normalizePhone(m.phoneRaw);
    if (!norm.ok) {
      stats.invalidPhone++;
      continue;
    }
    stats.byCategory[m.category] = (stats.byCategory[m.category] || 0) + 1;
    const cfKey = m.callFlag || '(пусто)';
    stats.byCallFlag[cfKey] = (stats.byCallFlag[cfKey] || 0) + 1;
    if (seenPhones.has(norm.phone)) {
      stats.duplicatesInSheet++;
      continue;
    }
    seenPhones.add(norm.phone);
    allValid.push({ ...m, phone: norm.phone, foreign: !!norm.foreign });
  }
  // фильтр и limit применяем после полного обхода — чтобы stats были честные
  let candidates = allValid.filter(c => filter.has(c.category));
  if (callFlagFilter) candidates = candidates.filter(c => callFlagFilter.has(c.callFlag));
  if (limit) candidates = candidates.slice(0, limit);
  stats.afterFilter = candidates.length;

  console.log('\nСтатистика обхода:');
  console.log(`  всего строк:           ${stats.total}`);
  console.log(`  невалидный телефон:    ${stats.invalidPhone}`);
  console.log(`  дубли в самом sheet:   ${stats.duplicatesInSheet}`);
  console.log(`  распределение по BrokerCategory (после фильтра телефона):`);
  for (const [k, v] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(15)} ${v}`);
  }
  console.log(`  распределение по ЗВОНОК (col F):`);
  for (const [k, v] of Object.entries(stats.byCallFlag).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(15)} ${v}`);
  }
  console.log(`  под фильтр попало:     ${stats.afterFilter}`);

  if (candidates.length === 0) {
    console.log('\nНечего импортировать. Завершаю.');
    process.exit(0);
  }

  // ─── Pass 2: DB writes (или dry-run) ──────────────────────────────────────

  const prisma = new PrismaClient();
  const dbStats = { existed: 0, created: 0, updated: 0, callLogsCreated: 0, errors: 0 };

  if (isDryRun) {
    console.log('\n[DRY-RUN] Первые 10 кандидатов:');
    candidates.slice(0, 10).forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.phone}  ${c.category.padEnd(13)} ${c.name || '(без имени)'} | ${c.resultStr}${c.zorgeStr ? ' | Zorge: ' + c.zorgeStr : ''}`);
    });

    // Сколько уже в БД? — опционально, требует живой DATABASE_URL
    try {
      const existingByPhone = await prisma.broker.findMany({
        where: { phone: { in: candidates.map(c => c.phone) } },
        select: { phone: true },
      });
      const existSet = new Set(existingByPhone.map(b => b.phone));
      const wouldUpdate = candidates.filter(c => existSet.has(c.phone)).length;
      const wouldCreate = candidates.length - wouldUpdate;
      console.log(`\n[DRY-RUN] Итог:`);
      console.log(`  будет обновлено (уже есть в БД по phone): ${wouldUpdate}`);
      console.log(`  будет создано новых:                       ${wouldCreate}`);
      console.log(`  будет создано CallLog (rows с result):     ${candidates.filter(c => c.callResult).length}`);
    } catch (e) {
      console.log(`\n[DRY-RUN] DB-проверка пропущена (нет доступа к БД): ${e.message.split('\n')[0]}`);
      console.log(`  всего кандидатов под фильтр: ${candidates.length}`);
      console.log(`  с результатом для CallLog:   ${candidates.filter(c => c.callResult).length}`);
    }
    console.log('\nДля реальной записи — убери --dry-run.');
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  }

  // Реальная запись
  console.log(`\nЗапись в БД: ${candidates.length} брокеров...`);
  let i = 0;
  for (const c of candidates) {
    i++;
    if (i % 500 === 0) console.log(`  … ${i}/${candidates.length}`);
    try {
      const existing = await prisma.broker.findUnique({ where: { phone: c.phone } });
      let brokerId;
      if (existing) {
        await prisma.broker.update({
          where: { id: existing.id },
          data: {
            category: c.category,
            isInBase: true,
            baseSource,
            doNotCall: existing.doNotCall || c.doNotCall, // не понижаем
            // имя обновляем только если в БД пусто
            fullName: existing.fullName || c.name || '(без имени)',
          },
        });
        brokerId = existing.id;
        dbStats.updated++;
      } else {
        const created = await prisma.broker.create({
          data: {
            fullName: c.name || '(без имени)',
            phone: c.phone,
            role: 'BROKER',
            status: 'PENDING',
            category: c.category,
            isInBase: true,
            baseSource,
            doNotCall: c.doNotCall,
          },
        });
        brokerId = created.id;
        dbStats.created++;
      }

      // CallLog только если есть зафиксированный результат
      if (c.callResult) {
        await prisma.callLog.create({
          data: {
            brokerId,
            result: c.callResult,
            comment: c.comment,
            campaign: null,
          },
        });
        dbStats.callLogsCreated++;
      }
      if (c.zorgeResult) {
        await prisma.callLog.create({
          data: {
            brokerId,
            result: c.zorgeResult,
            comment: c.comment,
            campaign: 'Зорге 9',
          },
        });
        dbStats.callLogsCreated++;
      }
    } catch (e) {
      dbStats.errors++;
      console.error(`  ERR row ${i} (${c.phone}):`, e.message);
    }
  }

  // ─── Sheet 2: Координаторы (опционально) ──────────────────────────────────
  if (includeCoords && wb.SheetNames.length >= 2) {
    const sheet2 = wb.Sheets[wb.SheetNames[1]];
    const coordRows = XLSX.utils.sheet_to_json(sheet2, { defval: null });
    console.log(`\nКоординаторы '${wb.SheetNames[1]}': ${coordRows.length} строк`);
    const coordStats = { created: 0, updated: 0, invalid: 0 };
    for (const row of coordRows) {
      const norm = normalizePhone(row['Номер '] ?? row['Номер']);
      if (!norm.ok) { coordStats.invalid++; continue; }
      const name = (row['Имя'] || '').toString().trim() || '(координатор)';
      const agency = (row['Агенство'] || '').toString().trim() || null;
      try {
        const existing = await prisma.broker.findUnique({ where: { phone: norm.phone } });
        if (existing) {
          await prisma.broker.update({
            where: { id: existing.id },
            data: { isCoordinator: true, coordinatorAgency: agency, isInBase: true, baseSource },
          });
          coordStats.updated++;
        } else {
          await prisma.broker.create({
            data: {
              fullName: name, phone: norm.phone, role: 'BROKER', status: 'PENDING',
              category: 'COLD', isCoordinator: true, coordinatorAgency: agency,
              isInBase: true, baseSource,
            },
          });
          coordStats.created++;
        }
      } catch (e) {
        console.error(`  ERR coord (${norm.phone}):`, e.message);
      }
    }
    console.log(`Координаторы: создано=${coordStats.created} обновлено=${coordStats.updated} невалидных=${coordStats.invalid}`);
  }

  await prisma.$disconnect();
  console.log('\nГотово:');
  console.log(`  создано брокеров:   ${dbStats.created}`);
  console.log(`  обновлено брокеров: ${dbStats.updated}`);
  console.log(`  создано CallLog:    ${dbStats.callLogsCreated}`);
  console.log(`  ошибок:             ${dbStats.errors}`);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
