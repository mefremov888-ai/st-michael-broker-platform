#!/usr/bin/env node
/**
 * 2026-07-23: Разовый синк ответственного лида из последней задачи MoreKIT.
 *
 * Кейс: лид завис на Админе («Без КЦ»), потому что MoreKIT назначил
 * оператора в задаче ПОЗЖЕ, чем отработал 5-минутный поллинг при
 * создании фиксации. Скрипт берёт ответственного из самой свежей задачи
 * лида и ставит его в карточку — та же логика syncLeadResponsibleFromLatestTask,
 * но с немедленной проверкой (без ожидания).
 *
 * Запуск в контейнере api (workflow sync-lead-responsible.yml):
 *   LEAD_ID=32262709 node /app/scripts/sync-lead-responsible.js
 */

(async () => {
  const leadId = Number(process.env.LEAD_ID || process.argv[2]);
  if (!leadId) {
    console.error('Не задан LEAD_ID');
    process.exit(1);
  }

  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('/app/apps/api/dist/app.module');
  const { AmoCrmAdapter } = require('/app/packages/integrations/dist/amo-crm.adapter');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const amo = new AmoCrmAdapter();
  try {
    const before = await amo.getLead(leadId);
    console.log(`Лид ${leadId}: текущий ответственный = ${before?.responsible_user_id ?? '(нет)'}`);

    const tasks = await amo.getTasksByEntity('leads', leadId);
    const withResp = tasks.filter((t) => !!t.responsible_user_id)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    console.log(`Задач с ответственным: ${withResp.length}`);
    for (const t of withResp.slice(0, 5)) {
      console.log(`  задача ${t.id}: responsible=${t.responsible_user_id}, created=${new Date((t.created_at || 0) * 1000).toISOString()}`);
    }

    // Немедленная проверка: intervalMs=0, одна попытка.
    const changed = await amo.syncLeadResponsibleFromLatestTask(leadId, { intervalMs: 0, maxAttempts: 1 });
    const after = await amo.getLead(leadId);
    console.log(`Результат: ${changed ? 'ОБНОВЛЕНО' : 'без изменений'}; ответственный теперь = ${after?.responsible_user_id ?? '(нет)'}`);
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error('Fatal:', e?.message || e);
  process.exit(1);
});
