-- 2026-09-07: Толбухина — отдельный проект (ЖК) наравне с Зорге 9 и Серебряным Бором;
-- «Не указан» (UNKNOWN) — лиды Колл-центра до перехода в воронку ЖК и записи старого кабинета без проекта.
-- Только добавление значения enum; данные не меняются.
ALTER TYPE "Project" ADD VALUE IF NOT EXISTS 'TOLBUKHINA';
ALTER TYPE "Project" ADD VALUE IF NOT EXISTS 'UNKNOWN';
