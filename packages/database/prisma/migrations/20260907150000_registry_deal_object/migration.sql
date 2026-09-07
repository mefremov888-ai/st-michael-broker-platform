-- 2026-09-07: объект сделки в «Реестре сделок» (registry_deals) — площадь,
-- этаж, корпус, номер квартиры. В исходном Google-реестре и в выгрузке
-- data/registry-deals-upload.json этих полей нет; они заполняются из полей
-- лида amoCRM («Метраж, м2» 604555, «Этаж» 604551, «Дом» 604547, номер
-- квартиры — по названию поля) скриптом
-- scripts/enrich-registry-deals-from-amo.js (workflow
-- apply-registry-deal-objects.yml, dry-run по умолчанию, только пустые поля).
-- object_source: 'amo' — откуда взят объект; NULL — не заполнено.
--
-- Все колонки nullable, без DEFAULT и без backfill в миграции — ADD COLUMN на
-- ~1,6 тыс. строк мгновенный, migrate deploy безопасен.
ALTER TABLE "registry_deals" ADD COLUMN "sqm" DECIMAL(10,2);
ALTER TABLE "registry_deals" ADD COLUMN "floor" INTEGER;
ALTER TABLE "registry_deals" ADD COLUMN "building" TEXT;
ALTER TABLE "registry_deals" ADD COLUMN "apartment_number" TEXT;
ALTER TABLE "registry_deals" ADD COLUMN "object_source" TEXT;
