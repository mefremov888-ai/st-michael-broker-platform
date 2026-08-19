# Telegram-мониторинг кабинета брокера

Для технических алертов не нужен постоянно запущенный Telegram-бот. API и
внешний GitHub Actions monitor отправляют сообщения напрямую через Telegram
Bot API. Рекомендуется отдельный send-only бот и закрытая группа, не общий бот
брокеров.

`@BotFather` не получает алерты. Он только создаёт бота и выдаёт/отзывает его
token. Сами сообщения отправляет созданный бот в закрытую рабочую группу.

## Если token попал в чат, письмо или тикет

Такой token больше нельзя использовать, даже если сообщение потом удалить:

1. Открыть в Telegram проверенный аккаунт `@BotFather` с синей галочкой.
2. Отправить `/mybots` → выбрать нужного бота → `API Token` →
   `Revoke current token`.
3. Получить новый token. Не копировать его в переписку, задачу, скриншот или
   командную строку.
4. Обновить secret, в котором жил старый token. Если один бот использовался и
   как `TELEGRAM_BOT_TOKEN`, и как `OPS_TELEGRAM_BOT_TOKEN`, обновить оба.
5. После теста убедиться, что запрос со старым token больше не принимается.

## 1. Создать отдельного ops-бота и чат

1. В `@BotFather` нажать `START` или отправить `/newbot`.
2. Задать отображаемое имя, например `ST Michael Ops`.
3. Задать username, заканчивающийся на `bot`, например
   `st_michael_ops_bot`.
4. Сохранить token сразу в password manager. В репозиторий его не добавлять.
5. В Telegram выбрать `Новое сообщение` → `Создать группу`, назвать её,
   например, `ST Michael — техалерты`, и сделать закрытой.
6. Добавить созданного бота в группу. Права администратора для обычной
   отправки сообщений не нужны; достаточно разрешения писать сообщения.
7. В группе отправить `/start@username_бота`, чтобы update гарантированно
   попал боту даже при включённом Privacy Mode.
8. Получить отрицательный `chat.id` из `getUpdates`. Команда ниже спрашивает
   token скрыто, не сохраняет его в истории PowerShell и печатает только ID:

   ```powershell
   $secureToken = Read-Host "Новый Telegram bot token" -AsSecureString
   $tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
   try {
     $opsBotToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
     $updates = Invoke-RestMethod -Uri "https://api.telegram.org/bot$opsBotToken/getUpdates"
     $chatId = $updates.result |
       ForEach-Object { $_.message.chat.id } |
       Where-Object { $_ } |
       Select-Object -Last 1
     "OPS_ALERT_CHAT_ID=$chatId"
   } finally {
     if ($tokenPtr -ne [IntPtr]::Zero) {
       [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
     }
     Remove-Variable opsBotToken,secureToken,updates -ErrorAction SilentlyContinue
   }
   ```

   Для группы значение обычно выглядит как `-1001234567890`. Если результат
   пустой, ещё раз отправить команду в группе и повторить запрос. Если бот уже
   использует webhook или long polling, `getUpdates` конфликтует с ним — для
   ops-мониторинга поэтому предпочтителен отдельный send-only бот.

