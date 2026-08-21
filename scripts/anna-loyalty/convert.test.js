"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  AGENCY_ENTRY,
  BROKER_ENTRY,
  ConversionError,
  MAX_OUTPUT_BYTES,
  convertArchive,
  crc32,
  writePrivateFile,
} = require("./convert.js");

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const value = Buffer.from(content, "utf8");
    const checksum = crc32(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(value.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, value);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(value.length, 20);
    central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + value.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function agency(overrides = {}) {
  return {
    id: "agency-alpha",
    kind: "agency",
    name: "Synthetic Agency",
    company: "Synthetic Agency",
    phone: "79990000002",
    email: "agency@example.test",
    role: "",
    specialization: "",
    stage: "",
    birthday: "",
    btDate: "",
    lastMeetingDate: "",
    lastDealDate: "",
    fixations: 0,
    meetings: 0,
    deals: 0,
    sales: 0,
    rating: 0,
    assigned: "",
    calls: [],
    recognitions: [],
    agencyContacts: [],
    agencySize: "",
    brokerCount: 0,
    website: "",
    projectsOnSite: "",
    sitePlacementRequirements: "",
    lastAgencyMeetingDate: "",
    agencyBtFormat: "",
    activeBrokers: 0,
    lastContractDate: "",
    nextAgreement: "",
    partnershipStatus: "",
    crmIds: "2001",
    crmSource: "synthetic",
    verification: "synthetic",
    aliases: "",
    crmNames: "",
    paymentControl: 0,
    successfulDeals: 0,
    zorgeDeals: 0,
    berzarinaDeals: 0,
    activeCrmCards: 0,
    crmScore: 0,
    dealsWithAmount: 0,
    dealsByMonth: {},
    ...overrides,
  };
}

function broker(overrides = {}) {
  return {
    phone: "79990000001",
    name: "Synthetic Broker",
    company: "Synthetic Agency",
    email: "broker@example.test",
    history: [["Результат звонка", "проинформирован"]],
    comment: "Synthetic follow-up",
    sources: ["Synthetic sheet"],
    specialization: "Премиум",
    geography: "Москва",
    role: "Брокер",
    crm: {
      verification: "synthetic",
      id: "1001",
      ids: ["1001"],
      url: "https://example.amocrm.ru/contacts/detail/1001",
      name: "Synthetic Broker CRM",
      names: ["Synthetic Broker CRM"],
      company: "Synthetic Agency",
      companies: ["Synthetic Agency"],
      email: "broker@example.test",
      emails: ["broker@example.test"],
      birthday: "01.01",
      bt: "1",
      btDate: "2026-01-02",
      region: "Москва",
      fixations: 2,
      meetings: 1,
      deals: 1,
      lastFixationDate: "2026-01-03",
      lastMeetingDate: "2026-01-03",
      lastDealDate: "2026-01-04",
      dealsByMonth: { "2026-01": 1 },
      dealAmountRub: 1000000,
      lastCallDate: "2026-01-05",
      callsMayAugust: [
        { date: "2026-01-05", direction: "out", result: "answered" },
      ],
    },
    ...overrides,
  };
}

function fixtureArchive(
  directory,
  brokers = [broker()],
  agencies = [agency()],
  sourceOverrides = {},
) {
  const brokerSource =
    sourceOverrides.brokerSource ||
    [
      "export type BrokerSourceRow = Record<string, unknown>;",
      `export const brokerSourceRows: BrokerSourceRow[] = ${JSON.stringify(brokers)};`,
    ].join("\n");
  const agencySource =
    sourceOverrides.agencySource ||
    `export const crmAgencySeed = ${JSON.stringify(agencies)} as const;\n`;
  const archive = storedZip({
    [BROKER_ENTRY]: brokerSource,
    [AGENCY_ENTRY]: agencySource,
  });
  const zipPath = path.join(directory, "fixture.zip");
  fs.writeFileSync(zipPath, archive);
  return {
    archive,
    zipPath,
    expectedSha256: crypto.createHash("sha256").update(archive).digest("hex"),
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "anna-loyalty-converter-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("converts strict source literals and independently builds the manifest", (t) => {
  const fixture = fixtureArchive(temporaryDirectory(t));
  const converted = convertArchive({
    zipPath: fixture.zipPath,
    expectedSha256: fixture.expectedSha256,
  });
  assert.equal(converted.document.expectedRecords, 2);
  assert.equal(converted.document.expectedUniquePhones, 2);
  assert.equal(converted.document.expectedActivities, 0);
  assert.equal(converted.document.expectedSourceAggregates, 2);
  assert.equal(converted.document.expectedExternalIdentities, 2);
  assert.deepEqual(converted.document.expectedSourceReportedSummary.brokers, {
    records: 1,
    fixations: 2,
    fixationKnownRecords: 1,
    meetings: 1,
    meetingKnownRecords: 1,
    deals: 1,
    dealKnownRecords: 1,
    brokerTours: 1,
    brokerTourKnownRecords: 1,
    calls: 1,
    callKnownRecords: 1,
    dealAmount: "1000000.00",
    dealAmountKnownRecords: 1,
  });
  assert.deepEqual(converted.document.expectedSourceReportedSummary.agencies, {
    records: 1,
    fixations: 0,
    fixationKnownRecords: 1,
    meetings: 0,
    meetingKnownRecords: 1,
    deals: 0,
    dealKnownRecords: 1,
    brokerTours: null,
    brokerTourKnownRecords: 0,
    calls: null,
    callKnownRecords: 0,
    dealAmount: "0.00",
    dealAmountKnownRecords: 1,
  });
  assert.ok(converted.output.length <= MAX_OUTPUT_BYTES);
  const repeated = convertArchive({
    zipPath: fixture.zipPath,
    expectedSha256: fixture.expectedSha256,
  });
  assert.deepEqual(repeated.output, converted.output);
  assert.equal(
    converted.report.gzipBase64Chunks45k,
    Math.ceil(converted.report.gzipBase64Bytes / 45_000),
  );
  assert.equal(
    converted.document.records.some((record) => record.activities),
    false,
  );
  const brokerRecord = converted.document.records.find(
    (record) => record.entityType === "BROKER",
  );
  assert.deepEqual(brokerRecord.attributes.history[0], [
    "Результат звонка",
    "проинформирован",
    "Проинформирован",
    "2026-05",
  ]);
  assert.equal(brokerRecord.organizationRoles.length, 1);
  assert.match(
    brokerRecord.externalKey,
    /^anna:broker:phone-sha256:[a-f0-9]{64}$/,
  );
});

test("external key for a valid non-AMO row is stable across source order", (t) => {
  const directory = temporaryDirectory(t);
  const firstBroker = broker({
    crm: { ...broker().crm, id: "", ids: [], url: "" },
  });
  const secondBroker = broker({
    phone: "79990000003",
    name: "Second synthetic broker",
    crm: {
      ...broker().crm,
      id: "",
      ids: [],
      url: "",
      name: "Second synthetic broker",
    },
  });
  const first = fixtureArchive(directory, [firstBroker, secondBroker]);
  const firstResult = convertArchive({
    zipPath: first.zipPath,
    expectedSha256: first.expectedSha256,
  });
  const expectedKey = firstResult.document.records.find((record) =>
    record.contactPoints?.some((point) => point.value === "79990000001"),
  ).externalKey;
  fs.unlinkSync(first.zipPath);
  const second = fixtureArchive(directory, [secondBroker, firstBroker]);
  const secondResult = convertArchive({
    zipPath: second.zipPath,
    expectedSha256: second.expectedSha256,
  });
  const reorderedKey = secondResult.document.records.find((record) =>
    record.contactPoints?.some((point) => point.value === "79990000001"),
  ).externalKey;
  assert.equal(reorderedKey, expectedKey);
});

test("retains invalid 77-prefix row without making it phone-matchable", (t) => {
  const invalid = broker({ phone: "77123456789" });
  const fixture = fixtureArchive(temporaryDirectory(t), [invalid]);
  const converted = convertArchive({
    zipPath: fixture.zipPath,
    expectedSha256: fixture.expectedSha256,
  });
  const record = converted.document.records.find(
    (item) => item.entityType === "BROKER",
  );
  assert.equal(
    record.contactPoints.some((point) => point.type === "PHONE"),
    false,
  );
  assert.equal(record.attributes.exclusionCandidate, "INVALID_PHONE");
  assert.equal(record.attributes.matchable, false);
  assert.match(record.externalKey, /^anna:broker:amo-contact:1001$/);
  assert.equal(converted.report.invalidBrokerPhones, 1);
});

test("rejects a ZIP whose SHA-256 was not explicitly reviewed", (t) => {
  const fixture = fixtureArchive(temporaryDirectory(t));
  assert.throws(
    () =>
      convertArchive({
        zipPath: fixture.zipPath,
        expectedSha256: "0".repeat(64),
      }),
    (error) =>
      error instanceof ConversionError && error.code === "ZIP_SHA256_MISMATCH",
  );
});

test("never evaluates TypeScript expressions around the source array", (t) => {
  const malicious =
    "export const brokerSourceRows: BrokerSourceRow[] = (() => [])();";
  const fixture = fixtureArchive(temporaryDirectory(t), [], [agency()], {
    brokerSource: malicious,
  });
  assert.throws(
    () =>
      convertArchive({
        zipPath: fixture.zipPath,
        expectedSha256: fixture.expectedSha256,
      }),
    (error) =>
      error instanceof ConversionError &&
      ["SOURCE_ARRAY_REQUIRED", "SOURCE_EXECUTABLE_SUFFIX"].includes(
        error.code,
      ),
  );
});

test("fails closed on source schema drift", (t) => {
  const fixture = fixtureArchive(temporaryDirectory(t), [
    broker({ unexpected: "schema drift" }),
  ]);
  assert.throws(
    () =>
      convertArchive({
        zipPath: fixture.zipPath,
        expectedSha256: fixture.expectedSha256,
      }),
    (error) =>
      error instanceof ConversionError && error.code === "SOURCE_UNKNOWN_FIELD",
  );
});

test("enforces output limit and report never contains source PII", (t) => {
  const sentinel = "SENTINEL_PERSON_NAME_NOT_FOR_REPORT";
  const fixture = fixtureArchive(temporaryDirectory(t), [
    broker({ name: sentinel }),
  ]);
  const converted = convertArchive({
    zipPath: fixture.zipPath,
    expectedSha256: fixture.expectedSha256,
  });
  assert.equal(JSON.stringify(converted.report).includes(sentinel), false);
  assert.throws(
    () =>
      convertArchive({
        zipPath: fixture.zipPath,
        expectedSha256: fixture.expectedSha256,
        maxOutputBytes: 100,
      }),
    (error) =>
      error instanceof ConversionError && error.code === "OUTPUT_TOO_LARGE",
  );
});

test("writes a complete private file without overwriting an existing target", (t) => {
  const directory = temporaryDirectory(t);
  const destination = path.join(directory, "import.json");
  const security = writePrivateFile(destination, Buffer.from('{"safe":true}'));
  assert.equal(fs.readFileSync(destination, "utf8"), '{"safe":true}');
  assert.equal(security.posixModeRequested, "0600");
  if (process.platform !== "win32")
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.throws(
    () => writePrivateFile(destination, Buffer.from("{}")),
    (error) =>
      error instanceof ConversionError && error.code === "OUTPUT_EXISTS",
  );
});
