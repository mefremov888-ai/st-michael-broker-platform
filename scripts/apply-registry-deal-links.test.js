const test = require("node:test");
const assert = require("node:assert/strict");
const { planLink } = require("./apply-registry-deal-links");

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
