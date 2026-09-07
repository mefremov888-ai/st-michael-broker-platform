#!/usr/bin/env node
/**
 * 2026-09-07: проверка «База Анны ↔ Наша база» перед любым решением о слиянии
 * (владелец: «если всё пойдёт на дубль — сломаем нашу базу; сначала результат
 * проверки»). Только чтение, без ПД в выводе (только счётчики и примеры без
 * телефонов).
 *
 * Что считает по активному снимку базы Анны (LoyaltyDataset code=ANNA):
 *   Брокеры Анны (source records BROKER):
 *     - есть телефон / нет телефона;
 *     - совпал ровно с одним нашим брокером по телефону (1:1);
 *     - совпал с несколькими нашими карточками (телефон у нескольких брокеров);
 *     - несколько строк Анны на одного нашего брокера (дубли внутри Анны);
 *     - не найден у нас («только у Анны»).
 *   Наши брокеры (role BROKER, не слиты): найдены у Анны / только у нас.
 *   Агентства Анны: по ИНН, по нормализованному названию, не найдены.
 *   Текущие сцепки LoyaltyEntityLink по статусам.
 *
 * Запуск в контейнере api (workflow inspect-anna-vs-ours.yml):
 *   node /app/scripts/inspect-anna-vs-ours.js
 */

const { canonicalAgencyMatchKey } = require("./enrich-agencies-from-amo");

