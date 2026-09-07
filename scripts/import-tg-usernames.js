#!/usr/bin/env node
/**
 * 2026-07-23: Импорт участников TG-чатов БЕЗ телефона, но с ником.
 * Данные: scripts/data/tg-usernames-2026-07-22.json (2216 контактов,
 * боты и дубли между чатами уже отфильтрованы).
 *
 * Телефон в схеме обязателен и уникален → таким контактам пишем
 * служебный phone = 'tg:<ник в нижнем регистре>'. Фильтр в кабинете:
 * /admin/brokers → «Только Telegram (без телефона)» (contact=TG_ONLY).
 *
 * Правила:
 *  - пропускаем, если ник уже есть в базе (telegram_username, без
 *    регистра) или 'tg:<ник>' уже занят (идемпотентность);
 *  - doNotCall=true (звонить некуда), category COLD, isInBase=true,
 *    baseSource из чата (tg_etalon_pro / tg_a101), без пароля —
 *    в «Заходы» не попадают.
 *
 * По умолчанию dry-run. Запись: --apply.
 */

const APPLY = process.argv.slice(2).includes('--apply');

(async () => {
  const fs = require('fs');
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();

  try {
    const data = JSON.parse(fs.readFileSync('/app/scripts/data/tg-usernames-2026-07-22.json', 'utf8'));
    console.log(`Режим: ${APPLY ? 'APPLY (пишем в БД)' : 'DRY-RUN'}`);
    console.log(`Во входном файле контактов только с ником: ${data.length}`);

    const existing = await prisma.broker.findMany({
      where: { OR: [{ telegramUsername: { not: null } }, { phone: { startsWith: 'tg:' } }] },
      select: { telegramUsername: true, phone: true },
    });
    const knownNicks = new Set();
    for (const b of existing) {
      if (b.telegramUsername) knownNicks.add(b.telegramUsername.toLowerCase().replace(/^@/, ''));
      if (b.phone?.startsWith('tg:')) knownNicks.add(b.phone.slice(3).toLowerCase());
    }
    console.log(`Ников уже в базе: ${knownNicks.size}`);

    const stats = { already: 0, added: 0, errors: 0, byChat: {} };
    for (const e of data) {
      const nick = String(e.username || '').replace(/^@/, '').trim();
      if (!nick) continue;
      const lower = nick.toLowerCase();
      if (knownNicks.has(lower)) {
        stats.already++;
        continue;
      }
      knownNicks.add(lower);
      try {
        if (APPLY) {
          await prisma.broker.create({
            data: {
              fullName: (e.name || '').trim() || `@${nick}`,
              phone: `tg:${lower}`,
              role: 'BROKER',
              status: 'PENDING',
              category: 'COLD',
              isInBase: true,
              doNotCall: true,
              baseSource: e.chat,
              telegramUsername: nick,
            },
          });
        }
        stats.added++;
        stats.byChat[e.chat] = (stats.byChat[e.chat] || 0) + 1;
      } catch (err) {
        stats.errors++;
        console.error(`ERROR @${nick}: ${err?.message || err}`);
      }
    }

    console.log('───────────────────────────────');
    console.log('ИТОГО:');
    console.log(`  ник уже был в базе: ${stats.already}`);
    console.log(`  добавлено новых:    ${stats.added}${APPLY ? '' : ' (dry-run)'}`);
    for (const [chat, n] of Object.entries(stats.byChat)) console.log(`    - ${chat}: ${n}`);
    console.log(`  ошибок:             ${stats.errors}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('Fatal:', e?.message || e);
  process.exit(1);
});
