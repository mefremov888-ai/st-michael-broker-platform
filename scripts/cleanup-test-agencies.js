#!/usr/bin/env node
/**
 * 2026-09-04: разовая чистка ТЕСТОВЫХ агентств из БД кабинета.
 *
 * 12 агентств, подтверждённых пользователем к удалению, идентифицируются по
 * ИНН (agencies.inn — уникальный ключ). Скрипт:
 *   1. Находит агентства по ИНН, печатает id / name / inn.
 *   2. Считает ВСЕ связи на Agency из schema.prisma:
 *        - broker_agencies (NOT NULL FK) + ФИО/телефоны привязанных брокеров
 *        - deals.agency_id                (nullable FK)
 *        - clients.fixation_agency_id     (soft-ссылка без FK, nullable)
 *        - loyalty_call_assignments.our_agency_id (nullable FK, Restrict)
 *        - loyalty_tasks.our_agency_id            (nullable FK, Restrict)
 *        - loyalty_engagement_events.our_agency_id (nullable FK, Restrict)
 *        - loyalty_entity_links (target_type=AGENCY, target_id NOT NULL —
 *          блокирует удаление, ссылку занулить нельзя)
 *   3. Ищет следы в amoCRM: GET /api/v4/companies?query=<ИНН|название>
 *      (limit 5) — только чтение, в amo НИЧЕГО не меняется.
 *   4. С флагом --apply: транзакцией на агентство — удаляет broker_agencies,
 *      занулят nullable-ссылки, удаляет само агентство. Агентство с непустой
 *      NOT NULL-зависимостью (loyalty_entity_links) пропускается с сообщением.
 *      Брокеры НЕ удаляются.
 *
 * По умолчанию dry-run (только печать). Запуск в контейнере api
 * (workflow cleanup-test-agencies.yml):
 *   node /app/scripts/cleanup-test-agencies.js [--apply]
 */

const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ИНН тестовых агентств, подтверждённых к удалению (2026-09-03).
const TEST_INNS = [
  "7894561232",
  "1232133424",
  "1234567891",
  "121234233221",
  "1234567897",
  "1234567890",
  "1233456789",
  "7894561231",
  "123456789777",
  "123789456112",
  "123456678945",
  "1178885692",
];

