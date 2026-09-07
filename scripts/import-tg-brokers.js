#!/usr/bin/env node
/**
 * 2026-07-22: Импорт контактов брокеров, спарсенных из Telegram-чатов
 * застройщиков (Эталон.ПРО Москва, ГК А101). Данные: scripts/data/
 * tg-brokers-2026-07-22.json (только мобильные РФ, без ботов и без
 * офисных номеров из рекламных постов).
 *
 * Правила:
 *  - добавляем ТОЛЬКО номера, которых нет в базе (brokers.phone +
 *    broker_phones), сверка по последним 10 цифрам;
 *  - пометка baseSource: 'tg_etalon_pro' / 'tg_a101' — по ней фильтруются;
 *  - БЕЗ пароля → в «Заходы» на /admin/broker-applications НЕ попадают
 *    (признак регистрации — пароль, PR #264);
 *  - category COLD, status PENDING, isInBase=true (очередь КЦ);
 *  - telegram_username заполняем если есть.
 *
 * По умолчанию dry-run. Запись: --apply.
 * В конце печатает CSV добавленных между маркерами ===CSV-START/END===.
 */

const APPLY = process.argv.slice(2).includes('--apply');
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

(async () => {
  const fs = require('fs');
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();

  try {
    const data = JSON.parse(fs.readFileSync('/app/scripts/data/tg-brokers-2026-07-22.json', 'utf8'));
    console.log(`Режим: ${APPLY ? 'APPLY (пишем в БД)' : 'DRY-RUN'}`);
    console.log(`Во входном файле уникальных мобильных: ${data.length}`);

    const existing = await prisma.$queryRaw`
      SELECT right(regexp_replace(phone, '\\D', '', 'g'), 10) AS p FROM brokers
      UNION
      SELECT right(regexp_replace(phone, '\\D', '', 'g'), 10) AS p FROM broker_phones
    `;
    const known = new Set(existing.map((r) => r.p).filter(Boolean));
    console.log(`Номеров уже в базе (brokers + broker_phones): ${known.size}`);

    const stats = { already: 0, added: 0, errors: 0, byChat: {} };
    const added = [];
    for (const e of data) {
      const p10 = last10(e.phone);
      if (!p10 || p10.length < 10) continue;
      if (known.has(p10)) {
        stats.already++;
        continue;
      }
      known.add(p10); // защита от дублей внутри самого файла
      const fullName = (e.name || '').trim() || (e.username ? e.username : '(без имени)');
      try {
        if (APPLY) {
          await prisma.broker.create({
            data: {
              fullName,
              phone: '+7' + p10,
              role: 'BROKER',
              status: 'PENDING',
              category: 'COLD',
              isInBase: true,
              baseSource: e.chat, // tg_etalon_pro / tg_a101
              telegramUsername: e.username ? String(e.username).replace(/^@/, '') : null,
            },
          });
        }
        stats.added++;
        stats.byChat[e.chat] = (stats.byChat[e.chat] || 0) + 1;
        added.push(e);
      } catch (err) {
        stats.errors++;
        console.error(`ERROR ${e.phone}: ${err?.message || err}`);
      }
    }

    console.log('───────────────────────────────');
    console.log('ИТОГО:');
    console.log(`  уже были в базе:  ${stats.already}`);
    console.log(`  добавлено новых:  ${stats.added}${APPLY ? '' : ' (dry-run)'}`);
    for (const [chat, n] of Object.entries(stats.byChat)) console.log(`    - ${chat}: ${n}`);
    console.log(`  ошибок:           ${stats.errors}`);

    console.log('===CSV-START===');
    console.log('phone;name;username;chat;via');
    for (const e of added) {
      console.log([`+7${last10(e.phone)}`, e.name || '', e.username || '', e.chat, e.via].join(';'));
    }
    console.log('===CSV-END===');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('Fatal:', e?.message || e);
  process.exit(1);
});
