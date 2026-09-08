#!/usr/bin/env node
/**
 * 2026-09-08 (решение владельца): завести карточки брокеров по amo-контактам
 * из строк «Реестра сделок» (brokerAmoContactId), у которых нет карточки в
 * кабинете, и разнести по ним договоры — чтобы у брокера в «Нашей базе» были
 * видны его сделки (сопоставление по телефону, как обсуждали).
 *
 * Правила:
 *   1. Контакт amo → телефоны. Если карточка брокера с таким телефоном уже
 *      есть (brokers.phone / broker_phones) — используем её (amoContactId
 *      дописываем, если пусто; если там другой контакт — пропуск с отчётом).
 *   2. Иначе создаём карточку: fullName из amo, phone (+7…), role BROKER,
 *      status PENDING (без аккаунта), isInBase, baseSource amocrm,
 *      amoContactId; остальные телефоны контакта — в broker_phones.
 *   3. Агентство — как в link-brokers-to-agencies-from-amo (ИНН контакта →
 *      ИНН/название компании → поле «Агентство»), только если карточка
 *      агентства одна; связь isPrimary.
 *   4. Строки реестра с этим brokerAmoContactId и пустым brokerId → brokerId.
 * Контакт без телефона — пропуск (телефон обязателен и уникален).
 * DRY_RUN=1 по умолчанию (отчёт без ПД: имена и телефоны маскируются).
 *
 * Запуск в контейнере api (workflow apply-registry-brokers-from-amo.yml).
 */

const { resolveAgency, buildAgencyIndex } = require("./link-brokers-to-agencies-from-amo");

const AMO_PAGE_PAUSE_MS = 280;
const BATCH = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };
const maskName = (n) => String(n || "").split(/\s+/).map((w, i) => (i === 0 ? w : w.slice(0, 1) + ".")).join(" ");

