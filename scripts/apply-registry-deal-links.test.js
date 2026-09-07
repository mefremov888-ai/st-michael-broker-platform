const test = require("node:test");
const assert = require("node:assert/strict");
const { planLink, contractKey } = require("./apply-registry-deal-links");

test("ключ номера договора не различает латиницу/кириллицу и пробелы", () => {
  assert.equal(contractKey("ЗГ2-16-1-173a"), contractKey("ЗГ2-16-1-173а"));
  assert.equal(contractKey("MM-100"), contractKey("ММ-100"));
  assert.notEqual(contractKey("ЗГ2-2-3-004"), contractKey("ЗГ1-2-3-009"));
});

const link = { amoLeadId: 31140291, contractNumber: "ММ-100", amountRub: 2133111 };

test("одна строка без лида → привязка, AMO_ONLY-строка лида удаляется", () => {
  const plan = planLink(link, [{ id: "r1", rowKey: "legacy:x", source: "REGISTRY", amoLeadId: null }], { id: "a1", rowKey: "amo:31140291", source: "AMO_ONLY" });
  assert.equal(plan.status, "link");
  assert.equal(plan.row.id, "r1");
  assert.equal(plan.dropAmoOnly.id, "a1");
});

test("уже привязано → already; нет строк → not-found; две строки → ambiguous", () => {
  assert.equal(planLink(link, [{ id: "r1", amoLeadId: 31140291n }], null).status, "already");
  assert.equal(planLink(link, [], null).status, "not-found");
  assert.equal(planLink(link, [{ id: "r1", amoLeadId: null }, { id: "r2", amoLeadId: null }], null).status, "ambiguous");
});

test("строка с чужим лидом не считается кандидатом", () => {
  const plan = planLink(link, [{ id: "r1", amoLeadId: 999n }, { id: "r2", amoLeadId: null, rowKey: "k", source: "REGISTRY" }], null);
  assert.equal(plan.status, "link");
  assert.equal(plan.row.id, "r2");
});
