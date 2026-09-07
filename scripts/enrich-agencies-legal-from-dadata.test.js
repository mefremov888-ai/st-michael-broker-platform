const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isRealInn,
  isPlaceholderName,
  planAgencyUpdate,
} = require("./enrich-agencies-legal-from-dadata");

test("настоящий ИНН — ровно 10 или 12 цифр, плейсхолдеры NOINN-* нет", () => {
  assert.equal(isRealInn("7707083893"), true);
  assert.equal(isRealInn("500100732259"), true);
  assert.equal(isRealInn("NOINN-3f2a1b9c0d"), false);
  assert.equal(isRealInn("77070838931"), false);
  assert.equal(isRealInn(""), false);
});

test("имя-плейсхолдер «Агентство <ИНН>» и пустое имя распознаются", () => {
  assert.equal(isPlaceholderName("Агентство 7707083893", "7707083893"), true);
  assert.equal(isPlaceholderName("", "7707083893"), true);
  assert.equal(isPlaceholderName("Red Line", "7707083893"), false);
  // Плейсхолдер чужого ИНН — это уже чьё-то имя, не трогаем.
  assert.equal(isPlaceholderName("Агентство 1111111111", "7707083893"), false);
});

test("план заполняет ТОЛЬКО пустые реквизиты и не перезаписывает имя", () => {
  const profile = {
    inn: "7707083893",
    name: "ПАО Сбербанк",
    fullName: 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "СБЕРБАНК РОССИИ"',
    address: "г Москва, ул Вавилова, д 19",
    status: "ACTIVE",
  };
  const plan = planAgencyUpdate(
    { id: "a1", name: "Сбер (партнёр)", inn: "7707083893", legalName: null, legalAddress: "" },
    profile,
  );
  assert.deepEqual(plan.fields, ["legalName", "legalAddress"]);
  assert.equal(plan.data.legalName, profile.fullName);
  assert.equal(plan.data.legalAddress, profile.address);
  assert.equal("name" in plan.data, false);
});

test("имя заменяется только у плейсхолдера; заполненные поля нетронуты", () => {
  const profile = {
    inn: "7707083893",
    name: "ПАО Сбербанк",
    fullName: 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "СБЕРБАНК РОССИИ"',
    address: "г Москва, ул Вавилова, д 19",
    status: "ACTIVE",
  };
  const plan = planAgencyUpdate(
    {
      id: "a1",
      name: "Агентство 7707083893",
      inn: "7707083893",
      legalName: "уже есть",
      legalAddress: "уже есть",
    },
    profile,
  );
  assert.deepEqual(plan.fields, ["name"]);
  assert.equal(plan.data.name, "ПАО Сбербанк");
});

test("нечего заполнять или реестр не ответил → плана нет", () => {
  const full = {
    id: "a1",
    name: "Red Line",
    inn: "7707083893",
    legalName: "ООО «Ред Лайн»",
    legalAddress: "адрес",
  };
  assert.equal(
    planAgencyUpdate(full, { name: "x", fullName: "y", address: "z" }),
    null,
  );
  assert.equal(planAgencyUpdate({ ...full, legalName: null }, null), null);
});
