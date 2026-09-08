const test = require("node:test");
const assert = require("node:assert/strict");
const { pickBroker } = require("./link-registry-deals-by-client-phone");
const f = (brokerId, createdAt, st = "CONDITIONALLY_UNIQUE") => ({ brokerId, createdAt, uniquenessStatus: st, fixationStatus: "NOT_FIXED" });
test("pickBroker: один брокер → он; отклонённые не считаются; ближайшая до сделки; один день у разных → неоднозначно", () => {
  assert.deepEqual(pickBroker([f("a", "2024-01-01"), f("a", "2024-02-01", "EXPIRED")], "2024-03-01"), { brokerId: "a", via: "single-broker" });
  assert.equal(pickBroker([f("a", "2024-01-01", "REJECTED")], "2024-03-01").via, "only-rejected");
  assert.equal(pickBroker([], "2024-03-01").via, "no-fixations");
  assert.deepEqual(pickBroker([f("a", "2024-01-01"), f("b", "2024-02-15"), f("c", "2024-05-01")], "2024-03-01"), { brokerId: "b", via: "closest-before-deal" });
  assert.equal(pickBroker([f("a", "2024-02-15T10:00:00Z"), f("b", "2024-02-15T12:00:00Z")], "2024-03-01").via, "ambiguous-same-day");
  assert.deepEqual(pickBroker([f("a", "2024-05-01"), f("b", "2024-06-01")], "2024-03-01"), { brokerId: "a", via: "earliest" });
});
