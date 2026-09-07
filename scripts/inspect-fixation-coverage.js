#!/usr/bin/env node
/**
 * 2026-09-07: контрольные цифры по фиксациям (ТОЛЬКО ЧТЕНИЕ) — снимаются до
 * и после массовых операций (импорт старого кабинета, склейки), чтобы
 * объяснить каждую разницу владельцу. Никаких ПД: только агрегаты.
 *
 * Считает:
 *   - клиенты по статусам уникальности/фиксации и по годам createdAt;
 *   - «фиксации за всё время» по правилу кабинета (FIXED|EXPIRED или
 *     CONDITIONALLY_UNIQUE|EXPIRED), «действующие» (срок не истёк),
 *     отклонённые;
 *   - брокеров с ≥1 фиксацией (lifetime / действующей);
 *   - агентств с ≥1 фиксацией через привязанных брокеров;
 *   - исторических записей старого кабинета ([old-cabinet:…]).
 *
 * Запуск в контейнере api (workflow inspect-fixation-coverage.yml):
 *   node /app/scripts/inspect-fixation-coverage.js
 */

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const now = new Date();
  const lifetimeWhere = {
    OR: [
      { fixationStatus: { in: ["FIXED", "EXPIRED"] } },
      { uniquenessStatus: { in: ["CONDITIONALLY_UNIQUE", "EXPIRED"] } },
    ],
  };
  const activeWhere = {
    OR: [
      { fixationStatus: "FIXED", OR: [{ fixationExpiresAt: null }, { fixationExpiresAt: { gt: now } }] },
      { uniquenessStatus: "CONDITIONALLY_UNIQUE", OR: [{ uniquenessExpiresAt: null }, { uniquenessExpiresAt: { gt: now } }] },
    ],
  };
  try {
    const total = await prisma.client.count();
    const byUniq = await prisma.client.groupBy({ by: ["uniquenessStatus"], _count: { _all: true } });
    const byFix = await prisma.client.groupBy({ by: ["fixationStatus"], _count: { _all: true } });
    const lifetime = await prisma.client.count({ where: lifetimeWhere });
    const active = await prisma.client.count({ where: activeWhere });
    const rejected = await prisma.client.count({ where: { uniquenessStatus: "REJECTED" } });
    const historical = await prisma.client.count({ where: { comment: { startsWith: "[old-cabinet:" } } });
    const brokersLifetime = await prisma.broker.count({ where: { mergedIntoId: null, clients: { some: lifetimeWhere } } });
    const brokersActive = await prisma.broker.count({ where: { mergedIntoId: null, clients: { some: activeWhere } } });
    const agenciesLifetime = await prisma.agency.count({ where: { brokerAgencies: { some: { broker: { clients: { some: lifetimeWhere } } } } } });
    const agenciesActive = await prisma.agency.count({ where: { brokerAgencies: { some: { broker: { clients: { some: activeWhere } } } } } });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT EXTRACT(YEAR FROM created_at)::int AS y, COUNT(*)::int AS n FROM clients GROUP BY 1 ORDER BY 1`,
    );
    console.log("=== Контрольные цифры по фиксациям ===");
    console.log(`Клиентов всего:                          ${total}`);
    console.log(`  исторических (старый кабинет):          ${historical}`);
    console.log(`Фиксаций за всё время (правило кабинета): ${lifetime}`);
    console.log(`Действующих фиксаций:                     ${active}`);
    console.log(`Отклонённых (REJECTED):                   ${rejected}`);
    console.log(`Брокеров с фиксациями (за всё время):     ${brokersLifetime}`);
    console.log(`Брокеров с действующими:                  ${brokersActive}`);
    console.log(`Агентств с фиксациями (через брокеров):   ${agenciesLifetime}`);
    console.log(`Агентств с действующими:                  ${agenciesActive}`);
    console.log(`По статусу уникальности: ${byUniq.map((g) => `${g.uniquenessStatus}=${g._count._all}`).join(", ")}`);
    console.log(`По статусу фиксации:     ${byFix.map((g) => `${g.fixationStatus}=${g._count._all}`).join(", ")}`);
    console.log(`По годам создания:       ${rows.map((r) => `${r.y}: ${r.n}`).join(", ")}`);
    console.log(`JSON: ${JSON.stringify({ total, historical, lifetime, active, rejected, brokersLifetime, brokersActive, agenciesLifetime, agenciesActive })}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}
