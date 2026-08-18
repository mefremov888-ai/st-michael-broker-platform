#!/usr/bin/env node
/**
 * 2026-08-18: массовый ретрай фиксаций, зависших в очереди ошибок amoCRM
 * из-за WAF-блокировки IP сервера (13-18.08.2026, снята вручную поддержкой
 * amoCRM). Часть из них уже исчерпала лимит автоматических попыток
 * (amoSyncAttempts >= 10 в scheduler.service.ts handleAmoFailedRetry),
 * поэтому крон их больше не подхватывает — нужен разовый ручной прогон.
 *
 * Переиспользует ровно ту же логику, что и кнопка «Повторить» в
 * /admin/broker-applications (AdminService.retryAmoSync).
 *
 * Запуск в контейнере api (через workflow retry-failed-amo-sync.yml):
 *   node /app/scripts/retry-failed-amo-sync.js            # dry-run (по умолчанию)
 *   node /app/scripts/retry-failed-amo-sync.js --apply    # реально отправить
 *
 * Rate-лимит amo ~7 req/s — идём последовательно с паузой 300мс.
 */

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DIAGNOSE = args.includes('--diagnose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { NestFactory } = require('@nestjs/core');
  let AppModule, AdminService;
  try {
    ({ AppModule } = require('/app/apps/api/dist/app.module'));
    ({ AdminService } = require('/app/apps/api/dist/admin/admin.service'));
  } catch (e) {
    console.error('Cannot load Nest:', e?.message);
    process.exit(1);
  }
  const { PrismaClient } = require('@st-michael/database');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = new PrismaClient();
  const adminService = app.get(AdminService);

  try {
    const candidates = await prisma.client.findMany({
      where: { amoSyncStatus: { in: ['FAILED', 'PENDING'] } },
      select: {
        id: true, fullName: true, phone: true, amoSyncAttempts: true, amoSyncError: true,
        broker: { select: { fullName: true, phone: true, amoContactId: true } },
        responsibleBroker: { select: { fullName: true, phone: true, amoContactId: true } },
      },
      orderBy: { amoSyncLastAttemptAt: 'asc' },
    });

    console.log(`Найдено ${candidates.length} записей в очереди ошибок.`);

    if (DIAGNOSE) {
      for (const c of candidates) {
        const rb = c.responsibleBroker || c.broker;
        console.log(`  ${c.fullName} (${c.phone}) <- брокер: ${rb?.fullName} (${rb?.phone}), amoContactId=${rb?.amoContactId || 'НЕТ'}`);
      }
      return;
    }

    if (!APPLY) {
      for (const c of candidates) {
        console.log(`  [dry-run] ${c.fullName} (${c.phone}) — попыток: ${c.amoSyncAttempts}, ошибка: ${String(c.amoSyncError || '').slice(0, 80)}`);
      }
      console.log('\nЭто dry-run. Для реальной отправки запусти с --apply.');
      return;
    }

    let ok = 0;
    let fail = 0;
    for (const c of candidates) {
      try {
        const res = await adminService.retryAmoSync(c.id);
        console.log(`  OK: ${c.fullName} (${c.phone}) — ${JSON.stringify(res)}`);
        ok++;
      } catch (e) {
        console.log(`  FAIL: ${c.fullName} (${c.phone}) — ${e?.message || e}`);
        fail++;
      }
      await sleep(300);
    }
    console.log(`\nГотово: успешно ${ok}, ошибок ${fail} из ${candidates.length}.`);
  } finally {
    await prisma.$disconnect();
    await app.close();
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
