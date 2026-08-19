-- Generated from git HEAD's pre-loyalty Prisma schema.
-- Fresh databases apply this atomically before 20260818000100_loyalty_base.
BEGIN;

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('BROKER', 'MANAGER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'PENDING');

-- CreateEnum
CREATE TYPE "CommissionLevel" AS ENUM ('START', 'BASIC', 'STRONG', 'PREMIUM', 'ELITE', 'CHAMPION', 'LEGEND');

-- CreateEnum
CREATE TYPE "CommissionMode" AS ENUM ('PROGRESSIVE', 'FLAT');

-- CreateEnum
CREATE TYPE "Project" AS ENUM ('ZORGE9', 'SILVER_BOR');

-- CreateEnum
CREATE TYPE "UniquenessStatus" AS ENUM ('CONDITIONALLY_UNIQUE', 'REJECTED', 'UNDER_REVIEW', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BrokerFunnelStage" AS ENUM ('NEW_BROKER', 'BROKER_TOUR', 'FIXATION', 'MEETING', 'DEAL');

-- CreateEnum
CREATE TYPE "BrokerSource" AS ENUM ('CRM_MANUAL', 'BROKER_CABINET', 'PHONE_CALL', 'CLOSED_AS_BROKER', 'LANDING_BROKER_TOUR', 'LANDING_FORM');

-- CreateEnum
CREATE TYPE "FixationStatus" AS ENUM ('NOT_FIXED', 'FIXED', 'EXPIRED', 'ANNULLED');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('NEW', 'BOOKED', 'DEAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('DDU', 'DKP', 'PDKP');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('PENDING', 'SIGNED', 'PAID', 'COMMISSION_PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LotStatus" AS ENUM ('AVAILABLE', 'BOOKED', 'SOLD');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('INITIATED', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'UNAVAILABLE', 'FAILED');

-- CreateEnum
CREATE TYPE "CallResult" AS ENUM ('INTERESTED', 'NOT_INTERESTED', 'CALLBACK', 'MEETING_SCHEDULED');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "MeetingType" AS ENUM ('OFFICE_VISIT', 'ONLINE', 'BROKER_TOUR');

-- CreateEnum
CREATE TYPE "KcTeam" AS ENUM ('STAFF', 'OUTSOURCE');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'WHATSAPP', 'TELEGRAM', 'EMAIL', 'PUSH');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "BrokerCategory" AS ENUM ('COLD', 'WARM', 'HOT', 'CONVERTED', 'ON_BOT_REVIEW', 'BLACKLIST');

-- CreateEnum
CREATE TYPE "BrokerSpecialization" AS ENUM ('COMM', 'RESIDENTIAL', 'BOTH');

-- CreateEnum
CREATE TYPE "BrokerCallResult" AS ENUM ('NDZ', 'DOUBLE_NDZ', 'INFORMED', 'ALREADY_KNOWS', 'WRONG_NUMBER', 'REFUSED_COMMUNICATION', 'NOT_A_BROKER', 'SCHEDULED_TOUR', 'ONLY_SEND_INFO', 'IN_PROGRESS', 'REFUSED_TOUR', 'HUNG_UP', 'NOT_RELEVANT', 'NOT_BROKER_ANYMORE', 'ASKED_NOT_TO_CALL', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "AmoSyncStatus" AS ENUM ('SYNCED', 'PENDING', 'FAILED');

-- CreateTable
CREATE TABLE "agencies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "inn" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "legal_address" TEXT,
    "bank_name" TEXT,
    "bank_bik" TEXT,
    "bank_account" TEXT,
    "correspondent_account" TEXT,
    "total_sqm_sold" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "commission_level" "CommissionLevel" NOT NULL DEFAULT 'START',
    "quarterly_bonus_streak" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_agencies" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "agency_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_agencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brokers" (
    "id" TEXT NOT NULL,
    "amo_contact_id" BIGINT,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "avatar_url" TEXT,
    "birth_date" DATE,
    "password_hash" TEXT,
    "password_reset_token" TEXT,
    "password_reset_expires_at" TIMESTAMP(3),
    "role" "UserRole" NOT NULL DEFAULT 'BROKER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "funnel_stage" "BrokerFunnelStage" NOT NULL DEFAULT 'NEW_BROKER',
    "source" "BrokerSource",
    "closure_reason" TEXT,
    "telegram_chat_id" BIGINT,
    "broker_tour_visited" BOOLEAN NOT NULL DEFAULT false,
    "broker_tour_date" TIMESTAMP(3),
    "do_not_call" BOOLEAN NOT NULL DEFAULT false,
    "best_call_time" TEXT,
    "mango_employee_num" TEXT,
    "kc_team" "KcTeam",
    "position" TEXT,
    "telegram_username" TEXT,
    "telegram_id" TEXT,
    "whatsapp_username" TEXT,
    "presentation_sent" BOOLEAN NOT NULL DEFAULT false,
    "category" "BrokerCategory" NOT NULL DEFAULT 'COLD',
    "specialization" "BrokerSpecialization",
    "region" TEXT,
    "is_regional" BOOLEAN NOT NULL DEFAULT false,
    "is_coordinator" BOOLEAN NOT NULL DEFAULT false,
    "coordinator_agency" TEXT,
    "last_call_at" TIMESTAMP(3),
    "next_call_at" TIMESTAMP(3),
    "is_in_base" BOOLEAN NOT NULL DEFAULT false,
    "base_source" TEXT,
    "assigned_manager_id" TEXT,
    "assigned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "reactivated_at" TIMESTAMP(3),
    "merged_into_id" TEXT,
    "merged_at" TIMESTAMP(3),

    CONSTRAINT "brokers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "responsible_broker_id" TEXT,
    "amo_lead_id" BIGINT,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "comment" TEXT,
    "project" "Project" NOT NULL DEFAULT 'ZORGE9',
    "fixation_agency_id" TEXT,
    "uniqueness_status" "UniquenessStatus" NOT NULL DEFAULT 'CONDITIONALLY_UNIQUE',
    "uniqueness_reason" TEXT,
    "uniqueness_expires_at" TIMESTAMP(3),
    "fixation_status" "FixationStatus" NOT NULL DEFAULT 'NOT_FIXED',
    "fixation_expires_at" TIMESTAMP(3),
    "inspection_act_signed" BOOLEAN NOT NULL DEFAULT false,
    "status" "ClientStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "amo_created_at" TIMESTAMP(3),
    "amo_updated_at" TIMESTAMP(3),
    "amo_sync_status" "AmoSyncStatus" NOT NULL DEFAULT 'SYNCED',
    "amo_sync_error" TEXT,
    "amo_sync_attempts" INTEGER NOT NULL DEFAULT 0,
    "amo_sync_last_attempt_at" TIMESTAMP(3),
    "property_type" TEXT,
    "rooms_count" TEXT,
    "amount" DECIMAL(14,2),
    "sqm" DECIMAL(10,2),
    "client_region" TEXT,
    "purchase_timing" TEXT,
    "readiness_level" TEXT,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lots" (
    "id" TEXT NOT NULL,
    "external_id" TEXT,
    "number" TEXT NOT NULL,
    "project" "Project" NOT NULL DEFAULT 'ZORGE9',
    "building" TEXT NOT NULL,
    "floor" INTEGER NOT NULL,
    "rooms" TEXT NOT NULL,
    "sqm" DECIMAL(10,2) NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "price_per_sqm" DECIMAL(10,2),
    "status" "LotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "property_type" TEXT,
    "layout_url" TEXT,
    "plan_image_url" TEXT,
    "description" TEXT,
    "floors_total" INTEGER,
    "building_section" TEXT,
    "window_view" TEXT,
    "built_year" INTEGER,
    "ready_quarter" INTEGER,
    "building_state" TEXT,
    "has_balcony" BOOLEAN NOT NULL DEFAULT false,
    "has_terrace" BOOLEAN NOT NULL DEFAULT false,
    "is_penthouse" BOOLEAN NOT NULL DEFAULT false,
    "is_corner_layout" BOOLEAN NOT NULL DEFAULT false,
    "has_storage" BOOLEAN NOT NULL DEFAULT false,
    "two_bathrooms" BOOLEAN NOT NULL DEFAULT false,
    "has_master_bedroom" BOOLEAN NOT NULL DEFAULT false,
    "is_urban_villa" BOOLEAN NOT NULL DEFAULT false,
    "is_view_lot" BOOLEAN NOT NULL DEFAULT false,
    "is_high_flat" BOOLEAN NOT NULL DEFAULT false,
    "discount_price" DECIMAL(14,2),
    "discount_percent" DECIMAL(5,2),
    "discount_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "agency_id" TEXT,
    "lot_id" TEXT,
    "amo_deal_id" BIGINT,
    "amo_parent_deal_id" BIGINT,
    "project" "Project" NOT NULL DEFAULT 'ZORGE9',
    "contract_type" "ContractType",
    "amount" DECIMAL(14,2) NOT NULL,
    "sqm" DECIMAL(10,2) NOT NULL,
    "commission_rate" DECIMAL(5,2) NOT NULL,
    "commission_amount" DECIMAL(14,2) NOT NULL,
    "payment_received" BOOLEAN NOT NULL DEFAULT false,
    "payment_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "is_installment" BOOLEAN NOT NULL DEFAULT false,
    "status" "DealStatus" NOT NULL DEFAULT 'PENDING',
    "signed_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "client_id" TEXT,
    "mango_call_id" TEXT,
    "direction" "CallDirection" NOT NULL DEFAULT 'OUTBOUND',
    "status" "CallStatus" NOT NULL DEFAULT 'COMPLETED',
    "result" "CallResult",
    "duration_sec" INTEGER,
    "transcript" TEXT,
    "sentiment" "Sentiment",
    "recording_url" TEXT,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "cycle_day" INTEGER NOT NULL DEFAULT 1,
    "materials_sent" JSONB,
    "initiated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_dedup_dismissals" (
    "id" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_dedup_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_phones" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_logs" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "operator_id" TEXT,
    "campaign" TEXT,
    "result" "BrokerCallResult" NOT NULL,
    "comment" TEXT,
    "next_call_at" TIMESTAMP(3),
    "duration" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by_id" TEXT NOT NULL,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "filters" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "manager_id" TEXT,
    "slot_id" TEXT,
    "type" "MeetingType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "comment" TEXT,
    "status" "MeetingStatus" NOT NULL DEFAULT 'PENDING',
    "act_signed" BOOLEAN NOT NULL DEFAULT false,
    "reminded_24h" BOOLEAN NOT NULL DEFAULT false,
    "reminded_1h" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_slots" (
    "id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "duration_min" INTEGER NOT NULL DEFAULT 60,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "type" "MeetingType",
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "project" "Project",
    "file_url" TEXT NOT NULL,
    "file_size" INTEGER,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailings" (
    "id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "channels" JSONB NOT NULL,
    "filters" JSONB NOT NULL,
    "recipients_count" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorite_lots" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_acceptances" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "offer_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "signed_pdf_url" TEXT,

    CONSTRAINT "offer_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_acceptances" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "privacy_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "privacy_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "payload" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_content" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "site_content_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "site_content_revisions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "editor_id" TEXT,
    "editor_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_content_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landing_events" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landing_projects" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tag" TEXT,
    "name" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT NOT NULL,
    "cta_text" TEXT,
    "cta_href" TEXT,
    "image_url" TEXT,
    "gallery" JSONB,
    "class_type" TEXT,
    "address" TEXT,
    "district" TEXT,
    "total_units" INTEGER,
    "floors_total" INTEGER,
    "buildings_count" INTEGER,
    "price_per_sqm_from" DECIMAL(14,2),
    "ready_quarter" INTEGER,
    "ready_year" INTEGER,
    "commission_from" DECIMAL(5,2),
    "commission_to" DECIMAL(5,2),
    "characteristics" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landing_news" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL,
    "excerpt" TEXT,
    "image_url" TEXT,
    "url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_news_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landing_promos" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT,
    "tag" TEXT,
    "image_url" TEXT,
    "image_position" TEXT DEFAULT 'center',
    "cta_text" TEXT,
    "cta_href" TEXT,
    "project" "Project",
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_promos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_requests" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "message" TEXT,
    "source" TEXT,
    "event_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "processed_at" TIMESTAMP(3),
    "processed_by" TEXT,
    "amo_lead_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_policies" (
    "id" TEXT NOT NULL,
    "project" "Project" NOT NULL,
    "mode" "CommissionMode" NOT NULL,
    "installment_enabled" BOOLEAN,
    "installment_discount" DECIMAL(5,2),
    "subsidized_mortgage_enabled" BOOLEAN,
    "subsidized_mortgage_rate" DECIMAL(5,2),
    "display_note" TEXT,
    "flat_rate" DECIMAL(5,2),
    "levels" JSONB,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agencies_inn_key" ON "agencies"("inn");

-- CreateIndex
CREATE UNIQUE INDEX "broker_agencies_broker_id_agency_id_key" ON "broker_agencies"("broker_id", "agency_id");

-- CreateIndex
CREATE UNIQUE INDEX "brokers_amo_contact_id_key" ON "brokers"("amo_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "brokers_phone_key" ON "brokers"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "brokers_password_reset_token_key" ON "brokers"("password_reset_token");

-- CreateIndex
CREATE UNIQUE INDEX "brokers_telegram_chat_id_key" ON "brokers"("telegram_chat_id");

-- CreateIndex
CREATE INDEX "brokers_category_idx" ON "brokers"("category");

-- CreateIndex
CREATE INDEX "brokers_next_call_at_idx" ON "brokers"("next_call_at");

-- CreateIndex
CREATE INDEX "brokers_assigned_manager_id_idx" ON "brokers"("assigned_manager_id");

-- CreateIndex
CREATE INDEX "clients_phone_idx" ON "clients"("phone");

-- CreateIndex
CREATE INDEX "clients_broker_id_idx" ON "clients"("broker_id");

-- CreateIndex
CREATE INDEX "clients_amo_sync_status_idx" ON "clients"("amo_sync_status");

-- CreateIndex
CREATE UNIQUE INDEX "lots_external_id_key" ON "lots"("external_id");

-- CreateIndex
CREATE INDEX "lots_project_status_idx" ON "lots"("project", "status");

-- CreateIndex
CREATE INDEX "deals_broker_id_idx" ON "deals"("broker_id");

-- CreateIndex
CREATE INDEX "deals_client_id_idx" ON "deals"("client_id");

-- CreateIndex
CREATE INDEX "deals_agency_id_idx" ON "deals"("agency_id");

-- CreateIndex
CREATE INDEX "calls_broker_id_created_at_idx" ON "calls"("broker_id", "created_at");

-- CreateIndex
CREATE INDEX "calls_client_id_created_at_idx" ON "calls"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "calls_mango_call_id_idx" ON "calls"("mango_call_id");

-- CreateIndex
CREATE UNIQUE INDEX "broker_dedup_dismissals_name_key_key" ON "broker_dedup_dismissals"("name_key");

-- CreateIndex
CREATE UNIQUE INDEX "broker_phones_phone_key" ON "broker_phones"("phone");

-- CreateIndex
CREATE INDEX "broker_phones_broker_id_idx" ON "broker_phones"("broker_id");

-- CreateIndex
CREATE INDEX "call_logs_broker_id_created_at_idx" ON "call_logs"("broker_id", "created_at");

-- CreateIndex
CREATE INDEX "call_logs_operator_id_created_at_idx" ON "call_logs"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "campaigns_is_active_idx" ON "campaigns"("is_active");

-- CreateIndex
CREATE INDEX "meetings_broker_id_date_idx" ON "meetings"("broker_id", "date");

-- CreateIndex
CREATE INDEX "meetings_date_status_idx" ON "meetings"("date", "status");

-- CreateIndex
CREATE INDEX "meeting_slots_starts_at_is_active_idx" ON "meeting_slots"("starts_at", "is_active");

-- CreateIndex
CREATE INDEX "documents_category_is_public_sort_order_idx" ON "documents"("category", "is_public", "sort_order");

-- CreateIndex
CREATE INDEX "notifications_broker_id_created_at_idx" ON "notifications"("broker_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_broker_id_idx" ON "push_subscriptions"("broker_id");

-- CreateIndex
CREATE INDEX "notification_preferences_broker_id_idx" ON "notification_preferences"("broker_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_broker_id_event_type_channel_key" ON "notification_preferences"("broker_id", "event_type", "channel");

-- CreateIndex
CREATE INDEX "mailings_sent_at_idx" ON "mailings"("sent_at");

-- CreateIndex
CREATE INDEX "favorite_lots_broker_id_idx" ON "favorite_lots"("broker_id");

-- CreateIndex
CREATE UNIQUE INDEX "favorite_lots_broker_id_lot_id_key" ON "favorite_lots"("broker_id", "lot_id");

-- CreateIndex
CREATE INDEX "offer_acceptances_broker_id_idx" ON "offer_acceptances"("broker_id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_acceptances_broker_id_offer_version_key" ON "offer_acceptances"("broker_id", "offer_version");

-- CreateIndex
CREATE INDEX "privacy_acceptances_broker_id_idx" ON "privacy_acceptances"("broker_id");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_acceptances_broker_id_privacy_version_key" ON "privacy_acceptances"("broker_id", "privacy_version");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entity_id_idx" ON "audit_logs"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "site_content_revisions_key_created_at_idx" ON "site_content_revisions"("key", "created_at");

-- CreateIndex
CREATE INDEX "landing_events_date_is_active_idx" ON "landing_events"("date", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "landing_projects_slug_key" ON "landing_projects"("slug");

-- CreateIndex
CREATE INDEX "landing_news_published_at_is_active_idx" ON "landing_news"("published_at", "is_active");

-- CreateIndex
CREATE INDEX "landing_promos_sort_order_is_active_idx" ON "landing_promos"("sort_order", "is_active");

-- CreateIndex
CREATE INDEX "contact_requests_created_at_idx" ON "contact_requests"("created_at");

-- CreateIndex
CREATE INDEX "commission_policies_project_start_date_end_date_idx" ON "commission_policies"("project", "start_date", "end_date");

-- AddForeignKey
ALTER TABLE "broker_agencies" ADD CONSTRAINT "broker_agencies_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_agencies" ADD CONSTRAINT "broker_agencies_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brokers" ADD CONSTRAINT "brokers_assigned_manager_id_fkey" FOREIGN KEY ("assigned_manager_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brokers" ADD CONSTRAINT "brokers_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_responsible_broker_id_fkey" FOREIGN KEY ("responsible_broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_phones" ADD CONSTRAINT "broker_phones_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "meeting_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorite_lots" ADD CONSTRAINT "favorite_lots_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorite_lots" ADD CONSTRAINT "favorite_lots_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_acceptances" ADD CONSTRAINT "offer_acceptances_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_acceptances" ADD CONSTRAINT "privacy_acceptances_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
