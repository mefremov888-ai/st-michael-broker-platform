#!/usr/bin/env node
/**
 * 2026-09-04: read-only выгрузка справочников для сшивки сделок:
 * агентства (id, название, ИНН) и брокеры (id, ФИО, последние 4 цифры
 * телефона, агентство, есть ли amoContactId). Полные телефоны и прочие
 * персональные данные НЕ выгружаются. Вывод — NDJSON между маркерами.
 *
 * Запуск в контейнере api (workflow export-agencies-brokers.yml):
 *   node /app/scripts/export-agencies-brokers.js
 */
(async () => {
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();
  try {
    const agencies = await prisma.$queryRaw`
      SELECT a.id, a.name, a.inn,
             count(b.id)::int AS brokers
      FROM agencies a LEFT JOIN brokers b ON b.agency_id = a.id
      GROUP BY a.id, a.name, a.inn`;
    const brokers = await prisma.$queryRaw`
      SELECT b.id, b.full_name, right(regexp_replace(coalesce(b.phone,''),'\\D','','g'), 4) AS phone4,
             a.name AS agency, (b.amo_contact_id IS NOT NULL) AS has_amo
      FROM brokers b LEFT JOIN agencies a ON a.id = b.agency_id
      WHERE b.merged_into_id IS NULL`;
    console.log(`агентств: ${agencies.length}; брокеров: ${brokers.length}`);
    console.log('===AGENCIES-BEGIN===');
    for (const a of agencies) console.log(JSON.stringify(a));
    console.log('===AGENCIES-END===');
    console.log('===BROKERS-BEGIN===');
    for (const b of brokers) console.log(JSON.stringify(b));
    console.log('===BROKERS-END===');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
