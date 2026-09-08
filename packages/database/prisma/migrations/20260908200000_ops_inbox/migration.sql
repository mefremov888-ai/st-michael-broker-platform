-- 2026-09-08: входящие сообщения ops-бота техподдержки (ответы владельца и Анны,
-- файлы с решениями) для рабочей сессии ассистента. Только новая таблица.
CREATE TABLE IF NOT EXISTS "ops_inbox_messages" (
  "id" TEXT NOT NULL,
  "update_id" BIGINT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "chat_title" TEXT,
  "from_name" TEXT,
  "from_username" TEXT,
  "message_id" BIGINT NOT NULL,
  "text" TEXT,
  "file_id" TEXT,
  "file_name" TEXT,
  "file_size" INTEGER,
  "mime_type" TEXT,
  "reply_to_text" TEXT,
  "sent_at" TIMESTAMP(3) NOT NULL,
  "handled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_inbox_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ops_inbox_messages_update_id_key" ON "ops_inbox_messages"("update_id");
CREATE INDEX IF NOT EXISTS "ops_inbox_messages_created_at_idx" ON "ops_inbox_messages"("created_at");
