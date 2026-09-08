#!/usr/bin/env node
/**
 * 2026-09-08: точечная привязка строк реестра к брокерам по подготовленному
 * списку (data/registry-broker-ids.json: [{id, brokerId, contractNumber,
 * channel}]) — результат inspect-registry-broker-channels, отфильтрованный
 * офлайн (только однозначные совпадения). Пишет brokerId ТОЛЬКО в пустые;
 * проверяет, что брокер существует (role BROKER, не слит). DRY_RUN=1 по умолчанию.
 */
const fs = require("node:fs");

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const file = process.argv[2] || "/app/registry-broker-ids.json";
  const rows = JSON.parse(fs.readFileSync(file, "utf8")).rows || [];
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log(`=== Режим: ${dryRun ? "DRY-RUN" : "APPLY"} · строк в файле: ${rows.length} ===`);
    const brokerIds = [...new Set(rows.map((r) => r.brokerId))];
    const brokers = new Map((await prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, role: true, mergedIntoId: true } })).map((b) => [b.id, b]));
    const targets = await prisma.registryDeal.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, brokerId: true, contractNumber: true } });
    const tmap = new Map(targets.map((t) => [t.id, t]));
    const stats = { ok: 0, rowMissing: 0, alreadyLinked: 0, brokerInvalid: 0, byChannel: {} };
    const plan = [];
    for (const r of rows) {
      const t = tmap.get(r.id);
      if (!t) { stats.rowMissing++; continue; }
      if (t.brokerId) { stats.alreadyLinked++; continue; }
      const b = brokers.get(r.brokerId);
      if (!b || b.role !== "BROKER" || b.mergedIntoId) { stats.brokerInvalid++; continue; }
      stats.ok++; stats.byChannel[r.channel] = (stats.byChannel[r.channel] || 0) + 1;
      plan.push({ id: r.id, brokerId: r.brokerId });
    }
    console.log(`К записи: ${stats.ok}; строка не найдена ${stats.rowMissing}; уже с брокером ${stats.alreadyLinked}; брокер невалиден ${stats.brokerInvalid}; по каналам ${JSON.stringify(stats.byChannel)}`);
    console.log("RESULT: " + JSON.stringify({ ...stats, dryRun }));
    if (dryRun) { console.log("DRY-RUN: ничего не записано."); return; }
    let done = 0;
    for (const p of plan) { const res = await prisma.registryDeal.updateMany({ where: { id: p.id, brokerId: null }, data: { brokerId: p.brokerId } }); done += res.count; }
    console.log(`updated=${done}`);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