function normPhone(value) {
  let d = String(value ?? "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  return d.length === 11 && d[0] === "7" ? d : null;
}

function pct(a, b) {
  return b ? `${Math.round((a / b) * 1000) / 10}%` : "—";
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const dataset = await prisma.loyaltyDataset.findFirst({ where: { code: "ANNA" }, select: { id: true, activeSnapshotId: true } });
    if (!dataset?.activeSnapshotId) {
      console.log("База Анны: активного снимка нет — сравнивать нечего.");
      console.log("RESULT: " + JSON.stringify({ snapshot: null }));
      return;
    }
    const snapshotId = dataset.activeSnapshotId;
    const records = await prisma.loyaltySourceRecord.findMany({
      where: { snapshotId, sourceArchivedAt: null },
      select: {
        id: true, entityType: true, personId: true, organizationId: true, displayName: true, taxId: true,
        contactPoints: { where: { type: "PHONE" }, select: { normalizedValue: true, value: true } },
      },
    });
    const annaBrokers = records.filter((r) => r.entityType === "BROKER");
    const annaAgencies = records.filter((r) => r.entityType === "AGENCY");
    console.log(`=== База Анны ↔ Наша база (снимок ${snapshotId.slice(0, 8)}…) ===`);
    console.log(`Строк Анны: брокеров ${annaBrokers.length}, агентств ${annaAgencies.length}`);

    // Наши брокеры и их телефоны.
    const ours = await prisma.broker.findMany({
      where: { role: "BROKER", mergedIntoId: null },
      select: { id: true, phone: true, phones: { select: { phone: true } }, brokerAgencies: { select: { agencyId: true } } },
    });
    const phoneToOurs = new Map(); // phone -> Set(brokerId)
    for (const b of ours) {
      for (const p of [b.phone, ...b.phones.map((x) => x.phone)]) {
        const n = normPhone(p);
        if (!n) continue;
        if (!phoneToOurs.has(n)) phoneToOurs.set(n, new Set());
        phoneToOurs.get(n).add(b.id);
      }
    }
    console.log(`Наших брокеров (действующих карточек): ${ours.length}; уникальных телефонов у них: ${phoneToOurs.size}`);

    // Брокеры Анны → наши.
    const stat = { noPhone: 0, one: 0, many: 0, none: 0 };
    const ourHit = new Map(); // ourBrokerId -> count of Anna rows
    const examplesNone = [];
    for (const r of annaBrokers) {
      const phones = [...new Set(r.contactPoints.map((c) => normPhone(c.normalizedValue || c.value)).filter(Boolean))];
      if (!phones.length) { stat.noPhone++; continue; }
      const targets = new Set();
      for (const p of phones) for (const id of phoneToOurs.get(p) || []) targets.add(id);
      if (targets.size === 0) { stat.none++; if (examplesNone.length < 10) examplesNone.push(r.displayName); continue; }
      if (targets.size === 1) { stat.one++; } else { stat.many++; }
      for (const id of targets) ourHit.set(id, (ourHit.get(id) || 0) + 1);
    }
    const ourMatched = ourHit.size;
    const ourWithSeveralAnna = [...ourHit.values()].filter((n) => n > 1).length;
    const ourOnly = ours.length - ourMatched;
    console.log("\n--- Брокеры Анны ---");
    console.log(`  без телефона:                              ${stat.noPhone}`);
    console.log(`  совпали ровно с одним нашим (1:1):         ${stat.one}  (${pct(stat.one, annaBrokers.length)})`);
    console.log(`  телефон есть у нескольких наших карточек:  ${stat.many}`);
    console.log(`  не найдены у нас («только у Анны»):        ${stat.none}  (${pct(stat.none, annaBrokers.length)})`);
    console.log(`  примеры «только у Анны» (имена): ${examplesNone.join("; ")}`);
    console.log("--- Наши брокеры ---");
    console.log(`  найдены у Анны:                             ${ourMatched}  (${pct(ourMatched, ours.length)})`);
    console.log(`  из них на одного нашего — несколько строк Анны (дубли внутри Анны): ${ourWithSeveralAnna}`);
    console.log(`  только у нас (нет у Анны):                  ${ourOnly}  (${pct(ourOnly, ours.length)})`);

    // Агентства Анны → наши.
    const agencies = await prisma.agency.findMany({ select: { id: true, name: true, legalName: true, inn: true } });
    const byInn = new Map(agencies.filter((a) => /^\d{10}(\d{2})?$/.test(String(a.inn || ""))).map((a) => [String(a.inn), a.id]));
    const byKey = new Map();
    for (const a of agencies) for (const v of [a.name, a.legalName]) { const k = canonicalAgencyMatchKey(v); if (k) { if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(a.id); } }
    const ag = { inn: 0, nameUnique: 0, nameAmbiguous: 0, none: 0 };
    const agExamples = [];
    for (const r of annaAgencies) {
      const inn = String(r.taxId || "").replace(/\D/g, "");
      if (inn && byInn.has(inn)) { ag.inn++; continue; }
      const k = canonicalAgencyMatchKey(r.displayName);
      const ids = k ? byKey.get(k) : null;
      if (ids && ids.size === 1) ag.nameUnique++;
      else if (ids && ids.size > 1) ag.nameAmbiguous++;
      else { ag.none++; if (agExamples.length < 10) agExamples.push(r.displayName); }
    }
    console.log("--- Агентства Анны ---");
    console.log(`  совпали по ИНН:                    ${ag.inn}`);
    console.log(`  совпали по названию (однозначно):  ${ag.nameUnique}`);
    console.log(`  название есть у нескольких наших:  ${ag.nameAmbiguous}`);
    console.log(`  не найдены у нас:                  ${ag.none}`);
    console.log(`  примеры не найденных: ${agExamples.join("; ")}`);

    // Текущие сцепки.
    const links = await prisma.loyaltyEntityLink.groupBy({ by: ["targetType", "status"], _count: { _all: true } });
    console.log("--- Сцепки LoyaltyEntityLink (тип/статус) ---");
    for (const l of links) console.log(`  ${l.targetType}/${l.status}: ${l._count._all}`);

    console.log("\nВывод: слияние без потерь возможно только для строк 1:1; «только у Анны» — это новые карточки (не дубли), а «несколько наших на один телефон» и «несколько строк Анны на одного нашего» — кандидаты в дубли, их надо разобрать руками до слияния.");
    console.log("RESULT: " + JSON.stringify({ snapshot: snapshotId, annaBrokers: annaBrokers.length, annaAgencies: annaAgencies.length, ourBrokers: ours.length, brokers: { ...stat, ourMatched, ourWithSeveralAnna, ourOnly }, agencies: ag, links: links.map((l) => ({ type: l.targetType, status: l.status, count: l._count._all })) }));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}

module.exports = { normPhone };
