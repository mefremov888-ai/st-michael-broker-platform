"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const inspector = require("./inspect-loyalty-agency-period-candidate-parity");

const AGENCY_A = "11111111-1111-4111-8111-111111111111";
const AGENCY_B = "22222222-2222-4222-8222-222222222222";
const DIGEST_KEY = Buffer.alloc(32, 0x42);

function completeRows(memberships = () => null) {
  return inspector.expectedGroupKeys().map((key) => {
    const [period, source, metric, variant] = key.split("|");
    const selected = memberships({ period, source, metric, variant });
    const agencyIds =
      selected || (variant === "exact" ? [AGENCY_A] : [AGENCY_A, AGENCY_B]);
    return {
      period,
      source,
      metric,
      variant,
      agency_ids: agencyIds,
    };
  });
}

function attestation(overrides = {}) {
  return [
    {
      database_name: "broker_platform",
      read_only: "on",
      isolation: "repeatable read",
      statement_timeout: "20s",
      lock_timeout: "1s",
      system_identifier: "123456789",
      broker_rows: "20000",
      ...overrides,
    },
  ];
}

const environment = {
  PRODUCTION_PG_SYSTEM_IDENTIFIER: "123456789",
  PRODUCTION_MIN_BROKER_ROWS: "10000",
};

test("SQL mirrors current service source, status and independent agency rules", () => {
  assert.match(
    inspector.PARITY_SQL,
    /fixation_status IN \('FIXED', 'EXPIRED'\)/,
  );
  assert.match(
    inspector.PARITY_SQL,
    /uniqueness_status IN \('CONDITIONALLY_UNIQUE', 'EXPIRED'\)/,
  );
  assert.match(
    inspector.PARITY_SQL,
    /c\.comment IS NULL OR c\.comment NOT LIKE '\[old-cabinet:%'/,
  );
  assert.match(inspector.PARITY_SQL, /c\.comment LIKE '\[old-cabinet:%'/);
  assert.match(
    inspector.PARITY_SQL,
    /m\.status IN \('CONFIRMED', 'COMPLETED'\)/,
  );
  assert.match(inspector.PARITY_SQL, /m\.type <> 'BROKER_TOUR'/);
  assert.match(
    inspector.PARITY_SQL,
    /FROM exact_fixations f\s+JOIN exact_meetings m\s+USING \(period, source, agency_id\)/,
  );
  assert.doesNotMatch(inspector.PARITY_SQL, /fixation_agency_id/i);
});

test("SQL compares exact UTC labels with the fail-open Moscow candidate range", () => {
  assert.match(inspector.PARITY_SQL, /start_date::timestamp AS exact_from/);
  assert.match(
    inspector.PARITY_SQL,
    /\(finish_date \+ 1\)::timestamp AS exact_to/,
  );
  assert.match(
    inspector.PARITY_SQL,
    /LEAST\([\s\S]*start_date::timestamp,[\s\S]*AT TIME ZONE 'Europe\/Moscow'\) AT TIME ZONE 'UTC'[\s\S]*\) AS candidate_from/,
  );
  assert.match(
    inspector.PARITY_SQL,
    /GREATEST\([\s\S]*\(finish_date \+ 1\)::timestamp,[\s\S]*AT TIME ZONE 'Europe\/Moscow'\) AT TIME ZONE 'UTC'[\s\S]*\) AS candidate_to/,
  );
  assert.match(inspector.PARITY_SQL, /c\.created_at >= b\.exact_from/);
  assert.match(inspector.PARITY_SQL, /c\.created_at < b\.exact_to/);
  assert.match(inspector.PARITY_SQL, /c\.created_at >= b\.candidate_from/);
  assert.match(inspector.PARITY_SQL, /c\.created_at < b\.candidate_to/);
  assert.deepEqual(inspector.PERIODS, [
    { name: "month", from: "2026-10-01", to: "2026-10-31" },
    { name: "quarter", from: "2026-10-01", to: "2026-12-31" },
    { name: "custom", from: "2021-01-01", to: "2022-12-31" },
  ]);
  for (const { name, from, to } of inspector.PERIODS) {
    assert.match(
      inspector.PARITY_SQL,
      new RegExp(`\\('${name}'::text, DATE '${from}', DATE '${to}'\\)`),
    );
  }
});

test("report contains only counts and digests, never agency ids", () => {
  const report = inspector.buildReport(completeRows(), DIGEST_KEY);
  assert.equal(report.parity, true);
  assert.equal(report.fullApiParityClaimed, false);
  assert.equal(report.scenarioCount, 27);
  assert.equal(report.scenarios.length, 27);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.exactCount, 1);
    assert.equal(scenario.candidateCount, 2);
    assert.equal(scenario.missingCount, 0);
    assert.equal(scenario.extraCount, 1);
    assert.match(scenario.exactDigest, /^[0-9a-f]{64}$/);
    assert.match(scenario.candidateDigest, /^[0-9a-f]{64}$/);
    assert.match(scenario.missingDigest, /^[0-9a-f]{64}$/);
  }
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(AGENCY_A));
  assert.doesNotMatch(serialized, new RegExp(AGENCY_B));
});

