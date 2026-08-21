-- Preserve curated legacy rollups as aggregate evidence. Never expand these
-- values into synthetic loyalty_activities: the source has no event identity.
BEGIN;

CREATE TYPE "LoyaltyAggregateQuality" AS ENUM (
  'SOURCE_REPORTED',
  'PARTIAL',
  'UNVERIFIED'
);

CREATE TYPE "LoyaltyAggregateExactness" AS ENUM (
  'EXACT',
  'APPROXIMATE',
  'UNKNOWN'
);

CREATE TYPE "LoyaltyAggregatePeriodKind" AS ENUM (
  'LIFETIME',
  'DATE_RANGE',
  'MONTHLY_BREAKDOWN',
  'UNKNOWN'
);

ALTER TABLE "loyalty_metric_snapshots"
  ADD COLUMN "activity_evidence_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "loyalty_metric_snapshots" AS metric
SET "activity_evidence_count" = evidence."count"
FROM (
  SELECT
    "source_record_id",
    "rule_version",
    COUNT(*)::INTEGER AS "count"
  FROM "loyalty_activities"
  GROUP BY "source_record_id", "rule_version"
) AS evidence
WHERE evidence."source_record_id" = metric."source_record_id"
  AND evidence."rule_version" = metric."rule_version";

ALTER TABLE "loyalty_metric_snapshots"
  ADD CONSTRAINT "loyalty_metric_snapshots_activity_evidence_count_check"
  CHECK ("activity_evidence_count" >= 0);

CREATE TABLE "loyalty_source_aggregates" (
  "id" TEXT NOT NULL,
  "source_record_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_version" TEXT NOT NULL,
  "source_label" TEXT,
  "quality" "LoyaltyAggregateQuality" NOT NULL,
  "exactness" "LoyaltyAggregateExactness" NOT NULL,
  "period_kind" "LoyaltyAggregatePeriodKind" NOT NULL DEFAULT 'UNKNOWN',
  "period_from" TIMESTAMP(3),
  "period_to" TIMESTAMP(3),
  "contributes_to_source_summary" BOOLEAN NOT NULL DEFAULT false,
  "fixation_count" INTEGER,
  "meeting_count" INTEGER,
  "deal_count" INTEGER,
  "broker_tour_count" INTEGER,
  "call_count" INTEGER,
  "deal_amount" DECIMAL(18,2),
  "currency" TEXT,
  "last_fixation_at" TIMESTAMP(3),
  "last_meeting_at" TIMESTAMP(3),
  "last_deal_at" TIMESTAMP(3),
  "last_call_at" TIMESTAMP(3),
  "broker_tour_visited" BOOLEAN,
  "broker_tour_at" TIMESTAMP(3),
  "deals_by_month" JSONB,
  "call_breakdown" JSONB,
  "provenance" JSONB,
  "reported_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_source_aggregates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_source_aggregates_counts_check" CHECK (
    ("fixation_count" IS NULL OR "fixation_count" >= 0) AND
    ("meeting_count" IS NULL OR "meeting_count" >= 0) AND
    ("deal_count" IS NULL OR "deal_count" >= 0) AND
    ("broker_tour_count" IS NULL OR "broker_tour_count" >= 0) AND
    ("call_count" IS NULL OR "call_count" >= 0)
  ),
  CONSTRAINT "loyalty_source_aggregates_amount_check" CHECK (
    "deal_amount" IS NULL OR "deal_amount" >= 0
  ),
  CONSTRAINT "loyalty_source_aggregates_currency_check" CHECK (
    ("deal_amount" IS NULL AND "currency" IS NULL) OR
    ("deal_amount" IS NOT NULL AND "currency" = 'RUB')
  ),
  CONSTRAINT "loyalty_source_aggregates_period_check" CHECK (
    ("period_kind" <> 'DATE_RANGE' OR
      ("period_from" IS NOT NULL AND "period_to" IS NOT NULL)) AND
    ("period_to" IS NULL OR
      ("period_from" IS NOT NULL AND "period_to" >= "period_from"))
  ),
  CONSTRAINT "loyalty_source_aggregates_summary_quality_check" CHECK (
    NOT "contributes_to_source_summary" OR "quality" = 'SOURCE_REPORTED'
  )
);

CREATE UNIQUE INDEX "loyalty_source_aggregates_source_record_id_key"
  ON "loyalty_source_aggregates"("source_record_id");
CREATE INDEX "loyalty_source_aggregates_summary_idx"
  ON "loyalty_source_aggregates"("quality", "contributes_to_source_summary");
CREATE INDEX "loyalty_source_aggregates_source_kind_source_version_idx"
  ON "loyalty_source_aggregates"("source_kind", "source_version");

ALTER TABLE "loyalty_source_aggregates"
  ADD CONSTRAINT "loyalty_source_aggregates_source_record_id_fkey"
  FOREIGN KEY ("source_record_id") REFERENCES "loyalty_source_records"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
