#!/usr/bin/env node
/**
 * Диагностика webhook'ов amoCRM.
 *
 * Жалоба: КЦ открепил брокера от лида в amoCRM → status в кабинете
 * брокера не сменился на REJECTED. Подозрение — amoCRM не шлёт нам
 * webhook на изменение лида.
 *
 * Скрипт читает GET /api/v4/webhooks и печатает все настроенные
 * webhook'и + проверяет есть ли наш /webhooks/amo/lead-update.
 *
 * Запуск через workflow: task=inspect-amo-webhooks
 */

(async () => {
  const { AmoCrmAdapter, getAmoTokens } = require('@st-michael/integrations');
  const adapter = new AmoCrmAdapter();

  // Прямой запрос к amoCRM API без обёртки adapter (она не даёт generic request наружу)
  // Доступаемся к private request через bracket-syntax трюк.
  const subdomain = process.env.AMO_SUBDOMAIN || 'stmichael';
  const domain = process.env.AMO_BASE_DOMAIN || 'amocrm.ru';
  const apiDomain = process.env.AMO_API_DOMAIN || `${subdomain}.${domain}`;
  const baseUrl = `https://${apiDomain}/api/v4`;
  const tokens = getAmoTokens();

  if (!tokens.access) {
    console.error('ERROR: AMO_ACCESS_TOKEN не задан');
    process.exit(1);
  }

  console.log(`═══════════════════════════════════════════`);
  console.log(`amoCRM webhooks @ ${apiDomain}`);
  console.log(`═══════════════════════════════════════════`);

  const res = await fetch(`${baseUrl}/webhooks`, {
    headers: {
      Authorization: `Bearer ${tokens.access}`,
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`ERROR ${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  const data = await res.json();
  const webhooks = data?._embedded?.webhooks || [];
  console.log(`Найдено webhook'ов: ${webhooks.length}\n`);
  if (webhooks.length === 0) {
    console.log(`❌ В amoCRM НЕТ настроенных webhook'ов вообще.`);
    console.log(`   → Нужно добавить через amoCRM админку (Настройки → Интеграции → API → Вебхуки)`);
    console.log(`   → URL: https://72.56.241.199/api/webhooks/amo/lead-update`);
    console.log(`   → События: «Изменение сделки», нужны как минимум leads:update`);
    return;
  }

  let found = false;
  for (const w of webhooks) {
    console.log(`Webhook ${w.id}:`);
    console.log(`  destination: ${w.destination}`);
    console.log(`  disabled:    ${w.disabled}`);
    console.log(`  settings:    ${JSON.stringify(w.settings || [])}`);
    console.log(`  created_at:  ${w.created_at}  updated_at: ${w.updated_at}`);
    console.log(``);
    // 2026-06-11: проверяем именно наш хост — раньше includes('/webhooks/amo')
    // ловил chat2desk.com/webhooks/amo и давал false positive.
    const dest = w.destination || '';
    if (
      dest.includes('broker.stmichael.ru/api/webhooks/amo/lead-update') ||
      dest.includes('72.56.241.199/api/webhooks/amo/lead-update')
    ) {
      found = true;
    }
  }

  if (!found) {
    console.log(`❌ Webhook на наш /webhooks/amo/lead-update НЕ найден.`);
    console.log(`   → amoCRM не уведомляет нас об изменении лидов.`);
    console.log(`   → Нужно добавить webhook через amoCRM админку:`);
    console.log(`     URL: https://72.56.241.199/api/webhooks/amo/lead-update`);
    console.log(`     События: leads:update + leads:status + (опционально) leads:delete`);
  } else {
    console.log(`✅ Webhook на наш endpoint найден. Если он disabled=false и URL верный,`);
    console.log(`   но события не приходят — проверь логи api на /api/webhooks/amo/lead-update.`);
  }

  console.log(`═══════════════════════════════════════════`);
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
