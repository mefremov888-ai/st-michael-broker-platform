#!/usr/bin/env node
/**
 * 2026-09-13: у 164 брокеров со сделками ноль засчитанных встреч. План
 * привязки спорных карточек добавляет всего 11 встреч — значит причина
 * другая. Смотрим по этим брокерам: есть ли у них заявки, из какого они
 * кабинета, попадают ли телефоны их клиентов в карточки колл-центра,
 * и есть ли встречи в «незасчитываемых» статусах. Только SELECT-ы.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const q = (sql) => prisma.$queryRawUnsafe(sql);
  const n = (v) => Number(v ?? 0);

  const ZERO = `
    WITH d AS (SELECT DISTINCT broker_id FROM registry_deals WHERE broker_id IS NOT NULL AND paid_at IS NOT NULL)
    SELECT d.broker_id FROM d
    WHERE NOT EXISTS (
      SELECT 1 FROM meetings mm WHERE mm.broker_id = d.broker_id
        AND mm.status IN ('CONFIRMED','COMPLETED') AND mm.type <> 'BROKER_TOUR')
  `;

  try {
    const summary = await q(`
      WITH z AS (${ZERO})
      SELECT
        COUNT(*)::int AS brokers,
        COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM clients c WHERE c.broker_id = z.broker_id) = 0)::int AS no_clients,
        COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM meetings m WHERE m.broker_id = z.broker_id) > 0)::int AS has_other_meetings,
        COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM brokers b WHERE b.id = z.broker_id AND b.amo_contact_id IS NULL) = 1)::int AS no_amo_contact,
        COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM brokers b WHERE b.id = z.broker_id AND b.password_hash IS NULL) = 1)::int AS never_registered
      FROM z
    `);
    const s = summary[0];
    console.log("=== БРОКЕРЫ СО СДЕЛКАМИ И НУЛЁМ ЗАСЧИТАННЫХ ВСТРЕЧ ===");
    console.log(`  всего:                              ${n(s.brokers)}`);
    console.log(`  вообще нет заявок в кабинете:       ${n(s.no_clients)}`);
    console.log(`  встречи есть, но не засчитываются:  ${n(s.has_other_meetings)}`);
    console.log(`  нет контакта в amoCRM:              ${n(s.no_amo_contact)}`);
    console.log(`  никогда не заходили в кабинет:      ${n(s.never_registered)}`);

    const clientStats = await q(`
      WITH z AS (${ZERO})
      SELECT
        SUM((SELECT COUNT(*) FROM clients c WHERE c.broker_id = z.broker_id))::int AS clients_total,
        SUM((SELECT COUNT(*) FROM clients c WHERE c.broker_id = z.broker_id AND c.comment LIKE '[old-cabinet:%'))::int AS clients_old,
        SUM((SELECT COUNT(*) FROM clients c WHERE c.broker_id = z.broker_id AND c.amo_lead_id IS NOT NULL))::int AS clients_with_lead
      FROM z
    `);
    const c = clientStats[0];
    console.log(`  заявок у них суммарно:              ${n(c.clients_total)}`);
    console.log(`    из них старый кабинет:            ${n(c.clients_old)}`);
    console.log(`    из них с лидом amoCRM:            ${n(c.clients_with_lead)}`);

    const byStatus = await q(`
      WITH z AS (${ZERO})
      SELECT m.status::text AS s, m.type::text AS t, COUNT(*)::int AS c
      FROM meetings m JOIN z ON z.broker_id = m.broker_id
      GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8
    `);
    console.log("  какие встречи у них ЕСТЬ (статус/тип):");
    if (!byStatus.length) console.log("    нет ни одной записи о встрече");
    for (const r of byStatus) console.log(`    ${r.s} / ${r.t}: ${n(r.c)}`);

    // сделки этих брокеров: как они попали в реестр
    const deals = await q(`
      WITH z AS (${ZERO})
      SELECT
        COUNT(*)::int AS deals,
        COUNT(*) FILTER (WHERE rd.broker_amo_contact_id IS NOT NULL)::int AS via_amo_contact,
        COUNT(*) FILTER (WHERE rd.sale_channel = 'BROKER')::int AS channel_broker,
        MIN(rd.paid_at)::text AS first_deal,
        MAX(rd.paid_at)::text AS last_deal
      FROM registry_deals rd JOIN z ON z.broker_id = rd.broker_id
      WHERE rd.paid_at IS NOT NULL
    `);
    const d = deals[0];
    console.log("\n=== ИХ СДЕЛКИ ===");
    console.log(`  сделок всего:                       ${n(d.deals)}`);
    console.log(`  привязаны через контакт amoCRM:     ${n(d.via_amo_contact)}`);
    console.log(`  канал «через брокера»:              ${n(d.channel_broker)}`);
    console.log(`  период:                             ${d.first_deal} — ${d.last_deal}`);

    // для сравнения: те, у кого встречи ЕСТЬ
    const withMeetings = await q(`
      WITH d AS (SELECT DISTINCT broker_id FROM registry_deals WHERE broker_id IS NOT NULL AND paid_at IS NOT NULL),
      w AS (SELECT d.broker_id FROM d WHERE EXISTS (
        SELECT 1 FROM meetings mm WHERE mm.broker_id = d.broker_id
          AND mm.status IN ('CONFIRMED','COMPLETED') AND mm.type <> 'BROKER_TOUR'))
      SELECT COUNT(*)::int AS brokers,
             SUM((SELECT COUNT(*) FROM clients c WHERE c.broker_id = w.broker_id))::int AS clients_total
      FROM w
    `);
    const wm = withMeetings[0];
    console.log("\n=== ДЛЯ СРАВНЕНИЯ: брокеры со сделками И встречами ===");
    console.log(`  брокеров:                           ${n(wm.brokers)}`);
    console.log(`  заявок у них суммарно:              ${n(wm.clients_total)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
