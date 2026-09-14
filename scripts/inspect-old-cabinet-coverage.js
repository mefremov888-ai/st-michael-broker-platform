#!/usr/bin/env node
/**
 * 2026-09-14: что из выгрузки старого кабинета (agencies/brokers/orders.xlsx
 * от 29.08.2026) уже есть в базе, а что мы не забрали. Телефоны сверяем по
 * хэшам — персональных данных в репозитории нет. Только чтение.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const hash10 = (raw) => {
  const d = String(raw || "").replace(/\D/g, "");
  const ten = d.length >= 10 ? d.slice(-10) : "";
  return ten ? crypto.createHash("sha256").update(ten).digest("hex").slice(0, 16) : null;
};
const normName = (s) =>
  String(s || "").toLowerCase().replace(/[«»"'`]/g, "").replace(/\s+/g, " ").trim();

async function main() {
  const file = path.resolve(__dirname, "../data/old-cabinet-refbook-20260914.json");
  const ref = JSON.parse(fs.readFileSync(file, "utf-8"));
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const brokers = await prisma.broker.findMany({
      select: { id: true, phone: true, mergedIntoId: true, passwordHash: true, displayName: true },
    });
    const extra = await prisma.brokerPhone.findMany({ select: { brokerId: true, phone: true } });
    const known = new Map();
    for (const b of brokers) {
      const h = hash10(b.phone);
      if (h && !known.has(h)) known.set(h, b);
    }
    for (const p of extra) {
      const h = hash10(p.phone);
      if (h && !known.has(h)) known.set(h, { id: p.brokerId });
    }

    const refHashes = ref["хэши_телефонов_справочника"] || [];
    const orderHashes = ref["хэши_телефонов_из_заявок"] || [];
    const missingRef = refHashes.filter((h) => !known.has(h));
    const missingOrders = orderHashes.filter((h) => !known.has(h));

    console.log("=== Брокеры ===");
    console.log(`  в справочнике старого кабинета: ${refHashes.length}`);
    console.log(`  из них есть у нас:              ${refHashes.length - missingRef.length}`);
    console.log(`  НЕТ у нас:                      ${missingRef.length}`);
    console.log(`  телефонов брокеров в заявках:   ${orderHashes.length}`);
    console.log(`  из них нет у нас:               ${missingOrders.length}`);

    const agencies = await prisma.agency.findMany({ select: { id: true, name: true } });
    const byName = new Map(agencies.map((a) => [normName(a.name), a]));
    const refAgencies = ref["агентства"] || [];
    const missingAg = refAgencies.filter((n) => !byName.has(normName(n)));
    console.log("\n=== Агентства ===");
    console.log(`  в справочнике старого кабинета: ${refAgencies.length}`);
    console.log(`  из них есть у нас:              ${refAgencies.length - missingAg.length}`);
    console.log(`  НЕТ у нас:                      ${missingAg.length}`);
    console.log(`  всего агентств в базе:          ${agencies.length}`);
    console.log("  примеры отсутствующих:", missingAg.slice(0, 8).join(" | "));

    const clients = await prisma.client.count({ where: { comment: { startsWith: "[old-cabinet:" } } });
    console.log("\n=== Заявки ===");
    console.log(`  в файле:                        ${ref["заявок_всего"]}`);
    console.log(`  залито в базу:                  ${clients}`);
    console.log(`  разница:                        ${Number(ref["заявок_всего"]) - clients}`);
    console.log(`  статусы в файле:                ${JSON.stringify(ref["заявки_по_статусам"]).slice(0, 120)}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
