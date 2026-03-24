#!/bin/sh
set -e

echo "==> Running Prisma migrations..."
npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma

echo "==> Seeding database (if empty)..."
npx prisma db seed --schema=packages/database/prisma/schema.prisma 2>/dev/null || echo "==> Seed skipped (data exists or failed)"

echo "==> Starting API server..."
exec node apps/api/dist/main.js
