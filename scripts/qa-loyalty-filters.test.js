"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sameMoney, decimalCents, fixationOnlyFilter, sampledPeriodMatches, agencyPeriodWhere } = require("./qa-loyalty-filters");

test("money identity ignores decimal formatting without floating point rounding", () => {
  assert.equal(sameMoney("0.00", "0"), true);
  assert.equal(sameMoney("12.50", "12.5"), true);
  assert.equal(sameMoney("9999999999999999.99", "9999999999999999.98"), false);
  assert.equal(decimalCents("9999999999999999.99"), 999999999999999999n);
  assert.equal(sameMoney("-0.01", "0.01"), false);
});
test("missing or malformed amounts cannot pass as zero", () => {
  for (const value of [null, undefined, "", "NaN", "1e3", "0.001"])
    assert.equal(sameMoney(value, "0"), false);
});
test("fixation QA does not require meetings and deals in the same period", () => {
  const period = { from: "2026-10-01", to: "2026-10-12" };
  assert.deepEqual(fixationOnlyFilter(period), { fixationPeriod: period });
});
test("period QA fails an empty sample when DB has activity", () => {
  assert.equal(sampledPeriodMatches(2, { total: 0, items: [] }, true), false);
  assert.equal(sampledPeriodMatches(2, { total: 2, items: [] }, true), false);
  assert.equal(sampledPeriodMatches(2, { total: 2, items: [{}] }, true), true);
  assert.equal(sampledPeriodMatches(2, { total: 2, items: [{}] }, false), false);
  assert.equal(sampledPeriodMatches(0, { total: 0, items: [] }, true), true);
});
test("agency periods independently count current memberships and UTC date labels", () => {
  const period = { from: "2026-09-12T09:00:00.000Z", to: "2026-10-12T09:00:00.000Z" };
  const fix = agencyPeriodWhere("fixation", period).brokerAgencies.some.broker;
  assert.equal(fix.meetings, undefined);
  assert.equal(fix.clients.some.createdAt.gte.toISOString(), "2026-09-12T00:00:00.000Z");
  assert.equal(fix.clients.some.createdAt.lt.toISOString(), "2026-10-13T00:00:00.000Z");
  const meet = agencyPeriodWhere("meeting", period).brokerAgencies.some.broker;
  assert.equal(meet.clients, undefined);
  assert.deepEqual(meet.meetings.some.status, { in: ["CONFIRMED", "COMPLETED"] });
  assert.deepEqual(meet.meetings.some.type, { not: "BROKER_TOUR" });
});
