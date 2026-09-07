#!/usr/bin/env node
/**
 * Печатает ВСЕ custom_fields определения для контактов в amoCRM.
 * GET /api/v4/contacts/custom_fields — возвращает все поля, даже не заполненные.
 *
 * Для поиска field_id контактных полей чтобы потом авто-заполнять при фиксации.
 */

(async () => {
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
    const r = await amo.request('/contacts/custom_fields?limit=250');
    const fields = r?._embedded?.custom_fields || [];
    console.log('═══════════════════════════════════');
    console.log(`CONTACT CUSTOM FIELDS: ${fields.length} total`);
    console.log('═══════════════════════════════════');
    console.log('field_id  | type       | code             | name');
    console.log('───────────────────────────────────');
    for (const f of fields) {
      console.log(`${String(f.id).padEnd(9)} | ${String(f.type || '').padEnd(10).slice(0,10)} | ${String(f.code || '').padEnd(16).slice(0,16)} | ${f.name}`);
      if (f.enums && f.enums.length > 0) {
        // Print possible values for enum/select fields
        for (const e of f.enums.slice(0, 10)) {
          console.log(`            └─ enum: ${e.id} = "${e.value}"`);
        }
      }
    }
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
