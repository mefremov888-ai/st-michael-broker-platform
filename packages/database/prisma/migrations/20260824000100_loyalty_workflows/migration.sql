-- Server-side workflows for Anna loyalty CRM parity: campaigns, queues,
-- idempotent call attempts, tasks, loyalty history, grants and audited exports.
-- Additive only: existing loyalty snapshots and cabinet entities are untouched.
BEGIN;

CREATE TYPE "LoyaltyCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "LoyaltyAssignmentStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "LoyaltyCallResult" AS ENUM (
  'INFORMED', 'DO_NOT_CALL', 'NOT_INTERESTED', 'NO_ANSWER', 'SEND_INFORMATION',
  'BROKER_TOUR_BOOKED', 'BROKER_TOUR_DECLINED', 'INVALID_PHONE', 'NOT_A_BROKER',
  'COOPERATION_DECLINED', 'BROKER_TOUR_SCHEDULED', 'CALLBACK', 'AGREEMENTS_EXIST',
  'COOPERATION_AGREED'
);
CREATE TYPE "LoyaltyTaskStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');
CREATE TYPE "LoyaltyEngagementType" AS ENUM (
  'GIFT', 'AWARD', 'PRIVATE_EVENT', 'INDIVIDUAL_TERMS',
  'PERSONAL_DISCOUNT', 'PERSONAL_COMMISSION'
);
CREATE TYPE "LoyaltyPermission" AS ENUM (
  'READ_ALL', 'READ_OWN_QUEUE', 'CALL_EXECUTE', 'CALL_ASSIGN', 'ENTITY_EDIT',
  'REFERENCE_MANAGE', 'EXPORT', 'IMPORT', 'RECONCILE', 'AUDIT_READ', 'ANALYTICS_SYNC'
);
CREATE TYPE "LoyaltyExportStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'EXPIRED');
CREATE TYPE "LoyaltySyncSource" AS ENUM ('GOOGLE_SHEETS', 'AMOCRM');
CREATE TYPE "LoyaltySyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TYPE "LoyaltyReconciliationDecision" ADD VALUE IF NOT EXISTS 'SUPPLEMENT';
ALTER TYPE "LoyaltyReconciliationDecision" ADD VALUE IF NOT EXISTS 'ARCHIVE';
ALTER TABLE "loyalty_reconciliation_cases"
  ADD COLUMN "decision_reason" TEXT,
  ADD COLUMN "decision_payload" JSONB;

CREATE TABLE "loyalty_call_campaigns" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "message" TEXT NOT NULL,
  "base" "LoyaltyBaseKind" NOT NULL,
  "entity_type" "LoyaltyEntityType" NOT NULL,
  "snapshot_id" TEXT,
  "filter_snapshot" JSONB NOT NULL,
  "filter_hash" VARCHAR(64) NOT NULL,
  "expected_count" INTEGER NOT NULL,
  "status" "LoyaltyCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loyalty_call_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_call_campaigns_counts_check" CHECK ("expected_count" >= 0 AND "version" > 0),
  CONSTRAINT "loyalty_call_campaigns_hash_check" CHECK ("filter_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "loyalty_call_campaigns_message_check" CHECK (length(btrim("name")) > 0 AND length(btrim("message")) > 0),
  CONSTRAINT "loyalty_call_campaigns_state_check" CHECK (
    ("status" = 'DRAFT' AND "started_at" IS NULL AND "completed_at" IS NULL AND "archived_at" IS NULL)
    OR ("status" = 'ACTIVE' AND "started_at" IS NOT NULL AND "completed_at" IS NULL AND "archived_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "started_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "archived_at" IS NULL)
    OR ("status" = 'ARCHIVED' AND "archived_at" IS NOT NULL)
  )
);

