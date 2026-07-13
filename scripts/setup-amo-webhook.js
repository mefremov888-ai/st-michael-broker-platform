#!/usr/bin/env node
/**
 * Регистрирует webhook в amoCRM на наш endpoint /api/webhooks/amo/lead-update.
 *
 * Проблема: КЦ открепил брокера от лида → status в кабинете не сменился.
 * Причина: в amoCRM нет webhook'а на наш URL, поэтому syncBrokerAttachmentFromLead
 * никогда не вызывается. inspect-amo-webhooks подтвердил.
 *
 * Запуск через workflow: task=setup-amo-webhook
 * (опционально — destination URL через env WEBHOOK_URL для тестирования)
 *
 * Settings:
 *   - update_lead — на любое обновление лида (включая link/unlink контактов)
 *   - status_lead — на изменение статуса
 * Можно расширять по необходимости.
 */

(async () => {
  const { getAmoTokens } = require('@st-michael/integrations');
  const subdomain = process.env.AMO_SUBDOMAIN || 'stmichael';
  const domain = process.env.AMO_BASE_DOMAIN || 'amocrm.ru';
  const apiDomain = process.env.AMO_API_DOMAIN || `${subdomain}.${domain}`;
  const baseUrl = `https://${apiDomain}/api/v4`;
  const tokens = getAmoTokens();

  // 2026-06-11: явно используем broker.stmichael.ru, не WEB_URL.
  // WEB_URL на проде содержит IP-адрес сервера (маскируется как secret в логах),
  // и нам нужен публичный домен для amoCRM webhook'а.
  const destination =
    process.env.WEBHOOK_URL ||
    'https://broker.stmichael.ru/api/webhooks/amo/lead-update';

  console.log(`═══════════════════════════════════════════`);
  console.log(`Регистрация webhook в amoCRM`);
  console.log(`destination: ${destination}`);
  console.log(`settings:    [update_lead, status_lead]`);
  console.log(`═══════════════════════════════════════════`);

  if (!tokens.access) {
    console.error('ERROR: AMO_ACCESS_TOKEN не задан');
    process.exit(1);
  }

  // 2026-06-11: amoCRM /api/v4/webhooks ждёт OBJECT не массив. Ошибка
  // была: "FieldNotExpected" at path "0" → API парсил массив как поле "0".
  const body = {
    destination,
    settings: ['update_lead', 'status_lead'],
  };

  const res = await fetch(`${baseUrl}/webhooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  if (!res.ok) {
    console.error(`❌ HTTP ${res.status}`);
    console.error(text.slice(0, 1000));
    process.exit(1);
  }

  console.log(`✅ HTTP ${res.status}`);
  try {
    const data = JSON.parse(text);
    console.log(`response: ${JSON.stringify(data, null, 2)}`);
  } catch {
    console.log(text.slice(0, 1000));
  }

  console.log(`\nГотово. amoCRM теперь будет уведомлять нас об update_lead и status_lead.`);
  console.log(`Проверить: inspect-amo-webhooks должен показать наш destination.`);
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
