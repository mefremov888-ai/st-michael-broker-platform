import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";

describe("loyalty base migration safety", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../../../packages/database/prisma/migrations/20260818000100_loyalty_base/migration.sql",
    ),
    "utf8",
  );
  const baselineSql = readFileSync(
    resolve(
      __dirname,
      "../../../../packages/database/prisma/migrations/0_legacy_baseline/migration.sql",
    ),
    "utf8",
  );
  const baselineSchema = readFileSync(
    resolve(
      __dirname,
      "../../../../packages/database/prisma/baselines/0_legacy_baseline.prisma",
    ),
  );
  const aggregateSql = readFileSync(
    resolve(
      __dirname,
      "../../../../packages/database/prisma/migrations/20260821000100_loyalty_source_aggregates/migration.sql",
    ),
    "utf8",
  );

  it("is atomic and enforces cross-dataset ownership at the database boundary", () => {
    expect(sql.trimStart()).toContain("BEGIN;");
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain("loyalty_datasets_active_snapshot_owner_fkey");
    expect(sql).toContain("loyalty_publication_events_snapshot_owner_fkey");
    expect(sql).toContain("loyalty_publication_events_previous_owner_fkey");
    expect(sql).toContain("loyalty_reconciliation_cases_snapshot_owner_fkey");
    expect(sql).toContain("loyalty_reconciliation_cases_person_owner_fkey");
    expect(sql).toContain(
      "loyalty_reconciliation_cases_organization_owner_fkey",
    );
  });

  it("requires a published active snapshot and makes publication evidence append-only", () => {
    expect(sql).toContain("loyalty_datasets_active_snapshot_published_trigger");
    expect(sql).toContain("loyalty_snapshots_active_status_guard_trigger");
    expect(sql).toContain("s.\"status\" = 'PUBLISHED'");
    expect(sql).toContain("loyalty_publication_events_append_only_trigger");
    expect(sql).toContain(
      'BEFORE UPDATE OR DELETE ON "loyalty_publication_events"',
    );
  });

  it("persists manual entity audit values before and after each mutation", () => {
    expect(sql).toContain('"before_values" JSONB');
    expect(sql).toContain('"after_values" JSONB');
  });

  it("pins the real pre-loyalty baseline before the additive loyalty migration", () => {
    const digest = (value: string | Buffer) =>
      createHash("sha256").update(value).digest("hex").toUpperCase();
    expect(digest(baselineSchema)).toBe(
      "441C03DFC60C931D3CC22329F2651E744655279D2C332096EAF983976991A419",
    );
    expect(digest(baselineSql)).toBe(
      "646F98459ABB9D4ED6746810F403188B45270656C5E6EA20E89D53465A870A08",
    );
    expect(baselineSql).not.toMatch(
      /CREATE TYPE "Loyalty|(?:CREATE|ALTER|REFERENCES)[^\n]*"loyalty_/i,
    );
    expect(
      "0_legacy_baseline".localeCompare("20260818000100_loyalty_base"),
    ).toBeLessThan(0);
    expect(baselineSql.trimStart()).toContain("BEGIN;");
    expect(baselineSql.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("stores source rollups separately and never synthesizes activities", () => {
    expect(aggregateSql.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/);
    expect(aggregateSql.trimEnd()).toMatch(/COMMIT;$/);
    expect(aggregateSql).toContain('CREATE TABLE "loyalty_source_aggregates"');
    expect(aggregateSql).toContain(
      '"contributes_to_source_summary" BOOLEAN NOT NULL DEFAULT false',
    );
    expect(aggregateSql).toContain(
      "loyalty_source_aggregates_summary_quality_check",
    );
    expect(aggregateSql).toContain('ADD COLUMN "activity_evidence_count"');
    expect(aggregateSql).toContain(
      'GROUP BY "source_record_id", "rule_version"',
    );
    expect(aggregateSql).toContain(
      'evidence."rule_version" = metric."rule_version"',
    );
    expect(aggregateSql).not.toMatch(/INSERT\s+INTO\s+"loyalty_activities"/i);
  });
});
