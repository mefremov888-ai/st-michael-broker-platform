#!/usr/bin/env node
// 2026-09-26: клиенты с несколькими попытками синка, последняя — вчера
// вечером (когда шли ошибки AMBIGUOUS_EXACT_CONTACT), чтобы понять, кто
// именно застревал и чем закончилось. Read-only.
const mask = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.client.findMany({
      where: {
        amoSyncAttempts: { gte: 5 },
        amoSyncLastAttemptAt: { gte: new Date("2026-09-25T00:00:00Z") },
      },
      orderBy: { amoSyncLastAttemptAt: "desc" },
      select: { id: true, fullName: true, phone: true, project: true, brokerId: true, responsibleBrokerId: true, amoSyncStatus: true, amoSyncError: true, amoSyncAttempts: true, amoSyncLastAttemptAt: true, amoLeadId: true, createdAt: true },
    });
    console.log(`Клиентов с 5+ попытками, последняя с 25.09: ${rows.length}`);
    for (const c of rows) {
      const respId = c.responsibleBrokerId || c.brokerId;
      const broker = await prisma.broker.findUnique({ where: { id: respId }, select: { fullName: true, phone: true, amoContactId: true } });
      console.log(`  ${c.fullName} (${mask(c.phone)}) | ${c.project} | статус ${c.amoSyncStatus}${c.amoSyncError ? ` (${c.amoSyncError})` : ""} | попыток ${c.amoSyncAttempts} | последняя ${c.amoSyncLastAttemptAt?.toISOString().slice(0,16)} | лид ${c.amoLeadId ?? "—"}`);
      console.log(`    ответственный: ${broker ? `${broker.fullName} (${mask(broker.phone)}, amo контакт ${broker.amoContactId ?? "—"})` : respId}`);
    }
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
