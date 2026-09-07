#!/usr/bin/env node
/**
 * 2026-09-07 (задача владельца «протестировать, что все фильтры работают
 * качественно»): контрольная проверка фильтров «Нашей базы» ЧЕРЕЗ реальный API
 * (как это делает браузер) против прямых запросов к БД. Только чтение.
 *
 * Как работает:
 *   - берёт первого ADMIN из brokers, подписывает JWT тем же способом, что
 *     auth.service.login (HS256, JWT_SECRET контейнера) — как broker-test-kit;
 *   - вызывает POST /api/loyalty-base/ours/{brokers|agencies}/search и
 *     GET /overview с наборами фильтров;
 *   - сверяет инварианты и числа с Prisma-подсчётами по тем же правилам.
 * Печатает PASS/FAIL по каждой проверке и RESULT-json. Код выхода 1, если
 * есть FAIL.
 */

const crypto = require("node:crypto");

const API_BASE = `http://localhost:${process.env.API_PORT || 4000}/api`;
const HIST = "[old-cabinet:";
const FIX = { OR: [{ fixationStatus: { in: ["FIXED", "EXPIRED"] } }, { uniquenessStatus: { in: ["CONDITIONALLY_UNIQUE", "EXPIRED"] } }] };
const b64url = (input) => Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 }));
  const data = `${head}.${body}`;
  return `${data}.${b64url(crypto.createHmac("sha256", secret).update(data).digest())}`;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET отсутствует в env контейнера api");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const admin = await prisma.broker.findFirst({ where: { role: "ADMIN" }, select: { id: true, phone: true }, orderBy: { createdAt: "asc" } });
    if (!admin) throw new Error("нет ADMIN в brokers");
    const token = signJwt({ sub: admin.id, phone: admin.phone, role: "ADMIN" }, secret);
    const http = async (method, path, body) => {
      const res = await fetch(`${API_BASE}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: res.status, body: json, text };
    };
    const search = async (entity, filter = {}, columns = {}, extra = {}) => {
      const r = await http("POST", `/loyalty-base/ours/${entity}/search`, { page: 1, pageSize: 50, archived: "exclude", sortBy: "name", sortOrder: "asc", filter, columns, ...extra });
      if (r.status !== 200) throw new Error(`${entity} search HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      return r.body;
    };
    const brokerOwner = { is: { role: "BROKER", mergedIntoId: null } };

    // ── Брокеры: «Есть фиксации» / «Нет фиксаций» / всего ──
    const all = await search("brokers");
    const has = await search("brokers", {}, { activity: "HAS_FIXATIONS" });
    const none = await search("brokers", {}, { activity: "NO_FIXATIONS" });
    const active = await search("brokers", {}, { activity: "HAS_ACTIVE_FIXATIONS" });
    check("брокеры: HAS_FIXATIONS + NO_FIXATIONS = всего", has.total + none.total === all.total, `${has.total} + ${none.total} vs ${all.total}`);
    check("брокеры: HAS_ACTIVE_FIXATIONS ≤ HAS_FIXATIONS", active.total <= has.total, `${active.total} ≤ ${has.total}`);
    check("брокеры: у строк HAS_FIXATIONS metrics.fixations > 0", has.items.every((i) => Number(i.metrics?.fixations) > 0), `проверено ${has.items.length} строк`);
    check("брокеры: у строк NO_FIXATIONS metrics.fixations = 0", none.items.every((i) => Number(i.metrics?.fixations || 0) === 0), `проверено ${none.items.length} строк`);
    // Сверка с БД: брокеров с фиксациями (без учёта low-signal/архив — список
    // показывает всех действующих BROKER, поэтому ожидаем равенство).
    const dbHas = await prisma.broker.count({ where: { role: "BROKER", mergedIntoId: null, clients: { some: FIX } } });
    check("брокеры: HAS_FIXATIONS = БД (брокеры с ≥1 фиксацией)", has.total === dbHas, `API ${has.total} vs БД ${dbHas}`);
    // Поштучно: metrics.fixations = count в БД для первых 20.
    let perRowOk = true, perRowChecked = 0;
    for (const item of has.items.slice(0, 20)) {
      const n = await prisma.client.count({ where: { brokerId: item.id, ...FIX } });
      if (n !== Number(item.metrics?.fixations)) { perRowOk = false; console.log(`   ✗ ${item.id}: API ${item.metrics?.fixations} vs БД ${n}`); }
      perRowChecked++;
    }
    check("брокеры: metrics.fixations = БД поштучно", perRowOk, `проверено ${perRowChecked}`);

    // ── Источник старый / новый / оба ──
    const oldOnly = await search("brokers", { cabinetSource: "old" }, { activity: "HAS_FIXATIONS" });
    const newOnly = await search("brokers", { cabinetSource: "new" }, { activity: "HAS_FIXATIONS" });
    const dbOld = await prisma.broker.count({ where: { role: "BROKER", mergedIntoId: null, clients: { some: { AND: [FIX, { comment: { startsWith: HIST } }] } } } });
    const dbNew = await prisma.broker.count({ where: { role: "BROKER", mergedIntoId: null, clients: { some: { AND: [FIX, { NOT: { comment: { startsWith: HIST } } }] } } } });
    check("источник: старый кабинет = БД", oldOnly.total === dbOld, `API ${oldOnly.total} vs БД ${dbOld}`);
    check("источник: новый кабинет = БД", newOnly.total === dbNew, `API ${newOnly.total} vs БД ${dbNew}`);
    check("источник: old ≤ оба и new ≤ оба", oldOnly.total <= has.total && newOnly.total <= has.total, `${oldOnly.total}, ${newOnly.total} ≤ ${has.total}`);
    check("источник: у строк «старый» metrics.fixations > 0", oldOnly.items.every((i) => Number(i.metrics?.fixations) > 0), `проверено ${oldOnly.items.length}`);

    // ── Период активности: фиксации за 30 дней ──
    const to = new Date(); const from = new Date(to.getTime() - 30 * 86400000);
    const period = { from: from.toISOString(), to: to.toISOString() };
    const inPeriod = await search("brokers", { activityPeriod: period }, { activity: "HAS_FIXATIONS" }, { activityType: "FIXATION" });
    let periodOk = true, periodChecked = 0;
    for (const item of inPeriod.items.slice(0, 15)) {
      const n = await prisma.client.count({ where: { brokerId: item.id, ...FIX, createdAt: { gte: from, lte: to } } });
      const api = Number(item.periodMetrics?.fixations);
      if (Number.isFinite(api) && n !== api) { periodOk = false; console.log(`   ✗ ${item.id}: periodMetrics.fixations API ${api} vs БД ${n}`); }
      periodChecked++;
    }
    check("период: periodMetrics.fixations за 30 дней = БД", periodOk, `проверено ${periodChecked}`);

    // ── Обзор: activities.fixations = БД за период ──
    const ov = await http("GET", `/loyalty-base/ours/overview?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`);
    const dbOvFix = await prisma.client.count({ where: { ...FIX, createdAt: { gte: from, lte: to }, broker: brokerOwner } });
    check("обзор: activities.fixations за 30 дней = БД", ov.status === 200 && Number(ov.body?.activities?.fixations) === dbOvFix, `API ${ov.body?.activities?.fixations} vs БД ${dbOvFix}`);
    const ovOld = await http("GET", `/loyalty-base/ours/overview?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}&cabinetSource=old`);
    const dbOvOld = await prisma.client.count({ where: { ...FIX, comment: { startsWith: HIST }, createdAt: { gte: from, lte: to }, broker: brokerOwner } });
    check("обзор: фиксации старого кабинета за 30 дней = БД", ovOld.status === 200 && Number(ovOld.body?.activities?.fixations) === dbOvOld, `API ${ovOld.body?.activities?.fixations} vs БД ${dbOvOld}`);
    const dbPaid = await prisma.registryDeal.count({ where: { paidAt: { gte: from, lte: to }, brokerId: { not: null }, broker: brokerOwner } });
    check("обзор: сделки реестра (paidAt, с брокером) за 30 дней ≤ activities.deals", Number(ov.body?.activities?.deals) >= dbPaid, `API ${ov.body?.activities?.deals} vs реестр ${dbPaid}`);

    // ── Агентства: «Есть фиксации» ──
    const agAll = await search("agencies");
    const agHas = await search("agencies", {}, { activity: "HAS_FIXATIONS" });
    const agNone = await search("agencies", {}, { activity: "NO_FIXATIONS" });
    check("агентства: HAS_FIXATIONS + NO_FIXATIONS = всего", agHas.total + agNone.total === agAll.total, `${agHas.total} + ${agNone.total} vs ${agAll.total}`);
    check("агентства: у строк HAS_FIXATIONS metrics.fixations > 0", agHas.items.every((i) => Number(i.metrics?.fixations) > 0), `проверено ${agHas.items.length}`);
    const dbAgHas = await prisma.agency.count({ where: { brokerAgencies: { some: { broker: { role: "BROKER", mergedIntoId: null, clients: { some: FIX } } } } } });
    check("агентства: HAS_FIXATIONS ≈ БД (агентства с брокером с фиксацией)", agHas.total === dbAgHas, `API ${agHas.total} vs БД ${dbAgHas} (расхождение = правило low-signal/архив, смотреть текст)`);
    const agOld = await search("agencies", { cabinetSource: "old" }, { activity: "HAS_FIXATIONS" });
    const agNew = await search("agencies", { cabinetSource: "new" }, { activity: "HAS_FIXATIONS" });
    check("агентства: источник old/new ≤ оба", agOld.total <= agHas.total && agNew.total <= agHas.total, `${agOld.total}, ${agNew.total} ≤ ${agHas.total}`);

    // ── Сделки в периоде ──
    const deals = await search("brokers", { activityPeriod: period, dealsInPeriod: true });
    check("брокеры: «сделки в периоде» — у строк periodMetrics.deals > 0", deals.items.every((i) => Number(i.periodMetrics?.deals) > 0), `строк ${deals.items.length}, всего ${deals.total}`);

    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nИтого: ${results.length - failed} PASS, ${failed} FAIL`);
    console.log("RESULT: " + JSON.stringify({ pass: results.length - failed, fail: failed, checks: results.map((r) => ({ n: r.name, ok: r.ok, d: r.detail })) }));
    if (failed) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
