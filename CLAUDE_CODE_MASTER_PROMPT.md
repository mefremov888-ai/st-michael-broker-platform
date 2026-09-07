# CLAUDE CODE — MASTER PROMPT
## ST MICHAEL Broker Platform | Зорге 9

> Этот файл — единая точка входа для Claude Code. Прочитай полностью перед началом работы.
> Цель: поднять production-ready monorepo с нуля за одну сессию.

---

## 1. ЧТО СТРОИМ

Единая цифровая платформа управления брокерским каналом девелопера ST MICHAEL (Москва).
Два проекта в портфеле: **Зорге 9** (приоритет) и **Квартал Серебряный Бор**.

Три точки входа для брокера:
1. **Web-кабинет** — личный кабинет брокера (Next.js)
2. **Telegram-бот** — зеркало кабинета (grammY)
3. **AI-агент** — голосовой обзвон брокеров (будущий этап, но API закладываем сейчас)

---

## 2. АРХИТЕКТУРА

```
Тип: Modular Monolith (NestJS)
Причина: команда 1-3 разработчика, быстрый MVP, модули легко вынести в микросервисы

st-michael-broker-platform/
├── apps/
│   ├── web/                    # Next.js 14 App Router + TypeScript + Tailwind
│   ├── api/                    # NestJS 10 + TypeScript
│   └── telegram/               # grammY + TypeScript
├── packages/
│   ├── shared/                 # Общие типы, enum'ы, валидация (zod), утилиты
│   ├── database/               # Prisma schema + миграции + seed
│   └── integrations/           # Адаптеры: amoCRM, Mango, Profitbase, WhatsApp
├── docker/
│   ├── docker-compose.yml      # PostgreSQL 16, Redis 7, API, Web, TG-бот
│   ├── docker-compose.dev.yml  # Dev overrides (hot reload)
│   ├── Dockerfile.api
│   ├── Dockerfile.web
│   └── Dockerfile.telegram
├── .env.example
├── turbo.json
├── package.json
├── tsconfig.base.json
└── README.md
```

---

## 3. TECH STACK

| Слой | Технология | Версия |
|------|-----------|--------|
| Monorepo | Turborepo | latest |
| Frontend | Next.js (App Router) | 14.x |
| CSS | Tailwind CSS | 3.x |
| Backend | NestJS | 10.x |
| ORM | Prisma | 5.x |
| БД | PostgreSQL | 16 |
| Кэш / Очереди | Redis 7 + BullMQ | latest |
| TG-бот | grammY | latest |
| Валидация | zod (shared) + class-validator (NestJS) | latest |
| Auth | JWT (access + refresh) + SMS OTP | — |
| Хранилище | Yandex Object Storage (S3-compatible) | — |
| Runtime | Node.js | 20 LTS |

---

## 4. ENV-ПЕРЕМЕННЫЕ

Создай `.env.example` с этими переменными:

```env
# === Database ===
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/broker_platform
REDIS_URL=redis://localhost:6379

# === Auth ===
JWT_SECRET=change-me-in-production
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
SMS_PROVIDER_API_KEY=

# === amoCRM ===
AMO_SUBDOMAIN=stmichael
AMO_CLIENT_ID=
AMO_CLIENT_SECRET=
AMO_REDIRECT_URI=
AMO_ACCESS_TOKEN=
AMO_REFRESH_TOKEN=

# === Telephony ===
MANGO_API_KEY=
MANGO_API_SALT=
CALLTOUCH_TOKEN=
CALLTOUCH_SITE_ID=

# === Profitbase ===
PROFITBASE_API_KEY=
PROFITBASE_BASE_URL=

# === Messaging ===
TELEGRAM_BOT_TOKEN=
WHATSAPP_TOKEN=
WHATSAPP_PHONE_ID=

# === Storage ===
S3_ENDPOINT=https://storage.yandexcloud.net
S3_BUCKET=st-michael-media
S3_ACCESS_KEY=
S3_SECRET_KEY=

# === AI (будущий этап) ===
LLM_API_KEY=
LLM_MODEL=

# === App ===
API_PORT=4000
WEB_URL=http://localhost:3000
API_URL=http://localhost:4000
```

---

## 5. PRISMA SCHEMA

