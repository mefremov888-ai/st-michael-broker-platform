#!/bin/bash
set -e

echo "============================================"
echo "  ST Michael Broker Platform - Deploy"
echo "============================================"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is not installed. Install it first:"
    echo "  https://docs.docker.com/get-docker/"
    exit 1
fi

if ! command -v docker compose &> /dev/null && ! command -v docker-compose &> /dev/null; then
    echo "ERROR: Docker Compose is not installed."
    exit 1
fi

COMPOSE_CMD="docker compose"
if ! command -v docker compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
fi

# Create .env if not exists
if [ ! -f .env ]; then
    echo "==> Creating .env from .env.example..."
    cp .env.example .env

    # Generate random JWT secret
    JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -d '\n/' | head -c 64)
    sed -i "s/JWT_SECRET=change-me-in-production/JWT_SECRET=$JWT_SECRET/" .env 2>/dev/null || true

    echo "==> .env created. Edit it if needed, then run this script again."
    echo ""
    echo "  Important settings to configure:"
    echo "  - JWT_SECRET (auto-generated)"
    echo "  - TELEGRAM_BOT_TOKEN (if using Telegram bot)"
    echo "  - S3_* (if using file storage)"
    echo ""
fi

# Create SSL directory (for future HTTPS)
mkdir -p docker/ssl

echo "==> Building and starting all services..."
$COMPOSE_CMD up -d --build

echo ""
echo "==> Waiting for services to start..."
sleep 5

echo ""
echo "==> Checking service health..."
$COMPOSE_CMD ps

echo ""
echo "============================================"
echo "  Deploy complete!"
echo "============================================"
echo ""
echo "  Web app:     http://localhost"
echo "  API:         http://localhost:4000"
echo "  Swagger:     http://localhost:4000/api"
echo ""
echo "  Test login credentials (from seed data):"
echo "  Phone: +79001234567 (Александр Петров)"
echo "  Phone: +79009876543 (Мария Сидорова)"
echo "  Phone: +79005551234 (Дмитрий Иванов)"
echo ""
echo "  OTP codes appear in API logs:"
echo "  $COMPOSE_CMD logs -f api"
echo ""
echo "  To stop:  $COMPOSE_CMD down"
echo "  To reset: $COMPOSE_CMD down -v && $COMPOSE_CMD up -d --build"
echo "============================================"
