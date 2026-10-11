#!/usr/bin/env node
"use strict";

const { createHash, createHmac, randomBytes } = require("node:crypto");
const { readFileSync } = require("node:fs");

const STATEMENT_TIMEOUT_MS = 20_000;
// Fixed evidence windows for a one-time production parity check. They are not
// an evergreen definition of the product's month or quarter filters.
const PERIODS = Object.freeze([
  Object.freeze({ name: "month", from: "2026-10-01", to: "2026-10-31" }),
  Object.freeze({ name: "quarter", from: "2026-10-01", to: "2026-12-31" }),
  Object.freeze({ name: "custom", from: "2021-01-01", to: "2022-12-31" }),
]);
const SOURCES = Object.freeze(["all", "old", "new"]);
const METRICS = Object.freeze(["fixations", "meetings", "independent_and"]);
const VARIANTS = Object.freeze(["exact", "candidate"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

const PARITY_SQL = `
WITH periods(period, start_date, finish_date) AS (
  VALUES
    ('month'::text, DATE '2026-10-01', DATE '2026-10-31'),
    ('quarter'::text, DATE '2026-10-01', DATE '2026-12-31'),
    ('custom'::text, DATE '2021-01-01', DATE '2022-12-31')
), bounds AS (
  SELECT
    period,
    start_date::timestamp AS exact_from,
    (finish_date + 1)::timestamp AS exact_to,
    LEAST(
      start_date::timestamp,
      (start_date::timestamp AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'UTC'
    ) AS candidate_from,
    GREATEST(
      (finish_date + 1)::timestamp,
      ((finish_date + 1)::timestamp AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'UTC'
    ) AS candidate_to
  FROM periods
), sources(source) AS (
  VALUES ('all'::text), ('old'::text), ('new'::text)
), exact_fixations AS (
  SELECT DISTINCT b.period, s.source, ba.agency_id::text AS agency_id
  FROM bounds b
  CROSS JOIN sources s
  CROSS JOIN public.broker_agencies ba
  JOIN public.clients c ON c.broker_id = ba.broker_id
  WHERE c.created_at >= b.exact_from
    AND c.created_at < b.exact_to
    AND (
      c.fixation_status IN ('FIXED', 'EXPIRED')
      OR c.uniqueness_status IN ('CONDITIONALLY_UNIQUE', 'EXPIRED')
    )
    AND (
      s.source = 'all'
      OR (s.source = 'old' AND c.comment LIKE '[old-cabinet:%')
      OR (
        s.source = 'new'
        AND (c.comment IS NULL OR c.comment NOT LIKE '[old-cabinet:%')
      )
    )
), candidate_fixations AS (
  SELECT DISTINCT b.period, s.source, ba.agency_id::text AS agency_id
  FROM bounds b
  CROSS JOIN sources s
  CROSS JOIN public.broker_agencies ba
  JOIN public.clients c ON c.broker_id = ba.broker_id
  WHERE c.created_at >= b.candidate_from
    AND c.created_at < b.candidate_to
    AND (
      c.fixation_status IN ('FIXED', 'EXPIRED')
      OR c.uniqueness_status IN ('CONDITIONALLY_UNIQUE', 'EXPIRED')
    )
    AND (
      s.source = 'all'
      OR (s.source = 'old' AND c.comment LIKE '[old-cabinet:%')
      OR (
        s.source = 'new'
        AND (c.comment IS NULL OR c.comment NOT LIKE '[old-cabinet:%')
      )
    )
), exact_meetings AS (
  SELECT DISTINCT b.period, s.source, ba.agency_id::text AS agency_id
  FROM bounds b
  CROSS JOIN sources s
  CROSS JOIN public.broker_agencies ba
  JOIN public.meetings m ON m.broker_id = ba.broker_id
  WHERE m.date >= b.exact_from
    AND m.date < b.exact_to
    AND m.status IN ('CONFIRMED', 'COMPLETED')
    AND m.type <> 'BROKER_TOUR'
), candidate_meetings AS (
  SELECT DISTINCT b.period, s.source, ba.agency_id::text AS agency_id
  FROM bounds b
  CROSS JOIN sources s
  CROSS JOIN public.broker_agencies ba
  JOIN public.meetings m ON m.broker_id = ba.broker_id
  WHERE m.date >= b.candidate_from
    AND m.date < b.candidate_to
    AND m.status IN ('CONFIRMED', 'COMPLETED')
    AND m.type <> 'BROKER_TOUR'
), exact_independent_and AS (
  SELECT f.period, f.source, f.agency_id
  FROM exact_fixations f
  JOIN exact_meetings m
    USING (period, source, agency_id)
), candidate_independent_and AS (
  SELECT f.period, f.source, f.agency_id
  FROM candidate_fixations f
  JOIN candidate_meetings m
    USING (period, source, agency_id)
), membership(period, source, metric, variant, agency_id) AS (
  SELECT period, source, 'fixations', 'exact', agency_id FROM exact_fixations
  UNION ALL
  SELECT period, source, 'fixations', 'candidate', agency_id FROM candidate_fixations
  UNION ALL
  SELECT period, source, 'meetings', 'exact', agency_id FROM exact_meetings
  UNION ALL
  SELECT period, source, 'meetings', 'candidate', agency_id FROM candidate_meetings
  UNION ALL
  SELECT period, source, 'independent_and', 'exact', agency_id FROM exact_independent_and
  UNION ALL
  SELECT period, source, 'independent_and', 'candidate', agency_id FROM candidate_independent_and
), metrics(metric) AS (
  VALUES ('fixations'::text), ('meetings'::text), ('independent_and'::text)
), variants(variant) AS (
  VALUES ('exact'::text), ('candidate'::text)
), groups AS (
  SELECT p.period, s.source, m.metric, v.variant
  FROM periods p
  CROSS JOIN sources s
  CROSS JOIN metrics m
  CROSS JOIN variants v
)
SELECT
  g.period,
  g.source,
  g.metric,
  g.variant,
  COALESCE(
    array_agg(member.agency_id ORDER BY member.agency_id)
      FILTER (WHERE member.agency_id IS NOT NULL),
    ARRAY[]::text[]
  ) AS agency_ids
FROM groups g
LEFT JOIN membership member
  USING (period, source, metric, variant)
GROUP BY g.period, g.source, g.metric, g.variant
ORDER BY g.period, g.source, g.metric, g.variant
`;

const ATTESTATION_SQL = `
SELECT
  current_database() AS database_name,
  current_setting('transaction_read_only') AS read_only,
  current_setting('transaction_isolation') AS isolation,
  current_setting('statement_timeout') AS statement_timeout,
  current_setting('lock_timeout') AS lock_timeout,
  system_identifier::text AS system_identifier,
  (SELECT count(*)::text FROM public.brokers) AS broker_rows
FROM pg_control_system()
`;

class SafeRefusal extends Error {
  constructor(safeCode) {
    super(safeCode);
    this.safeCode = safeCode;
  }
}

function refuse(safeCode) {
  throw new SafeRefusal(safeCode);
}

function hashIds(ids, digestKey) {
  if (!Buffer.isBuffer(digestKey) || digestKey.length !== 32) {
    refuse("QUERY_RESULT_INVALID");
  }
  return createHmac("sha256", digestKey)
    .update(ids.join("\n"), "utf8")
    .digest("hex");
}

function buildReadOnlyDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    refuse("DATABASE_URL_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    refuse("DATABASE_URL_INVALID");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    refuse("DATABASE_URL_INVALID");
  }
  const existing = parsed.searchParams
    .getAll("options")
    .map((value) => value.trim())
    .filter(Boolean);
  parsed.searchParams.delete("options");
  parsed.searchParams.append(
    "options",
    [
      ...existing,
      "-c default_transaction_read_only=on",
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      "-c lock_timeout=1000",
    ].join(" "),
  );
  return parsed.toString();
}

function expectedGroupKeys() {
  const keys = [];
  for (const period of PERIODS) {
    for (const source of SOURCES) {
      for (const metric of METRICS) {
        for (const variant of VARIANTS) {
          keys.push(`${period.name}|${source}|${metric}|${variant}`);
        }
      }
    }
  }
  return keys;
}

function normalizeMembershipRows(rows) {
  if (!Array.isArray(rows)) refuse("QUERY_RESULT_INVALID");
  const groups = new Map();
  const expected = new Set(expectedGroupKeys());
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      refuse("QUERY_RESULT_INVALID");
    }
    const keys = Object.keys(row).sort();
    if (
      JSON.stringify(keys) !==
      JSON.stringify(["agency_ids", "metric", "period", "source", "variant"])
    ) {
      refuse("QUERY_RESULT_INVALID");
    }
    const key = `${row.period}|${row.source}|${row.metric}|${row.variant}`;
    if (
      !expected.has(key) ||
      groups.has(key) ||
      !Array.isArray(row.agency_ids)
    ) {
      refuse("QUERY_RESULT_INVALID");
    }
    const ids = row.agency_ids.map((value) => {
      if (typeof value !== "string" || !UUID.test(value)) {
        refuse("QUERY_RESULT_INVALID");
      }
      return value;
    });
    const sorted = [...new Set(ids)].sort();
    if (
      ids.length !== sorted.length ||
      ids.some((value, index) => value !== sorted[index])
    ) {
      refuse("QUERY_RESULT_INVALID");
    }
    groups.set(key, sorted);
  }
  if (groups.size !== expected.size || rows.length !== expected.size) {
    refuse("QUERY_RESULT_INVALID");
  }
  return groups;
}

