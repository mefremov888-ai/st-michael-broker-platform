#!/usr/bin/env node
/**
 * 2026-09-21: у каких наших брокеров в amoCRM больше одного контакта на один
 * телефон. Такие заявки виснут с BROKER_AMO_CONTACT_MISSING (случай Ледяевой).
 *
 * Как считаем: один раз выгружаем ВСЕ контакты amoCRM постранично (250 за
 * запрос, пауза 300 мс — в лимит не упираемся), строим карту «10 цифр
 * телефона → контакты», затем проходим по брокерам кабинета.
 * Только чтение. Телефоны в выводе маскируются.
 */
const SUBDOMAIN = process.env.AMO_SUBDOMAIN || "stmichael";
const BASE = process.env.AMO_BASE_DOMAIN || "amocrm.ru";
const TOKEN = process.env.AMO_ACCESS_TOKEN;
const API = `https://${SUBDOMAIN}.${BASE}/api/v4`;
const ten = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : null; };
const mask = (t) => (t ? `+7${t.slice(0, 3)}***${t.slice(-2)}` : "—");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllContacts() {
  const byPhone = new Map();
  let page = 1, total = 0;
  for (;;) {
    const r = await fetch(`${API}/contacts?limit=250&page=${page}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.status === 204) break;
    if (r.status === 429) { await sleep(2000); continue; }
    if (!r.ok) throw new Error(`amo ${r.status} на странице ${page}`);
    const j = await r.json();
    const list = (j._embedded && j._embedded.contacts) || [];
    if (!list.length) break;
    for (const c of list) {
      total++;
      const isBroker = (c.custom_fields_values || []).some((f) => /брокер/i.test(f.field_name || "") && f.values.some((v) => v.value === true || v.value === 1 || String(v.value) === "1"));
      const phones = new Set((c.custom_fields_values || []).filter((f) => f.field_code === "PHONE").flatMap((f) => f.values.map((v) => ten(v.value))).filter(Boolean));
      for (const p of phones) {
        if (!byPhone.has(p)) byPhone.set(p, []);
        byPhone.get(p).push({ id: c.id, name: c.name || "(без имени)", isBroker, updated: c.updated_at || 0 });
      }
    }
    page++;
    await sleep(300);
  }
  return { byPhone, total };
}

async function main() {
  if (!TOKEN) { console.error("AMO_ACCESS_TOKEN не установлен"); process.exit(2); }
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const t0 = Date.now();
    const { byPhone, total } = await fetchAllContacts();
    console.log(`Контактов в amoCRM: ${total}, телефонов с двумя и более контактами: ${[...byPhone.values()].filter((l) => l.length > 1).length} (за ${Math.round((Date.now() - t0) / 1000)} с)\n`);

    const brokers = await prisma.broker.findMany({
      where: { mergedIntoId: null },
      select: { id: true, fullName: true, phone: true, amoContactId: true, status: true, role: true },
    });
    const dup = [];
    let linkedOk = 0, noContact = 0, single = 0;
    for (const b of brokers) {
      const t = ten(b.phone);
      const list = t ? byPhone.get(t) : null;
      if (!list || !list.length) { noContact++; continue; }
      if (list.length === 1) { single++; continue; }
      dup.push({ b, t, list });
    }
    dup.sort((a, b) => (a.b.status === "ACTIVE" ? 0 : 1) - (b.b.status === "ACTIVE" ? 0 : 1) || b.list.length - a.list.length);

    console.log(`Брокеров в кабинете: ${brokers.length}`);
    console.log(`  контакт в amo ровно один: ${single}`);
    console.log(`  контакта в amo нет: ${noContact}`);
    console.log(`  контактов два и больше: ${dup.length}`);
    const active = dup.filter((d) => d.b.status === "ACTIVE");
    const unlinked = dup.filter((d) => !d.b.amoContactId);
    const linkedToOne = dup.filter((d) => d.b.amoContactId && d.list.some((c) => String(c.id) === String(d.b.amoContactId)));
    console.log(`    из них активных в кабинете: ${active.length}`);
    console.log(`    из них карточка НЕ привязана ни к одному контакту (виснут при фиксации): ${unlinked.length}`);
    console.log(`    из них привязаны к одному из дублей (работают, но дубль остаётся): ${linkedToOne.length}\n`);

    console.log("=== Список (сначала активные, потом по числу дублей) ===");
    for (const d of dup) {
      const link = d.b.amoContactId ? `привязана к ${d.b.amoContactId}` : "НЕ привязана";
      console.log(`- ${d.b.fullName} · ${mask(d.t)} · ${d.b.status} · ${link}`);
      for (const c of d.list.sort((x, y) => y.updated - x.updated)) {
        console.log(`    · ${c.id} · ${c.name}${c.isBroker ? " · брокер" : ""} · обновлён ${new Date(c.updated * 1000).toISOString().slice(0, 10)}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
