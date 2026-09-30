const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildPlan, inspectHtml, CALC } = require("./apply-cooperation-documents-2026-09-30");

const doc = (id, name, extra = {}) => ({
  id,
  name,
  description: null,
  type: "PDF",
  fileUrl: `/files/cooperation/${id}.pdf`,
  isPublic: true,
  sortOrder: 0,
  ...extra,
});

// Состояние прода на 30.09: четыре публичных документа
const PROD = [
  doc("a", "Условия сотрудничества сентябрь", { sortOrder: 1 }),
  doc("b", "Условия рассрочки Квартал Серебряный бор", { sortOrder: 2 }),
  doc("c", "Условия вознаграждения для брокеров на август 2026 г.", { sortOrder: 3 }),
  doc("d", "Условия вознаграждения партнёром St Michael", {
    type: "DOCX",
    description: "[seed:cooperation-rewards-conditions]",
    fileUrl: "/cooperation/conditions-of-rewards-st-michael.docx",
    sortOrder: 1,
  }),
];

test("прод 30.09: оставить «Условия сотрудничества», скрыть три, калькулятор создать сразу после", () => {
  const plan = buildPlan(PROD);
  assert.equal(plan.keep.id, "a");
  assert.deepEqual(plan.hide.map((d) => d.id).sort(), ["b", "c", "d"]);
  assert.deepEqual(plan.unexpected, []);
  assert.equal(plan.calcExisting, null);
  assert.equal(plan.calcSortOrder, 2);
});

test("повторный запуск: калькулятор найден по маркеру и обновляется, уже скрытые не трогаются", () => {
  const again = [
    PROD[0],
    { ...PROD[1], isPublic: false },
    { ...PROD[2], isPublic: false },
    { ...PROD[3], isPublic: false },
    doc("calc", "Старое имя калькулятора", { description: CALC.description, type: "HTML", fileUrl: CALC.fileUrl, sortOrder: 2 }),
  ];
  const plan = buildPlan(again);
  assert.equal(plan.calcExisting.id, "calc");
  assert.deepEqual(plan.hide, []);
  assert.deepEqual(plan.unexpected, []);
  assert.deepEqual(plan.calcDuplicates, []);
});

test("калькулятор, снятый с публикации в админке, при повторном запуске возвращается (без дубля)", () => {
  const plan = buildPlan([PROD[0], doc("calc", CALC.name, { description: CALC.description, fileUrl: CALC.fileUrl, isPublic: false })]);
  assert.equal(plan.calcExisting.id, "calc");
  assert.deepEqual(plan.unexpected, []);
});

test("калькулятор без маркера, но с тем же fileUrl — тоже свой (upsert по запасному ключу)", () => {
  const plan = buildPlan([PROD[0], doc("x", "Калькулятор", { fileUrl: CALC.fileUrl })]);
  assert.equal(plan.calcExisting.id, "x");
  assert.deepEqual(plan.unexpected, []);
});

test("чужой публичный документ в разделе — стоп", () => {
  const plan = buildPlan([...PROD, doc("z", "Регламент работы с клиентами")]);
  assert.deepEqual(plan.unexpected.map((d) => d.id), ["z"]);
});

test("второй публичный выпуск «Условий сотрудничества» — стоп, публичный предпочтительнее скрытого", () => {
  const plan = buildPlan([doc("old", "Условия сотрудничества август", { isPublic: false }), PROD[0]]);
  assert.equal(plan.keep.id, "a");
  assert.deepEqual(plan.unexpected, []);
  const plan2 = buildPlan([doc("old", "Условия сотрудничества август"), PROD[0]]);
  assert.equal(plan2.unexpected.length, 1);
  assert.deepEqual([plan2.keep.id, plan2.unexpected[0].id].sort(), ["a", "old"]);
});

test("исходный HTML из репозитория проходит проверки, скрипты только с cdnjs", () => {
  const info = inspectHtml(path.join(__dirname, "..", "seed-data", "documents", "calculator-rassrochki-2026-09.html"));
  assert.deepEqual(info.problems, []);
  assert.ok(info.size > 100 * 1024);
  assert.ok(info.scripts.length >= 2);
  assert.ok(info.scripts.every((u) => u.startsWith("https://cdnjs.cloudflare.com/")));
  assert.match(info.sha256, /^[0-9a-f]{64}$/);
});
