#!/usr/bin/env node
/**
 * 2026-09-08 (владелец: «сквозная аналитика — брокер должен найтись где-то в
 * amo или в старом кабинете»): поиск брокера для ОПЛАЧЕННЫХ строк реестра без
 * брокера по всем доступным каналам. Только чтение, отчёт по каналам +
 * секции SECTION_B64 с найденными парами (для apply отдельным шагом).
 *
 * Каналы:
 *   A. Поля лида amo, в названии которых есть «брокер/агент/партнёр/риелтор»
 *      (значение → карточка брокера по ФИО или телефону).
 *   B. Примечания лида (notes): телефон в тексте → карточка брокера по телефону;
 *      «Брокер/Агент: ФИО» → карточка по ФИО.
 *   C. Теги лида (имя тега = ФИО брокера / агентство).
 *   D. Поля контакта КЛИЕНТА с «агент/брокер» в названии.
 *   E. Старый кабинет: фиксация с тем же ФИО клиента (точное совпадение
 *      нормализованного ФИО) до даты сделки → брокер фиксации.
 *   F. Агентство из Google (RegistryDeal.agencyCanonical): если у агентства в
 *      кабинете ровно один брокер с фиксациями/сделками — кандидат (слабый,
 *      только в отчёт).
 * Совпадение по ФИО: нормализованные «фамилия имя [отчество]», без учёта
 * порядка слов, минимум два общих слова; телефон — последние 10 цифр.
 */

