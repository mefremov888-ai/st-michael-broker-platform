#!/usr/bin/env node
/**
 * 2026-07-22: Backfill Broker.kcTeam — разделение менеджеров КЦ на
 * Штат (Empire Estate) / Аутсорс. Согласовано 2026-07-15.
 *
 * Штат — 6 сотрудников по docs/call-center-team.md (матчим по ФИО среди
 * role=MANAGER, без учёта регистра и порядка слов). Все остальные
 * MANAGER → OUTSOURCE. Не-менеджеров не трогаем. Идемпотентен.
 *
 * По умолчанию dry-run. Запись: --apply.
 */

const APPLY = process.argv.slice(2).includes('--apply');

// Фамилия+имя штатных (docs/call-center-team.md, 2026-05-15)
const STAFF = [
  ['скибицкая', 'анна'],
  ['корнева', 'александра'],
  ['уланов', 'артём'],
  ['кириллова', 'ксения'],
  ['цветкова', 'надежда'],
  ['арефьева', 'юлия'],
];

const normWords = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^а-яa-z]+/)
    .filter(Boolean);

function isStaff(fullName) {
  const words = new Set(normWords(fullName));
  return STAFF.some((pair) => pair.every((w) => words.has(w.replace(/ё/g, 'е'))));
}

(async () => {
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();
  try {
    const managers = await prisma.broker.findMany({
      where: { role: 'MANAGER' },
      select: { id: true, fullName: true, kcTeam: true },
      orderBy: { fullName: 'asc' },
    });
    console.log(`Режим: ${APPLY ? 'APPLY' : 'DRY-RUN'}; менеджеров в БД: ${managers.length}`);

    let staff = 0;
    let outsource = 0;
    for (const m of managers) {
      const team = isStaff(m.fullName) ? 'STAFF' : 'OUTSOURCE';
      if (team === 'STAFF') staff++;
      else outsource++;
      console.log(`  ${team === 'STAFF' ? 'ШТАТ    ' : 'АУТСОРС '} ${m.fullName}${m.kcTeam ? ` (было: ${m.kcTeam})` : ''}`);
      if (APPLY && m.kcTeam !== team) {
        await prisma.broker.update({ where: { id: m.id }, data: { kcTeam: team } });
      }
    }
    console.log('───────────────');
    console.log(`ИТОГО: Штат ${staff} (ожидаем 6), Аутсорс ${outsource}${APPLY ? '' : ' (dry-run)'}`);
    if (staff !== 6) {
      console.log('ВНИМАНИЕ: штатных не 6 — сверить ФИО в БД с docs/call-center-team.md');
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('Fatal:', e?.message || e);
  process.exit(1);
});
