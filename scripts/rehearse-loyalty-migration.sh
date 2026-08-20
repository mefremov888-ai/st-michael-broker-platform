#!/bin/sh
# 2026-08-20: одноразовая репетиция миграции легаси-базы (см.
# packages/database/prisma/migrations/README.md, раздел
# "Existing legacy production database", шаги 1-6).
#
# Что делает:
#   1. Снимает pg_dump с ЖИВОЙ базы через уже работающий postgres-контейнер
#      (read-only операция, ничего не блокирует и не меняет).
#   2. Поднимает ОТДЕЛЬНЫЙ одноразовый postgres:16-alpine контейнер в своей
#      сети — никак не связан с боевым stack, случайный пароль, только на
#      localhost сервера.
#   3. Восстанавливает дамп В ЭТОТ отдельный контейнер.
#   4. Прогоняет prisma migrate resolve + migrate deploy + migrate status
#      ТОЛЬКО против этой копии.
#   5. Печатает результат и построчные счётчики brokers/agencies до и после
#      (миграция аддитивная, эти таблицы менять не должна).
#   6. Гарантированно сносит временный контейнер и volume в конце (trap),
#      даже если что-то упало.
#
# Реальный DATABASE_URL боевой базы этот скрипт НИГДЕ не читает и не строит —
# бэкап снимается через `docker compose exec postgres`, не через прямое
# подключение. Финальное применение миграции на самой проде (шаги 7-8 в
# README) этот скрипт НЕ делает — это отдельная, человеко-выполняемая часть.
set -eu

DEPLOY_PATH="${1:?usage: rehearse-loyalty-migration.sh <deploy_path>}"
cd "$DEPLOY_PATH"

REHEARSAL_ID="loyalty-rehearsal-$$"
REHEARSAL_NET="${REHEARSAL_ID}-net"
REHEARSAL_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
DUMP_FILE="/tmp/${REHEARSAL_ID}.dump"

cleanup() {
    echo "=== Уборка временных ресурсов ==="
    docker rm -f "$REHEARSAL_ID" >/dev/null 2>&1 || true
    docker network rm "$REHEARSAL_NET" >/dev/null 2>&1 || true
    rm -f -- "$DUMP_FILE"
}
trap cleanup EXIT

echo "=== 1/6: Снимаем pg_dump с живой базы (read-only) ==="
docker compose exec -T postgres pg_dump -U postgres -Fc broker_platform > "$DUMP_FILE"
echo "Размер дампа: $(du -h "$DUMP_FILE" | cut -f1)"

echo "=== Счётчики живой базы (для сверки после восстановления) ==="
LIVE_BROKERS=$(docker compose exec -T postgres psql -U postgres -d broker_platform -tAc "SELECT count(*) FROM brokers;")
LIVE_AGENCIES=$(docker compose exec -T postgres psql -U postgres -d broker_platform -tAc "SELECT count(*) FROM agencies;")
echo "brokers=$LIVE_BROKERS agencies=$LIVE_AGENCIES"

echo "=== 2/6: Поднимаем изолированный одноразовый Postgres ==="
docker network create "$REHEARSAL_NET" >/dev/null
docker run -d --name "$REHEARSAL_ID" --network "$REHEARSAL_NET" \
    -e POSTGRES_PASSWORD="$REHEARSAL_PASSWORD" \
    -e POSTGRES_DB=rehearsal \
    postgres:16-alpine >/dev/null

echo "Ждём готовности изолированного контейнера..."
i=0
until docker exec "$REHEARSAL_ID" pg_isready -U postgres >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
        echo "✗ Изолированный Postgres не поднялся за 60 секунд"
        exit 1
    fi
    sleep 1
done

echo "=== 3/6: Восстанавливаем дамп в изолированный контейнер ==="
docker exec -i "$REHEARSAL_ID" pg_restore -U postgres -d rehearsal --no-owner --exit-on-error < "$DUMP_FILE"

RESTORED_BROKERS=$(docker exec "$REHEARSAL_ID" psql -U postgres -d rehearsal -tAc "SELECT count(*) FROM brokers;")
RESTORED_AGENCIES=$(docker exec "$REHEARSAL_ID" psql -U postgres -d rehearsal -tAc "SELECT count(*) FROM agencies;")
echo "После восстановления: brokers=$RESTORED_BROKERS agencies=$RESTORED_AGENCIES"
if [ "$RESTORED_BROKERS" != "$LIVE_BROKERS" ] || [ "$RESTORED_AGENCIES" != "$LIVE_AGENCIES" ]; then
    echo "✗ Счётчики после восстановления не совпадают с живой базой — репетиция не прошла"
    exit 1
fi

echo "=== 4/6: Прогоняем prisma migrate против изолированной копии ==="
CLONE_DATABASE_URL="postgresql://postgres:${REHEARSAL_PASSWORD}@${REHEARSAL_ID}:5432/rehearsal"

docker run --rm --network "$REHEARSAL_NET" \
    -e DATABASE_URL="$CLONE_DATABASE_URL" \
    -v "$(pwd)/packages/database:/app/packages/database:ro" \
    -w /app/packages/database \
    node:20-alpine sh -c "
        set -e
        npm install --no-save --no-audit --no-fund prisma@5.22 >/dev/null 2>&1
        echo '--- migrate diff (ожидаем пустой diff, exit 0) ---'
        npx prisma migrate diff \
            --from-url \"\$DATABASE_URL\" \
            --to-schema-datamodel prisma/baselines/0_legacy_baseline.prisma \
            --script --exit-code
        echo '--- migrate resolve --applied 0_legacy_baseline ---'
        npx prisma migrate resolve --applied 0_legacy_baseline --schema prisma/schema.prisma
        echo '--- migrate deploy (применит 20260818000100_loyalty_base + mango safety) ---'
        npx prisma migrate deploy --schema prisma/schema.prisma
        echo '--- migrate status ---'
        npx prisma migrate status --schema prisma/schema.prisma
    "

echo "=== 5/6: Финальные счётчики после миграции (должны не измениться) ==="
FINAL_BROKERS=$(docker exec "$REHEARSAL_ID" psql -U postgres -d rehearsal -tAc "SELECT count(*) FROM brokers;")
FINAL_AGENCIES=$(docker exec "$REHEARSAL_ID" psql -U postgres -d rehearsal -tAc "SELECT count(*) FROM agencies;")
echo "brokers=$FINAL_BROKERS agencies=$FINAL_AGENCIES"
if [ "$FINAL_BROKERS" != "$LIVE_BROKERS" ] || [ "$FINAL_AGENCIES" != "$LIVE_AGENCIES" ]; then
    echo "✗ Миграция изменила количество строк brokers/agencies — это НЕ ожидается, останавливаем."
    exit 1
fi

echo "=== 6/6: Репетиция прошла чисто ==="
echo "brokers=$FINAL_BROKERS agencies=$FINAL_AGENCIES, миграция аддитивна, счётчики не изменились."
echo "Это НЕ применяет ничего на боевой базе — только подтверждает, что миграция безопасна."