Файл: `packages/database/prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─── ENUMS ───────────────────────────────────────────

enum UserRole {
  BROKER
  MANAGER
  ADMIN
}

enum UserStatus {
  ACTIVE
  BLOCKED
  PENDING
}

enum CommissionLevel {
  START
  BASIC
  STRONG
  PREMIUM
  ELITE
  CHAMPION
  LEGEND
}

enum Project {
  ZORGE9
  SILVER_BOR
}

enum UniquenessStatus {
  CONDITIONALLY_UNIQUE
  REJECTED
  UNDER_REVIEW        // Спорная ситуация — ручное решение менеджера
  EXPIRED
}

// Этапы воронки брокеров в amoCRM
enum BrokerFunnelStage {
  NEW_BROKER
  BROKER_TOUR
  FIXATION
  MEETING
  DEAL
}

// Источник появления брокера
enum BrokerSource {
  CRM_MANUAL          // Внесён менеджером вручную
  BROKER_CABINET      // Зарегистрировался через кабинет
  PHONE_CALL          // Позвонил на линию
  CLOSED_AS_BROKER    // Закрыт как брокер (с причиной)
}

enum FixationStatus {
  NOT_FIXED
  FIXED
  EXPIRED
  ANNULLED
}

enum ClientStatus {
  NEW
  BOOKED
  DEAL
  CANCELLED
}

enum ContractType {
  DDU
  DKP
  PDKP
}

enum DealStatus {
  PENDING
  SIGNED
  PAID
  COMMISSION_PAID
  CANCELLED
}

enum LotStatus {
  AVAILABLE
  BOOKED
  SOLD
}

enum CallDirection {
  OUTBOUND
  INBOUND
}

enum CallStatus {
  COMPLETED
  NO_ANSWER
  BUSY
  UNAVAILABLE
  FAILED
}

enum CallResult {
  INTERESTED
  NOT_INTERESTED
  CALLBACK
  MEETING_SCHEDULED
}

enum Sentiment {
  POSITIVE
  NEUTRAL
  NEGATIVE
}

enum MeetingType {
  OFFICE_VISIT
  ONLINE
  BROKER_TOUR
}

enum MeetingStatus {
  PENDING
  CONFIRMED
  COMPLETED
  CANCELLED
}

enum NotificationChannel {
  SMS
  WHATSAPP
  TELEGRAM
  EMAIL
}

enum NotificationStatus {
  PENDING
  SENT
  DELIVERED
  FAILED
}

// ─── MODELS ──────────────────────────────────────────

model Agency {
  id               String            @id @default(uuid())
  name             String
  legalName        String?           @map("legal_name")
  inn              String            @unique   // ОБЯЗАТЕЛЬНОЕ — ключ дедупликации и связи с кабинетом
  phone            String?
  email            String?
  address          String?
  totalSqmSold     Decimal           @default(0) @map("total_sqm_sold") @db.Decimal(10, 2)
  commissionLevel  CommissionLevel   @default(START) @map("commission_level")
  quarterlyBonusStreak Int           @default(0) @map("quarterly_bonus_streak")
  brokerAgencies   BrokerAgency[]
  deals            Deal[]
  createdAt        DateTime          @default(now()) @map("created_at")
  updatedAt        DateTime          @updatedAt @map("updated_at")

  @@map("agencies")
}

// M2M: Брокер ↔ Компании (неограниченное кол-во, не удаляются)
model BrokerAgency {
  id         String   @id @default(uuid())
  brokerId   String   @map("broker_id")
  broker     Broker   @relation(fields: [brokerId], references: [id])
  agencyId   String   @map("agency_id")
  agency     Agency   @relation(fields: [agencyId], references: [id])
  isPrimary  Boolean  @default(false) @map("is_primary")  // Основная компания
  joinedAt   DateTime @default(now()) @map("joined_at")

  @@unique([brokerId, agencyId])  // Без повторов
  @@map("broker_agencies")
}

model Broker {
  id                   String             @id @default(uuid())
  amoContactId         BigInt?            @unique @map("amo_contact_id")
  fullName             String             @map("full_name")
  phone                String             @unique
  email                String?
  passwordHash         String?            @map("password_hash")
  role                 UserRole           @default(BROKER)
  status               UserStatus         @default(PENDING)
  funnelStage          BrokerFunnelStage  @default(NEW_BROKER) @map("funnel_stage")
  source               BrokerSource?      // Откуда пришёл брокер
  closureReason        String?            @map("closure_reason") // Причина закрытия (если закрыт)
  brokerAgencies       BrokerAgency[]     // M2M — список компаний (не удаляются)
  telegramChatId       BigInt?            @unique @map("telegram_chat_id")
  brokerTourVisited    Boolean            @default(false) @map("broker_tour_visited")
  brokerTourDate       DateTime?          @map("broker_tour_date")
  doNotCall            Boolean            @default(false) @map("do_not_call")
  bestCallTime         String?            @map("best_call_time")
  clients              Client[]
  deals                Deal[]
  calls                Call[]
  meetings             Meeting[]
  notifications        Notification[]
  createdAt            DateTime           @default(now()) @map("created_at")
  updatedAt            DateTime           @updatedAt @map("updated_at")

  @@map("brokers")
}

model Client {
  id                  String           @id @default(uuid())
  brokerId            String           @map("broker_id")
  broker              Broker           @relation(fields: [brokerId], references: [id])
  amoLeadId           BigInt?          @map("amo_lead_id")
  fullName            String           @map("full_name")
  phone               String
  email               String?
  comment             String?
  project             Project          @default(ZORGE9)
  fixationAgencyId    String?          @map("fixation_agency_id") // Компания, от которой подана заявка
  uniquenessStatus    UniquenessStatus @default(CONDITIONALLY_UNIQUE) @map("uniqueness_status")
  uniquenessReason    String?          @map("uniqueness_reason")  // Пояснение (напр. «переоткрыта сделка»)
  uniquenessExpiresAt DateTime?        @map("uniqueness_expires_at")
  fixationStatus      FixationStatus   @default(NOT_FIXED) @map("fixation_status")
  fixationExpiresAt   DateTime?        @map("fixation_expires_at")
  inspectionActSigned Boolean          @default(false) @map("inspection_act_signed")
  status              ClientStatus     @default(NEW)
  deals               Deal[]
  meetings            Meeting[]
  createdAt           DateTime         @default(now()) @map("created_at")
  updatedAt           DateTime         @updatedAt @map("updated_at")

  @@index([phone])
  @@index([brokerId])
  @@map("clients")
}

model Lot {
  id           String    @id @default(uuid())
  externalId   String?   @unique @map("external_id")
  number       String
  project      Project   @default(ZORGE9)
  building     String
  floor        Int
  rooms        String
  sqm          Decimal   @db.Decimal(10, 2)
  price        Decimal   @db.Decimal(14, 2)
  pricePerSqm  Decimal?  @map("price_per_sqm") @db.Decimal(10, 2)
  status       LotStatus @default(AVAILABLE)
  layoutUrl    String?   @map("layout_url")
  planImageUrl String?   @map("plan_image_url")
  description  String?
  deals        Deal[]
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  @@index([project, status])
  @@map("lots")
}

model Deal {
  id               String       @id @default(uuid())
  clientId         String       @map("client_id")
  client           Client       @relation(fields: [clientId], references: [id])
  brokerId         String       @map("broker_id")
  broker           Broker       @relation(fields: [brokerId], references: [id])
  agencyId         String?      @map("agency_id")  // Компания, от которой сделка (привязка на ДВОУ)
  agency           Agency?      @relation(fields: [agencyId], references: [id])
  lotId            String?      @map("lot_id")
  lot              Lot?         @relation(fields: [lotId], references: [id])
  amoDealId        BigInt?      @map("amo_deal_id")
  project          Project      @default(ZORGE9)
  contractType     ContractType? @map("contract_type")
  amount           Decimal      @db.Decimal(14, 2)
  sqm              Decimal      @db.Decimal(10, 2)
  commissionRate   Decimal      @map("commission_rate") @db.Decimal(5, 2)
  commissionAmount Decimal      @map("commission_amount") @db.Decimal(14, 2)
  paymentReceived  Boolean      @default(false) @map("payment_received")
  paymentPercent   Decimal      @default(0) @map("payment_percent") @db.Decimal(5, 2)
  isInstallment    Boolean      @default(false) @map("is_installment")
  status           DealStatus   @default(PENDING)
  signedAt         DateTime?    @map("signed_at")
  paidAt           DateTime?    @map("paid_at")
  createdAt        DateTime     @default(now()) @map("created_at")
  updatedAt        DateTime     @updatedAt @map("updated_at")

  @@index([brokerId])
  @@index([clientId])
  @@index([agencyId])
  @@map("deals")
}

model Call {
  id            String        @id @default(uuid())
  brokerId      String        @map("broker_id")
  broker        Broker        @relation(fields: [brokerId], references: [id])
  mangoCallId   String?       @map("mango_call_id")
  direction     CallDirection @default(OUTBOUND)
  status        CallStatus    @default(COMPLETED)
  result        CallResult?
  durationSec   Int?          @map("duration_sec")
  transcript    String?
  sentiment     Sentiment?
  recordingUrl  String?       @map("recording_url")
  attemptNumber Int           @default(1) @map("attempt_number")
  cycleDay      Int           @default(1) @map("cycle_day")
  materialsSent Json?         @map("materials_sent")
  createdAt     DateTime      @default(now()) @map("created_at")

  @@index([brokerId, createdAt])
  @@map("calls")
}

model Meeting {
  id         String        @id @default(uuid())
  clientId   String        @map("client_id")
  client     Client        @relation(fields: [clientId], references: [id])
  brokerId   String        @map("broker_id")
  broker     Broker        @relation(fields: [brokerId], references: [id])
  managerId  String?       @map("manager_id")
  type       MeetingType
  date       DateTime
  comment    String?
  status     MeetingStatus @default(PENDING)
  actSigned  Boolean       @default(false) @map("act_signed")
  createdAt  DateTime      @default(now()) @map("created_at")
  updatedAt  DateTime      @updatedAt @map("updated_at")

  @@index([brokerId, date])
  @@map("meetings")
}

model Document {
  id        String   @id @default(uuid())
  name      String
  type      String
  category  String
  project   Project?
  fileUrl   String   @map("file_url")
  fileSize  Int?     @map("file_size")
  createdAt DateTime @default(now()) @map("created_at")

  @@map("documents")
}

model Notification {
  id        String              @id @default(uuid())
  brokerId  String              @map("broker_id")
  broker    Broker              @relation(fields: [brokerId], references: [id])
  channel   NotificationChannel
  subject   String?
  body      String
  status    NotificationStatus  @default(PENDING)
  sentAt    DateTime?           @map("sent_at")
  createdAt DateTime            @default(now()) @map("created_at")

  @@index([brokerId, createdAt])
  @@map("notifications")
}

model AuditLog {
  id        String   @id @default(uuid())
  userId    String?  @map("user_id")
  action    String
  entity    String
  entityId  String?  @map("entity_id")
  payload   Json?
  ip        String?
  createdAt DateTime @default(now()) @map("created_at")

  @@index([entity, entityId])
  @@index([userId, createdAt])
  @@map("audit_logs")
}
```

