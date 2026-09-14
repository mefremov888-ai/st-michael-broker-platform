#!/usr/bin/env node
/**
 * 2026-09-14: проверка после apply-kc-meetings-coverage — сколько встреч
 * реально создано (метка карточки КЦ в комментарии) и за какие годы.
 * Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '2 hours')::int AS last_2h,
        COUNT(*) FILTER (WHERE comment LIKE '%брокер определён%')::int AS by_coverage
      FROM meetings WHERE comment LIKE '[amo:kc-lead:%'
    `);
    const r = rows[0];
    console.log("=== Встречи с меткой карточки колл-центра ===");
    console.log(`  всего:                        ${Number(r.total)}`);
    console.log(`  создано за последние 2 часа:  ${Number(r.last_2h)}`);
    console.log(`  из добивки (с пометкой как):  ${Number(r.by_coverage)}`);

    const years = await prisma.$queryRawUnsafe(`
      SELECT to_char(date, 'YYYY') AS y, COUNT(*)::int AS c
      FROM meetings WHERE comment LIKE '%брокер определён%' GROUP BY 1 ORDER BY 1
    `);
    for (const y of years) console.log(`    ${y.y}: ${Number(y.c)}`);

    const zero = await prisma.$queryRawUnsafe(`
      WITH d AS (SELECT DISTINCT broker_id FROM registry_deals WHERE broker_id IS NOT NULL AND paid_at IS NOT NULL)
      SELECT COUNT(*)::int AS with_deals,
             COUNT(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM meetings mm WHERE mm.broker_id = d.broker_id
                 AND mm.status IN ('CONFIRMED','COMPLETED') AND mm.type <> 'BROKER_TOUR'))::int AS zero_meetings
      FROM d
    `);
    console.log("\n=== Брокеры со сделками ===");
    console.log(`  всего:                        ${Number(zero[0].with_deals)}`);
    console.log(`  из них без встреч:            ${Number(zero[0].zero_meetings)}   (было 164)`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
