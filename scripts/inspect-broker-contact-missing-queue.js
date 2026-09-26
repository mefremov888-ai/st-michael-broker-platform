#!/usr/bin/env node
// 2026-09-26: все клиенты с amoSyncError=BROKER_AMO_CONTACT_MISSING (любой
// статус), не только FAILED — этот код ставит PENDING. Read-only.
const mask = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.client.findMany({
      where: { amoSyncError: "BROKER_AMO_CONTACT_MISSING" },
      orderBy: { amoSyncLastAttemptAt: "desc" },
      select: { id: true, fullName: true, phone: true, project: true, brokerId: true, responsibleBrokerId: true, amoSyncStatus: true, amoSyncAttempts: true, amoSyncLastAttemptAt: true, createdAt: true },
    });
    console.log(`Всего клиентов с BROKER_AMO_CONTACT_MISSING: ${rows.length}`);
    for (const c of rows) {
      const respId = c.responsibleBrokerId || c.brokerId;
      const broker = await prisma.broker.findUnique({ where: { id: respId }, select: { fullName: true, phone: true, amoContactId: true, status: true } });
      console.log(`  ${c.fullName} (${mask(c.phone)}) | ${c.project} | статус ${c.amoSyncStatus} | попыток ${c.amoSyncAttempts} | последняя ${c.amoSyncLastAttemptAt?.toISOString().slice(0,16) || "—"} | создан ${c.createdAt.toISOString().slice(0,16)}`);
      console.log(`    ответственный: ${broker ? `${broker.fullName} (${mask(broker.phone)}, amo контакт ${broker.amoContactId ?? "—"}, ${broker.status})` : respId}`);
    }
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
