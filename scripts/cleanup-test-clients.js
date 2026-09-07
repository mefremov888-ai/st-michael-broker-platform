#!/usr/bin/env node
/**
 * 2026-09-07: чистка ТЕСТОВЫХ клиентов из прод-БД (шум в логах: SMS-уведомления
 * по фейковым записям вида «test 44 Михаил», «Михаил Тест47», «мих тест63»,
 * «тест1 тест», «DDD», «НДЗ», «те», «2 1», «Тест звонок», телефоны
 * +7999123XXXX / +799999999XX).
 *
 * Правила кандидата (клиент тестовый, если выполняется ЛЮБОЕ):
 *   (a) в full_name есть отдельное слово «тест»/«test» (допускаются цифры
 *       сразу после слова: «Тест47», «тест63», «тест1»; «Протестировать»
 *       и фамилия «Тестов» НЕ ловятся);
 *   (b) телефон ~ ^\+7999(9999|1234|1235|1236);
 *   (c) full_name точно из списка: DDD, НДЗ, те, 2 1, Тест звонок.
 *
 * Исключения:
 *   • клиент с amo_lead_id И реальными сделками (deals>0) — НЕ трогается,
 *     попадает в отчёт «подозрительные»;
 *   • при удалении ЛЮБОЙ кандидат с deals>0 пропускается с сообщением
 *     (у тестовых сделок быть не должно);
 *   • явный safelist телефонов (Ксения Цепляева +79261997991 — реальный
 *     импорт, под правила не попадает, но страхуемся).
 *
 * DRY_RUN=1 (default): полный список кандидатов (имя, телефон с маской
 * последних 4, брокер, дата создания, есть ли amoLeadId) + счётчики.
 * DRY_RUN=0: удаление клиентов вместе с их meetings/calls, порциями по 50,
 * в конце отчёт deleted=N. Deals НЕ удаляются никогда.
 *
 * Запуск в контейнере api (workflow apply-cleanup-test-clients.yml):
 *   DRY_RUN=1 node /app/scripts/cleanup-test-clients.js
 *
 * Правила вынесены в exports — их гоняет локальный тест
 * scripts/cleanup-test-clients.test.js (node scripts/cleanup-test-clients.test.js).
 */

// Слово «тест»/«test»: перед ним не-буква/начало, после — можно цифры,
// затем не-буквенно-цифровой символ или конец строки.
const TEST_WORD_RE = /(^|[^а-яёa-z])(тест|test)\d*([^а-яёa-z0-9]|$)/i;

// Телефоны тестовых серий (правило согласовано в постановке задачи).
const TEST_PHONE_RE = /^\+7999(9999|1234|1235|1236)/;

// Точные имена-мусор (сравнение после trim, регистр значим).
const EXACT_TEST_NAMES = new Set(["DDD", "НДЗ", "те", "2 1", "Тест звонок"]);

// Реальные клиенты, которых НИКОГДА не трогаем (страховка поверх правил).
const SAFE_PHONES = new Set(["+79261997991"]); // Ксения Цепляева — реальный импорт

/**
 * Возвращает null (не кандидат) или строку-правило: 'name-word' | 'phone' | 'exact-name'.
 */
function testClientRule(client) {
  const name = String(client.fullName || "").trim();
  const phone = String(client.phone || "").trim();
  if (SAFE_PHONES.has(phone)) return null;
  if (EXACT_TEST_NAMES.has(name)) return "exact-name";
  if (TEST_WORD_RE.test(name)) return "name-word";
  if (TEST_PHONE_RE.test(phone)) return "phone";
  return null;
}

module.exports = { testClientRule, TEST_WORD_RE, TEST_PHONE_RE, EXACT_TEST_NAMES, SAFE_PHONES };

if (require.main !== module) return;

const DRY_RUN = process.env.DRY_RUN !== "0";
const BATCH = 50;
const maskLast4 = (p) => {
  const s = String(p || "");
  return s.length > 4 ? s.slice(0, -4) + "****" : "****";
};

