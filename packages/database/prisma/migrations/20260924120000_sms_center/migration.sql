-- 2026-09-24: СМС Центр — журнал отправок и одноразовые коды.
-- Код в БД не хранится: только хеш; в тексте журнала код заменён на «••••••».
CREATE TABLE "sms_messages" (
  "id" TEXT NOT NULL,
  "broker_id" TEXT,
  "phone" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "provider_id" TEXT,
  "provider_status" INTEGER,
  "error" TEXT,
  "parts" INTEGER,
  "cost" DECIMAL(10,2),
  "sent_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "status_checked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sms_messages_phone_created_at_idx" ON "sms_messages"("phone", "created_at");
CREATE INDEX "sms_messages_status_created_at_idx" ON "sms_messages"("status", "created_at");
CREATE INDEX "sms_messages_broker_id_created_at_idx" ON "sms_messages"("broker_id", "created_at");

CREATE TABLE "phone_otps" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumed_at" TIMESTAMP(3),
  "ip" TEXT,
  "sms_message_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "phone_otps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "phone_otps_phone_purpose_created_at_idx" ON "phone_otps"("phone", "purpose", "created_at");
CREATE INDEX "phone_otps_ip_created_at_idx" ON "phone_otps"("ip", "created_at");
