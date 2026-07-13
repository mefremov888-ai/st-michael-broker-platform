#!/usr/bin/env node
/**
 * Реальная отправка тестового SMTP-письма.
 *
 * Жалоба: с правильного email брокера (есть в БД) forgot-password сказал
 * «ссылка отправлена», но письмо не пришло. Подозрение — SMTP сконфигурирован,
 * но молча падает (try/catch в auth.service.ts глушит ошибку).
 *
 * Скрипт берёт SMTP-настройки из env, формирует transporter как в проде, и
 * посылает РЕАЛЬНОЕ письмо на TEST_EMAIL. Логирует подробную ошибку если
 * упадёт — будем точно знать причину (тайм-аут / auth-failed / TLS / etc).
 *
 * Запуск: TEST_EMAIL=mefremov888@gmail.com node test-smtp-send.js
 */

(async () => {
  const TEST_EMAIL = process.env.TEST_EMAIL;
  if (!TEST_EMAIL) {
    console.error('ERROR: TEST_EMAIL env обязателен (формат name@domain.tld)');
    process.exit(1);
  }

  console.log(`═══════════════════════════════════════════`);
  console.log(`Тестовая отправка SMTP-письма на: ${TEST_EMAIL}`);
  console.log(`═══════════════════════════════════════════`);
  console.log(`SMTP_HOST:   ${process.env.SMTP_HOST}`);
  console.log(`SMTP_PORT:   ${process.env.SMTP_PORT || 465}`);
  console.log(`SMTP_USER:   ${process.env.SMTP_USER}`);
  console.log(`SMTP_SECURE: ${process.env.SMTP_SECURE !== 'false' ? 'true (default)' : 'false'}`);
  console.log(`SMTP_FROM:   ${process.env.SMTP_FROM || process.env.SMTP_USER}`);
  console.log(``);

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // 2026-06-15: тот же фикс что и в auth.service.ts — mail.stmichael.ru
    // ставит self-signed сертификат, без этой опции verify/STARTTLS падает.
    tls: { rejectUnauthorized: false },
    logger: true,
    debug: true,
  });

  // 1. Проверка соединения
  console.log(`Step 1: verify transport...`);
  try {
    await transporter.verify();
    console.log(`✅ verify OK\n`);
  } catch (e) {
    console.error(`❌ verify FAILED:`);
    console.error(`   code:    ${e?.code}`);
    console.error(`   command: ${e?.command}`);
    console.error(`   message: ${e?.message}`);
    console.error(`   response: ${e?.response}`);
    process.exit(1);
  }

  // 2. Отправка
  console.log(`Step 2: sendMail...`);
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: TEST_EMAIL,
      subject: `Test от broker.stmichael.ru — ${new Date().toISOString()}`,
      text:
        `Это тестовое письмо от diagnostic-скрипта test-smtp-send.js.\n\n` +
        `Если ты его получил — значит SMTP с broker.stmichael.ru работает корректно,\n` +
        `и forgot-password / welcome-email тоже должны доходить.\n\n` +
        `Не отвечай на это письмо.`,
      html:
        `<p><b>Тестовое письмо</b> от diagnostic-скрипта test-smtp-send.js.</p>` +
        `<p>Если ты его получил — SMTP с broker.stmichael.ru работает корректно, ` +
        `forgot-password / welcome-email тоже должны доходить.</p>`,
    });
    console.log(`✅ sendMail OK`);
    console.log(`   messageId: ${info.messageId}`);
    console.log(`   accepted:  ${JSON.stringify(info.accepted)}`);
    console.log(`   rejected:  ${JSON.stringify(info.rejected)}`);
    console.log(`   response:  ${info.response}`);
  } catch (e) {
    console.error(`❌ sendMail FAILED:`);
    console.error(`   code:    ${e?.code}`);
    console.error(`   command: ${e?.command}`);
    console.error(`   message: ${e?.message}`);
    console.error(`   response: ${e?.response}`);
    process.exit(1);
  }

  console.log(`═══════════════════════════════════════════`);
})().catch((e) => {
  console.error('Outer error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
