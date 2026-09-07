#!/usr/bin/env node
/**
 * 2026-09-07: отчёт расхождений «Реестр сделок» (registry_deals, источник
 * правды — Google-реестр) ↔ amoCRM. Только чтение, ничего не пишет.
 *
 * Правило владельца 07.09.2026: сделка = факт оплаты ДДУ («Дата оплаты ДДУ»,
 * paidAt), сумма = «Стоимость по ДДУ» (amount). Реестр — истина, amo —
 * подтверждение; расхождения показываются, а не «чинятся» автоматически.
 *
 * Что сравнивается (по строкам реестра с amoLeadId):
 *   1. «Дата ДДУ» реестра (signedAt) ↔ поле лида «Дата договора» (558353);
 *   2. «Стоимость по ДДУ» реестра (amount) ↔ поле лида «Стоимость в ДДУ» (833065),
 *      допуск ±1 ₽;
 *   3. № договора реестра ↔ поле лида «№ договора» (558577), латиница/кириллица
 *      нормализуются;
 *   4. проект реестра ↔ воронка лида (Зорге 9 / Берзарина=Серебряный Бор /
 *      Толбухина);
 *   5. оплата: paidAt реестра ↔ стадия лида (Успешно / Контроль оплаты /
 *      Зарегистрирована / Сделка / Платная бронь / прочее / Закрыто).
 * Плюс: строки реестра без лида amo; лиды amo на стадиях сделки, которых нет
 * в реестре (по трём клиентским воронкам).
 *
 * Запуск в контейнере api (workflow inspect-registry-vs-amo.yml):
 *   node /app/scripts/inspect-registry-vs-amo.js
 * Переменные: EXAMPLES (кол-во примеров на раздел, по умолчанию 25).
 */

const AMO_PAGE_PAUSE_MS = 280;
const BATCH = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ID из packages/integrations/src/amo-crm.fields.ts.
const LEAD_FIELD = { CONTRACT_DATE: 558353, PRICE_DDU: 833065, CONTRACT_NUMBER: 558577, CONTRACT_TYPE: 617493 };
const PIPELINES = { 7600550: "ZORGE9", 7600546: "SILVER_BOR", 7600554: "TOLBUKHINA", 7600542: "KC" };
const STAGE_GROUP = {
  142: "SUCCESS", 143: "LOST",
  62907386: "PAYMENT_CONTROL", 62907458: "PAYMENT_CONTROL", 62907598: "PAYMENT_CONTROL",
  62907382: "DEAL_REGISTERED", 62907454: "DEAL_REGISTERED", 62907594: "DEAL_REGISTERED",
  62907378: "DEAL", 62907450: "DEAL", 62907590: "DEAL",
  62907374: "DEAL_PREP", 62907446: "DEAL_PREP", 62907586: "DEAL_PREP",
  62907370: "PAID_BOOKING", 62907442: "PAID_BOOKING", 62907582: "PAID_BOOKING",
};
// Стадии «сделка и дальше» для поиска лидов, которых нет в реестре.
const DEAL_STAGES_BY_PIPELINE = {
  7600550: [62907450, 62907454, 62907458, 142],
  7600546: [62907378, 62907382, 62907386, 142],
  7600554: [62907590, 62907594, 62907598, 142],
};

function cfValueById(entity, fieldId) {
  for (const f of entity?.custom_fields_values || []) {
    if (Number(f?.field_id) !== Number(fieldId)) continue;
    for (const v of f?.values || []) {
      const value = v?.value;
      if (value !== null && value !== undefined && String(value).trim() !== "") return String(value).trim();
    }
  }
  return null;
}

/** unix-секунды / ISO / «дд.мм.гггг» → YYYY-MM-DD (UTC-дата), иначе null. */
function toIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (/^\d{9,11}$/.test(s)) return new Date(Number(s) * 1000).toISOString().slice(0, 10);
  const ru = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

/** «12 345 678,50 руб» → 12345678.5; мусор → null. */
function toMoney(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s| /g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "." || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Та же нормализация, что в apply-registry-deal-links.js: латиница → кириллица,
// нижний регистр, без пробелов и «№».
const LAT_TO_CYR = { a: "а", b: "в", c: "с", e: "е", k: "к", m: "м", h: "н", o: "о", p: "р", x: "х", y: "у", t: "т" };
function contractKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[abcekmhopxyt]/g, (ch) => LAT_TO_CYR[ch] || ch)
    .replace(/[\s№]+/g, "");
}

function stageGroup(lead) {
  if (!lead) return "NO_LEAD";
  return STAGE_GROUP[Number(lead.status_id)] || "OTHER";
}

