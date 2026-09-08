#!/usr/bin/env node
/**
 * 2026-09-08: пересчёт поля Broker.funnelStage по событиям. Поле с марта 2026
 * двигалось только действиями через кабинет, импорт/реестр/amo его не трогали:
 * 19 012 из 19 025 брокеров стояли в «Новый». Правило (как статусы базы
 * лояльности): DEAL — есть оплаченный ДДУ реестра или подтверждённая сделка
 * кабинета; MEETING — подтверждённая/состоявшаяся встреча с клиентом (не
 * брокер-тур); FIXATION — есть фиксация по правилам кабинета (оба кабинета);
 * BROKER_TOUR — отметка тура; иначе NEW_BROKER. Поле только поднимаем, вниз
 * не опускаем (ручные значения выше — не трогаем). DRY_RUN=1 — только отчёт.
 */
const DRY = process.env.DRY_RUN !== "0";
const ORDER = { NEW_BROKER: 0, BROKER_TOUR: 1, FIXATION: 2, MEETING: 3, DEAL: 4 };
const FIX = { OR: [{ fixationStatus: { in: ["FIXED", "EXPIRED"] } }, { uniquenessStatus: { in: ["CONDITIONALLY_UNIQUE", "EXPIRED"] } }] };
const DEAL_WHERE = { contractType: "DDU", amount: { gt: 0 }, status: { in: ["SIGNED", "PAID", "COMMISSION_PAID"] }, signedAt: { not: null } };
async function main() {
  const { PrismaClient } = require("@st-michael/database"); const prisma = new PrismaClient();
  try {
    console.log(`Режим: ${DRY ? "DRY-RUN (только отчёт)" : "APPLY (пишем funnel_stage)"}`);
    const brokers = await prisma.broker.findMany({ where: { role: "BROKER", mergedIntoId: null }, select: { id: true, funnelStage: true, brokerTourVisited: true } });
    const ids = brokers.map((b) => b.id); const B = 500;
    const has = { fix: new Set(), meet: new Set(), deal: new Set() };
    for (let i = 0; i < ids.length; i += B) {
      const batch = ids.slice(i, i + B);
      const [f, m, d, r] = await Promise.all([
        prisma.client.groupBy({ by: ["brokerId"], where: { brokerId: { in: batch }, ...FIX } }),
        prisma.meeting.groupBy({ by: ["brokerId"], where: { brokerId: { in: batch }, status: { in: ["CONFIRMED", "COMPLETED"] }, type: { not: "BROKER_TOUR" } } }),
        prisma.deal.groupBy({ by: ["brokerId"], where: { brokerId: { in: batch }, ...DEAL_WHERE } }),
        prisma.registryDeal.groupBy({ by: ["brokerId"], where: { brokerId: { in: batch }, paidAt: { not: null } } }),
      ]);
      for (const g of f) has.fix.add(g.brokerId); for (const g of m) has.meet.add(g.brokerId); for (const g of d) has.deal.add(g.brokerId); for (const g of r) has.deal.add(g.brokerId);
    }
    const before = {}, after = {}, changes = []; const transitions = {};
    for (const b of brokers) {
      const computed = has.deal.has(b.id) ? "DEAL" : has.meet.has(b.id) ? "MEETING" : has.fix.has(b.id) ? "FIXATION" : b.brokerTourVisited ? "BROKER_TOUR" : "NEW_BROKER";
      const target = ORDER[computed] > ORDER[b.funnelStage] ? computed : b.funnelStage;
      before[b.funnelStage] = (before[b.funnelStage] || 0) + 1; after[target] = (after[target] || 0) + 1;
      if (target !== b.funnelStage) { changes.push({ id: b.id, from: b.funnelStage, to: target }); const k = `${b.funnelStage}→${target}`; transitions[k] = (transitions[k] || 0) + 1; }
    }
    console.log(`Брокеров: ${brokers.length}; было: ${JSON.stringify(before)}; станет: ${JSON.stringify(after)}`);
    console.log(`К изменению: ${changes.length}; переходы: ${JSON.stringify(transitions)}`);
    if (!DRY) {
      let updated = 0;
      for (const stage of Object.keys(ORDER)) {
        const idsFor = changes.filter((c) => c.to === stage).map((c) => c.id);
        for (let i = 0; i < idsFor.length; i += B) { const res = await prisma.broker.updateMany({ where: { id: { in: idsFor.slice(i, i + B) } }, data: { funnelStage: stage } }); updated += res.count; }
      }
      console.log(`Записано: ${updated}`);
    }
    console.log("RESULT: " + JSON.stringify({ dry: DRY, brokers: brokers.length, before, after, changes: changes.length, transitions }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
