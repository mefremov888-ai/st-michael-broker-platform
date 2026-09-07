/**
 * Общая логика импорта брокеров из любого источника (XLSX, Google Sheets, …).
 *
 * Источник передаёт уже распарсенные объекты строк (ключ → значение по заголовкам
 * первой строки). Логика нормализации, фильтрации и записи в БД — здесь.
 *
 * TZ v3 §2.11 (нормализация телефонов), §3 (импорт), §5 (схема Broker/CallLog).
 */

const path = require('path');

function loadPrisma() {
  try {
    return require('@prisma/client');
  } catch (_) {
    return require(path.join(__dirname, '..', '..', 'packages', 'database', 'node_modules', '@prisma', 'client'));
  }
}

// ─── Phone normalization (TZ v3 §2.11) ──────────────────────────────────────

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
      return { ok: false, reason: 'truncated_77', raw: digits };
    }
    if (digits[0] === '7') return { ok: true, phone: '+' + digits };
    if (digits[0] === '8') return { ok: true, phone: '+7' + digits.slice(1) };
    return { ok: true, phone: '+' + digits, foreign: true };
  }
  if (n === 12) {
    if (digits.startsWith('77')) return { ok: true, phone: '+' + digits.slice(1) };
    return { ok: true, phone: '+' + digits, foreign: true };
  }
  return { ok: true, phone: '+' + digits, foreign: true };
}

// ─── Mappings (TZ v3 §2.2 + §5) ─────────────────────────────────────────────

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

const VALID_CATEGORIES = ['COLD', 'WARM', 'HOT', 'CONVERTED', 'ON_BOT_REVIEW', 'BLACKLIST'];
const VALID_CALL_FLAGS = ['да', 'в работе', 'обработан'];

function mapRow(row) {
  const name = (row['Имя'] || '').toString().trim();
  const phoneRaw = row['Телефон брокера'] ?? row['Телефон'];
  const meetings = Number(row['Встречи'] || 0);
  const deals = Number(row['Сделки'] || 0);
  const callFlag = (row['ЗВОНОК'] || '').toString().trim().toLowerCase();
  const resultStr = (row['Результат звонка'] || '').toString().trim();
  const zorgeStr = (row['Обзвон по Зорге '] || row['Обзвон по Зорге'] || '').toString().trim();
  const comment = (row['Комментарий'] || '').toString().trim() || null;

  const mapped = RESULT_MAP[resultStr] || { category: 'COLD', result: null };
  const zorgeResult = ZORGE_MAP[zorgeStr] || null;

  let category = mapped.category;
  if (deals > 0 || meetings > 0) category = 'CONVERTED';

  const doNotCall =
    ['BLACKLIST', 'ON_BOT_REVIEW'].includes(category) ||
    resultStr === 'Отказ от коммуникации' ||
    zorgeStr === 'Просил не звонить';

  // 2026-07-06: специализация — ищем коммерческие маркеры в комментарии,
  // имени, поле «Результат». Одного совпадения достаточно, чтобы пометить
  // брокера как COMM. Иначе null (не трогаем то, что уже стоит в БД).
  const COMM_KEYWORDS = /(комм(?:ерц|\.|ерческ)|komm|commercial|офис|склад|торгов|нежил|ритейл|retail)/i;
  const specialization = [comment, name, resultStr, zorgeStr]
    .some((s) => s && COMM_KEYWORDS.test(String(s)))
    ? 'COMM'
    : null;

  // 2026-07-09: региональный признак — КЦ пишет «регион», «региональ» в
  // комментарии. Отдельно от specialization: региональный может быть
  // одновременно коммерческим или жилым.
  const REGIONAL_KEYWORDS = /(регион(?:аль|ы|а|)?|из\s+регион|региональ)/i;
  const isRegional = [comment, name, resultStr, zorgeStr]
    .some((s) => s && REGIONAL_KEYWORDS.test(String(s)));

  return { name, phoneRaw, callFlag, category, callResult: mapped.result, zorgeResult, comment, doNotCall, resultStr, zorgeStr, specialization, isRegional };
}

