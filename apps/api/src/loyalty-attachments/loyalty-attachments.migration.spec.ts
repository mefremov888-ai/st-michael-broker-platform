import { readFileSync } from "fs";
import { resolve } from "path";

describe("loyalty protected attachment migration safety", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../../../packages/database/prisma/migrations/20260824000300_loyalty_event_attachments/migration.sql",
    ),
    "utf8",
  );

  it("is an atomic additive migration ordered after event versioning", () => {
    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+"/i);
    expect(sql).toContain('CREATE TABLE "loyalty_event_attachments"');
    expect(sql).toContain(
      'FOREIGN KEY ("event_id") REFERENCES "loyalty_engagement_events"("id")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("created_by_id") REFERENCES "brokers"("id")',
    );
  });

  it("database-enforces binary size, type, digest and immutable archive semantics", () => {
    expect(sql).toContain('octet_length("data") = "size"');
    expect(sql).toContain('"size" <= 5242880');
    expect(sql).toContain("\"sha256\" ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain("loyalty_event_attachments_mime_type_check");
    expect(sql).toContain(
      "loyalty event attachment bytes and metadata are immutable",
    );
    expect(sql).toContain('NEW."data" IS DISTINCT FROM OLD."data"');
    expect(sql).toContain(
      "loyalty event attachment can only transition from active to archived",
    );
    expect(sql).toContain("NEW.version <> OLD.version + 1");
    expect(sql).toContain("loyalty event attachments cannot be deleted");
  });

  it("serializes and caps lifetime storage per event, including archived rows", () => {
    expect(sql).toContain("loyalty_event_attachments_storage_limit");
    expect(sql).toContain('WHERE "id" = NEW."event_id"\n    FOR UPDATE');
    expect(sql).toContain("attachment_count >= 20");
    expect(sql).toContain('attachment_bytes + NEW."size" > 52428800');
    expect(sql).toContain(
      'FROM "loyalty_event_attachments"\n    WHERE "event_id" = NEW."event_id"',
    );
    expect(sql).toContain("loyalty attachment parent event is not active");
    expect(sql).toContain('WHERE "corrects_event_id" = NEW."event_id"');
    expect(sql).toContain(
      "loyalty attachment requires the current event revision",
    );
  });
});
