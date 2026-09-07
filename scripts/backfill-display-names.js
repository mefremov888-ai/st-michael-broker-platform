#!/usr/bin/env node
/**
 * 2026-09-07: Бэкфилл Broker.displayName — «имя для работы» для КЦ.
 *
 * У ~19% из 19k брокеров fullName кривое (мусор, телефоны вместо имён,
 * ники). displayName видит КЦ в «Нашей базе»; брокер в кабинете продолжает
 * видеть своё самоназвание (fullName не трогаем).
 *
 * Источники по приоритету (заполняем ТОЛЬКО пустой displayName —
 * идемпотентность и защита ручных правок КЦ):
 *   1) self        — собственное fullName брокера, если оно «здоровое»;
 *   2) old_cabinet — ФИО из старого кабинета по телефону
 *                    (data-ветка data/display-names-20260907,
 *                    файл data/old-cabinet-names.json: {phoneKey, fullName});
 *   3) amo         — имя контакта amoCRM (GET /contacts/{id}) для брокеров
 *                    с amoContactId; пауза 280мс между запросами.
 *
 * «Здоровое ФИО»: ≥2 слова кириллицей/латиницей (дефис/апостроф внутри
 * слова допустимы), без цифр, длина 5–60, ни одно слово не из стоп-списка
 * (брокер, тест, test, агент, риелтор/риэлтор, клиент).
 *
 * Запуск в контейнере api (workflow apply-display-names.yml):
 *   node /app/scripts/backfill-display-names.js /app/old-cabinet-names.json              # dry-run
 *   node /app/scripts/backfill-display-names.js /app/old-cabinet-names.json --apply      # запись
 *   node /app/scripts/backfill-display-names.js /app/old-cabinet-names.json --amo-offset 0 --amo-limit 3000
 *
 * --amo-offset/--amo-limit режут ТОЛЬКО amo-фазу (для порционной обработки,
 * если кандидатов на amo-запросы много); фазы self/old_cabinet без запросов
 * наружу и выполняются целиком всегда.
 */