/** Сравнение одной строки реестра с лидом (чистая функция). */
function compareRow(row, lead) {
  const out = { issues: [] };
  if (!lead) { out.issues.push("lead_missing"); return out; }
  const amoDate = toIsoDate(cfValueById(lead, LEAD_FIELD.CONTRACT_DATE));
  const regDate = toIsoDate(row.signedAt);
  out.amoDate = amoDate; out.regDate = regDate;
  if (amoDate && regDate && amoDate !== regDate) out.issues.push("date_mismatch");
  else if (regDate && !amoDate) out.issues.push("date_missing_in_amo");
  else if (amoDate && !regDate) out.issues.push("date_missing_in_registry");

  const amoAmount = toMoney(cfValueById(lead, LEAD_FIELD.PRICE_DDU));
  const regAmount = row.amount === null || row.amount === undefined ? null : Number(row.amount);
  out.amoAmount = amoAmount; out.regAmount = regAmount;
  if (amoAmount !== null && regAmount !== null && Math.abs(amoAmount - regAmount) > 1) out.issues.push("amount_mismatch");
  else if (regAmount !== null && amoAmount === null) out.issues.push("amount_missing_in_amo");
  else if (amoAmount !== null && regAmount === null) out.issues.push("amount_missing_in_registry");

  const amoContract = cfValueById(lead, LEAD_FIELD.CONTRACT_NUMBER);
  out.amoContract = amoContract;
  if (amoContract && contractKey(amoContract) !== contractKey(row.contractNumber)) out.issues.push("contract_mismatch");
  else if (!amoContract) out.issues.push("contract_missing_in_amo");

  const amoProject = PIPELINES[Number(lead.pipeline_id)] || "OTHER_PIPELINE";
  out.amoProject = amoProject;
  if (row.project && amoProject !== "OTHER_PIPELINE" && amoProject !== "KC" && amoProject !== row.project) out.issues.push("project_mismatch");

  out.stage = stageGroup(lead);
  const paid = Boolean(row.paidAt);
  if (paid && out.stage === "LOST") out.issues.push("paid_but_amo_lost");
  if (!paid && out.stage === "SUCCESS") out.issues.push("unpaid_but_amo_success");
  return out;
}

async function fetchLeadsByIds(amo, ids) {
  const leads = new Map();
  let errors = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
    try {
      const res = await amo["request"](`/leads?${q}&limit=${BATCH}`);
      for (const lead of res?._embedded?.leads || []) leads.set(Number(lead.id), lead);
    } catch (e) {
      errors++;
      console.error(`Ошибка страницы лидов (${i}-${i + chunk.length}): ${e?.message || e}`);
    }
    await sleep(AMO_PAGE_PAUSE_MS);
  }
  return { leads, errors };
}

async function fetchDealStageLeads(amo) {
  const leads = [];
  for (const [pipelineId, statuses] of Object.entries(DEAL_STAGES_BY_PIPELINE)) {
    const filter = statuses.map((s, i) => `filter[statuses][${i}][pipeline_id]=${pipelineId}&filter[statuses][${i}][status_id]=${s}`).join("&");
    for (let page = 1; page <= 200; page++) {
      let res;
      try {
        res = await amo["request"](`/leads?${filter}&page=${page}&limit=${BATCH}`);
      } catch (e) {
        console.error(`Ошибка страницы стадий сделки (воронка ${pipelineId}, стр. ${page}): ${e?.message || e}`);
        break;
      }
      const list = res?._embedded?.leads || [];
      leads.push(...list);
      if (!res?._links?.next || list.length === 0) break;
      await sleep(AMO_PAGE_PAUSE_MS);
    }
  }
  return leads;
}

function fmt(v) { return v === null || v === undefined ? "—" : String(v); }

