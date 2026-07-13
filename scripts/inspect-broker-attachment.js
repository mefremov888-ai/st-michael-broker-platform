#!/usr/bin/env node
/**
 * Диагностика «открепил брокера от лида в amoCRM — статус в кабинете не сменился».
 *
 * Пользователь сообщает что: брокер фиксировал клиента → CONDITIONALLY_UNIQUE
 * (Уникален). КЦ-менеджер открепил брокера от лида в amoCRM. Ожидается:
 * webhook amo/lead-update → syncBrokerAttachmentFromLead → REJECTED (Не уникален).
 * Не сработало.
 *
 * Скрипт по PHONE показывает:
 *   1. Client в БД (id, brokerId, amoLeadId, uniquenessStatus, uniquenessReason)
 *   2. Broker.amoContactId
 *   3. Текущее состояние lead в amoCRM (если amoLeadId есть): список contact_id
 *   4. Прикреплён ли broker.amoContactId к лиду сейчас → YES/NO
 *   5. Записи AuditLog UNIQUENESS_RESOLVED для этого Client'а
 *   6. Recent CLIENT_FIXATION audit
 *
 * Запуск через workflow: task=inspect-broker-attachment phone=+79104572395
 */

(async () => {
  const PHONE = process.env.PHONE;
  const EMAIL = process.env.EMAIL;
  if (!PHONE && !EMAIL) {
    console.error('ERROR: либо PHONE либо EMAIL env должен быть задан');
    process.exit(1);
  }

  const { PrismaClient } = require('@st-michael/database');
  const { AmoCrmAdapter } = require('@st-michael/integrations');
  const prisma = new PrismaClient();
  const amo = new AmoCrmAdapter();

  try {
    // 2026-06-11: режим EMAIL — диагностика forgot-password
    if (EMAIL && !PHONE) {
      console.log(`═══════════════════════════════════════════`);
      console.log(`Поиск Broker по email: ${EMAIL}`);
      console.log(`═══════════════════════════════════════════`);

      // SMTP-настройки
      console.log(`\n─── SMTP-конфигурация ───`);
      console.log(`SMTP_HOST:   ${process.env.SMTP_HOST || '(не задан)'}`);
      console.log(`SMTP_PORT:   ${process.env.SMTP_PORT || '(не задан)'}`);
      console.log(`SMTP_USER:   ${process.env.SMTP_USER ? process.env.SMTP_USER : '(не задан)'}`);
      console.log(`SMTP_PASS:   ${process.env.SMTP_PASS ? '(задан, скрыт)' : '(НЕ ЗАДАН)'}`);
      console.log(`SMTP_FROM:   ${process.env.SMTP_FROM || '(не задан)'}`);
      console.log(`SMTP_SECURE: ${process.env.SMTP_SECURE || '(default true)'}`);
      const smtpOk = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
      console.log(`Готово к отправке: ${smtpOk ? 'ДА ✅' : 'НЕТ ❌ (логика молча падает на else-ветке и пишет ссылку только в логи)'}`);

      // Поиск брокера
      console.log(`\n─── Broker в БД ───`);
      // Сначала точное совпадение
      let brokers = await prisma.broker.findMany({
        where: { email: EMAIL },
        select: { id: true, fullName: true, email: true, role: true, status: true, createdAt: true, passwordResetExpiresAt: true },
      });
      if (brokers.length === 0) {
        // Регистр-независимый поиск (на случай если ввели Mefremov@... вместо mefremov@...)
        brokers = await prisma.broker.findMany({
          where: { email: { equals: EMAIL, mode: 'insensitive' } },
          select: { id: true, fullName: true, email: true, role: true, status: true, createdAt: true, passwordResetExpiresAt: true },
        });
        if (brokers.length > 0) {
          console.log(`⚠️  Точного совпадения нет, но есть с другим регистром:`);
        }
      }
      if (brokers.length === 0) {
        console.log(`❌ Broker с email "${EMAIL}" в БД НЕ НАЙДЕН.`);
        console.log(`   → forgot-password molча возвращает «если email зарегистрирован, ссылка отправлена»`);
        console.log(`   → письмо НЕ отправляется (логика на auth.service.ts:187: return до отправки)`);
        console.log(`\n   Все брокеры с похожим email:`);
        const similar = await prisma.broker.findMany({
          where: { email: { contains: EMAIL.split('@')[0]?.slice(0, 4) || '', mode: 'insensitive' } },
          select: { fullName: true, email: true, role: true },
          take: 10,
        });
        for (const b of similar) console.log(`     - ${b.email}  (${b.fullName}, role=${b.role})`);
      } else {
        for (const b of brokers) {
          console.log(`✅ Broker ${b.id}`);
          console.log(`     fullName: ${b.fullName}`);
          console.log(`     email:    ${b.email}`);
          console.log(`     role:     ${b.role}`);
          console.log(`     status:   ${b.status}`);
          console.log(`     createdAt: ${b.createdAt?.toISOString()}`);
          console.log(`     passwordResetExpiresAt: ${b.passwordResetExpiresAt?.toISOString() || '(нет активной reset-сессии)'}`);

          // Свежие audit логи
          const audits = await prisma.auditLog.findMany({
            where: { brokerId: b.id, action: { in: ['LOGIN', 'PASSWORD_RESET', 'PASSWORD_RESET_REQUESTED'] } },
            orderBy: { createdAt: 'desc' },
            take: 5,
          });
          console.log(`     Recent audits (LOGIN/PASSWORD_RESET): ${audits.length}`);
          for (const a of audits) {
            console.log(`       ${a.createdAt.toISOString()} ${a.action}`);
          }
        }
      }
      console.log(`\n═══════════════════════════════════════════`);
      return;
    }

    // Нормализуем телефон для поиска (как в БД хранится)
    const normalizedPhone = PHONE.startsWith('+') ? PHONE : `+${PHONE}`;
    console.log(`═══════════════════════════════════════════`);
    console.log(`Поиск Client по phone: ${normalizedPhone}`);
    console.log(`═══════════════════════════════════════════`);

    const clients = await prisma.client.findMany({
      where: { phone: normalizedPhone },
      include: {
        broker: { select: { id: true, fullName: true, phone: true, amoContactId: true } },
        deals: { select: { id: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (clients.length === 0) {
      console.log(`Client не найден в БД для phone=${normalizedPhone}`);
      return;
    }

    for (const c of clients) {
      console.log(`\nClient ${c.id}`);
      console.log(`  createdAt:        ${c.createdAt.toISOString()}`);
      console.log(`  updatedAt:        ${c.updatedAt.toISOString()}`);
      console.log(`  fullName:         ${c.fullName}`);
      console.log(`  brokerId:         ${c.brokerId}`);
      console.log(`  broker:           ${c.broker?.fullName} (${c.broker?.phone})`);
      console.log(`  broker.amoContactId: ${c.broker?.amoContactId}`);
      console.log(`  amoLeadId:        ${c.amoLeadId}`);
      console.log(`  uniquenessStatus: ${c.uniquenessStatus}`);
      console.log(`  uniquenessReason: ${c.uniquenessReason}`);
      console.log(`  uniquenessExpiresAt: ${c.uniquenessExpiresAt?.toISOString()}`);
      console.log(`  deals: ${c.deals.length} (${c.deals.map((d) => d.status).join(', ')})`);

      // Lead в amoCRM
      if (c.amoLeadId) {
        const leadId = Number(c.amoLeadId);
        console.log(`\n  ─── amoCRM Lead ${leadId} ───`);
        const lead = await amo.getLead(leadId).catch((e) => {
          console.log(`  getLead error: ${e?.message || e}`);
          return null;
        });
        if (lead) {
          console.log(`  pipeline_id: ${lead.pipeline_id}  status_id: ${lead.status_id}`);
          console.log(`  responsible_user_id: ${lead.responsible_user_id}`);
          const contactIds = ((lead?._embedded?.contacts) || []).map((x) => Number(x.id));
          console.log(`  contacts на лиде: [${contactIds.join(', ')}]`);
          const brokerAmoId = c.broker?.amoContactId ? Number(c.broker.amoContactId) : null;
          if (brokerAmoId) {
            const isAttached = contactIds.includes(brokerAmoId);
            console.log(`  Брокер (amoContactId=${brokerAmoId}) сейчас прикреплён к лиду: ${isAttached ? 'ДА ✅' : 'НЕТ ❌'}`);
            if (!isAttached && c.uniquenessStatus === 'CONDITIONALLY_UNIQUE') {
              console.log(`  ⚠️  НЕСООТВЕТСТВИЕ: в БД status=CONDITIONALLY_UNIQUE, но в amoCRM брокера на лиде нет → должно быть REJECTED. Webhook не дошёл / не сработал.`);
            }
          } else {
            console.log(`  ⚠️  broker.amoContactId не задан — sync не может сравнить`);
          }
        }
      }

      // AuditLog по этому Client
      console.log(`\n  ─── AuditLog ───`);
      const audits = await prisma.auditLog.findMany({
        where: { entity: 'Client', entityId: c.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      if (audits.length === 0) {
        console.log(`  Записей нет`);
      } else {
        for (const a of audits) {
          console.log(`  ${a.createdAt.toISOString()} ${a.action} payload=${JSON.stringify(a.payload).slice(0, 200)}`);
        }
      }
    }
    console.log(`\n═══════════════════════════════════════════`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
