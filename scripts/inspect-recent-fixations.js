#!/usr/bin/env node
/**
 * Диагностика: последние N фиксаций клиентов с их amoSyncStatus/amoSyncError.
 * Нужен чтобы быстро понять что упало в createFixationRequest на проде.
 *
 * Запуск через workflow: task=inspect-recent-fixations [+ limit=10]
 */

(async () => {
  const LIMIT = Number(process.env.LIMIT) || 5;

  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();

  try {
    const clients = await prisma.client.findMany({
      orderBy: { createdAt: 'desc' },
      take: LIMIT,
      include: {
        broker: { select: { fullName: true, phone: true } },
      },
    });

    console.log(`═══════════════════════════════════════════`);
    console.log(`Последние ${clients.length} фиксаций:`);
    console.log(`═══════════════════════════════════════════`);

    for (const c of clients) {
      console.log(`\nClient ${c.id}`);
      console.log(`  createdAt: ${c.createdAt?.toISOString()}`);
      console.log(`  brokerId:  ${c.brokerId} (${c.broker?.fullName} / ${c.broker?.phone})`);
      console.log(`  fullName:  ${c.fullName}`);
      console.log(`  phone:     ${c.phone}`);
      console.log(`  project:   ${c.project}`);
      console.log(`  uniquenessStatus: ${c.uniquenessStatus}`);
      console.log(`  uniquenessReason: ${c.uniquenessReason}`);
      console.log(`  amoLeadId:       ${c.amoLeadId}`);
      console.log(`  amoSyncStatus:   ${c.amoSyncStatus}`);
      console.log(`  amoSyncError:    ${c.amoSyncError}`);
      console.log(`  amoSyncAttempts: ${c.amoSyncAttempts}`);
      console.log(`  amoSyncLastAttemptAt: ${c.amoSyncLastAttemptAt?.toISOString()}`);
    }
    console.log(`═══════════════════════════════════════════`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
