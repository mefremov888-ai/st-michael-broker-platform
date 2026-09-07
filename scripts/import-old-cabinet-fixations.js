#!/usr/bin/env node
/**
 * 2026-09-07: перенос исторических фиксаций из СТАРОГО кабинета брокера
 * (orders.xlsx: 28 055 строк 2020–2026) в клиентов текущего кабинета.
 * Решение владельца 07.09: «делать» — иначе «Есть фиксации» у брокеров и
 * агентств показывает только фиксации с 2026 года.
 *
 * Вход — JSON из data-ветки (data/old-cabinet-fixations.json), собранный
 * локально из orders.xlsx: только строки со статусом 1 (принята) или 2
 * (отклонена), с телефонами клиента и брокера.
 *
 * Правила:
 *   - брокер ищется по телефону (brokers.phone и broker_phones.phone);
 *     не нашёлся — строка пропускается со счётчиком (создавать брокеров
 *     задним числом не будем);
 *   - идемпотентность: в comment пишется маркер [old-cabinet:<id>]; строки с
 *     уже существующим маркером пропускаются;
 *   - статус 1 → uniquenessStatus = EXPIRED (или CONDITIONALLY_UNIQUE, если
 *     30 дней с даты фиксации ещё не прошли), uniquenessExpiresAt = дата+30д;
 *     статус 2 → REJECTED с пояснением. fixationStatus = NOT_FIXED (акт
 *     осмотра по старым данным неизвестен), inspectionActSigned = false;
 *   - createdAt = дата из старого кабинета (история сохраняется);
 *   - amoSyncStatus = SYNCED — в amo ничего не отправляем;
 *   - project: «Зорге 9» → ZORGE9, «Квартал Серебряный Бор» → SILVER_BOR;
 *     остальное (пусто, «Берзарина 37», …) → ZORGE9 по умолчанию схемы, а
 *     исходное название сохраняется в comment.
 *
 * DRY_RUN=1 (по умолчанию) — отчёт: сколько сопоставилось брокеров, сколько
 * строк создастся, по годам/статусам, топ несопоставленных телефонов брокеров
 * (маскированные). DRY_RUN=0 — createMany батчами по 500.
 *
 * Запуск в контейнере api (workflow apply-old-cabinet-fixations.yml):
 *   DRY_RUN=1 node /app/scripts/import-old-cabinet-fixations.js /app/old-cabinet-fixations.json
 */

const BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const MARK = (id) => `[old-cabinet:${id}]`;
const MARK_RE = /\[old-cabinet:(\d+)\]/;

function buildComment(row) {
  const parts = [MARK(row.oldId), "Импорт из старого кабинета"];
  if (row.projectRaw && !row.project) parts.push(`проект: ${row.projectRaw}`);
  if (row.status === 2) parts.push("статус в старом кабинете: отклонена");
  if (row.info) parts.push(row.info);
  return parts.join(" · ").slice(0, 1000);
}

/** Данные Client для одной строки (чистая функция). */
function buildClientData(row, brokerId, now = new Date()) {
  const createdAt = new Date(row.createdAt);
  const expiresAt = new Date(createdAt.getTime() + 30 * DAY_MS);
  const accepted = row.status === 1;
  return {
    brokerId,
    fullName: String(row.fullName || "Клиент (старый кабинет)").slice(0, 200),
    phone: row.clientPhone,
    email: row.email || null,
    comment: buildComment(row),
    project: row.project || "ZORGE9",
    uniquenessStatus: accepted ? (expiresAt > now ? "CONDITIONALLY_UNIQUE" : "EXPIRED") : "REJECTED",
    uniquenessReason: accepted ? "перенос из старого кабинета" : "отклонена в старом кабинете",
    uniquenessExpiresAt: accepted ? expiresAt : null,
    fixationStatus: "NOT_FIXED",
    inspectionActSigned: false,
    amoSyncStatus: "SYNCED",
    propertyType: row.propertyType || null,
    roomsCount: row.rooms ? String(row.rooms) : null,
    amount: row.budget ?? null,
    sqm: row.sqm ?? null,
    createdAt,
  };
}