async function main() {
  const EXAMPLES = Math.max(0, Number(process.env.EXAMPLES || 25));
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const tokenRows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(tokenRows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || process.env.AMO_ACCESS_TOKEN || "", byKey.get("AMO_REFRESH_TOKEN") || process.env.AMO_REFRESH_TOKEN || "");
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "inspect-registry-vs-amo" }, create: { key, value, updatedBy: "inspect-registry-vs-amo" } });
      }
      console.error("amo tokens refreshed and persisted");
    });
    const amo = new AmoCrmAdapter();

    const rows = await prisma.registryDeal.findMany({
      select: { id: true, contractNumber: true, project: true, signedAt: true, paidAt: true, amount: true, amoLeadId: true, source: true, brokerId: true },
    });
    const total = rows.length;
    const withLead = rows.filter((r) => r.amoLeadId);
    const paidTotal = rows.filter((r) => r.paidAt).length;
    console.log("=== Реестр сделок ↔ amoCRM: отчёт расхождений (только чтение) ===\n");
    console.log(`Строк реестра: ${total}; с датой оплаты ДДУ: ${paidTotal}; без даты оплаты: ${total - paidTotal}`);
    console.log(`С лидом amo: ${withLead.length}; без лида amo: ${total - withLead.length}`);
    const byProj = {};
    for (const r of rows) {
      const k = r.project || "—";
      byProj[k] = byProj[k] || { rows: 0, paid: 0, noLead: 0 };
      byProj[k].rows++; if (r.paidAt) byProj[k].paid++; if (!r.amoLeadId) byProj[k].noLead++;
    }
    console.log(`По проектам: ${JSON.stringify(byProj)}`);

    const ids = [...new Set(withLead.map((r) => Number(r.amoLeadId)).filter((n) => Number.isSafeInteger(n) && n > 0))];
    const { leads, errors } = await fetchLeadsByIds(amo, ids);
    console.log(`Лидов запрошено: ${ids.length}; получено: ${leads.size}; ошибок страниц: ${errors}\n`);

    const counts = {}; const examples = {}; const stageMatrix = {};
    const add = (issue, line) => {
      counts[issue] = (counts[issue] || 0) + 1;
      examples[issue] = examples[issue] || [];
      if (examples[issue].length < EXAMPLES) examples[issue].push(line);
    };
    for (const row of withLead) {
      const lead = leads.get(Number(row.amoLeadId));
      const c = compareRow(row, lead);
      const key = `${row.paidAt ? "paid" : "unpaid"}/${c.stage || stageGroup(lead)}`;
      stageMatrix[key] = (stageMatrix[key] || 0) + 1;
      const base = `${fmt(row.contractNumber)} [${fmt(row.project)}] лид ${row.amoLeadId}`;
      for (const issue of c.issues) {
        let detail = "";
        if (issue.startsWith("date")) detail = `реестр ${fmt(c.regDate)} / amo ${fmt(c.amoDate)}`;
        else if (issue.startsWith("amount")) detail = `реестр ${fmt(c.regAmount)} / amo ${fmt(c.amoAmount)}`;
        else if (issue.startsWith("contract")) detail = `amo «${fmt(c.amoContract)}»`;
        else if (issue === "project_mismatch") detail = `воронка amo ${c.amoProject}`;
        else if (issue.includes("amo_")) detail = `стадия amo ${c.stage}`;
        add(issue, `${base}: ${detail}`);
      }
    }

    console.log("=== Расхождения по строкам реестра с лидом amo ===");
    const ORDER = ["date_mismatch", "amount_mismatch", "contract_mismatch", "project_mismatch", "unpaid_but_amo_success", "paid_but_amo_lost", "date_missing_in_amo", "amount_missing_in_amo", "contract_missing_in_amo", "date_missing_in_registry", "amount_missing_in_registry", "lead_missing"];
    const LABEL = {
      date_mismatch: "Дата ДДУ отличается (реестр ≠ amo)",
      amount_mismatch: "Стоимость ДДУ отличается более чем на 1 ₽",
      contract_mismatch: "№ договора отличается",
      project_mismatch: "Проект реестра ≠ воронка amo",
      unpaid_but_amo_success: "В реестре нет даты оплаты, а лид amo «Успешно»",
      paid_but_amo_lost: "В реестре есть оплата, а лид amo закрыт как нереализованный",
      date_missing_in_amo: "В amo нет даты договора",
      amount_missing_in_amo: "В amo нет стоимости в ДДУ",
      contract_missing_in_amo: "В amo нет № договора",
      date_missing_in_registry: "В реестре нет даты ДДУ, в amo есть",
      amount_missing_in_registry: "В реестре нет стоимости, в amo есть",
      lead_missing: "Лид по id не найден в amo",
    };
    for (const issue of ORDER) {
      if (!counts[issue]) continue;
      console.log(`\n${LABEL[issue]}: ${counts[issue]}`);
      for (const line of examples[issue]) console.log(`  ${line}`);
    }
    console.log("\n=== Оплата в реестре × стадия лида amo ===");
    for (const [k, v] of Object.entries(stageMatrix).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

    // Лиды amo на стадиях сделки, отсутствующие в реестре.
    const known = new Set(rows.map((r) => Number(r.amoLeadId)).filter(Boolean));
    const dealLeads = await fetchDealStageLeads(amo);
    const missing = dealLeads.filter((l) => !known.has(Number(l.id)));
    const missingByPipe = {};
    for (const l of missing) {
      const k = `${PIPELINES[Number(l.pipeline_id)] || l.pipeline_id}/${stageGroup(l)}`;
      missingByPipe[k] = (missingByPipe[k] || 0) + 1;
    }
    console.log(`\n=== Лиды amo на стадиях «Сделка … Успешно», которых нет в реестре ===`);
    console.log(`Всего лидов на стадиях сделки: ${dealLeads.length}; нет в реестре: ${missing.length}`);
    console.log(`  по воронке/стадии: ${JSON.stringify(missingByPipe)}`);
    for (const l of missing.slice(0, EXAMPLES)) {
      console.log(`  лид ${l.id} [${PIPELINES[Number(l.pipeline_id)] || l.pipeline_id}/${stageGroup(l)}] № ${fmt(cfValueById(l, LEAD_FIELD.CONTRACT_NUMBER))} дата ${fmt(toIsoDate(cfValueById(l, LEAD_FIELD.CONTRACT_DATE)))} сумма ${fmt(toMoney(cfValueById(l, LEAD_FIELD.PRICE_DDU)))}`);
    }

    console.log("\nRESULT: " + JSON.stringify({ total, paidTotal, withLead: withLead.length, leadsFetched: leads.size, counts, stageMatrix, dealStageLeads: dealLeads.length, dealLeadsMissingInRegistry: missing.length, missingByPipe }));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}

module.exports = { compareRow, toIsoDate, toMoney, contractKey, stageGroup, cfValueById };
