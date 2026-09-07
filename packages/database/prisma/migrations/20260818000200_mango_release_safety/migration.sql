BEGIN;

-- Fail closed if historical data violates the new one-to-one mapping.
-- An operator must resolve duplicates explicitly; this migration never
-- deletes rows or picks a winner automatically.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "brokers"
    WHERE "mango_employee_num" IS NOT NULL
    GROUP BY "mango_employee_num"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique Mango employee numbers: duplicate non-null values exist';
  END IF;
END $$;

-- Official /events/call sequence counter used for atomic stale-event guards.
ALTER TABLE "calls" ADD COLUMN "mango_event_seq" BIGINT;

-- PostgreSQL unique indexes allow multiple NULL values, so employees without
-- a configured Mango extension remain valid.
CREATE UNIQUE INDEX "brokers_mango_employee_num_key"
  ON "brokers"("mango_employee_num");

COMMIT;
