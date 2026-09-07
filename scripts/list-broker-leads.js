#!/usr/bin/env node
/**
 * Печатает список ВСЕХ лидов из amoCRM для каждого ACTIVE-брокера в БД.
 * Колонки: leadId | pipeline_id | status_id | created_at | имя.
 *
 * Запуск через workflow: task=list-broker-leads
 */

(async () => {
  const { NestFactory } = require('@nestjs/core');
  let AppModule, AmocrmService;
  try {
    ({ AppModule } = require('/app/apps/api/dist/app.module'));
    ({ AmocrmService } = require('/app/apps/api/dist/amocrm/amocrm.service'));
  } catch (e) {
    console.error('Cannot load Nest modules:', e?.message);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    // Prisma через DI (token 'PrismaClient' — см. database.module.ts)
    const prisma = app.get('PrismaClient', { strict: false });
    if (!prisma) {
      console.error('Cannot resolve PrismaClient from Nest context');
      process.exit(1);
    }
    const amoSvc = app.get(AmocrmService);
    const { AmoCrmAdapter } = require('/app/packages/integrations/dist/amo-crm.adapter');
    const amo = new AmoCrmAdapter();

    const brokers = await prisma.broker.findMany({
      where: { status: 'ACTIVE', amoContactId: { not: null } },
      select: { id: true, fullName: true, phone: true, amoContactId: true },
      orderBy: { fullName: 'asc' },
    });

    for (const broker of brokers) {
      console.log(`\n═══════════════════════════════════`);
      console.log(`Брокер: ${broker.fullName}  (${broker.phone})  amoContactId=${broker.amoContactId}`);
      console.log(`───────────────────────────────────`);
      try {
        const fullContact = await amo.getContact(Number(broker.amoContactId));
        const linkedLeads = fullContact?._embedded?.leads || [];
        if (linkedLeads.length === 0) {
          console.log('  (нет лидов)');
          continue;
        }
        console.log(`leadId    | pipeline | status   | created    | name`);
        for (const leadRef of linkedLeads) {
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
            console.log(`${String(lead.id).padEnd(9)} | ${pip} | ${st} | ${created.padEnd(10)} | ${nm}`);
          } catch (e) {
            console.log(`${String(leadRef.id).padEnd(9)} | ERROR: ${e?.message}`);
          }
        }
      } catch (e) {
        console.log(`  ERROR fetching contact: ${e?.message}`);
      }
    }

    console.log(`\n═══════════════════════════════════`);
    console.log(`Pipelines:  7600542=КЦ  7600546=Берзарина(СБ)  7600550=Зорге9  7600554=Толбухина  10787390=Брокеры`);
    console.log(`Status 142=Успешно реализовано, 143=Закрыто-не-реализовано`);
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
