const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveBroker } = require("./link-registry-deals-to-brokers");

test("resolveBroker: ровно один брокер-контакт → привязка; несколько → ambiguous; ноль → причина", () => {
  const map = new Map([["101", "b1"], ["102", "b2"], ["103", "b1"]]);
  assert.deepEqual(resolveBroker([101, 555], map), { brokerId: "b1", via: "lead-contact" });
  assert.deepEqual(resolveBroker([101, 103], map), { brokerId: "b1", via: "lead-contact" }); // две карточки → одна основная
  assert.equal(resolveBroker([101, 102], map).via, "ambiguous");
  assert.equal(resolveBroker([555], map).via, "no-broker-contact");
  assert.equal(resolveBroker([], map).via, "no-contacts");
});
