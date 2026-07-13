#!/usr/bin/env node
/**
 * Проверяет какие модели Claude доступны по текущему ANTHROPIC_API_KEY.
 * Помогает диагностировать 403 при вызове конкретной модели.
 *
 * Запуск в контейнере api:
 *   docker compose exec -T api node /app/scripts/check-anthropic-models.js
 */

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY не задан в env');
  process.exit(2);
}

(async () => {
  // 1. Список моделей — покажет что видит ключ.
  console.log('=== 1. GET /v1/models ===');
  const listRes = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
  });
  const listBody = await listRes.text();
  console.log(`HTTP ${listRes.status}`);
  console.log(listBody.slice(0, 3000));

  // 2. Пробный запрос к самой дешёвой модели — покажет что реально работает.
  console.log('\n=== 2. Test call claude-haiku-4-5 ===');
  const testModels = [
    'claude-haiku-4-5',
    'claude-3-5-haiku-20241022',
    'claude-3-haiku-20240307',
  ];
  for (const model of testModels) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ok' }],
      }),
    });
    const body = await r.text();
    console.log(`\nmodel=${model} → HTTP ${r.status}`);
    console.log(body.slice(0, 400));
  }
})().catch((e) => {
  console.error('FATAL:', e?.message || e);
  process.exit(1);
});