(async () => {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log(`=== Режим: ${DRY_RUN ? "DRY-RUN (только отчёт)" : "APPLY (удаление тестовых клиентов!)"} ===\n`);

    // ─── 1. Полный проход по клиентам постранично, фильтр правилами ───
    const candidates = [];
    let cursor = null;
    let scanned = 0;
    for (;;) {
      const page = await prisma.client.findMany({
        take: 1000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: {
          id: true, fullName: true, phone: true, createdAt: true,
          amoLeadId: true, brokerId: true,
          broker: { select: { fullName: true } },
        },
      });
      if (page.length === 0) break;
      scanned += page.length;
      for (const c of page) {
        const rule = testClientRule(c);
        if (rule) candidates.push({ ...c, rule });
      }
      cursor = page[page.length - 1].id;
    }
    console.log(`Просканировано клиентов: ${scanned}; кандидатов по правилам: ${candidates.length}\n`);

    // ─── 2. Сделки кандидатов ───
    const dealCounts = new Map();
    for (let i = 0; i < candidates.length; i += 500) {
      const ids = candidates.slice(i, i + 500).map((c) => c.id);
      const grouped = await prisma.deal.groupBy({
        by: ["clientId"],
        where: { clientId: { in: ids } },
        _count: { _all: true },
      });
      for (const g of grouped) dealCounts.set(g.clientId, g._count._all);
    }

    const suspicious = []; // amo_lead_id + реальные сделки → не трогаем
    const toDelete = [];
    for (const c of candidates) {
      const deals = dealCounts.get(c.id) || 0;
      if (c.amoLeadId && deals > 0) suspicious.push({ ...c, deals });
      else toDelete.push({ ...c, deals });
    }

    // ─── 3. Отчёт ───
    const byRule = { "name-word": 0, phone: 0, "exact-name": 0 };
    console.log("─── Кандидаты на удаление ───");
    for (const c of toDelete) {
      byRule[c.rule]++;
      console.log(
        `  • «${c.fullName}» | ${maskLast4(c.phone)} | брокер: ${c.broker?.fullName || c.brokerId} | ` +
          `создан ${c.createdAt.toISOString().slice(0, 10)} | amoLeadId: ${c.amoLeadId ? "есть" : "нет"} | ` +
          `deals=${c.deals}${c.deals > 0 ? " ← БУДЕТ ПРОПУЩЕН" : ""} | правило: ${c.rule}`,
      );
    }
    console.log(`\nСчётчики: всего=${toDelete.length} ` +
      `(по слову тест/test: ${byRule["name-word"]}, по телефону: ${byRule.phone}, по точному имени: ${byRule["exact-name"]})`);

    if (suspicious.length > 0) {
      console.log("\n─── Подозрительные, НЕ тронуты (amo_lead_id + реальные сделки) ───");
      for (const c of suspicious) {
        console.log(
          `  • «${c.fullName}» | ${maskLast4(c.phone)} | брокер: ${c.broker?.fullName || c.brokerId} | ` +
            `amoLeadId=${c.amoLeadId} | deals=${c.deals}`,
        );
      }
    }
    console.log("");

    if (DRY_RUN) {
      console.log("DRY-RUN: ничего не изменено. Для удаления запустите с DRY_RUN=0.");
      return;
    }

    // ─── 4. Удаление порциями: meetings + calls, затем клиент ───
    let deleted = 0;
    let skippedWithDeals = 0;
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const batch = toDelete.slice(i, i + BATCH);
      // Пере-проверка сделок непосредственно перед удалением (могли появиться).
      const fresh = await prisma.deal.groupBy({
        by: ["clientId"],
        where: { clientId: { in: batch.map((c) => c.id) } },
        _count: { _all: true },
      });
      const freshDeals = new Map(fresh.map((g) => [g.clientId, g._count._all]));
      const safeIds = [];
      for (const c of batch) {
        const deals = freshDeals.get(c.id) || 0;
        if (deals > 0) {
          console.log(`ПРОПУСК «${c.fullName}» (${maskLast4(c.phone)}): у клиента ${deals} сделок — тестовым тут не место, разберитесь руками.`);
          skippedWithDeals++;
        } else {
          safeIds.push(c.id);
        }
      }
      if (safeIds.length === 0) continue;
      await prisma.$transaction(async (tx) => {
        const m = await tx.meeting.deleteMany({ where: { clientId: { in: safeIds } } });
        const cl = await tx.call.deleteMany({ where: { clientId: { in: safeIds } } });
        const d = await tx.client.deleteMany({ where: { id: { in: safeIds } } });
        deleted += d.count;
        console.log(`Порция ${Math.floor(i / BATCH) + 1}: клиентов −${d.count}, встреч −${m.count}, звонков −${cl.count}`);
      });
    }
    console.log(`\n=== Итог: deleted=${deleted}, пропущено из-за сделок=${skippedWithDeals}, подозрительных (не тронуты)=${suspicious.length} ===`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
