#!/usr/bin/env node
// 2026-09-26: клиенты, у которых была попытка синка ровно в окне
// 25.09 15:45–17:10 UTC (когда шли AMBIGUOUS_EXACT_CONTACT), любой статус.
const mask = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.client.findMany({
      where: { amoSyncLastAttemptAt: { gte: new Date("2026-09-25T15:40:00Z"), lte: new Date("2026-09-25T17:15:00Z") } },
      orderBy: { amoSyncLastAttemptAt: "asc" },
      select: { id: true, fullName: true, phone: true, project: true, brokerId: true, responsibleBrokerId: true, amoSyncStatus: true, amoSyncError: true, amoSyncAttempts: true, amoSyncLastAttemptAt: true, amoLeadId: true },
    });
    console.log(`Найдено записей в окне: ${rows.length}`);
    for (const c of rows) {
      const respId = c.responsibleBrokerId || c.brokerId;
      const broker = await prisma.broker.findUnique({ where: { id: respId }, select: { fullName: true, phone: true, amoContactId: true } });
      console.log(`  ${c.fullName} (${mask(c.phone)}) | ${c.project} | ${c.amoSyncStatus}${c.amoSyncError ? ` (${c.amoSyncError})` : ""} | попыток ${c.amoSyncAttempts} | ${c.amoSyncLastAttemptAt.toISOString()} | лид ${c.amoLeadId ?? "—"}`);
      console.log(`    ответственный: ${broker ? `${broker.fullName} (${mask(broker.phone)}, amo контакт ${broker.amoContactId ?? "—"})` : respId}`);
    }
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
