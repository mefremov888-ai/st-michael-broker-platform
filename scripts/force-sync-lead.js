#!/usr/bin/env node
/**
 * Force-trigger amoCRM webhook handler for a specific lead.
 *
 * Использование: когда какой-то Client в БД застрял в неправильном
 * статусе (например, до фикса PR #142 был UNDER_REVIEW и webhook
 * после фикса ещё не приходил). Скрипт шлёт синтетический webhook
 * POST на наш endpoint — handler заберёт актуальное состояние лида
 * из amoCRM и обновит все Client с этим amoLeadId.
 *
 * Запуск через workflow: task=force-sync-lead, lead_id=<число>.
 */

(async () => {
  const leadId = String(process.env.LEAD_ID || '').trim();
  if (!leadId || !/^\d+$/.test(leadId)) {
    console.error(`ERROR: LEAD_ID должен быть числом, получено: '${leadId}'`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════');
  console.log(`force-sync-lead leadId=${leadId}`);
  console.log('═══════════════════════════════════════════');

  // Endpoint бьём изнутри контейнера — host=localhost, порт API из env.
  const apiPort = process.env.API_PORT || '4000';
  const url = `http://localhost:${apiPort}/api/webhooks/amo/lead-update`;

  // Имитируем формат amoCRM v4 webhook: leads.update[0].id.
  // Наш handler парсит и вызывает syncBrokerAttachmentFromLead(leadId).
  const body = {
    leads: {
      update: [{ id: leadId }],
    },
  };

  console.log(`POST ${url}`);
  console.log(`body: ${JSON.stringify(body)}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  console.log(`HTTP ${res.status}`);
  console.log(`response: ${text.slice(0, 1000)}`);

  if (!res.ok) {
    console.error('❌ Запрос вернул ошибку');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════');
  console.log('✅ Готово. Все Client с этим amoLeadId перепроверены.');
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
