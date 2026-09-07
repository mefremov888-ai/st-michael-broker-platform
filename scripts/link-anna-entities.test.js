const test = require("node:test");
const assert = require("node:assert/strict");
const { pickMostActive, normPhone, stableUuid } = require("./link-anna-entities");

test("pickMostActive: сделки > встречи > фиксации > тур > звонок > ACTIVE > amo > updatedAt", () => {
  const a = { id: "a", status: "PENDING", _count: { deals: 0, meetings: 2, clients: 10 } };
  const b = { id: "b", status: "ACTIVE", _count: { deals: 1, meetings: 0, clients: 0 } };
  const c = { id: "c", status: "ACTIVE", _count: { deals: 0, meetings: 2, clients: 3 }, brokerTourVisited: true };
  assert.equal(pickMostActive([a, b, c]).id, "b");
  assert.equal(pickMostActive([a, c]).id, "a"); // фиксаций больше при равных встречах
  const d = { id: "d", status: "ACTIVE", _count: { deals: 0, meetings: 0, clients: 0 }, updatedAt: "2026-09-01" };
  const e = { id: "e", status: "ACTIVE", _count: { deals: 0, meetings: 0, clients: 0 }, updatedAt: "2026-09-05" };
  assert.equal(pickMostActive([d, e]).id, "e");
});

test("normPhone и stableUuid", () => {
  assert.equal(normPhone("8 (925) 318-14-67"), "79253181467");
  assert.equal(normPhone("9253181467"), "79253181467");
  assert.equal(normPhone("123"), null);
  const u = stableUuid("reconciliation-v2:case:x");
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(u, stableUuid("reconciliation-v2:case:x"));
});
