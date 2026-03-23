# ST Michael Broker Platform

Платформа управления брокерской деятельностью для агентства недвижимости ST Michael. Включает веб-кабинет брокера, API для интеграций и Telegram-бот.

## 🏗️ Архитектура

Монолитная архитектура с разделением на сервисы:

- **API (NestJS)**: Backend с бизнес-логикой, интеграциями и Swagger документацией
- **Web (Next.js)**: Кабинет брокера с авторизацией и управлением
- **Telegram Bot (grammY)**: Бот для быстрого доступа к функциям
- **Database (PostgreSQL + Prisma)**: База данных с полной схемой
- **Cache/Queue (Redis + BullMQ)**: Кеширование и фоновые задачи

## 🚀 Быстрый запуск

### Предварительные требования

- Node.js 20+
- Docker & Docker Compose
- Git

### 1. Клонирование и установка

```bash
git clone <repository-url>
cd st-michael-broker-platform

# Установка зависимостей
npm install
```

### 2. Настройка окружения

```bash
cp .env.example .env
```

Заполните переменные в `.env`:

```env
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/broker_platform
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET=your-super-secret-jwt-key
SMS_PROVIDER_API_KEY=your-sms-api-key

# Telegram Bot
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
API_URL=http://localhost:4000

# amoCRM Integration
AMO_SUBDOMAIN=stmichael
AMO_CLIENT_ID=your-client-id
AMO_CLIENT_SECRET=your-client-secret
AMO_ACCESS_TOKEN=your-access-token
AMO_REFRESH_TOKEN=your-refresh-token

# Telephony (Mango)
MANGO_API_KEY=your-mango-api-key
```

### 3. Запуск с Docker (рекомендуется)

```bash
# Сборка и запуск всех сервисов
docker-compose up --build

# Или в фоне
docker-compose up -d --build
```

Сервисы будут доступны:
- **API**: http://localhost:4000
- **Web**: http://localhost:3000
- **Swagger**: http://localhost:4000/api
- **PostgreSQL**: localhost:5432
- **Redis**: localhost:6379

### 4. Инициализация базы данных

```bash
# Генерация Prisma клиента
npm run db:generate

# Запуск миграций
npm run db:migrate

# Заполнение тестовыми данными
npm run db:seed
```

## 🛠️ Разработка

### Локальный запуск без Docker

```bash
# API
npm run dev --workspace=apps/api

# Web
npm run dev --workspace=apps/web

# Telegram Bot
npm run telegram:dev
```

### Структура проекта

```
├── apps/
│   ├── api/              # NestJS API
│   ├── web/              # Next.js кабинет
│   └── telegram/         # grammY бот
├── packages/
│   ├── shared/           # Общие типы и схемы
│   ├── database/         # Prisma схема и seed
│   └── integrations/     # Адаптеры внешних сервисов
├── docker/               # Docker конфигурация
└── docker-compose.yml
```

## 📋 API Документация

Swagger доступен по адресу: http://localhost:4000/api

### Основные эндпоинты

- `POST /auth/login` - Авторизация по телефону
- `POST /auth/verify-otp` - Подтверждение SMS кода
- `GET /brokers/me` - Профиль брокера
- `GET /commission/broker/:id` - Комиссия брокера
- `POST /client-fixation` - Фиксация клиента
- `GET /lots` - Каталог объектов
- `GET /deals/broker/:id` - Сделки брокера

## 🤖 Telegram Bot

### Команды

- `/start` - Авторизация по номеру телефона
- `/commission` - Текущая комиссия
- `/deals` - Статус сделок
- `/materials` - Материалы для работы
- `/help` - Справка

### Функции

- 🔒 Фиксация клиентов (пошагово)
- 🏠 Подбор квартир по фильтрам
- 🏦 Ипотечный калькулятор
- 📊 Просмотр комиссии и сделок

## 🔧 Интеграции

### amoCRM
Автоматическая синхронизация:
- Брокеры и их статусы воронки
- Клиенты и уникальность
- Сделки и комиссии

### Mango Telecom
Интеграция телефонии:
- Входящие звонки
- Запись разговоров
- Автоматическое создание лидов

### WhatsApp Business
Отправка уведомлений:
- Статус уникальности
- Напоминания о встречах
- Материалы и брошюры

### Profitbase
Синхронизация объектов:
- Каталог недвижимости
- Цены и статусы
- Автоматические обновления

## 📊 База данных

### Основные сущности

- **Agencies** - Агентства недвижимости
- **Brokers** - Брокеры с уровнями и комиссиями
- **Clients** - Клиенты с уникальностью
- **Lots** - Объекты недвижимости
- **Deals** - Сделки
- **Meetings** - Встречи и показы
- **Documents** - Материалы и документы

### Seed данные

Тестовые данные включают:
- 3 агентства с разными ИНН
- 3 брокера разных уровней
- 10 клиентов с различными статусами
- 20 объектов недвижимости
- 3 сделки в разных статусах
- 5 встреч и показов

## 🚀 Деплой

### Production сборка

```bash
# Сборка всех приложений
npm run build

# Запуск в Docker
docker-compose -f docker-compose.yml up -d
```

### Переменные окружения для продакшена

```env
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@host:5432/db
REDIS_URL=redis://host:6379
JWT_SECRET=strong-production-secret
```

## 📝 Бизнес-правила

### Уникальность клиентов
- 4 сценария проверки при фиксации
- 30 календарных дней с момента регистрации
- Автоматические напоминания и истечение

### Фиксация клиентов
- Только после визита в офис ИЛИ онлайн-встречи
- 30 дней на завершение
- Привязка к агентству только на этапе ДВОУ

### Комиссии брокеров
- Накопительная система по уровням
- Расчет на основе суммы сделки
- Прогресс к следующему уровню

## 🐛 Troubleshooting

### Проблемы с Docker

```bash
# Очистка контейнеров
docker-compose down -v
docker system prune -a

# Просмотр логов
docker-compose logs api
docker-compose logs web
```

### Проблемы с базой данных

```bash
# Сброс базы
npm run db:migrate:reset
npm run db:seed
```

### Проблемы с Telegram ботом

```bash
# Проверка токена
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe

# Перезапуск бота
docker-compose restart telegram
```

## 📞 Поддержка

Для вопросов и поддержки:
- Техническая документация: [ссылка]
- Менеджер проекта: @manager
- Техническая поддержка: support@stmichael.ru

## 📄 Лицензия

Copyright © 2024 ST Michael Realty. Все права защищены.