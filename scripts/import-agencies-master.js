#!/usr/bin/env node
/**
 * 2026-09-05: массовый импорт агентств в карточки кабинета из сводного
 * реестра (agencies-master: кабинет + старый кабинет + Google-реестр ДДУ +
 * база Анны + amo). Вход — JSON-массив записей вида
 * {canonical, displayName, sources, registryDeals, registryAmount,
 *  oldCabinetBrokers, phones, inn, test, possibleDuplicateOf},
 * лежит в data-ветке (data/agencies-import.json), записи test=true в файл
 * не включены ещё на этапе подготовки.
 *
 * Что делает:
 *   1. Загружает ВСЕ существующие Agency (id, name, legalName, inn).
 *   2. Дедуп: запись пропускается, если её ИНН уже есть в БД, ЛИБО если
 *      нормализованный ключ canonical/displayName совпадает с ключом
 *      name/legalName существующего агентства. Нормализация — копия
 *      normalizeAgencyMatchKey из боевого мэтчинга сделок
 *      (apps/api/src/loyalty-base/loyalty-base.service.ts).
 *   3. Фильтр мусора: пустой/короче 2 символов ключ, имена «тест»/«test»,
 *      телефонные автокарточки «Агентство <10+ цифр>».
 *   4. Создаёт недостающие Agency: name = displayName, inn = inn из файла.
 *      ВАЖНО: в схеме agencies.inn NOT NULL + UNIQUE, а ИНН есть лишь у
 *      ~37 записей из ~1450 — для остальных генерится детерминированный
 *      плейсхолдер «NOINN-<sha1(canonical)[:10]>». Он очевидно не похож на
 *      настоящий ИНН (10–12 цифр); если брокер позже привяжется по
 *      настоящему ИНН, создастся отдельная карточка — склеивать вручную.
 *      Остальные поля Agency — дефолты схемы; поля «источник/комментарий»
 *      в модели нет.
 *
 * Режимы:
 *   DRY_RUN=1 (и вообще всё, кроме DRY_RUN=0) — только отчёт: сколько в
 *   файле, сколько совпало с существующими, сколько будет создано, сколько
 *   отфильтровано, топ-20 создаваемых по registryDeals. НИЧЕГО не пишет.
 *   DRY_RUN=0 — боевой: createMany порциями по 100 (skipDuplicates на
 *   случай гонки по inn), в конце count агентств до/после.
 *
 * Запуск в контейнере api (workflow apply-agencies-import.yml):
 *   DRY_RUN=1 node /app/scripts/import-agencies-master.js /app/agencies-import.json
 */

const fs = require("fs");
const crypto = require("crypto");

const BATCH_SIZE = 100;

// ─── Копия normalizeAgencyMatchKey из
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
// ─── конец копии ───

// Детерминированный плейсхолдер для NOT NULL + UNIQUE колонки agencies.inn:
// одинаковый вход → одинаковый «ИНН», повторный запуск не плодит дублей.
function placeholderInn(seed) {
  return (
    "NOINN-" +
    crypto.createHash("sha1").update(String(seed), "utf8").digest("hex").slice(0, 10)
  );
}

// Явный мусор: «тест»/«test» в любом регистре и телефонные автокарточки
// «Агентство <10+ цифр>» (их создаёт авторегистрация без названия).
function isGarbageName(name) {
  const trimmed = String(name || "").trim();
  if (/^(тест|test)$/iu.test(trimmed)) return true;
  if (/^агентство\s+\d{10,}$/iu.test(trimmed)) return true;
  return false;
}

/**
 * Чистая функция планирования (без БД) — используется и скриптом, и
 * локальной проверкой. records — записи agencies-master,
 * existingAgencies — [{name, legalName, inn}].
 */
