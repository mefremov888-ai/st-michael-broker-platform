#!/usr/bin/env node
/**
 * 2026-09-07: юридическое название и юридический адрес агентств из
 * госреестра (ЕГРЮЛ/ЕГРИП через DaData «Организация по ИНН»).
 *
 * Зачем: в «Нашей базе» у всех агентств «Юридическое название: Нет данных» —
 * поле Agency.legalName никогда не заполнялось (регистрация, привязка по
 * ИНН, импорт 05.09 и обогащение из amo пишут только name + inn). Сервис
 * DaData в проекте уже подключён (packages/integrations/dadata.adapter.ts,
 * ключ DADATA_API_KEY у api-контейнера), но использовался только в
 * подсказках формы регистрации.
 *
 * Что делает:
 *   1. Берёт карточки Agency с НАСТОЯЩИМ ИНН (10/12 цифр; плейсхолдеры
 *      NOINN-* пропускаются — по ним реестр ничего не найдёт).
 *   2. Для каждой, где пусто legalName или legalAddress либо имя —
 *      плейсхолдер «Агентство <ИНН>», запрашивает DaData по ИНН и берёт
 *      ТОЛЬКО точное совпадение ИНН.
 *   3. Обновляет ТОЛЬКО пустые поля: legalName ← полное название с ОПФ,
 *      legalAddress ← адрес; name — только если сейчас плейсхолдер.
 *      Ничего не перезаписывает.
 *
 * Режимы (безопасный дефолт — только отчёт):
 *   DRY_RUN=1 (и всё, кроме DRY_RUN=0) — отчёт: сколько карточек, сколько
 *   найдено в реестре, «заполнится N» по полю, топ-20 примеров. Не пишет.
 *   DRY_RUN=0 — боевой: update по одной, счётчики.
 *
 * Запуск в контейнере api (workflow apply-agency-legal-enrich.yml):
 *   DRY_RUN=1 node /app/scripts/enrich-agencies-legal-from-dadata.js
 */

const DADATA_PAUSE_MS = 150;
const APPLY_LOG_EVERY = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRealInn(value) {
  return /^(\d{10}|\d{12})$/.test(String(value ?? "").trim());
}

function isPlaceholderName(name, inn) {
  const value = String(name ?? "").trim();
  return !value || value === `Агентство ${inn}`;
}

