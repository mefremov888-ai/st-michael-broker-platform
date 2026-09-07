# Импорт брокеров из Google Sheets — настройка

Одноразовая настройка. После неё импорт запускается одной кнопкой из GitHub Actions без xlsx-файлов и без SSH.

## Архитектура

```
[Google Sheet]  ─ shares ─→  [Service Account]  ─ reads ─→  [API container]  ─ writes ─→  [Postgres]
                                     ↑
                                 GOOGLE_SERVICE_ACCOUNT_JSON
                                 (env var в .env на сервере)

[GitHub UI: Run workflow]  →  [SSH в сервер]  →  [docker compose exec api node …gsheet.js]
```

---

## Шаг 1 — Создать Service Account (делает Михаил, ~10 минут)

1. Открыть **Google Cloud Console**: https://console.cloud.google.com/
   - Если проекта нет — создать новый. Имя: `st-michael-broker-platform`. (Бесплатно.)

2. В навигации слева → **APIs & Services → Library**
   - Найти **Google Sheets API** → кнопка **Enable**.

3. **APIs & Services → Credentials → Create Credentials → Service Account**
   - Service account name: `broker-platform-sheets-reader`
   - Service account ID — оставить по умолчанию (сгенерится автоматически)
   - **Create and Continue** → роли можно пропустить → **Done**

4. На созданном service account кликнуть → вкладка **Keys → Add Key → Create new key → JSON**.
   - Скачается файл вида `st-michael-...-abc123.json`. **Это секрет**, не коммитить никуда.

5. Открыть JSON, найти строку `"client_email": "broker-platform-sheets-reader@xxx.iam.gserviceaccount.com"` — скопировать этот email.

6. Открыть **Google Sheets таблицу** колл-центра:
   `https://docs.google.com/spreadsheets/d/1HYiRxnRb0psYzKZmD7f34gdMgNR6gso8Swj8pj9cAC8/edit`
   - Кнопка **Share (Поделиться)** → вставить email из п. 5 → права **Viewer (Просмотр)** → снять галку «Notify people» → **Share**.

7. Отправить Сергею **содержимое JSON-файла** (любым защищённым каналом — Telegram secret chat, etc).

### Если ID таблицы другой
Если используете не эту таблицу, ID — это часть URL между `/d/` и `/edit`. Сообщите Сергею в дополнение к JSON.

---

## Шаг 2 — Положить креденшелы на сервер (делает Сергей, ~5 минут, один раз)

1. На сервере открыть `.env` в директории репозитория (`DEPLOY_PATH` из GitHub Secrets):
   ```bash
   cd /path/to/st-michael-broker-platform
   nano .env
   ```

2. Добавить строку с **минифицированным** JSON (одной строкой, в одинарных кавычках):
   ```env
   GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...","client_id":"...","auth_uri":"...","token_uri":"...","auth_provider_x509_cert_url":"...","client_x509_cert_url":"..."}'
   ```

   Чтобы превратить полученный многострочный JSON в одну строку:
   ```bash
   # положи присланный JSON в файл /tmp/sa.json и выполни:
   echo "GOOGLE_SERVICE_ACCOUNT_JSON='$(cat /tmp/sa.json | tr -d '\n')'" >> .env
   rm /tmp/sa.json
   ```

3. (Опционально) если ID таблицы НЕ совпадает с дефолтным:
   ```env
   BROKER_SHEET_ID=1HYiRxnRb0psYzKZmD7f34gdMgNR6gso8Swj8pj9cAC8
   ```

4. Применить — пересобрать api контейнер (там новая зависимость `googleapis`):
   ```bash
   docker compose up -d --build api
   ```

5. Проверить что переменная видна внутри контейнера:
   ```bash
   docker compose exec api sh -c 'echo "${GOOGLE_SERVICE_ACCOUNT_JSON:0:50}…"'
   # должно вывести начало JSON, не пусто
   ```

6. Проверить что таблица читается:
   ```bash
   docker compose exec api node /app/scripts/import-brokers-from-gsheet.js --list-tabs
   ```
   Должен вывестись список листов таблицы (например `[0] "Брокеры"`, `[1] "Координаторы"`).

   Если ошибка `The caller does not have permission` — значит шаг 1.6 (Share) не сделан или email не тот.

7. Добавить себя (Сергея) и Михаила в **GitHub Secrets** репо `sereganikitin/st-michael-broker-platform`:
   - Settings → Secrets and variables → Actions
   - Проверить что `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PORT`, `DEPLOY_PATH` уже есть (они уже используются для деплоя — должны быть).

После п. 6 настройка закончена. Михаил может жать кнопку.

---

## Шаг 3 — Запуск импорта (Михаил, любое количество раз)

1. https://github.com/sereganikitin/st-michael-broker-platform/actions
2. Слева — workflow **«Import brokers from Google Sheet»** → справа **Run workflow**.
3. Параметры по умолчанию:
   - `filter = ALL` — все категории
   - `call_flag = да` — только обзвоненных
   - `dry_run = true` — **безопасно**, ничего не пишет
4. Нажать **Run workflow** → дождаться выполнения (1-3 минуты).
5. В логах будет статистика — сколько брокеров будет создано/обновлено.
6. Если цифры ОК → запустить ещё раз, но `dry_run = false`. Это уже реальный импорт.

### ⚠️ Важно про повторные запуски

Скрипт **идемпотентен по `Broker.phone`** — повторный реальный запуск НЕ создаст дубликатов брокеров (upsert).

Но на `CallLog` уникального констрейнта НЕТ — **каждый реальный запуск добавит новые записи в историю звонков**. Это нормально для регулярной синхронизации (новые звонки операторов из Google → новые `CallLog` у нас), но НЕ запускай реальный импорт «на всякий случай» дважды подряд.

Если что-то пошло не так и нужно перезапустить — сначала удали лишние `CallLog`:
```sql
DELETE FROM call_logs WHERE created_at > '2026-05-20 00:00:00';
-- (подставь свою дату)
```

---

## Troubleshooting

**`googleapis` не найден** → пересобрать api контейнер: `docker compose up -d --build api`

**`The caller does not have permission`** → service account не расшарен на таблице. Шаг 1.6.

**`Unable to parse range`** → имя листа не совпадает с дефолтным. Запусти `--list-tabs` и передай `--main-tab "Имя"` через workflow input (нужно будет дописать input в workflow).

**Workflow висит** → проверь что нет другого деплоя в очереди (concurrency group в action `deploy.yml`).
