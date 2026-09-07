#!/usr/bin/env node
/**
 * 2026-09-07 (решения владельца, вечер): сцепки «база Анны ↔ Наша база» БЕЗ
 * слияния — только LoyaltyEntityLink (обратимые связи, как их пишет модуль
 * сверки при решении LINK).
 *
 * Правила:
 *   Брокеры Анны (активный снимок, source records BROKER, person не в архиве):
 *     - телефон совпал ровно с одной нашей карточкой → сцепка;
 *     - телефон у нескольких наших карточек → сцепка с САМОЙ АКТИВНОЙ
 *       (сделки > встречи > фиксации > брокер-тур > lastCallAt > ACTIVE >
 *       есть amo-контакт > updatedAt);
 *     - нет телефона / нет совпадений → пропуск (карточки НЕ создаём, п.3).
 *   Агентства Анны: по ИНН (taxId), иначе по нормализованному названию, если
 *   совпадение единственное; иначе пропуск.
 *   Уже есть подтверждённая сцепка (CONFIRMED, не отозвана) → пропуск.
 *   Наша карточка должна проходить те же проверки, что assertOurTarget в
 *   модуле сверки: role BROKER, status != BLOCKED, source != CLOSED_AS_BROKER,
 *   mergedIntoId null.
 *
 * Пишет (APPLY): LoyaltyReconciliationCase (детерминированный id, как в
 * reconciliation-v2, status RESOLVED / decision LINK) + LoyaltyEntityLink
 * (CONFIRMED, ruleVersion loyalty-reconciliation-v2) + LoyaltyEntityChange
 * (аудит). DRY_RUN=1 по умолчанию — только отчёт без ПД.
 *
 * Запуск в контейнере api (workflow apply-anna-links.yml).
 */

const { createHash } = require("node:crypto");
const { canonicalAgencyMatchKey } = require("./enrich-agencies-from-amo");

const RULE_VERSION = "loyalty-reconciliation-v2";
const ACTOR = null; // системный прогон (владелец 07.09)

