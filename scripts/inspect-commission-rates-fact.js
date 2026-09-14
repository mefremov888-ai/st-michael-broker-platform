#!/usr/bin/env node
/**
 * 2026-09-14: какие ставки комиссии РЕАЛЬНО платят. Считаем по факту из
 * Google-листа: сумма комиссии / стоимость по ДДУ. Это ответ на вопрос
 * «сколько на самом деле», без опоры на политики кабинета. Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT project::text AS project,
             sale_channel AS channel,
             lead_source_raw AS lead_source,
             amount::float8 AS amount,
             commission_amount_fact::float8 AS fact,
             commission_paid_raw AS paid_raw,
             commission_paid_amount::float8 AS paid_amount
      FROM registry_deals
      WHERE commission_amount_fact IS NOT NULL AND amount IS NOT NULL AND amount > 0
    `);
    console.log(`=== Договоров с суммой комиссии и стоимостью: ${rows.length} ===`);

    const buckets = new Map();
    const byProject = new Map();
    for (const r of rows) {
      const rate = (r.fact / r.amount) * 100;
      const key = rate < 0.5 ? "меньше 0,5%" : rate > 12 ? "больше 12% (похоже, не ставка)" : `${(Math.round(rate * 4) / 4).toFixed(2)}%`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
      const p = byProject.get(r.project) || { n: 0, sum: 0, rates: [] };
      p.n++; p.sum += r.fact; p.rates.push(rate);
      byProject.set(r.project, p);
    }
    console.log("\n--- Фактическая ставка (сумма комиссии / стоимость ДДУ) ---");
    for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
      console.log(`  ${String(k).padEnd(28)} ${v}`);
    }
    console.log("\n--- По проектам ---");
    for (const [p, v] of byProject) {
      const sorted = v.rates.slice().sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      console.log(`  ${p}: договоров ${v.n}, медианная ставка ${med.toFixed(2)}%, всего комиссии ${Math.round(v.sum).toLocaleString("ru-RU")} ₽`);
    }

    const paid = rows.filter((r) => r.paid_raw);
    const withSum = paid.filter((r) => r.paid_amount !== null);
    const mismatch = withSum.filter((r) => Math.abs(r.paid_amount - r.fact) > 1);
    console.log("\n--- Выплаты ---");
    console.log(`  с отметкой о выплате:              ${paid.length}`);
    console.log(`  из них с дописанной суммой:        ${withSum.length}`);
    console.log(`  где дописанная сумма ≠ начисленной: ${mismatch.length}`);
    for (const r of mismatch.slice(0, 5)) {
      console.log(`    начислено ${Math.round(r.fact)} ₽ · в отметке ${Math.round(r.paid_amount)} ₽ · «${String(r.paid_raw).slice(0, 40)}»`);
    }

    const srcRows = await prisma.$queryRawUnsafe(`
      SELECT COALESCE(lead_source_raw, '—') AS src, sale_channel AS channel, COUNT(*)::int AS c
      FROM registry_deals WHERE lead_source_raw IS NOT NULL GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12
    `);
    console.log("\n--- Источник лида против канала продажи ---");
    for (const r of srcRows) console.log(`  ${String(r.src).padEnd(12)} канал=${String(r.channel || "не определён").padEnd(14)} ${Number(r.c)}`);

    const fillable = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS c FROM registry_deals
      WHERE sale_channel IS NULL AND lead_source_raw IS NOT NULL
    `);
    console.log(`\n  договоров без канала, где источник лида ЕСТЬ: ${Number(fillable[0].c)}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