---

## 6. NestJS MODULES (apps/api)

Создай следующие NestJS модули. Каждый модуль — отдельная папка с `module.ts`, `controller.ts`, `service.ts`, DTO (через zod + `@anatine/zod-nestjs` или class-validator).

### 6.1 AuthModule
- POST `/auth/register` — регистрация брокера (phone + SMS OTP)
- POST `/auth/login` — вход по phone + OTP
- POST `/auth/refresh` — обновление JWT
- GET `/auth/me` — текущий пользователь
- Guards: `JwtAuthGuard`, `RolesGuard` (decorator `@Roles('BROKER', 'MANAGER', 'ADMIN')`)

### 6.2 ClientFixationModule (КЛЮЧЕВОЙ — по ТЗ amoCRM v1.4)

**POST `/clients/fix`** — фиксация клиента (проверка уникальности)
- Валидация: phone (required), fullName (required), comment, project, agencyInn (required)
- Поиск компании по ИНН → если нет, создать в БД и amoCRM
- Сохранение fixationAgencyId на клиенте

**АЛГОРИТМ ПРОВЕРКИ УНИКАЛЬНОСТИ (4 сценария):**

```
1. Телефон НЕ найден в CRM
   → Статус: CONDITIONALLY_UNIQUE
   → Действие: создать контакт, зафиксировать брокера и агентство
   → uniquenessExpiresAt = now + 30 days

2. Телефон найден, статус сделки: «Закрыто и не реализовано»
   → Статус: CONDITIONALLY_UNIQUE
   → Действие: ПЕРЕОТКРЫТЬ сделку, зафиксировать нового брокера
   → uniquenessReason = "Переоткрыта закрытая сделка"

3. Телефон найден, статус сделки: «Квалификация / выводим на встречу»
   → Статус: CONDITIONALLY_UNIQUE
   → Действие: зафиксировать брокера
   → УВЕДОМИТЬ менеджера о наличии другого брокера (тип: BROKER_CONFLICT)
   → uniquenessReason = "Клиент на квалификации у другого брокера"

4. Телефон найден, ЛЮБОЙ другой активный статус
   (Встреча назначена / Встреча проведена / Устная бронь / ДВОУ / Сделка)
   → Статус: REJECTED или UNDER_REVIEW
   → Действие: уведомить менеджера для ручного решения
   → Ответ в кабинет брокера: уведомление с пояснением
```

