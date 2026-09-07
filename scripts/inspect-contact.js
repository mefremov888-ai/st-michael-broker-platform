#!/usr/bin/env node
/**
 * Печатает custom_fields контакта amoCRM. Для поиска field_id полей в левой панели
 * (Бюджет, Тип объекта, Цель покупки и т.д. — те что заполняет менеджер вручную).
 *
 * Запуск через workflow: task=inspect-contact + contact_id=<число>
 */

(async () => {
  const CONTACT_ID = Number(process.env.CONTACT_ID);
  if (!CONTACT_ID) {
    console.error('CONTACT_ID env required');
    process.exit(1);
  }

  const { NestFactory } = require('@nestjs/core');
  let AppModule;
  try {
    ({ AppModule } = require('/app/apps/api/dist/app.module'));
  } catch (e) {
    console.error('Cannot load Nest:', e?.message);
    process.exit(1);
  }
  const { AmoCrmAdapter } = require('/app/packages/integrations/dist/amo-crm.adapter');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const amo = new AmoCrmAdapter();
    const contact = await amo.getContact(CONTACT_ID);
    if (!contact) {
      console.log('Contact not found');
      process.exit(1);
    }
    console.log('═══════════════════════════════════');
    console.log(`Contact ${contact.id}: ${contact.name}`);
    console.log(`responsible_user_id: ${contact.responsible_user_id}`);
    console.log(`created_at: ${contact.created_at}`);
    console.log('───────────────────────────────────');
    console.log('field_id | field_name | code | values');
    for (const f of contact.custom_fields_values || []) {
      const vs = (f.values || []).map((v) => JSON.stringify(v.value || v)).join(', ');
      console.log(`${String(f.field_id).padEnd(8)} | ${String(f.field_name || '').padEnd(35).slice(0,35)} | ${String(f.field_code || '').padEnd(15).slice(0,15)} | ${vs}`);
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
