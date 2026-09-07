#!/usr/bin/env node
/**
 * 2026-09-07: сквозной приёмочный тест «новый брокер → агентство с ИНН →
 * фиксация клиента → лид в amoCRM». Три комплекта: ИНН 10 знаков (юрлицо,
 * контрольная цифра по алгоритму ФНС), 12 знаков (ИП, две контрольные цифры)
 * и 11 знаков (заведомо невалидная длина — ключевой вопрос владельца:
 * блокирует ли такой ИНН фиксацию).
 *
 * Запускается ВНУТРИ контейнера api (workflow broker-test-kit.yml доставляет
 * скрипт через git show + docker cp, приём apply-agencies-import.yml).
 * Все действия — через реальные HTTP-эндпоинты на localhost:4000/api тем же
 * путём, что и живой кабинет (регистрация, привязка агентства, фиксация).
 * NestFactory(AppModule) НЕ поднимается — полный контекст запускает
 * шедулеры-кроны внутри скрипта (прецедент: export v1).
 *
 * Режимы через env STEP:
 *   STEP=selftest — локальная проверка генератора ИНН (без БД и amo).
 *   STEP=prepare  — read-only: подобрать чистые телефоны (нет в БД и в amo)
 *                   и ИНН (нет в agencies), напечатать JSON-план кита.
 *   STEP=run      — пишущий (требует CONFIRM=yes): создать брокеров,
 *                   агентства, зафиксировать клиентов, итоговая таблица.
 *   STEP=cleanup  — пишущий (требует CONFIRM=yes): удалить ТЕСТКИТ-артефакты
 *                   из БД по префиксу имени. amo-лиды НЕ удаляются — только
 *                   перечисляются id для ручного удаления.
 *
 * Авторизация фиксации: JWT подписывается прямо в скрипте (HS256,
 * секрет из process.env.JWT_SECRET контейнера, payload {sub, phone, role}
 * как в auth.service.login / jwt.strategy). Для зарегистрированных брокеров
 * сначала пробуем настоящий POST /api/auth/login.
 *
 * Токены amo — из SystemSetting через Prisma + refresh-hook (приём
 * canary-amo-check.js / export-amo-deals.js).
 */

"use strict";

const crypto = require("crypto");

// Fix BigInt JSON serialization (как в apps/api/src/main.ts).
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function () { return this.toString(); };

const STEP = String(process.env.STEP || "").trim().toLowerCase();
const CONFIRM = String(process.env.CONFIRM || "").trim().toLowerCase();
const API_BASE = `http://localhost:${process.env.API_PORT || 4000}/api`;
const AMO_LEAD_URL = (id) => `https://stmichael.amocrm.ru/leads/detail/${id}`;

const PREFIX = "ТЕСТКИТ";
const CLIENT_PHONE_PREFIX = "+79990";
const BROKER_PHONE_PREFIX = "+79991";

// ─────────────────────────────────────────────────────────────────────────────
// ИНН: алгоритм контрольных цифр ФНС.
// 10 знаков (юрлицо): 10-я цифра = ((Σ d[i]*w[i], i=1..9) mod 11) mod 10,
//   веса [2,4,10,3,5,9,4,6,8].
// 12 знаков (физлицо/ИП): 11-я цифра по весам [7,2,4,10,3,5,9,4,6,8] от
//   первых 10; 12-я — по весам [3,7,2,4,10,3,5,9,4,6,8] от первых 11.
// ─────────────────────────────────────────────────────────────────────────────
const W10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const W11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const W12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function controlDigit(digitsStr, weights) {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(digitsStr[i]) * weights[i];
  return (sum % 11) % 10;
}

function isValidInn10(inn) {
  return /^\d{10}$/.test(inn) && Number(inn[9]) === controlDigit(inn, W10);
}

function isValidInn12(inn) {
  return (
    /^\d{12}$/.test(inn) &&
    Number(inn[10]) === controlDigit(inn, W11) &&
    Number(inn[11]) === controlDigit(inn, W12)
  );
}

function randomDigits(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += String(crypto.randomInt(0, 10));
  return s;
}

// 10-значный: регион 77 + 7 случайных + контрольная.
function generateInn10() {
  const base = "77" + randomDigits(7);
  return base + String(controlDigit(base, W10));
}

// 12-значный (ИП): регион 77 + 8 случайных + 2 контрольные.
function generateInn12() {
  const base = "77" + randomDigits(8);
  const d11 = String(controlDigit(base, W11));
  const d12 = String(controlDigit(base + d11, W12));
  return base + d11 + d12;
}

