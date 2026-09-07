#!/usr/bin/env node
/**
 * 2026-09-07: точечная привязка спорных строк реестра сделок к лидам amoCRM
 * по решению владельца («брать самую позднюю не-красную строку таблицы»).
 *
 * Вход — JSON из data-ветки: {"links":[{amoLeadId, contractNumber,
 * amountRub}]}. Для каждой записи ищется строка registry_deals с точным
 * contractNumber и суммой (amount = amountRub) БЕЗ amoLeadId; ей ставится
 * amoLeadId и source='BOTH'. Если для этого лида есть отдельная строка
 * AMO_ONLY (rowKey = amo:<leadId>) — она удаляется как поглощённая.
 * Неоднозначность (0 или >1 подходящих строк) — пропуск со счётчиком.
 *
 * DRY_RUN=1 (по умолчанию) — только план. DRY_RUN=0 — запись.
 * Запуск в контейнере api (workflow apply-registry-deal-links.yml):
 *   DRY_RUN=1 node /app/scripts/apply-registry-deal-links.js /app/registry-deal-links.json
 */

function planLink(link, candidates, amoOnlyRow) {
  const target = candidates.filter((r) => r.amoLeadId === null || r.amoLeadId === undefined);
  if (candidates.some((r) => r.amoLeadId !== null && r.amoLeadId !== undefined && String(r.amoLeadId) === String(link.amoLeadId))) {
    return { status: "already", row: candidates.find((r) => String(r.amoLeadId) === String(link.amoLeadId)) };
  }
  if (target.length !== 1) return { status: target.length === 0 ? "not-found" : "ambiguous", count: target.length };
  return { status: "link", row: target[0], dropAmoOnly: amoOnlyRow || null };
}

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const file = process.argv[2];
  if (!file) throw new Error("usage: apply-registry-deal-links.js <links.json>");
  const input = JSON.parse(require("fs").readFileSync(file, "utf8"));
  const links = Array.isArray(input) ? input : input.links || [];
  console.log(`=== Режим: ${dryRun ? "DRY-RUN (только план)" : "APPLY (запись в БД!)"} · записей: ${links.length} ===\n`);
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const totals = { linked: 0, already: 0, notFound: 0, ambiguous: 0, amoOnlyDropped: 0, failed: 0 };
  try {
    for (const link of links) {
      const candidates = await prisma.registryDeal.findMany({
        where: { contractNumber: String(link.contractNumber), amount: link.amountRub },
        select: { id: true, rowKey: true, source: true, amount: true, signedAt: true, amoLeadId: true },
      });
      const amoOnlyRow = await prisma.registryDeal.findUnique({
        where: { rowKey: `amo:${link.amoLeadId}` },
        select: { id: true, rowKey: true, source: true, amount: true },
      });
      const plan = planLink(link, candidates, amoOnlyRow);
      const head = `лид ${link.amoLeadId} → «${link.contractNumber}» ${link.amountRub} ₽`;
      if (plan.status === "already") { totals.already++; console.log(`УЖЕ ПРИВЯЗАНО ${head}`); continue; }
      if (plan.status === "not-found") { totals.notFound++; console.log(`НЕ НАЙДЕНО ${head} (кандидатов без лида: 0)`); continue; }
      if (plan.status === "ambiguous") { totals.ambiguous++; console.log(`НЕОДНОЗНАЧНО ${head} (кандидатов: ${plan.count})`); continue; }
      console.log(`ПРИВЯЗКА ${head}: строка ${plan.row.rowKey} (${plan.row.source}, ${plan.row.signedAt ? new Date(plan.row.signedAt).toISOString().slice(0, 10) : "без даты"})${plan.dropAmoOnly ? `; удалить AMO_ONLY ${plan.dropAmoOnly.rowKey}` : ""}`);
      if (dryRun) continue;
      try {
        await prisma.$transaction(async (tx) => {
          if (plan.dropAmoOnly) { await tx.registryDeal.delete({ where: { id: plan.dropAmoOnly.id } }); totals.amoOnlyDropped++; }
          await tx.registryDeal.update({ where: { id: plan.row.id }, data: { amoLeadId: BigInt(link.amoLeadId), source: "BOTH" } });
        });
        totals.linked++;
        console.log("   ✓ записано");
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

module.exports = { planLink };
