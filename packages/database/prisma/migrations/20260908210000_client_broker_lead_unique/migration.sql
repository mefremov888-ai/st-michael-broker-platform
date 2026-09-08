-- 2026-09-08: один лид amoCRM = одна запись клиента у брокера. Дубли объединены
-- 08.09 (967 записей), причина закрыта в коде (PR 493); индекс защищает от повтора.
-- NULL amo_lead_id (заявки без лида) под ограничение не попадают.
CREATE UNIQUE INDEX IF NOT EXISTS "clients_broker_id_amo_lead_id_key" ON "clients"("broker_id", "amo_lead_id");
