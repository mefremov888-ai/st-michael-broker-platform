-- 2026-09-07: Broker.display_name — «имя для работы» для КЦ («Наша база»).
--
-- У ~19% брокеров fullName кривое (мусор, телефоны, ники). КЦ видит
-- display_name в списке и карточке «Нашей базы» и может править его
-- кнопкой «Исправить имя»; брокер в своём кабинете продолжает видеть
-- своё самоназвание (full_name не трогаем, display_name брокеру не отдаём).
--
-- display_name_source: 'self' | 'old_cabinet' | 'amo' | 'manual' —
-- откуда взято имя (бэкфилл scripts/backfill-display-names.js, ручные
-- правки КЦ = 'manual'; заполненное значение бэкфилл не перезаписывает).
--
-- Обе колонки nullable, без DEFAULT и без backfill в миграции —
-- ADD COLUMN на 19k строк мгновенный, migrate deploy безопасен.
ALTER TABLE "brokers" ADD COLUMN "display_name" TEXT;
ALTER TABLE "brokers" ADD COLUMN "display_name_source" TEXT;
