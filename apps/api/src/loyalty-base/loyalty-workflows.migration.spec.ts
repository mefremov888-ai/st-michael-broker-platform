import { readFileSync } from "fs";
import { resolve } from "path";

describe("loyalty workflow migration safety", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../../../packages/database/prisma/migrations/20260824000100_loyalty_workflows/migration.sql",
    ),
    "utf8",
  );

  it("is atomic, additive and leaves cabinet business rows untouched", () => {
    expect(sql.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE)\b/i);
    expect(sql).not.toMatch(
      /(?:UPDATE|DELETE\s+FROM)\s+"(?:brokers|agencies)"/i,
    );
    expect(sql).toContain('CREATE TABLE "loyalty_call_campaigns"');
    expect(sql).toContain('CREATE TABLE "loyalty_call_assignments"');
    expect(sql).toContain('CREATE TABLE "loyalty_call_attempts"');
    expect(sql).toContain('CREATE TABLE "loyalty_tasks"');
    expect(sql).toContain('CREATE TABLE "loyalty_engagement_events"');
    expect(sql).toContain('CREATE TABLE "loyalty_sync_runs"');
    expect(sql).toContain('CREATE TABLE "loyalty_manual_entities"');
    expect(sql).toContain('CREATE TABLE "loyalty_contact_overrides"');
    expect(sql).toContain('CREATE TABLE "loyalty_agency_contact_people"');
  });

  it("enforces one target, retry idempotency and filter-stable assignments", () => {
    expect(sql).toContain("loyalty_call_assignments_one_target_check");
    expect(sql).toContain("loyalty_tasks_one_target_check");
    expect(sql).toContain("loyalty_engagement_events_one_target_check");
    expect(sql).toContain("loyalty_call_attempts_submission_id_key");
    expect(sql).toContain("loyalty_call_campaigns_hash_check");
    expect(sql).toContain("loyalty_call_assignments_campaign_anna_person_key");
    expect(sql).toContain("loyalty_call_assignments_campaign_our_agency_key");
  });

  it("keeps call history append-only and corrections attributable", () => {
    expect(sql).toContain("loyalty_call_attempts_append_only");
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "loyalty_call_attempts"');
    expect(sql).toContain("loyalty_call_attempts_correction_check");
    expect(sql).toContain("loyalty_engagement_events_correction_check");
    expect(sql).toContain("loyalty_engagement_events_protect");
  });

  it("has explicit module grants and audited exports without storing search text in audit columns", () => {
    expect(sql).toContain('CREATE TABLE "loyalty_user_grants"');
    expect(sql).toContain("loyalty_user_grants_active_key");
    expect(sql).toContain('CREATE TABLE "loyalty_export_jobs"');
    expect(sql).toContain('CREATE TABLE "loyalty_workflow_audits"');
    expect(sql).toContain("loyalty_sync_runs_one_active_source_key");
    expect(sql).toContain("loyalty_sync_runs_state_check");
    expect(sql).toContain("loyalty_manual_entities_one_target_check");
    expect(sql).toContain("loyalty_manual_entities_scope_guard");
    expect(sql).toContain("loyalty_contact_overrides_one_target_check");
    expect(sql).toContain("loyalty_contact_overrides_active_value_key");
    expect(sql).toContain("loyalty_contact_overrides_scope_guard");
    expect(sql).toContain("loyalty_agency_contact_people_scope_guard");
    expect(sql).not.toContain('"search" TEXT');
  });
});

describe("loyalty event archive/restore migration safety", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../../../packages/database/prisma/migrations/20260824000200_loyalty_event_restore_version/migration.sql",
    ),
    "utf8",
  );

  it("is an atomic additive version upgrade without business-row rewrites", () => {
    expect(sql.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+"/i);
    expect(sql).toContain(
      'ALTER TABLE "loyalty_engagement_events"\n  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1',
    );
    expect(sql).toContain("loyalty_engagement_events_version_check");
  });

  it("allows only an archive-state toggle paired with one version increment", () => {
    expect(sql).toContain("to_jsonb(NEW) - 'archived_at' - 'version'");
    expect(sql).toContain(
      "(NEW.archived_at IS NULL) = (OLD.archived_at IS NULL)",
    );
    expect(sql).toContain("NEW.version <> OLD.version + 1");
    expect(sql).toContain("loyalty engagement events cannot be deleted");
  });

  it("database-enforces append-only workflow audit history", () => {
    expect(sql).toContain("loyalty_workflow_audits_append_only");
    expect(sql).toContain(
      'BEFORE UPDATE OR DELETE ON "loyalty_workflow_audits"',
    );
    expect(sql).toContain("loyalty workflow audit is append-only");
  });
});
