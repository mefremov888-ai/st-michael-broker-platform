#!/usr/bin/env node
/**
 * 2026-06-15: backfill Client.amoLeadId для повторных Client, созданных
 * между PR #126 и PR #140. После PR #126 такие записи создавались с
 * amoLeadId=null (исходя из неверной идеи «не путаем webhook-роутинг»).
 *
 * Алгоритм:
 *  1. Для каждого Client с amoLeadId=null ищем «sibling» Client с тем же
 *     телефоном, у которого amoLeadId есть.
 *  2. Берём amoLeadId самого свежего sibling (по createdAt) и подставляем
 *     в Client без amoLeadId.
 *  3. Логируем сколько обновили.
 *
 * После этого webhook на open/close лида будет находить ВСЕ Client с
 * этим amoLeadId (включая «повторные» от других брокеров) и правильно
 * обновлять uniquenessStatus.
 *
 * Запуск через workflow: task=backfill-client-amo-lead-id (dry-run по
 * умолчанию). Для реальной записи: input apply=true.
 */
const { PrismaClient } = require('@st-michael/database');

(async () => {
  const apply = String(process.env.APPLY || 'false') === 'true';
  console.log(`═══════════════════════════════════════════`);
  console.log(`backfill Client.amoLeadId  mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`═══════════════════════════════════════════`);

  const prisma = new PrismaClient();

  const orphans = await prisma.client.findMany({
    where: { amoLeadId: null },
    select: { id: true, phone: true, fullName: true, brokerId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`Найдено Client без amoLeadId: ${orphans.length}`);

  let updated = 0;
  let noSibling = 0;
  for (const c of orphans) {
    const sibling = await prisma.client.findFirst({
      where: { phone: c.phone, amoLeadId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, amoLeadId: true, createdAt: true },
    });
    if (!sibling) {
      noSibling++;
      continue;
    }
    console.log(`Client ${c.id} (${c.phone} ${c.fullName}, broker=${c.brokerId}, ${c.createdAt.toISOString().slice(0,10)}) → amoLeadId=${sibling.amoLeadId.toString()} (от ${sibling.id})`);
    if (apply) {
      await prisma.client.update({
        where: { id: c.id },
        data: { amoLeadId: sibling.amoLeadId },
      });
      updated++;
    }
  }
  console.log(`═══════════════════════════════════════════`);
  console.log(`Без подходящего sibling: ${noSibling}`);
  console.log(`Обновлено: ${updated}${apply ? '' : ' (DRY-RUN — фактически не записано)'}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
