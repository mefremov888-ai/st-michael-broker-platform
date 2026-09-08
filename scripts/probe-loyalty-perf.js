#!/usr/bin/env node
/**
 * 2026-09-08 (владелец): «бывает Bad Gateway при выборе метрик и фильтров».
 * Замер времени ответа ключевых запросов базы лояльности изнутри контейнера
 * (admin JWT как в qa-loyalty-filters). Печатает мс и статус по каждому,
 * помечает медленные (> 10 с) и ошибки. Только чтение.
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
    const to = new Date(); const from = new Date(to.getTime() - 92 * 86400000);
    const period = { from: from.toISOString(), to: to.toISOString() };
    const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const base = { page: 1, pageSize: 30, archived: "exclude", sortBy: "name", sortOrder: "asc", search: "", filter: {}, columns: {} };
    const cases = [
      ["GET", "ours overview (квартал)", `/loyalty-base/ours/overview?${q(period)}`],
      ["GET", "ours overview (старый кабинет)", `/loyalty-base/ours/overview?${q({ ...period, cabinetSource: "old" })}`],
      ["POST", "ours brokers: без фильтров", "/loyalty-base/ours/brokers/search", base],
      ["POST", "ours brokers: Есть фиксации", "/loyalty-base/ours/brokers/search", { ...base, columns: { activity: "HAS_FIXATIONS" } }],
      ["POST", "ours brokers: статус Фиксирующий + старый кабинет", "/loyalty-base/ours/brokers/search", { ...base, filter: { brokerStatuses: ["FIXATING"], cabinetSource: "old" } }],
      ["POST", "ours brokers: сделки за период + сортировка по сумме", "/loyalty-base/ours/brokers/search", { ...base, sortBy: "dealAmount", sortOrder: "desc", filter: { activityPeriod: period, dealsInPeriod: true } }],
      ["POST", "ours brokers: поиск по телефону", "/loyalty-base/ours/brokers/search", { ...base, search: "9161" }],
      ["POST", "ours agencies: без фильтров", "/loyalty-base/ours/agencies/search", base],
      ["POST", "ours agencies: Есть сделки", "/loyalty-base/ours/agencies/search", { ...base, columns: { deals: "HAS_DEALS" } }],
      ["POST", "ours activity-summary: без фильтров", "/loyalty-base/ours/brokers/activity-summary", { ...base, pageSize: 1, summaryPeriod: period }],
      ["POST", "ours activity-summary: Фиксирующий", "/loyalty-base/ours/brokers/activity-summary", { ...base, pageSize: 1, filter: { brokerStatuses: ["FIXATING"] }, summaryPeriod: period }],
      ["POST", "ours agencies activity-summary", "/loyalty-base/ours/agencies/activity-summary", { ...base, pageSize: 1, summaryPeriod: period }],
      ["POST", "anna brokers: без фильтров (со сцепками)", "/loyalty-base/anna/brokers/search", base],
      ["POST", "anna brokers: сцепленные, сортировка по сделкам", "/loyalty-base/anna/brokers/search", { ...base, sortBy: "deals", sortOrder: "desc", filter: { linkedOurs: "linked" } }],
      ["POST", "anna agencies: без фильтров", "/loyalty-base/anna/agencies/search", base],
      ["GET", "anna overview", `/loyalty-base/anna/overview?${q(period)}`],
      ["GET", "воронка strict", "/loyalty-base/ours/funnel?mode=strict"],
      ["GET", "воронка all", "/loyalty-base/ours/funnel?mode=all"],
      ["GET", "реестр: серия по месяцам", `/admin/registry-deals/series?${q({ from: new Date(to.getTime() - 365 * 86400000).toISOString(), to: to.toISOString(), granularity: "month" })}`],
    ];
    const results = [];
    for (const [method, name, path, body] of cases) {
      const t0 = Date.now(); let status = 0; let note = "";
      try {
        const res = await fetch(`${API_BASE}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
        status = res.status; const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
        if (json && typeof json.total === "number") note = `total ${json.total}`;
        else if (json?.selection?.count !== undefined) note = `выборка ${json.selection.count}`;
        else if (json?.totals?.cohort !== undefined) note = `когорта ${json.totals.cohort}`;
        else if (status >= 400) note = text.slice(0, 120);
      } catch (e) { note = String(e?.message || e).slice(0, 120); }
      const ms = Date.now() - t0; const slow = ms > 10000 ? " ⚠ медленно" : ""; const bad = status !== 200 && status !== 201 ? " ✗" : "";
      results.push({ name, ms, status, note });
      console.log(`${String(ms).padStart(6)} мс | HTTP ${status}${bad} | ${name}${note ? ` — ${note}` : ""}${slow}`);
    }
    const slow = results.filter((r) => r.ms > 10000).length; const errors = results.filter((r) => r.status !== 200 && r.status !== 201).length;
    console.log(`\nИтого: запросов ${results.length}, медленных (>10 с) ${slow}, ошибок ${errors}, максимум ${Math.max(...results.map((r) => r.ms))} мс`);
    console.log("RESULT: " + JSON.stringify({ n: results.length, slow, errors, max: Math.max(...results.map((r) => r.ms)), results }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