CREATE TABLE "loyalty_call_assignments" (
  "id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "anna_person_id" TEXT,
  "anna_organization_id" TEXT,
  "our_broker_id" TEXT,
  "our_agency_id" TEXT,
  "assigned_to_id" TEXT NOT NULL,
  "assigned_by_id" TEXT NOT NULL,
  "status" "LoyaltyAssignmentStatus" NOT NULL DEFAULT 'PENDING',
  "version" INTEGER NOT NULL DEFAULT 1,
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  CONSTRAINT "loyalty_call_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_call_assignments_one_target_check" CHECK (
    num_nonnulls("anna_person_id", "anna_organization_id", "our_broker_id", "our_agency_id") = 1
  ),
  CONSTRAINT "loyalty_call_assignments_version_check" CHECK ("version" > 0),
  CONSTRAINT "loyalty_call_assignments_state_check" CHECK (
    ("status" = 'PENDING' AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'IN_PROGRESS' AND "started_at" IS NOT NULL AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "completed_at" IS NULL)
  )
);

CREATE TABLE "loyalty_call_attempts" (
  "id" TEXT NOT NULL,
  "assignment_id" TEXT NOT NULL,
  "submission_id" VARCHAR(80) NOT NULL,
  "operator_id" TEXT NOT NULL,
  "result" "LoyaltyCallResult" NOT NULL,
  "comment" TEXT,
  "next_step" TEXT,
  "next_action_at" TIMESTAMP(3),
  "source" VARCHAR(64) NOT NULL DEFAULT 'LOYALTY_CALL_QUEUE',
  "corrects_attempt_id" TEXT,
  "correction_reason" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_call_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_call_attempts_submission_id_key" UNIQUE ("submission_id"),
  CONSTRAINT "loyalty_call_attempts_correction_check" CHECK (
    ("corrects_attempt_id" IS NULL AND "correction_reason" IS NULL)
    OR ("corrects_attempt_id" IS NOT NULL AND length(btrim("correction_reason")) > 0)
  )
);

CREATE TABLE "loyalty_tasks" (
  "id" TEXT NOT NULL,
  "anna_person_id" TEXT,
  "anna_organization_id" TEXT,
  "our_broker_id" TEXT,
  "our_agency_id" TEXT,
  "assignment_id" TEXT,
  "call_attempt_id" TEXT,
  "title" VARCHAR(240) NOT NULL,
  "description" TEXT,
  "status" "LoyaltyTaskStatus" NOT NULL DEFAULT 'OPEN',
  "due_at" TIMESTAMP(3),
  "assigned_to_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "completed_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loyalty_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_tasks_one_target_check" CHECK (
    num_nonnulls("anna_person_id", "anna_organization_id", "our_broker_id", "our_agency_id") = 1
  ),
  CONSTRAINT "loyalty_tasks_title_check" CHECK (length(btrim("title")) > 0),
  CONSTRAINT "loyalty_tasks_version_check" CHECK ("version" > 0),
  CONSTRAINT "loyalty_tasks_state_check" CHECK (
    ("status" = 'OPEN' AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "completed_at" IS NULL)
  )
);

CREATE TABLE "loyalty_engagement_events" (
  "id" TEXT NOT NULL,
  "anna_person_id" TEXT,
  "anna_organization_id" TEXT,
  "our_broker_id" TEXT,
  "our_agency_id" TEXT,
  "type" "LoyaltyEngagementType" NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "comment" TEXT,
  "amount" DECIMAL(18,2),
  "value" VARCHAR(500),
  "valid_until" TIMESTAMP(3),
  "attachment_url" VARCHAR(1000),
  "basis_url" VARCHAR(1000),
  "created_by_id" TEXT NOT NULL,
  "corrects_event_id" TEXT,
  "correction_reason" TEXT,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_engagement_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_engagement_events_one_target_check" CHECK (
    num_nonnulls("anna_person_id", "anna_organization_id", "our_broker_id", "our_agency_id") = 1
  ),
  CONSTRAINT "loyalty_engagement_events_amount_check" CHECK ("amount" IS NULL OR "amount" >= 0),
  CONSTRAINT "loyalty_engagement_events_validity_check" CHECK ("valid_until" IS NULL OR "valid_until" >= "occurred_at"),
  CONSTRAINT "loyalty_engagement_events_correction_check" CHECK (
    ("corrects_event_id" IS NULL AND "correction_reason" IS NULL)
    OR ("corrects_event_id" IS NOT NULL AND length(btrim("correction_reason")) > 0)
  ),
  CONSTRAINT "loyalty_engagement_events_urls_check" CHECK (
    ("attachment_url" IS NULL OR "attachment_url" ~ '^https://')
    AND ("basis_url" IS NULL OR "basis_url" ~ '^https://')
  )
);

