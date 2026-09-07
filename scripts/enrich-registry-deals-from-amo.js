#!/usr/bin/env node
/**
 * 2026-09-07: объект сделки для «Реестра сделок» (registry_deals) из лида
 * amoCRM — площадь, этаж, корпус, номер квартиры.
 *
 * Зачем: владелец хочет видеть в карточке агентства/брокера у сделки не
 * только сумму и дату ДДУ, но и площадь, этаж, корпус. В Google-реестре и в
 * выгрузке реестра этих полей нет, а у лида amo есть: «Метраж, м2» (604555),
 * «Этаж» (604551), «Дом» (604547, например «Корпус 1. Gold»). Номер квартиры
 * — поле ищется по названию («№ квартиры», «номер помещения»), если его нет —
 * не заполняется.
 *
 * Что делает:
 *   1. Берёт строки registry_deals с amoLeadId, у которых пусто хотя бы одно
 *      из полей объекта (sqm/floor/building/apartmentNumber).
 *   2. Тянет лиды пачками по 250 через GET /leads?filter[id][]=… (пауза
 *      280мс между страницами — «светофор» amo).
 *   3. Обновляет ТОЛЬКО пустые поля; object_source = 'amo'. Ничего не
 *      перезаписывает; лид не найден/поле пустое — пропуск со счётчиком.
 *
 * Режимы (безопасный дефолт — только отчёт):
 *   DRY_RUN=1 (и всё, кроме DRY_RUN=0) — отчёт: строк-кандидатов, лидов
 *   найдено, «заполнится N» по полю, топ-20 примеров. НИЧЕГО не пишет.
 *   DRY_RUN=0 — боевой: update по одной строке, счётчики.
 *
 * Запуск в контейнере api (workflow apply-registry-deal-objects.yml):
 *   DRY_RUN=1 node /app/scripts/enrich-registry-deals-from-amo.js
 */

const AMO_PAGE_PAUSE_MS = 280;
const BATCH = 250;
const APPLY_LOG_EVERY = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Известные ID полей лида (packages/integrations/src/amo-crm.fields.ts).
const LEAD_FIELD_SQM = 604555;
const LEAD_FIELD_FLOOR = 604551;
const LEAD_FIELD_BUILDING = 604547;

function cfValueById(entity, fieldId) {
  if (!fieldId) return null;
  const fields = entity?.custom_fields_values || [];
  for (const f of fields) {
    if (Number(f?.field_id) !== Number(fieldId)) continue;
    for (const v of f?.values || []) {
      const value = v?.value;
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        return String(value).trim();
      }
    }
  }
  return null;
}

/** «54,3» / «54.30 м2» → 54.3; мусор → null. */
function parseSqm(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/\s+/g, "").replace(",", ".");
  const m = cleaned.match(/^-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) return null;
  return Math.round(n * 100) / 100;
}

/** «7» / «7 этаж» / «7/25» → 7; мусор → null. */
function parseFloor(raw) {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).trim().match(/^-?\d{1,3}/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isInteger(n) || n < -5 || n > 200) return null;
  return n;
}

function parseText(raw, maxLen = 120) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).replace(/\s+/g, " ").trim();
  return value ? value.slice(0, maxLen) : null;
}

/** Поле «номер квартиры» среди кастом-полей лида — по названию. */
function pickApartmentField(customFields) {
  const list = Array.isArray(customFields) ? customFields : [];
  const byName = (re) =>
    list.find(
      (f) =>
        re.test(String(f?.name || "")) &&
        /text|numeric/i.test(String(f?.type || "text")),
    );
  return (
    byName(/^№\s*(кв|квартир|помещ)/i) ||
    byName(/номер\s*(квартир|помещен)/i) ||
    byName(/(квартир|помещен)/i) ||
    null
  );
}

