-- 2026-07-17: Аудит базы брокеров (read-only).
-- Запускается workflow-ом .github/workflows/audit-broker-base.yml
-- через psql в контейнере postgres. Ничего не пишет в БД.

\pset pager off

\echo ''
\echo '================ 1. ОБЩИЕ ЦИФРЫ ================'
\echo ''
\echo '--- Все записи по ролям ---'
SELECT role, count(*) FROM brokers GROUP BY role ORDER BY count(*) DESC;

\echo '--- Брокеры (role=BROKER) по статусу ---'
SELECT status, count(*) FROM brokers WHERE role = 'BROKER' GROUP BY status ORDER BY count(*) DESC;

\echo '--- По источнику (source) ---'
SELECT coalesce(source::text, '(null)') AS source, count(*) FROM brokers WHERE role = 'BROKER' GROUP BY 1 ORDER BY count(*) DESC;

\echo '--- По base_source / is_in_base ---'
SELECT coalesce(base_source, '(null)') AS base_source, is_in_base, count(*) FROM brokers WHERE role = 'BROKER' GROUP BY 1, 2 ORDER BY count(*) DESC;

\echo '--- По категории КЦ ---'
SELECT category, count(*) FROM brokers WHERE role = 'BROKER' GROUP BY category ORDER BY count(*) DESC;

\echo '--- По стадии воронки ---'
SELECT funnel_stage, count(*) FROM brokers WHERE role = 'BROKER' GROUP BY funnel_stage ORDER BY count(*) DESC;

\echo ''
\echo '================ 2. ЗАПОЛНЕННОСТЬ ПОЛЕЙ (role=BROKER) ================'
\echo ''
\x on
SELECT
  count(*)                                                                        AS total_brokers,
  count(*) FILTER (WHERE full_name IS NULL OR btrim(full_name) = '')              AS name_empty,
  count(*) FILTER (WHERE full_name ~ '^[-+0-9() ]+$')                             AS name_looks_like_phone,
  count(*) FILTER (WHERE btrim(full_name) <> '' AND position(' ' IN btrim(full_name)) = 0) AS name_single_word,
  count(*) FILTER (WHERE email IS NULL OR email = '')                             AS email_empty,
  count(*) FILTER (WHERE specialization IS NULL)                                  AS specialization_empty,
  count(*) FILTER (WHERE region IS NULL OR region = '')                           AS region_empty,
  count(*) FILTER (WHERE is_regional)                                             AS is_regional,
  count(*) FILTER (WHERE is_coordinator)                                          AS is_coordinator,
  count(*) FILTER (WHERE amo_contact_id IS NULL)                                  AS no_amo_contact_id,
  count(*) FILTER (WHERE telegram_chat_id IS NOT NULL)                            AS has_telegram_chat,
  count(*) FILTER (WHERE telegram_username IS NOT NULL AND telegram_username <> '') AS has_telegram_username,
  count(*) FILTER (WHERE whatsapp_username IS NOT NULL AND whatsapp_username <> '') AS has_whatsapp,
  count(*) FILTER (WHERE do_not_call)                                             AS do_not_call,
  count(*) FILTER (WHERE assigned_manager_id IS NULL)                             AS no_assigned_manager,
  count(*) FILTER (WHERE password_hash IS NOT NULL)                               AS has_cabinet_password
FROM brokers
WHERE role = 'BROKER';
\x off

\echo '--- Брокеры без связи с агентством ---'
SELECT count(*) AS brokers_without_agency
FROM brokers b
WHERE b.role = 'BROKER'
  AND NOT EXISTS (SELECT 1 FROM broker_agencies ba WHERE ba.broker_id = b.id);

\echo '--- Качество телефонов: длина нормализованного номера ---'
SELECT length(regexp_replace(phone, '[^0-9]', '', 'g')) AS digits_len, count(*)
FROM brokers WHERE role = 'BROKER'
GROUP BY 1 ORDER BY count(*) DESC;