function mapCoordRow(row) {
  const phoneRaw = row['Номер '] ?? row['Номер'];
  const name = (row['Имя'] || '').toString().trim() || '(координатор)';
  const agency = (row['Агенство'] || '').toString().trim() || null;
  return { phoneRaw, name, agency };
}

// ─── Main import flow ───────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array<object>} opts.rows       — основной лист (объекты row→value по заголовкам)
 * @param {Array<object>} [opts.coordRows] — лист координаторов (опционально)
 * @param {Set<string>}   opts.filter     — какие BrokerCategory импортировать
 * @param {Set<string>|null} opts.callFlagFilter — фильтр по столбцу ЗВОНОК (null = не фильтруем)
 * @param {number|null}   opts.limit
 * @param {boolean}       opts.isDryRun
 * @param {string}        opts.baseSource — 'google_sheet' / 'xlsx' / 'manual'
 * @param {boolean}       opts.includeCoords
 */
async function runImport(opts) {
  const { rows, coordRows = [], filter, callFlagFilter, limit, isDryRun, baseSource, includeCoords } = opts;

  console.log('━'.repeat(70));
  console.log(`Импорт ${rows.length} строк (источник: ${baseSource})`);
  console.log(`Фильтр BrokerCategory:  ${[...filter].join(', ')}`);
  console.log(`Фильтр ЗВОНОК (col F):  ${callFlagFilter ? [...callFlagFilter].join(', ') : '(нет — все)'}`);
  console.log(`Dry-run:                ${isDryRun ? 'ДА' : 'нет'}`);
  if (limit) console.log(`Limit:                  ${limit}`);
  console.log(`Координаторы:           ${includeCoords ? `ДА (${coordRows.length})` : 'нет'}`);
  console.log('━'.repeat(70));

  // ─── Pass 1: stats & filtering ──────────────────────────────────────────
  const stats = {
    total: rows.length,
    invalidPhone: 0,
    byCategory: {},
    byCallFlag: {},
    afterFilter: 0,
    duplicatesInSheet: 0,
  };
  const seenPhones = new Set();
  const allValid = [];
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
  let candidates = allValid.filter((c) => filter.has(c.category));
  if (callFlagFilter) candidates = candidates.filter((c) => callFlagFilter.has(c.callFlag));
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

  if (candidates.length === 0 && (!includeCoords || coordRows.length === 0)) {
    console.log('\nНечего импортировать. Завершаю.');
    return { created: 0, updated: 0, callLogsCreated: 0, errors: 0 };
  }

  const { PrismaClient } = loadPrisma();
  const prisma = new PrismaClient();
  const dbStats = { existed: 0, created: 0, updated: 0, callLogsCreated: 0, errors: 0, coordCreated: 0, coordUpdated: 0 };

  if (isDryRun) {
    console.log('\n[DRY-RUN] Первые 10 кандидатов:');
    candidates.slice(0, 10).forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.phone}  ${c.category.padEnd(13)} ${c.name || '(без имени)'} | ${c.resultStr}${c.zorgeStr ? ' | Zorge: ' + c.zorgeStr : ''}`);
    });
    try {
      const existingByPhone = await prisma.broker.findMany({
        where: { phone: { in: candidates.map((c) => c.phone) } },
        select: { phone: true },
      });
      const existSet = new Set(existingByPhone.map((b) => b.phone));
      const wouldUpdate = candidates.filter((c) => existSet.has(c.phone)).length;
      const wouldCreate = candidates.length - wouldUpdate;
      console.log(`\n[DRY-RUN] Итог:`);
      console.log(`  будет обновлено (уже есть в БД по phone): ${wouldUpdate}`);
      console.log(`  будет создано новых:                       ${wouldCreate}`);
      console.log(`  будет создано CallLog (rows с result):     ${candidates.filter((c) => c.callResult).length}`);
    } catch (e) {
      console.log(`\n[DRY-RUN] DB-проверка пропущена (нет доступа к БД): ${e.message.split('\n')[0]}`);
      console.log(`  всего кандидатов под фильтр: ${candidates.length}`);
    }
    console.log('\nДля реальной записи — убери --dry-run.');
    await prisma.$disconnect().catch(() => {});
    return dbStats;
  }

  // ─── Pass 2: реальная запись ────────────────────────────────────────────
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
            doNotCall: existing.doNotCall || c.doNotCall,
            fullName: existing.fullName || c.name || '(без имени)',
            // 2026-07-06: специализация — если Google говорит COMM, а у нас
            // ещё не задана, ставим. Не затираем существующее (например
            // RESIDENTIAL или BOTH — брокер сам мог указать).
            ...(c.specialization && !existing.specialization
              ? { specialization: c.specialization }
              : {}),
            // 2026-07-09: региональный признак — OR. Если Google сказал
            // regional и у нас ещё false — ставим true. Обратно не
            // «размагничиваем»: если брокер уже помечен как регионал,
            // отсутствие ключевого слова в новой строке не сбрасывает.
            ...(c.isRegional && !existing.isRegional
              ? { isRegional: true }
              : {}),
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
            ...(c.specialization ? { specialization: c.specialization } : {}),
            ...(c.isRegional ? { isRegional: true } : {}),
          },
        });
        brokerId = created.id;
        dbStats.created++;
      }

      if (c.callResult) {
        await prisma.callLog.create({
          data: { brokerId, result: c.callResult, comment: c.comment, campaign: null },
        });
        dbStats.callLogsCreated++;
      }
      if (c.zorgeResult) {
        await prisma.callLog.create({
          data: { brokerId, result: c.zorgeResult, comment: c.comment, campaign: 'Зорге 9' },
        });
        dbStats.callLogsCreated++;
      }
    } catch (e) {
      dbStats.errors++;
      console.error(`  ERR row ${i} (${c.phone}):`, e.message);
    }
  }

  if (includeCoords && coordRows.length > 0) {
    console.log(`\nКоординаторы: ${coordRows.length} строк`);
    for (const row of coordRows) {
      const m = mapCoordRow(row);
      const norm = normalizePhone(m.phoneRaw);
      if (!norm.ok) continue;
      try {
        const existing = await prisma.broker.findUnique({ where: { phone: norm.phone } });
        if (existing) {
          await prisma.broker.update({
            where: { id: existing.id },
            data: { isCoordinator: true, coordinatorAgency: m.agency, isInBase: true, baseSource },
          });
          dbStats.coordUpdated++;
        } else {
          await prisma.broker.create({
            data: {
              fullName: m.name,
              phone: norm.phone,
              role: 'BROKER',
              status: 'PENDING',
              category: 'COLD',
              isCoordinator: true,
              coordinatorAgency: m.agency,
              isInBase: true,
              baseSource,
            },
          });
          dbStats.coordCreated++;
        }
      } catch (e) {
        console.error(`  ERR coord (${norm.phone}):`, e.message);
      }
    }
    console.log(`Координаторы: создано=${dbStats.coordCreated} обновлено=${dbStats.coordUpdated}`);
  }

  await prisma.$disconnect();
  console.log('\nГотово:');
  console.log(`  создано брокеров:   ${dbStats.created}`);
  console.log(`  обновлено брокеров: ${dbStats.updated}`);
  console.log(`  создано CallLog:    ${dbStats.callLogsCreated}`);
  console.log(`  ошибок:             ${dbStats.errors}`);
  return dbStats;
}

module.exports = {
  normalizePhone,
  RESULT_MAP,
  ZORGE_MAP,
  VALID_CATEGORIES,
  VALID_CALL_FLAGS,
  mapRow,
  mapCoordRow,
  runImport,
};