/** План обновления строки реестра по лиду (чистая функция). */
function planRowUpdate(row, lead, apartmentFieldId) {
  if (!lead) return null;
  const data = {};
  const fields = [];
  const sqm = parseSqm(cfValueById(lead, LEAD_FIELD_SQM));
  const floor = parseFloor(cfValueById(lead, LEAD_FIELD_FLOOR));
  const building = parseText(cfValueById(lead, LEAD_FIELD_BUILDING));
  const apartment = apartmentFieldId
    ? parseText(cfValueById(lead, apartmentFieldId), 32)
    : null;
  const empty = (v) => v === null || v === undefined || String(v).trim() === "";
  if (empty(row.sqm) && sqm !== null) {
    data.sqm = sqm;
    fields.push("sqm");
  }
  if (empty(row.floor) && floor !== null) {
    data.floor = floor;
    fields.push("floor");
  }
  if (empty(row.building) && building) {
    data.building = building;
    fields.push("building");
  }
  if (empty(row.apartmentNumber) && apartment) {
    data.apartmentNumber = apartment;
    fields.push("apartmentNumber");
  }
  if (!fields.length) return null;
  data.objectSource = "amo";
  return { data, fields };
}

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  console.log(
    `=== Режим: ${dryRun ? "DRY-RUN (только отчёт)" : "APPLY (запись в БД!)"} ===\n`,
  );
  const {
    AmoCrmAdapter,
    setAmoTokens,
    setAmoTokenRefreshHook,
  } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();

  try {
    const tokenRows = await prisma.systemSetting.findMany({
      where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } },
      select: { key: true, value: true },
    });
    const byKey = new Map(tokenRows.map((r) => [r.key, r.value]));
    setAmoTokens(
      byKey.get("AMO_ACCESS_TOKEN") || process.env.AMO_ACCESS_TOKEN || "",
      byKey.get("AMO_REFRESH_TOKEN") || process.env.AMO_REFRESH_TOKEN || "",
    );
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [
        ["AMO_ACCESS_TOKEN", tokens.access],
        ["AMO_REFRESH_TOKEN", tokens.refresh],
      ]) {
        await prisma.systemSetting.upsert({
          where: { key },
          update: { value, updatedBy: "enrich-registry-deals-from-amo" },
          create: { key, value, updatedBy: "enrich-registry-deals-from-amo" },
        });
      }
      console.error("amo tokens refreshed and persisted");
    });
    const amo = new AmoCrmAdapter();

    // 1. Поле «номер квартиры» — по справочнику кастом-полей лидов.
    const customFields = [];
    for (let page = 1; ; page++) {
      const res = await amo["request"](
        `/leads/custom_fields?page=${page}&limit=250`,
      );
      const list = res?._embedded?.custom_fields || [];
      customFields.push(...list);
      if (!res?._links?.next || list.length === 0) break;
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    const apartmentField = pickApartmentField(customFields);
    console.log(
      `Поле номера квартиры: ${apartmentField ? `id=${apartmentField.id} «${apartmentField.name}»` : "НЕ НАЙДЕНО — квартира не заполняется"}`,
    );

    // 2. Кандидаты.
    const rows = await prisma.registryDeal.findMany({
      where: {
        amoLeadId: { not: null },
        OR: [
          { sqm: null },
          { floor: null },
          { building: null },
          { apartmentNumber: null },
        ],
      },
      select: {
        id: true,
        contractNumber: true,
        amoLeadId: true,
        sqm: true,
        floor: true,
        building: true,
        apartmentNumber: true,
      },
    });
    console.log(`Строк реестра с лидом amo и пустым объектом: ${rows.length}`);

    // 3. Лиды пачками.
    const leadIds = [
      ...new Set(
        rows
          .map((r) => Number(r.amoLeadId))
          .filter((n) => Number.isSafeInteger(n) && n > 0),
      ),
    ];
    const leads = new Map();
    let requestErrors = 0;
    for (let i = 0; i < leadIds.length; i += BATCH) {
      const chunk = leadIds.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/leads?${q}&limit=${BATCH}`);
        for (const lead of res?._embedded?.leads || []) {
          leads.set(Number(lead.id), lead);
        }
      } catch (e) {
        requestErrors++;
        console.error(
          `Ошибка страницы лидов (${i}-${i + chunk.length}): ${e?.message || e}`,
        );
      }
      console.log(`— лиды: ${Math.min(i + BATCH, leadIds.length)}/${leadIds.length} —`);
      await sleep(AMO_PAGE_PAUSE_MS);
    }

    // 4. План.
    const stats = {
      leadFound: 0,
      leadMissing: 0,
      fillSqm: 0,
      fillFloor: 0,
      fillBuilding: 0,
      fillApartment: 0,
      nothingToFill: 0,
    };
    const updates = [];
    const examples = [];
    for (const row of rows) {
      const lead = leads.get(Number(row.amoLeadId));
      if (!lead) {
        stats.leadMissing++;
        continue;
      }
      stats.leadFound++;
      const plan = planRowUpdate(row, lead, apartmentField?.id || null);
      if (!plan) {
        stats.nothingToFill++;
        continue;
      }
      if (plan.fields.includes("sqm")) stats.fillSqm++;
      if (plan.fields.includes("floor")) stats.fillFloor++;
      if (plan.fields.includes("building")) stats.fillBuilding++;
      if (plan.fields.includes("apartmentNumber")) stats.fillApartment++;
      updates.push({ id: row.id, contractNumber: row.contractNumber, ...plan });
      if (examples.length < 20) {
        examples.push({ contractNumber: row.contractNumber, data: plan.data });
      }
    }

    console.log("\n=== Сводка: объект сделки из лидов amo ===");
    console.log(`Лид найден:                 ${stats.leadFound}`);
    console.log(`Лид не найден в amo:        ${stats.leadMissing}`);
    console.log(`Ошибок запросов:            ${requestErrors}`);
    console.log(`Лид без полей объекта:      ${stats.nothingToFill}`);
    console.log(`Строк к обновлению:         ${updates.length}`);
    console.log(`Заполнится площадь:         ${stats.fillSqm}`);
    console.log(`Заполнится этаж:            ${stats.fillFloor}`);
    console.log(`Заполнится корпус:          ${stats.fillBuilding}`);
    console.log(`Заполнится квартира:        ${stats.fillApartment}`);
    console.log("\nТоп-20 примеров «договор → объект»:");
    for (const e of examples) {
      const d = e.data;
      console.log(
        `  ${e.contractNumber} → площадь=${d.sqm ?? "—"} этаж=${d.floor ?? "—"} корпус=${d.building ?? "—"} кв=${d.apartmentNumber ?? "—"}`,
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
        await prisma.registryDeal.update({ where: { id: u.id }, data: u.data });
        updated++;
      } catch (e) {
        failed++;
        console.error(`Ошибка «${u.contractNumber}»: ${e?.message || e}`);
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

module.exports = {
  cfValueById,
  parseSqm,
  parseFloor,
  parseText,
  pickApartmentField,
  planRowUpdate,
};
