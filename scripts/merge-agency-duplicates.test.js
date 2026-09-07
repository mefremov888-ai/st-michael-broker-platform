const test = require("node:test");
const assert = require("node:assert/strict");
const { planRequisites, loserNameKeys } = require("./merge-agency-duplicates");

test("реквизиты: заполняются только пустые поля выжившей, ИНН-плейсхолдер заменяется настоящим", () => {
  const survivor = { name: "Kalinka", legalName: null, inn: "NOINN-abc", phone: "+79160000000", email: null, address: null, legalAddress: null };
  const losers = [
    { name: "Калинка", legalName: "ООО «Калинка»", inn: "7700000001", phone: "+79990000000", email: "a@b.ru", address: null, legalAddress: "адрес" },
    { name: "Клинка", legalName: null, inn: "NOINN-zzz", phone: null, email: "c@d.ru", address: "Москва", legalAddress: null },
  ];
  assert.deepEqual(planRequisites(survivor, losers), {
    legalName: "ООО «Калинка»",
    email: "a@b.ru",
    address: "Москва",
    legalAddress: "адрес",
    inn: "7700000001",
  });
});

test("реквизиты: настоящий ИНН выжившей не трогаем", () => {
  const survivor = { name: "A", legalName: "есть", inn: "7700000009", phone: "1", email: "2", address: "3", legalAddress: "4" };
  assert.deepEqual(planRequisites(survivor, [{ name: "B", inn: "7700000001" }]), {});
});

test("ключи названий поглощаемых карточек — канонические, с legalName", () => {
  const keys = loserNameKeys([
    { name: "VSN Realty", legalName: null },
    { name: "ООО Гоу Риэлти", legalName: "ООО «ГОУ РИЭЛТИ»" },
  ]);
  assert.ok(keys.has("vsnrealty"));
  assert.ok(keys.has("гоуриэлти"));
  assert.equal(keys.size, 2);
});
