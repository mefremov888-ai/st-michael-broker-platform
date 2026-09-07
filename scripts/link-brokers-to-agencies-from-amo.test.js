const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAgency, buildAgencyIndex, cleanInn } = require("./link-brokers-to-agencies-from-amo");

const index = buildAgencyIndex([
  { id: "a1", name: "Trend Agent", legalName: null, inn: "7700000001" },
  { id: "a2", name: "Калинка", legalName: "ООО «Калинка»", inn: "NOINN-x" },
  { id: "a3", name: "Веста Дом", legalName: null, inn: "NOINN-y" },
  { id: "a4", name: "Веста Дом", legalName: null, inn: "NOINN-z" }, // дубль названия → неоднозначно
]);
const cf = (id, v) => ({ field_id: id, values: [{ value: v }] });

test("ИНН контакта — первый приоритет", () => {
  const r = resolveAgency({ custom_fields_values: [cf(834489, "7700000001")] }, [{ name: "Другое", inn: null }], index);
  assert.equal(r.agency.id, "a1"); assert.equal(r.via, "contact-inn");
});

test("ИНН компании, затем название компании (только уникальное)", () => {
  assert.equal(resolveAgency({}, [{ name: "x", inn: "7700000001" }], index).via, "company-inn");
  const byName = resolveAgency({}, [{ name: "ООО КАЛИНКА", inn: null }], index);
  assert.equal(byName.agency.id, "a2"); assert.equal(byName.via, "company-name");
  assert.equal(resolveAgency({}, [{ name: "Веста Дом", inn: null }], index).agency, null);
});

test("поле «Агентство» у контакта — последний приоритет; без данных — no-data", () => {
  const r = resolveAgency({ custom_fields_values: [cf(835417, "Калинка")] }, [], index);
  assert.equal(r.agency.id, "a2"); assert.equal(r.via, "contact-agency-name");
  assert.equal(resolveAgency({}, [], index).via, "no-data");
  assert.equal(resolveAgency({ custom_fields_values: [cf(834489, "1234567890")] }, [], index).via, "no-match");
});

test("cleanInn: только 10/12 цифр", () => {
  assert.equal(cleanInn(" 7700000001 "), "7700000001");
  assert.equal(cleanInn("ИНН 500100732259"), "500100732259");
  assert.equal(cleanInn("77000000011"), null);
});
