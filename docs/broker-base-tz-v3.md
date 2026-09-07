# ТЗ v3: Интеграция базы брокеров в кабинет (СОГЛАСОВАНО)

**Дата**: 2026-05-15  
**Статус**: Согласовано, готово к реализации  
**Предыдущие версии**: `broker-base-tz.md`, `broker-base-tz-v2.md`

---

## 1. Что было изучено (без изменений)

База Google Sheets, **10 837 брокеров**:
- 7 506 с заявкой (69%)
- 1 544 со встречей (14%)
- 260 со сделкой (2.4%)

Категории результата звонка: 11 типов (НДЗ, Проинформирован, Уже был, Запись на БТ, и т.д.)

---

## 2. Согласованные решения

### 2.1 Архитектура — расширяем `Broker`

✅ **Подтверждено**. Одна запись брокера от первого холодного звонка до закрытия сделки. `BrokerLead` НЕ создаём.

### 2.2 5 рабочих статусов вместо 11 (с уточнением)

| Статус (`BrokerCategory`) | Что входит | Действие КЦ | Хранение |
|---|---|---|---|
| `COLD` | НДЗ (без 2x), новые из импорта | звонить регулярно | вечно |
| `WARM` | Проинформирован, Только отправить инфо, Уже был | редкие касания | вечно |
| `HOT` | Запись на БТ, В работе | приоритет звонков | вечно |
| `CONVERTED` | Есть встреча/сделка | вне обзвонной воронки | вечно |
| **`ON_BOT_REVIEW`** | **2 НДЗ, Отказ от коммуникации** | **«На проверке у бота»** | **вечно** |
| `BLACKLIST` | НЕ брокер, Некорректный номер | не звоним | **удалять через 6 мес** |

**Изменение**: добавлен статус `ON_BOT_REVIEW` (был частью BLACKLIST). Хранится вечно. BLACKLIST теперь только для «реально не брокер» и удаляется через 6 мес.

### 2.3 Несколько телефонов на одного брокера

Сценарий: один брокер сменил симку и работает с двух номеров. Нужно поддерживать.

**Решение**: добавить модель `BrokerPhone`:
```prisma
model BrokerPhone {
  id        String  @id @default(uuid())
  brokerId  String
  broker    Broker  @relation(fields: [brokerId], references: [id])
  phone     String  @unique
  isPrimary Boolean @default(false)
  
  @@index([brokerId])
  @@map("broker_phones")
}
```
- Поле `Broker.phone` остаётся как primary (для совместимости с существующей логикой)
- Поиск брокера ведётся по обоим: и `Broker.phone`, и `BrokerPhone.phone`

### 2.4 Координаторы — отдельная метка

Координатор = руководитель агентства / организатор брокер-туров на стороне брокеров. Нужны для:
- Звонков на массовые мероприятия (БТ)
- Координатор может «привести» 10 брокеров на встречу

**Решение**: добавить флаг на брокере:
```prisma
isCoordinator        Boolean @default(false)
coordinatorAgency    String? // имя агентства (если применимо)
```
Плюс импорт из Sheet2 «Координаторы» в Excel.

### 2.5 Кампании, сегментация, расписание операторов — без изменений

Как в v2:
- `Campaign` как отдельная модель
- `specialization` (COMM/RESIDENTIAL/BOTH)
- `region` (MSK/SPB/OTHER) — по умолчанию MSK
- Расписание операторов делаем позже, после ухода от Morekit

### 2.6 Связь с amoCRM — без изменений

Координатор не дублирует amoCRM. amoCRM остаётся для клиентских лидов.

### 2.7 Импорт из Google — одноразовый

После импорта Google архивируется. Двусторонний sync не делаем.

### 2.8 Audio звонков — **ОСТАВЛЯЕМ В amoCRM**

Изменение от v2: запись звонков **продолжает храниться в amoCRM** (Mango Office интеграция). Если нужно прослушать — открываем карточку в amoCRM. **Не копируем в S3**, не дублируем.

### 2.9 Merge дубликатов при импорте