const AMO_PAGE_PAUSE_MS = 280;
const BATCH = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last10 = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
const words = (v) => new Set(String(v || "").toLowerCase().replace(/ё/g, "е").split(/[^a-zа-я]+/i).filter((w) => w.length >= 3));
const emit = (name, rows) => { const b64 = Buffer.from(JSON.stringify(rows), "utf8").toString("base64"); const C = 60000; const n = Math.ceil(b64.length / C) || 1; for (let i = 0; i < n; i++) console.log(`SECTION_B64:${name}:${i + 1}/${n}:${b64.slice(i * C, (i + 1) * C)}`); };
const PHONE_RE = /(?:\+7|8|7)?[\s(]*9\d{2}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;

async function main() {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const tokenRows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(tokenRows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
    setAmoTokenRefreshHook(async (tokens) => { for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "inspect-registry-broker-channels" }, create: { key, value, updatedBy: "inspect-registry-broker-channels" } }); });
    const amo = new AmoCrmAdapter();

    // Брокеры кабинета: по телефону и по ФИО.
    const brokers = await prisma.broker.findMany({ where: { role: "BROKER", mergedIntoId: null }, select: { id: true, fullName: true, phone: true, amoContactId: true, phones: { select: { phone: true } }, brokerAgencies: { select: { agencyId: true } } } });
    const byPhone = new Map(); const byNameWords = [];
    for (const b of brokers) {
      for (const p of [b.phone, ...b.phones.map((x) => x.phone)]) { const d = last10(p); if (d.length === 10) { if (!byPhone.has(d)) byPhone.set(d, new Set()); byPhone.get(d).add(b.id); } }
      const w = words(b.fullName); if (w.size >= 2) byNameWords.push({ id: b.id, w, agencies: b.brokerAgencies.map((x) => x.agencyId) });
    }
    const nameMatch = (text, agencyId) => {
      const tw = words(text); if (tw.size < 2) return [];
      let hits = byNameWords.filter((b) => [...b.w].filter((x) => tw.has(x)).length >= 2);
      if (agencyId && hits.length > 1) { const inAg = hits.filter((h) => h.agencies.includes(agencyId)); if (inAg.length) hits = inAg; }
      return [...new Set(hits.map((h) => h.id))];
    };
    const phoneMatch = (text) => { const out = new Set(); for (const m of String(text || "").match(PHONE_RE) || []) { const d = last10(m); if (d.length === 10) for (const id of byPhone.get(d) || []) out.add(id); } return [...out]; };

    const rows = await prisma.registryDeal.findMany({ where: { brokerId: null, paidAt: { not: null } }, select: { id: true, contractNumber: true, amoLeadId: true, paidAt: true, agencyCanonical: true, agencyNameRaw: true, project: true } });
    console.log(`Оплаченных строк без брокера: ${rows.length}; с лидом amo: ${rows.filter((r) => r.amoLeadId).length}`);
    const agencies = await prisma.agency.findMany({ select: { id: true, name: true, legalName: true } });
    const { canonicalAgencyMatchKey } = require("./enrich-agencies-from-amo");
    const agencyByKey = new Map(); for (const a of agencies) for (const v of [a.name, a.legalName]) { const k = canonicalAgencyMatchKey(v); if (k && !agencyByKey.has(k)) agencyByKey.set(k, a.id); }
    const rowAgency = (r) => agencyByKey.get(canonicalAgencyMatchKey(r.agencyCanonical || r.agencyNameRaw || "")) || null;

    // A. Каталог полей лида.
    const leadFields = [];
    for (let page = 1; ; page++) { const res = await amo["request"](`/leads/custom_fields?page=${page}&limit=250`); const list = res?._embedded?.custom_fields || []; leadFields.push(...list); if (!res?._links?.next || !list.length) break; await sleep(AMO_PAGE_PAUSE_MS); }
    const agentLeadFields = leadFields.filter((f) => /брокер|агент|партн|риелт|realtor|broker|agent/i.test(String(f.name || "")));
    console.log(`Поля лида с «брокер/агент»: ${agentLeadFields.map((f) => `${f.id} «${f.name}»`).join("; ") || "нет"}`);
    const contactFields = [];
    for (let page = 1; ; page++) { const res = await amo["request"](`/contacts/custom_fields?page=${page}&limit=250`); const list = res?._embedded?.custom_fields || []; contactFields.push(...list); if (!res?._links?.next || !list.length) break; await sleep(AMO_PAGE_PAUSE_MS); }
    const agentContactFields = contactFields.filter((f) => /брокер|агент|партн|риелт|realtor|broker|agent/i.test(String(f.name || "")));
    console.log(`Поля контакта с «брокер/агент»: ${agentContactFields.map((f) => `${f.id} «${f.name}»`).join("; ") || "нет"}`);

    // Лиды (с контактами и тегами).
    const leadIds = [...new Set(rows.map((r) => Number(r.amoLeadId)).filter((n) => n > 0))];
    const leads = new Map(); const contactIds = new Set();
    for (let i = 0; i < leadIds.length; i += BATCH) {
      const q = leadIds.slice(i, i + BATCH).map((id) => `filter[id][]=${id}`).join("&");
      try { const res = await amo["request"](`/leads?${q}&limit=${BATCH}&with=contacts`); for (const l of res?._embedded?.leads || []) { leads.set(Number(l.id), l); for (const c of l._embedded?.contacts || []) contactIds.add(Number(c.id)); } } catch (e) { console.error(`leads page ${i}: ${e?.message || e}`); }
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    const contacts = new Map(); const cids = [...contactIds];
    for (let i = 0; i < cids.length; i += BATCH) {
      const q = cids.slice(i, i + BATCH).map((id) => `filter[id][]=${id}`).join("&");
      try { const res = await amo["request"](`/contacts?${q}&limit=${BATCH}`); for (const c of res?._embedded?.contacts || []) contacts.set(Number(c.id), c); } catch (e) { console.error(`contacts page ${i}: ${e?.message || e}`); }
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    // B. Примечания лидов.
    const notesByLead = new Map();
    for (let i = 0; i < leadIds.length; i += 50) {
      const q = leadIds.slice(i, i + 50).map((id) => `filter[entity_id][]=${id}`).join("&");
      for (let page = 1; page <= 10; page++) {
        let res; try { res = await amo["request"](`/leads/notes?${q}&limit=250&page=${page}`); } catch (e) { console.error(`notes ${i} p${page}: ${e?.message || e}`); break; }
        const list = res?._embedded?.notes || [];
        for (const n of list) { const t = n?.params?.text || n?.params?.html || ""; if (t) (notesByLead.get(Number(n.entity_id)) || notesByLead.set(Number(n.entity_id), []).get(Number(n.entity_id))).push(String(t)); }
        if (!res?._links?.next || !list.length) break;
        await sleep(AMO_PAGE_PAUSE_MS);
      }
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    console.log(`Лидов: ${leads.size}; контактов: ${contacts.size}; лидов с примечаниями: ${notesByLead.size}`);

    const cf = (e, id) => (e?.custom_fields_values || []).find((f) => Number(f.field_id) === Number(id))?.values?.map((v) => v.value).filter(Boolean).join(" ") || "";
    const found = []; const stats = { A: 0, B_phone: 0, B_name: 0, C: 0, D: 0, E: 0, F: 0, none: 0, multi: 0 };
    const clientNameIdx = new Map(); // для E — по ФИО клиента среди наших фиксаций
    for (const r of rows) {
      const lead = leads.get(Number(r.amoLeadId));
      const agencyId = rowAgency(r);
      const cands = new Map(); // brokerId -> channel
      const add = (ids, ch) => { for (const id of ids) if (!cands.has(id)) cands.set(id, ch); };
      if (lead) {
        for (const f of agentLeadFields) { const v = cf(lead, f.id); if (v) { add(phoneMatch(v), "A"); add(nameMatch(v, agencyId), "A"); } }
        for (const t of notesByLead.get(Number(lead.id)) || []) { const ph = phoneMatch(t); if (ph.length) add(ph, "B_phone"); const m = t.match(/(?:брокер|агент)[^:\n]{0,20}:\s*([^\n,;(]{5,60})/i); if (m) add(nameMatch(m[1], agencyId), "B_name"); }
        for (const tg of lead._embedded?.tags || []) add(nameMatch(tg.name, agencyId), "C");
        for (const c of lead._embedded?.contacts || []) { const ct = contacts.get(Number(c.id)); for (const f of agentContactFields) { const v = cf(ct, f.id); if (v) { add(phoneMatch(v), "D"); add(nameMatch(v, agencyId), "D"); } } }
        // E: ФИО клиента → наши фиксации с тем же ФИО до сделки.
        const clientName = (lead._embedded?.contacts || []).map((c) => contacts.get(Number(c.id))?.name).filter(Boolean)[0];
        if (clientName && words(clientName).size >= 2) {
          const key = [...words(clientName)].sort().join(" ");
          if (!clientNameIdx.has(key)) {
            const parts = [...words(clientName)];
            const cls = await prisma.client.findMany({ where: { AND: parts.slice(0, 2).map((w) => ({ fullName: { contains: w, mode: "insensitive" } })), broker: { is: { role: "BROKER", mergedIntoId: null } }, uniquenessStatus: { in: ["CONDITIONALLY_UNIQUE", "EXPIRED"] } }, select: { brokerId: true, createdAt: true, fullName: true }, take: 50 });
            clientNameIdx.set(key, cls.filter((c) => [...words(c.fullName)].filter((x) => words(clientName).has(x)).length >= 2));
          }
          const cls = clientNameIdx.get(key).filter((c) => new Date(c.createdAt) <= new Date(r.paidAt));
          const bs = [...new Set(cls.map((c) => c.brokerId))]; if (bs.length === 1) add(bs, "E");
        }
      }
      if (!cands.size && agencyId) {
        const ag = brokers.filter((b) => b.brokerAgencies.some((x) => x.agencyId === agencyId));
        if (ag.length === 1) add([ag[0].id], "F");
      }
      if (!cands.size) { stats.none++; continue; }
      if (cands.size > 1) { stats.multi++; }
      const [brokerId, ch] = [...cands.entries()][0];
      stats[ch] = (stats[ch] || 0) + 1;
      found.push({ id: r.id, contractNumber: r.contractNumber, project: r.project, amoLeadId: r.amoLeadId ? String(r.amoLeadId) : null, paidAt: r.paidAt.toISOString().slice(0, 10), brokerId, channel: ch, candidates: cands.size });
    }
    console.log("\n=== Найдено по каналам ===");
    console.log(`A поля лида: ${stats.A} | B примечания (телефон): ${stats.B_phone} | B примечания (ФИО): ${stats.B_name} | C теги: ${stats.C} | D поля контакта клиента: ${stats.D} | E старый/новый кабинет по ФИО клиента: ${stats.E} | F единственный брокер агентства: ${stats.F}`);
    console.log(`Не найдено: ${stats.none}; строк с несколькими кандидатами: ${stats.multi}`);
    console.log("RESULT: " + JSON.stringify({ rows: rows.length, ...stats, found: found.length }));
    emit("broker_channel_matches", found);
  } finally { await prisma.$disconnect(); }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
