#!/usr/bin/env node
/**
 * 2026-09-08 (владелец): три агентства с названием «ИП» — настоящие
 * предприниматели с ИНН; переименовать в «ИП Фамилия И. О.» (по юрназванию
 * или ФИО брокера), чтобы они не склеивались по названию. DRY_RUN=1 — отчёт.
 */
const RENAMES = [
  { id: "c9262cd0-d0cb-4e66-9589-7ab503a0504d", name: "ИП Старкова О. И." },
  { id: "a8d9650a-cff3-42ba-b0a6-be904ded529d", name: "ИП Корчагин М. В." },
  { id: "14f43bf0-3d71-4083-8d00-06cdf3254b72", name: "Эмпайр Эстейт" },
];
async function main() {
  const dry = process.env.DRY_RUN !== "0";
  const { PrismaClient } = require("@st-michael/database"); const prisma = new PrismaClient();
  try {
    console.log(`Режим: ${dry ? "DRY-RUN" : "APPLY"}`);
    for (const r of RENAMES) {
      const a = await prisma.agency.findUnique({ where: { id: r.id }, select: { id: true, name: true, legalName: true, inn: true, _count: { select: { brokerAgencies: true } } } });
      if (!a) { console.log(`  ✗ ${r.id}: не найдено`); continue; }
      const dup = await prisma.agency.findFirst({ where: { name: r.name, id: { not: r.id } }, select: { id: true } });
      console.log(`  • «${a.name}» (${a.legalName || "—"}, ИНН ${a.inn}, брокеров ${a._count.brokerAgencies}) → «${r.name}»${dup ? " — ЗАНЯТО, пропуск" : ""}`);
      if (!dry && !dup) await prisma.agency.update({ where: { id: r.id }, data: { name: r.name } });
    }
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
