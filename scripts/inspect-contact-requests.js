#!/usr/bin/env node
/**
 * 2026-09-18: куда доезжают заявки с кнопок лендинга («Записаться на
 * брокер-тур», «Записаться на встречу», «Стать партнёром»). Только чтение:
 * сколько их, по каким источникам, сколько разобрано и когда была последняя.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const total = await prisma.contactRequest.count();
    const processed = await prisma.contactRequest.count({ where: { processedAt: { not: null } } });
    console.log(`Заявок с сайта всего: ${total}, отмечены как разобранные: ${processed}, без отметки: ${total - processed}\n`);

    const groups = await prisma.contactRequest.groupBy({
      by: ["source"],
      _count: { _all: true },
      _max: { createdAt: true },
    });
    console.log("=== По источникам ===");
    for (const g of groups.sort((a, b) => b._count._all - a._count._all)) {
      const last = g._max.createdAt ? new Date(g._max.createdAt).toISOString().slice(0, 16).replace("T", " ") : "—";
      console.log(`  ${String(g.source || "без источника").padEnd(20)} ${String(g._count._all).padStart(5)}   последняя ${last}`);
    }

    const recent = await prisma.contactRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { createdAt: true, source: true, name: true, phone: true, processedAt: true },
    });
    console.log("\n=== Последние десять ===");
    for (const r of recent) {
      const phone = r.phone ? `${String(r.phone).slice(0, 6)}***${String(r.phone).slice(-2)}` : "—";
      console.log(`  ${new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")} · ${String(r.source || "—").padEnd(16)} · ${String(r.name || "").slice(0, 25).padEnd(25)} · ${phone} · ${r.processedAt ? "разобрана" : "НЕ разобрана"}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