**Важно**: компания НЕ привязывается к клиенту на этапе фиксации. Привязка происходит автоматически на этапе ДВОУ (платная бронь) — см. DealsModule.

- GET `/clients` — список клиентов брокера (с фильтрами по status, uniquenessStatus)
- GET `/clients/:id` — детали клиента
- POST `/clients/:id/extend` — продление уникальности (с комментарием и причиной)
- PATCH `/clients/:id/fix` — перевод в FIXED (после визита + акт)
  - Устанавливает `fixationExpiresAt = now + 30 days`, `inspectionActSigned = true`
- PATCH `/clients/:id/resolve` — ручное решение менеджера по UNDER_REVIEW (managerOnly)
  - Устанавливает uniquenessStatus = CONDITIONALLY_UNIQUE или REJECTED + причина

**CRON-задачи** (BullMQ):
- Каждый час: проверка истекающих uniqueness/fixation
- За 3 дня до истечения: отправка SMS/TG напоминания
- По истечении 30 дней без активности: перевод в EXPIRED, уведомление брокеру

### 6.3 CatalogModule
- GET `/lots` — список лотов с фильтрами (project, rooms, priceMin, priceMax, sqmMin, sqmMax, floor, status)
- GET `/lots/:id` — детали лота
- Webhook: POST `/webhooks/profitbase/lot-update` — обновление из Profitbase