Официальная документация: [создание бота](https://core.telegram.org/bots/features#botfather),
[Bot API / getUpdates](https://core.telegram.org/bots/api#getupdates).

## 2. Добавить GitHub Actions secrets

Открыть канонический production-репозиторий
`sereganikitin/st-michael-broker-platform`, затем:

1. `Settings` → `Secrets and variables` → `Actions`.
2. Нажать `New repository secret`.
3. Создать `OPS_TELEGRAM_BOT_TOKEN` и вставить новый token.
4. Ещё раз нажать `New repository secret`.
5. Создать `OPS_ALERT_CHAT_ID` и вставить отрицательный ID группы.

Обязательные secrets:

- `OPS_TELEGRAM_BOT_TOKEN` — token нового бота;
- `OPS_ALERT_CHAT_ID` — отрицательный ID закрытой группы.

Если алерты нужны в нескольких чатах, вместо одиночного значения можно задать
secret `OPS_ALERT_CHAT_IDS` со списком ID через запятую. App-level отправка
пойдёт во все чаты; внешний monitor использует основной `OPS_ALERT_CHAT_ID`.

Через GitHub CLI те же secrets можно задать интерактивно, не помещая значения
в командную строку:

```text
gh auth login -h github.com
gh secret set OPS_TELEGRAM_BOT_TOKEN --repo sereganikitin/st-michael-broker-platform
gh secret set OPS_ALERT_CHAT_ID --repo sereganikitin/st-michael-broker-platform
```

После merge в `master` deploy workflow сохранит secrets в серверный `.env`, а
Docker Compose явно передаст их API-контейнеру. После изменения env контейнер
нужно пересоздать через обычный deploy (`docker compose up -d`), одного
`docker compose restart` недостаточно.

## 3. Проверить настройку

После merge обновлённого workflow в `master`:

1. В GitHub открыть `Actions`.
2. Слева выбрать `Monitor broker cabinet health`.
3. Нажать `Run workflow`.
4. Выбрать ветку `master`.
5. Включить `Send a Telegram test message`.
6. Нажать зелёную кнопку `Run workflow`.
7. Дождаться зелёного результата двух jobs. В группе должно появиться
   сообщение `🧪 PROD: тест Telegram-мониторинга КБ прошёл`.

Если workflow красный, открыть упавший step. GitHub не показывает значение
secret, поэтому безопасно проверять только наличие secret, chat ID, членство
бота в группе и право писать сообщения.

Затем проверить, что публичный endpoint отвечает HTTP 200:

```text
https://broker.stmichael.ru/api/health/ready
```

Ответ `status=ok` означает, что доступны API, PostgreSQL и Redis. Endpoint не
отдаёт адреса подключений, тексты внутренних ошибок или secrets.

## Что отслеживается

- публичная доступность КБ и readiness API каждые 10 минут;
- PostgreSQL, Redis и контейнеры `api`, `web`, `nginx`;
- заполнение диска от 85%;
- фиксации `FAILED/PENDING`, зависшие более 10 минут;
- очередь от 10 фиксаций и заявки, исчерпавшие 10 auto-retry;
- технический HTTP 5xx при попытке брокера выполнить фиксацию;
- недоступность/авторизация amoCRM и SMTP;
- отказ Morekit принять уже созданную в amoCRM фиксацию;
- успешная доставка самого Telegram-сообщения.

Бизнес-ответы `UNDER_REVIEW`, `REJECTED`, ошибки заполнения формы и другие 4xx
не считаются поломкой. В алерты не попадают ФИО, полные телефоны, email, ИНН,
токены или сырой ответ интеграции — только внутренние ID и категория ошибки.

Одинаковые host-level инциденты отправляются при изменении состояния, затем не
чаще раза в час; после восстановления приходит зелёное сообщение. Публичное
падение с недоступным SSH повторяется каждым запуском monitor workflow, потому
что в этом случае хранить cooldown на production-сервере невозможно.

## Быстрая диагностика

| Симптом | Что проверить |
|---|---|
| `401 Unauthorized` | token отозван или secret содержит старое значение |
| `400 chat not found` | неверный `OPS_ALERT_CHAT_ID` или бот не добавлен в группу |
| `403 bot was blocked/kicked` | вернуть бота в группу и разрешить сообщения |
| `getUpdates` возвращает пусто | отправить `/start@username` и повторить; проверить, что это отдельный бот без webhook/long polling |
| Тест из GitHub проходит, а API-алертов нет | проверить deploy/recreate API и наличие `OPS_*` внутри контейнера только как boolean, не печатая значения |
| В группе слишком много сообщений | не удалять state-файл `.ops-monitor-state`; проверить cooldown и смену incident key |
