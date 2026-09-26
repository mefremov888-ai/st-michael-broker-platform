#!/usr/bin/env node
// 2026-09-26: живой срез очереди фиксаций (amoSyncStatus=FAILED) за всё
// время — какие ошибки сейчас реально держат заявки. Read-only, запускается
// внутри контейнера api (нет доступа к docker logs хоста — это отдельно).
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const failed = await prisma.client.count({ where: { amoSyncStatus: "FAILED" } });
    const byError = await prisma.client.groupBy({
      by: ["amoSyncError"],
      where: { amoSyncStatus: "FAILED" },
      _count: true,
      orderBy: { _count: { amoSyncError: "desc" } },
      take: 15,
    });
    console.log(`=== Клиентов с amoSyncStatus=FAILED: ${failed} ===`);
    for (const row of byError) console.log(`  ${row._count} × ${String(row.amoSyncError || "(без текста)").slice(0, 200)}`);

    const recent = await prisma.client.findMany({
      where: { amoSyncStatus: "FAILED" },
      orderBy: { amoSyncLastAttemptAt: "desc" },
      take: 10,
      select: { fullName: true, project: true, amoSyncError: true, amoSyncAttempts: true, amoSyncLastAttemptAt: true, createdAt: true },
    });
    console.log("\n=== 10 последних по времени попытки ===");
    for (const c of recent) {
      console.log(`  ${c.fullName} | ${c.project} | попыток ${c.amoSyncAttempts} | последняя ${c.amoSyncLastAttemptAt?.toISOString().slice(0, 16) || "—"} | ${String(c.amoSyncError || "").slice(0, 150)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
