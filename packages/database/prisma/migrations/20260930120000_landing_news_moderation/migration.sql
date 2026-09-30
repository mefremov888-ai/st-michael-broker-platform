-- 2026-09-30: согласование Telegram-новостей перед публикацией на лендинге.
-- Только добавление колонок в landing_news:
--   moderation_status — PENDING | APPROVED | REJECTED. Все существующие строки
--     (парсер stmichael.ru, ручные карточки) получают APPROVED через DEFAULT;
--     новые посты Telegram-канала создаются как PENDING, публичный endpoint
--     отдаёт только APPROVED;
--   moderation_notices — JSON со списком сообщений «На согласование»
--     (chat_id + message_id у каждого модератора), чтобы после решения убрать
--     кнопки и дописать итог в каждом;
--   moderated_at / moderated_by — когда и кто решил (имя из Telegram или логин админа).

-- AlterTable
ALTER TABLE "landing_news" ADD COLUMN "moderation_status" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "moderation_notices" JSONB,
ADD COLUMN "moderated_at" TIMESTAMP(3),
ADD COLUMN "moderated_by" TEXT;

-- CreateIndex
CREATE INDEX "landing_news_moderation_status_idx" ON "landing_news"("moderation_status");
