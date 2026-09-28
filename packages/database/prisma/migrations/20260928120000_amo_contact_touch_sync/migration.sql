-- 2026-09-28: ночная синхронизация «касаний» из amoCRM в «Нашу базу» лояльности.
-- Две новые таблицы, существующие строки не трогаются (только CREATE):
--   broker_amo_contact_sync — срез amoCRM по брокеру (1:1 с brokers):
--     последнее касание, последний звонок, ответственный воронки КЦ,
--     результат поиска контакта по телефону (очередь ручной привязки).
--     Заполняется только ночным синком, руками не правится.
--   amo_users — справочник сотрудников amoCRM (GET /api/v4/users) и их
--     привязка к нашему сотруднику (brokers с ролью MANAGER/ADMIN).
-- Enum AmoTouchKind — вид последнего касания.

-- CreateEnum
CREATE TYPE "AmoTouchKind" AS ENUM ('CALL_IN', 'CALL_OUT', 'TASK_COMPLETED', 'MEETING', 'NOTE', 'LEAD_STATUS', 'CONTACT_UPDATE');

-- CreateTable
CREATE TABLE "broker_amo_contact_sync" (
    "broker_id" TEXT NOT NULL,
    "amo_contact_id" BIGINT,
    "amo_lookup_at" TIMESTAMP(3),
    "amo_lookup_status" TEXT,
    "amo_lookup_candidates" JSONB,
    "amo_responsible_user_id" BIGINT,
    "kc_responsible_user_id" BIGINT,
    "kc_lead_id" BIGINT,
    "kc_lead_updated_at" TIMESTAMP(3),
    "amo_updated_at" TIMESTAMP(3),
    "amo_closest_task_at" TIMESTAMP(3),
    "last_touch_at" TIMESTAMP(3),
    "last_touch_kind" "AmoTouchKind",
    "last_touch_ref" TEXT,
    "last_touch_user_id" BIGINT,
    "last_call_at" TIMESTAMP(3),
    "last_call_direction" TEXT,
    "last_call_status" INTEGER,
    "last_call_result_text" TEXT,
    "last_call_duration_sec" INTEGER,
    "last_call_user_id" BIGINT,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "sync_error" TEXT,
    "source_hash" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_amo_contact_sync_pkey" PRIMARY KEY ("broker_id")
);

-- CreateTable
CREATE TABLE "amo_users" (
    "id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "broker_id" TEXT,
    "matched_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amo_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broker_amo_contact_sync_last_touch_at_idx" ON "broker_amo_contact_sync"("last_touch_at");

-- CreateIndex
CREATE INDEX "broker_amo_contact_sync_kc_responsible_user_id_idx" ON "broker_amo_contact_sync"("kc_responsible_user_id");

-- CreateIndex
CREATE INDEX "broker_amo_contact_sync_amo_lookup_status_idx" ON "broker_amo_contact_sync"("amo_lookup_status");

-- CreateIndex
CREATE UNIQUE INDEX "amo_users_broker_id_key" ON "amo_users"("broker_id");

-- AddForeignKey
ALTER TABLE "broker_amo_contact_sync" ADD CONSTRAINT "broker_amo_contact_sync_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amo_users" ADD CONSTRAINT "amo_users_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