function planImport(records, existingAgencies) {
  const existingKeys = new Set();
  const existingInns = new Set();
  for (const a of existingAgencies) {
    for (const v of [a.name, a.legalName]) {
      const key = normalizeAgencyMatchKey(v);
      if (key) existingKeys.add(key);
    }
    if (a.inn) existingInns.add(String(a.inn).trim());
  }

  const stats = {
    totalInFile: records.length,
    skippedTestFlag: 0, // страховка: test=true не должны попадать в файл
    skippedGarbage: 0, // пустой/короткий ключ, «тест», «Агентство <цифры>»
    matchedExisting: 0, // уже есть в БД (по ИНН или нормализованному ключу)
    skippedFileDuplicate: 0, // дубль ключа/ИНН внутри самого файла
    toCreate: 0,
    withRealInn: 0,
    withPlaceholderInn: 0,
  };

  const toCreate = [];
  const seenKeys = new Set();
  const seenInns = new Set();

  for (const r of records) {
    if (r?.test === true) {
      stats.skippedTestFlag++;
      continue;
    }
    const name = String(r?.displayName || "").trim();
    const keyDisplay = normalizeAgencyMatchKey(name);
    const keyCanonical = normalizeAgencyMatchKey(r?.canonical);
    if (!keyDisplay || keyDisplay.length < 2 || isGarbageName(name)) {
      stats.skippedGarbage++;
      continue;
    }

    const inn = r?.inn ? String(r.inn).trim() : null;
    if (inn && existingInns.has(inn)) {
      stats.matchedExisting++;
      continue;
    }
    if (
      existingKeys.has(keyDisplay) ||
      (keyCanonical && existingKeys.has(keyCanonical))
    ) {
      stats.matchedExisting++;
      continue;
    }

    if (
      seenKeys.has(keyDisplay) ||
      (keyCanonical && seenKeys.has(keyCanonical)) ||
      (inn && seenInns.has(inn))
    ) {
      stats.skippedFileDuplicate++;
      continue;
    }
    seenKeys.add(keyDisplay);
    if (keyCanonical) seenKeys.add(keyCanonical);
    if (inn) seenInns.add(inn);

    if (inn) stats.withRealInn++;
    else stats.withPlaceholderInn++;

    toCreate.push({
      name,
      inn: inn || placeholderInn(r?.canonical || name),
      // registryDeals — только для отчёта (топ-20), в БД не пишется
      registryDeals: Number(r?.registryDeals) || 0,
    });
  }
  stats.toCreate = toCreate.length;

  return { stats, toCreate };
}

function printSummary(stats, toCreate) {
  console.log("=== Сводка импорта агентств ===");
  console.log(`Записей в файле:                 ${stats.totalInFile}`);
  console.log(`Уже есть в БД (совпали):         ${stats.matchedExisting}`);
  console.log(`Будет создано:                   ${stats.toCreate}`);
  console.log(`  из них с настоящим ИНН:        ${stats.withRealInn}`);
  console.log(`  из них с плейсхолдером NOINN-: ${stats.withPlaceholderInn}`);
  console.log(`Отфильтровано мусора:            ${stats.skippedGarbage}`);
  console.log(`Дубли внутри файла:              ${stats.skippedFileDuplicate}`);
  console.log(`test=true (не должно быть >0):   ${stats.skippedTestFlag}`);

  const top = [...toCreate]
    .sort((a, b) => b.registryDeals - a.registryDeals)
    .slice(0, 20);
  console.log("\nТоп-20 создаваемых по сделкам реестра:");
  for (const t of top) {
    console.log(`  ${String(t.registryDeals).padStart(4)} | ${t.name}`);
  }
}

if (require.main === module) {
  (async () => {
    const filePath = process.argv[2];
    // Безопасный дефолт: боевой режим ТОЛЬКО при явном DRY_RUN=0.
    const dryRun = process.env.DRY_RUN !== "0";
    if (!filePath) {
      console.error(
        "Usage: DRY_RUN=1|0 node import-agencies-master.js <path-to-json>",
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

      const countBefore = await prisma.agency.count();
      console.log(`Агентств в БД до импорта: ${countBefore}`);

      const existing = await prisma.agency.findMany({
        select: { id: true, name: true, legalName: true, inn: true },
      });
      const { stats, toCreate } = planImport(records, existing);
      printSummary(stats, toCreate);

      if (dryRun) {
        console.log("\nDRY-RUN: ничего не создано. Для записи DRY_RUN=0.");
        return;
      }

      let created = 0;
      for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
        const batch = toCreate
          .slice(i, i + BATCH_SIZE)
          .map(({ name, inn }) => ({ name, inn }));
        const res = await prisma.agency.createMany({
          data: batch,
          skipDuplicates: true, // гонка по unique inn не роняет весь импорт
        });
        created += res.count;
        console.log(
          `— батч ${Math.floor(i / BATCH_SIZE) + 1}: создано ${created}/${toCreate.length} —`,
        );
      }

      const countAfter = await prisma.agency.count();
      console.log(`\ncreated=${created}`);
      console.log(`Агентств в БД: до=${countBefore}, после=${countAfter}`);
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
  placeholderInn,
  isGarbageName,
  planImport,
};