\echo ''
\echo '================ 3. ДУБЛИ ================'
\echo ''
\echo '--- Дубли по нормализованному телефону (8xxx = 7xxx) среди brokers.phone ---'
WITH norm AS (
  SELECT id, full_name,
         CASE WHEN left(d, 1) = '8' AND length(d) = 11 THEN '7' || substr(d, 2) ELSE d END AS p
  FROM (SELECT id, full_name, regexp_replace(phone, '[^0-9]', '', 'g') AS d FROM brokers) t
)
SELECT count(*) AS duplicate_phone_groups, coalesce(sum(c), 0) AS records_in_duplicates
FROM (SELECT p, count(*) c FROM norm GROUP BY p HAVING count(*) > 1) g;

\echo '--- Топ-20 групп дублей по телефону ---'
WITH norm AS (
  SELECT id, full_name,
         CASE WHEN left(d, 1) = '8' AND length(d) = 11 THEN '7' || substr(d, 2) ELSE d END AS p
  FROM (SELECT id, full_name, regexp_replace(phone, '[^0-9]', '', 'g') AS d FROM brokers) t
)
SELECT p AS phone_normalized, count(*) AS cnt, string_agg(left(full_name, 30), ' | ') AS names
FROM norm GROUP BY p HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 20;

\echo '--- Дубли ФИО (одинаковое имя, разные записи) ---'
SELECT count(*) AS duplicate_name_groups, coalesce(sum(c), 0) AS records_in_duplicates
FROM (
  SELECT lower(btrim(full_name)) n, count(*) c
  FROM brokers WHERE role = 'BROKER' AND btrim(coalesce(full_name, '')) <> ''
  GROUP BY 1 HAVING count(*) > 1
) g;

\echo '--- Топ-20 дублей ФИО ---'
SELECT lower(btrim(full_name)) AS name, count(*) AS cnt
FROM brokers WHERE role = 'BROKER' AND btrim(coalesce(full_name, '')) <> ''
GROUP BY 1 HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 20;

\echo '--- Пересечение доп.номеров (broker_phones) с основными номерами других брокеров ---'
SELECT count(*) AS extra_phone_conflicts
FROM broker_phones bp
JOIN brokers b ON regexp_replace(b.phone, '[^0-9]', '', 'g') = regexp_replace(bp.phone, '[^0-9]', '', 'g')
WHERE b.id <> bp.broker_id;

\echo ''
\echo '================ 4. СДЕЛКИ И АКТИВНОСТЬ ================'
\echo ''
\echo '--- Сделки: всего / брокеров со сделками ---'
SELECT count(*) AS deals_total, count(DISTINCT broker_id) AS brokers_with_deals FROM deals;

\echo '--- Распределение: сколько сделок у брокера ---'
SELECT c AS deals_count, count(*) AS brokers
FROM (SELECT broker_id, count(*) c FROM deals GROUP BY broker_id) t
GROUP BY c ORDER BY c;

\echo '--- Клиенты (фиксации): всего / брокеров с клиентами ---'
SELECT count(*) AS clients_total, count(DISTINCT broker_id) AS brokers_with_clients FROM clients;

\echo '--- Активность обзвона КЦ ---'
\x on
SELECT
  count(*) FILTER (WHERE last_call_at IS NULL)                              AS never_called,
  count(*) FILTER (WHERE last_call_at >= now() - interval '30 days')       AS called_last_30d,
  count(*) FILTER (WHERE last_call_at <  now() - interval '90 days')       AS call_older_90d,
  count(*) FILTER (WHERE next_call_at IS NOT NULL AND next_call_at < now()) AS next_call_overdue
FROM brokers WHERE role = 'BROKER';
\x off

\echo '--- Результаты звонков КЦ (call_logs) ---'
SELECT result, count(*) FROM call_logs GROUP BY result ORDER BY count(*) DESC;

\echo '--- Охват: брокеров хоть с одним звонком КЦ ---'
SELECT count(DISTINCT broker_id) AS brokers_with_call_logs FROM call_logs;

\echo ''
\echo '================ 5. АГЕНТСТВА ================'
\echo ''
SELECT count(*) AS agencies_total FROM agencies;
SELECT count(*) AS broker_agency_links, count(DISTINCT broker_id) AS brokers_linked FROM broker_agencies;

\echo ''
\echo '=== АУДИТ ЗАВЕРШЁН ==='
