-- Optimistic and reversible archival for immutable loyalty engagement events.
-- Existing event payloads remain immutable; only archived_at plus its version
-- may change together. Workflow audit rows become database-enforced append-only.
BEGIN;

ALTER TABLE "loyalty_engagement_events"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "loyalty_engagement_events_version_check" CHECK ("version" > 0);

CREATE OR REPLACE FUNCTION loyalty_protect_engagement_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'loyalty engagement events cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'archived_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'archived_at' - 'version') THEN
    RAISE EXCEPTION 'loyalty engagement events are immutable except archived_at and version';
  END IF;
  IF (NEW.archived_at IS NULL) = (OLD.archived_at IS NULL) THEN
    RAISE EXCEPTION 'loyalty engagement event archive state must change';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'loyalty engagement event version must increment by one';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION loyalty_reject_workflow_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'loyalty workflow audit is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_workflow_audits_append_only
BEFORE UPDATE OR DELETE ON "loyalty_workflow_audits"
FOR EACH ROW EXECUTE FUNCTION loyalty_reject_workflow_audit_mutation();

COMMIT;
