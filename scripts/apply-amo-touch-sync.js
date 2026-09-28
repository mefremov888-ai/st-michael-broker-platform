#!/usr/bin/env node
/**
 * 2026-09-28: ручной запуск ночного синка «касаний» amoCRM →
 * BrokerAmoContactSync / AmoUser (AmoTouchSyncService), в контейнере api.
 *
 * Зачем отдельно от крона: первый прогон (бэкфилл 13,7 тыс. контактов)
 * и проверка правил на проде в режиме dry-run. Сервис берётся из сборки
 * apps/api/dist и инстанцируется НАПРЯМУЮ — без NestFactory(AppModule),
 * чтобы внутри скрипта не поднялись шедулеры (кроны синка) и не съели
 * память (инцидент 08.09: 2 ГБ RAM). Токены amo — из SystemSetting с
 * refresh-hook (тот же приём, что canary-amo-check.js).
 *
 * Env:
 *   MODE=dry-run|apply      (по умолчанию dry-run — ничего не пишет)
 *   MAX_CONTACTS=2000       сколько изменившихся контактов обработать в фазе 2
 *   PHASES=0,1,2,3          какие фазы выполнять
 *   LOOKUP_QUOTA=300        квота фазы 3 (поиск по телефону)
 *   BACKFILL=1              перечитать касания у всех (игнорировать updated_at)
 *
 * dry-run делает ВСЕ чтения из amo и все записи внутри транзакции с откатом —
 * ошибки записи видны до боевого прогона.
 *
 * Вывод: сводка одной строкой AMO_TOUCH_SYNC_<STATUS> + примеры изменений
 * (телефоны замаскированы). Exit: 0 — SUCCEEDED, 1 — FAILED, 2 — SKIPPED.
 */

'use strict';

const MODE = process.env.MODE === 'apply' ? 'apply' : 'dry-run';

function positiveInt(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function parsePhases(raw) {
  if (!raw) return undefined;
  const phases = String(raw)
    .split(/[,\s;]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => [0, 1, 2, 3].includes(n));
  return phases.length ? phases : undefined;
}

(async () => {
  const {
    setAmoTokens,
    setAmoTokenRefreshHook,
  } = require('/app/packages/integrations/dist/amo-crm.adapter');
  const { PrismaClient } = require('@st-michael/database');
  const { AmoTouchSyncService } = require('/app/apps/api/dist/amocrm/amo-touch-sync.service');
  const prisma = new PrismaClient();

  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ['AMO_ACCESS_TOKEN', 'AMO_REFRESH_TOKEN'] } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    setAmoTokens(
      byKey.get('AMO_ACCESS_TOKEN') || process.env.AMO_ACCESS_TOKEN || '',
      byKey.get('AMO_REFRESH_TOKEN') || process.env.AMO_REFRESH_TOKEN || '',
    );
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [
        ['AMO_ACCESS_TOKEN', tokens.access],
        ['AMO_REFRESH_TOKEN', tokens.refresh],
      ]) {
        await prisma.systemSetting.upsert({
          where: { key },
          update: { value, updatedBy: 'apply-amo-touch-sync' },
          create: { key, value, updatedBy: 'apply-amo-touch-sync' },
        });
      }
      console.error('amo tokens refreshed and persisted');
    });

    // Алерты в ТГ отправляет ночной крон; здесь — только в лог workflow.
    const opsAlerts = {
      sendSafely: async (message) => {
        console.log(`[ops-alert] ${message}`);
        return true;
      },
    };

    const opts = {
      mode: MODE,
      maxContacts: positiveInt(process.env.MAX_CONTACTS),
      phases: parsePhases(process.env.PHASES),
      lookupQuota: positiveInt(process.env.LOOKUP_QUOTA),
      backfill: /^(1|true|yes)$/i.test(String(process.env.BACKFILL || '')),
    };
    console.log(
      `=== amo-touch-sync ${MODE.toUpperCase()} maxContacts=${opts.maxContacts ?? 'default'} ` +
        `phases=${opts.phases ? opts.phases.join(',') : 'all'} lookupQuota=${opts.lookupQuota ?? 'default'} ` +
        `backfill=${opts.backfill} ===`,
    );

    const service = new AmoTouchSyncService(prisma, opsAlerts);
    const result = await service.run(opts);

    console.log(`AMO_TOUCH_SYNC_${result.status} run=${result.runId || '-'} errorCode=${result.errorCode || '-'}` +
      (result.reason ? ` reason=${result.reason}` : ''));
    console.log(JSON.stringify({ mode: result.mode, backfillDone: result.backfillDone, ...result.stats }));
    if (result.samples.length) {
      console.log('Примеры изменений:');
      for (const sample of result.samples) console.log(`  ${sample}`);
    }
    if (MODE !== 'apply') {
      console.log('ПРОГОН БЕЗ ЗАПИСИ: изменения откачены (MODE=apply — боевой режим).');
    }
    if (result.status === 'FAILED') process.exitCode = 1;
    else if (result.status === 'SKIPPED') process.exitCode = 2;
  } catch (e) {
    console.error('FATAL:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