### 6.4 DealsModule
- GET `/deals` — список сделок брокера
- GET `/deals/:id` — детали сделки
- PATCH `/deals/:id/attach-agency` — привязка компании к сделке (managerOnly)
  - Можно сменить вручную (с логированием в audit_log)
- Webhook: POST `/webhooks/amo/lead-update` — обновление статуса из amoCRM
  - **На этапе ДВОУ (платная бронь)**: автоматически привязать agencyId из client.fixationAgencyId
  - **При оплате**: пересчитать totalSqmSold на Agency, обновить commissionLevel

### 6.5 CommissionModule
- GET `/commission/my` — текущий уровень, ставка, прогресс, бонус (по agency через ИНН)
- GET `/commission/calculate` — расчёт комиссии по сумме сделки
- Логика уровней (привязка к Agency по ИНН, totalSqmSold на Agency, не на брокере):

**Зорге 9:**
| Уровень | м²/квартал | Ставка |
|---------|-----------|--------|
| Start | 0–59 | 5.0% |
| Basic | 60–119 | 5.5% |
| Strong | 120–199 | 6.0% |
| Premium | 200–319 | 6.5% |
| Elite | 320–499 | 7.0% |
| Champion | 500–699 | 7.5% |
| Legend | 700+ | 8.0% |

**Квартальный бонус** (при Strong+):
- 1-й квартал: +0.1%
- 2-й подряд: +0.15%
- 3-й подряд: +0.2%
- 4+ подряд: +0.25% (max)
- При 0 продаж в квартале — счётчик обнуляется

**Особые условия:**
- Рассрочка: ставка −0.5%
- Зорге 9: выплата при 50%+ оплаты, иначе в 2 этапа
- Серебряный Бор: выплата при 30%+ оплаты
- Субсидированная ипотека: 4% фиксированно
- Коммерция Зорге 9: продажа 3%, фитнес 3%, здания 2%, аренда ритейл 100% мес., аренда фитнес 50% мес.

### 6.6 MeetingsModule
- GET `/meetings` — список встреч брокера
- POST `/meetings` — запись на встречу (clientId, type, date, comment)
- PATCH `/meetings/:id` — обновление статуса
- POST `/meetings/:id/sign-act` — подписание акта осмотра → автоматическая фиксация клиента

### 6.7 CallerModule (заготовка для AI-агента)
- GET `/calls` — история звонков
- POST `/calls/schedule` — запланировать обзвон (adminOnly)
- Webhook: POST `/webhooks/mango/call-result` — результат звонка

**Логика обзвона** (реализовать как BullMQ queue):
- Рабочие часы: пн–пт 11:00–19:00 МСК, сб 12:00–17:00
- Макс 3 попытки/день, пауза 2 часа
- Цикл до 3 дней, пауза между циклами 2 дня
- При 3 дня недоступен → снижение приоритета в amoCRM
- Флаг doNotCall — пропускать

### 6.8 NotificationModule
- BullMQ queue для отправки уведомлений
- Каналы: SMS, WhatsApp, Telegram
- Типы: uniqueness_expiring, fixation_expiring, deal_status_changed, meeting_reminder, push_broadcast, **broker_conflict** (менеджеру — когда два брокера на одного клиента), **uniqueness_resolved** (брокеру — результат ручного рассмотрения)

### 6.9 DocumentsModule
- GET `/documents` — список документов (с фильтрами по category, project)
- GET `/documents/:id/download` — presigned URL для S3

### 6.10 AnalyticsModule (заготовка)
- GET `/analytics/dashboard` — агрегированные метрики для дашборда
- GET `/analytics/funnel` — воронка брокеров (5 этапов по ТЗ amoCRM v1.4):
  1. Новый брокер (с подтипами: CRM_MANUAL / BROKER_CABINET / PHONE_CALL / CLOSED_AS_BROKER)
  2. Брокер-тур (посетил, далее нет активности)
  3. Фиксации на уникальность
  4. Встреча
  5. Сделка
