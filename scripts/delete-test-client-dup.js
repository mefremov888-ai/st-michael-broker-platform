#!/usr/bin/env node
/**
 * 2026-09-08: единственный дубль по (broker_id, amo_lead_id) — тестовая запись
 * «ТЕТСТ Тест» (2026-05-04) рядом с настоящей «Антон Федоров» у того же
 * брокера/лида. Удаляем тестовую (без сделок/встреч). DRY_RUN=1 — отчёт.
 */
async function main() {
  const dry = process.env.DRY_RUN !== "0";
  const { PrismaClient } = require("@st-michael/database"); const prisma = new PrismaClient();
  try {
    const rows = await prisma.client.findMany({ where: { brokerId: { startsWith: "0443e652" }, amoLeadId: BigInt(32216983), fullName: { startsWith: "ТЕТСТ", mode: "insensitive" } }, select: { id: true, fullName: true, phone: true, createdAt: true, _count: { select: { deals: true, meetings: true } } } });
    console.log(`Режим: ${dry ? "DRY-RUN" : "APPLY"}; найдено тестовых записей: ${rows.length}`);
    for (const r of rows) console.log(`  • ${r.fullName} | ${String(r.phone).replace(/(\+7\d{3})\d{4}(\d{2})/, "$1****$2")} | ${r.createdAt.toISOString().slice(0, 10)} | сделок ${r._count.deals}, встреч ${r._count.meetings}`);
    const safe = rows.filter((r) => r._count.deals === 0 && r._count.meetings === 0);
    if (!dry && safe.length) { const res = await prisma.client.deleteMany({ where: { id: { in: safe.map((r) => r.id) } } }); console.log(`Удалено: ${res.count}`); }
    console.log("RESULT: " + JSON.stringify({ found: rows.length, deletable: safe.length, dry }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
