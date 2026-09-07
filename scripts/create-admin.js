#!/usr/bin/env node
/**
 * Создаёт нового админа в БД (или промотит существующего брокера до ADMIN).
 * Идемпотентен: если брокер с таким телефоном уже есть — обновит role и
 * passwordHash. Иначе создаст нового с role=ADMIN, status=ACTIVE.
 *
 * ВХОДНЫЕ ДАННЫЕ — через env-переменные (НЕ хардкодить в коде):
 *   ADMIN_PHONE     — обязательный, например "+79123456789"
 *   ADMIN_PASSWORD  — обязательный
 *   ADMIN_NAME      — опциональный, по умолчанию "Администратор"
 *
 * Запуск через workflow: task=create-admin (env подставляется из inputs).
 */

let PrismaClient, bcrypt;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
}
try {
  bcrypt = require('bcrypt');
} catch (_) {
  bcrypt = require('../apps/api/node_modules/bcrypt');
}

const PHONE = process.env.ADMIN_PHONE;
const PASSWORD = process.env.ADMIN_PASSWORD;
const NAME = process.env.ADMIN_NAME || 'Администратор';

if (!PHONE || !PASSWORD) {
  console.error('ADMIN_PHONE и ADMIN_PASSWORD обязательны. Задайте их через env-переменные.');
  process.exit(1);
}

(async () => {
  const prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const existing = await prisma.broker.findUnique({ where: { phone: PHONE } });

  if (existing) {
    await prisma.broker.update({
      where: { id: existing.id },
      data: {
        role: 'ADMIN',
        status: 'ACTIVE',
        passwordHash,
        fullName: existing.fullName || NAME,
      },
    });
    console.log(`Existing broker promoted to ADMIN: ${PHONE} (id=${existing.id})`);
  } else {
    const created = await prisma.broker.create({
      data: {
        phone: PHONE,
        fullName: NAME,
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    console.log(`New ADMIN created: ${PHONE} (id=${created.id})`);
  }

  console.log('\nDone. Login: ' + PHONE);
  console.log('After first login change the password in profile settings.');

  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
