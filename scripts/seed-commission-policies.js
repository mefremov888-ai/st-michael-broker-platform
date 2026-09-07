#!/usr/bin/env node
/**
 * Сидер начальных политик комиссии (правка 2026-05-13).
 *
 * По Зорге 9:
 *   - PROGRESSIVE  01.01.2026 — 06.05.2026  (старая шкала ТЗ)
 *   - FLAT 4%      07.05.2026 — 31.12.2099  (новая, действует сейчас)
 *
 * По Серебряному Бору (Б37): пока ничего не сидим — заказчик создаст в админке.
 *
 * Идемпотентен: проверяет наличие политик по (project + startDate) — если есть, пропускает.
 */

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
}

const ZORGE_PROGRESSIVE_LEVELS = [
  { level: 'START',    minSqm: 0,   rate: 5.0 },
  { level: 'BASIC',    minSqm: 60,  rate: 5.5 },
  { level: 'STRONG',   minSqm: 120, rate: 6.0 },
  { level: 'PREMIUM',  minSqm: 200, rate: 6.5 },
  { level: 'ELITE',    minSqm: 320, rate: 7.0 },
  { level: 'CHAMPION', minSqm: 500, rate: 7.5 },
  { level: 'LEGEND',   minSqm: 700, rate: 8.0 },
];

const POLICIES = [
  {
    project: 'ZORGE9',
    mode: 'PROGRESSIVE',
    levels: ZORGE_PROGRESSIVE_LEVELS,
    startDate: new Date('2026-01-01T00:00:00Z'),
    endDate:   new Date('2026-05-06T23:59:59Z'),
    notes: 'Старая прогрессивная шкала Зорге 9 (до перехода на FLAT 4%).',
  },
  {
    project: 'ZORGE9',
    mode: 'FLAT',
    flatRate: 4.0,
    startDate: new Date('2026-05-07T00:00:00Z'),
    endDate:   new Date('2099-12-31T23:59:59Z'),
    notes: 'Новая фиксированная ставка 4% по Зорге 9 (с 07.05.2026).',
  },
];

(async () => {
  const prisma = new PrismaClient();
  let created = 0;
  let skipped = 0;
  for (const p of POLICIES) {
    const existing = await prisma.commissionPolicy.findFirst({
      where: {
        project: p.project,
        startDate: p.startDate,
      },
    });
    if (existing) {
      console.log(`Skipped (exists): ${p.project} ${p.mode} from ${p.startDate.toISOString().slice(0, 10)}`);
      skipped++;
      continue;
    }
    await prisma.commissionPolicy.create({
      data: {
        project: p.project,
        mode: p.mode,
        flatRate: p.flatRate != null ? p.flatRate : null,
        levels: p.levels || null,
        startDate: p.startDate,
        endDate: p.endDate,
        isActive: true,
        notes: p.notes,
      },
    });
    console.log(`Created: ${p.project} ${p.mode} ${p.flatRate ? p.flatRate + '%' : '(levels)'} ${p.startDate.toISOString().slice(0, 10)} — ${p.endDate.toISOString().slice(0, 10)}`);
    created++;
  }
  console.log(`\nDone. Created: ${created}, skipped: ${skipped}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