Если в Google две строки с одинаковым телефоном:
- Объединяем в одну запись
- Имена разные → склеиваем через `//` (например «Иван // Ромашка»)
- Имена одинаковые → берём одно
- Счётчики (заявки, встречи, сделки) суммируем
- Комментарии — последний по дате звонка

### 2.10 PII

- **Номера в открытом виде** для КЦ операторов (иначе не позвонить)
- **Нестандартные номера** (`+77...`, отсутствующая цифра) — оставляем как есть. КЦ просто не дозвонится, помечает «Некорректный номер»
- Анонимизация только при увольнении (`isActive=false`, имя → «Бывший #N»)

### 2.11 Нормализация телефонов (для определения дубликатов)

**Дубликат = одинаковый номер после нормализации.** Все варианты приводятся к `+7XXXXXXXXXX`.

**Алгоритм** (используется при импорте и при ручном вводе):

1. Убираем все символы кроме цифр
2. Получили число длиной `n`:

| n | Что значит | Действие |
|---|---|---|
| 12, начинается с `77` | Брокер случайно ввёл `+7` дважды | Отбросить первую `7` → 11 цифр, первая = `7` → валид |
| 11, начинается с `7` (но не `77`) | Стандартный RF | `+` + 11 цифр |
| 11, начинается с `8` | Старый формат RF | Заменить `8` на `7` → `+7XXX...` |
| 11, начинается с `77` | Брокер ввёл `+7` дважды + последняя цифра не вошла в форму (truncate) | **INVALID** → BLACKLIST (Некорректный номер) |
| 10 (мобильный без префикса) | Свежий ввод | Добавить `7` в начало → `+7XXX...` |
| < 10 | Неполный | **INVALID** |
| 11+, начинается с другой цифры (1, 9, 8 с длиной 12+) | Возможно иностранный | Сохраняем как `+<digits>`, КЦ звонит вручную |

**Примеры**:

| Ввод | После нормализации |
|---|---|
| `+7 925 123 45 67` | `+79251234567` ✓ |
| `8 (925) 123-45-67` | `+79251234567` ✓ |
| `925 123 45 67` | `+79251234567` ✓ |
| `+7 7 925 123 45 67` (12 цифр, `77...`) | `+79251234567` ✓ (дроп первой 7) |
| `+7 7 925 123 45` (11 цифр, `77925123456`) | **INVALID** ❌ (truncated, last digit lost) |
| `+998 90 123 45 67` (Узбекистан) | `+998901234567` — оставляем, иностранный |

**Только после нормализации сравниваем телефоны для merge дубликатов.**

---

## 3. План реализации (СОГЛАСОВАН)

| Этап | Время | Что делается |
|---|---|---|
| 0. Подготовка | 1 день | ✅ ТЗ согласовано. Получить Service Account для Google Sheets |
| 1. Модель данных | 1 день | Prisma migration: `Broker` (категории, специализация, регион, isCoordinator), `BrokerPhone`, `CallLog`, `Campaign` |
| 2. Импорт из Google | 2 дня | Скрипт `import-google-brokers.js` + workflow task. Merge дубликатов по правилам v3.2.9 |
| 3. UI колл-центра | 5-7 дней | Очередь обзвона, карточка брокера для оператора с быстрыми кнопками, история CallLog |
| 4. Кампании | 3 дня | CRUD + dashboard |
| 5. Аналитика | 3 дня | Воронка конверсии + KPI операторов |
| 6 (опц). Round-robin | 5 дней | Когда уйдём от Morekit |
| 7 (опц). Mango интеграция | 3 дня | Click-to-call из карточки. Audio остаётся в amoCRM |

**Итого MVP (0-5): ~15 рабочих дней**. Делаем «оперативно и качественно», без рывков, по порядку.

---

## 4. Что НЕ делаем

- Не отказываемся от amoCRM
- Не делаем двусторонний sync с Google
- Не дублируем audio звонков в S3 (остаётся в amoCRM)
- Не строим систему обучения операторов
- Не делаем мобильное приложение (web-кабинет адаптивный)

---

## 5. Следующий шаг — Этап 1 (модель данных)

После согласования этого ТЗ я начну с **Prisma migration**:

```prisma
model Broker {
  // существующие поля
  ...
  // новое
  category             BrokerCategory @default(COLD)
  specialization       BrokerSpecialization?
  region               String?
  isCoordinator        Boolean @default(false)
  coordinatorAgency    String?
  lastCallAt           DateTime?
  nextCallAt           DateTime?
  isInBase             Boolean @default(false)
  baseSource           String? // 'google_sheet' / 'amocrm' / 'manual'
  doNotCall            Boolean @default(false)
  // relations
  phones               BrokerPhone[]
  callLogs             CallLog[]
}

model BrokerPhone {
  id        String  @id @default(uuid())
  brokerId  String
  broker    Broker  @relation(fields: [brokerId], references: [id])
  phone     String  @unique
  isPrimary Boolean @default(false)
}

model CallLog {
  id         String   @id @default(uuid())
  brokerId   String
  broker     Broker   @relation(fields: [brokerId], references: [id])
  operatorId String?
  campaign   String?
  result     CallResult
  comment    String?
  nextCallAt DateTime?
  duration   Int?
  createdAt  DateTime @default(now())
}

model Campaign {
  id          String    @id @default(uuid())
  name        String
  description String?
  createdById String
  startAt     DateTime?
  endAt       DateTime?
  isActive    Boolean   @default(true)
  filters     Json
  createdAt   DateTime  @default(now())
}

enum BrokerCategory {
  COLD
  WARM
  HOT
  CONVERTED
  ON_BOT_REVIEW
  BLACKLIST
}

enum BrokerSpecialization {
  COMM
  RESIDENTIAL
  BOTH
}

enum CallResult {
  NDZ, DOUBLE_NDZ, INFORMED, ALREADY_KNOWS, WRONG_NUMBER,
  REFUSED_COMMUNICATION, NOT_A_BROKER, SCHEDULED_TOUR,
  ONLY_SEND_INFO, IN_PROGRESS, REFUSED_TOUR, HUNG_UP,
  NOT_RELEVANT, NOT_BROKER_ANYMORE, ASKED_NOT_TO_CALL, NEGATIVE
}
```

Это будет одна миграция `prisma db push` при следующем деплое.

После — Этап 2: импорт из Google Sheets.
