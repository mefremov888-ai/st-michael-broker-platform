BEGIN;

CREATE TABLE "loyalty_event_attachments" (
  "id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "file_name" VARCHAR(240) NOT NULL,
  "mime_type" VARCHAR(120) NOT NULL,
  "size" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "data" BYTEA NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMP(3),
  CONSTRAINT "loyalty_event_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_event_attachments_file_name_check" CHECK (
    length(btrim("file_name")) > 0
  ),
  CONSTRAINT "loyalty_event_attachments_mime_type_check" CHECK (
    "mime_type" IN (
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  ),
  CONSTRAINT "loyalty_event_attachments_size_check" CHECK (
    "size" > 0 AND "size" <= 5242880 AND octet_length("data") = "size"
  ),
  CONSTRAINT "loyalty_event_attachments_sha256_check" CHECK (
    "sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "loyalty_event_attachments_version_check" CHECK ("version" > 0)
);

CREATE INDEX "loyalty_event_attachments_event_id_archived_at_created_at_idx"
  ON "loyalty_event_attachments"("event_id", "archived_at", "created_at");
CREATE INDEX "loyalty_event_attachments_created_by_id_created_at_idx"
  ON "loyalty_event_attachments"("created_by_id", "created_at");

ALTER TABLE "loyalty_event_attachments"
  ADD CONSTRAINT "loyalty_event_attachments_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "loyalty_engagement_events"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_event_attachments"
  ADD CONSTRAINT "loyalty_event_attachments_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "brokers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION loyalty_protect_event_attachment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'loyalty event attachments cannot be deleted';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
     OR NEW."file_name" IS DISTINCT FROM OLD."file_name"
     OR NEW."mime_type" IS DISTINCT FROM OLD."mime_type"
     OR NEW."size" IS DISTINCT FROM OLD."size"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."data" IS DISTINCT FROM OLD."data"
     OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'loyalty event attachment bytes and metadata are immutable';
  END IF;
  IF OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'loyalty event attachment can only transition from active to archived';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'loyalty event attachment version must increment by one';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Serialize inserts per parent event and cap lifetime storage (archived rows
-- still count). This prevents an editor from recycling archive state to grow
-- the protected BYTEA table without a bound, including under concurrent
-- uploads.
CREATE FUNCTION loyalty_limit_event_attachment_storage() RETURNS trigger AS $$
DECLARE
  attachment_count INTEGER;
  attachment_bytes BIGINT;
  parent_archived_at TIMESTAMP(3);
BEGIN
  SELECT "archived_at" INTO parent_archived_at
    FROM "loyalty_engagement_events"
    WHERE "id" = NEW."event_id"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'loyalty attachment parent event does not exist';
  END IF;
  IF parent_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'loyalty attachment parent event is not active';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM "loyalty_engagement_events"
      WHERE "corrects_event_id" = NEW."event_id"
  ) THEN
    RAISE EXCEPTION 'loyalty attachment requires the current event revision';
  END IF;

  SELECT COUNT(*), COALESCE(SUM("size"), 0)
    INTO attachment_count, attachment_bytes
    FROM "loyalty_event_attachments"
    WHERE "event_id" = NEW."event_id";

  IF attachment_count >= 20 OR attachment_bytes + NEW."size" > 52428800 THEN
    RAISE EXCEPTION 'loyalty event attachment storage limit exceeded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_event_attachments_storage_limit
BEFORE INSERT ON "loyalty_event_attachments"
FOR EACH ROW EXECUTE FUNCTION loyalty_limit_event_attachment_storage();

CREATE TRIGGER loyalty_event_attachments_protect
BEFORE UPDATE OR DELETE ON "loyalty_event_attachments"
FOR EACH ROW EXECUTE FUNCTION loyalty_protect_event_attachment();

COMMIT;
