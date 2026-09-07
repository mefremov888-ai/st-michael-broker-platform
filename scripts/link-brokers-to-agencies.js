#!/usr/bin/env node
/**
 * 2026-09-07: массовая привязка брокеров к карточкам агентств по данным
 * СТАРОГО кабинета (2 325 брокеров с текстовым названием агентства).
 * Вход — JSON-массив записей {brokerPhone, agencyKey, agencyNameRaw},
 * подготовленных локально из brokers.xlsx (телефон нормализован до
 * "+7"+10 цифр, agencyKey — canonicalAgencyMatchKey названия), лежит в
 * data-ветке (data/broker-agency-links.json).
 *
 * Что делает:
 *   1. Грузит всех Broker (id, phone + дополнительные BrokerPhone) и все
 *      Agency (id, name, legalName), строит индексы: телефон → брокер,
 *      canonical-ключ названия → агентства.
 *   2. Для каждой записи: брокер по точному совпадению нормализованного
 *      телефона, агентство по ключу; если найдены оба и связи в
 *      broker_agencies ещё нет — планирует создание BrokerAgency
 *      (isPrimary=false — нейтрально, joinedAt по default(now)).
 *      Существующие связи НЕ трогает, ничего не обновляет и не удаляет.
 *      Дедуп по (brokerId, agencyId) — и против БД, и внутри файла;
 *      страховкой служит @@unique([brokerId, agencyId]) + skipDuplicates.
 *   3. Если ключу соответствует несколько агентств (дубли карточек по
 *      названию), связь создаётся с каждым найденным — так же, как боевой
 *      мэтчинг реестра приписывает сделку всем карточкам с этим ключом.
 *
 * Режимы:
 *   DRY_RUN=1 (и вообще всё, кроме DRY_RUN=0) — только отчёт: всего строк,
 *   брокер найден/нет, агентство найдено/нет, сколько связей будет создано,
 *   топ-15 агентств по числу новых связей. НИЧЕГО не пишет.
 *   DRY_RUN=0 — боевой: createMany порциями по 200 (skipDuplicates),
 *   отчёт created=N и счётчик broker_agencies до/после.
 *
 * Запуск в контейнере api (workflow apply-broker-agency-links.yml):
 *   DRY_RUN=1 node /app/scripts/link-brokers-to-agencies.js /app/broker-agency-links.json
 */

const fs = require("fs");

const BATCH_SIZE = 200;

// ─── Копия normalizeAgencyMatchKey + AGENCY_KEY_ALIASES +
// canonicalAgencyMatchKey из
// apps/api/src/loyalty-base/loyalty-base.service.ts (импорт из .ts в
// js-скрипт контейнера невозможен — dist компилируется без экспорта этого
// модуля наружу). Менять ТОЛЬКО синхронно с оригиналом. ───
const AGENCY_NAME_STOP_TOKENS = new Set([
  "ооо",
  "оао",
  "зао",
  "пао",
  "ао",
  "ип",
  "ан",
  "агентство",
  "недвижимости",
  "llc",
  "ltd",
]);

function normalizeAgencyMatchKey(value) {
  const tokens = String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!tokens.length) return null;
  const meaningful = tokens.filter(
    (token) => !AGENCY_NAME_STOP_TOKENS.has(token),
  );
  return (meaningful.length ? meaningful : tokens).join("") || null;
}

const AGENCY_KEY_ALIASES = {
  trendagent: normalizeAgencyMatchKey("ООО «Онлайн Недвижимость»"),
  нмаркетпро: normalizeAgencyMatchKey("Нмаркет"),
};

function canonicalAgencyMatchKey(value) {
  const key = normalizeAgencyMatchKey(value);
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(AGENCY_KEY_ALIASES, key)
    ? AGENCY_KEY_ALIASES[key]
    : key;
}
// ─── конец копии ───

// Телефоны в файле уже нормализованы ("+7"+10 цифр); эта функция —
// страховка + приведение телефонов БД к тому же виду для точного сравнения.
function normalizePhone(input) {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (digits.length === 10 && digits[0] === "9") return "+7" + digits;
  if (digits.length === 11 && digits[0] === "7" && digits[1] !== "7")
    return "+" + digits;
  if (digits.length === 11 && digits[0] === "8") return "+7" + digits.slice(1);
  return null;
}

/**
 * Чистая функция планирования (без БД): records — записи файла,
 * brokers — [{id, phone, phones: [{phone}]}], agencies — [{id, name,
 * legalName}], existingLinks — [{brokerId, agencyId}].
 */
