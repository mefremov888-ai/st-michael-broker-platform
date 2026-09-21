#!/usr/bin/env node
/**
 * 2026-09-21: заявки, которые ждут контакт брокера в amoCRM
 * (BROKER_AMO_CONTACT_MISSING). Для каждой — кто ответственный, есть ли у
 * его карточки контакт amo, и есть ли в amoCRM контакт с его телефоном.
 * Только чтение: база + GET в amoCRM. Телефоны печатаются маской.
 */
const SUBDOMAIN = process.env.AMO_SUBDOMAIN || "stmichael";
const BASE = process.env.AMO_BASE_DOMAIN || "amocrm.ru";
const TOKEN = process.env.AMO_ACCESS_TOKEN;
const API = `https://${SUBDOMAIN}.${BASE}/api/v4`;
const mask = (p) => (p ? `${String(p).slice(0, 6)}***${String(p).slice(-2)}` : "—");
const ten = (p) => String(p || "").replace(/\D/g, "").slice(-10);

async function amoSearch(phone) {
  const q = ten(phone);
  if (!q || !TOKEN) return { error: "нет телефона или токена" };
  const r = await fetch(`${API}/contacts?query=${encodeURIComponent(q)}&limit=10`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (r.status === 204) return { found: [] };
  if (!r.ok) return { error: `${r.status}` };
  const j = await r.json();
  const list = (j._embedded && j._embedded.contacts) || [];
  return {
    found: list.map((c) => {
      const phones = (c.custom_fields_values || []).filter((f) => f.field_code === "PHONE").flatMap((f) => f.values.map((v) => ten(v.value)));
      const isBroker = (c.custom_fields_values || []).some((f) => /брокер/i.test(f.field_name || "") && f.values.some((v) => v.value === true || v.value === 1 || String(v.value) === "1"));
      return { id: c.id, name: c.name, exactPhone: phones.includes(q), isBroker };
    }),
  };
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.client.findMany({
      where: { amoSyncStatus: { in: ["FAILED", "PENDING"] }, amoSyncError: { startsWith: "BROKER_AMO_CONTACT_MISSING" } },
      select: {
        id: true, fullName: true, createdAt: true, amoSyncAttempts: true,
        broker: { select: { id: true, fullName: true, phone: true, amoContactId: true } },
        responsibleBroker: { select: { id: true, fullName: true, phone: true, amoContactId: true, status: true, createdAt: true } },
      },
    });
    console.log(`Заявок, ждущих контакт брокера: ${rows.length}\n`);
    for (const c of rows) {
      const rb = c.responsibleBroker || c.broker;
      console.log(`--- клиент ${c.fullName} · заявка от ${c.createdAt.toISOString().slice(0, 10)} · попыток ${c.amoSyncAttempts}`);
      console.log(`    подал: ${c.broker.fullName} · контакт amo ${c.broker.amoContactId || "НЕТ"}`);
      console.log(`    ответственный: ${rb.fullName} · ${mask(rb.phone)} · статус ${rb.status} · карточка с ${rb.createdAt.toISOString().slice(0, 10)} · контакт amo в карточке: ${rb.amoContactId || "НЕТ"}`);
      const s = await amoSearch(rb.phone);
      if (s.error) { console.log(`    поиск в amoCRM: ошибка ${s.error}`); continue; }
      if (!s.found.length) { console.log("    поиск в amoCRM по телефону: контакта НЕТ — нужно создавать"); continue; }
      console.log(`    поиск в amoCRM по телефону: найдено ${s.found.length}`);
      for (const f of s.found) console.log(`      · id ${f.id} · ${f.name} · телефон совпал точно: ${f.exactPhone ? "да" : "нет"} · помечен брокером: ${f.isBroker ? "да" : "нет"}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