- GET `/analytics/funnel` — фильтры: кол-во фиксаций (числовой), дата фиксации (период от-до), брокер-тур (да/нет + дата), встречи, сделки

### 6.11 WebhooksModule
- POST `/webhooks/amo/lead-update`
- POST `/webhooks/amo/contact-update`
- POST `/webhooks/mango/call-result`
- POST `/webhooks/profitbase/lot-update`
- Все webhook'и: HMAC-валидация подписи, логирование в audit_log

---

## 7. INTEGRATION ADAPTERS (packages/integrations)

Каждый адаптер — отдельный файл с интерфейсом и реализацией.

### 7.1 AmoCrmAdapter
```typescript
interface IAmoCrmAdapter {
  // Контакты
  findContactByPhone(phone: string): Promise<AmoContact | null>;
  createContact(data: CreateContactDto): Promise<AmoContact>;
  
  // Компании
  findCompanyByInn(inn: string): Promise<AmoCompany | null>;
  createCompany(data: CreateCompanyDto): Promise<AmoCompany>;  // name + inn
  linkContactToCompany(contactId: number, companyId: number): Promise<void>;
  
  // Сделки (лиды)
  createLead(data: CreateLeadDto): Promise<AmoLead>;
  updateLead(id: number, data: UpdateLeadDto): Promise<void>;
  reopenLead(id: number, newBrokerAmoId: number): Promise<AmoLead>;  // Переоткрытие закрытой сделки
  getLeadsByBroker(brokerAmoId: number): Promise<AmoLead[]>;
  getLeadStage(leadId: number): Promise<string>;  // Текущий статус сделки в воронке
  
  // Создание заявки на фиксацию — передаёт: компания + ИНН + телефон брокера + комментарий
  createFixationRequest(data: {
    clientPhone: string;
    clientName: string;
    brokerPhone: string;
    agencyName: string;
    agencyInn: string;
    comment: string;
    project: string;
  }): Promise<AmoLead>;
}
```
- OAuth2 с автоматическим обновлением токена
- Rate limiting: не более 7 запросов/сек
- Retry с exponential backoff
- При создании заявки: поиск компании по ИНН → если есть, привязать → если нет, создать

### 7.2 MangoAdapter
```typescript
interface IMangoAdapter {
  initiateCall(from: string, to: string): Promise<{ callId: string }>;
  getCallRecording(callId: string): Promise<string>; // URL
  getCallStatus(callId: string): Promise<CallStatus>;
}
```

### 7.3 ProfitbaseAdapter
```typescript
interface IProfitbaseAdapter {
  getLots(filters?: LotFilters): Promise<ProfitbaseLot[]>;
  getLotById(id: string): Promise<ProfitbaseLot>;
  syncLots(): Promise<{ created: number; updated: number }>;
}
```

### 7.4 WhatsAppAdapter
```typescript
interface IWhatsAppAdapter {
  sendMessage(phone: string, text: string): Promise<void>;
  sendDocument(phone: string, documentUrl: string, caption: string): Promise<void>;
  sendImage(phone: string, imageUrl: string, caption: string): Promise<void>;
}
```

---

## 8. NEXT.JS WEB (apps/web)

### Структура страниц (App Router):
```
app/
├── layout.tsx              # Sidebar + TopBar shell
├── page.tsx                # Redirect to /dashboard
├── (auth)/
│   ├── login/page.tsx      # Вход по телефону + OTP
│   └── register/page.tsx   # Регистрация
├── (cabinet)/
│   ├── layout.tsx          # Authenticated layout with sidebar
│   ├── dashboard/page.tsx
│   ├── fixation/page.tsx
│   ├── clients/
│   │   ├── page.tsx        # Список
│   │   └── [id]/page.tsx   # Детали клиента
│   ├── catalog/
│   │   ├── page.tsx        # Лоты с фильтрами
│   │   └── [id]/page.tsx   # Карточка лота
│   ├── deals/page.tsx
│   ├── commission/page.tsx
│   ├── meetings/page.tsx
│   ├── calculators/page.tsx
│   └── documents/page.tsx
```

### Дизайн-система:
- Тёмная тема: bg `#0c0b0b`, surface `#111010` / `#181716`
- Акцент: gold `#B4936F`, gold hover `#c9a882`
- Текст: white `#ffffff`, muted `#7a7672`
- Статусы: green `#6dbf8e`, red `#a05050`, blue `#5b8fd4`
- Шрифт: Inter (или system), uppercase labels, letter-spacing на заголовках
- Border: `rgba(255,255,255,0.08)`
- Минимальный border-radius: 3–4px

