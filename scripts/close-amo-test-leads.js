#!/usr/bin/env node
/**
 * 2026-09-07 (решение владельца, п.16): тестовые лиды test-kit в amoCRM
 * закрыть. amoCRM API v4 не удаляет лиды — поэтому переводим в «Закрыто и не
 * реализовано» (143) в их же воронке и переименовываем «ТЕСТ — удалить: …».
 *
 * Вход: LEAD_IDS="32329985,32329987,…" (обязателен), DRY_RUN=1 по умолчанию.
 * Ничего не трогает в БД кабинета. Компании через API не удаляются и не
 * переименовываются здесь (только UI amo).
 *
 * Запуск в контейнере api (workflow ops-close-amo-test-leads.yml).
 */

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const ids = String(process.env.LEAD_IDS || "").split(/[,;\s]+/).map((s) => Number(s)).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) throw new Error("LEAD_IDS пуст");
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const tokenRows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(tokenRows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "close-amo-test-leads" }, create: { key, value, updatedBy: "close-amo-test-leads" } });
      }
    });
    const amo = new AmoCrmAdapter();
    console.log(`=== Режим: ${dryRun ? "DRY-RUN" : "APPLY (закрытие лидов в amo!)"} · лидов: ${ids.length} ===`);
    const q = ids.map((id) => `filter[id][]=${id}`).join("&");
    const res = await amo["request"](`/leads?${q}&limit=250`);
    const leads = res?._embedded?.leads || [];
    const found = new Map(leads.map((l) => [Number(l.id), l]));
    const updates = [];
    for (const id of ids) {
      const l = found.get(id);
      if (!l) { console.log(`  • лид ${id}: НЕ НАЙДЕН (уже удалён?)`); continue; }
      const already = Number(l.status_id) === 143;
      console.log(`  • лид ${id}: «${l.name}» воронка ${l.pipeline_id} статус ${l.status_id}${already ? " (уже закрыт)" : ""}`);
      const name = String(l.name || "").startsWith("ТЕСТ — удалить") ? l.name : `ТЕСТ — удалить: ${l.name || id}`;
      updates.push({ id, pipeline_id: l.pipeline_id, status_id: 143, name });
    }
    // Клиенты кабинета, привязанные к этим лидам (для справки).
    const linked = await prisma.client.count({ where: { amoLeadId: { in: ids.map((n) => BigInt(n)) } } });
    console.log(`Записей клиентов кабинета с этими лидами: ${linked} (не трогаем)`);
    if (dryRun) { console.log("DRY-RUN: ничего не изменено."); return; }
    if (!updates.length) return;
    const out = await amo["request"](`/leads`, { method: "PATCH", body: JSON.stringify(updates) });
    const done = out?._embedded?.leads?.length ?? 0;
    console.log(`Закрыто/переименовано: ${done}`);
    console.log("RESULT: " + JSON.stringify({ requested: ids.length, found: found.size, updated: done }));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}
