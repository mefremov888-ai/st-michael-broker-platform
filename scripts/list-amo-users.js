#!/usr/bin/env node
/**
 * Печатает всех пользователей amoCRM с ролями и группами.
 * Помогает найти КЦ-операторов и понять где у них график.
 *
 * Также пробует достать catalogs (Списки) — там может храниться график КЦ.
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

    console.log('═══════════════════════════════════');
    console.log('AMO USERS');
    console.log('═══════════════════════════════════');
    const users = await amo.getUsers();
    console.log(`Total users: ${users.length}\n`);
    console.log('userId | name | email | phone | roles | groups');
    for (const u of users) {
      const roles = (u.rights?.user_rights || u._embedded?.roles || []).map((r) => r.name || r.id).join(',');
      const groups = (u._embedded?.groups || []).map((g) => g.name).join(',');
      const phone = String(u.phone || '').replace(/\D/g, '');
      console.log(`${String(u.id).padEnd(8)} | ${String(u.name || '').padEnd(30).slice(0,30)} | ${String(u.email || '').padEnd(35).slice(0,35)} | ${phone.padEnd(11)} | ${roles.slice(0,30)} | ${groups.slice(0,30)}`);
    }

    console.log('\n═══════════════════════════════════');
    console.log('AMO CATALOGS (Списки)');
    console.log('═══════════════════════════════════');
    // Try GET /api/v4/catalogs
    try {
      const catalogs = await amo.request('/catalogs', { method: 'GET' });
      const list = catalogs?._embedded?.catalogs || [];
      console.log(`Total catalogs: ${list.length}\n`);
      console.log('catalogId | name | code | сан-тип-сущности');
      for (const c of list) {
        console.log(`${String(c.id).padEnd(9)} | ${String(c.name || '').padEnd(40).slice(0,40)} | ${String(c.code || '').padEnd(20).slice(0,20)} | ${c.type || ''}`);
      }
      // For each catalog also list elements (first 5)
      for (const c of list) {
        try {
          const elems = await amo.request(`/catalogs/${c.id}/elements?limit=10`, { method: 'GET' });
          const els = elems?._embedded?.elements || [];
          if (els.length > 0) {
            console.log(`\n  Catalog "${c.name}" — первые ${Math.min(10, els.length)} элементов:`);
            for (const e of els) {
              const cfs = (e.custom_fields_values || []).map((f) => `${f.field_name || f.field_code}=${(f.values || []).map((v) => v.value).join('|')}`).join('; ');
              console.log(`    ${String(e.id).padEnd(8)} | ${(e.name || '').slice(0, 50)} | ${cfs.slice(0, 200)}`);
            }
          }
        } catch (e) {
          console.log(`    (error fetching elements: ${e?.message})`);
        }
      }
    } catch (e) {
      console.log('Catalogs API error:', e?.message);
    }
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
