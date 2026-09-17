#!/usr/bin/env node
/**
 * 2026-09-17: почему фильтры «Направление», «Не звонить» и «Данные и amoCRM»
 * на «Нашей базе» дают ноль. Только чтение: считаем, что вообще лежит в
 * соответствующих колонках у брокеров кабинета.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const total = await prisma.broker.count({ where: { mergedIntoId: null } });
    console.log(`Брокеров в базе (без слитых): ${total}\n`);

    const bySpec = await prisma.broker.groupBy({
      by: ["specialization"],
      where: { mergedIntoId: null },
      _count: { _all: true },
    });
    console.log("=== Направление (specialization) ===");
    for (const row of bySpec.sort((a, b) => b._count._all - a._count._all)) {
      console.log(`  ${row.specialization ?? "не заполнено"}: ${row._count._all}`);
    }

    const byRegion = await prisma.broker.groupBy({
      by: ["isRegional"],
      where: { mergedIntoId: null },
      _count: { _all: true },
    });
    console.log("\n=== Региональный признак ===");
    for (const row of byRegion) console.log(`  isRegional=${row.isRegional}: ${row._count._all}`);

    const byDnc = await prisma.broker.groupBy({
      by: ["doNotCall"],
      where: { mergedIntoId: null },
      _count: { _all: true },
    });
    console.log("\n=== «Не звонить» ===");
    for (const row of byDnc) console.log(`  doNotCall=${row.doNotCall}: ${row._count._all}`);

    const withAmo = await prisma.broker.count({
      where: { mergedIntoId: null, amoContactId: { not: null } },
    });
    console.log("\n=== Данные и amoCRM ===");
    console.log(`  с контактом amo: ${withAmo}`);
    console.log(`  без контакта amo: ${total - withAmo}`);

    const withPhoneAndName = await prisma.broker.count({
      where: {
        mergedIntoId: null,
        phone: { not: "" },
        fullName: { not: "" },
        email: { not: null },
      },
    });
    console.log(`  с телефоном, ФИО и почтой (условно «данные заполнены»): ${withPhoneAndName}`);

    const byFormat = await prisma.broker.groupBy({
      by: ["isCoordinator"],
      where: { mergedIntoId: null },
      _count: { _all: true },
    });
    console.log("\n=== Координаторы ===");
    for (const row of byFormat) console.log(`  isCoordinator=${row.isCoordinator}: ${row._count._all}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
