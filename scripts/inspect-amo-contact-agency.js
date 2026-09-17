#!/usr/bin/env node
/**
 * 2026-09-17: читаем карточку контакта в amoCRM и показываем, какая у него
 * компания и что стоит в полях — чтобы понять агентство брокера, у которого
 * в кабинете агентство не проставлено (из-за этого заявка стоит на удержании
 * MANUAL_HOLD_AGENCY_UNKNOWN).
 *
 * Только чтение (GET). Контакты задаются через AMO_CONTACT_IDS, по умолчанию
 * разбираем контакт брокера «Субоч Евгений».
 */
const SUBDOMAIN = process.env.AMO_SUBDOMAIN || "stmichael";
const BASE = process.env.AMO_BASE_DOMAIN || "amocrm.ru";
const TOKEN = process.env.AMO_ACCESS_TOKEN;
const IDS = (process.env.AMO_CONTACT_IDS || "47033237")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error("AMO_ACCESS_TOKEN не установлен");
  process.exit(2);
}
const API = `https://${SUBDOMAIN}.${BASE}/api/v4`;

async function get(path) {
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} на ${path}`);
  return r.json();
}

async function main() {
  for (const id of IDS) {
    console.log(`=== Контакт amo ${id} ===`);
    let c;
    try {
      c = await get(`/contacts/${id}?with=leads`);
    } catch (e) {
      console.log(`  не прочитался: ${e.message}`);
      continue;
    }
    console.log(`  имя: ${c.name}`);
    console.log(`  ответственный (user_id): ${c.responsible_user_id}`);
    const company = c._embedded && c._embedded.companies && c._embedded.companies[0];
    if (company) {
      const full = await get(`/companies/${company.id}`).catch(() => null);
      console.log(`  компания: ${full ? full.name : company.id} (id ${company.id})`);
    } else {
      console.log("  компания: не привязана");
    }
    const fields = c.custom_fields_values || [];
    console.log(`  поля (${fields.length}):`);
    for (const f of fields) {
      const vals = (f.values || []).map((v) => v.value).filter((v) => v !== null && v !== undefined);
      if (!vals.length) continue;
      const shown = /телефон|phone|почта|email/i.test(f.field_name || "")
        ? vals.map((v) => String(v).slice(0, 6) + "***").join(", ")
        : vals.join(", ");
      console.log(`    ${f.field_name}: ${shown}`);
    }
    const leads = (c._embedded && c._embedded.leads) || [];
    console.log(`  сделок привязано: ${leads.length}`);
    console.log("");
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
