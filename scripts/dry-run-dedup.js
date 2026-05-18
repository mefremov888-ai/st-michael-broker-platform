#!/usr/bin/env node
/**
 * DRY-RUN дедупликации сделок. НИЧЕГО НЕ УДАЛЯЕТ — только выводит план действий.
 *
 * Логика та же что в amocrm.service.ts post-fix дедупа: группируем Deal'ы по
 * прямой parent↔child / siblings / amoDealId-дубликат связи. Транзитивные
 * цепочки НЕ строим (раньше давало ложные мега-группы).
 *
 * Запуск:
 *   BROKER_ID=<uuid> node /app/scripts/dry-run-dedup.js  (для одного брокера)
 *   node /app/scripts/dry-run-dedup.js                   (все брокеры — по умолчанию)
 *   STATUS_FILTER=ACTIVE node ...                        (фильтр по статусу)
 *
 * Через workflow: task=dry-run-dedup
 */

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
}

const STATUS_RANK = { CANCELLED: -1, PENDING: 0, SIGNED: 1, PAID: 2, COMMISSION_PAID: 3 };

async function analyzeBroker(prisma, brokerId, brokerName, brokerStatus) {
  const deals = await prisma.deal.findMany({
    where: { brokerId },
    select: {
      id: true, amoDealId: true, amoParentDealId: true,
      project: true, amount: true, sqm: true,
      commissionRate: true, commissionAmount: true,
      status: true, signedAt: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (deals.length === 0) {
    return { dups: 0, total: 0, withParent: 0 };
  }

  const withParent = deals.filter((d) => d.amoParentDealId).length;

  function related(a, b) {
    const aD = a.amoDealId ? String(a.amoDealId) : null;
    const bD = b.amoDealId ? String(b.amoDealId) : null;
    const aP = a.amoParentDealId ? String(a.amoParentDealId) : null;
    const bP = b.amoParentDealId ? String(b.amoParentDealId) : null;
    if (aD && bD && aD === bD) return true;       // одинаковый amoDealId
    if (aD && bP && aD === bP) return true;       // A parent B
    if (aP && bD && aP === bD) return true;       // B parent A
    if (aP && bP && aP === bP) return true;       // siblings
    return false;
  }

  const finalGroups = new Map();
  const seen = new Set();
  for (const d of deals) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const groupKey = String(d.amoParentDealId || d.amoDealId || d.id);
    const collected = [d];
    for (const other of deals) {
      if (seen.has(other.id)) continue;
      if (related(d, other)) {
        collected.push(other);
        seen.add(other.id);
      }
    }
    finalGroups.set(groupKey, collected);
  }

  let dups = 0;
  let printed = false;
  for (const [key, group] of finalGroups) {
    if (group.length <= 1) continue;
    if (!printed) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Broker: ${brokerName} (${brokerId})  status=${brokerStatus}`);
      printed = true;
    }
    console.log(`\nГруппа root=${key} (${group.length} Deal):`);
    for (const d of group) {
      console.log(`  · id=${d.id.slice(0, 8)} amo=${d.amoDealId} parent=${d.amoParentDealId || '-'}  proj=${d.project} amount=${d.amount} sqm=${d.sqm} status=${d.status}`);
    }
    const sorted = [...group].sort((a, b) => {
      const sqmDiff = Number(b.sqm || 0) - Number(a.sqm || 0);
      if (sqmDiff !== 0) return sqmDiff;
      const sDiff = (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0);
      if (sDiff !== 0) return sDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    const keep = sorted[0];
    const remove = sorted.slice(1);
    console.log(`  ✓ KEEP   id=${keep.id.slice(0, 8)} (sqm=${keep.sqm}, status=${keep.status})`);
    for (const d of remove) {
      console.log(`  ✗ DELETE id=${d.id.slice(0, 8)} (sqm=${d.sqm}, status=${d.status})`);
      dups++;
    }
  }
  return { dups, total: deals.length, withParent };
}

(async () => {
  const prisma = new PrismaClient();
  const brokerIdEnv = process.env.BROKER_ID;
  const statusFilter = process.env.STATUS_FILTER || ''; // пусто = все статусы
  console.log('═══════════════════════════════════');
  console.log('DRY-RUN DEDUP — ничего не удаляет');
  console.log('═══════════════════════════════════');
  let totalDups = 0;
  let summary = [];
  if (brokerIdEnv) {
    const b = await prisma.broker.findUnique({
      where: { id: brokerIdEnv },
      select: { id: true, fullName: true, status: true },
    });
    if (!b) {
      console.log('Broker not found');
      process.exit(1);
    }
    const r = await analyzeBroker(prisma, b.id, b.fullName, b.status);
    summary.push({ name: b.fullName, status: b.status, ...r });
    totalDups += r.dups;
  } else {
    const where = statusFilter ? { status: statusFilter } : {};
    const brokers = await prisma.broker.findMany({
      where,
      select: { id: true, fullName: true, status: true },
      orderBy: { fullName: 'asc' },
    });
    console.log(`Анализирую ${brokers.length} брокеров (фильтр: ${statusFilter || 'ВСЕ'})...`);
    for (const b of brokers) {
      const r = await analyzeBroker(prisma, b.id, b.fullName, b.status);
      summary.push({ name: b.fullName, status: b.status, ...r });
      totalDups += r.dups;
    }
  }

  // Per-broker breakdown (всегда показываем — даже если 0 дублей).
  console.log(`\n═══════════════════════════════════`);
  console.log('Брокер                              | статус   | Deal | сParent | дубли');
  console.log('────────────────────────────────────┼──────────┼──────┼─────────┼──────');
  for (const s of summary) {
    const name = (s.name || '').padEnd(35, ' ').slice(0, 35);
    const st = (s.status || '').padEnd(8, ' ').slice(0, 8);
    const t = String(s.total).padStart(4, ' ');
    const wp = String(s.withParent).padStart(7, ' ');
    const d = String(s.dups).padStart(4, ' ');
    console.log(`${name} | ${st} | ${t} | ${wp} | ${d}`);
  }
  console.log(`\n═══════════════════════════════════`);
  console.log(`ИТОГО к удалению: ${totalDups} Deal'ов`);
  console.log(`Брокеров проверено: ${summary.length}`);
  console.log(`Всего Deal в БД (у проверенных): ${summary.reduce((s, x) => s + x.total, 0)}`);
  console.log(`Из них с amoParentDealId: ${summary.reduce((s, x) => s + x.withParent, 0)}`);
  console.log(`БД не изменена.`);
  console.log(`═══════════════════════════════════`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
