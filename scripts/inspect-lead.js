#!/usr/bin/env node
/**
 * Диагностика лида в amoCRM — печатает все custom fields лида.
 * Используется для поиска ID полей "Комиссия в рублях", "Комиссия брокера" и т.п.
 *
 * Запуск через workflow: task=inspect-lead + lead_id=<число>
 */

(async () => {
  const LEAD_ID = Number(process.env.LEAD_ID);
  if (!LEAD_ID || isNaN(LEAD_ID)) {
    console.error('LEAD_ID env var required (positive integer)');
    process.exit(1);
  }

  const { NestFactory } = require('@nestjs/core');
  let AppModule, AmocrmService;
  try {
    ({ AppModule } = require('/app/apps/api/dist/app.module'));
    ({ AmocrmService } = require('/app/apps/api/dist/amocrm/amocrm.service'));
  } catch (e) {
    console.error('Cannot load Nest modules from /app/apps/api/dist:', e?.message);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const svc = app.get(AmocrmService);
    const data = await svc.inspectLead(LEAD_ID);
    if (data?.error) {
      console.error('ERROR:', data.error);
      process.exit(1);
    }
    console.log('═══════════════════════════════════');
    console.log(`Lead ${data.id}: ${data.name}`);
    console.log(`pipeline_id: ${data.pipeline_id}  status_id: ${data.status_id}`);
    console.log(`price: ${data.price}  created_at: ${data.created_at} (${new Date(data.created_at * 1000).toISOString()})`);
    console.log(`responsible_user_id (системный): ${data.responsible_user_id}`);
    console.log(`custom_fields_count: ${data.custom_fields_count}`);
    console.log('───────────────────────────────────');
    console.log('field_id | field_name | code | values');
    console.log('───────────────────────────────────');
    for (const f of data.custom_fields || []) {
      const vs = (f.values || []).map((v) => JSON.stringify(v.value)).join(', ');
      console.log(`${String(f.field_id).padEnd(8)} | ${String(f.field_name || '').padEnd(35).slice(0,35)} | ${String(f.field_code || '').padEnd(15).slice(0,15)} | ${vs}`);
    }
    console.log('═══════════════════════════════════');
    console.log(`Задачи на лиде (${(data.tasks || []).length}):`);
    console.log('───────────────────────────────────');
    console.log('task_id | task_type | responsible_user_id | is_completed | text');
    console.log('───────────────────────────────────');
    for (const t of data.tasks || []) {
      console.log(`${String(t.id).padEnd(10)} | ${String(t.task_type_id).padEnd(9)} | ${String(t.responsible_user_id).padEnd(19)} | ${String(t.is_completed).padEnd(12)} | ${String(t.text || '').slice(0, 80)}`);
    }
    console.log('═══════════════════════════════════');
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
