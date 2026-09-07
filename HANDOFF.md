# HANDOFF — что было сделано и как запустить

**Дата:** 2026-04-30
**Кто делал:** Claude Code (по ТЗ из `скриншоты и файлы для корректировки/`)
**База:** `colleague/master` @ `bfbcf56` (твои последние коммиты по amoCRM, CMS, файловому хранилищу, админке, бренд импорту)

---

## 1. Что сделано — 17 задач из ТЗ

### Большие пропуски

| № | Задача | Статус |
|---|--------|--------|
| 1 | **Push в браузере (web-push)** — VAPID, SW, контроллер, processor с авто-удалением 410/404, frontend helpers | ✅ |
| 2 | **Профиль брокера** — аватар, дата рождения, банковские/юр. реквизиты агентства, смена пароля (≥8), матрица настроек уведомлений (9 событий × 4 канала) | ✅ |
| 3 | **Подписание оферты (Раздел 8)** — модель `OfferAcceptance`, акцепт по ст. 438 ГК с фиксацией IP/UA/timestamp, HTML-документ для печати в PDF, текст в SiteContent (редактируется админом) | ✅ |
| 4 | **Слоты встреч + cron 24ч/1ч** — `MeetingSlot` модель, bulk-создание (дни × время), UI-выбор слота при записи, cron-напоминания 24h и 1h до встречи на все 4 канала | ✅ |
| 5 | **Админ-аналитика 15.6** — KPIs, динамика регистраций брокеров, фиксации (уник vs не уник), воронки (брокеров и сделок), топ-10 брокеров, статистика по проектам | ✅ |
| 6 | **Рассылки + управление встречами админом** — модель `Mailing`, сегментация (проект/агентство/уровень/этап/статус), preview, history; `/admin/meetings` с подтверждением/отменой | ✅ |
| 7 | **Лендинг расширен** — слайдер акций (`LandingPromo`, авто-смена 6с), детальные карточки проектов (адрес/класс/срок/комиссия), форма обратной связи (`ContactRequest`), попап брокер-тура с записью | ✅ |

### Telegram-бот (Раздел 9 ТЗ) — **НЕ делалось** по запросу заказчика. Telegram остаётся как канал отправки уведомлений (если есть `telegramChatId`).

### Средние

- ✅ Расширенные фильтры каталога: 7 новых флагов лотов (угловая / кладовая / 2 санузла / мастер-спальня / урбан-вилла / видовая / хайфлет 4м+)
- ✅ Раздельные шкалы комиссии на лендинге — переключатель Зорге 9 / Серебряный Бор
- ✅ Сводные KPI на странице `/deals` (всего сделок / общая сумма / комиссия / к выплате)
- ✅ Раздельное Имя / Фамилия / Отчество в форме регистрации + min длина пароля 8 символов
- ✅ Маска телефона `+7 (XXX) ***-**-XX` в списке /clients (полный — только в детали клиента)
- ✅ Бронь лота из каталога → POST `/public/cms/contact` с source=`catalog-booking`
- ✅ Breadcrumbs + единая Toast-система (через `<ToastProvider>`) + Skeleton-компоненты

### Мелкие

- ✅ Мобильная нижняя навигация (`<BottomNav>` — 5 пунктов на ≤lg)
- ✅ Баннер «фиксация истекает через N дней» в `/clients` (alert сверху + per-row warning)
- ✅ 4 информационные карточки условий на странице `/commission`

---

## 2. ⚠️ ВАЖНО — что нужно сделать вручную перед запуском

### Шаг 1. Установить новые зависимости в API

```bash
cd apps/api
npm install
```

Что добавлено:
- `web-push` (^3.6.7) — отправка push-уведомлений через VAPID
- `@types/web-push` (dev)

### Шаг 2. Сгенерировать VAPID-ключи (один раз)

```bash
node scripts/generate-vapid.js
```

Скопируй вывод в корневой `.env`:
```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:broker@stmichael.ru
```

### Шаг 3. Применить новую схему БД

```bash
cd packages/database
npm run db:push
```

> Используется `prisma db push` (без миграций), как в текущем проекте. Применит всё разом.

**Что добавлено в БД (~10 новых таблиц/полей):**