// 11 знаков — буквально 11 цифр (невалидная длина по определению).
function generateInn11() {
  return "77" + randomDigits(9);
}

function selftestInn() {
  // Известные настоящие ИНН из открытых данных:
  //   7707083893 — ПАО Сбербанк (юрлицо, 10 знаков);
  //   7708004767 — РЖД-структура (юрлицо, 10 знаков);
  //   500100732259 — эталонный 12-значный ИНН из примеров ФНС.
  const checks = [
    ["7707083893", isValidInn10("7707083893") === true, "Сбербанк 7707083893 валиден"],
    ["7707083894", isValidInn10("7707083894") === false, "искажённая контрольная цифра отвергается (10)"],
    ["500100732259", isValidInn12("500100732259") === true, "эталонный 12-значный валиден"],
    ["500100732258", isValidInn12("500100732258") === false, "искажённая контрольная цифра отвергается (12)"],
  ];
  for (const [inn, ok, label] of checks) {
    if (!ok) throw new Error(`SELFTEST FAIL: ${label} (inn=${inn})`);
    console.log(`selftest: OK — ${label}`);
  }
  for (let i = 0; i < 50; i++) {
    const a = generateInn10();
    if (!isValidInn10(a)) throw new Error(`SELFTEST FAIL: сгенерированный ИНН10 невалиден: ${a}`);
    const b = generateInn12();
    if (!isValidInn12(b)) throw new Error(`SELFTEST FAIL: сгенерированный ИНН12 невалиден: ${b}`);
    const c = generateInn11();
    if (c.length !== 11) throw new Error(`SELFTEST FAIL: ИНН11 не 11 знаков: ${c}`);
  }
  console.log("selftest: OK — генератор 50/50 раундов (ИНН10/ИНН12/ИНН11)");
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT HS256 — как auth.service.login (payload {sub, phone, role}) +
// jwt.strategy (secretOrKey = process.env.JWT_SECRET, validate по payload.sub).
// ─────────────────────────────────────────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signJwt(payload, secret) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + 15 * 60 };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const sig = b64url(crypto.createHmac("sha256", secret).update(data).digest());
  return `${data}.${sig}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP к локальному api (Node 20 — глобальный fetch есть).
// ─────────────────────────────────────────────────────────────────────────────
async function http(method, path, body, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* оставляем текстом */ }
  return { status: res.status, body: parsed };
}

function shortBody(b, max = 400) {
  const s = typeof b === "string" ? b : JSON.stringify(b);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// amo: токены из SystemSetting + refresh-hook (приём canary-amo-check.js).
// ─────────────────────────────────────────────────────────────────────────────
async function initAmo(prisma) {
  const {
    AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook,
  } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  setAmoTokens(
    byKey.get("AMO_ACCESS_TOKEN") || process.env.AMO_ACCESS_TOKEN || "",
    byKey.get("AMO_REFRESH_TOKEN") || process.env.AMO_REFRESH_TOKEN || "",
  );
  setAmoTokenRefreshHook(async (tokens) => {
    for (const [key, value] of [
      ["AMO_ACCESS_TOKEN", tokens.access],
      ["AMO_REFRESH_TOKEN", tokens.refresh],
    ]) {
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value, updatedBy: "broker-test-kit" },
        create: { key, value, updatedBy: "broker-test-kit" },
      });
    }
    console.error("amo tokens refreshed and persisted");
  });
  return new AmoCrmAdapter();
}

// ─────────────────────────────────────────────────────────────────────────────
// Подбор чистых телефонов: партиями по 6 случайных, каждый проверяем в БД
// (brokers.phone, broker_phones.phone, clients.phone) и в amo
// (findContactByPhone strict → пусто). Выбираем нужное число чистых.
// ─────────────────────────────────────────────────────────────────────────────
async function findCleanPhones(prisma, amo, prefix, need, label) {
  const digitsToAdd = 12 - prefix.length; // формат +7XXXXXXXXXX
  const clean = [];
  const seen = new Set();
  for (let round = 1; round <= 5 && clean.length < need; round++) {
    const batch = [];
    while (batch.length < 6) {
      const p = prefix + randomDigits(digitsToAdd);
      if (!seen.has(p)) { seen.add(p); batch.push(p); }
    }
    console.log(`\n[${label}] раунд ${round}: кандидаты ${batch.join(", ")}`);
    for (const phone of batch) {
      if (clean.length >= need) break;
      const [broker, brokerPhone, client] = await Promise.all([
        prisma.broker.findUnique({ where: { phone }, select: { id: true } }),
        prisma.brokerPhone.findUnique({ where: { phone }, select: { id: true } }),
        prisma.client.findFirst({ where: { phone }, select: { id: true } }),
      ]);
      if (broker || brokerPhone || client) {
        console.log(`  ${phone}: ЗАНЯТ в БД (broker=${!!broker} broker_phone=${!!brokerPhone} client=${!!client})`);
        continue;
      }
      let amoContact = null;
      try {
        amoContact = await amo.findContactByPhone(phone, { strict: true });
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (msg === "AMBIGUOUS_EXACT_CONTACT") {
          console.log(`  ${phone}: ЗАНЯТ в amo (несколько контактов)`);
          continue;
        }
        throw new Error(`amo недоступен при проверке ${phone}: ${msg}`);
      }
      if (amoContact) {
        console.log(`  ${phone}: ЗАНЯТ в amo (contact id=${amoContact.id})`);
        continue;
      }
      console.log(`  ${phone}: ЧИСТ (нет в БД, нет в amo)`);
      clean.push(phone);
    }
  }
  if (clean.length < need) {
    throw new Error(`не удалось подобрать ${need} чистых телефонов ${label} за 5 раундов`);
  }
  return clean.slice(0, need);
}

async function findFreeInn(prisma, generator, label) {
  for (let i = 0; i < 20; i++) {
    const inn = generator();
    const existing = await prisma.agency.findUnique({ where: { inn }, select: { id: true, name: true } });
    if (!existing) {
      console.log(`[ИНН ${label}] ${inn}: свободен в agencies`);
      return inn;
    }
    console.log(`[ИНН ${label}] ${inn}: уже есть в agencies («${existing.name}») — генерирую другой`);
  }
  throw new Error(`не удалось подобрать свободный ИНН (${label})`);
}

async function buildPlan(prisma, amo) {
  const clientPhones = await findCleanPhones(prisma, amo, CLIENT_PHONE_PREFIX, 3, "клиенты");
  const brokerPhones = await findCleanPhones(prisma, amo, BROKER_PHONE_PREFIX, 3, "брокеры");
  const inn10 = await findFreeInn(prisma, generateInn10, "10, юрлицо, валидный по ФНС");
  const inn12 = await findFreeInn(prisma, generateInn12, "12, ИП, валидный по ФНС");
  const inn11 = await findFreeInn(prisma, generateInn11, "11, заведомо невалидная длина");
  const kitDefs = [
    { tag: "ИНН10", inn: inn10, innType: "AGENCY", clientLetter: "А" },
    { tag: "ИНН11", inn: inn11, innType: "AGENCY", clientLetter: "Б" },
    { tag: "ИНН12", inn: inn12, innType: "PERSONAL", clientLetter: "В" },
  ];
  const kits = kitDefs.map((k, i) => ({
    kit: k.tag,
    inn: k.inn,
    innType: k.innType,
    brokerPhone: brokerPhones[i],
    brokerName: `${PREFIX} Брокер ${k.tag}`,
    agencyName: `${PREFIX} Агентство ${k.tag.replace("ИНН", "")}`,
    clientPhone: clientPhones[i],
    clientName: `${PREFIX} Клиент ${k.clientLetter}`,
    project: "ZORGE9",
  }));
  return { generatedAt: new Date().toISOString(), prefix: PREFIX, kits };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP=prepare — read-only к БД, только GET к amo.
// ─────────────────────────────────────────────────────────────────────────────
async function stepPrepare(prisma, amo) {
  selftestInn();
  const plan = await buildPlan(prisma, amo);
  console.log("\n=== ГОТОВЫЙ JSON-ПЛАН КИТА (все сущности с префиксом ТЕСТКИТ) ===");
  console.log(JSON.stringify(plan, null, 2));
  console.log("\nprepare: ничего не записано (read-only). Дальше STEP=run + CONFIRM=yes.");
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP=run — пишущий сквозной прогон.
// ─────────────────────────────────────────────────────────────────────────────
async function stepRun(prisma, amo) {
  if (CONFIRM !== "yes") throw new Error("STEP=run требует CONFIRM=yes");
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET отсутствует в env контейнера api");

  selftestInn();
  const plan = await buildPlan(prisma, amo);
  console.log("\n=== ПЛАН ПРОГОНА ===");
  console.log(JSON.stringify(plan, null, 2));

  const results = [];
  for (const kit of plan.kits) {
    console.log(`\n########## КОМПЛЕКТ ${kit.kit} (ИНН ${kit.inn}) ##########`);
    const r = {
      kit: kit.kit,
      inn: kit.inn,
      brokerCreated: "нет",
      agency: "-",
      fixation: "-",
      status: "-",
      amoLink: "-",
    };
    results.push(r);
    const password = `Testkit!${randomDigits(8)}`;
    const email = `testkit-${kit.kit.toLowerCase().replace("инн", "inn")}-${Date.now()}@example.com`;

    // Существовало ли агентство с этим ИНН до прогона (для честного rename).
    const agencyExistedBefore = !!(await prisma.agency.findUnique({
      where: { inn: kit.inn }, select: { id: true },
    }));

    // ── 1. Регистрация брокера тем же HTTP-путём, что публичная форма ──
    let brokerId = null;
    const reg = await http("POST", "/auth/register", {
      phone: kit.brokerPhone,
      fullName: kit.brokerName,
      email,
      password,
      inn: kit.inn,
      innType: kit.innType,
      agencyName: kit.agencyName,
    });
    console.log(`[${kit.kit}] POST /auth/register → HTTP ${reg.status}: ${shortBody(reg.body)}`);
    if (reg.status === 201 && reg.body && reg.body.brokerId) {
      brokerId = reg.body.brokerId;
      r.brokerCreated = "да (register)";
      r.agency = "ok (создано при регистрации)";
    } else {
      const errText = (reg.body && (reg.body.message || JSON.stringify(reg.body.errors || reg.body))) || `HTTP ${reg.status}`;
      r.agency = `ошибка регистрации: ${shortBody(errText, 160)}`;
      // ── 1b. Фолбэк: брокер создаётся напрямую в БД теми же полями, что
      // auth.service.register (bcrypt-хэш, ACTIVE, BROKER_CABINET), чтобы
      // проверить вторую половину требования — проходит ли фиксация при
      // проблемном ИНН. Агентство пробуем привязать штатным HTTP-путём
      // профиля POST /auth/me/agency (там проверка длины 10–12).
      console.log(`[${kit.kit}] регистрация не прошла — создаю брокера напрямую в БД (обходной путь для теста фиксации)`);
      const bcrypt = require("bcrypt");
      const passwordHash = await bcrypt.hash(password, 10);
      const created = await prisma.broker.create({
        data: {
          phone: kit.brokerPhone,
          fullName: kit.brokerName,
          email,
          passwordHash,
          status: "ACTIVE",
          source: "BROKER_CABINET",
        },
        select: { id: true },
      });
      brokerId = created.id;
      r.brokerCreated = "да (напрямую в БД: register отклонил ИНН)";
      const tokenTmp = signJwt({ sub: brokerId, phone: kit.brokerPhone, role: "BROKER" }, secret);
      const attach = await http("POST", "/auth/me/agency", { inn: kit.inn }, tokenTmp);
      console.log(`[${kit.kit}] POST /auth/me/agency → HTTP ${attach.status}: ${shortBody(attach.body)}`);
      if (attach.status === 200) {
        r.agency += `; привязка через профиль: ok (${shortBody((attach.body && attach.body.agency && attach.body.agency.name) || "", 60)})`;
      } else {
        r.agency += `; привязка через профиль: ошибка ${attach.status} ${shortBody((attach.body && attach.body.message) || attach.body, 120)}`;
      }
    }

    // Агентство, созданное этим прогоном без ТЕСТКИТ-имени (fixClient и
    // attachAgencyByInn называют его «Агентство <ИНН>»), переименовываем в
    // ТЕСТКИТ-имя, чтобы cleanup находил его по префиксу.
    if (!agencyExistedBefore) {
      await prisma.agency.updateMany({
        where: { inn: kit.inn, NOT: { name: { startsWith: PREFIX } } },
        data: { name: kit.agencyName },
      });
    }

    // ── 2. JWT: сначала штатный login, затем самоподписанный ──
    let token = null;
    const login = await http("POST", "/auth/login", { phone: kit.brokerPhone, password });
    if (login.status === 200 && login.body && login.body.accessToken) {
      token = login.body.accessToken;
      console.log(`[${kit.kit}] POST /auth/login → HTTP 200 (токен получен штатно)`);
    } else {
      token = signJwt({ sub: brokerId, phone: kit.brokerPhone, role: "BROKER" }, secret);
      console.log(`[${kit.kit}] POST /auth/login → HTTP ${login.status}; использую самоподписанный JWT (payload как в auth.service.login)`);
    }

    // ── 3. Фиксация клиента ──
    const fix = await http("POST", "/clients/fix", {
      idempotencyKey: crypto.randomUUID(),
      phone: kit.clientPhone,
      fullName: kit.clientName,
      project: kit.project,
      agencyInn: kit.inn,
      comment: `${PREFIX}: сквозной приёмочный тест (${kit.kit})`,
    }, token);
    console.log(`[${kit.kit}] POST /clients/fix → HTTP ${fix.status}: ${shortBody(fix.body, 700)}`);

    if (fix.status === 200 || fix.status === 201) {
      r.fixation = "ok";
      r.status = String((fix.body && (fix.body.status || (fix.body.client && fix.body.client.uniquenessStatus))) || "?");
    } else {
      const errText = (fix.body && (fix.body.message || JSON.stringify(fix.body))) || `HTTP ${fix.status}`;
      r.fixation = `ошибка ${fix.status}: ${shortBody(errText, 160)}`;
    }

    // ── 4. Пост-проверка по БД: id клиента, uniquenessStatus, amoLeadId ──
    const client = await prisma.client.findFirst({
      where: { phone: kit.clientPhone, brokerId },
      select: {
        id: true, uniquenessStatus: true, amoLeadId: true,
        amoSyncStatus: true, amoSyncError: true,
      },
      orderBy: { createdAt: "desc" },
    });
    if (client) {
      console.log(`[${kit.kit}] клиент в БД: id=${client.id} uniquenessStatus=${client.uniquenessStatus} amoSyncStatus=${client.amoSyncStatus} amoLeadId=${client.amoLeadId || "нет"}${client.amoSyncError ? ` amoSyncError=${client.amoSyncError}` : ""}`);
      r.status = String(client.uniquenessStatus);
      if (client.amoLeadId) {
        r.amoLink = AMO_LEAD_URL(client.amoLeadId);
        console.log(`[${kit.kit}] amo-лид: ${r.amoLink}`);
      }
    } else {
      console.log(`[${kit.kit}] клиент в БД НЕ создан`);
    }
  }

  console.log("\n=== ИТОГОВАЯ ТАБЛИЦА ===");
  console.log("комплект | брокер создан? | агентство | фиксация | статус | ссылка amo");
  for (const r of results) {
    console.log(`${r.kit} (ИНН ${r.inn}) | ${r.brokerCreated} | ${r.agency} | ${r.fixation} | ${r.status} | ${r.amoLink}`);
  }
  console.log("\nПосле проверки: STEP=cleanup + CONFIRM=yes удалит ТЕСТКИТ-артефакты из БД (amo-лиды — вручную).");
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP=cleanup — удаление ТЕСТКИТ-артефактов по префиксу имени.
// ─────────────────────────────────────────────────────────────────────────────
async function stepCleanup(prisma) {
  if (CONFIRM !== "yes") throw new Error("STEP=cleanup требует CONFIRM=yes");

  const brokers = await prisma.broker.findMany({
    where: { fullName: { startsWith: PREFIX } },
    select: { id: true, fullName: true, phone: true, amoContactId: true },
  });
  const brokerIds = brokers.map((b) => b.id);
  const clients = await prisma.client.findMany({
    where: {
      OR: [
        { fullName: { startsWith: PREFIX } },
        ...(brokerIds.length ? [{ brokerId: { in: brokerIds } }] : []),
      ],
    },
    select: { id: true, fullName: true, phone: true, amoLeadId: true },
  });
  const clientIds = clients.map((c) => c.id);
  const agencies = await prisma.agency.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true, name: true, inn: true },
  });

  console.log(`Найдено: брокеров ${brokers.length}, клиентов ${clients.length}, агентств ${agencies.length}`);
  for (const b of brokers) console.log(`  брокер: ${b.fullName} (${b.phone}) amoContactId=${b.amoContactId || "нет"}`);
  for (const c of clients) console.log(`  клиент: ${c.fullName} (${c.phone}) amoLeadId=${c.amoLeadId || "нет"}`);
  for (const a of agencies) console.log(`  агентство: «${a.name}» ИНН ${a.inn}`);

  const amoLeadIds = clients.filter((c) => c.amoLeadId).map((c) => String(c.amoLeadId));
  const amoContactIds = brokers.filter((b) => b.amoContactId).map((b) => String(b.amoContactId));

  // Клиенты: сначала зависимости (meetings/calls/deals), затем сами клиенты.
  if (clientIds.length) {
    const meetings = await prisma.meeting.deleteMany({ where: { clientId: { in: clientIds } } });
    const calls = await prisma.call.deleteMany({ where: { clientId: { in: clientIds } } });
    const deals = await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
    const del = await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    console.log(`Клиенты: удалено ${del.count} (meetings −${meetings.count}, calls −${calls.count}, deals −${deals.count})`);
  }

  // Брокеры: зависимости, затем сами. Каждая пачка в try/catch — новая
  // NOT NULL-связь в схеме не должна ронять остальную чистку.
  if (brokerIds.length) {
    const depTables = [
      ["notification", { brokerId: { in: brokerIds } }],
      ["brokerPhone", { brokerId: { in: brokerIds } }],
      ["brokerAgency", { brokerId: { in: brokerIds } }],
      ["offerAcceptance", { brokerId: { in: brokerIds } }],
      ["privacyAcceptance", { brokerId: { in: brokerIds } }],
      ["pushSubscription", { brokerId: { in: brokerIds } }],
      ["notificationPreference", { brokerId: { in: brokerIds } }],
      ["favoriteLot", { brokerId: { in: brokerIds } }],
      ["callLog", { brokerId: { in: brokerIds } }],
    ];
    for (const [model, where] of depTables) {
      try {
        const del = await prisma[model].deleteMany({ where });
        if (del.count) console.log(`  ${model}: −${del.count}`);
      } catch (e) {
        console.log(`  ${model}: пропуск (${(e && e.message ? e.message.split("\n")[0] : e)})`);
      }
    }
    let deletedBrokers = 0;
    for (const b of brokers) {
      try {
        await prisma.broker.delete({ where: { id: b.id } });
        deletedBrokers++;
      } catch (e) {
        console.log(`  брокер ${b.fullName}: НЕ удалён — ${(e && e.message ? e.message.split("\n")[0] : e)}`);
      }
    }
    console.log(`Брокеры: удалено ${deletedBrokers} из ${brokers.length}`);
  }

  // Агентства: занулить nullable-ссылки, удалить (приём cleanup-test-agencies).
  let deletedAgencies = 0;
  for (const a of agencies) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.brokerAgency.deleteMany({ where: { agencyId: a.id } });
        await tx.deal.updateMany({ where: { agencyId: a.id }, data: { agencyId: null } });
        await tx.client.updateMany({ where: { fixationAgencyId: a.id }, data: { fixationAgencyId: null } });
        await tx.agency.delete({ where: { id: a.id } });
      });
      deletedAgencies++;
      console.log(`Агентство «${a.name}» (ИНН ${a.inn}): удалено`);
    } catch (e) {
      console.log(`Агентство «${a.name}» (ИНН ${a.inn}): НЕ удалено — ${(e && e.message ? e.message.split("\n")[0] : e)}`);
    }
  }
  console.log(`Агентства: удалено ${deletedAgencies} из ${agencies.length}`);

  console.log("\n=== amo НЕ трогали — удалить вручную ===");
  if (amoLeadIds.length) {
    for (const id of amoLeadIds) console.log(`  лид ${id}: ${AMO_LEAD_URL(id)}`);
  } else {
    console.log("  лидов не было");
  }
  if (amoContactIds.length) {
    console.log(`  контакты брокеров (id): ${amoContactIds.join(", ")}`);
  } else {
    console.log("  контактов брокеров не было");
  }
  console.log("Записи audit_logs не удаляются (без FK, остаются как история).");
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  if (STEP === "selftest") {
    selftestInn();
    console.log("SELFTEST OK");
    return;
  }
  if (!["prepare", "run", "cleanup"].includes(STEP)) {
    console.error("Задайте STEP=selftest|prepare|run|cleanup (run/cleanup также CONFIRM=yes)");
    process.exit(2);
  }
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    if (STEP === "cleanup") {
      await stepCleanup(prisma);
    } else {
      const amo = await initAmo(prisma);
      if (STEP === "prepare") await stepPrepare(prisma, amo);
      else await stepRun(prisma, amo);
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error("FATAL:", (e && e.message) || e);
  process.exit(1);
});
