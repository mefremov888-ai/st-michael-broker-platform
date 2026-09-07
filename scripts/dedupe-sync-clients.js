#!/usr/bin/env node
/**
 * 2026-09-08 (ночь): удаление дублей клиентов, созданных синком amo.
 * Причина: правило «не исторический клиент» отбрасывало записи с пустым
 * комментарием (NOT startsWith vs NULL) → синк не находил существующую запись
 * и создавал новую с тем же телефоном, брокером и лидом. Исправлено hotfix
 * (поезд 26), этот скрипт убирает последствия.
 *
 * Дубль = записи нового кабинета с одинаковыми (phone, broker_id, amo_lead_id).
 * Оставляем САМУЮ СТАРУЮ (keeper), удаляем более новые, если:
 *   - created_at >= SINCE (по умолчанию 2026-09-07T06:00Z; ALL=1 — без ограничения);
 *   - у дубля нет сделок и встреч (иначе пропуск с отчётом);
 *   - дубль не «зафиксирован» вручную (fixationStatus = NOT_FIXED).
 * Аудит: для каждого удалённого — JSON без ПД (id, brokerId, amoLeadId,
 * статусы, даты). DRY_RUN=1 по умолчанию.
 */

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const all = process.env.ALL === "1";
  const since = new Date(process.env.SINCE || "2026-09-07T06:00:00Z");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log(`=== Режим: ${dryRun ? "DRY-RUN" : "APPLY (удаление дублей!)"} · ${all ? "все дубли" : `новые с ${since.toISOString()}`} ===`);
    const groups = await prisma.$queryRawUnsafe(
      `SELECT phone, broker_id AS "brokerId", amo_lead_id::text AS "amoLeadId", COUNT(*)::int AS n
       FROM clients WHERE amo_lead_id IS NOT NULL AND (comment IS NULL OR comment NOT LIKE '[old-cabinet:%')
       GROUP BY phone, broker_id, amo_lead_id HAVING COUNT(*) > 1 ORDER BY n DESC`,
    );
    console.log(`Групп (телефон+брокер+лид) с дублями: ${groups.length}; лишних записей всего: ${groups.reduce((a, g) => a + (g.n - 1), 0)}`);
    const stats = { candidates: 0, skipRecent: 0, skipHasRelations: 0, skipFixed: 0, toDelete: 0 };
    const deletions = [];
    for (const g of groups) {
      const rows = await prisma.client.findMany({
        where: { phone: g.phone, brokerId: g.brokerId, amoLeadId: BigInt(g.amoLeadId), OR: [{ comment: null }, { NOT: { comment: { startsWith: "[old-cabinet:" } } }] },
        orderBy: { createdAt: "asc" },
        select: { id: true, createdAt: true, uniquenessStatus: true, uniquenessExpiresAt: true, fixationStatus: true, project: true, responsibleBrokerId: true, _count: { select: { deals: true, meetings: true } } },
      });
      const [keeper, ...dups] = rows;
      for (const d of dups) {
        stats.candidates++;
        if (!all && d.createdAt < since) { stats.skipRecent++; continue; }
        if (d._count.deals || d._count.meetings) { stats.skipHasRelations++; continue; }
        if (d.fixationStatus !== "NOT_FIXED") { stats.skipFixed++; continue; }
        stats.toDelete++;
        deletions.push({ id: d.id, keeperId: keeper.id, brokerId: g.brokerId, amoLeadId: g.amoLeadId, createdAt: d.createdAt.toISOString(), uniquenessStatus: d.uniquenessStatus, uniquenessExpiresAt: d.uniquenessExpiresAt ? d.uniquenessExpiresAt.toISOString() : null, project: d.project, responsibleBrokerId: d.responsibleBrokerId });
      }
    }
    console.log(`Кандидатов (лишних записей): ${stats.candidates}; пропуск — старше SINCE: ${stats.skipRecent}, есть сделки/встречи: ${stats.skipHasRelations}, зафиксирован вручную: ${stats.skipFixed}`);
    console.log(`К удалению: ${stats.toDelete}`);
    console.log("RESULT: " + JSON.stringify({ groups: groups.length, ...stats, dryRun, all }));
    if (dryRun) { console.log("DRY-RUN: ничего не удалено. Для удаления DRY_RUN=0."); return; }
    console.log("AUDIT_BEGIN");
    for (const d of deletions) console.log(JSON.stringify(d));
    console.log("AUDIT_END");
    let deleted = 0;
    for (let i = 0; i < deletions.length; i += 200) {
      const ids = deletions.slice(i, i + 200).map((d) => d.id);
      const res = await prisma.client.deleteMany({ where: { id: { in: ids }, deals: { none: {} }, meetings: { none: {} } } });
      deleted += res.count;
    }
    console.log(`deleted=${deleted}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
