#!/usr/bin/env node
/**
 * 2026-09-04: живая read-only проверка ключей Mango Office.
 * Аудит показал: check-mango-settings проверяет только URL, а ключ/соль —
 * нет; «настроено» ≠ «работает». Этот скрипт делает безопасный запрос
 * POST /vpbx/config/users/request (список сотрудников, НИКАКИХ звонков)
 * и отвечает на вопрос «телефония авторизуется или нет».
 *
 * Печатает: источник ключей (БД/env), HTTP-код, число сотрудников и их
 * extensions (внутренние номера) — телефоны/ФИО не печатаются.
 *
 * Запуск в контейнере api (workflow check-mango-auth.yml):
 *   node /app/scripts/check-mango-auth.js
 */
const crypto = require('crypto');

(async () => {
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ['MANGO_API_KEY', 'MANGO_API_SALT', 'MANGO_API_URL'] } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const apiKey = byKey.get('MANGO_API_KEY') || process.env.MANGO_API_KEY || '';
    const apiSalt = byKey.get('MANGO_API_SALT') || process.env.MANGO_API_SALT || '';
    const apiUrl = (byKey.get('MANGO_API_URL') || process.env.MANGO_API_URL || 'https://app.mango-office.ru/vpbx').replace(/\/$/, '');
    console.log(`MANGO_API_KEY: ${apiKey ? `задан (${byKey.has('MANGO_API_KEY') ? 'БД' : 'env'}, ${apiKey.length} симв.)` : 'НЕ ЗАДАН'}`);
    console.log(`MANGO_API_SALT: ${apiSalt ? `задан (${byKey.has('MANGO_API_SALT') ? 'БД' : 'env'})` : 'НЕ ЗАДАН'}`);
    console.log(`MANGO_API_URL: ${apiUrl}`);
    if (!apiKey || !apiSalt) {
      console.log('ВЕРДИКТ: телефония НЕ работает — ключи не заданы.');
      return;
    }
    const json = JSON.stringify({});
    const sign = crypto.createHash('sha256').update(apiKey + json + apiSalt).digest('hex');
    const body = new URLSearchParams({ vpbx_api_key: apiKey, sign, json });
    const res = await fetch(`${apiUrl}/config/users/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    console.log(`HTTP: ${res.status}`);
    if (res.ok) {
      let users = [];
      try { users = (JSON.parse(text).users || []); } catch {}
      const exts = users.map((u) => u?.telephony?.extension).filter(Boolean);
      console.log(`Сотрудников в Mango: ${users.length}; extensions: ${exts.join(', ') || '(нет)'}`);
      console.log('ВЕРДИКТ: ключи РАБОЧИЕ — авторизация в Mango проходит, телефония доступна.');
    } else {
      console.log(`Ответ Mango (обрезан): ${text.slice(0, 200)}`);
      console.log('ВЕРДИКТ: телефония НЕ работает — Mango отверг ключи или запрос.');
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
