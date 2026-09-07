#!/usr/bin/env node
/**
 * 2026-09-07: привязка строк «Реестра сделок» к брокерам кабинета через
 * контакты лида amoCRM. Сейчас из 1 425 оплаченных договоров к брокеру
 * привязаны только ~175 — сделки не видны в карточках брокеров «Нашей базы».
 *
 * Правило (только пустые brokerId, только строки с лидом amo):
 *   1. У лида берём все привязанные контакты (GET /leads?with=contacts).
 *   2. Контакт → карточка брокера по Broker.amoContactId (слитые карточки
 *      → их основная). Если ровно одна карточка брокера — привязываем.
 *   3. Если брокеров-контактов несколько или ноль — пропуск со счётчиком
 *      (в отчёт), ничего не угадываем.
 * Дополнительно считаем, у скольких пропущенных заполнено поле лида «Агент»
 * (835417) — кандидат на следующий канал (по ФИО), без записи.
 *
 * DRY_RUN=1 (по умолчанию) — отчёт; DRY_RUN=0 — update brokerId по одной
 * строке + запись в RegistryDeal.brokerAmoContactId (если пусто).
 *
 * Запуск в контейнере api (workflow apply-registry-broker-links.yml):
 *   DRY_RUN=1 node /app/scripts/link-registry-deals-to-brokers.js
 */

const AMO_PAGE_PAUSE_MS = 280;
const BATCH = 250;
const LEAD_FIELD_AGENT = 835417;
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

/** Решение по одной строке (чистая функция): contactIds → brokerId | null + причина. */
function resolveBroker(contactIds, brokerByContact) {
  const ids = new Set();
  for (const cid of contactIds) {
    const b = brokerByContact.get(String(cid));
    if (b) ids.add(b);
  }
  if (ids.size === 1) return { brokerId: [...ids][0], via: "lead-contact" };
  if (ids.size > 1) return { brokerId: null, via: "ambiguous" };
  return { brokerId: null, via: contactIds.length ? "no-broker-contact" : "no-contacts" };
}

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  console.log(`=== Режим: ${dryRun ? "DRY-RUN (только отчёт)" : "APPLY (запись brokerId!)"} ===\n`);
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const tokenRows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(tokenRows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "link-registry-deals-to-brokers" }, create: { key, value, updatedBy: "link-registry-deals-to-brokers" } });
      }
      console.error("amo tokens refreshed and persisted");
    });
    const amo = new AmoCrmAdapter();

    // Брокеры: amoContactId → id действующей карточки (слитые → основная).
    const brokers = await prisma.broker.findMany({
      where: { role: "BROKER", amoContactId: { not: null } },
      select: { id: true, amoContactId: true, mergedIntoId: true },
    });
    const brokerByContact = new Map();
    for (const b of brokers) brokerByContact.set(String(b.amoContactId), b.mergedIntoId || b.id);
    console.log(`Карточек брокеров с amo-контактом: ${brokers.length}`);

    const rows = await prisma.registryDeal.findMany({
      where: { brokerId: null, amoLeadId: { not: null } },
      select: { id: true, contractNumber: true, amoLeadId: true, paidAt: true, brokerAmoContactId: true },
    });
    const paidRows = rows.filter((r) => r.paidAt);
    console.log(`Строк реестра без брокера с лидом amo: ${rows.length} (из них оплаченных: ${paidRows.length})`);

    const leadIds = [...new Set(rows.map((r) => Number(r.amoLeadId)).filter((n) => Number.isSafeInteger(n) && n > 0))];
    const leads = new Map();
    let errors = 0;
    for (let i = 0; i < leadIds.length; i += BATCH) {
      const chunk = leadIds.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/leads?${q}&limit=${BATCH}&with=contacts`);
        for (const lead of res?._embedded?.leads || []) leads.set(Number(lead.id), lead);
      } catch (e) {
        errors++;
        console.error(`Ошибка страницы лидов (${i}-${i + chunk.length}): ${e?.message || e}`);
      }
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    console.log(`Лидов получено: ${leads.size}; ошибок страниц: ${errors}`);

    const stats = { linked: 0, ambiguous: 0, noBrokerContact: 0, noContacts: 0, leadMissing: 0, agentFieldFilled: 0 };
    const updates = [];
    const examples = [];
    for (const r of rows) {
      const lead = leads.get(Number(r.amoLeadId));
      if (!lead) { stats.leadMissing++; continue; }
      const contactIds = (lead._embedded?.contacts || []).map((c) => c.id);
      const res = resolveBroker(contactIds, brokerByContact);
      if (res.brokerId) {
        stats.linked++;
        const brokerContact = contactIds.find((cid) => brokerByContact.get(String(cid)) === res.brokerId);
        updates.push({ id: r.id, brokerId: res.brokerId, brokerAmoContactId: r.brokerAmoContactId ? null : brokerContact });
        if (examples.length < 15) examples.push(`${r.contractNumber} → брокер ${res.brokerId.slice(0, 8)}… (контакт ${brokerContact})`);
      } else {
        if (res.via === "ambiguous") stats.ambiguous++;
        else if (res.via === "no-broker-contact") stats.noBrokerContact++;
        else stats.noContacts++;
        if (cfValueById(lead, LEAD_FIELD_AGENT)) stats.agentFieldFilled++;
      }
    }
    console.log("\n=== Сводка ===");
    console.log(`К привязке (ровно один брокер-контакт у лида): ${stats.linked}`);
    console.log(`Несколько брокеров-контактов (пропуск):        ${stats.ambiguous}`);
    console.log(`Контакты есть, но ни один не брокер кабинета:  ${stats.noBrokerContact}`);
    console.log(`У лида нет контактов:                          ${stats.noContacts}`);
    console.log(`Лид не найден в amo:                           ${stats.leadMissing}`);
    console.log(`Из пропущенных — заполнено поле «Агент» (ФИО): ${stats.agentFieldFilled}`);
    console.log(`Примеры: ${examples.join("; ")}`);
    console.log("RESULT: " + JSON.stringify({ rows: rows.length, paidRows: paidRows.length, ...stats, dryRun }));
    if (dryRun) { console.log("\nDRY-RUN: ничего не записано. Для записи DRY_RUN=0."); return; }
    let done = 0;
    for (const u of updates) {
      const data = { brokerId: u.brokerId };
      if (u.brokerAmoContactId) data.brokerAmoContactId = BigInt(u.brokerAmoContactId);
      await prisma.registryDeal.update({ where: { id: u.id }, data });
      done++;
      if (done % 200 === 0) console.log(`— записано ${done}/${updates.length} —`);
    }
    console.log(`\nupdated=${done}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}

module.exports = { resolveBroker };