test("digests are deterministic only within one private run key", () => {
  const rows = completeRows();
  const first = inspector.buildReport(rows, DIGEST_KEY);
  const repeated = inspector.buildReport(rows, DIGEST_KEY);
  const independent = inspector.buildReport(rows, Buffer.alloc(32, 0x43));
  assert.deepEqual(first, repeated);
  assert.notEqual(
    first.scenarios[0].exactDigest,
    independent.scenarios[0].exactDigest,
  );
});

test("a missing candidate remains visible only as a count and digest", () => {
  const report = inspector.buildReport(
    completeRows(({ period, source, metric, variant }) => {
      if (
        period === "month" &&
        source === "new" &&
        metric === "fixations" &&
        variant === "candidate"
      ) {
        return [];
      }
      return null;
    }),
    DIGEST_KEY,
  );
  assert.equal(report.parity, false);
  const failed = report.scenarios.find(
    (row) =>
      row.period === "month" &&
      row.source === "new" &&
      row.metric === "fixations",
  );
  assert.equal(failed.missingCount, 1);
  assert.equal(failed.candidateCount, 0);
  assert.match(failed.missingDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(AGENCY_A));
});

test("null, unknown, duplicate and unsorted query shapes fail closed", () => {
  assert.throws(
    () => inspector.buildReport(null, DIGEST_KEY),
    /QUERY_RESULT_INVALID/,
  );
  const unknown = completeRows();
  unknown[0] = { ...unknown[0], source: "other" };
  assert.throws(
    () => inspector.buildReport(unknown, DIGEST_KEY),
    /QUERY_RESULT_INVALID/,
  );
  const nullable = completeRows();
  nullable[0] = { ...nullable[0], agency_ids: null };
  assert.throws(
    () => inspector.buildReport(nullable, DIGEST_KEY),
    /QUERY_RESULT_INVALID/,
  );
  const duplicate = completeRows();
  duplicate[0] = { ...duplicate[0], agency_ids: [AGENCY_A, AGENCY_A] };
  assert.throws(
    () => inspector.buildReport(duplicate, DIGEST_KEY),
    /QUERY_RESULT_INVALID/,
  );
  const unsorted = completeRows();
  unsorted[0] = { ...unsorted[0], agency_ids: [AGENCY_B, AGENCY_A] };
  assert.throws(
    () => inspector.buildReport(unsorted, DIGEST_KEY),
    /QUERY_RESULT_INVALID/,
  );
  assert.throws(
    () => inspector.buildReport(completeRows(), Buffer.alloc(31)),
    /QUERY_RESULT_INVALID/,
  );
});

test("read-only URL preserves prior options and forces bounded read-only sessions", () => {
  const result = new URL(
    inspector.buildReadOnlyDatabaseUrl(
      "postgresql://user:pass@db.internal:5432/app?schema=public&options=-c%20search_path%3Dpublic",
    ),
  );
  assert.equal(result.searchParams.get("schema"), "public");
  const options = result.searchParams.get("options");
  assert.match(options, /search_path=public/);
  assert.match(options, /default_transaction_read_only=on/);
  assert.match(options, /statement_timeout=20000/);
  assert.match(options, /lock_timeout=1000/);
  assert.throws(
    () => inspector.buildReadOnlyDatabaseUrl("mysql://db/app"),
    /DATABASE_URL_INVALID/,
  );
});

test("inspector attests repeatable read-only identity before one parity query", async () => {
  const calls = [];
  const tx = {
    $executeRawUnsafe: async (sql) => {
      calls.push(["execute", sql]);
      return 0;
    },
    $queryRawUnsafe: async (sql) => {
      calls.push(["query", sql]);
      return sql === inspector.ATTESTATION_SQL ? attestation() : completeRows();
    },
  };
  const prisma = {
    $transaction: async (callback, options) => {
      calls.push(["transaction", options]);
      return callback(tx);
    },
  };

  const report = await inspector.inspect(prisma, environment);
  assert.equal(report.parity, true);
  assert.deepEqual(calls[0], ["transaction", { timeout: 30000 }]);
  assert.match(calls[1][1], /REPEATABLE READ READ ONLY/);
  assert.match(calls[2][1], /statement_timeout = '20000ms'/);
  assert.match(calls[3][1], /lock_timeout = '1000ms'/);
  assert.equal(calls[4][1], inspector.ATTESTATION_SQL);
  assert.equal(calls[5][1], inspector.PARITY_SQL);
  assert.equal(calls.length, 6);
});