function planLinks(records, brokers, agencies, existingLinks) {
  const brokerByPhone = new Map();
  for (const broker of brokers) {
    const candidates = [
      broker.phone,
      ...(Array.isArray(broker.phones)
        ? broker.phones.map((p) => p && p.phone)
        : []),
    ];
    for (const raw of candidates) {
      const phone = normalizePhone(raw);
      if (!phone) continue;
      // Первый брокер с этим телефоном выигрывает (phone в БД unique,
      // коллизии возможны только через broker_phones — редкость).
      if (!brokerByPhone.has(phone)) brokerByPhone.set(phone, broker.id);
    }
  }

  const agenciesByKey = new Map();
  for (const agency of agencies) {
    for (const value of [agency.name, agency.legalName]) {
      const key = canonicalAgencyMatchKey(value);
      if (!key) continue;
      const list = agenciesByKey.get(key) || [];
      if (!list.includes(agency.id)) list.push(agency.id);
      agenciesByKey.set(key, list);
    }
  }

  const existingPairs = new Set();
  for (const link of existingLinks) {
    existingPairs.add(`${link.brokerId}|${link.agencyId}`);
  }

  const stats = {
    totalRows: records.length,
    brokerFound: 0,
    brokerNotFound: 0,
    agencyFound: 0,
    agencyNotFound: 0,
    alreadyLinked: 0,
    toCreate: 0,
  };
  const toCreate = [];
  const plannedPairs = new Set();
  const perAgency = new Map(); // agencyId → счётчик новых связей

  for (const record of records) {
    const phone = normalizePhone(record && record.brokerPhone);
    const brokerId = phone ? brokerByPhone.get(phone) : undefined;
    if (!brokerId) {
      stats.brokerNotFound++;
      continue;
    }
    stats.brokerFound++;

    const key = String((record && record.agencyKey) || "");
    const agencyIds = key ? agenciesByKey.get(key) : undefined;
    if (!agencyIds || !agencyIds.length) {
      stats.agencyNotFound++;
      continue;
    }
    stats.agencyFound++;

    for (const agencyId of agencyIds) {
      const pair = `${brokerId}|${agencyId}`;
      if (existingPairs.has(pair)) {
        stats.alreadyLinked++;
        continue;
      }
      if (plannedPairs.has(pair)) continue; // дубль внутри файла
      plannedPairs.add(pair);
      toCreate.push({ brokerId, agencyId, isPrimary: false });
      perAgency.set(agencyId, (perAgency.get(agencyId) || 0) + 1);
    }
  }
  stats.toCreate = toCreate.length;

  return { stats, toCreate, perAgency };
}

function printSummary(stats, perAgency, agencies) {
  console.log("=== Сводка привязки брокеров к агентствам ===");
  console.log(`Строк в файле:                    ${stats.totalRows}`);
  console.log(`Брокер найден по телефону:        ${stats.brokerFound}`);
  console.log(`Брокер НЕ найден:                 ${stats.brokerNotFound}`);
  console.log(`Агентство найдено по ключу:       ${stats.agencyFound}`);
  console.log(`Агентство НЕ найдено:             ${stats.agencyNotFound}`);
  console.log(`Связь уже есть (не трогаем):      ${stats.alreadyLinked}`);
  console.log(`Связей будет создано:             ${stats.toCreate}`);

  const nameById = new Map(agencies.map((a) => [a.id, a.name]));
  const top = [...perAgency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log("\nТоп-15 агентств по числу новых связей:");
  for (const [agencyId, count] of top) {
    console.log(
      `  ${String(count).padStart(4)} | ${nameById.get(agencyId) || agencyId}`,
    );
  }
}

if (require.main === module) {
  (async () => {
    const filePath = process.argv[2];
    // Безопасный дефолт: боевой режим ТОЛЬКО при явном DRY_RUN=0.
    const dryRun = process.env.DRY_RUN !== "0";
    if (!filePath) {
      console.error(
        "Usage: DRY_RUN=1|0 node link-brokers-to-agencies.js <path-to-json>",
      );
      process.exit(1);
    }

    const records = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(records)) {
      console.error("FATAL: входной JSON должен быть массивом записей");
      process.exit(1);
    }

    const { PrismaClient } = require("@st-michael/database");
    const prisma = new PrismaClient();

    try {
      console.log(
        `=== Режим: ${dryRun ? "DRY-RUN (только отчёт)" : "APPLY (запись в БД!)"} ===\n`,
      );

      const countBefore = await prisma.brokerAgency.count();
      console.log(`Связей broker_agencies до: ${countBefore}`);

      const brokers = await prisma.broker.findMany({
        select: { id: true, phone: true, phones: { select: { phone: true } } },
      });
      const agencies = await prisma.agency.findMany({
        select: { id: true, name: true, legalName: true },
      });
      const existingLinks = await prisma.brokerAgency.findMany({
        select: { brokerId: true, agencyId: true },
      });
      console.log(
        `Брокеров: ${brokers.length}, агентств: ${agencies.length}, связей: ${existingLinks.length}\n`,
      );

      const { stats, toCreate, perAgency } = planLinks(
        records,
        brokers,
        agencies,
        existingLinks,
      );
      printSummary(stats, perAgency, agencies);

      if (dryRun) {
        console.log("\nDRY-RUN: ничего не создано. Для записи DRY_RUN=0.");
        return;
      }

      let created = 0;
      for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
        const batch = toCreate.slice(i, i + BATCH_SIZE);
        const res = await prisma.brokerAgency.createMany({
          data: batch,
          skipDuplicates: true, // @@unique([brokerId, agencyId]) не роняет запуск
        });
        created += res.count;
        console.log(
          `— батч ${Math.floor(i / BATCH_SIZE) + 1}: создано ${created}/${toCreate.length} —`,
        );
      }

      const countAfter = await prisma.brokerAgency.count();
      console.log(`\ncreated=${created}`);
      console.log(
        `Связей broker_agencies: до=${countBefore}, после=${countAfter}`,
      );
    } finally {
      await prisma.$disconnect();
    }
  })().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}

module.exports = {
  normalizeAgencyMatchKey,
  canonicalAgencyMatchKey,
  normalizePhone,
  planLinks,
};
