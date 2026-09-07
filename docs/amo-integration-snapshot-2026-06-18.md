# amoCRM-интеграция — снапшот рабочего состояния 2026-06-18

**Цель:** зафиксировать настройки, которые сейчас работают, чтобы можно было откатиться если что-то сломаем.

**Эталонный коммит мастера:** `c5f57a8` (Merge PR #167 — fix(admin): не перетирать ФИО брокера данными из amoCRM).
**Откат:** `git checkout c5f57a8` для эталонного состояния, или revert свежих PR по одному.

---

## Воронки amoCRM

| pipeline_id | Название |
|---|---|
| 7600542 | КЦ (колл-центр) |
| 7600546 | Берзарина 37 / Серебряный Бор (sales) |
| 7600550 | Зорге 9 (sales) |
| 7600554 | Толбухина (sales) |
| 10787390 | БРОКЕРЫ |

## Ключевые статусы (status_id)

**КЦ (7600542):**
- 62907282 — Классифицировали, выводим на встречу (RULE_2 active)
- 62907286 — Встреча назначена (RULE_2 active, marker RULE_2_KC_PENDING)
- 142 — Встреча проведена (closed-final КЦ)
- 143 — Закрыто и не реализовано → REJECTED для всех претендентов

**Sales (7600546/50/54):**
- 62907138 / 62907154 / 62907170 — Квалификация (RULE_2)
- 62907142 / 62907158 / 62907174 — Встреча назначена (sales MEETING_SCHEDULED → RULE_2)
- 62907358 / 62907430 / 62907570 — Встреча проведена «думают» (RULE_EXCEPTION_AFTER_SALES_MEETING)
- Платная бронь / Подготовка сделки / Сделка / Сделка зарегистрирована / Контроль оплаты → RULE_REJECT_SALES_DEAL

## Env-переменные (на проде)

| key | значение | назначение |
|---|---|---|
| AMO_ACCESS_TOKEN | (живёт в БД SystemSetting + env fallback) | OAuth access |
| AMO_REFRESH_TOKEN | (БД SystemSetting + env fallback) | OAuth refresh |
| AMO_CLIENT_ID / AMO_CLIENT_SECRET | (env) | OAuth refresh-grant |
| AMO_SUBDOMAIN | stmichael | для построения URL |
| AMO_BASE_DOMAIN | amocrm.ru | |
| AMO_REDIRECT_URI | https://broker.stmichael.ru/ | OAuth |
| AMO_ALARM_TASK_TYPE_ID | 2393839 | тип alarm-задач |
| AMO_BROKER_MEETINGS_MANAGER_ID | 10216602 | Ксения — встречи брокеров + ответственный за brokers-pipeline лиды (PR #165) |
| AMO_DEFAULT_RESPONSIBLE_USER_ID | (НЕ задан) | fallback для leads если Морикит сломан — оставить пустым |
| MOREKIT_WEBHOOK_URL | хранится в БД SystemSetting | webhook Морикита (Анна меняет периодически) |

## Кастомные поля (важные)

**Лид (Lead):**
- 587387 «Тип объекта» — multiselect: Квартира=1025397, Апартамент=859233, Коммерческое=889061, Кладовая=981093, Паркинг=859235
- 583447 «Сколько комнат»
- 833045 «Стоимость без скидок, руб» (= бюджет)
- 604555 «Метраж, м²»
- 665195 «От брокера» (Да/Нет)
- 833189 «Дата создания заявки от брокера»
- 618551 «Источник/utm_source» = «Заявка от брокера» (маркер broker-fixation лидов)
- 832015 / 832171 «Ответственный КЦ» / «Ответственный КЦ список»
- 839251 cc_id_daughter (id sales-дочернего лида)
- 842387 «Сделка в Брокерах» (ссылка)
- 836265 «Встреча» (тип: офис/онлайн/тур)
- 839185 «Дата и время встречи»

**Контакт:**
- 835415 IS_BROKER (true → контакт-брокер, не клиент)
- AGENCY_NAME, INN (используются для брокер-импорта)
- 589265 REGION (регион клиента)
- 835955 «Отправлена презентация»

## Правила уникальности (evaluateUniqueness)

Приоритет (от строгого к мягкому):
1. **RULE_REJECT_SALES_DEAL** — лид в sales-сделке (Платная бронь+) → REJECTED, новой карточки не создаём.
2. **RULE_EXCEPTION_AFTER_SALES_MEETING** — лид в sales-«думают»/отложенный → UNDER_REVIEW + создаём L2 в КЦ + marker `EXCEPTION_AFTER_SALES_MEETING:`.
3. **RULE_2** — КЦ active (62907282/62907286) или sales MEETING_SCHEDULED → UNDER_REVIEW + alarm-нота + alarm-task. КЦ-триггер ВСЕГДА побеждает sales (PR #159).
4. **RULE_1** — КЦ-«Новое обращение» без брокера → CONDITIONALLY_UNIQUE + прикрепляем нового брокера контактом + alarm-задача.
5. **NO_CONFLICT** — нет активных лидов → создаём новый.

**Маркеры в `Client.uniquenessReason`** (используются webhook'ом для лифта статуса):
- `RULE_2_KC_PENDING:<leadId>` — лифт только когда КЦ-лид перейдёт в 142 (PR #156)
- `EXCEPTION_AFTER_SALES_MEETING:<leadId>` — лифт только когда L2 дойдёт до 62907282 или sales-лид закроется 143

## Webhook'и amoCRM

URL: `https://broker.stmichael.ru/api/webhooks/amo/lead-update`
Зарегистрирован через `setup-amo-webhook` task (object body, не array).

Поведение: webhook ВСЕГДА возвращает 200 (PR #147) — иначе amoCRM отключает endpoint после 5xx.

Логика:
- КЦ 143 → REJECTED для всех Client с этим amoLeadId
- КЦ 142 → CONDITIONALLY_UNIQUE для прикреплённых, REJECTED для остальных
- attached → CONDITIONALLY_UNIQUE (если не маркер RULE_2_KC_PENDING)
- detached → REJECTED
- Sales-pipeline transitions — ретроспективно меняют статус Client'ов с маркером EXCEPTION

## Sync responsible_user_id

Когда мы создаём лид через API без `responsible_user_id`, amoCRM ставит OAuth-токен-owner (тех.админ). Морикит создаёт задачу с правильным responsible, но НЕ обновляет лид.

`syncLeadResponsibleFromLatestTask` (PR #160): 30 × 10с = 5 мин polling.
- Захватываем `initialResponsible` при старте
- Если найдена task с другим responsible — обновляем лид
- Если `current != initial` (КЦ-менеджер вручную взял) — НЕ перетираем
- Вызывается из `client-fixation.service.ts` после `notifyFixation`

## Брокер-тур (заявка с лендинга → воронка БРОКЕРЫ 10787390)

`createBrokerLeadFromLanding`:
- Контакт IS_BROKER=true
- Лид с responsible = AMO_BROKER_MEETINGS_MANAGER_ID (Ксения, PR #165)
- Задача «Связаться с новым брокером» с тем же responsible
- ДОПОЛНИТЕЛЬНО webhook в Морикит → вторая задача на КЦ-оператора по графику (PR #166)

## Ответственные

- Любая фиксация лид → Юлия (через Морикит после notifyFixation + sync)
- Задача от RULE_1/RULE_2 alarm — на responsible лида, fallback на AMO_DEFAULT_RESPONSIBLE_USER_ID
- Брокер-тур → Ксения (AMO_BROKER_MEETINGS_MANAGER_ID)
- Воронки продаж broker-platform НЕ трогает (PR от 15.06)

## История критических фиксов на этой неделе

| PR | Что | Зачем |
|---|---|---|
| #145 | КЦ 143 → REJECTED для всех | Не оставлять прикреплённого как «уникален» если КЦ закрыл |
| #147 | webhook всегда 200 | amoCRM отключал endpoint после 5xx |
| #149-152 | sales-pipeline дифференциация | разные стадии sales = разные правила |
| #156 | RULE_2_KC_PENDING marker | webhook лифтит только на КЦ 142 |
| #159 | КЦ-триггер побеждает sales для RULE_2 | alarm попадает в КЦ-карточку, не теряется |
| #160 | sync responsible 5 мин + защита | Морикит-задача иногда позже 60с |
| #162 | админ может менять uniquenessStatus | аварийная ручка |
| #165 | broker-tour responsible = Ксения | задача видна Ксении |
| #166 | broker-tour Морикит-дубль | КЦ-оператор по графику тоже видит |
| #167 | не перетирать fullName из amo | админские пометки не попадают в кабинет |

## Откат

Полный откат: `git checkout c5f57a8` на сервере + `docker compose up -d --force-recreate api`.
Частичный: `git revert <PR-merge-commit>` для конкретной правки.

`.env` бэкапы создаются автоматически при `update-smtp-creds` / `update-amo-meetings-manager` как `.env.bak.<unix-timestamp>` — можно восстановить.