test("database attestation rejects writable, weak, null and wrong identities", () => {
  assert.match(
    inspector.ATTESTATION_SQL,
    /current_database\(\) AS database_name/,
  );
  inspector.validateAttestation(attestation(), environment);
  for (const changed of [
    { database_name: "postgres" },
    { database_name: null },
    { read_only: "off" },
    { isolation: "read committed" },
    { statement_timeout: "0" },
    { lock_timeout: "0" },
    { system_identifier: null },
    { broker_rows: "9999" },
  ]) {
    assert.throws(
      () => inspector.validateAttestation(attestation(changed), environment),
      /DATABASE_ATTESTATION_INVALID/,
    );
  }
});

test("failure classification never reflects arbitrary error text", () => {
  assert.equal(
    inspector.failureCode({ code: "P2010", meta: { code: "57014" } }),
    "STATEMENT_TIMEOUT",
  );
  assert.equal(
    inspector.failureCode({ code: "P2010", meta: { code: "42P01" } }),
    "DATABASE_QUERY_FAILED",
  );
  assert.equal(
    inspector.failureCode(new Error("secret row and SQL text")),
    "UNKNOWN_FAILURE",
  );
  assert.equal(
    inspector.failureCode({ name: "PrismaClientUnknownRequestError" }),
    "DATABASE_QUERY_FAILED",
  );
  assert.equal(
    inspector.failureCode({ code: "42P01", message: "secret table" }),
    "DATABASE_QUERY_FAILED",
  );
  assert.equal(
    inspector.failureCode({ code: "57014", message: "secret query" }),
    "STATEMENT_TIMEOUT",
  );
});

test("workflow pins source, SSH, runtime, DB identity and sanitizes artifacts", () => {
  const workflow = readFileSync(
    path.join(
      __dirname,
      "../.github/workflows/inspect-production-loyalty-agency-period-candidate-parity.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /test "\$EXPECTED_REF" = refs\/heads\/master/);
  assert.match(workflow, /git show "\$SOURCE_SHA:\$inspector_path"/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /fingerprints\[0\].*EXPECTED_SSH_FINGERPRINT/);
  assert.match(workflow, /flock -s -n 9/);
  assert.match(workflow, /git rev-parse HEAD.*expected_deployed_sha/);
  assert.match(
    workflow,
    /docker exec st-michael-api sh -c 'printf %s "\$GIT_SHA"'/,
  );
  assert.match(workflow, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(workflow, /PRODUCTION_PG_SYSTEM_IDENTIFIER/);
  assert.match(workflow, /\/tmp\/st-michael-loyalty-parity\.XXXXXX/);
  assert.match(workflow, /stat -c %a "\$work".*700/);
  assert.match(
    workflow,
    /\.parity == true and all\(\.scenarios\[\]; \.missingCount == 0\)/,
  );
  assert.match(workflow, /\(\$r\.parity \| type\) == "boolean"/);
  assert.match(
    workflow,
    /docker exec st-michael-api sh -c '[\s\S]*test -f "\$report" -a ! -L "\$report" -a -s "\$report"[\s\S]*test -f "\$errors" -a ! -L "\$errors" -a ! -s "\$errors"[\s\S]*' verify-output "\$report" "\$errors"/,
  );
  assert.doesNotMatch(workflow, /^\s*test -s "\$report"/m);
  assert.match(workflow, /loyalty_parity_failure_code=UNKNOWN_FAILURE/);
  assert.doesNotMatch(
    workflow,
    /docker compose up|docker restart|git pull|system prune|INSERT|UPDATE|DELETE/i,
  );
  assert.doesNotMatch(
    workflow,
    /actions\/upload-artifact|GITHUB_STEP_SUMMARY|\btee\b/,
  );
});

test("source attestation is a SHA-256 of exact bytes", () => {
  const sourcePath =
    require.resolve("./inspect-loyalty-agency-period-candidate-parity");
  const digest = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex");
  assert.doesNotThrow(() =>
    inspector.attestRuntime(
      {
        LOYALTY_PARITY_INSPECTOR_SHA256: digest,
        LOYALTY_PARITY_DEPLOYED_GIT_SHA: "a".repeat(40),
        GIT_SHA: "a".repeat(40),
      },
      sourcePath,
    ),
  );
  assert.throws(
    () =>
      inspector.attestRuntime(
        {
          LOYALTY_PARITY_INSPECTOR_SHA256: "b".repeat(64),
          LOYALTY_PARITY_DEPLOYED_GIT_SHA: "a".repeat(40),
          GIT_SHA: "a".repeat(40),
        },
        sourcePath,
      ),
    /SOURCE_ATTESTATION_INVALID/,
  );
});
