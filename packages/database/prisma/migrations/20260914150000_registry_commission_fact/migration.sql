-- 2026-09-14: факт комиссии из Google-листа рядом с расчётом кабинета.
-- Поля сырые: в проценте бывает источник лида, в отметке о выплате —
-- произвольный текст с дописанной суммой. Разбор — на стороне приложения.
ALTER TABLE "registry_deals"
  ADD COLUMN "commission_amount_fact" DECIMAL(14,2),
  ADD COLUMN "commission_percent_raw" TEXT,
  ADD COLUMN "commission_paid_raw" TEXT,
  ADD COLUMN "commission_paid_amount" DECIMAL(14,2),
  ADD COLUMN "commission_sheet_at" TIMESTAMP(3),
  ADD COLUMN "lead_source_raw" TEXT,
  ADD COLUMN "commission_sheet_row" INTEGER;

CREATE INDEX "registry_deals_commission_amount_fact_idx" ON "registry_deals"("commission_amount_fact");
