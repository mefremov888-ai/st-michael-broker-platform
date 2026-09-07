const test = require("node:test");
const assert = require("node:assert/strict");
const { compareRow, toIsoDate, toMoney, contractKey, stageGroup } = require("./inspect-registry-vs-amo");

const cf = (id, v) => ({ field_id: id, values: [{ value: v }] });
const lead = (over = {}) => ({
  id: 1,
  pipeline_id: 7600550,
  status_id: 142,
  custom_fields_values: [cf(558353, "1721941200"), cf(833065, "12 345 678,50"), cf(558577, "ЗР1-1-1-050-240")],
  ...over,
});

test("toIsoDate: unix-секунды, дд.мм.гггг, ISO, Date", () => {
  assert.equal(toIsoDate("1721941200"), "2024-07-26"); // 00:00 МСК 26.07 = 21:00 UTC 25.07
  assert.equal(toIsoDate("1721952000"), "2024-07-26");
  assert.equal(toIsoDate("26.07.2024"), "2024-07-26");
  assert.equal(toIsoDate("2024-07-26T00:00:00.000Z"), "2024-07-26");
  assert.equal(toIsoDate(new Date("2024-07-26T00:00:00.000Z")), "2024-07-26");
  assert.equal(toIsoDate("мусор"), null);
  assert.equal(toIsoDate(null), null);
});

test("toMoney и contractKey", () => {
  assert.equal(toMoney("12 345 678,50 руб"), 12345678.5);
  assert.equal(toMoney(""), null);
  assert.equal(contractKey("ЗР1-1-1-050"), contractKey("ЗP1-1-1-050"));
  assert.equal(contractKey("№ СБ3-16-3-214 "), contractKey("CБ3-16-3-214"));
  assert.notEqual(contractKey("ЗР1-1-1-050"), contractKey("ЗР1-1-1-051"));
});

test("compareRow: совпадение без расхождений", () => {
  const c = compareRow(
    { contractNumber: "ЗР1-1-1-050", project: "ZORGE9", signedAt: new Date("2024-07-26T00:00:00.000Z"), paidAt: new Date("2024-08-01T00:00:00.000Z"), amount: "12345678.50" },
    lead(),
  );
  assert.deepEqual(c.issues, []);
  assert.equal(c.stage, "SUCCESS");
});

test("compareRow: дата, сумма, проект, оплата", () => {
  const c = compareRow(
    { contractNumber: "ЗР1-1-1-050", project: "SILVER_BOR", signedAt: new Date("2024-07-20T00:00:00.000Z"), paidAt: null, amount: "12000000" },
    lead(),
  );
  assert.deepEqual(c.issues.sort(), ["amount_mismatch", "date_mismatch", "project_mismatch", "unpaid_but_amo_success"]);
});

test("compareRow: лид не найден / поля пустые в amo / оплата при потерянном лиде", () => {
  assert.deepEqual(compareRow({ contractNumber: "x" }, null).issues, ["lead_missing"]);
  const c = compareRow(
    { contractNumber: "ЗР1-1-1-050", project: "ZORGE9", signedAt: new Date("2024-07-26T00:00:00.000Z"), paidAt: new Date("2024-08-01T00:00:00.000Z"), amount: "1" },
    lead({ status_id: 143, custom_fields_values: [] }),
  );
  assert.deepEqual(c.issues.sort(), ["amount_missing_in_amo", "contract_missing_in_amo", "date_missing_in_amo", "paid_but_amo_lost"]);
  assert.equal(stageGroup(lead({ status_id: 62907442 })), "PAID_BOOKING");
  assert.equal(stageGroup(lead({ status_id: 142, pipeline_id: 7600542 })), "KC_MEETING_DONE"); // КЦ: 142 = встреча проведена, не сделка
  assert.equal(stageGroup(null), "NO_LEAD");
});
