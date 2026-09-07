#!/usr/bin/env node
/**
 * 2026-09-07: склейка дублей агентств (латиница ↔ кириллица) по решению
 * владельца («склеить все пары; выживает карточка с бОльшим числом
 * сделок/брокеров, имя — русское написание»).
 *
 * Вход — JSON из data-ветки: {"clusters":[{survivorName, finalName,
 * mergeNames:[...], pairs:[...]}]}. Карточки ищутся по ТОЧНОМУ имени
 * (trim); если имя не найдено или найдено >1 раза — вся группа
 * пропускается со счётчиком (ничего наполовину не склеиваем).
 *
 * Что делает для каждой группы (одна транзакция):
 *   1. brokerAgencies: связь брокера с поглощаемой карточкой переносится на
 *      выжившую; если у брокера уже есть связь с выжившей — лишняя удаляется,
 *      признак primary сохраняется.
 *   2. deals.agencyId, clients.fixationAgencyId → выжившая.
 *   3. Лояльность: loyalty_call_assignments / loyalty_tasks /
 *      loyalty_engagement_events (our_agency_id), loyalty_entity_links и
 *      loyalty_reconciliation_cases (targetType=AGENCY) → выжившая.
 *   4. registry_deals.agencyCanonical: строки с названием поглощаемой
 *      карточки получают финальное имя, чтобы атрибуция сделок реестра по
 *      названию не потерялась после переименования.
 *   5. Реквизиты: пустые phone/email/address/legalName/legalAddress выжившей
 *      заполняются из поглощаемых; настоящий ИНН (10/12 цифр) заменяет
 *      плейсхолдер NOINN-* у выжившей.
 *   6. name выжившей = finalName; поглощаемые удаляются; в audit_logs
 *      пишется запись AGENCY_MERGE с прежними именами и ИНН.
 *
 * DRY_RUN=1 (по умолчанию) — только план и счётчики. DRY_RUN=0 — запись.
 * Запуск в контейнере api (workflow apply-agency-merges.yml):
 *   DRY_RUN=1 node /app/scripts/merge-agency-duplicates.js /app/agency-merges.json
 */

const { canonicalAgencyMatchKey, isRealInn, isPlaceholderInn } = require("./enrich-agencies-from-amo");

const empty = (v) => v === null || v === undefined || String(v).trim() === "";

/** Какие реквизиты выжившей заполнить из поглощаемых (чистая функция). */
function planRequisites(survivor, losers) {
  const data = {};
  for (const field of ["legalName", "phone", "email", "address", "legalAddress"]) {
    if (!empty(survivor[field])) continue;
    const donor = losers.find((l) => !empty(l[field]));
    if (donor) data[field] = String(donor[field]).trim();
  }
  if (isPlaceholderInn(survivor.inn)) {
    const donor = losers.find((l) => isRealInn(l.inn));
    if (donor) data.inn = String(donor.inn).trim();
  }
  return data;
}

/** Ключи названий поглощаемых карточек для registry_deals. */
function loserNameKeys(losers) {
  const keys = new Set();
  for (const l of losers) {
    for (const v of [l.name, l.legalName]) {
      const k = canonicalAgencyMatchKey(v);
      if (k) keys.add(k);
    }
  }
  return keys;
}