function stableUuid(value) {
  const chars = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "8";
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function normPhone(value) {
  let d = String(value ?? "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  return d.length === 11 && d[0] === "7" ? d : null;
}
/** Ранг «активности» карточки — больше = активнее (чистая функция). */
function activityScore(b) {
  const c = b._count || {};
  return [
    Number(c.deals || 0),
    Number(c.meetings || 0),
    Number(c.clients || 0),
    b.brokerTourVisited ? 1 : 0,
    b.lastCallAt ? new Date(b.lastCallAt).getTime() : 0,
    b.status === "ACTIVE" ? 1 : 0,
    b.amoContactId ? 1 : 0,
    b.updatedAt ? new Date(b.updatedAt).getTime() : 0,
  ];
}
function pickMostActive(cards) {
  return [...cards].sort((a, b) => {
    const sa = activityScore(a), sb = activityScore(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  console.log(`=== Режим: ${dryRun ? "DRY-RUN (только отчёт)" : "APPLY (запись сцепок!)"} ===`);
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const dataset = await prisma.loyaltyDataset.findFirst({ where: { code: "ANNA" }, select: { id: true, activeSnapshotId: true } });
    if (!dataset?.activeSnapshotId) { console.log("Нет активного снимка Анны."); return; }
    const snapshotId = dataset.activeSnapshotId;

    // Наши брокеры (как assertOurTarget) с активностью.
    const ours = await prisma.broker.findMany({
      where: { role: "BROKER", mergedIntoId: null, NOT: { status: "BLOCKED" } },
      select: {
        id: true, phone: true, status: true, source: true, amoContactId: true, lastCallAt: true, brokerTourVisited: true, updatedAt: true,
        phones: { select: { phone: true } },
        _count: { select: { clients: true, deals: true, meetings: true } },
      },
    });
    const eligible = ours.filter((b) => b.source !== "CLOSED_AS_BROKER");
    const phoneToOurs = new Map();
    for (const b of eligible) for (const p of [b.phone, ...b.phones.map((x) => x.phone)]) { const n = normPhone(p); if (!n) continue; if (!phoneToOurs.has(n)) phoneToOurs.set(n, new Set()); phoneToOurs.get(n).add(b.id); }
    const byId = new Map(eligible.map((b) => [b.id, b]));

    // Строки Анны.
    const records = await prisma.loyaltySourceRecord.findMany({
      where: { snapshotId, sourceArchivedAt: null },
      select: {
        id: true, entityType: true, personId: true, organizationId: true, displayName: true, taxId: true,
        person: { select: { id: true, archivedAt: true } }, organization: { select: { id: true, archivedAt: true } },
        contactPoints: { where: { type: "PHONE" }, select: { normalizedValue: true, value: true } },
      },
    });
    // Уже подтверждённые сцепки.
    const existing = await prisma.loyaltyEntityLink.findMany({ where: { status: "CONFIRMED", revokedAt: null }, select: { personId: true, organizationId: true, targetType: true, targetId: true } });
    const linkedPersons = new Set(existing.filter((l) => l.personId).map((l) => l.personId));
    const linkedOrgs = new Set(existing.filter((l) => l.organizationId).map((l) => l.organizationId));
    const usedTargets = new Set(existing.map((l) => `${l.targetType}:${l.targetId}`));

    const plan = [];
    const st = { brokers: { total: 0, alreadyLinked: 0, noPhone: 0, one: 0, many: 0, none: 0, archived: 0, targetTaken: 0 }, agencies: { total: 0, alreadyLinked: 0, inn: 0, nameUnique: 0, ambiguous: 0, none: 0, archived: 0, targetTaken: 0 } };
    // Брокеры (по person: несколько строк на одного person → один раз).
    const seenPersons = new Set();
    for (const r of records.filter((x) => x.entityType === "BROKER" && x.personId)) {
      if (seenPersons.has(r.personId)) continue;
      seenPersons.add(r.personId);
      st.brokers.total++;
      if (r.person?.archivedAt) { st.brokers.archived++; continue; }
      if (linkedPersons.has(r.personId)) { st.brokers.alreadyLinked++; continue; }
      const phones = [...new Set(records.filter((x) => x.personId === r.personId).flatMap((x) => x.contactPoints.map((c) => normPhone(c.normalizedValue || c.value))).filter(Boolean))];
      if (!phones.length) { st.brokers.noPhone++; continue; }
      const targets = new Set();
      for (const p of phones) for (const id of phoneToOurs.get(p) || []) targets.add(id);
      if (!targets.size) { st.brokers.none++; continue; }
      const cards = [...targets].map((id) => byId.get(id)).filter(Boolean);
      const chosen = cards.length === 1 ? cards[0] : pickMostActive(cards);
      if (cards.length === 1) st.brokers.one++; else st.brokers.many++;
      if (usedTargets.has(`BROKER:${chosen.id}`)) { st.brokers.targetTaken++; continue; }
      usedTargets.add(`BROKER:${chosen.id}`);
      plan.push({ kind: "BROKER", personId: r.personId, targetId: chosen.id, matchCodes: ["PHONE_EXACT"], score: "1.0000", note: cards.length === 1 ? "phone 1:1" : `phone → most active of ${cards.length}` });
    }
    // Агентства.
    const agencies = await prisma.agency.findMany({ select: { id: true, name: true, legalName: true, inn: true } });
    const byInn = new Map(agencies.filter((a) => /^\d{10}(\d{2})?$/.test(String(a.inn || ""))).map((a) => [String(a.inn), a.id]));
    const byKey = new Map();
    for (const a of agencies) for (const v of [a.name, a.legalName]) { const k = canonicalAgencyMatchKey(v); if (k) { if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(a.id); } }
    const seenOrgs = new Set();
    for (const r of records.filter((x) => x.entityType === "AGENCY" && x.organizationId)) {
      if (seenOrgs.has(r.organizationId)) continue;
      seenOrgs.add(r.organizationId);
      st.agencies.total++;
      if (r.organization?.archivedAt) { st.agencies.archived++; continue; }
      if (linkedOrgs.has(r.organizationId)) { st.agencies.alreadyLinked++; continue; }
      const inn = String(r.taxId || "").replace(/\D/g, "");
      let targetId = null, code = null;
      if (inn && byInn.has(inn)) { targetId = byInn.get(inn); code = "INN_EXACT"; st.agencies.inn++; }
      else {
        const k = canonicalAgencyMatchKey(r.displayName);
        const ids = k ? byKey.get(k) : null;
        if (ids && ids.size === 1) { targetId = [...ids][0]; code = "NAME_EXACT"; st.agencies.nameUnique++; }
        else if (ids && ids.size > 1) { st.agencies.ambiguous++; continue; }
        else { st.agencies.none++; continue; }
      }
      if (usedTargets.has(`AGENCY:${targetId}`)) { st.agencies.targetTaken++; continue; }
      usedTargets.add(`AGENCY:${targetId}`);
      plan.push({ kind: "AGENCY", organizationId: r.organizationId, targetId, matchCodes: [code], score: code === "INN_EXACT" ? "1.0000" : "0.9000", note: code });
    }

    console.log("\n--- Брокеры Анны ---"); for (const [k, v] of Object.entries(st.brokers)) console.log(`  ${k}: ${v}`);
    console.log("--- Агентства Анны ---"); for (const [k, v] of Object.entries(st.agencies)) console.log(`  ${k}: ${v}`);
    console.log(`\nСцепок к записи: ${plan.length} (брокеров ${plan.filter((p) => p.kind === "BROKER").length}, агентств ${plan.filter((p) => p.kind === "AGENCY").length})`);
    console.log("RESULT: " + JSON.stringify({ snapshot: snapshotId, plan: plan.length, ...st, dryRun }));
    if (dryRun) { console.log("\nDRY-RUN: ничего не записано. Для записи DRY_RUN=0."); return; }

    let written = 0;
    const now = new Date();
    for (let i = 0; i < plan.length; i += 100) {
      const chunk = plan.slice(i, i + 100);
      await prisma.$transaction(async (tx) => {
        for (const p of chunk) {
          const owner = p.kind === "BROKER" ? { personId: p.personId } : { organizationId: p.organizationId };
          const identity = `${snapshotId}:${p.kind}:${p.kind === "BROKER" ? "PERSON" : "ORGANIZATION"}:${p.personId || p.organizationId}:${p.targetId}`;
          const caseId = stableUuid("reconciliation-v2:case:" + identity);
          await tx.loyaltyReconciliationCase.createMany({
            data: [{ id: caseId, datasetId: dataset.id, snapshotId, ...owner, targetType: p.kind, targetId: p.targetId, matchCodes: p.matchCodes, score: p.score, evidence: { generatedBy: "link-anna-entities", note: p.note, ownerDecision: "2026-09-07: сцепки без слияния" }, ruleVersion: RULE_VERSION, status: "RESOLVED", decision: "LINK", decisionReason: "auto: " + p.note, resolvedAt: now }],
            skipDuplicates: true,
          });
          await tx.loyaltyReconciliationCase.updateMany({ where: { id: caseId, status: "OPEN" }, data: { status: "RESOLVED", decision: "LINK", decisionReason: "auto: " + p.note, resolvedAt: now, version: { increment: 1 } } });
          await tx.loyaltyEntityLink.create({
            data: { ...owner, targetType: p.kind, targetId: p.targetId, status: "CONFIRMED", reconciliationCaseId: caseId, evidence: { matchCodes: p.matchCodes, decision: "LINK", generatedBy: "link-anna-entities", note: p.note }, ruleVersion: RULE_VERSION, createdById: ACTOR, decidedById: ACTOR, decidedAt: now },
          });
          await tx.loyaltyEntityChange.create({ data: { ...owner, action: "UPDATE", changedFields: ["reconciliationDecision"], beforeValues: { link: null }, afterValues: { link: { targetType: p.kind, targetId: p.targetId, decision: "LINK" } }, actorId: ACTOR } });
          written++;
        }
      });
      console.log(`— записано ${written}/${plan.length} —`);
    }
    console.log(`written=${written}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}

module.exports = { pickMostActive, activityScore, normPhone, stableUuid };
