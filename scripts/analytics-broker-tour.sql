-- 2026-07-22: Сквозная аналитика по брокер-турам (read-only).
-- Отвечает на вопросы: сколько брокеров было на брокер-туре, кто именно,
-- и кто из них зафиксировал уникальность клиента.
-- Запускается workflow-ом .github/workflows/analytics-broker-tour.yml
-- через psql в контейнере postgres. Ничего не пишет в БД.
-- Телефоны в выводе маскируются (последние 4 цифры).

\pset pager off

\echo ''
\echo '================ 1. СИГНАЛЫ «БЫЛ НА БРОКЕР-ТУРЕ» (сколько по каждому источнику) ================'
\echo ''
\echo '--- Отметка «был на брокер-туре» (broker_tour_visited) ---'
SELECT broker_tour_visited, count(*)
FROM brokers
WHERE role = 'BROKER' AND merged_into_id IS NULL
GROUP BY 1 ORDER BY 1 DESC;

\echo '--- Стадия воронки (funnel_stage) ---'
SELECT funnel_stage, count(*)
FROM brokers
WHERE role = 'BROKER' AND merged_into_id IS NULL
GROUP BY 1 ORDER BY count(*) DESC;

\echo '--- Записались на тур через лендинг (source = LANDING_BROKER_TOUR) ---'
SELECT count(*) AS landing_tour_signups
FROM brokers
WHERE role = 'BROKER' AND merged_into_id IS NULL AND source = 'LANDING_BROKER_TOUR';

\echo '--- Встречи типа BROKER_TOUR по статусам ---'
SELECT status, count(*) AS meetings, count(DISTINCT broker_id) AS brokers
FROM meetings
WHERE type = 'BROKER_TOUR'
GROUP BY 1 ORDER BY count(*) DESC;

\echo ''
\echo '================ 2. КТО БЫЛ НА БРОКЕР-ТУРЕ (broker_tour_visited = true) ================'
\echo ''
SELECT
  b.full_name                                              AS broker,
  '***' || right(regexp_replace(b.phone, '\D', '', 'g'), 4) AS phone,
  to_char(b.broker_tour_date, 'DD.MM.YYYY')                AS tour_date,
  b.funnel_stage,
  b.category,
  count(c.id)                                              AS clients_total,
  count(c.id) FILTER (WHERE c.uniqueness_status = 'CONDITIONALLY_UNIQUE') AS unique_fixations,
  count(c.id) FILTER (WHERE c.fixation_status = 'FIXED')   AS fixed_status
FROM brokers b
LEFT JOIN clients c ON c.broker_id = b.id
WHERE b.role = 'BROKER' AND b.merged_into_id IS NULL AND b.broker_tour_visited = true
GROUP BY b.id, b.full_name, b.phone, b.broker_tour_date, b.funnel_stage, b.category
ORDER BY unique_fixations DESC, b.broker_tour_date NULLS LAST;

\echo ''
\echo '--- Итог по «был на туре»: всего / с фиксациями ---'
SELECT
  count(*)                                   AS tour_visited_total,
  count(*) FILTER (WHERE fix.unique_cnt > 0) AS with_unique_fixation,
  count(*) FILTER (WHERE fix.fixed_cnt > 0)  AS with_fixed_status
FROM brokers b
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE c.uniqueness_status = 'CONDITIONALLY_UNIQUE') AS unique_cnt,
    count(*) FILTER (WHERE c.fixation_status = 'FIXED')                  AS fixed_cnt
  FROM clients c WHERE c.broker_id = b.id
) fix ON true
WHERE b.role = 'BROKER' AND b.merged_into_id IS NULL AND b.broker_tour_visited = true;

\echo ''
\echo '================ 3. ЗАПИСАНЫ НА ТУР, НО ОТМЕТКИ «БЫЛ» НЕТ ================'
\echo ''
\echo '--- Есть дата тура, но visited = false (записан, не пришёл / не отмечен) ---'
SELECT
  b.full_name                                              AS broker,
  '***' || right(regexp_replace(b.phone, '\D', '', 'g'), 4) AS phone,
  to_char(b.broker_tour_date, 'DD.MM.YYYY')                AS tour_date,
  b.funnel_stage
FROM brokers b
WHERE b.role = 'BROKER' AND b.merged_into_id IS NULL
  AND b.broker_tour_visited = false AND b.broker_tour_date IS NOT NULL
ORDER BY b.broker_tour_date DESC
LIMIT 50;

\echo ''
\echo '================ 4. ВСТРЕЧИ-ТУРЫ (meetings type=BROKER_TOUR) — кто ездил ================'
\echo ''
SELECT
  b.full_name                                              AS broker,
  '***' || right(regexp_replace(b.phone, '\D', '', 'g'), 4) AS phone,
  m.status,
  to_char(m.date, 'DD.MM.YYYY')                            AS meeting_date,
  b.broker_tour_visited
FROM meetings m
JOIN brokers b ON b.id = m.broker_id
WHERE m.type = 'BROKER_TOUR'
ORDER BY m.date DESC
LIMIT 100;

\echo ''
\echo '================ 5. ОБРАТНАЯ ПРОВЕРКА: ВСЕ БРОКЕРЫ С УНИКАЛЬНЫМИ ФИКСАЦИЯМИ ================'
\echo ''
SELECT
  b.full_name                                              AS broker,
  '***' || right(regexp_replace(b.phone, '\D', '', 'g'), 4) AS phone,
  b.broker_tour_visited                                    AS was_on_tour,
  to_char(b.broker_tour_date, 'DD.MM.YYYY')                AS tour_date,
  count(c.id) FILTER (WHERE c.uniqueness_status = 'CONDITIONALLY_UNIQUE') AS unique_fixations,
  count(c.id)                                              AS clients_total
FROM brokers b
JOIN clients c ON c.broker_id = b.id
WHERE b.merged_into_id IS NULL
GROUP BY b.id, b.full_name, b.phone, b.broker_tour_visited, b.broker_tour_date
HAVING count(c.id) FILTER (WHERE c.uniqueness_status = 'CONDITIONALLY_UNIQUE') > 0
ORDER BY unique_fixations DESC;

\echo ''
\echo '--- Итог: брокеров с уникальными фиксациями всего / из них были на туре ---'
SELECT
  count(*)                                          AS brokers_with_unique_fixations,
  count(*) FILTER (WHERE b.broker_tour_visited)     AS of_them_on_tour
FROM (
  SELECT c.broker_id
  FROM clients c
  WHERE c.uniqueness_status = 'CONDITIONALLY_UNIQUE'
  GROUP BY c.broker_id
) f
JOIN brokers b ON b.id = f.broker_id
WHERE b.merged_into_id IS NULL;

\echo ''
\echo '=== Конец отчёта ==='
