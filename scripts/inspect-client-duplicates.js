#!/usr/bin/env node
/**
 * 2026-09-08 (ночь): проверка дублей клиентов после бага NULL-комментария
 * (notHistoricalClientWhere отбрасывал записи без комментария → синк amo
 * мог создать вторую запись клиента с тем же телефоном у того же брокера).
 * Только чтение.
 *
 * Вход: SINCE (ISO, по умолчанию 2026-09-07T06:00:00Z — деплой поезда 20).
 * Показывает: пары «новая запись (createdAt ≥ SINCE) + старая запись с тем же
 * телефоном и брокером», разбивку по источнику новой записи (amoLeadId есть /
 * нет), и общую картину «один телефон у одного брокера несколько раз».
 */

const mask = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };

async function main() {
  const since = new Date(process.env.SINCE || "2026-09-07T06:00:00Z");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT n.id AS new_id, n.phone, n.broker_id AS broker_id, n.created_at AS new_created, n.amo_lead_id::text AS new_lead,
              o.id AS old_id, o.created_at AS old_created, o.amo_lead_id::text AS old_lead,
              (o.comment LIKE '[old-cabinet:%') AS old_is_hist
       FROM clients n
       JOIN clients o ON o.phone = n.phone AND o.broker_id = n.broker_id AND o.id <> n.id AND o.created_at < n.created_at
       WHERE n.created_at >= $1 AND (n.comment IS NULL OR n.comment NOT LIKE '[old-cabinet:%')
       ORDER BY n.created_at DESC`,
      since,
    );
    console.log(`=== Дубли клиентов (новая запись с ${since.toISOString()} + старая с тем же телефоном и брокером): ${rows.length} ===`);
    const byKind = { oldIsHistorical: 0, oldIsNew: 0, newFromAmo: 0, newManual: 0 };
    for (const r of rows) {
      if (r.old_is_hist) byKind.oldIsHistorical++; else byKind.oldIsNew++;
      if (r.new_lead) byKind.newFromAmo++; else byKind.newManual++;
    }
    console.log(`  старая запись — история старого кабинета: ${byKind.oldIsHistorical}; старая — новый кабинет: ${byKind.oldIsNew}`);
    console.log(`  новая запись — из amo (есть лид): ${byKind.newFromAmo}; заведена вручную/иначе: ${byKind.newManual}`);
    for (const r of rows.slice(0, 20)) {
      console.log(`  • ${mask(r.phone)} брокер ${String(r.broker_id).slice(0, 8)}… новая ${new Date(r.new_created).toISOString().slice(0, 16)} (лид ${r.new_lead || "—"}) ↔ старая ${new Date(r.old_created).toISOString().slice(0, 16)} (лид ${r.old_lead || "—"}${r.old_is_hist ? ", история" : ""})`);
    }
    const totalNew = await prisma.client.count({ where: { createdAt: { gte: since }, OR: [{ comment: null }, { NOT: { comment: { startsWith: "[old-cabinet:" } } }] } });
    console.log(`Всего записей нового кабинета, созданных с ${since.toISOString().slice(0, 16)}: ${totalNew}`);
    const dup = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS pairs FROM (SELECT phone, broker_id FROM clients WHERE comment IS NULL OR comment NOT LIKE '[old-cabinet:%' GROUP BY phone, broker_id HAVING COUNT(*) > 1) t`,
    );
    console.log(`Всего «телефон+брокер» с несколькими записями нового кабинета (за всё время): ${dup?.[0]?.pairs ?? "н/д"}`);
    console.log("RESULT: " + JSON.stringify({ since: since.toISOString(), duplicatesSince: rows.length, ...byKind, totalNewSince: totalNew, allTimePairs: dup?.[0]?.pairs ?? null }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
