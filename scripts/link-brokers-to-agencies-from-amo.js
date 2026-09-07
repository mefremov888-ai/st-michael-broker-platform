#!/usr/bin/env node
/**
 * 2026-09-07: привязка брокеров к агентствам по данным amoCRM (решение
 * владельца 07.09: «дозаполнить привязки брокер–агентство из компаний amo»).
 *
 * Кому: брокерам кабинета с amoContactId и БЕЗ единой связи broker_agencies.
 * Откуда агентство (по порядку попыток):
 *   1. поле контакта amo «ИНН» (834489) → карточка Agency по ИНН;
 *   2. компания, привязанная к контакту → её ИНН (поле компании «ИНН») →
 *      Agency по ИНН;
 *   3. название компании → Agency по нормализованному ключу названия
 *      (только если карточка одна);
 *   4. поле контакта «Агентство» (835417) → тот же ключ названия.
 * Новые карточки агентств НЕ создаются: если ничего не совпало — пропуск
 * со счётчиком. Создаётся одна связь, isPrimary = true.
 *
 * DRY_RUN=1 (по умолчанию) — отчёт и топ-20 примеров (без ПД брокеров).
 * DRY_RUN=0 — createMany(skipDuplicates).
 *
 * Запуск в контейнере api (workflow apply-broker-agency-links-amo.yml):
 *   DRY_RUN=1 node /app/scripts/link-brokers-to-agencies-from-amo.js
 */

const { canonicalAgencyMatchKey, isRealInn } = require("./enrich-agencies-from-amo");

const CONTACT_FIELD_INN = 834489;
const CONTACT_FIELD_AGENCY_NAME = 835417;
const AMO_PAGE_PAUSE_MS = 280;
const BATCH = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function cleanInn(value) {
  const d = String(value ?? "").replace(/\D/g, "");
  return isRealInn(d) ? d : null;
}

/** Индексы карточек агентств: по ИНН и по уникальному ключу названия. */
function buildAgencyIndex(agencies) {
  const byInn = new Map();
  const byKey = new Map();
  for (const a of agencies) {
    if (isRealInn(a.inn)) byInn.set(String(a.inn).trim(), a);
    for (const v of [a.name, a.legalName]) {
      const k = canonicalAgencyMatchKey(v);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k).add(a.id);
    }
  }
  const byId = new Map(agencies.map((a) => [a.id, a]));
  const uniqueByKey = (k) => {
    const ids = byKey.get(k);
    return ids && ids.size === 1 ? byId.get([...ids][0]) : null;
  };
  return { byInn, uniqueByKey };
}

