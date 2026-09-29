-- 2026-09-29: новости лендинга из закрытого Telegram-канала компании.
-- Только добавление колонок в landing_news, существующие строки не трогаются:
--   telegram_chat_id + telegram_message_id — ключ поста (upsert при приёме
--     channel_post / edited_channel_post), уникальная пара;
--   media_group_id — альбом: несколько фото одним постом = одна новость.

-- AlterTable
ALTER TABLE "landing_news" ADD COLUMN "telegram_chat_id" TEXT,
ADD COLUMN "telegram_message_id" INTEGER,
ADD COLUMN "media_group_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "landing_news_telegram_chat_id_telegram_message_id_key" ON "landing_news"("telegram_chat_id", "telegram_message_id");

-- CreateIndex
CREATE INDEX "landing_news_telegram_chat_id_media_group_id_idx" ON "landing_news"("telegram_chat_id", "media_group_id");
