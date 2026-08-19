-- Additive bounded context for the Anna loyalty base.
-- No row is inserted into, updated in, or deleted from brokers/agencies.

BEGIN;

CREATE TYPE "LoyaltyBaseKind" AS ENUM ('ANNA', 'OUR');
CREATE TYPE "LoyaltyEntityType" AS ENUM ('BROKER', 'AGENCY');
CREATE TYPE "LoyaltySnapshotStatus" AS ENUM ('STAGED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED');
CREATE TYPE "LoyaltyContactPointType" AS ENUM ('PHONE', 'EMAIL', 'TELEGRAM', 'WHATSAPP', 'OTHER');
CREATE TYPE "LoyaltyExternalSystem" AS ENUM ('AMOCRM', 'BROKER_CABINET', 'GOOGLE_SHEETS', 'ANNA_FILE', 'MANUAL');
CREATE TYPE "LoyaltyExternalEntityType" AS ENUM ('CONTACT', 'COMPANY', 'LEAD', 'OTHER');
CREATE TYPE "LoyaltyActivityType" AS ENUM ('FIXATION', 'MEETING', 'DEAL', 'BROKER_TOUR', 'CALL');
CREATE TYPE "LoyaltyActivityVerdict" AS ENUM ('INCLUDED', 'EXCLUDED', 'UNKNOWN');
CREATE TYPE "LoyaltyLinkStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED', 'REVOKED');
CREATE TYPE "LoyaltyReconciliationStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
CREATE TYPE "LoyaltyReconciliationDecision" AS ENUM ('LINK', 'KEEP_SEPARATE', 'REJECT_MATCH', 'UNLINK');
CREATE TYPE "LoyaltyChangeAction" AS ENUM ('UPDATE', 'ARCHIVE', 'RESTORE');

CREATE TABLE "loyalty_datasets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base" "LoyaltyBaseKind" NOT NULL DEFAULT 'ANNA',
    "active_snapshot_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "loyalty_datasets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "loyalty_snapshots" (
    "id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "status" "LoyaltySnapshotStatus" NOT NULL DEFAULT 'STAGED',
    "source_name" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "rule_version" TEXT NOT NULL,
    "expected_records" INTEGER,
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "broker_count" INTEGER NOT NULL DEFAULT 0,
    "agency_count" INTEGER NOT NULL DEFAULT 0,
    "activity_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "created_by_id" TEXT,
    "published_by_id" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_snapshots_counts_check" CHECK (
      "record_count" >= 0 AND "broker_count" >= 0 AND "agency_count" >= 0
      AND "activity_count" >= 0 AND "error_count" >= 0
      AND "record_count" = "broker_count" + "agency_count"
      AND ("expected_records" IS NULL OR "expected_records" > 0)
    ),
    CONSTRAINT "loyalty_snapshots_publish_state_check" CHECK (
      (("status" IN ('PUBLISHED', 'SUPERSEDED')) AND "published_at" IS NOT NULL AND "error_count" = 0
        AND "expected_records" IS NOT NULL AND "expected_records" = "record_count")
      OR (("status" IN ('STAGED', 'REJECTED')) AND "published_at" IS NULL)
    )
);

CREATE TABLE "loyalty_persons" (
    "id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "external_key" TEXT NOT NULL,
    "manual_display_name" TEXT,
    "manual_city" TEXT,
    "manual_attributes" JSONB,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "loyalty_persons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "loyalty_organizations" (
    "id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "external_key" TEXT NOT NULL,
    "manual_display_name" TEXT,
    "manual_city" TEXT,
    "manual_attributes" JSONB,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "loyalty_organizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "loyalty_source_records" (
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "source_row_number" INTEGER,
    "entity_type" "LoyaltyEntityType" NOT NULL,
    "person_id" TEXT,
    "organization_id" TEXT,
    "display_name" TEXT NOT NULL,
    "city" TEXT,
    "tax_id" TEXT,
    "source_system" "LoyaltyExternalSystem" NOT NULL DEFAULT 'ANNA_FILE',
    "source_external_id" TEXT,
    "row_fingerprint" TEXT NOT NULL,
    "attributes" JSONB,
    "source_archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_source_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_source_records_owner_check" CHECK (
      ("entity_type" = 'BROKER' AND "person_id" IS NOT NULL AND "organization_id" IS NULL)
      OR ("entity_type" = 'AGENCY' AND "organization_id" IS NOT NULL AND "person_id" IS NULL)
    )
);