/** Как admin/brokers-import.helper normalizePhone: → "+7XXXXXXXXXX" или null. */
function normalizePhone(input) {
  const digits = String(input ?? "").replace(/\D/g, "");
  const n = digits.length;
  if (n < 10) return null;
  if (n === 10) return "+7" + digits;
  if (n === 11) {
    if (digits[0] === "7" && digits[1] === "7") return null;
    if (digits[0] === "7") return "+" + digits;
    if (digits[0] === "8") return "+7" + digits.slice(1);
    return "+" + digits;
  }
  if (n === 12 && digits.startsWith("77")) return "+" + digits.slice(1);
  return "+" + digits;
}
function contactPhones(contact) {
  const out = [];
  for (const f of contact?.custom_fields_values || []) {
    if (f?.field_code !== "PHONE") continue;
    for (const v of f?.values || []) { const p = normalizePhone(v?.value); if (p && !out.includes(p)) out.push(p); }
  }
  return out;
}
function cfValueById(entity, fieldId) {
  for (const f of entity?.custom_fields_values || []) {
    if (Number(f?.field_id) !== Number(fieldId)) continue;
    for (const v of f?.values || []) { const value = v?.value; if (value !== null && value !== undefined && String(value).trim() !== "") return String(value).trim(); }
  }
  return null;
}

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  console.log(`=== Режим: ${dryRun ? "DRY-RUN (только отчёт)" : "APPLY (создание карточек и привязка!)"} ===\n`);
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const tokenRows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(tokenRows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "create-brokers-from-registry-contacts" }, create: { key, value, updatedBy: "create-brokers-from-registry-contacts" } });
      }
    });
    const amo = new AmoCrmAdapter();

    // 1. Контакты из строк реестра без брокера.
    const rows = await prisma.registryDeal.findMany({ where: { brokerId: null, brokerAmoContactId: { not: null } }, select: { id: true, brokerAmoContactId: true, paidAt: true } });
    const contactIds = [...new Set(rows.map((r) => String(r.brokerAmoContactId)))];
    console.log(`Строк реестра без брокера с amo-контактом брокера: ${rows.length} (оплаченных ${rows.filter((r) => r.paidAt).length}); уникальных контактов: ${contactIds.length}`);

    // Уже существующие карточки по amoContactId.
    const existingByContact = new Map((await prisma.broker.findMany({ where: { amoContactId: { in: contactIds.map((c) => BigInt(c)) } }, select: { id: true, amoContactId: true, mergedIntoId: true } })).map((b) => [String(b.amoContactId), b.mergedIntoId || b.id]));

    // 2. Контакты из amo (с компаниями).
    const contacts = new Map();
    const companyIds = new Set();
    for (let i = 0; i < contactIds.length; i += BATCH) {
      const chunk = contactIds.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/contacts?${q}&limit=${BATCH}&with=companies`);
        for (const c of res?._embedded?.contacts || []) { contacts.set(String(c.id), c); for (const comp of c?._embedded?.companies || []) companyIds.add(Number(comp.id)); }
      } catch (e) { console.error(`Ошибка страницы контактов ${i}: ${e?.message || e}`); }
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    console.log(`Контактов получено из amo: ${contacts.size}; компаний к загрузке: ${companyIds.size}`);
    // Поле ИНН компании + компании.
    const cfs = [];
    for (let page = 1; ; page++) {
      const res = await amo["request"](`/companies/custom_fields?page=${page}&limit=250`);
      const list = res?._embedded?.custom_fields || [];
      cfs.push(...list);
      if (!res?._links?.next || list.length === 0) break;
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    const innField = cfs.find((f) => /инн/i.test(String(f?.name || "")));
    const companies = new Map();
    const compList = [...companyIds];
    for (let i = 0; i < compList.length; i += BATCH) {
      const chunk = compList.slice(i, i + BATCH);
      const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/companies?${q}&limit=${BATCH}`);
        for (const c of res?._embedded?.companies || []) companies.set(Number(c.id), { id: c.id, name: String(c.name || "").trim(), inn: innField ? cfValueById(c, innField.id) : null });
      } catch (e) { console.error(`Ошибка страницы компаний ${i}: ${e?.message || e}`); }
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    const agencyIndex = buildAgencyIndex(await prisma.agency.findMany({ select: { id: true, name: true, legalName: true, inn: true } }));

    // 3. План по контактам.
    const plan = [];
    const stats = { alreadyCard: 0, contactMissing: 0, noPhone: 0, matchedByPhone: 0, phoneHasOtherContact: 0, toCreate: 0, withAgency: 0 };
    const examples = [];
    for (const cid of contactIds) {
      if (existingByContact.has(cid)) { stats.alreadyCard++; plan.push({ cid, brokerId: existingByContact.get(cid), action: "existing" }); continue; }
      const c = contacts.get(cid);
      if (!c) { stats.contactMissing++; continue; }
      const phones = contactPhones(c);
      if (!phones.length) { stats.noPhone++; continue; }
      const found = await prisma.broker.findFirst({ where: { OR: [{ phone: { in: phones } }, { phones: { some: { phone: { in: phones } } } }] }, select: { id: true, amoContactId: true, mergedIntoId: true, fullName: true } });
      const comps = (c?._embedded?.companies || []).map((x) => companies.get(Number(x.id))).filter(Boolean);
      const agency = resolveAgency(c, comps, agencyIndex).agency || null;
      if (found) {
        if (found.amoContactId && String(found.amoContactId) !== cid) { stats.phoneHasOtherContact++; continue; }
        stats.matchedByPhone++;
        plan.push({ cid, brokerId: found.mergedIntoId || found.id, action: "match-phone", setContact: !found.amoContactId, agencyId: agency?.id || null });
        continue;
      }
      stats.toCreate++;
      if (agency) stats.withAgency++;
      plan.push({ cid, action: "create", fullName: String(c.name || "").trim() || `Брокер amo ${cid}`, phone: phones[0], extraPhones: phones.slice(1), agencyId: agency?.id || null, agencyName: agency?.name || null });
      if (examples.length < 15) examples.push(`${maskName(c.name)} ${mask(phones[0])}${agency ? ` → ${agency.name}` : ""}`);
    }
    const rowsAttachable = rows.filter((r) => plan.some((p) => p.cid === String(r.brokerAmoContactId) && (p.brokerId || p.action === "create"))).length;
    console.log("\n=== Сводка ===");
    console.log(`Карточка уже есть (по amoContactId):        ${stats.alreadyCard}`);
    console.log(`Найдена карточка по телефону:               ${stats.matchedByPhone}`);
    console.log(`Телефон занят карточкой с другим контактом: ${stats.phoneHasOtherContact} (пропуск)`);
    console.log(`Контакт не найден в amo:                    ${stats.contactMissing}`);
    console.log(`У контакта нет телефона:                    ${stats.noPhone} (пропуск)`);
    console.log(`К созданию карточек:                        ${stats.toCreate} (с агентством ${stats.withAgency})`);
    console.log(`Строк реестра, которые получат брокера:     ${rowsAttachable} из ${rows.length}`);
    console.log(`Примеры: ${examples.join("; ")}`);
    console.log("RESULT: " + JSON.stringify({ rows: rows.length, contacts: contactIds.length, ...stats, rowsAttachable, dryRun }));
    if (dryRun) { console.log("\nDRY-RUN: ничего не записано. Для записи DRY_RUN=0."); return; }

    // 4. APPLY.
    let created = 0, linkedRows = 0, agencyLinks = 0, contactSet = 0;
    for (const p of plan) {
      let brokerId = p.brokerId;
      if (p.action === "create") {
        const b = await prisma.broker.create({ data: { fullName: p.fullName, phone: p.phone, role: "BROKER", status: "PENDING", isInBase: true, baseSource: "amocrm", amoContactId: BigInt(p.cid) } });
        brokerId = b.id; created++;
        if (p.extraPhones.length) await prisma.brokerPhone.createMany({ data: p.extraPhones.map((ph) => ({ brokerId, phone: ph })), skipDuplicates: true });
      } else if (p.action === "match-phone" && p.setContact) {
        await prisma.broker.update({ where: { id: brokerId }, data: { amoContactId: BigInt(p.cid) } }); contactSet++;
      }
      if (p.agencyId && brokerId) {
        const has = await prisma.brokerAgency.findFirst({ where: { brokerId }, select: { id: true } });
        if (!has) { await prisma.brokerAgency.create({ data: { brokerId, agencyId: p.agencyId, isPrimary: true } }); agencyLinks++; }
      }
      if (brokerId) {
        const res = await prisma.registryDeal.updateMany({ where: { brokerId: null, brokerAmoContactId: BigInt(p.cid) }, data: { brokerId } });
        linkedRows += res.count;
      }
    }
    console.log(`\ncreated=${created} amoContactSet=${contactSet} agencyLinks=${agencyLinks} registryRowsLinked=${linkedRows}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}

module.exports = { normalizePhone, contactPhones };
