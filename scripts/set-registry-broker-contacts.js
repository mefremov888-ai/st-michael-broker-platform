#!/usr/bin/env node
/**
 * 2026-09-08: проставить registry_deals.broker_amo_contact_id по подготовленному
 * списку (data/registry-broker-contacts.json: {rows:[{id, brokerAmoContactId,
 * contractNumber}]}) — контакты лида с флагом «Брокер»/компанией-агентством,
 * отобранные вручную (решение владельца). Пишет ТОЛЬКО в строки без брокера и
 * без контакта. Дальше карточки заводит create-brokers-from-registry-contacts.
 * DRY_RUN=1 — только отчёт.
 */
const fs = require("fs");
async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const file = process.argv[2] || "/app/registry-broker-contacts.json";
  const rows = JSON.parse(fs.readFileSync(file, "utf8")).rows || [];
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log(`Режим: ${dryRun ? "DRY-RUN" : "APPLY"}; строк в списке: ${rows.length}`);
    const targets = await prisma.registryDeal.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, contractNumber: true, brokerId: true, brokerAmoContactId: true } });
    const byId = new Map(targets.map((t) => [t.id, t]));
    const stats = { missing: 0, hasBroker: 0, hasContact: 0, plan: 0 }; const plan = [];
    for (const r of rows) {
      const t = byId.get(r.id);
      if (!t) { stats.missing++; continue; }
      if (t.brokerId) { stats.hasBroker++; continue; }
      if (t.brokerAmoContactId) { stats.hasContact++; console.log(`  ~ ${t.contractNumber}: уже контакт ${t.brokerAmoContactId} (в списке ${r.brokerAmoContactId})`); continue; }
      stats.plan++; plan.push({ id: r.id, cid: String(r.brokerAmoContactId), cn: t.contractNumber });
    }
    for (const p of plan) console.log(`  • ${p.cn} → контакт ${p.cid}`);
    let done = 0;
    if (!dryRun) for (const p of plan) { const res = await prisma.registryDeal.updateMany({ where: { id: p.id, brokerId: null, brokerAmoContactId: null }, data: { brokerAmoContactId: BigInt(p.cid) } }); done += res.count; }
    console.log("RESULT: " + JSON.stringify({ ...stats, updated: done, dryRun }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