| Таблица / Поле | Назначение |
|----------------|------------|
| `push_subscriptions` | Подписки браузеров на push (Task #1) |
| `notification_preferences` | Матрица «событие × канал × включено» (Task #2) |
| `Broker.avatarUrl`, `Broker.birthDate` | Расширение профиля (Task #2) |
| `Agency.legalAddress, bankName, bankBik, bankAccount, correspondentAccount` | Юр. реквизиты (Task #2) |
| `offer_acceptances` | Акцепты оферты с версией (Task #3) |
| `meeting_slots` + `Meeting.slotId, reminded24h, reminded1h` | Слоты и cron (Task #4) |
| `mailings` | История рассылок (Task #6) |
| `landing_promos` | Слайдер акций (Task #7) |
| `contact_requests` | Заявки с лендинга / каталога (Task #7) |
| `LandingProject` — много новых полей | Детальные карточки проектов (Task #7) |
| `Lot` — 7 новых boolean | Расширенные фильтры (Task #8) |
| Enum `NotificationChannel.PUSH` | Push-канал (Task #1) |

### Шаг 4. Пересобрать фронт и перезапустить

```bash
cd apps/web && npm run build
# затем рестарт ваших процессов API + Web (pm2 / docker / etc.)
```

---

## 3. ⚠️ Известные ограничения

### Push требует HTTPS
Web Push API не работает без TLS. На текущем деплое `https://72.56.241.199` сертификат IP-адресу не выдадут (Let's Encrypt не выдаёт на IP, самоподписанный браузер блокирует).

**Решение:** купить домен (или использовать поддомен), настроить Let's Encrypt в nginx. Без HTTPS UI-кнопка «Включить push» в профиле покажет сообщение "Push доступен только по HTTPS или на localhost".

### ЭДО для оферты — не полная интеграция
Реализован акцепт-чекбокс с фиксацией IP/UA/timestamp/version. Это юридически корректный акцепт публичной оферты по ст. 438 ГК РФ. Полноценная интеграция с DocuSign / СБИС / Контур.Диадок — будущий этап (вне MVP).

### Telegram-бот
Канал TELEGRAM в notification.processor работает: если у брокера в БД есть `telegramChatId` и в `.env` задан `TELEGRAM_BOT_TOKEN`, уведомления уходят в Telegram. Но **бот, который ловит /start от пользователя и сохраняет chatId, не реализован** (по запросу заказчика). Привязку chatId сейчас можно делать только вручную через API/SQL.

### GitHub-токен в `git remote -v`
`origin` URL содержит embedded GitHub PAT (`ghp_...`). Это утечка — рекомендую отозвать на https://github.com/settings/tokens и заменить URL на чистый:
```bash
git remote set-url origin https://github.com/mefremov888-ai/st-michael-broker-platform.git
```

---

## 4. Структура изменений — где что искать

### Новые модули API

```
apps/api/src/
├── notification/
│   ├── notification.controller.ts        ← НОВЫЙ (push subscribe, preferences)
│   ├── notification.processor.ts          ← расширен (PUSH-ветка, eventType-фильтр)
│   └── notification.service.ts            ← добавлен eventType
├── offer/                                 ← НОВЫЙ модуль (Task #3)
│   ├── offer.controller.ts
│   ├── offer.module.ts
│   └── offer.service.ts
├── auth/auth.{controller,service}.ts      ← change-password, avatar, расширенный PATCH /me
├── meetings/meetings.{controller,service}.ts ← slots CRUD + getAvailableSlots
├── admin/admin.{controller,service}.ts    ← mailings + meeting management
├── analytics/analytics.{controller,service}.ts ← getAdminOverview
├── catalog/catalog.service.ts             ← 7 новых feature-флагов в фильтрах
├── cms/cms.{public,admin,service}.ts      ← promos, contact-requests, project details
└── scheduler/scheduler.service.ts         ← cron meeting reminders 24h/1h
```

### Новые страницы/компоненты Web

```
apps/web/
├── public/
│   └── sw.js                              ← НОВЫЙ — service worker для push
├── src/
│   ├── app/(cabinet)/
│   │   ├── admin/
│   │   │   ├── analytics/page.tsx          ← НОВАЯ (Task #5)
│   │   │   ├── mailings/page.tsx           ← НОВАЯ (Task #6)
│   │   │   ├── meetings/page.tsx           ← НОВАЯ (Task #6)
│   │   │   └── meeting-slots/page.tsx      ← НОВАЯ (Task #4)
│   │   ├── documents/offer/page.tsx        ← НОВАЯ (Task #3)
│   │   ├── profile/page.tsx                ← переписана с 0 (Task #2)
│   │   ├── meetings/page.tsx               ← +slot picker
│   │   ├── catalog/page.tsx                ← +7 фильтров, +бронь
│   │   ├── clients/page.tsx                ← +маска тел., +баннер
│   │   ├── deals/page.tsx                  ← +KPI-сводка
│   │   ├── commission/page.tsx             ← +карточки условий
│   │   ├── documents/page.tsx              ← +баннер оферты
│   │   └── layout.tsx                      ← +Breadcrumbs +BottomNav
│   ├── app/page.tsx                        ← лендинг: слайдер акций, форма, попап брокер-тур, раздельные шкалы, ФИО split
│   ├── app/providers.tsx                   ← +ToastProvider
│   ├── components/
│   │   ├── BottomNav.tsx                   ← НОВЫЙ (Task #15)
│   │   ├── Breadcrumbs.tsx                 ← НОВЫЙ (Task #14)
│   │   ├── Skeleton.tsx                    ← НОВЫЙ (Task #14)
│   │   ├── Toast.tsx                       ← НОВЫЙ (Task #14)
│   │   ├── Sidebar.tsx                     ← +ссылки на новые разделы
│   │   └── TopBar.tsx                      ← +аватар
│   └── lib/
│       ├── push.ts                         ← НОВЫЙ — subscribe/unsubscribe helpers
│       └── auth.tsx                        ← +avatarUrl/birthDate в Broker
```

### Схема БД

`packages/database/prisma/schema.prisma` — все новые модели и поля. Prisma при `db:push` автоматически создаст таблицы.

### Скрипты

`scripts/generate-vapid.js` — одноразовая генерация ключей VAPID для web-push.

---

## 5. Новые API-эндпоинты (для тестирования через Swagger `/docs`)

### Push (Task #1)
- `GET  /api/notifications/push/vapid-key` — public, отдаёт публичный ключ
- `POST /api/notifications/push/subscribe` — auth, сохраняет endpoint+keys
- `DELETE /api/notifications/push/unsubscribe?endpoint=...` — auth
- `GET  /api/notifications/push/status` — auth

### Настройки уведомлений (Task #2)
- `GET  /api/notifications/preferences` — auth, матрица 9×4 + дефолты
- `PUT  /api/notifications/preferences` — auth, bulk upsert

### Профиль (Task #2)
- `POST /api/auth/change-password` — auth, требует текущий пароль
- `POST /api/auth/avatar` — auth, multipart, ≤5MB, image/*
- `PATCH /api/auth/me` — расширен полями `birthDate` и `agency.{legalAddress,bankName,bankBik,bankAccount,correspondentAccount}`

### Оферта (Task #3)
- `GET  /api/offer/current` — public
- `GET  /api/offer/my` — auth, статус акцепта
- `POST /api/offer/accept` — auth
- `GET  /api/offer/my/document` — auth, HTML для печати в PDF
- `POST /api/offer/admin/update` — ADMIN, обновляет текст+версию

### Слоты встреч (Task #4)
- `GET  /api/meetings/slots/available?date=YYYY-MM-DD&type=...` — auth, доступные слоты
- `GET  /api/meetings/slots` — admin/manager, все
- `POST /api/meetings/slots` — admin/manager, single или bulk
- `PATCH /api/meetings/slots/:id` — admin/manager
- `DELETE /api/meetings/slots/:id` — admin/manager

### Аналитика (Task #5)
- `GET  /api/analytics/admin/overview?startDate=&endDate=` — admin/manager

### Рассылки + админ-встречи (Task #6)
- `POST /api/admin/mailings/preview` — admin/manager, считает получателей
- `POST /api/admin/mailings/send` — admin/manager, очереди в notification queue
- `GET  /api/admin/mailings` — admin/manager, история
- `GET  /api/admin/meetings` — admin/manager, все встречи
- `PATCH /api/admin/meetings/:id/status` — admin/manager, confirm/cancel

### Лендинг (Task #7)
- `GET  /api/public/cms/promos` — public
- `GET  /api/public/cms/projects/:slug` — public, детали проекта
- `POST /api/public/cms/contact` — public, форма обратной связи
- `POST /api/admin/cms/promos` + CRUD — admin
- `GET  /api/admin/cms/contact-requests` — admin/manager, заявки

---

## 6. Бэкапы — на случай отката

В origin запушены ветки и теги:
- `backup/pre-colleague-merge-2026-04-30` — состояние до подтягивания твоего bfbcf56 (master коммит `4260413`)
- `backup/colleague-master-2026-04-30` — твоё чистое состояние `bfbcf56`

Откат при необходимости:
```bash
# Полный откат к моменту до моих правок
git fetch origin
git reset --hard origin/backup/colleague-master-2026-04-30

# Или к самому первому состоянию (до мерджа)
git reset --hard origin/backup/pre-colleague-merge-2026-04-30
```

---

## 7. Что осталось не покрыто (для будущих итераций)

- **Telegram-бот** (Раздел 9 ТЗ) — пропущен по запросу
- **UI-страница для управления промо-акциями** (`/admin/promos`) — модель и API готовы, страница не сделана. Сейчас управляется через API напрямую. Можно скопировать `/admin/events/page.tsx` как шаблон.
- **UI-редактор оферты в админке** — API `POST /offer/admin/update` готов, страница нет
- **UI-страница просмотра контакт-заявок** — API `GET /admin/cms/contact-requests` готов, страница нет
- **Полноценный ЭДО** для оферты (DocuSign / СБИС / Контур.Диадок) — pre-MVP вариант (акцепт по ст. 438 ГК) реализован
- **VAPID + HTTPS** — нужен домен с TLS, чтобы push заработал в браузере

---

## 8. Тестовый чек-лист — что проверить после запуска

- [ ] API стартует без ошибок (`npm run start:dev` в `apps/api/`)
- [ ] `prisma db push` прошёл без warnings
- [ ] Регистрация нового брокера (раздельное ФИО, пароль ≥8) — успешно
- [ ] Профиль: загрузка аватара, дата рождения, банк-реквизиты, смена пароля
- [ ] Профиль → Уведомления: матрица сохраняется (PUT /notifications/preferences)
- [ ] Профиль → "Включить push" работает (требует HTTPS / localhost)
- [ ] /documents/offer → checkbox + "Принять" → статус в баннере
- [ ] /admin/meeting-slots → bulk создание слотов
- [ ] /meetings → выбор слота из календаря
- [ ] Cron `*/15 * * * *` (meeting reminders) — проверить логи через 15 минут
- [ ] /admin/analytics → отображаются графики
- [ ] /admin/mailings → preview + отправка (получатель видит уведомление в /api/notifications или Notification.list)
- [ ] /admin/meetings → confirm/cancel меняет статус и отправляет уведомление
- [ ] Лендинг: слайдер акций крутится (если `LandingPromo.create()` есть данные)
- [ ] Лендинг: «Записаться на брокер-тур» → попап → форма → запись в `contact_requests`
- [ ] Лендинг: переключатель Зорге 9 / Серебряный Бор в комиссии
- [ ] /catalog → 7 новых фильтров (Балкон / Терраса / Угловая / Кладовая / 2 санузла / Мастер / Урбан / Видовая / Хайфлет)
- [ ] /catalog → "Забронировать" отправляет в `contact_requests` с source=`catalog-booking`
- [ ] /clients → телефоны замаскированы, баннер при истечении фиксации
- [ ] /deals → 4 KPI-карточки сверху (всего сделок / сумма / комиссия / к выплате)
- [ ] /commission → 4 карточки условий + переключатель проектов
- [ ] Mobile (≤768px): нижняя навигация (BottomNav) видна, sidebar — burger
- [ ] Breadcrumbs показываются на всех страницах кабинета

---

## 9. Контакты

Если возникнут вопросы — пиши в чате с заказчиком, ссылайся на этот файл и номер задачи.

Файл скриншотов и ТЗ для справки: `скриншоты и файлы для корректировки/`
- `tz_stmichael_брокер_v3.docx` — ТЗ кабинета
- `tz_stmichael_посадка брокерская.docx` — ТЗ лендинга
- `broker_landing_light.html`, `broker_cabinet_preview (1).html` — макеты
- `broker_структура.png`, `tg_image_*.png` — структура и скриншоты дизайна
