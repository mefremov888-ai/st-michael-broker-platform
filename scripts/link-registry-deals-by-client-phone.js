#!/usr/bin/env node
/**
 * 2026-09-08 (решение владельца: «сквозная аналитика — по всем базам»):
 * привязка строк «Реестра сделок» без брокера через ТЕЛЕФОН КЛИЕНТА.
 *
 * Цепочка: строка реестра → лид amo → контакт клиента → телефон(ы) клиента →
 * фиксации в нашей базе с этим телефоном (новый кабинет И перенос старого
 * кабинета) → брокер, который фиксировал клиента.
 *
 * Правила выбора брокера, если фиксаций несколько:
 *   - берём фиксации до даты оплаты ДДУ (или до даты ДДУ), ближайшую к сделке;
 *   - если все фиксации у одного брокера — он; если у разных — ближайшая
 *     принятая (CONDITIONALLY_UNIQUE/EXPIRED/FIXED) до сделки; отклонённые
 *     (REJECTED/UNDER_REVIEW) не считаются;
 *   - неоднозначность (две принятые фиксации разных брокеров в один день) —
 *     пропуск с отчётом.
 * Записываем brokerId (только пустые) и в комментарий строки ничего не
 * пишем — источник привязки фиксируется в аудите лога.
 * DRY_RUN=1 по умолчанию.
 *
 * Запуск в контейнере api (workflow apply-registry-broker-links-by-phone.yml).
 */

const AMO_PAGE_PAUSE_MS = 280;
const BATCH = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last10 = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
const ACCEPTED = new Set(["CONDITIONALLY_UNIQUE", "EXPIRED"]);

function contactPhones(contact) {
  const out = new Set();
  for (const f of contact?.custom_fields_values || []) {
    if (f?.field_code !== "PHONE") continue;
    for (const v of f?.values || []) { const p = last10(v?.value); if (p.length === 10) out.add(p); }
  }
  return [...out];
}