(async () => {
  // Без NestFactory(AppModule): полный контекст запускает шедулеры (кроны
  // синка) внутри скрипта — дублирование и записи в БД. Токены amo загружаем
  // напрямую из SystemSetting (как export-amo-deals.js), hook на refresh
  // обязателен — refresh_token ротируется при каждом использовании.
  const {
    AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook,
  } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();

  try {
    console.log(`=== Режим: ${APPLY ? "APPLY (удаление!)" : "DRY-RUN (только чтение)"} ===\n`);

    // ─── 1. Агентства по ИНН ───
    const agencies = await prisma.agency.findMany({
      where: { inn: { in: TEST_INNS } },
      select: { id: true, name: true, legalName: true, inn: true },
      orderBy: { name: "asc" },
    });
    const foundInns = new Set(agencies.map((a) => a.inn));
    const missing = TEST_INNS.filter((inn) => !foundInns.has(inn));

    console.log(`Найдено агентств: ${agencies.length} из ${TEST_INNS.length}`);
    for (const a of agencies) {
      console.log(`  • ${a.id} | «${a.name}»${a.legalName ? ` (${a.legalName})` : ""} | ИНН ${a.inn}`);
    }
    if (missing.length > 0) {
      console.log(`Не найдены в БД (уже удалены или ИНН отличается): ${missing.join(", ")}`);
    }
    console.log("");

    // ─── 2. Связи каждого агентства (все relations на Agency из schema.prisma) ───
    const plans = [];
    for (const a of agencies) {
      const brokerAgencies = await prisma.brokerAgency.findMany({
        where: { agencyId: a.id },
        select: {
          id: true,
          isPrimary: true,
          broker: { select: { id: true, fullName: true, phone: true } },
        },
      });
      const [deals, clients, loyaltyAssignments, loyaltyTasks, loyaltyEvents, entityLinks] =
        await Promise.all([
          prisma.deal.count({ where: { agencyId: a.id } }),
          prisma.client.count({ where: { fixationAgencyId: a.id } }),
          prisma.loyaltyCallAssignment.count({ where: { ourAgencyId: a.id } }),
          prisma.loyaltyTask.count({ where: { ourAgencyId: a.id } }),
          prisma.loyaltyEngagementEvent.count({ where: { ourAgencyId: a.id } }),
          prisma.loyaltyEntityLink.count({
            where: { targetType: "AGENCY", targetId: a.id },
          }),
        ]);

      console.log(`─── «${a.name}» (ИНН ${a.inn}) ───`);
      console.log(`  broker_agencies: ${brokerAgencies.length}`);
      for (const ba of brokerAgencies) {
        console.log(
          `    - брокер ${ba.broker.fullName} (${ba.broker.phone}, id=${ba.broker.id})` +
            `${ba.isPrimary ? " [основная компания]" : ""}`,
        );
      }
      console.log(`  deals.agency_id: ${deals}${deals > 0 ? " → SET NULL" : ""}`);
      console.log(`  clients.fixation_agency_id: ${clients}${clients > 0 ? " → SET NULL" : ""}`);
      console.log(`  loyalty_call_assignments.our_agency_id: ${loyaltyAssignments}${loyaltyAssignments > 0 ? " → SET NULL" : ""}`);
      console.log(`  loyalty_tasks.our_agency_id: ${loyaltyTasks}${loyaltyTasks > 0 ? " → SET NULL" : ""}`);
      console.log(`  loyalty_engagement_events.our_agency_id: ${loyaltyEvents}${loyaltyEvents > 0 ? " → SET NULL" : ""}`);
      console.log(
        `  loyalty_entity_links (target=AGENCY): ${entityLinks}` +
          `${entityLinks > 0 ? " ← БЛОКИРУЕТ удаление (NOT NULL, занулить нельзя)" : ""}`,
      );
      console.log("");

      plans.push({ agency: a, entityLinks });
    }

    // ─── 3. Следы в amoCRM (только чтение) ───
    console.log("=== Поиск следов в amoCRM (companies, только чтение) ===");
    try {
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
            update: { value, updatedBy: "cleanup-test-agencies" },
            create: { key, value, updatedBy: "cleanup-test-agencies" },
          });
        }
        console.error("amo tokens refreshed and persisted");
      });

      const amo = new AmoCrmAdapter();
      for (const a of agencies) {
        // Уникальные запросы: ИНН + название (+ юр. название, если отличается).
        const queries = [...new Set([a.inn, a.name, a.legalName].filter(Boolean))];
        for (const q of queries) {
          let res = null;
          try {
            res = await amo["request"](
              `/companies?query=${encodeURIComponent(q)}&limit=5`,
            );
          } catch (e) {
            console.log(`  «${a.name}» query="${q}": ошибка amo — ${e?.message || e}`);
            continue;
          }
          const companies = res?._embedded?.companies || [];
          if (companies.length === 0) {
            console.log(`  «${a.name}» query="${q}": не найдено`);
          } else {
            for (const c of companies) {
              console.log(`  «${a.name}» query="${q}": company id=${c.id}, name=«${c.name}»`);
            }
          }
          await sleep(250);
        }
      }
    } catch (e) {
      // amo-поиск информационный: его сбой не должен ронять чистку БД.
      console.log(`  amoCRM недоступен, поиск пропущен: ${e?.message || e}`);
    }
    console.log("");

    // ─── 4. Удаление (только с --apply) ───
    if (!APPLY) {
      console.log("DRY-RUN: ничего не изменено. Для удаления запустите с --apply.");
      return;
    }

    let deleted = 0;
    let skipped = 0;
    for (const { agency: a, entityLinks } of plans) {
      if (entityLinks > 0) {
        console.log(
          `ПРОПУСК «${a.name}» (ИНН ${a.inn}): ${entityLinks} loyalty_entity_links ` +
            `с NOT NULL-ссылкой target_id — сначала разберитесь со связями лояльности.`,
        );
        skipped++;
        continue;
      }
      try {
        await prisma.$transaction(async (tx) => {
          const ba = await tx.brokerAgency.deleteMany({ where: { agencyId: a.id } });
          const deals = await tx.deal.updateMany({
            where: { agencyId: a.id },
            data: { agencyId: null },
          });
          const clients = await tx.client.updateMany({
            where: { fixationAgencyId: a.id },
            data: { fixationAgencyId: null },
          });
          const la = await tx.loyaltyCallAssignment.updateMany({
            where: { ourAgencyId: a.id },
            data: { ourAgencyId: null },
          });
          const lt = await tx.loyaltyTask.updateMany({
            where: { ourAgencyId: a.id },
            data: { ourAgencyId: null },
          });
          const le = await tx.loyaltyEngagementEvent.updateMany({
            where: { ourAgencyId: a.id },
            data: { ourAgencyId: null },
          });
          await tx.agency.delete({ where: { id: a.id } });
          console.log(
            `УДАЛЕНО «${a.name}» (ИНН ${a.inn}): broker_agencies −${ba.count}, ` +
              `deals SET NULL ${deals.count}, clients SET NULL ${clients.count}, ` +
              `loyalty assignments/tasks/events SET NULL ${la.count}/${lt.count}/${le.count}. ` +
              `Брокеры не тронуты.`,
          );
        });
        deleted++;
      } catch (e) {
        // P2003 = FK violation: в схему добавили новую NOT NULL-связь на Agency,
        // которую этот скрипт не знает. Пропускаем агентство, не роняем остальные.
        console.log(`ПРОПУСК «${a.name}» (ИНН ${a.inn}): ошибка удаления — ${e?.message || e}`);
        skipped++;
      }
    }
    console.log(`\n=== Итог: удалено ${deleted}, пропущено ${skipped}, не найдено ${missing.length} ===`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
