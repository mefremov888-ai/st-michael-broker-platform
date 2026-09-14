#!/usr/bin/env node
/** 2026-09-14: проверка импорта старого кабинета — дубли и охват по годам. Только чтение. */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS всего,
             COUNT(DISTINCT substring(comment from '\[old-cabinet:(\d+)\]'))::int AS уникальных_маркеров,
             MIN(created_at)::text AS с, MAX(created_at)::text AS по
      FROM clients WHERE comment LIKE '[old-cabinet:%'
    `);
    const r = rows[0];
    console.log("=== Импорт старого кабинета ===");
    console.log(`  записей:              ${Number(r.всего)}`);
    console.log(`  уникальных номеров:   ${Number(r.уникальных_маркеров)}`);
    console.log(`  дублей:               ${Number(r.всего) - Number(r.уникальных_маркеров)}`);
    console.log(`  период:               ${String(r.с).slice(0, 10)} — ${String(r.по).slice(0, 10)}`);

    const years = await prisma.$queryRawUnsafe(`
      SELECT to_char(created_at, 'YYYY') AS y, COUNT(*)::int AS c
      FROM clients WHERE comment LIKE '[old-cabinet:%' GROUP BY 1 ORDER BY 1
    `);
    console.log("  по годам: " + years.map((x) => `${x.y}:${Number(x.c)}`).join("  "));

    const dupPhones = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS c FROM (
        SELECT phone, broker_id, created_at::date, COUNT(*) AS n
        FROM clients WHERE comment LIKE '[old-cabinet:%'
        GROUP BY 1,2,3 HAVING COUNT(*) > 1
      ) t
    `);
    console.log(`  групп «тот же клиент, тот же брокер, тот же день»: ${Number(dupPhones[0].c)}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