const mask = (p) => String(p).slice(0, 6) + "****";

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const file = process.argv[2];
  if (!file) throw new Error("usage: import-old-cabinet-fixations.js <old-cabinet-fixations.json>");
  const input = JSON.parse(require("fs").readFileSync(file, "utf8"));
  const rows = Array.isArray(input) ? input : input.rows || [];
  console.log(`=== Режим: ${dryRun ? "DRY-RUN (только отчёт)" : "APPLY (запись в БД!)"} · строк во входе: ${rows.length} ===\n`);
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    // 1. Телефон → брокер (основной телефон + доп. телефоны).
    const brokers = await prisma.broker.findMany({ where: { mergedIntoId: null }, select: { id: true, phone: true } });
    const extra = await prisma.brokerPhone.findMany({ select: { brokerId: true, phone: true } });
    const byPhone = new Map();
    for (const b of brokers) if (b.phone) byPhone.set(b.phone, b.id);
    for (const p of extra) if (p.phone && !byPhone.has(p.phone)) byPhone.set(p.phone, p.brokerId);
    console.log(`Брокеров в базе: ${brokers.length} (+${extra.length} доп. телефонов)`);

    // 2. Уже импортированные маркеры.
    const marked = await prisma.client.findMany({ where: { comment: { startsWith: "[old-cabinet:" } }, select: { comment: true } });
    const done = new Set();
    for (const c of marked) { const m = MARK_RE.exec(c.comment || ""); if (m) done.add(Number(m[1])); }
    console.log(`Уже импортировано ранее: ${done.size}`);

    // 3. План.
    const stats = { brokerMatched: 0, brokerMissing: 0, alreadyImported: 0, toCreate: 0, accepted: 0, rejected: 0, stillActive: 0 };
    const missingPhones = new Map();
    const byYear = new Map();
    const byProject = new Map();
    const prepared = [];
    const now = new Date();
    for (const row of rows) {
      if (done.has(Number(row.oldId))) { stats.alreadyImported++; continue; }
      const brokerId = byPhone.get(row.brokerPhone);
      if (!brokerId) {
        stats.brokerMissing++;
        missingPhones.set(row.brokerPhone, (missingPhones.get(row.brokerPhone) || 0) + 1);
        continue;
      }
      stats.brokerMatched++;
      const data = buildClientData(row, brokerId, now);
      prepared.push(data);
      stats.toCreate++;
      if (row.status === 1) stats.accepted++; else stats.rejected++;
      if (data.uniquenessStatus === "CONDITIONALLY_UNIQUE") stats.stillActive++;
      const y = row.createdAt.slice(0, 4); byYear.set(y, (byYear.get(y) || 0) + 1);
      byProject.set(data.project, (byProject.get(data.project) || 0) + 1);
    }
    console.log("\n=== Сводка ===");
    console.log(`Брокер найден по телефону:        ${stats.brokerMatched}`);
    console.log(`Брокер НЕ найден (пропуск):       ${stats.brokerMissing} (уникальных телефонов: ${missingPhones.size})`);
    console.log(`Уже импортировано (пропуск):      ${stats.alreadyImported}`);
    console.log(`К созданию:                       ${stats.toCreate} (принятых ${stats.accepted}, отклонённых ${stats.rejected}, ещё действующих ${stats.stillActive})`);
    console.log(`По годам: ${[...byYear.entries()].sort().map(([y, n]) => `${y}: ${n}`).join(", ")}`);
    console.log(`По проектам: ${[...byProject.entries()].map(([p, n]) => `${p}: ${n}`).join(", ")}`);
    const topMissing = [...missingPhones.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`Топ-10 несопоставленных телефонов брокеров (маска · строк): ${topMissing.map(([p, n]) => `${mask(p)} · ${n}`).join("; ")}`);

    if (dryRun) { console.log("\nDRY-RUN: ничего не записано. Для записи DRY_RUN=0."); return; }

    let created = 0;
    for (let i = 0; i < prepared.length; i += BATCH) {
      const batch = prepared.slice(i, i + BATCH);
      const res = await prisma.client.createMany({ data: batch });
      created += res.count;
      if ((i / BATCH) % 10 === 0) console.log(`— создано ${created}/${prepared.length} —`);
    }
    console.log(`\ncreated=${created}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}

module.exports = { buildClientData, buildComment, MARK_RE };