CREATE TABLE "loyalty_person_organization_roles" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "source_system" "LoyaltyExternalSystem" NOT NULL DEFAULT 'ANNA_FILE',
    "evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_person_organization_roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_person_org_role_validity_check" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);

CREATE TABLE "loyalty_source_field_values" (
    "id" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "raw_value" JSONB NOT NULL,
    "normalized_value" TEXT,
    "value_hash" TEXT NOT NULL,
    "source_system" "LoyaltyExternalSystem" NOT NULL,
    "source_external_id" TEXT,
    "locked_by_user" BOOLEAN NOT NULL DEFAULT false,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_source_field_values_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "loyalty_contact_points" (
    "id" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "type" "LoyaltyContactPointType" NOT NULL,
    "value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "label" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_contact_points_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "loyalty_external_identities" (
    "id" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "system" "LoyaltyExternalSystem" NOT NULL,
    "entity_type" "LoyaltyExternalEntityType" NOT NULL,
    "external_id" TEXT NOT NULL,
    "url" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_external_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "loyalty_activities" (
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "external_identity_id" TEXT,
    "source_system" "LoyaltyExternalSystem" NOT NULL,
    "source_external_id" TEXT NOT NULL,
    "type" "LoyaltyActivityType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "contract_type" TEXT,
    "verdict" "LoyaltyActivityVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "reason_code" TEXT,
    "rule_version" TEXT NOT NULL,
    "source_payload_hash" TEXT,
    "metadata" JSONB,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_activities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_activities_amount_check" CHECK ("amount" IS NULL OR "amount" >= 0),
    CONSTRAINT "loyalty_activities_currency_check" CHECK ("currency" = 'RUB'),
    CONSTRAINT "loyalty_activities_included_deal_check" CHECK (
      "verdict" <> 'INCLUDED' OR "type" <> 'DEAL'
      OR ("amount" > 0 AND "currency" = 'RUB' AND "contract_type" = 'DDU')
    )
);

CREATE TABLE "loyalty_metric_snapshots" (
    "id" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "rule_version" TEXT NOT NULL,
    "fixation_count" INTEGER NOT NULL DEFAULT 0,
    "meeting_count" INTEGER NOT NULL DEFAULT 0,
    "deal_count" INTEGER NOT NULL DEFAULT 0,
    "broker_tour_count" INTEGER NOT NULL DEFAULT 0,
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "deal_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_metric_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_metric_snapshots_values_check" CHECK (
      "fixation_count" >= 0 AND "meeting_count" >= 0 AND "deal_count" >= 0
      AND "broker_tour_count" >= 0 AND "call_count" >= 0 AND "deal_amount" >= 0
    )
);

CREATE TABLE "loyalty_publication_events" (
    "id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "previous_snapshot_id" TEXT,
    "content_hash" TEXT NOT NULL,
    "rule_version" TEXT NOT NULL,
    "is_rollback" BOOLEAN NOT NULL DEFAULT false,
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_publication_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_publication_events_transition_check" CHECK ("snapshot_id" <> "previous_snapshot_id")
);

CREATE TABLE "loyalty_reconciliation_cases" (
    "id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "person_id" TEXT,
    "organization_id" TEXT,
    "target_type" "LoyaltyEntityType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "match_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "evidence" JSONB,
    "score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "rule_version" TEXT NOT NULL,
    "status" "LoyaltyReconciliationStatus" NOT NULL DEFAULT 'OPEN',
    "decision" "LoyaltyReconciliationDecision",
    "version" INTEGER NOT NULL DEFAULT 1,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "loyalty_reconciliation_cases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_reconciliation_cases_owner_check" CHECK (
      ("person_id" IS NOT NULL AND "organization_id" IS NULL AND "target_type" = 'BROKER')
      OR ("organization_id" IS NOT NULL AND "person_id" IS NULL AND "target_type" = 'AGENCY')
    ),
    CONSTRAINT "loyalty_reconciliation_cases_score_check" CHECK ("score" >= 0 AND "score" <= 1),
    CONSTRAINT "loyalty_reconciliation_cases_version_check" CHECK ("version" > 0),
    CONSTRAINT "loyalty_reconciliation_cases_state_check" CHECK (
      ("status" = 'OPEN' AND "decision" IS NULL AND "resolved_at" IS NULL)
      OR ("status" IN ('RESOLVED', 'DISMISSED') AND "decision" IS NOT NULL AND "resolved_at" IS NOT NULL)
    )
);

CREATE TABLE "loyalty_entity_links" (
    "id" TEXT NOT NULL,
    "person_id" TEXT,
    "organization_id" TEXT,
    "target_type" "LoyaltyEntityType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "status" "LoyaltyLinkStatus" NOT NULL DEFAULT 'PROPOSED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reconciliation_case_id" TEXT,
    "evidence" JSONB,
    "rule_version" TEXT NOT NULL,
    "created_by_id" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_entity_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_entity_links_version_check" CHECK ("version" > 0),
    CONSTRAINT "loyalty_entity_links_owner_check" CHECK (
      ("person_id" IS NOT NULL AND "organization_id" IS NULL AND "target_type" = 'BROKER')
      OR ("organization_id" IS NOT NULL AND "person_id" IS NULL AND "target_type" = 'AGENCY')
    ),
    CONSTRAINT "loyalty_entity_links_status_check" CHECK (
      ("status" = 'PROPOSED' AND "decided_at" IS NULL AND "revoked_at" IS NULL)
      OR ("status" IN ('CONFIRMED', 'REJECTED') AND "decided_at" IS NOT NULL AND "revoked_at" IS NULL)
      OR ("status" = 'REVOKED' AND "decided_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
    )
);

CREATE TABLE "loyalty_entity_changes" (
    "id" TEXT NOT NULL,
    "person_id" TEXT,
    "organization_id" TEXT,
    "action" "LoyaltyChangeAction" NOT NULL,
    "changed_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "before_values" JSONB,
    "after_values" JSONB,
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_entity_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_entity_changes_owner_check" CHECK (num_nonnulls("person_id", "organization_id") = 1)
);

CREATE UNIQUE INDEX "loyalty_datasets_code_key" ON "loyalty_datasets"("code");
CREATE UNIQUE INDEX "loyalty_datasets_active_snapshot_id_key" ON "loyalty_datasets"("active_snapshot_id");
CREATE INDEX "loyalty_datasets_base_archived_at_idx" ON "loyalty_datasets"("base", "archived_at");

CREATE UNIQUE INDEX "loyalty_snapshots_dataset_id_content_hash_key" ON "loyalty_snapshots"("dataset_id", "content_hash");
CREATE UNIQUE INDEX "loyalty_snapshots_dataset_id_id_key" ON "loyalty_snapshots"("dataset_id", "id");
CREATE INDEX "loyalty_snapshots_dataset_id_status_created_at_idx" ON "loyalty_snapshots"("dataset_id", "status", "created_at");
CREATE UNIQUE INDEX "loyalty_snapshots_one_published_per_dataset" ON "loyalty_snapshots"("dataset_id") WHERE "status" = 'PUBLISHED';

CREATE UNIQUE INDEX "loyalty_persons_dataset_id_external_key_key" ON "loyalty_persons"("dataset_id", "external_key");
CREATE UNIQUE INDEX "loyalty_persons_dataset_id_id_key" ON "loyalty_persons"("dataset_id", "id");
CREATE INDEX "loyalty_persons_dataset_id_archived_at_idx" ON "loyalty_persons"("dataset_id", "archived_at");
CREATE UNIQUE INDEX "loyalty_organizations_dataset_id_external_key_key" ON "loyalty_organizations"("dataset_id", "external_key");
CREATE UNIQUE INDEX "loyalty_organizations_dataset_id_id_key" ON "loyalty_organizations"("dataset_id", "id");
CREATE INDEX "loyalty_organizations_dataset_id_archived_at_idx" ON "loyalty_organizations"("dataset_id", "archived_at");

CREATE UNIQUE INDEX "loyalty_source_records_snapshot_id_source_key_key" ON "loyalty_source_records"("snapshot_id", "source_key");
CREATE UNIQUE INDEX "loyalty_source_records_snapshot_id_id_key" ON "loyalty_source_records"("snapshot_id", "id");
CREATE INDEX "loyalty_source_records_snapshot_id_entity_type_source_archi_idx" ON "loyalty_source_records"("snapshot_id", "entity_type", "source_archived_at");
CREATE INDEX "loyalty_source_records_person_id_idx" ON "loyalty_source_records"("person_id");
CREATE INDEX "loyalty_source_records_organization_id_idx" ON "loyalty_source_records"("organization_id");
CREATE INDEX "loyalty_source_records_tax_id_idx" ON "loyalty_source_records"("tax_id");

CREATE UNIQUE INDEX "loyalty_person_organization_roles_source_record_id_organiza_key" ON "loyalty_person_organization_roles"("source_record_id", "organization_id", "role");
CREATE INDEX "loyalty_person_organization_roles_person_id_is_primary_vali_idx" ON "loyalty_person_organization_roles"("person_id", "is_primary", "valid_to");
CREATE INDEX "loyalty_person_organization_roles_organization_id_valid_to_idx" ON "loyalty_person_organization_roles"("organization_id", "valid_to");
CREATE UNIQUE INDEX "loyalty_person_org_roles_one_current_primary" ON "loyalty_person_organization_roles"("source_record_id") WHERE "is_primary" = true AND "valid_to" IS NULL;

CREATE UNIQUE INDEX "loyalty_source_field_values_source_record_id_field_name_val_key" ON "loyalty_source_field_values"("source_record_id", "field_name", "value_hash", "source_system");
CREATE INDEX "loyalty_source_field_values_source_record_id_field_name_obs_idx" ON "loyalty_source_field_values"("source_record_id", "field_name", "observed_at");
CREATE INDEX "loyalty_source_field_values_field_name_normalized_value_idx" ON "loyalty_source_field_values"("field_name", "normalized_value");

CREATE UNIQUE INDEX "loyalty_contact_points_source_record_id_type_normalized_val_key" ON "loyalty_contact_points"("source_record_id", "type", "normalized_value");
CREATE INDEX "loyalty_contact_points_type_normalized_value_idx" ON "loyalty_contact_points"("type", "normalized_value");
CREATE UNIQUE INDEX "loyalty_external_identities_source_record_id_system_entity__key" ON "loyalty_external_identities"("source_record_id", "system", "entity_type", "external_id");
CREATE INDEX "loyalty_external_identities_system_entity_type_external_id_idx" ON "loyalty_external_identities"("system", "entity_type", "external_id");

CREATE UNIQUE INDEX "loyalty_activities_snapshot_id_source_system_type_source_ex_key" ON "loyalty_activities"("snapshot_id", "source_system", "type", "source_external_id", "rule_version");
CREATE INDEX "loyalty_activities_source_record_id_type_occurred_at_idx" ON "loyalty_activities"("source_record_id", "type", "occurred_at");
CREATE INDEX "loyalty_activities_source_system_source_external_id_idx" ON "loyalty_activities"("source_system", "source_external_id");
CREATE UNIQUE INDEX "loyalty_metric_snapshots_source_record_id_rule_version_key" ON "loyalty_metric_snapshots"("source_record_id", "rule_version");
CREATE INDEX "loyalty_metric_snapshots_rule_version_calculated_at_idx" ON "loyalty_metric_snapshots"("rule_version", "calculated_at");
CREATE INDEX "loyalty_publication_events_dataset_id_created_at_idx" ON "loyalty_publication_events"("dataset_id", "created_at");
CREATE INDEX "loyalty_publication_events_snapshot_id_created_at_idx" ON "loyalty_publication_events"("snapshot_id", "created_at");

CREATE INDEX "loyalty_reconciliation_cases_snapshot_id_status_target_type_idx" ON "loyalty_reconciliation_cases"("snapshot_id", "status", "target_type");
CREATE INDEX "loyalty_reconciliation_cases_person_id_status_idx" ON "loyalty_reconciliation_cases"("person_id", "status");
CREATE INDEX "loyalty_reconciliation_cases_organization_id_status_idx" ON "loyalty_reconciliation_cases"("organization_id", "status");
CREATE INDEX "loyalty_reconciliation_cases_target_type_target_id_idx" ON "loyalty_reconciliation_cases"("target_type", "target_id");
CREATE UNIQUE INDEX "loyalty_reconciliation_person_candidate_key" ON "loyalty_reconciliation_cases"("snapshot_id", "person_id", "target_type", "target_id") WHERE "person_id" IS NOT NULL;
CREATE UNIQUE INDEX "loyalty_reconciliation_org_candidate_key" ON "loyalty_reconciliation_cases"("snapshot_id", "organization_id", "target_type", "target_id") WHERE "organization_id" IS NOT NULL;

CREATE INDEX "loyalty_entity_links_person_id_status_idx" ON "loyalty_entity_links"("person_id", "status");
CREATE INDEX "loyalty_entity_links_organization_id_status_idx" ON "loyalty_entity_links"("organization_id", "status");
CREATE INDEX "loyalty_entity_links_target_type_target_id_status_idx" ON "loyalty_entity_links"("target_type", "target_id", "status");
CREATE UNIQUE INDEX "loyalty_entity_links_one_active_person" ON "loyalty_entity_links"("person_id") WHERE "person_id" IS NOT NULL AND "status" = 'CONFIRMED' AND "revoked_at" IS NULL;
CREATE UNIQUE INDEX "loyalty_entity_links_one_active_org" ON "loyalty_entity_links"("organization_id") WHERE "organization_id" IS NOT NULL AND "status" = 'CONFIRMED' AND "revoked_at" IS NULL;
CREATE INDEX "loyalty_entity_changes_person_id_created_at_idx" ON "loyalty_entity_changes"("person_id", "created_at");
CREATE INDEX "loyalty_entity_changes_organization_id_created_at_idx" ON "loyalty_entity_changes"("organization_id", "created_at");

ALTER TABLE "loyalty_snapshots" ADD CONSTRAINT "loyalty_snapshots_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "loyalty_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_datasets" ADD CONSTRAINT "loyalty_datasets_active_snapshot_id_fkey" FOREIGN KEY ("active_snapshot_id") REFERENCES "loyalty_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loyalty_datasets" ADD CONSTRAINT "loyalty_datasets_active_snapshot_owner_fkey" FOREIGN KEY ("id", "active_snapshot_id") REFERENCES "loyalty_snapshots"("dataset_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_persons" ADD CONSTRAINT "loyalty_persons_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "loyalty_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_organizations" ADD CONSTRAINT "loyalty_organizations_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "loyalty_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_source_records" ADD CONSTRAINT "loyalty_source_records_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "loyalty_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_source_records" ADD CONSTRAINT "loyalty_source_records_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_source_records" ADD CONSTRAINT "loyalty_source_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_person_organization_roles" ADD CONSTRAINT "loyalty_person_organization_roles_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_person_organization_roles" ADD CONSTRAINT "loyalty_person_organization_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_person_organization_roles" ADD CONSTRAINT "loyalty_person_organization_roles_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "loyalty_source_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_source_field_values" ADD CONSTRAINT "loyalty_source_field_values_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "loyalty_source_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_contact_points" ADD CONSTRAINT "loyalty_contact_points_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "loyalty_source_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_external_identities" ADD CONSTRAINT "loyalty_external_identities_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "loyalty_source_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_activities" ADD CONSTRAINT "loyalty_activities_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "loyalty_source_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_activities" ADD CONSTRAINT "loyalty_activities_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "loyalty_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_activities" ADD CONSTRAINT "loyalty_activities_snapshot_record_owner_fkey" FOREIGN KEY ("snapshot_id", "source_record_id") REFERENCES "loyalty_source_records"("snapshot_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_activities" ADD CONSTRAINT "loyalty_activities_external_identity_id_fkey" FOREIGN KEY ("external_identity_id") REFERENCES "loyalty_external_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loyalty_metric_snapshots" ADD CONSTRAINT "loyalty_metric_snapshots_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "loyalty_source_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_publication_events" ADD CONSTRAINT "loyalty_publication_events_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "loyalty_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_publication_events" ADD CONSTRAINT "loyalty_publication_events_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "loyalty_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_publication_events" ADD CONSTRAINT "loyalty_publication_events_previous_snapshot_id_fkey" FOREIGN KEY ("previous_snapshot_id") REFERENCES "loyalty_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_publication_events" ADD CONSTRAINT "loyalty_publication_events_snapshot_owner_fkey" FOREIGN KEY ("dataset_id", "snapshot_id") REFERENCES "loyalty_snapshots"("dataset_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_publication_events" ADD CONSTRAINT "loyalty_publication_events_previous_owner_fkey" FOREIGN KEY ("dataset_id", "previous_snapshot_id") REFERENCES "loyalty_snapshots"("dataset_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_reconciliation_cases" ADD CONSTRAINT "loyalty_reconciliation_cases_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "loyalty_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_reconciliation_cases" ADD CONSTRAINT "loyalty_reconciliation_cases_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "loyalty_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_reconciliation_cases" ADD CONSTRAINT "loyalty_reconciliation_cases_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_reconciliation_cases" ADD CONSTRAINT "loyalty_reconciliation_cases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_reconciliation_cases" ADD CONSTRAINT "loyalty_reconciliation_cases_snapshot_owner_fkey" FOREIGN KEY ("dataset_id", "snapshot_id") REFERENCES "loyalty_snapshots"("dataset_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_reconciliation_cases" ADD CONSTRAINT "loyalty_reconciliation_cases_person_owner_fkey" FOREIGN KEY ("dataset_id", "person_id") REFERENCES "loyalty_persons"("dataset_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_reconciliation_cases" ADD CONSTRAINT "loyalty_reconciliation_cases_organization_owner_fkey" FOREIGN KEY ("dataset_id", "organization_id") REFERENCES "loyalty_organizations"("dataset_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_entity_links" ADD CONSTRAINT "loyalty_entity_links_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_entity_links" ADD CONSTRAINT "loyalty_entity_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_entity_links" ADD CONSTRAINT "loyalty_entity_links_reconciliation_case_id_fkey" FOREIGN KEY ("reconciliation_case_id") REFERENCES "loyalty_reconciliation_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loyalty_entity_changes" ADD CONSTRAINT "loyalty_entity_changes_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_entity_changes" ADD CONSTRAINT "loyalty_entity_changes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The composite FK above proves ownership. This deferred trigger additionally
-- proves the active pointer targets a PUBLISHED row after the atomic switch.
CREATE FUNCTION "loyalty_assert_active_snapshot_published"() RETURNS trigger AS $$
BEGIN
  IF NEW."active_snapshot_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "loyalty_snapshots" s
    WHERE s."id" = NEW."active_snapshot_id"
      AND s."dataset_id" = NEW."id"
      AND s."status" = 'PUBLISHED'
  ) THEN
    RAISE EXCEPTION 'active loyalty snapshot must belong to the dataset and be PUBLISHED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "loyalty_datasets_active_snapshot_published_trigger"
AFTER INSERT OR UPDATE OF "active_snapshot_id" ON "loyalty_datasets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "loyalty_assert_active_snapshot_published"();

CREATE FUNCTION "loyalty_assert_snapshot_not_active_unpublished"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "loyalty_datasets" d
    WHERE d."active_snapshot_id" = NEW."id"
      AND (d."id" <> NEW."dataset_id" OR NEW."status" <> 'PUBLISHED')
  ) THEN
    RAISE EXCEPTION 'an active loyalty snapshot must remain owned and PUBLISHED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "loyalty_snapshots_active_status_guard_trigger"
AFTER UPDATE OF "status", "dataset_id" ON "loyalty_snapshots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "loyalty_assert_snapshot_not_active_unpublished"();

-- Publication events are append-only application evidence. A database owner
-- can deliberately disable/drop this trigger during a controlled migration.
CREATE FUNCTION "loyalty_prevent_publication_event_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'loyalty publication events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "loyalty_publication_events_append_only_trigger"
BEFORE UPDATE OR DELETE ON "loyalty_publication_events"
FOR EACH ROW EXECUTE FUNCTION "loyalty_prevent_publication_event_mutation"();

COMMIT;
