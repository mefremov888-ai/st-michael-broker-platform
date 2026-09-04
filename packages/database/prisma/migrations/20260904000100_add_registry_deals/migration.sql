-- 2026-09-04: «Реестр сделок» — сквозная аналитика ДДУ (Google-реестр ↔ amoCRM).
-- Чисто аддитивная миграция: одна новая таблица, ни одна существующая строка
-- не меняется. Enum "Project" уже существует (0_legacy_baseline).

BEGIN;

CREATE TABLE "registry_deals" (
    "id" TEXT NOT NULL,
    "row_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "contract_number" TEXT NOT NULL,
    "project" "Project",
    "signed_at" DATE,
    "amount" DECIMAL(14,2),
    "agency_name_raw" TEXT,
    "agency_canonical" TEXT,
    "amo_lead_id" BIGINT,
    "broker_id" TEXT,
    "broker_amo_contact_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "registry_deals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "registry_deals_row_key_key" ON "registry_deals"("row_key");
CREATE INDEX "registry_deals_agency_canonical_idx" ON "registry_deals"("agency_canonical");
CREATE INDEX "registry_deals_broker_id_idx" ON "registry_deals"("broker_id");
CREATE INDEX "registry_deals_project_signed_at_idx" ON "registry_deals"("project", "signed_at");

ALTER TABLE "registry_deals" ADD CONSTRAINT "registry_deals_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