### API-клиент:
Используй fetch wrapper с автоматическим JWT refresh:
```typescript
// lib/api.ts
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options?.headers },
  });
  if (res.status === 401) { await refreshToken(); return apiFetch(path, options); }
  if (!res.ok) throw new ApiError(res.status, await res.json());
  return res.json();
}
```

---

## 9. TELEGRAM BOT (apps/telegram)

### Структура:
```
src/
├── bot.ts                  # Инициализация grammY
├── middleware/
│   ├── auth.ts             # Проверка авторизации по telegramChatId
│   └── logging.ts
├── conversations/
│   ├── fixClient.ts        # Пошаговая фиксация клиента
│   ├── selectLot.ts        # Подбор квартиры
│   └── calculator.ts       # Ипотечный калькулятор
├── commands/
│   ├── start.ts            # /start — авторизация по номеру
│   ├── commission.ts       # Моя комиссия
│   ├── deals.ts            # Статус сделок
│   ├── materials.ts        # Запрос материалов
│   └── help.ts
├── keyboards/
│   └── main.ts             # Inline-клавиатуры
└── services/
    └── api.ts              # Клиент к NestJS API
```

### Команды бота:
| Команда | Действие |
|---------|----------|
| /start | Авторизация по номеру телефона (SMS OTP) |
| Просмотр ЖК | Карточки с фото, ценой, остатками |
| Моя комиссия | Ставка + прогресс накопительной |
| Зафиксировать клиента | Пошаговый ввод: ФИО → телефон → проверка |
| Подбор квартир | Фильтры: комнаты, бюджет, этаж |
| Статус сделки | Текущие сделки брокера |
| Калькулятор ипотеки | Ввод суммы, взноса, ставки → расчёт |
| Калькулятор комиссии | Сумма сделки → комиссия по текущей ставке |
| Материалы | Inline-кнопки: брошюра, планировки, прайс, видео |
| Помощь | FAQ + эскалация на менеджера |

### Push-уведомления:
Бот отправляет push через Telegram при:
- Истечении уникальности (за 3 дня)
- Смене статуса сделки
- Подтверждении встречи
- Новых акциях / изменении прайса

---

## 10. DOCKER

### docker-compose.yml:
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: broker_platform
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  api:
    build:
      context: .
      dockerfile: docker/Dockerfile.api
    ports: ["4000:4000"]
    env_file: .env
    depends_on: [postgres, redis]

  web:
    build:
      context: .
      dockerfile: docker/Dockerfile.web
    ports: ["3000:3000"]
    env_file: .env
    depends_on: [api]

  telegram:
    build:
      context: .
      dockerfile: docker/Dockerfile.telegram
    env_file: .env
    depends_on: [api]

volumes:
  pgdata:
