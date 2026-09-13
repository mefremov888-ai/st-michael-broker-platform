#!/usr/bin/env node
/**
 * 2026-09-13: Анна проверила «Нашу базу» и написала: у кого есть сделки —
 * по-прежнему 0 встреч; фиксаций по месяцам втрое меньше ожидаемого.
 * Скрипт считает, сколько строк отсекает каждый фильтр, и где расходятся
 * «всего в базе» и «показано в кабинете». Только SELECT-ы, ничего не меняет.
 */

const MONTHS = 18;

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const q = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args);
  const n = (v) => Number(v ?? 0);

  try {
    // ── 1. Фиксации: сколько теряется на каждом шаге ────────────────────
    const fixationFilter = `(
      c.fixation_status IN ('FIXED','EXPIRED')
      OR c.uniqueness_status IN ('CONDITIONALLY_UNIQUE','EXPIRED')
    )`;

    const totals = await q(`
      SELECT
        COUNT(*)::int AS all_clients,
        COUNT(*) FILTER (WHERE ${fixationFilter})::int AS pass_status,
        COUNT(*) FILTER (WHERE ${fixationFilter} AND b.role = 'BROKER')::int AS pass_role,
        COUNT(*) FILTER (WHERE ${fixationFilter} AND b.role = 'BROKER' AND b.merged_into_id IS NULL)::int AS shown,
        COUNT(*) FILTER (WHERE c.uniqueness_status = 'REJECTED')::int AS rejected,
        COUNT(*) FILTER (WHERE c.uniqueness_status = 'UNDER_REVIEW')::int AS under_review,
        COUNT(*) FILTER (WHERE ${fixationFilter} AND b.role <> 'BROKER')::int AS not_broker_role,
        COUNT(*) FILTER (WHERE ${fixationFilter} AND b.merged_into_id IS NOT NULL)::int AS merged_broker,
        COUNT(*) FILTER (WHERE c.comment LIKE '[old-cabinet:%')::int AS old_cabinet,
        COUNT(*) FILTER (WHERE c.comment IS NULL OR c.comment NOT LIKE '[old-cabinet:%')::int AS new_cabinet
      FROM clients c LEFT JOIN brokers b ON b.id = c.broker_id
    `);
    const t = totals[0];
    console.log("=== ФИКСАЦИИ: что отсекается ===");
    console.log(`  всего записей клиентов:            ${n(t.all_clients)}`);
    console.log(`  проходят статус «фиксация»:        ${n(t.pass_status)}`);
    console.log(`  + брокер с ролью BROKER:           ${n(t.pass_role)}`);
    console.log(`  + карточка брокера не слита:       ${n(t.shown)}   ← столько показывает кабинет`);
    console.log(`  отсеяно «отклонена»:               ${n(t.rejected)}`);
    console.log(`  отсеяно «на проверке»:             ${n(t.under_review)}`);
    console.log(`  отсеяно роль не BROKER:            ${n(t.not_broker_role)}`);
    console.log(`  отсеяно слитая карточка брокера:   ${n(t.merged_broker)}`);
    console.log(`  из них старый кабинет:             ${n(t.old_cabinet)}`);
    console.log(`  из них новый кабинет:              ${n(t.new_cabinet)}`);

    // ── 2. Помесячно ───────────────────────────────────────────────────
    const byMonth = await q(`
      SELECT to_char(date_trunc('month', c.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM') AS m,
             COUNT(*)::int AS all_rows,
             COUNT(*) FILTER (WHERE ${fixationFilter})::int AS pass_status,
             COUNT(*) FILTER (WHERE ${fixationFilter} AND b.role = 'BROKER' AND b.merged_into_id IS NULL)::int AS shown
      FROM clients c LEFT JOIN brokers b ON b.id = c.broker_id
      WHERE c.created_at >= now() - interval '${MONTHS} months'
      GROUP BY 1 ORDER BY 1
    `);
    console.log("\n=== ФИКСАЦИИ ПО МЕСЯЦАМ (всего / проходят статус / показано) ===");
    for (const r of byMonth) {
      console.log(`  ${r.m}: ${String(n(r.all_rows)).padStart(6)} / ${String(n(r.pass_status)).padStart(6)} / ${String(n(r.shown)).padStart(6)}`);
    }

    // ── 2b. Что приходит после разового импорта 07.09 ──────────────────
    const recent = await q(`
      SELECT to_char(date_trunc('week', c.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM-DD') AS w,
             COUNT(*) FILTER (WHERE c.comment LIKE '[old-cabinet:%')::int AS old_rows,
             COUNT(*) FILTER (WHERE c.comment IS NULL OR c.comment NOT LIKE '[old-cabinet:%')::int AS new_rows
      FROM clients c
      WHERE c.created_at >= now() - interval '10 weeks'
      GROUP BY 1 ORDER BY 1
    `);
    console.log("
=== ПО НЕДЕЛЯМ: старый кабинет / новый кабинет ===");
    for (const r of recent) {
      console.log(`  неделя с ${r.w}: старый ${String(n(r.old_rows)).padStart(4)} | новый ${String(n(r.new_rows)).padStart(4)}`);
    }
    const lastOld = await q(`
      SELECT to_char(MAX(created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS last_old,
             to_char(MIN(created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS first_old
      FROM clients WHERE comment LIKE '[old-cabinet:%'
    `);
    console.log(`  записи старого кабинета: с ${lastOld[0].first_old} по ${lastOld[0].last_old}`);

    // ── 3. Встречи ─────────────────────────────────────────────────────
    const meetings = await q(`
      SELECT
        COUNT(*)::int AS all_meetings,
        COUNT(*) FILTER (WHERE status IN ('CONFIRMED','COMPLETED') AND type <> 'BROKER_TOUR')::int AS counted,
        COUNT(*) FILTER (WHERE type = 'BROKER_TOUR')::int AS tours,
        COUNT(*) FILTER (WHERE status NOT IN ('CONFIRMED','COMPLETED'))::int AS other_status
      FROM meetings
    `);
    const m = meetings[0];
    console.log("\n=== ВСТРЕЧИ ===");
    console.log(`  всего записей:                     ${n(m.all_meetings)}`);
    console.log(`  засчитываются в метрику:           ${n(m.counted)}`);
    console.log(`  брокер-туры (в метрику не идут):   ${n(m.tours)}`);
    console.log(`  прочий статус (не идут):           ${n(m.other_status)}`);

    const byStatus = await q(`SELECT status::text AS s, type::text AS t, COUNT(*)::int AS c FROM meetings GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12`);
    console.log("  разбивка статус/тип:");
    for (const r of byStatus) console.log(`    ${r.s} / ${r.t}: ${n(r.c)}`);

    // ── 4. Брокеры со сделками и нулём встреч ──────────────────────────
    const dealBrokers = await q(`
      WITH d AS (SELECT DISTINCT broker_id FROM registry_deals WHERE broker_id IS NOT NULL AND paid_at IS NOT NULL)
      SELECT
        COUNT(*)::int AS with_deals,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM meetings mm
          WHERE mm.broker_id = d.broker_id
            AND mm.status IN ('CONFIRMED','COMPLETED') AND mm.type <> 'BROKER_TOUR'
        ))::int AS zero_meetings
      FROM d
    `);
    const db = dealBrokers[0];
    console.log("\n=== БРОКЕРЫ СО СДЕЛКАМИ ===");
    console.log(`  всего брокеров со сделками:        ${n(db.with_deals)}`);
    console.log(`  из них с нулём засчитанных встреч: ${n(db.zero_meetings)}`);

    const examples = await q(`
      WITH d AS (SELECT DISTINCT broker_id FROM registry_deals WHERE broker_id IS NOT NULL AND paid_at IS NOT NULL)
      SELECT b.id, COALESCE(b.display_name, b.full_name) AS name,
             (SELECT COUNT(*)::int FROM registry_deals rd WHERE rd.broker_id = b.id AND rd.paid_at IS NOT NULL) AS deals,
             (SELECT COUNT(*)::int FROM meetings mm WHERE mm.broker_id = b.id) AS meetings_any,
             (SELECT COUNT(*)::int FROM clients cc WHERE cc.broker_id = b.id) AS clients
      FROM d JOIN brokers b ON b.id = d.broker_id
      WHERE NOT EXISTS (
        SELECT 1 FROM meetings mm WHERE mm.broker_id = b.id
          AND mm.status IN ('CONFIRMED','COMPLETED') AND mm.type <> 'BROKER_TOUR')
      ORDER BY deals DESC LIMIT 8
    `);
    console.log("  примеры (сделок / встреч любых / клиентов):");
    for (const r of examples) {
      console.log(`    ${r.name}: ${n(r.deals)} / ${n(r.meetings_any)} / ${n(r.clients)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
