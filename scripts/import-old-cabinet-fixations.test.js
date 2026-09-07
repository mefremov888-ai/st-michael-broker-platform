const test = require("node:test");
const assert = require("node:assert/strict");
const { buildClientData, buildComment, MARK_RE } = require("./import-old-cabinet-fixations");

const now = new Date("2026-09-07T12:00:00.000Z");

test("принятая старая фиксация → EXPIRED с датой истечения +30 дней, история сохраняется", () => {
  const d = buildClientData({ oldId: 5, status: 1, clientPhone: "+79030000001", fullName: "Иванов Иван", createdAt: "2024-03-01T10:00:00", project: "SILVER_BOR", projectRaw: "Квартал Серебряный Бор", budget: 15000000, rooms: 2, propertyType: "Апартамент" }, "broker-1", now);
  assert.equal(d.uniquenessStatus, "EXPIRED");
  assert.equal(d.uniquenessExpiresAt.toISOString().slice(0, 10), "2024-03-31");
  assert.equal(d.createdAt.toISOString().slice(0, 10), "2024-03-01");
  assert.equal(d.project, "SILVER_BOR");
  assert.equal(d.amoSyncStatus, "SYNCED");
  assert.equal(d.fixationStatus, "NOT_FIXED");
  assert.equal(d.roomsCount, "2");
  assert.equal(d.amount, 15000000);
  assert.match(d.comment, /^\[old-cabinet:5\] Импорт из старого кабинета$/);
});

test("свежая принятая фиксация остаётся действующей; отклонённая → REJECTED", () => {
  const fresh = buildClientData({ oldId: 6, status: 1, clientPhone: "+79030000002", fullName: "А", createdAt: "2026-08-20T10:00:00", project: null, projectRaw: "Берзарина 37" }, "b", now);
  assert.equal(fresh.uniquenessStatus, "CONDITIONALLY_UNIQUE");
  assert.equal(fresh.project, "UNKNOWN"); // 2026-09-07 (владелец): без проекта → «Не указан», не Зорге 9
  assert.match(fresh.comment, /проект: Берзарина 37/);
  const rejected = buildClientData({ oldId: 7, status: 2, clientPhone: "+79030000003", fullName: "Б", createdAt: "2025-01-01T10:00:00", project: "ZORGE9" }, "b", now);
  assert.equal(rejected.uniquenessStatus, "REJECTED");
  assert.equal(rejected.uniquenessExpiresAt, null);
  assert.match(rejected.comment, /отклонена/);
});

test("маркер идемпотентности разбирается из comment", () => {
  assert.equal(Number(MARK_RE.exec(buildComment({ oldId: 12345, status: 1 }))[1]), 12345);
  assert.equal(MARK_RE.exec("обычный комментарий"), null);
});

test("бюджет/метраж вне диапазона Decimal не пишутся в колонки, но остаются в комментарии", () => {
  const { buildClientData } = require("./import-old-cabinet-fixations");
  const row = { oldId: 7, createdAt: "2024-01-01T00:00:00.000Z", status: 1, fullName: "К", clientPhone: "+79990000007", budget: 1e13, sqm: 5e8, project: null };
  const data = buildClientData(row, "b1", new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(data.amount, null);
  assert.equal(data.sqm, null);
  assert.match(data.comment, /бюджет в источнике: 10000000000000/);
  assert.match(data.comment, /метраж в источнике: 500000000/);
  const ok = buildClientData({ ...row, budget: 12500000, sqm: 54.3 }, "b1");
  assert.equal(ok.amount, 12500000);
  assert.equal(ok.sqm, 54.3);
});