CREATE TABLE "loyalty_saved_views" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "base" "LoyaltyBaseKind" NOT NULL,
  "entity_type" "LoyaltyEntityType" NOT NULL,
  "filters" JSONB NOT NULL,
  "filter_hash" VARCHAR(64) NOT NULL,
  "is_shared" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loyalty_saved_views_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_saved_views_owner_id_name_base_entity_type_key" UNIQUE ("owner_id", "name", "base", "entity_type"),
  CONSTRAINT "loyalty_saved_views_hash_check" CHECK ("filter_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "loyalty_workflow_audits" (
  "id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "action" VARCHAR(100) NOT NULL,
  "entity_type" VARCHAR(100) NOT NULL,
  "entity_id" VARCHAR(100) NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_workflow_audits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "loyalty_user_grants" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "permission" "LoyaltyPermission" NOT NULL,
  "granted_by_id" TEXT NOT NULL,
  "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "loyalty_user_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "loyalty_export_jobs" (
  "id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "base" "LoyaltyBaseKind" NOT NULL,
  "entity_type" "LoyaltyEntityType" NOT NULL,
  "filter_hash" VARCHAR(64) NOT NULL,
  "filter" JSONB NOT NULL,
  "status" "LoyaltyExportStatus" NOT NULL DEFAULT 'PENDING',
  "row_count" INTEGER,
  "storage_key" VARCHAR(500),
  "failure_code" VARCHAR(100),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "loyalty_export_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_export_jobs_hash_check" CHECK ("filter_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "loyalty_export_jobs_row_count_check" CHECK ("row_count" IS NULL OR "row_count" >= 0)
);

CREATE TABLE "loyalty_sync_runs" (
  "id" TEXT NOT NULL,
  "source" "LoyaltySyncSource" NOT NULL,
  "status" "LoyaltySyncStatus" NOT NULL DEFAULT 'RUNNING',
  "rule_version" VARCHAR(100) NOT NULL,
  "source_ref_hash" VARCHAR(64),
  "content_hash" VARCHAR(64),
  "counts" JSONB,
  "error_code" VARCHAR(100),
  "requested_by_id" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "loyalty_sync_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_sync_runs_source_ref_hash_check" CHECK ("source_ref_hash" IS NULL OR "source_ref_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "loyalty_sync_runs_content_hash_check" CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "loyalty_sync_runs_state_check" CHECK (
    ("status" = 'RUNNING' AND "completed_at" IS NULL AND "error_code" IS NULL)
    OR ("status" = 'SUCCEEDED' AND "completed_at" IS NOT NULL AND "error_code" IS NULL AND "content_hash" IS NOT NULL AND "counts" IS NOT NULL)
    OR ("status" = 'FAILED' AND "completed_at" IS NOT NULL AND "error_code" IS NOT NULL)
  )
);

CREATE TABLE "loyalty_manual_entities" (
  "id" TEXT NOT NULL,
  "dataset_id" TEXT NOT NULL,
  "entity_type" "LoyaltyEntityType" NOT NULL,
  "person_id" TEXT,
  "organization_id" TEXT,
  "display_name" VARCHAR(300) NOT NULL,
  "city" VARCHAR(200),
  "phone_normalized" VARCHAR(32),
  "email_normalized" VARCHAR(254),
  "contact_points" JSONB NOT NULL,
  "attributes" JSONB,
  "created_by_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loyalty_manual_entities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_manual_entities_person_id_key" UNIQUE ("person_id"),
  CONSTRAINT "loyalty_manual_entities_organization_id_key" UNIQUE ("organization_id"),
  CONSTRAINT "loyalty_manual_entities_dataset_id_phone_normalized_key" UNIQUE ("dataset_id", "phone_normalized"),
  CONSTRAINT "loyalty_manual_entities_dataset_id_email_normalized_key" UNIQUE ("dataset_id", "email_normalized"),
  CONSTRAINT "loyalty_manual_entities_one_target_check" CHECK (
    num_nonnulls("person_id", "organization_id") = 1
    AND (("entity_type" = 'BROKER' AND "person_id" IS NOT NULL)
      OR ("entity_type" = 'AGENCY' AND "organization_id" IS NOT NULL))
  ),
  CONSTRAINT "loyalty_manual_entities_name_check" CHECK (length(btrim("display_name")) > 0),
  CONSTRAINT "loyalty_manual_entities_version_check" CHECK ("version" > 0),
  CONSTRAINT "loyalty_manual_entities_contact_points_check" CHECK (jsonb_typeof("contact_points") = 'array')
);

CREATE TABLE "loyalty_contact_overrides" (
  "id" TEXT NOT NULL,
  "dataset_id" TEXT NOT NULL,
  "entity_type" "LoyaltyEntityType" NOT NULL,
  "person_id" TEXT,
  "organization_id" TEXT,
  "type" "LoyaltyContactPointType" NOT NULL,
  "value" TEXT NOT NULL,
  "normalized_value" TEXT NOT NULL,
  "label" VARCHAR(160),
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "created_by_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loyalty_contact_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_contact_overrides_one_target_check" CHECK (
    num_nonnulls("person_id", "organization_id") = 1
    AND (("entity_type" = 'BROKER' AND "person_id" IS NOT NULL)
      OR ("entity_type" = 'AGENCY' AND "organization_id" IS NOT NULL))
  ),
  CONSTRAINT "loyalty_contact_overrides_value_check" CHECK (
    length(btrim("value")) > 0 AND length(btrim("normalized_value")) > 0
  ),
  CONSTRAINT "loyalty_contact_overrides_version_check" CHECK ("version" > 0)
);

CREATE TABLE "loyalty_agency_contact_people" (
  "id" TEXT NOT NULL,
  "dataset_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "display_name" VARCHAR(300) NOT NULL,
  "role" VARCHAR(160),
  "actuality_status" VARCHAR(24) NOT NULL DEFAULT 'CURRENT',
  "contact_points" JSONB NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loyalty_agency_contact_people_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_agency_contact_people_name_check" CHECK (length(btrim("display_name")) > 0),
  CONSTRAINT "loyalty_agency_contact_people_actuality_check" CHECK ("actuality_status" IN ('CURRENT', 'FORMER', 'UNKNOWN')),
  CONSTRAINT "loyalty_agency_contact_people_contacts_check" CHECK (jsonb_typeof("contact_points") = 'array'),
  CONSTRAINT "loyalty_agency_contact_people_version_check" CHECK ("version" > 0)
);

CREATE INDEX "loyalty_call_campaigns_status_created_at_idx" ON "loyalty_call_campaigns"("status", "created_at");
CREATE INDEX "loyalty_call_campaigns_created_by_id_status_idx" ON "loyalty_call_campaigns"("created_by_id", "status");
CREATE INDEX "loyalty_call_campaigns_snapshot_id_idx" ON "loyalty_call_campaigns"("snapshot_id");
CREATE INDEX "loyalty_call_assignments_campaign_id_status_idx" ON "loyalty_call_assignments"("campaign_id", "status");
CREATE INDEX "loyalty_call_assignments_assigned_to_id_status_assigned_at_idx" ON "loyalty_call_assignments"("assigned_to_id", "status", "assigned_at");
CREATE INDEX "loyalty_call_assignments_anna_person_id_idx" ON "loyalty_call_assignments"("anna_person_id");
CREATE INDEX "loyalty_call_assignments_anna_organization_id_idx" ON "loyalty_call_assignments"("anna_organization_id");
CREATE INDEX "loyalty_call_assignments_our_broker_id_idx" ON "loyalty_call_assignments"("our_broker_id");
CREATE INDEX "loyalty_call_assignments_our_agency_id_idx" ON "loyalty_call_assignments"("our_agency_id");
CREATE UNIQUE INDEX "loyalty_call_assignments_campaign_anna_person_key" ON "loyalty_call_assignments"("campaign_id", "anna_person_id") WHERE "anna_person_id" IS NOT NULL;
CREATE UNIQUE INDEX "loyalty_call_assignments_campaign_anna_org_key" ON "loyalty_call_assignments"("campaign_id", "anna_organization_id") WHERE "anna_organization_id" IS NOT NULL;
CREATE UNIQUE INDEX "loyalty_call_assignments_campaign_our_broker_key" ON "loyalty_call_assignments"("campaign_id", "our_broker_id") WHERE "our_broker_id" IS NOT NULL;
CREATE UNIQUE INDEX "loyalty_call_assignments_campaign_our_agency_key" ON "loyalty_call_assignments"("campaign_id", "our_agency_id") WHERE "our_agency_id" IS NOT NULL;
CREATE INDEX "loyalty_call_attempts_assignment_id_occurred_at_idx" ON "loyalty_call_attempts"("assignment_id", "occurred_at");
CREATE INDEX "loyalty_call_attempts_operator_id_occurred_at_idx" ON "loyalty_call_attempts"("operator_id", "occurred_at");
CREATE INDEX "loyalty_call_attempts_corrects_attempt_id_idx" ON "loyalty_call_attempts"("corrects_attempt_id");
CREATE INDEX "loyalty_tasks_assigned_to_id_status_due_at_idx" ON "loyalty_tasks"("assigned_to_id", "status", "due_at");
CREATE INDEX "loyalty_tasks_anna_person_id_status_idx" ON "loyalty_tasks"("anna_person_id", "status");
CREATE INDEX "loyalty_tasks_anna_organization_id_status_idx" ON "loyalty_tasks"("anna_organization_id", "status");
CREATE INDEX "loyalty_tasks_our_broker_id_status_idx" ON "loyalty_tasks"("our_broker_id", "status");
CREATE INDEX "loyalty_tasks_our_agency_id_status_idx" ON "loyalty_tasks"("our_agency_id", "status");
CREATE INDEX "loyalty_tasks_assignment_id_idx" ON "loyalty_tasks"("assignment_id");
CREATE INDEX "loyalty_tasks_call_attempt_id_idx" ON "loyalty_tasks"("call_attempt_id");
CREATE INDEX "loyalty_engagement_events_anna_person_id_occurred_at_idx" ON "loyalty_engagement_events"("anna_person_id", "occurred_at");
CREATE INDEX "loyalty_engagement_events_anna_organization_id_occurred_at_idx" ON "loyalty_engagement_events"("anna_organization_id", "occurred_at");
CREATE INDEX "loyalty_engagement_events_our_broker_id_occurred_at_idx" ON "loyalty_engagement_events"("our_broker_id", "occurred_at");
CREATE INDEX "loyalty_engagement_events_our_agency_id_occurred_at_idx" ON "loyalty_engagement_events"("our_agency_id", "occurred_at");
CREATE INDEX "loyalty_engagement_events_type_occurred_at_idx" ON "loyalty_engagement_events"("type", "occurred_at");
CREATE INDEX "loyalty_engagement_events_corrects_event_id_idx" ON "loyalty_engagement_events"("corrects_event_id");
CREATE INDEX "loyalty_saved_views_base_entity_type_is_shared_idx" ON "loyalty_saved_views"("base", "entity_type", "is_shared");
CREATE INDEX "loyalty_workflow_audits_entity_type_entity_id_created_at_idx" ON "loyalty_workflow_audits"("entity_type", "entity_id", "created_at");
CREATE INDEX "loyalty_workflow_audits_actor_id_created_at_idx" ON "loyalty_workflow_audits"("actor_id", "created_at");
CREATE INDEX "loyalty_user_grants_user_id_permission_revoked_at_idx" ON "loyalty_user_grants"("user_id", "permission", "revoked_at");
CREATE UNIQUE INDEX "loyalty_user_grants_active_key" ON "loyalty_user_grants"("user_id", "permission") WHERE "revoked_at" IS NULL;
CREATE INDEX "loyalty_user_grants_granted_by_id_granted_at_idx" ON "loyalty_user_grants"("granted_by_id", "granted_at");
CREATE INDEX "loyalty_export_jobs_created_by_id_created_at_idx" ON "loyalty_export_jobs"("created_by_id", "created_at");
CREATE INDEX "loyalty_export_jobs_status_expires_at_idx" ON "loyalty_export_jobs"("status", "expires_at");
CREATE INDEX "loyalty_sync_runs_source_started_at_idx" ON "loyalty_sync_runs"("source", "started_at");
CREATE INDEX "loyalty_sync_runs_status_started_at_idx" ON "loyalty_sync_runs"("status", "started_at");
CREATE INDEX "loyalty_sync_runs_requested_by_id_started_at_idx" ON "loyalty_sync_runs"("requested_by_id", "started_at");
CREATE UNIQUE INDEX "loyalty_sync_runs_one_active_source_key" ON "loyalty_sync_runs"("source") WHERE "status" = 'RUNNING';
CREATE INDEX "loyalty_manual_entities_dataset_id_entity_type_archived_at_idx" ON "loyalty_manual_entities"("dataset_id", "entity_type", "archived_at");
CREATE INDEX "loyalty_manual_entities_created_by_id_created_at_idx" ON "loyalty_manual_entities"("created_by_id", "created_at");
CREATE INDEX "loyalty_contact_overrides_dataset_id_entity_type_archived_at_idx" ON "loyalty_contact_overrides"("dataset_id", "entity_type", "archived_at");
CREATE INDEX "loyalty_contact_overrides_person_id_archived_at_idx" ON "loyalty_contact_overrides"("person_id", "archived_at");
CREATE INDEX "loyalty_contact_overrides_organization_id_archived_at_idx" ON "loyalty_contact_overrides"("organization_id", "archived_at");
CREATE INDEX "loyalty_contact_overrides_type_normalized_value_archived_at_idx" ON "loyalty_contact_overrides"("type", "normalized_value", "archived_at");
CREATE INDEX "loyalty_contact_overrides_created_by_id_created_at_idx" ON "loyalty_contact_overrides"("created_by_id", "created_at");
CREATE UNIQUE INDEX "loyalty_contact_overrides_active_value_key" ON "loyalty_contact_overrides"("dataset_id", "type", "normalized_value") WHERE "archived_at" IS NULL;
CREATE INDEX "loyalty_agency_contact_people_dataset_org_archived_idx" ON "loyalty_agency_contact_people"("dataset_id", "organization_id", "archived_at");
CREATE INDEX "loyalty_agency_contact_people_created_by_created_at_idx" ON "loyalty_agency_contact_people"("created_by_id", "created_at");

ALTER TABLE "loyalty_call_campaigns" ADD CONSTRAINT "loyalty_call_campaigns_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "loyalty_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_campaigns" ADD CONSTRAINT "loyalty_call_campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_assignments" ADD CONSTRAINT "loyalty_call_assignments_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "loyalty_call_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_assignments" ADD CONSTRAINT "loyalty_call_assignments_anna_person_id_fkey" FOREIGN KEY ("anna_person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_assignments" ADD CONSTRAINT "loyalty_call_assignments_anna_organization_id_fkey" FOREIGN KEY ("anna_organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_assignments" ADD CONSTRAINT "loyalty_call_assignments_our_broker_id_fkey" FOREIGN KEY ("our_broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_assignments" ADD CONSTRAINT "loyalty_call_assignments_our_agency_id_fkey" FOREIGN KEY ("our_agency_id") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_assignments" ADD CONSTRAINT "loyalty_call_assignments_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_assignments" ADD CONSTRAINT "loyalty_call_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_attempts" ADD CONSTRAINT "loyalty_call_attempts_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "loyalty_call_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_attempts" ADD CONSTRAINT "loyalty_call_attempts_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_call_attempts" ADD CONSTRAINT "loyalty_call_attempts_corrects_attempt_id_fkey" FOREIGN KEY ("corrects_attempt_id") REFERENCES "loyalty_call_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_tasks" ADD CONSTRAINT "loyalty_tasks_anna_person_id_fkey" FOREIGN KEY ("anna_person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_tasks" ADD CONSTRAINT "loyalty_tasks_anna_organization_id_fkey" FOREIGN KEY ("anna_organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_tasks" ADD CONSTRAINT "loyalty_tasks_our_broker_id_fkey" FOREIGN KEY ("our_broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_tasks" ADD CONSTRAINT "loyalty_tasks_our_agency_id_fkey" FOREIGN KEY ("our_agency_id") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_tasks" ADD CONSTRAINT "loyalty_tasks_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "loyalty_call_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_tasks" ADD CONSTRAINT "loyalty_tasks_call_attempt_id_fkey" FOREIGN KEY ("call_attempt_id") REFERENCES "loyalty_call_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_tasks" ADD CONSTRAINT "loyalty_tasks_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_tasks" ADD CONSTRAINT "loyalty_tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_engagement_events" ADD CONSTRAINT "loyalty_engagement_events_anna_person_id_fkey" FOREIGN KEY ("anna_person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_engagement_events" ADD CONSTRAINT "loyalty_engagement_events_anna_organization_id_fkey" FOREIGN KEY ("anna_organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_engagement_events" ADD CONSTRAINT "loyalty_engagement_events_our_broker_id_fkey" FOREIGN KEY ("our_broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_engagement_events" ADD CONSTRAINT "loyalty_engagement_events_our_agency_id_fkey" FOREIGN KEY ("our_agency_id") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_engagement_events" ADD CONSTRAINT "loyalty_engagement_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_engagement_events" ADD CONSTRAINT "loyalty_engagement_events_corrects_event_id_fkey" FOREIGN KEY ("corrects_event_id") REFERENCES "loyalty_engagement_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_saved_views" ADD CONSTRAINT "loyalty_saved_views_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_workflow_audits" ADD CONSTRAINT "loyalty_workflow_audits_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_user_grants" ADD CONSTRAINT "loyalty_user_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_user_grants" ADD CONSTRAINT "loyalty_user_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_export_jobs" ADD CONSTRAINT "loyalty_export_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_sync_runs" ADD CONSTRAINT "loyalty_sync_runs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_manual_entities" ADD CONSTRAINT "loyalty_manual_entities_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "loyalty_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_manual_entities" ADD CONSTRAINT "loyalty_manual_entities_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_manual_entities" ADD CONSTRAINT "loyalty_manual_entities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_manual_entities" ADD CONSTRAINT "loyalty_manual_entities_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_contact_overrides" ADD CONSTRAINT "loyalty_contact_overrides_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "loyalty_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_contact_overrides" ADD CONSTRAINT "loyalty_contact_overrides_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "loyalty_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_contact_overrides" ADD CONSTRAINT "loyalty_contact_overrides_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_contact_overrides" ADD CONSTRAINT "loyalty_contact_overrides_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_agency_contact_people" ADD CONSTRAINT "loyalty_agency_contact_people_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "loyalty_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_agency_contact_people" ADD CONSTRAINT "loyalty_agency_contact_people_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "loyalty_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_agency_contact_people" ADD CONSTRAINT "loyalty_agency_contact_people_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION loyalty_validate_manual_entity_scope() RETURNS trigger AS $$
DECLARE
  target_dataset TEXT;
  dataset_base "LoyaltyBaseKind";
BEGIN
  SELECT base INTO dataset_base FROM "loyalty_datasets" WHERE id = NEW.dataset_id;
  IF dataset_base IS DISTINCT FROM 'ANNA' THEN
    RAISE EXCEPTION 'manual loyalty entities require an ANNA dataset';
  END IF;
  IF NEW.person_id IS NOT NULL THEN
    SELECT dataset_id INTO target_dataset FROM "loyalty_persons" WHERE id = NEW.person_id;
  ELSE
    SELECT dataset_id INTO target_dataset FROM "loyalty_organizations" WHERE id = NEW.organization_id;
  END IF;
  IF target_dataset IS DISTINCT FROM NEW.dataset_id THEN
    RAISE EXCEPTION 'manual loyalty entity target must belong to the same dataset';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_manual_entities_scope_guard
BEFORE INSERT OR UPDATE ON "loyalty_manual_entities"
FOR EACH ROW EXECUTE FUNCTION loyalty_validate_manual_entity_scope();

CREATE FUNCTION loyalty_validate_contact_override_scope() RETURNS trigger AS $$
DECLARE
  target_dataset TEXT;
  dataset_base "LoyaltyBaseKind";
BEGIN
  SELECT base INTO dataset_base FROM "loyalty_datasets" WHERE id = NEW.dataset_id;
  IF dataset_base IS DISTINCT FROM 'ANNA' THEN
    RAISE EXCEPTION 'loyalty contact overrides require an ANNA dataset';
  END IF;
  IF NEW.person_id IS NOT NULL THEN
    SELECT dataset_id INTO target_dataset FROM "loyalty_persons" WHERE id = NEW.person_id;
  ELSE
    SELECT dataset_id INTO target_dataset FROM "loyalty_organizations" WHERE id = NEW.organization_id;
  END IF;
  IF target_dataset IS DISTINCT FROM NEW.dataset_id THEN
    RAISE EXCEPTION 'loyalty contact override target must belong to the same dataset';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_contact_overrides_scope_guard
BEFORE INSERT OR UPDATE ON "loyalty_contact_overrides"
FOR EACH ROW EXECUTE FUNCTION loyalty_validate_contact_override_scope();

CREATE FUNCTION loyalty_validate_agency_contact_person_scope() RETURNS trigger AS $$
DECLARE
  target_dataset TEXT;
  dataset_base "LoyaltyBaseKind";
BEGIN
  SELECT base INTO dataset_base FROM "loyalty_datasets" WHERE id = NEW.dataset_id;
  SELECT dataset_id INTO target_dataset FROM "loyalty_organizations" WHERE id = NEW.organization_id;
  IF dataset_base IS DISTINCT FROM 'ANNA' THEN
    RAISE EXCEPTION 'agency contact people require an ANNA dataset';
  END IF;
  IF target_dataset IS DISTINCT FROM NEW.dataset_id THEN
    RAISE EXCEPTION 'agency contact person target must belong to the same dataset';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_agency_contact_people_scope_guard
BEFORE INSERT OR UPDATE ON "loyalty_agency_contact_people"
FOR EACH ROW EXECUTE FUNCTION loyalty_validate_agency_contact_person_scope();

CREATE FUNCTION loyalty_reject_call_attempt_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'loyalty call attempts are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_call_attempts_append_only
BEFORE UPDATE OR DELETE ON "loyalty_call_attempts"
FOR EACH ROW EXECUTE FUNCTION loyalty_reject_call_attempt_mutation();

CREATE FUNCTION loyalty_protect_engagement_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'loyalty engagement events cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'archived_at') IS DISTINCT FROM (to_jsonb(OLD) - 'archived_at') THEN
    RAISE EXCEPTION 'loyalty engagement events are immutable except archived_at';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_engagement_events_protect
BEFORE UPDATE OR DELETE ON "loyalty_engagement_events"
FOR EACH ROW EXECUTE FUNCTION loyalty_protect_engagement_event();

COMMIT;