/** Выбор брокера по фиксациям клиента (чистая функция). */
function pickBroker(fixations, dealDate) {
  const accepted = fixations.filter((f) => ACCEPTED.has(f.uniquenessStatus) || f.fixationStatus === "FIXED");
  if (!accepted.length) return { brokerId: null, via: fixations.length ? "only-rejected" : "no-fixations" };
  const brokers = new Set(accepted.map((f) => f.brokerId));
  if (brokers.size === 1) return { brokerId: [...brokers][0], via: "single-broker" };
  const limit = dealDate ? new Date(dealDate).getTime() : Infinity;
  const before = accepted.filter((f) => new Date(f.createdAt).getTime() <= limit).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const pool = before.length ? before : accepted.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const best = pool[0];
  const sameDay = pool.filter((f) => new Date(f.createdAt).toISOString().slice(0, 10) === new Date(best.createdAt).toISOString().slice(0, 10) && f.brokerId !== best.brokerId);
  if (sameDay.length) return { brokerId: null, via: "ambiguous-same-day" };
  return { brokerId: best.brokerId, via: before.length ? "closest-before-deal" : "earliest" };
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
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "link-registry-deals-by-client-phone" }, create: { key, value, updatedBy: "link-registry-deals-by-client-phone" } });
      }
    });
    const amo = new AmoCrmAdapter();

    const rows = await prisma.registryDeal.findMany({ where: { brokerId: null, amoLeadId: { not: null } }, select: { id: true, contractNumber: true, amoLeadId: true, paidAt: true, signedAt: true } });
    console.log(`Строк реестра без брокера с лидом amo: ${rows.length} (оплаченных ${rows.filter((r) => r.paidAt).length})`);

    // Лиды с контактами.
    const leadIds = [...new Set(rows.map((r) => Number(r.amoLeadId)).filter((n) => n > 0))];
    const leadContacts = new Map(); // leadId -> [contactId]
    const contactIds = new Set();
    for (let i = 0; i < leadIds.length; i += BATCH) {
      const chunk = leadIds.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/leads?${q}&limit=${BATCH}&with=contacts`);
        for (const lead of res?._embedded?.leads || []) {
          const ids = (lead._embedded?.contacts || []).map((c) => Number(c.id));
          leadContacts.set(Number(lead.id), ids);
          ids.forEach((id) => contactIds.add(id));
        }
      } catch (e) { console.error(`Ошибка страницы лидов ${i}: ${e?.message || e}`); }
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    // Контакты → телефоны.
    const contactPhone = new Map();
    const cids = [...contactIds];
    for (let i = 0; i < cids.length; i += BATCH) {
      const chunk = cids.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/contacts?${q}&limit=${BATCH}`);
        for (const c of res?._embedded?.contacts || []) contactPhone.set(Number(c.id), contactPhones(c));
      } catch (e) { console.error(`Ошибка страницы контактов ${i}: ${e?.message || e}`); }
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    console.log(`Лидов с контактами: ${leadContacts.size}; контактов: ${contactPhone.size}`);

    // Телефоны брокеров — чтобы не принять контакт брокера за клиента.
    const brokerPhones = new Set();
    for (const b of await prisma.broker.findMany({ select: { phone: true, phones: { select: { phone: true } } } })) {
      for (const p of [b.phone, ...b.phones.map((x) => x.phone)]) { const d = last10(p); if (d.length === 10) brokerPhones.add(d); }
    }

    const stats = { linked: 0, noClientPhone: 0, noFixations: 0, onlyRejected: 0, ambiguous: 0, leadMissing: 0, byVia: {}, fromOldCabinet: 0, fromNewCabinet: 0 };
    const updates = [];
    const examples = [];
    for (const r of rows) {
      const ids = leadContacts.get(Number(r.amoLeadId));
      if (!ids) { stats.leadMissing++; continue; }
      const phones = [...new Set(ids.flatMap((id) => contactPhone.get(id) || []))].filter((p) => !brokerPhones.has(p));
      if (!phones.length) { stats.noClientPhone++; continue; }
      const variants = phones.flatMap((p) => [`+7${p}`, `8${p}`, `7${p}`, p]);
      const fixations = await prisma.client.findMany({
        where: { phone: { in: variants }, broker: { is: { role: "BROKER", mergedIntoId: null } } },
        select: { brokerId: true, createdAt: true, uniquenessStatus: true, fixationStatus: true, comment: true },
      });
      const pick = pickBroker(fixations, r.paidAt || r.signedAt);
      stats.byVia[pick.via] = (stats.byVia[pick.via] || 0) + 1;
      if (!pick.brokerId) { if (pick.via === "no-fixations") stats.noFixations++; else if (pick.via === "only-rejected") stats.onlyRejected++; else stats.ambiguous++; continue; }
      const src = fixations.find((f) => f.brokerId === pick.brokerId);
      if (String(src?.comment || "").startsWith("[old-cabinet:")) stats.fromOldCabinet++; else stats.fromNewCabinet++;
      stats.linked++;
      updates.push({ id: r.id, brokerId: pick.brokerId, via: pick.via, contract: r.contractNumber });
      if (examples.length < 15) examples.push(`${r.contractNumber} → ${pick.brokerId.slice(0, 8)}… (${pick.via})`);
    }
    console.log("\n=== Сводка ===");
    console.log(`К привязке по телефону клиента:     ${stats.linked} (источник фиксации: старый кабинет ${stats.fromOldCabinet}, новый ${stats.fromNewCabinet})`);
    console.log(`Нет телефона клиента у лида:        ${stats.noClientPhone}`);
    console.log(`Фиксаций с таким телефоном нет:     ${stats.noFixations}`);
    console.log(`Только отклонённые фиксации:        ${stats.onlyRejected}`);
    console.log(`Неоднозначно (разные брокеры):      ${stats.ambiguous}`);
    console.log(`Лид не найден:                      ${stats.leadMissing}`);
    console.log(`По способу: ${JSON.stringify(stats.byVia)}`);
    console.log(`Примеры: ${examples.join("; ")}`);
    console.log("RESULT: " + JSON.stringify({ rows: rows.length, ...stats, dryRun }));
    if (dryRun) { console.log("\nDRY-RUN: ничего не записано. Для записи DRY_RUN=0."); return; }
    console.log("AUDIT_BEGIN");
    for (const u of updates) console.log(JSON.stringify(u));
    console.log("AUDIT_END");
    let done = 0;
    for (const u of updates) { await prisma.registryDeal.update({ where: { id: u.id }, data: { brokerId: u.brokerId } }); done++; }
    console.log(`updated=${done}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}

module.exports = { pickBroker };
