#!/usr/bin/env node
/**
 * 2026-09-07: ночная сводка качества данных кабинета (решение владельца:
 * слать в Telegram владельцу и Анне). Только чтение; в тексте нет ПД —
 * только счётчики. Печатает текст между DIGEST_BEGIN / DIGEST_END, отправку
 * делает workflow nightly-data-quality-digest.yml.
 *
 * Разделы: брокеры, агентства, клиенты/фиксации (по источникам), реестр
 * сделок (по правилу оплаты), база Анны и сцепки, кандидаты в дубли,
 * что появилось за последние 24 часа.
 */

const HIST = "[old-cabinet:";
const DAY = 24 * 60 * 60 * 1000;
const n = (v) => Number(v || 0).toLocaleString("ru-RU");

async function safe(label, fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    console.error(`[digest] ${label}: ${e?.message || e}`);
    return fallback;
  }
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const now = new Date();
  const since = new Date(now.getTime() - DAY);
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const stamp = `${String(msk.getUTCDate()).padStart(2, "0")}.${String(msk.getUTCMonth() + 1).padStart(2, "0")}.${msk.getUTCFullYear()} ${String(msk.getUTCHours()).padStart(2, "0")}:${String(msk.getUTCMinutes()).padStart(2, "0")} МСК`;
  try {
    const brokerWhere = { role: "BROKER", mergedIntoId: null };
    const FIX = {
      OR: [
        { fixationStatus: { in: ["FIXED", "EXPIRED"] } },
        { uniquenessStatus: { in: ["CONDITIONALLY_UNIQUE", "EXPIRED"] } },
      ],
    };
    const ACTIVE = {
      OR: [
        { fixationStatus: "FIXED", OR: [{ fixationExpiresAt: null }, { fixationExpiresAt: { gt: now } }] },
        { uniquenessStatus: "CONDITIONALLY_UNIQUE", OR: [{ uniquenessExpiresAt: null }, { uniquenessExpiresAt: { gt: now } }] },
      ],
    };
    // NULL-safe (hotfix 07.09): пустой комментарий = запись нового кабинета.
    const notHist = { OR: [{ comment: null }, { NOT: { comment: { startsWith: HIST } } }] };

    const [
      brokers, brokersLinked, brokersNoAmo, brokersNew,
      agencies, agenciesRealInn, agenciesNew, agencyNames,
      clients, clientsHist, clientsAmo, clientsNew, fixLifetime, fixActive, underReview,
      regTotal, regPaid, regBookings, regNoBroker, regNoLead,
      dealsTotal, meetings24, annaRecords, links,
      dupPhones,
    ] = await Promise.all([
      safe("brokers", () => prisma.broker.count({ where: brokerWhere }), 0),
      safe("brokersLinked", () => prisma.broker.count({ where: { ...brokerWhere, brokerAgencies: { some: {} } } }), 0),
      safe("brokersNoAmo", () => prisma.broker.count({ where: { ...brokerWhere, amoContactId: null } }), 0),
      safe("brokersNew", () => prisma.broker.count({ where: { ...brokerWhere, createdAt: { gte: since } } }), 0),
      safe("agencies", () => prisma.agency.count(), 0),
      safe("agenciesRealInn", () => prisma.agency.count({ where: { NOT: { inn: { startsWith: "NOINN" } } } }), 0),
      safe("agenciesNew", () => prisma.agency.count({ where: { createdAt: { gte: since } } }), 0),
      safe("agencyNames", () => prisma.agency.findMany({ select: { name: true, legalName: true } }), []),
      safe("clients", () => prisma.client.count(), 0),
      safe("clientsHist", () => prisma.client.count({ where: { comment: { startsWith: HIST } } }), 0),
      safe("clientsAmo", () => prisma.client.count({ where: { amoLeadId: { not: null }, ...notHist } }), 0),
      safe("clientsNew", () => prisma.client.count({ where: { createdAt: { gte: since }, ...notHist } }), 0),
      safe("fixLifetime", () => prisma.client.count({ where: { ...FIX, broker: { is: brokerWhere } } }), 0),
      safe("fixActive", () => prisma.client.count({ where: { ...ACTIVE, broker: { is: brokerWhere } } }), 0),
      safe("underReview", () => prisma.client.count({ where: { uniquenessStatus: "UNDER_REVIEW" } }), 0),
      safe("regTotal", () => prisma.registryDeal.count(), 0),
      safe("regPaid", () => prisma.registryDeal.count({ where: { paidAt: { not: null } } }), 0),
      safe("regBookings", () => prisma.registryDeal.count({ where: { dvouPaidAt: { not: null } } }), 0),
      safe("regNoBroker", () => prisma.registryDeal.count({ where: { paidAt: { not: null }, brokerId: null } }), 0),
      safe("regNoLead", () => prisma.registryDeal.count({ where: { amoLeadId: null } }), 0),
      safe("dealsTotal", () => prisma.deal.count(), 0),
      safe("meetings24", () => prisma.meeting.count({ where: { createdAt: { gte: since } } }), 0),
      safe("annaRecords", async () => {
        const ds = await prisma.loyaltyDataset.findFirst({ where: { code: "ANNA" }, select: { activeSnapshotId: true } });
        if (!ds?.activeSnapshotId) return null;
        return prisma.loyaltySourceRecord.count({ where: { snapshotId: ds.activeSnapshotId, sourceArchivedAt: null } });
      }, null),
      safe("links", () => prisma.loyaltyEntityLink.groupBy({ by: ["status"], _count: { _all: true } }), []),
      safe("dupPhones", async () => {
        // Один телефон клиента у нескольких брокеров — кандидаты в спор/дубль.
        const rows = await prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS c FROM (SELECT phone FROM clients WHERE phone IS NOT NULL AND (comment IS NULL OR comment NOT LIKE '[old-cabinet:%') GROUP BY phone HAVING COUNT(DISTINCT broker_id) > 1) t`,
        );
        return Number(rows?.[0]?.c || 0);
      }, null),
    ]);

    // Дубли агентств по нормализованному названию (без ИНН).
    let agencyDupKeys = 0;
    try {
      const { canonicalAgencyMatchKey } = require("./enrich-agencies-from-amo");
      const seen = new Map();
      for (const a of agencyNames) {
        const k = canonicalAgencyMatchKey(a.name) || canonicalAgencyMatchKey(a.legalName);
        if (!k) continue;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      agencyDupKeys = [...seen.values()].filter((c) => c > 1).length;
    } catch (e) {
      console.error(`[digest] agencyDupKeys: ${e?.message || e}`);
    }
    const linkStr = (links || []).map((l) => `${l.status.toLowerCase()} ${n(l._count._all)}`).join(", ") || "нет";

    const lines = [
      `📊 Кабинет брокера — сводка качества данных, ${stamp}`,
      ``,
      `Брокеры: ${n(brokers)} действующих; с агентством ${n(brokersLinked)}, без агентства ${n(brokers - brokersLinked)}; без контакта amo ${n(brokersNoAmo)}; новых за сутки ${n(brokersNew)}.`,
      `Агентства: ${n(agencies)}; с настоящим ИНН ${n(agenciesRealInn)}; похожих названий (кандидаты в дубли) ${n(agencyDupKeys)}; новых за сутки ${n(agenciesNew)}.`,
      `Клиенты: ${n(clients)} всего = старый кабинет ${n(clientsHist)} + из amo ${n(clientsAmo)} + заведены в кабинете ${n(clients - clientsHist - clientsAmo)}. Новых за сутки ${n(clientsNew)}.`,
      `Фиксации: за всё время ${n(fixLifetime)}, действующих ${n(fixActive)}, на рассмотрении ${n(underReview)}.`,
      `Реестр сделок: строк ${n(regTotal)}; сделок (оплаченный ДДУ) ${n(regPaid)}; платных броней (ДВОУ) ${n(regBookings)}; оплаченных без брокера ${n(regNoBroker)}; без лида amo ${n(regNoLead)}. Сделок из amo (Deal): ${n(dealsTotal)}.`,
      `База Анны: строк в активном снимке ${annaRecords === null ? "нет снимка" : n(annaRecords)}; сцепки: ${linkStr}.`,
      `Несопоставленное: один телефон клиента у нескольких брокеров — ${dupPhones === null ? "н/д" : n(dupPhones)}; встреч создано за сутки ${n(meetings24)}.`,
    ];
    const text = lines.join("\n");
    console.log("DIGEST_BEGIN");
    console.log(text);
    console.log("DIGEST_END");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}