function buildReport(rows, digestKey = randomBytes(32)) {
  const groups = normalizeMembershipRows(rows);
  const scenarios = [];
  for (const period of PERIODS) {
    for (const source of SOURCES) {
      for (const metric of METRICS) {
        const exact = groups.get(`${period.name}|${source}|${metric}|exact`);
        const candidate = groups.get(
          `${period.name}|${source}|${metric}|candidate`,
        );
        if (!exact || !candidate) refuse("QUERY_RESULT_INVALID");
        const candidateSet = new Set(candidate);
        const exactSet = new Set(exact);
        const missing = exact.filter((id) => !candidateSet.has(id));
        const extra = candidate.filter((id) => !exactSet.has(id));
        scenarios.push({
          period: period.name,
          source,
          metric,
          exactCount: exact.length,
          candidateCount: candidate.length,
          missingCount: missing.length,
          extraCount: extra.length,
          exactDigest: hashIds(exact, digestKey),
          candidateDigest: hashIds(candidate, digestKey),
          missingDigest: hashIds(missing, digestKey),
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    // This proves only that the SQL candidate sets are supersets for these
    // fixed windows. It deliberately does not claim compiled API parity.
    scope: "AGENCY_PERIOD_SQL_CANDIDATE_SUPERSET_ONLY",
    fullApiParityClaimed: false,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    scenarioCount: scenarios.length,
    parity: scenarios.every((scenario) => scenario.missingCount === 0),
    scenarios,
  };
}

function validateAttestation(rows, env) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    refuse("DATABASE_ATTESTATION_INVALID");
  }
  const row = rows[0];
  const expectedIdentifier = String(env.PRODUCTION_PG_SYSTEM_IDENTIFIER || "");
  const minimumRows = Number(env.PRODUCTION_MIN_BROKER_ROWS);
  const brokerRows = Number(row?.broker_rows);
  if (
    row?.database_name !== "broker_platform" ||
    row?.read_only !== "on" ||
    row?.isolation !== "repeatable read" ||
    !new Set(["20s", "20000ms"]).has(row?.statement_timeout) ||
    !new Set(["1s", "1000ms"]).has(row?.lock_timeout) ||
    !/^[0-9]+$/.test(expectedIdentifier) ||
    row?.system_identifier !== expectedIdentifier ||
    !Number.isSafeInteger(minimumRows) ||
    minimumRows <= 0 ||
    !Number.isSafeInteger(brokerRows) ||
    brokerRows < minimumRows
  ) {
    refuse("DATABASE_ATTESTATION_INVALID");
  }
}

async function inspect(prisma, env) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`,
      );
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
      const attestation = await tx.$queryRawUnsafe(ATTESTATION_SQL);
      validateAttestation(attestation, env);
      return buildReport(await tx.$queryRawUnsafe(PARITY_SQL));
    },
    { timeout: 30_000 },
  );
}

function attestRuntime(env, sourcePath) {
  const expectedSource = String(env.LOYALTY_PARITY_INSPECTOR_SHA256 || "");
  const expectedDeployed = String(env.LOYALTY_PARITY_DEPLOYED_GIT_SHA || "");
  const runtimeSha = String(env.GIT_SHA || "");
  if (!SHA256.test(expectedSource) || !GIT_SHA.test(expectedDeployed)) {
    refuse("SOURCE_ATTESTATION_INVALID");
  }
  const actualSource = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex");
  if (actualSource !== expectedSource || runtimeSha !== expectedDeployed) {
    refuse("SOURCE_ATTESTATION_INVALID");
  }
}

const SAFE_CODES = new Set([
  "SOURCE_ATTESTATION_INVALID",
  "DATABASE_URL_INVALID",
  "DATABASE_ATTESTATION_INVALID",
  "QUERY_RESULT_INVALID",
  "STATEMENT_TIMEOUT",
  "DATABASE_QUERY_FAILED",
  "PARITY_MISSING_CANDIDATES",
  "UNKNOWN_FAILURE",
]);

function failureCode(error) {
  try {
    if (SAFE_CODES.has(error?.safeCode)) return error.safeCode;
    if (error?.code === "P2024") return "DATABASE_QUERY_FAILED";
    if (error?.code === "P2010") {
      return error?.meta?.code === "57014"
        ? "STATEMENT_TIMEOUT"
        : "DATABASE_QUERY_FAILED";
    }
    if (error?.name === "PrismaClientUnknownRequestError") {
      return "DATABASE_QUERY_FAILED";
    }
    if (typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)) {
      return error.code === "57014"
        ? "STATEMENT_TIMEOUT"
        : "DATABASE_QUERY_FAILED";
    }
  } catch {
    return "UNKNOWN_FAILURE";
  }
  return "UNKNOWN_FAILURE";
}

async function main() {
  attestRuntime(process.env, __filename);
  const { PrismaClient } = require("/app/node_modules/@st-michael/database");
  const prisma = new PrismaClient({
    datasources: {
      db: { url: buildReadOnlyDatabaseUrl(process.env.DATABASE_URL) },
    },
    log: [],
  });
  try {
    const report = await inspect(prisma, process.env);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.parity) refuse("PARITY_MISSING_CANDIDATES");
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  ATTESTATION_SQL,
  METRICS,
  PARITY_SQL,
  PERIODS,
  SOURCES,
  STATEMENT_TIMEOUT_MS,
  VARIANTS,
  attestRuntime,
  buildReadOnlyDatabaseUrl,
  buildReport,
  expectedGroupKeys,
  failureCode,
  hashIds,
  inspect,
  normalizeMembershipRows,
  validateAttestation,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`loyalty_parity_failure_code=${failureCode(error)}\n`);
    process.exitCode = 1;
  });
}
