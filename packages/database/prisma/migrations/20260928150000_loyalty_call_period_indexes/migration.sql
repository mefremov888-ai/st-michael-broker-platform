-- 2026-09-28: «Период звонков» в базе лояльности (инцидент 504 на проде).
-- Множество брокеров со звонком за период теперь считается прямыми запросами
-- по таблицам звонков за диапазон дат; существующие индексы начинаются с
-- broker_id / assignment_id / operator_id и по одной дате не помогают.
-- Только CREATE INDEX (без CONCURRENTLY — prisma migrate deploy выполняет
-- миграцию в транзакции). calls уже покрыт индексом (client_id, created_at):
-- условие client_id IS NULL AND created_at BETWEEN … идёт по нему.

-- CreateIndex
CREATE INDEX "call_logs_created_at_idx" ON "call_logs"("created_at");

-- CreateIndex
CREATE INDEX "loyalty_call_attempts_occurred_at_idx" ON "loyalty_call_attempts"("occurred_at");
