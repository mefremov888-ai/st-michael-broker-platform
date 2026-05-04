#!/usr/bin/env node
/**
 * Диагностический скрипт: показывает полную картину по одному брокеру
 * (агентство, уровень комиссии, все сделки с источником, потенциальные дубли).
 *
 * Запуск (на сервере где есть доступ к БД):
 *   cd packages/database && node ../../scripts/diagnose-broker.js +79255724180
 *
 * Или из корня репо если БД на той же машине:
 *   node scripts/diagnose-broker.js +79255724180
 */

const phoneArg = process.argv[2];
if (!phoneArg) {
  console.error('Usage: node scripts/diagnose-broker.js +79255724180');
  process.exit(1);
}

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  try {
    ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
  } catch (e) {
    console.error('Cannot find @prisma/client. Run `npm install` in packages/database first.');
    process.exit(1);
  }
}

const prisma = new PrismaClient();

const fmt = (n) => Math.round(Number(n)).toLocaleString('ru-RU') + ' ₽';
const pad = (s, n) => String(s).padEnd(n);
const line = (n = 80) => console.log('─'.repeat(n));

(async () => {
  const phone = phoneArg.startsWith('+') ? phoneArg : '+' + phoneArg.replace(/\D/g, '');

  // 1) Find broker
  const broker = await prisma.broker.findUnique({
    where: { phone },
    include: {
      brokerAgencies: { include: { agency: true } },
    },
  });

  if (!broker) {
    console.error(`✗ Брокер с телефоном ${phone} не найден в БД`);
    process.exit(1);
  }

  console.log('\n=== БРОКЕР ===');
  console.log(`ID:           ${broker.id}`);
  console.log(`ФИО:          ${broker.fullName}`);
  console.log(`Телефон:      ${broker.phone}`);
  console.log(`Email:        ${broker.email || '—'}`);
  console.log(`Роль:         ${broker.role}`);
  console.log(`Статус:       ${broker.status}`);
  console.log(`Этап воронки: ${broker.funnelStage}`);
  console.log(`Источник:     ${broker.source || '—'}`);
  console.log(`amoContactId: ${broker.amoContactId || '—'}`);
  console.log(`Создан:       ${broker.createdAt.toISOString()}`);

  // 2) Agencies
  console.log('\n=== АГЕНТСТВА ===');
  if (broker.brokerAgencies.length === 0) {
    console.log('Нет привязанных агентств');
  } else {
    for (const ba of broker.brokerAgencies) {
      console.log(`${ba.isPrimary ? '★' : ' '} ${ba.agency.name} (ИНН ${ba.agency.inn})`);
      console.log(`   Уровень комиссии: ${ba.agency.commissionLevel}  ←  внимание!`);
      console.log(`   Накоплено м²:     ${ba.agency.totalSqmSold}`);
      console.log(`   Кварт. бонус:     ${ba.agency.quarterlyBonusStreak}`);
    }
  }

  // 3) Deals
  const deals = await prisma.deal.findMany({
    where: { brokerId: broker.id },
    include: { client: { select: { fullName: true, phone: true } } },
    orderBy: { createdAt: 'desc' },
  });

  console.log('\n=== СДЕЛКИ ===');
  console.log(`Всего сделок: ${deals.length}`);
  if (deals.length > 0) {
    line();
    console.log(pad('#', 4) + pad('Проект', 12) + pad('Клиент', 28) + pad('Сумма', 16) + pad('Ставка', 8) + pad('Комиссия', 14) + pad('Статус', 18) + pad('Источник', 12));
    line();
    let totalAmount = 0;
    let totalCommission = 0;
    const byProject = { ZORGE9: 0, SILVER_BOR: 0 };
    const byProjectAmount = { ZORGE9: 0, SILVER_BOR: 0 };
    const byProjectCommission = { ZORGE9: 0, SILVER_BOR: 0 };
    let excelCount = 0;
    let amoCount = 0;
    deals.forEach((d, i) => {
      const source = d.amoDealId ? 'amoCRM' : 'Excel/manual';
      if (d.amoDealId) amoCount++; else excelCount++;
      byProject[d.project] = (byProject[d.project] || 0) + 1;
      byProjectAmount[d.project] = (byProjectAmount[d.project] || 0) + Number(d.amount);
      byProjectCommission[d.project] = (byProjectCommission[d.project] || 0) + Number(d.commissionAmount);
      totalAmount += Number(d.amount);
      totalCommission += Number(d.commissionAmount);
      console.log(
        pad(i + 1, 4) +
        pad(d.project, 12) +
        pad((d.client?.fullName || '—').slice(0, 26), 28) +
        pad(fmt(d.amount), 16) +
        pad(Number(d.commissionRate) + '%', 8) +
        pad(fmt(d.commissionAmount), 14) +
        pad(d.status, 18) +
        pad(source, 12)
      );
    });
    line();
    console.log(`\nИТОГО:`);
    console.log(`  Сделок по Зорге 9:       ${byProject.ZORGE9 || 0} | сумма: ${fmt(byProjectAmount.ZORGE9 || 0)} | комиссия: ${fmt(byProjectCommission.ZORGE9 || 0)}`);
    console.log(`  Сделок по Серебр. Бору:  ${byProject.SILVER_BOR || 0} | сумма: ${fmt(byProjectAmount.SILVER_BOR || 0)} | комиссия: ${fmt(byProjectCommission.SILVER_BOR || 0)}`);
    console.log(`  Из amoCRM:               ${amoCount}`);
    console.log(`  Из Excel/manual:         ${excelCount}`);
    console.log(`  Общая сумма:             ${fmt(totalAmount)}`);
    console.log(`  Общая комиссия:          ${fmt(totalCommission)}`);
  }

  // 4) Detect potential duplicates: same client + project + similar amount
  if (deals.length > 1) {
    const groups = {};
    for (const d of deals) {
      const key = `${d.clientId}::${d.project}::${Math.round(Number(d.amount))}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
    }
    const dups = Object.values(groups).filter((g) => g.length > 1);
    if (dups.length > 0) {
      console.log('\n=== ⚠️  ПОТЕНЦИАЛЬНЫЕ ДУБЛИ (одинаковый клиент+проект+сумма) ===');
      for (const g of dups) {
        console.log(`\nДубль (${g.length} штук):`);
        for (const d of g) {
          console.log(`  - id=${d.id.slice(0, 8)}... amoDealId=${d.amoDealId || 'НЕТ'} status=${d.status} commission=${fmt(d.commissionAmount)} created=${d.createdAt.toISOString().slice(0, 10)}`);
        }
      }
    }
  }

  // 5) Clients
  const clients = await prisma.client.findMany({
    where: { brokerId: broker.id },
    select: { id: true, fullName: true, phone: true, project: true, uniquenessStatus: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n=== КЛИЕНТЫ (${clients.length}) ===`);
  const byClientProject = { ZORGE9: 0, SILVER_BOR: 0 };
  for (const c of clients) byClientProject[c.project] = (byClientProject[c.project] || 0) + 1;
  console.log(`  По Зорге 9:       ${byClientProject.ZORGE9 || 0}`);
  console.log(`  По Серебр. Бору:  ${byClientProject.SILVER_BOR || 0}`);

  // 6) What commission would be at correct level
  if (broker.brokerAgencies.length > 0) {
    const primary = broker.brokerAgencies.find((ba) => ba.isPrimary) || broker.brokerAgencies[0];
    const realSqm = deals.reduce((s, d) => s + Number(d.sqm || 0), 0);
    console.log('\n=== АНАЛИЗ УРОВНЯ КОМИССИИ ===');
    console.log(`Текущий уровень в БД:     ${primary.agency.commissionLevel}`);
    console.log(`Накоплено м² в БД:        ${primary.agency.totalSqmSold}`);
    console.log(`Сумма sqm по сделкам:     ${realSqm} (если 0 — sqm не пишется при синке amoCRM)`);
    console.log(`\nЕсли пересчитать по реальным метрам:`);
    const thresholds = [
      { level: 'LEGEND', minSqm: 1200 },
      { level: 'CHAMPION', minSqm: 800 },
      { level: 'ELITE', minSqm: 500 },
      { level: 'PREMIUM', minSqm: 300 },
      { level: 'STRONG', minSqm: 150 },
      { level: 'BASIC', minSqm: 50 },
      { level: 'START', minSqm: 0 },
    ];
    const sqmForLevel = realSqm > 0 ? realSqm : Number(primary.agency.totalSqmSold || 0);
    const correctLevel = thresholds.find((t) => sqmForLevel >= t.minSqm);
    console.log(`  При ${sqmForLevel} м² должен быть: ${correctLevel?.level || 'START'}`);
  }

  console.log('\n');
  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e);
  prisma.$disconnect();
  process.exit(1);
});