const fs = require('fs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DATA_PATH = args.find((a) => !a.startsWith('--')) || '/app/old-cabinet-names.json';
const intArg = (name, def) => {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const AMO_OFFSET = intArg('--amo-offset', 0);
const AMO_LIMIT = intArg('--amo-limit', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── «Здоровость» ФИО ──────────────────────────────────────────────────
// ≥2 слова, только буквы кириллицы/латиницы (внутри слова допустимы
// дефис и апостроф), без цифр и прочих символов, длина 5–60, ни одно
// слово не из стоп-списка.
const STOP_WORDS = new Set([
  'брокер', 'тест', 'test', 'агент', 'риелтор', 'риэлтор', 'клиент',
]);
const WORD_RE = /^[A-Za-zА-Яа-яЁё]+(?:[-'’][A-Za-zА-Яа-яЁё]+)*$/;

function isHealthyFullName(name) {
  const t = String(name || '').replace(/\s+/g, ' ').trim();
  if (t.length < 5 || t.length > 60) return false;
  const words = t.split(' ');
  if (words.length < 2) return false;
  for (const w of words) {
    if (!WORD_RE.test(w)) return false;
    if (STOP_WORDS.has(w.toLowerCase())) return false;
  }
  return true;
}

// Телефон → ключ последних 10 цифр (как в старом кабинете могут быть
// и 8..., и 7..., и +7...).
function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

module.exports = { isHealthyFullName, phoneKey };
if (require.main !== module) return;

(async () => {
  const { NestFactory } = require('@nestjs/core');
  let AppModule;
  try {
    ({ AppModule } = require('/app/apps/api/dist/app.module'));
  } catch (e) {
    console.error('Cannot load Nest:', e?.message);
    process.exit(1);
  }
  const { AmoCrmAdapter } = require('/app/packages/integrations/dist/amo-crm.adapter');
  const { PrismaClient } = require('@st-michael/database');

  // Старый кабинет: [{phoneKey: '9261234567', fullName: 'Иванов Иван'}, ...]
  const oldCabinet = new Map();
  try {
    for (const row of JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))) {
      if (row.phoneKey && row.fullName) oldCabinet.set(String(row.phoneKey), String(row.fullName).trim());
    }
  } catch (e) {
    console.error(`Не прочитан файл данных ${DATA_PATH}: ${e?.message}`);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = new PrismaClient();
  const amo = new AmoCrmAdapter();

  try {
    console.log(`Режим: ${APPLY ? 'APPLY (пишем в БД)' : 'DRY-RUN (только отчёт)'}`);
    console.log(`Старый кабинет: ${oldCabinet.size} телефонов с ФИО`);

    // Только брокеры без displayName (уже заполненный — ручная правка КЦ
    // или прошлый прогон — НИКОГДА не перезаписываем).
    const brokers = await prisma.broker.findMany({
      where: { role: 'BROKER', mergedIntoId: null, displayName: null },
      select: { id: true, fullName: true, phone: true, amoContactId: true },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`Кандидатов без displayName: ${brokers.length}`);
    console.log('───────────────────────────────────');

    const stats = { self: 0, old_cabinet: 0, amo: 0, amoUnhealthy: 0, amoErrors: 0, unresolved: 0 };
    const examples = [];
    const addExample = (b, next, source) => {
      if (examples.length < 20) {
        examples.push(`  "${String(b.fullName).slice(0, 40)}" → "${next}" [${source}]`);
      }
    };

    // ── Фаза 1: self (здоровое собственное fullName) ──
    const selfIds = [];
    const rest = [];
    for (const b of brokers) {
      if (isHealthyFullName(b.fullName)) {
        selfIds.push(b.id);
        stats.self++;
        addExample(b, String(b.fullName).replace(/\s+/g, ' ').trim(), 'self');
      } else {
        rest.push(b);
      }
    }
    if (APPLY && selfIds.length) {
      // Одним UPDATE: display_name = нормализованное full_name.
      for (let i = 0; i < selfIds.length; i += 5000) {
        const chunk = selfIds.slice(i, i + 5000);
        await prisma.$executeRaw`
          UPDATE brokers
          SET display_name = btrim(regexp_replace(full_name, '\s+', ' ', 'g')),
              display_name_source = 'self'
          WHERE id = ANY(${chunk}) AND display_name IS NULL
        `;
      }
    }

    // ── Фаза 2: old_cabinet (ФИО из старого кабинета по телефону) ──
    const rest2 = [];
    for (const b of rest) {
      const key = phoneKey(b.phone);
      const oldName = key ? oldCabinet.get(key) : null;
      if (oldName && isHealthyFullName(oldName)) {
        stats.old_cabinet++;
        addExample(b, oldName, 'old_cabinet');
        if (APPLY) {
          await prisma.broker.update({
            where: { id: b.id },
            data: { displayName: oldName, displayNameSource: 'old_cabinet' },
          });
        }
      } else {
        rest2.push(b);
      }
    }

    // ── Фаза 3: amo (имя контакта по amoContactId) ──
    const amoCandidates = rest2.filter((b) => b.amoContactId != null);
    stats.unresolved = rest2.length - amoCandidates.length;
    // В dry-run без явного --amo-limit не гоняем тысячи GET-ов впустую:
    // берём сэмпл 50, полный объём печатаем для оценки порций.
    const effectiveLimit = AMO_LIMIT != null ? AMO_LIMIT : (APPLY ? null : 50);
    const amoSlice = amoCandidates.slice(AMO_OFFSET, effectiveLimit != null ? AMO_OFFSET + effectiveLimit : undefined);
    console.log(`Кандидатов amo-фазы всего: ${amoCandidates.length}; в этом прогоне: ${amoSlice.length}` +
      ` (offset=${AMO_OFFSET}, limit=${effectiveLimit ?? '∞'})`);
    if (!APPLY && AMO_LIMIT == null && amoCandidates.length > amoSlice.length) {
      console.log('DRY-RUN: amo-фаза — сэмпл 50 запросов (только чтение); полный объём задаётся --amo-limit');
    }

    for (let i = 0; i < amoSlice.length; i++) {
      const b = amoSlice[i];
      if (i > 0 && i % 200 === 0) console.log(`— amo-прогресс: ${i}/${amoSlice.length} —`);
      try {
        const contact = await amo.getContact(Number(b.amoContactId));
        const name = contact?.name ? String(contact.name).trim() : '';
        if (isHealthyFullName(name)) {
          stats.amo++;
          addExample(b, name, 'amo');
          if (APPLY) {
            await prisma.broker.update({
              where: { id: b.id },
              data: { displayName: name, displayNameSource: 'amo' },
            });
          }
        } else {
          stats.amoUnhealthy++;
        }
      } catch (e) {
        stats.amoErrors++;
        console.error(`ERROR amo ${b.amoContactId}: ${e?.message || e}`);
      }
      await sleep(280);
    }

    console.log('───────────────────────────────────');
    console.log(`ИТОГО${APPLY ? '' : ' (dry-run, БЕЗ записи)'}:`);
    console.log(`  self (здоровое своё ФИО):     ${stats.self}`);
    console.log(`  old_cabinet (старый кабинет): ${stats.old_cabinet}`);
    console.log(`  amo (имя контакта):           ${stats.amo}`);
    console.log(`  amo: имя нездоровое:          ${stats.amoUnhealthy}`);
    console.log(`  amo: ошибок запросов:         ${stats.amoErrors}`);
    console.log(`  без источника (не закрыты):   ${stats.unresolved + stats.amoUnhealthy + stats.amoErrors}`);
    console.log('Примеры «было → станет» (до 20):');
    for (const ex of examples) console.log(ex);
  } finally {
    await prisma.$disconnect();
    await app.close();
  }
})().catch((e) => {
  console.error('Fatal:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