async function resolveCluster(prisma, cluster) {
  const names = [cluster.survivorName, ...(cluster.mergeNames || [])].map((n) => String(n).trim());
  const found = await prisma.agency.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true, legalName: true, inn: true, phone: true, email: true, address: true, legalAddress: true },
  });
  const byName = new Map();
  for (const a of found) {
    const k = a.name.trim();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(a);
  }
  const problems = [];
  for (const n of names) {
    const list = byName.get(n) || [];
    if (list.length === 0) problems.push(`не найдено: «${n}»`);
    else if (list.length > 1) problems.push(`неоднозначно (${list.length} карточек): «${n}»`);
  }
  if (problems.length) return { ok: false, problems };
  const survivor = byName.get(names[0])[0];
  const losers = names.slice(1).map((n) => byName.get(n)[0]);
  return { ok: true, survivor, losers };
}

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const file = process.argv[2];
  if (!file) throw new Error("usage: merge-agency-duplicates.js <clusters.json>");
  const input = JSON.parse(require("fs").readFileSync(file, "utf8"));
  const clusters = Array.isArray(input) ? input : input.clusters || [];
  console.log(`=== Режим: ${dryRun ? "DRY-RUN (только план)" : "APPLY (запись в БД!)"} · групп: ${clusters.length} ===\n`);

  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const totals = { clusters: 0, skipped: 0, losers: 0, links: 0, linksDropped: 0, deals: 0, clients: 0, loyalty: 0, registryRows: 0, renamed: 0, merged: 0, failed: 0 };
  try {
    const registryRows = await prisma.registryDeal.findMany({
      where: { OR: [{ agencyCanonical: { not: null } }, { agencyNameRaw: { not: null } }] },
      select: { id: true, agencyCanonical: true, agencyNameRaw: true },
    });

    for (const cluster of clusters) {
      const label = `[${(cluster.pairs || []).join(",")}] ${cluster.finalName}`;
      const res = await resolveCluster(prisma, cluster);
      if (!res.ok) {
        totals.skipped++;
        console.log(`ПРОПУСК ${label}: ${res.problems.join("; ")}`);
        continue;
      }
      const { survivor, losers } = res;
      const loserIds = losers.map((l) => l.id);
      totals.clusters++;
      totals.losers += losers.length;

      const [links, survivorLinks, deals, clients, la, lt, le, lel, lrc] = await Promise.all([
        prisma.brokerAgency.findMany({ where: { agencyId: { in: loserIds } }, select: { id: true, brokerId: true, isPrimary: true } }),
        prisma.brokerAgency.findMany({ where: { agencyId: survivor.id }, select: { id: true, brokerId: true, isPrimary: true } }),
        prisma.deal.count({ where: { agencyId: { in: loserIds } } }),
        prisma.client.count({ where: { fixationAgencyId: { in: loserIds } } }),
        prisma.loyaltyCallAssignment.count({ where: { ourAgencyId: { in: loserIds } } }),
        prisma.loyaltyTask.count({ where: { ourAgencyId: { in: loserIds } } }),
        prisma.loyaltyEngagementEvent.count({ where: { ourAgencyId: { in: loserIds } } }),
        prisma.loyaltyEntityLink.count({ where: { targetType: "AGENCY", targetId: { in: loserIds } } }),
        prisma.loyaltyReconciliationCase.count({ where: { targetType: "AGENCY", targetId: { in: loserIds } } }),
      ]);
      const survivorByBroker = new Map(survivorLinks.map((l) => [l.brokerId, l]));
      const toMove = links.filter((l) => !survivorByBroker.has(l.brokerId));
      const toDrop = links.filter((l) => survivorByBroker.has(l.brokerId));
      const promoteSurvivorFor = toDrop.filter((l) => l.isPrimary && !survivorByBroker.get(l.brokerId).isPrimary).map((l) => survivorByBroker.get(l.brokerId).id);
      const keys = loserNameKeys(losers);
      const regRows = registryRows.filter((r) => {
        const k = canonicalAgencyMatchKey(r.agencyCanonical) ?? canonicalAgencyMatchKey(r.agencyNameRaw);
        return k && keys.has(k);
      });
      const requisites = planRequisites(survivor, losers);
      const rename = survivor.name.trim() !== String(cluster.finalName).trim();
      const loyalty = la + lt + le + lel + lrc;
      totals.links += toMove.length; totals.linksDropped += toDrop.length; totals.deals += deals; totals.clients += clients; totals.loyalty += loyalty; totals.registryRows += regRows.length; if (rename) totals.renamed++;

      console.log(`${label}: выживает «${survivor.name}» (ИНН ${survivor.inn}) ← ${losers.map((l) => `«${l.name}» (${l.inn})`).join(", ")}`);
      console.log(`   связи брокеров: перенос ${toMove.length}, лишних ${toDrop.length}; сделки ${deals}; клиенты ${clients}; лояльность ${loyalty}; реестр ${regRows.length}; реквизиты: ${Object.keys(requisites).join(", ") || "—"}${rename ? `; имя → «${cluster.finalName}»` : ""}`);

      if (dryRun) continue;
      try {
        await prisma.$transaction(async (tx) => {
          if (toDrop.length) await tx.brokerAgency.deleteMany({ where: { id: { in: toDrop.map((l) => l.id) } } });
          if (promoteSurvivorFor.length) await tx.brokerAgency.updateMany({ where: { id: { in: promoteSurvivorFor } }, data: { isPrimary: true } });
          if (toMove.length) await tx.brokerAgency.updateMany({ where: { id: { in: toMove.map((l) => l.id) } }, data: { agencyId: survivor.id } });
          await tx.deal.updateMany({ where: { agencyId: { in: loserIds } }, data: { agencyId: survivor.id } });
          await tx.client.updateMany({ where: { fixationAgencyId: { in: loserIds } }, data: { fixationAgencyId: survivor.id } });
          await tx.loyaltyCallAssignment.updateMany({ where: { ourAgencyId: { in: loserIds } }, data: { ourAgencyId: survivor.id } });
          await tx.loyaltyTask.updateMany({ where: { ourAgencyId: { in: loserIds } }, data: { ourAgencyId: survivor.id } });
          await tx.loyaltyEngagementEvent.updateMany({ where: { ourAgencyId: { in: loserIds } }, data: { ourAgencyId: survivor.id } });
          await tx.loyaltyEntityLink.updateMany({ where: { targetType: "AGENCY", targetId: { in: loserIds } }, data: { targetId: survivor.id } });
          await tx.loyaltyReconciliationCase.updateMany({ where: { targetType: "AGENCY", targetId: { in: loserIds } }, data: { targetId: survivor.id } });
          if (regRows.length) await tx.registryDeal.updateMany({ where: { id: { in: regRows.map((r) => r.id) } }, data: { agencyCanonical: String(cluster.finalName).trim() } });
          // ИНН уникален: сначала освобождаем его у донора.
          if (requisites.inn) {
            const donor = losers.find((l) => String(l.inn).trim() === requisites.inn);
            if (donor) await tx.agency.update({ where: { id: donor.id }, data: { inn: `NOINN-merged-${donor.id.slice(0, 8)}` } });
          }
          await tx.agency.deleteMany({ where: { id: { in: loserIds } } });
          await tx.agency.update({ where: { id: survivor.id }, data: { ...requisites, name: String(cluster.finalName).trim() } });
          await tx.auditLog.create({
            data: {
              action: "AGENCY_MERGE",
              entity: "Agency",
              entityId: survivor.id,
              payload: { finalName: cluster.finalName, survivor: { id: survivor.id, name: survivor.name, inn: survivor.inn }, merged: losers.map((l) => ({ id: l.id, name: l.name, inn: l.inn })), pairs: cluster.pairs || [], requisites },
            },
          });
        });
        totals.merged++;
        console.log(`   ✓ склеено`);
      } catch (e) {
        totals.failed++;
        console.error(`   ✗ ошибка: ${e?.message || e}`);
      }
    }
    console.log("\n=== Итого ===");
    console.log(JSON.stringify(totals));
    if (dryRun) console.log("DRY-RUN: ничего не записано. Для записи DRY_RUN=0.");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}

module.exports = { planRequisites, loserNameKeys };
