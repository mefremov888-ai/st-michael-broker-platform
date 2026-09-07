#!/usr/bin/env node
/**
 * 2026-08-18: разовая диагностика почтового сервера кабинета (SMTP_HOST и
 * т.д., используется в auth.service.ts для welcome/forgot-password писем).
 * Проверяет наличие конфигурации + делает transporter.verify() (connect +
 * EHLO + AUTH, без реальной отправки). С флагом --send-to email отправляет
 * тестовое письмо.
 *
 * Запуск в контейнере api (через workflow check-smtp.yml):
 *   node /app/scripts/check-smtp.js
 *   node /app/scripts/check-smtp.js --send-to someone@example.com
 *   node /app/scripts/check-smtp.js --phone +79991234567   # найти email брокера по телефону
 */

const args = process.argv.slice(2);
const sendToIdx = args.indexOf('--send-to');
const SEND_TO = sendToIdx !== -1 ? args[sendToIdx + 1] : null;
const phoneIdx = args.indexOf('--phone');
const PHONE = phoneIdx !== -1 ? args[phoneIdx + 1] : null;

(async () => {
  console.log('SMTP_HOST configured:', !!process.env.SMTP_HOST);
  console.log('SMTP_USER configured:', !!process.env.SMTP_USER);
  console.log('SMTP_PORT:', process.env.SMTP_PORT || '465 (default)');
  console.log('SMTP_FROM:', process.env.SMTP_FROM || process.env.SMTP_USER || '(not set)');

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log('SMTP не настроен — писем отправлять некому.');
    return;
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });

  try {
    await transporter.verify();
    console.log('SMTP verify: OK — сервер доступен, авторизация прошла.');
  } catch (e) {
    console.log('SMTP verify: FAIL —', e?.message || e);
    return;
  }

  let target = SEND_TO;
  if (PHONE) {
    const { PrismaClient } = require('@st-michael/database');
    const prisma = new PrismaClient();
    const digits = PHONE.replace(/\D/g, '').slice(-10);
    const broker = await prisma.broker.findFirst({
      where: { phone: { endsWith: digits } },
      select: { fullName: true, email: true, phone: true },
    });
    console.log('Найден брокер:', broker);
    if (broker?.email) target = broker.email;
    await prisma.$disconnect();
  }

  if (!target) {
    console.log('--send-to / --phone не передан — тестовое письмо не отправляю.');
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: target,
      subject: 'Тест почты — кабинет брокера St Michael',
      html: '<p>Это тестовое письмо от диагностики SMTP кабинета брокера. Если оно дошло — почта работает.</p>',
    });
    console.log('Тестовое письмо отправлено на', target);
  } catch (e) {
    console.log('Отправка FAIL —', e?.message || e);
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
