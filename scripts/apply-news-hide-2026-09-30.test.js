const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTitle, buildPlan, run, TITLES_TO_HIDE, MODERATED_BY } = require("./apply-news-hide-2026-09-30");

const row = (id, title, extra = {}) => ({
  id,
  title,
  source: "stmichael.ru",
  publishedAt: new Date("2026-09-01T00:00:00Z"),
  isActive: true,
  moderationStatus: "APPROVED",
  ...extra,
});

// Состояние прода на 30.09: 20 новостей сайта, из них 6 к скрытию
const HIDE = [
  row("h1", "На Ходынке открылась Детская Академия падела"),
  row("h2", "Джазовый вечер под открытым небом в «Зорге 9»"),
  row("h3", "Время открытий: как в «Зорге 9» встретили новый учебный год"),
  row("h4", "С Днем строителя!"),
  row("h5", "TURONE — новый адрес мужского стиля в Москве"),
  row("h6", "Более 12 событий за месяц: в «Зорге 9» запустили программу для взрослых и детей"),
];
const KEEP = Array.from({ length: 14 }, (_, i) => row(`k${i + 1}`, `Новость сайта №${i + 1}`));
const PROD = [...KEEP.slice(0, 7), ...HIDE, ...KEEP.slice(7)];

/** Фальшивый prisma: findMany/updateMany/count в памяти, $transaction с откатом по исключению. */
function fakePrisma(initial) {
  let rows = initial.map((r) => ({ ...r }));
  const model = (get, set) => ({
    findMany: async ({ where } = {}) => {
      const ids = where?.id?.in;
      return get().filter((r) => !ids || ids.includes(r.id));
    },
    count: async ({ where } = {}) => get().filter((r) => !where?.moderationStatus || r.moderationStatus === where.moderationStatus).length,
    updateMany: async ({ where, data }) => {
      let count = 0;
      set(
        get().map((r) => {
          if (!where.id.in.includes(r.id)) return r;
          if (where.moderationStatus?.not && r.moderationStatus === where.moderationStatus.not) return r;
          count++;
          return { ...r, ...data };
        }),
      );
      return { count };
    },
  });
  const prisma = {
    landingNews: model(() => rows, (next) => (rows = next)),
    txCalls: 0,
    $transaction: async (fn) => {
      prisma.txCalls++;
      let staged = rows.map((r) => ({ ...r }));
      const tx = { landingNews: model(() => staged, (next) => (staged = next)) };
      await fn(tx); // при исключении (в т.ч. Rollback) staged не применяется
      rows = staged;
    },
    rows: () => rows,
  };
  return prisma;
}

const quiet = { log: () => {}, error: () => {} };

test("нормализация: кавычки, регистр, пробелы, ё", () => {
  assert.equal(normalizeTitle('  Джазовый   вечер под открытым небом в "Зорге 9" '), "джазовый вечер под открытым небом в зорге 9");
  assert.equal(normalizeTitle("С Днём строителя!"), normalizeTitle("С Днем строителя!"));
  assert.equal(normalizeTitle("«TURONE» — НОВЫЙ адрес"), "turone — новый адрес");
});

test("план на проде 30.09: найдены все 6, остаются 14 APPROVED", () => {
  const plan = buildPlan(PROD);
  assert.deepEqual(plan.notFound, []);
  assert.deepEqual(plan.hideIds.sort(), ["h1", "h2", "h3", "h4", "h5", "h6"]);
  assert.equal(plan.remainApproved.length, 14);
});

test("заголовок в базе с другими кавычками/регистром — всё равно совпадение; похожий, но другой — нет", () => {
  const rows = [row("a", 'джазовый вечер под открытым небом в "Зорге 9"'), row("b", "Джазовый вечер под открытым небом в «Зорге 9» (фото)")];
  const plan = buildPlan(rows, ["Джазовый вечер под открытым небом в «Зорге 9»"]);
  assert.deepEqual(plan.hideIds, ["a"]);
  assert.deepEqual(plan.notFound, []);
});

test("не найденные печатаются как not found, уже REJECTED не трогаются, PENDING тоже скрывается", () => {
  const rows = [row("h1", HIDE[0].title, { moderationStatus: "REJECTED" }), row("h4", HIDE[3].title, { moderationStatus: "PENDING" }), ...KEEP];
  const plan = buildPlan(rows);
  assert.equal(plan.notFound.length, 4);
  assert.deepEqual(plan.hideIds, ["h4"]);
  assert.equal(plan.entries[0].already.length, 1);
  assert.equal(plan.remainApproved.length, 14);
});

test("dry-run: транзакция откатывается, статусы не меняются", async () => {
  const prisma = fakePrisma(PROD);
  const result = await run(prisma, { write: false, ...quiet });
  assert.equal(result.ok, true);
  assert.equal(result.hidden, 6);
  assert.equal(prisma.txCalls, 1);
  assert.equal(prisma.rows().filter((r) => r.moderationStatus === "REJECTED").length, 0);
});

test("apply: 6 → REJECTED с отметкой moderatedBy, 14 APPROVED не тронуты; повторный запуск — нечего скрывать", async () => {
  const prisma = fakePrisma(PROD);
  const result = await run(prisma, { write: true, ...quiet });
  assert.equal(result.hidden, 6);
  const rejected = prisma.rows().filter((r) => r.moderationStatus === "REJECTED");
  assert.deepEqual(rejected.map((r) => r.id).sort(), ["h1", "h2", "h3", "h4", "h5", "h6"]);
  assert.ok(rejected.every((r) => r.moderatedBy === MODERATED_BY && r.moderatedAt instanceof Date));
  assert.equal(prisma.rows().filter((r) => r.moderationStatus === "APPROVED").length, 14);

  const again = await run(prisma, { write: true, ...quiet });
  assert.equal(again.ok, true);
  assert.equal(again.hidden, 0);
  assert.equal(prisma.txCalls, 1);
});

test("ни один заголовок не найден — ok=false, записи нет", async () => {
  const prisma = fakePrisma(KEEP);
  const result = await run(prisma, { write: true, ...quiet });
  assert.equal(result.ok, false);
  assert.equal(prisma.txCalls, 0);
  assert.equal(result.plan.notFound.length, TITLES_TO_HIDE.length);
});
