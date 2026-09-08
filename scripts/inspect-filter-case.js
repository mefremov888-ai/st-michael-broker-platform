#!/usr/bin/env node
/**
 * 2026-09-08: владелец — «фильтр «Статус брокера: Фиксирующий» + «Источник:
 * старый кабинет» показывает карточки с 0 фиксаций». Повторяем запрос
 * страницы к API (как qa-loyalty-filters: admin JWT) и печатаем total и
 * первые строки (статусы, фиксации). Только чтение. Вход: FILTER_JSON
 * (canonical filter), COLUMNS_JSON, ENTITY (brokers|agencies), BASE.
 */
const crypto = require("node:crypto");
const API_BASE = process.env.API_BASE || `http://localhost:${process.env.API_PORT || 4000}/api`;
const b64url = (i) => Buffer.from(i).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function signJwt(payload, secret) { const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })); const b = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 })); const d = `${h}.${b}`; return `${d}.${b64url(crypto.createHmac("sha256", secret).update(d).digest())}`; }
async function main() {
  const secret = process.env.JWT_SECRET; if (!secret) throw new Error("JWT_SECRET отсутствует");
  const { PrismaClient } = require("@st-michael/database"); const prisma = new PrismaClient();
  try {
    const admin = await prisma.broker.findFirst({ where: { role: "ADMIN" }, select: { id: true, phone: true }, orderBy: { createdAt: "asc" } });
    const token = signJwt({ sub: admin.id, phone: admin.phone, role: "ADMIN" }, secret);
    const base = process.env.BASE || "ours"; const entity = process.env.ENTITY || "brokers";
    const cases = JSON.parse(process.env.CASES_JSON || "[]");
    for (const c of cases) {
      const body = { page: 1, pageSize: 5, archived: "exclude", sortBy: "name", sortOrder: "asc", search: "", filter: c.filter || {}, columns: c.columns || {}, ...(c.segment ? { segment: c.segment } : {}) };
      const res = await fetch(`${API_BASE}/loyalty-base/${base}/${entity}/search`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
      console.log(`\n=== ${c.name} → HTTP ${res.status}, total=${json?.total} ===`);
      if (!json?.items) { console.log(text.slice(0, 300)); continue; }
      for (const it of json.items) console.log(`  • ${String(it.displayName || "").slice(0, 28).padEnd(28)} | statuses=${JSON.stringify(it.computedStatuses)} | stage=${it.normalizedStage} | fix=${it.metrics?.fixations} meet=${it.metrics?.meetings} deals=${it.metrics?.deals} | period=${it.periodMetrics?.availability}`);
    }
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
