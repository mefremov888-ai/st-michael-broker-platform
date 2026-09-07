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
 *   node /app/scripts/retry-failed-amo-sync.js --ensure-brokers
 *   node /app/scripts/retry-failed-amo-sync.js --ensure-brokers --apply
 *
 * Rate-лимит amo ~7 req/s — идём последовательно с паузой 300мс.
 */

const crypto = require('crypto');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DIAGNOSE = args.includes('--diagnose');
const ENSURE_BROKERS = args.includes('--ensure-brokers');

function brokerAlias(id) {
  return `broker_${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;
}

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
        broker: { select: { id: true, fullName: true, phone: true, amoContactId: true } },
        responsibleBroker: { select: { id: true, fullName: true, phone: true, amoContactId: true } },
      },
      orderBy: { amoSyncLastAttemptAt: 'asc' },
    });

    console.log(`Найдено ${candidates.length} записей в очереди ошибок.`);

    if (ENSURE_BROKERS) {
      let ClientFixationService;
      try {
        ({ ClientFixationService } = require('/app/apps/api/dist/client-fixation/client-fixation.service'));
      } catch (e) {
        console.error('Cannot load ClientFixationService:', e?.message);
        process.exit(1);
      }
      const fixation = app.get(ClientFixationService);
      const byId = new Map();
      for (const c of candidates) {
        for (const b of [c.broker, c.responsibleBroker]) {
          if (b?.id && !byId.has(b.id)) byId.set(b.id, b);
        }
      }
      console.log(`Уникальных брокеров в очереди: ${byId.size}`);
      let already = 0;
      let created = 0;
      let failed = 0;
      for (const [id, b] of byId) {
        const had = Boolean(b.amoContactId);
        if (!APPLY) {
          console.log(`  [dry-run] ${brokerAlias(id)} amoContact=${had ? 'present' : 'missing'}`);
          continue;
        }
        try {
          const synced = await fixation.provisionBrokerAmoContact(id);
          const nowHas = Boolean(synced?.amoContactId);
          if (had && nowHas) already++;
          else if (nowHas) created++;
          else failed++;
          console.log(`  ${brokerAlias(id)} had=${had ? 'yes' : 'no'} now=${nowHas ? 'yes' : 'no'}`);
        } catch (e) {
          failed++;
          console.log(`  FAIL ${brokerAlias(id)} — ${e?.message || e}`);
        }
        await sleep(300);
      }
      if (!APPLY) {
        console.log('\nЭто dry-run. Для создания контактов в amoCRM запусти с --ensure-brokers --apply.');
        return;
      }
      console.log(`\nГотово: уже были ${already}, создано/продвинуто ${created}, ошибок ${failed} из ${byId.size}.`);
      return;
    }

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
