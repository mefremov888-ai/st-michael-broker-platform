#!/usr/bin/env node
/**
 * 2026-09-08: покрытие данных для воронки «Был на брокер-туре → фиксация →
 * встреча → платная бронь → сделка» по брокерам нашей базы. Только чтение.
 * Считает уникальных брокеров на каждой ступени (за всё время и «строго после
 * даты БТ»), медианы дней между ступенями, разбивку БТ по годам, а также
 * сколько фиксирующих/сделочных брокеров БТ не проходили. Печатает RESULT-json.
 */
const FIX = { OR: [{ fixationStatus: { in: ["FIXED", "EXPIRED"] } }, { uniquenessStatus: { in: ["CONDITIONALLY_UNIQUE", "EXPIRED"] } }] };
// как ourConfirmedDealWhere в loyalty-base: ДДУ, сумма > 0, подписан
const DEAL_WHERE = { contractType: "DDU", amount: { gt: 0 }, status: { in: ["SIGNED", "PAID", "COMMISSION_PAID"] }, signedAt: { not: null } };
const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const days = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const brokers = await prisma.broker.findMany({ where: { role: "BROKER", mergedIntoId: null }, select: { id: true, status: true, brokerTourVisited: true, brokerTourDate: true, funnelStage: true, createdAt: true } });
    const ids = brokers.map((b) => b.id);
    const byId = new Map(brokers.map((b) => [b.id, b]));
    const bt = brokers.filter((b) => b.brokerTourVisited);
    const btDated = bt.filter((b) => b.brokerTourDate);
    const btYears = {}; for (const b of btDated) { const y = new Date(b.brokerTourDate).getFullYear(); btYears[y] = (btYears[y] || 0) + 1; }
    console.log(`Брокеров: ${brokers.length}; с отметкой БТ: ${bt.length}; из них с датой БТ: ${btDated.length}; БТ по годам: ${JSON.stringify(btYears)}`);
    const stages = {}; for (const b of brokers) stages[b.funnelStage] = (stages[b.funnelStage] || 0) + 1;
    console.log(`funnelStage (поле карточки): ${JSON.stringify(stages)}`);

    // Первые события по брокеру
    const firstBy = async (rows, key, dateKey) => { const m = new Map(); for (const r of rows) { const id = r[key]; if (!id) continue; const d = r[dateKey]; if (!d) continue; const cur = m.get(id); if (!cur || new Date(d) < new Date(cur)) m.set(id, d); } return m; };
    const B = 500; const collect = async (fn) => { const out = []; for (let i = 0; i < ids.length; i += B) out.push(...(await fn(ids.slice(i, i + B)))); return out; };
    const fixRows = await collect((batch) => prisma.client.findMany({ where: { brokerId: { in: batch }, ...FIX }, select: { brokerId: true, createdAt: true, comment: true } }));
    const meetRows = await collect((batch) => prisma.meeting.findMany({ where: { brokerId: { in: batch }, status: { in: ["CONFIRMED", "COMPLETED"] } }, select: { brokerId: true, date: true } }));
    const dealRows = await collect((batch) => prisma.deal.findMany({ where: { brokerId: { in: batch }, ...DEAL_WHERE }, select: { brokerId: true, signedAt: true, createdAt: true } }));
    const regRows = await collect((batch) => prisma.registryDeal.findMany({ where: { brokerId: { in: batch } }, select: { brokerId: true, paidAt: true, dvouPaidAt: true } }));
    const firstFix = await firstBy(fixRows, "brokerId", "createdAt");
    const firstFixNew = await firstBy(fixRows.filter((r) => !String(r.comment || "").startsWith("[old-cabinet:")), "brokerId", "createdAt");
    const firstMeet = await firstBy(meetRows, "brokerId", "date");
    const firstDvou = await firstBy(regRows.filter((r) => r.dvouPaidAt), "brokerId", "dvouPaidAt");
    const firstDeal = await firstBy([...dealRows.map((r) => ({ brokerId: r.brokerId, d: r.signedAt || r.createdAt })), ...regRows.filter((r) => r.paidAt).map((r) => ({ brokerId: r.brokerId, d: r.paidAt }))], "brokerId", "d");
    console.log(`Брокеров с фиксациями: ${firstFix.size} (только новый кабинет: ${firstFixNew.size}); со встречами: ${firstMeet.size}; с платной бронью (ДВОУ): ${firstDvou.size}; со сделками (реестр+кабинет): ${firstDeal.size}`);

    const funnel = (cohort, strict) => {
      const after = (m, b) => { const d = m.get(b.id); if (!d) return false; if (!strict) return true; return b.brokerTourDate ? new Date(d) >= new Date(b.brokerTourDate) : false; };
      const fix = cohort.filter((b) => after(firstFix, b)); const meet = cohort.filter((b) => after(firstMeet, b)); const dvou = cohort.filter((b) => after(firstDvou, b)); const deal = cohort.filter((b) => after(firstDeal, b));
      const seq = { fixThenMeet: cohort.filter((b) => after(firstFix, b) && after(firstMeet, b)).length, fixThenDeal: cohort.filter((b) => after(firstFix, b) && after(firstDeal, b)).length };
      const dBtFix = cohort.filter((b) => b.brokerTourDate && firstFix.get(b.id) && new Date(firstFix.get(b.id)) >= new Date(b.brokerTourDate)).map((b) => days(b.brokerTourDate, firstFix.get(b.id)));
      const dFixMeet = cohort.filter((b) => firstFix.get(b.id) && firstMeet.get(b.id) && new Date(firstMeet.get(b.id)) >= new Date(firstFix.get(b.id))).map((b) => days(firstFix.get(b.id), firstMeet.get(b.id)));
      const dFixDeal = cohort.filter((b) => firstFix.get(b.id) && firstDeal.get(b.id) && new Date(firstDeal.get(b.id)) >= new Date(firstFix.get(b.id))).map((b) => days(firstFix.get(b.id), firstDeal.get(b.id)));
      return { cohort: cohort.length, withFixation: fix.length, withMeeting: meet.length, withPaidBooking: dvou.length, withDeal: deal.length, ...seq, medianDaysBtToFix: median(dBtFix), medianDaysFixToMeet: median(dFixMeet), medianDaysFixToDeal: median(dFixDeal) };
    };
    const all = funnel(bt, false); const strict = funnel(btDated, true);
    console.log(`Воронка БТ (за всё время): ${JSON.stringify(all)}`);
    console.log(`Воронка БТ (строго после даты БТ, только с датой): ${JSON.stringify(strict)}`);
    const noBt = brokers.filter((b) => !b.brokerTourVisited);
    const noBtFunnel = { cohort: noBt.length, withFixation: noBt.filter((b) => firstFix.has(b.id)).length, withMeeting: noBt.filter((b) => firstMeet.has(b.id)).length, withPaidBooking: noBt.filter((b) => firstDvou.has(b.id)).length, withDeal: noBt.filter((b) => firstDeal.has(b.id)).length };
    console.log(`Без отметки БТ: ${JSON.stringify(noBtFunnel)}`);
    // По годам БТ: когорты
    const byYear = {}; for (const y of Object.keys(btYears)) byYear[y] = funnel(btDated.filter((b) => new Date(b.brokerTourDate).getFullYear() === Number(y)), true);
    console.log(`Когорты по году БТ (строго): ${JSON.stringify(byYear)}`);
    // База Анны: отметки БТ в срезе и сцепка
    let anna = null;
    try {
      const agg = await prisma.loyaltySourceAggregate.count({ where: { brokerTourVisited: true } });
      const aggDated = await prisma.loyaltySourceAggregate.count({ where: { brokerTourVisited: true, brokerTourAt: { not: null } } });
      const links = await prisma.loyaltyEntityLink.findMany({ where: { status: "CONFIRMED", revokedAt: null, targetType: "BROKER" }, select: { targetId: true }, distinct: ["targetId"] });
      const linkedIds = new Set(links.map((l) => l.targetId));
      const linkedBt = bt.filter((b) => linkedIds.has(b.id)).length;
      anna = { sourceBtVisited: agg, sourceBtDated: aggDated, linkedBrokers: linkedIds.size, linkedWithOurBt: linkedBt };
    } catch (e) { anna = { error: String(e?.message || e) }; }
    console.log(`База Анны: ${JSON.stringify(anna)}`);
    console.log("RESULT: " + JSON.stringify({ brokers: brokers.length, bt: bt.length, btDated: btDated.length, btYears, stages, all, strict, noBt: noBtFunnel, byYear, anna }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
