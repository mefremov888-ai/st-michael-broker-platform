#!/usr/bin/env node
/**
 * 2026-09-14: владелец прислал действующие «Условия сотрудничества»
 * (сентябрь 2026): базовая комиссия 5 % при 100 % оплате, 4,5 % при
 * рассрочке с ПВ более 50 %, 4 % при рассрочке с ПВ до 50 % и
 * субсидированной ипотеке, плюс накопительная доплата за объём продаж
 * агентства В РУБЛЯХ. В коде кабинета зашита другая система — ступени по
 * накопленным КВАДРАТНЫМ МЕТРАМ (5,0–8,0 %). Смотрим, что реально лежит в
 * базе: какие политики активны, какие ставки и до какой даты. Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.commissionPolicy.findMany({
      orderBy: [{ project: "asc" }, { startDate: "desc" }],
    });
    console.log(`=== Политик комиссии в базе: ${rows.length} ===`);
    const now = new Date();
    for (const p of rows) {
      const active =
        p.isActive && new Date(p.startDate) <= now && new Date(p.endDate) >= now;
      console.log(`\n  ${p.project} | ${p.mode} | ${active ? "ДЕЙСТВУЕТ СЕЙЧАС" : "не действует"}`);
      console.log(`    период: ${String(p.startDate).slice(0, 10)} — ${String(p.endDate).slice(0, 10)}, isActive=${p.isActive}`);
      if (p.flatRate != null) console.log(`    единая ставка: ${p.flatRate}%`);
      if (p.levels) console.log(`    ступени: ${JSON.stringify(p.levels)}`);
      console.log(`    рассрочка: вкл=${p.installmentEnabled} скидка=${p.installmentDiscount}; субсид. ипотека: вкл=${p.subsidizedMortgageEnabled} ставка=${p.subsidizedMortgageRate}`);
      if (p.displayNote) console.log(`    подпись: ${p.displayNote}`);
      if (p.notes) console.log(`    заметка: ${p.notes}`);
    }

    const deals = await prisma.$queryRawUnsafe(`
      SELECT to_char(signed_at, 'YYYY-MM') AS m, COUNT(*)::int AS c,
             MIN(commission_rate)::text AS min_rate, MAX(commission_rate)::text AS max_rate
      FROM deals WHERE signed_at >= now() - interval '6 months'
      GROUP BY 1 ORDER BY 1
    `);
    console.log("\n=== Сделки кабинета: какие ставки проставлялись ===");
    if (!deals.length) console.log("  за полгода сделок в кабинете нет");
    for (const d of deals) console.log(`  ${d.m}: ${d.c} шт., ставки ${d.min_rate}–${d.max_rate}%`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