/** Решение для одного контакта (чистая функция). */
function resolveAgency(contact, companies, index) {
  const contactInn = cleanInn(cfValueById(contact, CONTACT_FIELD_INN));
  if (contactInn && index.byInn.has(contactInn)) return { agency: index.byInn.get(contactInn), via: "contact-inn" };
  for (const c of companies) {
    const inn = cleanInn(c.inn);
    if (inn && index.byInn.has(inn)) return { agency: index.byInn.get(inn), via: "company-inn" };
  }
  for (const c of companies) {
    const k = canonicalAgencyMatchKey(c.name);
    const a = k ? index.uniqueByKey(k) : null;
    if (a) return { agency: a, via: "company-name" };
  }
  const agencyName = cfValueById(contact, CONTACT_FIELD_AGENCY_NAME);
  const k = canonicalAgencyMatchKey(agencyName);
  const a = k ? index.uniqueByKey(k) : null;
  if (a) return { agency: a, via: "contact-agency-name" };
  return { agency: null, via: contactInn || companies.length || agencyName ? "no-match" : "no-data" };
}

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  console.log(`=== Режим: ${dryRun ? "DRY-RUN (только отчёт)" : "APPLY (запись в БД!)"} ===\n`);
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const tokenRows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(tokenRows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || process.env.AMO_ACCESS_TOKEN || "", byKey.get("AMO_REFRESH_TOKEN") || process.env.AMO_REFRESH_TOKEN || "");
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "link-brokers-to-agencies-from-amo" }, create: { key, value, updatedBy: "link-brokers-to-agencies-from-amo" } });
      }
      console.error("amo tokens refreshed and persisted");
    });
    const amo = new AmoCrmAdapter();

    // 1. Брокеры без агентства, но с контактом amo.
    const brokers = await prisma.broker.findMany({
      where: { mergedIntoId: null, amoContactId: { not: null }, brokerAgencies: { none: {} } },
      select: { id: true, amoContactId: true },
    });
    console.log(`Брокеров с amo-контактом и без агентства: ${brokers.length}`);
    const agencies = await prisma.agency.findMany({ select: { id: true, name: true, legalName: true, inn: true } });
    const index = buildAgencyIndex(agencies);
    console.log(`Карточек агентств: ${agencies.length}`);

    // 2. Поле ИНН у компаний (по названию поля).
    const cfs = [];
    for (let page = 1; ; page++) {
      const res = await amo["request"](`/companies/custom_fields?page=${page}&limit=250`);
      const list = res?._embedded?.custom_fields || [];
      cfs.push(...list);
      if (!res?._links?.next || list.length === 0) break;
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    const innField = cfs.find((f) => /инн/i.test(String(f?.name || "")));
    console.log(`Поле ИНН компании: ${innField ? `id=${innField.id}` : "не найдено"}`);

    // 3. Контакты пачками (с привязанными компаниями).
    const contactIds = brokers.map((b) => Number(b.amoContactId)).filter((n) => Number.isSafeInteger(n) && n > 0);
    const contacts = new Map();
    const companyIds = new Set();
    for (let i = 0; i < contactIds.length; i += BATCH) {
      const chunk = contactIds.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/contacts?${q}&limit=${BATCH}&with=companies`);
        for (const c of res?._embedded?.contacts || []) {
          contacts.set(Number(c.id), c);
          for (const comp of c?._embedded?.companies || []) companyIds.add(Number(comp.id));
        }
      } catch (e) {
        console.error(`Ошибка страницы контактов ${i}: ${e?.message || e}`);
      }
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    console.log(`Контактов получено: ${contacts.size}; компаний к загрузке: ${companyIds.size}`);

    // 4. Компании пачками.
    const companies = new Map();
    const compList = [...companyIds];
    for (let i = 0; i < compList.length; i += BATCH) {
      const chunk = compList.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/companies?${q}&limit=${BATCH}`);
        for (const c of res?._embedded?.companies || []) {
          companies.set(Number(c.id), { id: c.id, name: String(c.name || "").trim(), inn: innField ? cfValueById(c, innField.id) : null });
        }
      } catch (e) {
        console.error(`Ошибка страницы компаний ${i}: ${e?.message || e}`);
      }
      await sleep(AMO_PAGE_PAUSE_MS);
    }

    // 5. План.
    const stats = { contactMissing: 0, noData: 0, noMatch: 0, byVia: {} };
    const links = [];
    const examples = [];
    for (const b of brokers) {
      const contact = contacts.get(Number(b.amoContactId));
      if (!contact) { stats.contactMissing++; continue; }
      const comps = (contact?._embedded?.companies || []).map((c) => companies.get(Number(c.id))).filter(Boolean);
      const r = resolveAgency(contact, comps, index);
      if (!r.agency) { if (r.via === "no-data") stats.noData++; else stats.noMatch++; continue; }
      stats.byVia[r.via] = (stats.byVia[r.via] || 0) + 1;
      links.push({ brokerId: b.id, agencyId: r.agency.id, isPrimary: true });
      if (examples.length < 20) examples.push(`${r.agency.name} [${r.via}]`);
    }
    console.log("\n=== Сводка ===");
    console.log(`Связей к созданию:                 ${links.length}`);
    console.log(`  по источнику:                    ${JSON.stringify(stats.byVia)}`);
    console.log(`Контакт не найден в amo:           ${stats.contactMissing}`);
    console.log(`Нет данных об агентстве в amo:     ${stats.noData}`);
    console.log(`Данные есть, карточка не найдена:  ${stats.noMatch}`);
    console.log(`Примеры (агентство [источник]): ${examples.join("; ")}`);
    if (dryRun) { console.log("\nDRY-RUN: ничего не записано. Для записи DRY_RUN=0."); return; }
    let created = 0;
    for (let i = 0; i < links.length; i += 500) {
      const res = await prisma.brokerAgency.createMany({ data: links.slice(i, i + 500), skipDuplicates: true });
      created += res.count;
    }
    console.log(`\ncreated=${created}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}

module.exports = { resolveAgency, buildAgencyIndex, cleanInn };