/** План обновления одной карточки по ответу реестра (чистая функция). */
function planAgencyUpdate(agency, profile) {
  if (!profile) return null;
  const data = {};
  const fields = [];
  const legalName = String(profile.fullName || profile.name || "").trim();
  const shortName = String(profile.name || profile.fullName || "").trim();
  const address = String(profile.address || "").trim();
  if (!String(agency.legalName ?? "").trim() && legalName) {
    data.legalName = legalName;
    fields.push("legalName");
  }
  if (!String(agency.legalAddress ?? "").trim() && address) {
    data.legalAddress = address;
    fields.push("legalAddress");
  }
  if (isPlaceholderName(agency.name, agency.inn) && shortName) {
    data.name = shortName;
    fields.push("name");
  }
  return fields.length ? { data, fields } : null;
}

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  console.log(
    `=== Режим: ${dryRun ? "DRY-RUN (только отчёт)" : "APPLY (запись в БД!)"} ===\n`,
  );

  const { DadataAdapter } = require("/app/packages/integrations/dist/dadata.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const dadata = new DadataAdapter();

  try {
    if (!dadata.isConfigured()) {
      console.error("DADATA_API_KEY не задан в окружении api — обогащение невозможно.");
      process.exit(2);
    }

    const agencies = await prisma.agency.findMany({
      select: {
        id: true,
        name: true,
        inn: true,
        legalName: true,
        legalAddress: true,
      },
      orderBy: { name: "asc" },
    });
    const withRealInn = agencies.filter((a) => isRealInn(a.inn));
    const candidates = withRealInn.filter(
      (a) =>
        !String(a.legalName ?? "").trim() ||
        !String(a.legalAddress ?? "").trim() ||
        isPlaceholderName(a.name, a.inn),
    );

    const stats = {
      total: agencies.length,
      placeholderInn: agencies.length - withRealInn.length,
      realInn: withRealInn.length,
      candidates: candidates.length,
      foundInRegistry: 0,
      notFound: 0,
      requestErrors: 0,
      fillLegalName: 0,
      fillLegalAddress: 0,
      fillName: 0,
      liquidated: 0,
    };
    const updates = [];
    const examples = [];

    for (const agency of candidates) {
      let suggestions = [];
      try {
        suggestions = await dadata.suggestParty(agency.inn, 5);
      } catch {
        stats.requestErrors++;
        continue;
      } finally {
        await sleep(DADATA_PAUSE_MS);
      }
      const exact = suggestions.find((s) => String(s.inn) === agency.inn);
      if (!exact) {
        stats.notFound++;
        continue;
      }
      stats.foundInRegistry++;
      if (exact.status && exact.status !== "ACTIVE") stats.liquidated++;
      const plan = planAgencyUpdate(agency, exact);
      if (!plan) continue;
      if (plan.fields.includes("legalName")) stats.fillLegalName++;
      if (plan.fields.includes("legalAddress")) stats.fillLegalAddress++;
      if (plan.fields.includes("name")) stats.fillName++;
      updates.push({ agencyId: agency.id, agencyName: agency.name, ...plan });
      if (examples.length < 20) {
        examples.push({
          agencyName: agency.name,
          legalName: plan.data.legalName || agency.legalName || "—",
          status: exact.status,
          fields: plan.fields,
        });
      }
    }

    console.log("=== Сводка: юрреквизиты агентств из госреестра (DaData) ===");
    console.log(`Карточек Agency всего:              ${stats.total}`);
    console.log(`  с плейсхолдером NOINN-* (пропуск): ${stats.placeholderInn}`);
    console.log(`  с настоящим ИНН:                   ${stats.realInn}`);
    console.log(`Кандидатов (пустые реквизиты):      ${stats.candidates}`);
    console.log(`Найдено в реестре (точный ИНН):     ${stats.foundInRegistry}`);
    console.log(`  из них не действующие:             ${stats.liquidated}`);
    console.log(`Не найдено в реестре:               ${stats.notFound}`);
    console.log(`Ошибок запросов:                    ${stats.requestErrors}`);
    console.log(`Карточек к обновлению:              ${updates.length}`);
    console.log(`Заполнится юрназвание:              ${stats.fillLegalName}`);
    console.log(`Заполнится юрадрес:                 ${stats.fillLegalAddress}`);
    console.log(`Заменится имя-плейсхолдер:          ${stats.fillName}`);
    console.log("\nТоп-20 примеров «карточка → юрназвание (поля; статус)»:");
    for (const e of examples) {
      console.log(
        `  ${e.agencyName} → ${e.legalName} (${e.fields.join(", ")}; ${e.status})`,
      );
    }

    if (dryRun) {
      console.log("\nDRY-RUN: ничего не записано. Для записи DRY_RUN=0.");
      return;
    }

    let updated = 0;
    let failed = 0;
    for (const u of updates) {
      try {
        await prisma.agency.update({ where: { id: u.agencyId }, data: u.data });
        updated++;
      } catch (e) {
        failed++;
        console.error(`Ошибка «${u.agencyName}»: ${e?.message || e}`);
      }
      if ((updated + failed) % APPLY_LOG_EVERY === 0) {
        console.log(`— обновлено ${updated}/${updates.length} —`);
      }
    }
    console.log(`\nupdated=${updated}`);
    console.log(`Ошибок: ${failed}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e?.message || e);
    process.exit(1);
  });
}

module.exports = { isRealInn, isPlaceholderName, planAgencyUpdate };