```

---

## 11. SEED DATA

Файл: `packages/database/prisma/seed.ts`

Создай seed с:
- 3 Agencies: «Недвижимость+» (ИНН 7701234567), «Тренд» (ИНН 7709876543), «Ромашка» (ИНН 7705551234)
- 3 Brokers: разные уровни (Start, Strong, Elite), разные funnelStage и source
- BrokerAgency связки: один брокер привязан к 2 компаниям (история)
- 10 Clients: разные uniquenessStatus (включая UNDER_REVIEW), fixationAgencyId заполнен
- 20 Lots: микс студий, 1-к, 2-к, 3-к по Зорге 9
- 3 Deals: pending, signed, paid — с agencyId
- 5 Meetings: разные типы и статусы
- 8 Documents: брошюры, планировки, прайсы

---

## 12. ПОРЯДОК ВЫПОЛНЕНИЯ

### АВТОМАТИЧЕСКИЕ ПРАВИЛА (соблюдай всегда):

**Правило 1 — Git-коммит после каждого шага:**
После завершения каждого шага АВТОМАТИЧЕСКИ выполни:
```bash
git add -A
git commit -m "Шаг N: описание"
```
Не спрашивай разрешения на коммит — делай сам.

**Правило 2 — При старте / перезапуске определи прогресс:**
Если проект уже существует (есть файлы кроме CLAUDE_CODE_MASTER_PROMPT.md):
1. Выполни `git log --oneline` чтобы увидеть какие шаги завершены
2. Проверь структуру папок: `ls -la apps/ packages/ docker/`
3. Определи последний завершённый шаг
4. Сообщи: "Проект на шаге N. Продолжаю с шага N+1."
5. Продолжи со следующего шага БЕЗ пересоздания уже существующих файлов

**Правило 3 — Первый запуск (пустой проект):**
Если проекта ещё нет — сначала:
```bash
git init
git add -A
git commit -m "Шаг 0: initial commit + master prompt"
```

---

### ШАГИ:

**Шаг 1.** Инициализация monorepo: `package.json`, `turbo.json`, `tsconfig.base.json`, `.env.example`, `.gitignore`, workspace config
→ `git commit -m "Шаг 1: monorepo init (Turborepo + workspaces)"`

**Шаг 2.** packages/shared: типы, enum'ы, zod-схемы
→ `git commit -m "Шаг 2: shared types, enums, zod schemas"`

**Шаг 3.** packages/database: Prisma schema → `npx prisma generate` → seed
→ `git commit -m "Шаг 3: Prisma schema + migrations + seed"`

**Шаг 4.** packages/integrations: адаптеры (AmoCRM, Mango, Profitbase, WhatsApp) — заглушки с интерфейсами
→ `git commit -m "Шаг 4: integration adapters (stubs)"`

**Шаг 5.** apps/api: NestJS — все 11 модулей, от auth до webhooks
→ `git commit -m "Шаг 5: NestJS API (all 11 modules)"`

**Шаг 6.** apps/web: Next.js — layout, auth, все страницы кабинета
→ `git commit -m "Шаг 6: Next.js web cabinet"`

**Шаг 7.** apps/telegram: grammY бот — команды, conversations, keyboards
→ `git commit -m "Шаг 7: Telegram bot (grammY)"`

**Шаг 8.** docker/: Dockerfile'ы + compose
→ `git commit -m "Шаг 8: Docker configs"`

**Шаг 9.** README.md: инструкция по запуску
→ `git commit -m "Шаг 9: README + docs"`

---

## 13. КРИТИЧЕСКИЕ БИЗНЕС-ПРАВИЛА (НЕ НАРУШАТЬ)

1. **Уникальность — 4 сценария проверки** (см. §6.2). Не упрощать до 2 веток. Все 4 ветки должны быть реализованы с правильными статусами и уведомлениями.

2. **Уникальность — 30 календарных дней** с момента регистрации. Напоминание за 2-3 дня. Продление только с комментарием. По истечении без активности — EXPIRED автоматически.

3. **Фиксация — только после**: визит в офис ИЛИ онлайн-встреча + подписание Акта осмотра. 30 дней. Аннулирование при отсутствии активности.

4. **Компания к клиенту — НЕ при фиксации, а только на ДВОУ** (платная бронь). Менеджер привязывает. Компания не открепляется, но можно сменить вручную (с логом).

5. **Компании брокера — M2M, не удалять**. Брокер может работать от нескольких компаний. Старые остаются в истории. Дедупликация по ИНН.

6. **ИНН агентства — обязателен**. Ключ связи между CRM и кабинетом. При заявке передаётся: название + ИНН + телефон брокера + комментарий.

7. **Накопительная программа** — по агентству (юрлицо, по ИНН), не по отдельному брокеру. totalSqmSold хранится на Agency. Учитываются оба проекта. Пересчёт при каждой оплаченной сделке.

8. **Выплата комиссии — только после**: заключение ДДУ/ДКП/ПДКП + поступление денег на р/с. 5 рабочих дней после полного пакета документов.

9. **Приоритет при споре** — брокеру, который фактически привёл клиента к сделке. При конфликте (сценарий 3) — менеджер получает уведомление BROKER_CONFLICT.

10. **Запрещено**: скидки без согласования, занижение стоимости, фиктивные заявки, деление КВ с клиентом.

11. **Do Not Call** — обязательно уважать флаг при обзвоне.

12. **Синхронизация обратная**: amoCRM (оплаченные м²) → webhook → обновление totalSqmSold на Agency (по ИНН) → пересчёт commissionLevel → брокер видит актуальную ставку в кабинете.

---

## 14. КАЧЕСТВО КОДА

- Strict TypeScript (no `any`)
- ESLint + Prettier
- Каждый модуль API — со Swagger-декораторами (@ApiTags, @ApiOperation, @ApiResponse)
- Логирование через NestJS Logger
- Все даты — UTC, отображение — Moscow timezone на фронте
- Пагинация: cursor-based для списков
- Error handling: глобальный exception filter с proper error codes

---

## НАЧНИ РАБОТУ

**Если проект пустой** — начни с `git init` и шага 1.
**Если проект уже есть** — выполни `git log --oneline`, определи прогресс, продолжи.

После каждого шага — автоматический `git commit`. Не спрашивай, просто делай.
При возникновении вопросов по бизнес-логике — сверяйся с разделом 13.
