#!/usr/bin/env node
/**
 * 2026-09-08: вариант по ключу (broker_id, amo_lead_id) БЕЗ телефона и с
 * записями старого кабинета — для уникального индекса clients(broker_id,
 * amo_lead_id) (репетиция миграции упала на дублях). Правила те же:
 * 2026-09-08: ОБЪЕДИНЕНИЕ дублей клиентов (одинаковые телефон + брокер + лид amo,
 * записи нового кабинета). Дубли появились от синка amo (несколько записей
 * на один лид). Объединяем без потери данных:
 *   - keeper = самая старая запись группы;
 *   - сделки, встречи и прочие связи дублей переносятся на keeper;
 *   - если у дубля более «сильный» статус (зафиксирован вручную / есть
 *     comment / responsibleBrokerId), а у keeper пусто — переносится в keeper;
 *   - дубли удаляются; аудит (JSON без ПД) — в логе.
 * DRY_RUN=1 по умолчанию.
 *
 * Запуск в контейнере api (workflow apply-merge-duplicate-clients.yml).
 */

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log(`=== Режим: ${dryRun ? "DRY-RUN" : "APPLY (объединение дублей!)"} ===`);
    const groups = await prisma.$queryRawUnsafe(
      `SELECT broker_id AS "brokerId", amo_lead_id::text AS "amoLeadId", COUNT(*)::int AS n
       FROM clients WHERE amo_lead_id IS NOT NULL
       GROUP BY broker_id, amo_lead_id HAVING COUNT(*) > 1 ORDER BY n DESC`,
    );
    console.log(`Групп с дублями: ${groups.length}; лишних записей: ${groups.reduce((a, g) => a + (g.n - 1), 0)}`);
    const stats = { groups: groups.length, merged: 0, dealsMoved: 0, meetingsMoved: 0, fieldsCopied: 0 };
    const audit = [];
    for (const g of groups) {
      const rows = await prisma.client.findMany({
        where: { brokerId: g.brokerId, amoLeadId: BigInt(g.amoLeadId) },
        orderBy: { createdAt: "asc" },
        include: { _count: { select: { deals: true, meetings: true } } },
      });
      // keeper — самая старая запись НЕ из старого кабинета (живая запись синка);
      // если все из старого кабинета — самая старая. Телефоны в группе могут
      // отличаться — это фиксируется в аудите (phones).
      const isOld = (r) => String(r.comment || "").startsWith("[old-cabinet:");
      const ordered = [...rows.filter((r) => !isOld(r)), ...rows.filter(isOld)];
      const [keeper, ...dups] = ordered;
      const phones = [...new Set(rows.map((r) => r.phone))];
      if (phones.length > 1) stats.phoneMismatch = (stats.phoneMismatch || 0) + 1;
      if (!dups.length) continue;
      const patch = {};
      for (const d of dups) {
        if (!keeper.responsibleBrokerId && d.responsibleBrokerId) patch.responsibleBrokerId = d.responsibleBrokerId;
        if (!keeper.comment && d.comment) patch.comment = d.comment;
        if (keeper.fixationStatus === "NOT_FIXED" && d.fixationStatus !== "NOT_FIXED") { patch.fixationStatus = d.fixationStatus; patch.fixationExpiresAt = d.fixationExpiresAt; patch.fixationAgencyId = d.fixationAgencyId ?? keeper.fixationAgencyId; }
        if (!keeper.email && d.email) patch.email = d.email;
        if (!keeper.propertyType && d.propertyType) patch.propertyType = d.propertyType;
        if (!keeper.amount && d.amount) patch.amount = d.amount;
        if (!keeper.sqm && d.sqm) patch.sqm = d.sqm;
        // Самая свежая уникальность выигрывает (дубль обычно новее).
        if (d.uniquenessExpiresAt && (!keeper.uniquenessExpiresAt || d.uniquenessExpiresAt > keeper.uniquenessExpiresAt) && d.uniquenessStatus === "CONDITIONALLY_UNIQUE") { patch.uniquenessStatus = d.uniquenessStatus; patch.uniquenessExpiresAt = d.uniquenessExpiresAt; }
      }
      audit.push({ phones: phones.length, keeper: keeper.id, dups: dups.map((d) => ({ id: d.id, createdAt: d.createdAt.toISOString(), deals: d._count.deals, meetings: d._count.meetings, uniquenessStatus: d.uniquenessStatus })), patch: Object.keys(patch) });
      stats.merged += dups.length;
      stats.fieldsCopied += Object.keys(patch).length;
      stats.dealsMoved += dups.reduce((a, d) => a + d._count.deals, 0);
      stats.meetingsMoved += dups.reduce((a, d) => a + d._count.meetings, 0);
      if (dryRun) continue;
      await prisma.$transaction(async (tx) => {
        const ids = dups.map((d) => d.id);
        await tx.deal.updateMany({ where: { clientId: { in: ids } }, data: { clientId: keeper.id } });
        await tx.meeting.updateMany({ where: { clientId: { in: ids } }, data: { clientId: keeper.id } });
        if (Object.keys(patch).length) await tx.client.update({ where: { id: keeper.id }, data: patch });
        await tx.client.deleteMany({ where: { id: { in: ids } } });
      }, { timeout: 60000 });
    }
    console.log(`Объединено (удалено дублей): ${stats.merged}; перенесено сделок ${stats.dealsMoved}, встреч ${stats.meetingsMoved}; полей дописано в keeper ${stats.fieldsCopied}`);
    console.log("RESULT: " + JSON.stringify({ ...stats, dryRun }));
    if (!dryRun) { console.log("AUDIT_BEGIN"); for (const a of audit) console.log(JSON.stringify(a)); console.log("AUDIT_END"); }
    else console.log("DRY-RUN: ничего не изменено.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
