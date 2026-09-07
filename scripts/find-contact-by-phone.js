#!/usr/bin/env node
/**
 * Находит контакт в amoCRM по телефону и печатает все связанные лиды.
 *
 * Запуск через workflow: task=find-contact-by-phone + phone=<число>
 */

(async () => {
  const PHONE = process.env.PHONE;
  if (!PHONE) {
    console.error('PHONE env var required');
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

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const amo = new AmoCrmAdapter();
    console.log('═══════════════════════════════════');
    console.log(`Поиск контакта по телефону: ${PHONE}`);
    console.log('═══════════════════════════════════');

    const contact = await amo.findContactByPhone(PHONE);
    if (!contact) {
      console.log('Контакт не найден в amoCRM');
      return;
    }

    console.log(`Найден контакт: id=${contact.id}  name="${contact.name}"`);

    const fullContact = await amo.getContact(contact.id);
    const leads = fullContact?._embedded?.leads || [];
    if (leads.length === 0) {
      console.log('Связанных лидов нет');
      return;
    }

    console.log(`\nСвязанных лидов: ${leads.length}`);
    console.log('───────────────────────────────────');
    console.log('leadId    | pipeline | status   | created    | name');
    console.log('───────────────────────────────────');
    for (const leadRef of leads) {
      try {
        const lead = await amo.getLead(leadRef.id);
        if (!lead) {
          console.log(`${String(leadRef.id).padEnd(9)} | (lead not found)`);
          continue;
        }
        const created = lead.created_at ? new Date(lead.created_at * 1000).toISOString().slice(0, 10) : '—';
        const pip = String(lead.pipeline_id || '-').padEnd(8);
        const st = String(lead.status_id || '-').padEnd(8);
        const nm = String(lead.name || '').slice(0, 60);
        // Also show responsible_user_id (whose lead it is)
        console.log(`${String(lead.id).padEnd(9)} | ${pip} | ${st} | ${created.padEnd(10)} | ${nm}`);
      } catch (e) {
        console.log(`${String(leadRef.id).padEnd(9)} | ERROR: ${e?.message}`);
      }
    }

    console.log('\n═══════════════════════════════════');
    console.log('Pipelines: 7600542=КЦ  7600546=Берзарина(СБ)  7600550=Зорге9  7600554=Толбухина  10787390=Брокеры');
    console.log('Status 142=Успешно, 143=Закрыто-не-реализовано');
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
