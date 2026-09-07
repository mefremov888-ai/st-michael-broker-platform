-- 2026-09-07: правила владельца по сделкам. Дата сделки = «Дата оплаты ДДУ»
-- (столбец H Google-реестра, при рассрочке — первая оплата); «платная бронь» =
-- ДВОУ: дата (D), дата оплаты (E), сумма (AA). Заполняются перезаливкой
-- реестра (scripts/upload-registry-deals.js, режим ONLY_FIELDS) из сшивки
-- price_agent. Все колонки nullable, без DEFAULT — ADD COLUMN мгновенный.
ALTER TABLE "registry_deals" ADD COLUMN "paid_at" DATE;
ALTER TABLE "registry_deals" ADD COLUMN "dvou_date" DATE;
ALTER TABLE "registry_deals" ADD COLUMN "dvou_paid_at" DATE;
ALTER TABLE "registry_deals" ADD COLUMN "dvou_amount" DECIMAL(14,2);
CREATE INDEX "registry_deals_paid_at_idx" ON "registry_deals"("paid_at");
CREATE INDEX "registry_deals_dvou_paid_at_idx" ON "registry_deals"("dvou_paid_at");
