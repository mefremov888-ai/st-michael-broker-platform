#!/usr/bin/env node
/**
 * 2026-09-08: дубли клиентов по (broker_id, amo_lead_id) — репетиция миграции
 * уникального ключа упала на паре (0443e652…, 32216983). Считаем группы,
 * показываем состав (телефоны маскированы), связи (сделки/встречи), даты,
 * источник (комментарий [old-cabinet:]). Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database"); const prisma = new PrismaClient();
  try {
    const groups = await prisma.$queryRawUnsafe(`SELECT broker_id, amo_lead_id, count(*)::int AS n FROM clients WHERE amo_lead_id IS NOT NULL GROUP BY broker_id, amo_lead_id HAVING count(*) > 1 ORDER BY n DESC`);
    console.log(`Групп-дублей (broker_id, amo_lead_id): ${groups.length}; лишних записей: ${groups.reduce((s, g) => s + (g.n - 1), 0)}`);
    const mask = (p) => String(p || "").replace(/(\+7\d{3})\d{4}(\d{2})/, "$1****$2");
    let shown = 0; const stats = { samePhone: 0, diffPhone: 0, withRelations: 0, oldCabinet: 0 };
    for (const g of groups) {
      const rows = await prisma.client.findMany({ where: { brokerId: g.broker_id, amoLeadId: g.amo_lead_id }, select: { id: true, phone: true, fullName: true, createdAt: true, comment: true, fixationStatus: true, uniquenessStatus: true, _count: { select: { deals: true, meetings: true } } }, orderBy: { createdAt: "asc" } });
      const phones = new Set(rows.map((r) => r.phone)); if (phones.size === 1) stats.samePhone++; else stats.diffPhone++;
      if (rows.some((r) => r._count.deals || r._count.meetings)) stats.withRelations++;
      if (rows.some((r) => String(r.comment || "").startsWith("[old-cabinet:"))) stats.oldCabinet++;
      if (shown < 15) { shown++; console.log(`— брокер ${g.broker_id.slice(0, 8)} лид ${g.amo_lead_id}: ${rows.map((r) => `${r.fullName?.slice(0, 18)}|${mask(r.phone)}|${r.createdAt.toISOString().slice(0, 10)}|${r.fixationStatus}/${r.uniquenessStatus}|d${r._count.deals}m${r._count.meetings}${String(r.comment || "").startsWith("[old-cabinet:") ? "|old" : ""}`).join("  ‖  ")}`); }
    }
    console.log("RESULT: " + JSON.stringify({ groups: groups.length, ...stats }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
