#!/bin/sh
# 2026-08-20: безопасная репетиция миграций на копии production (см.
# packages/database/prisma/migrations/README.md, раздел
# "Existing legacy production database", шаги 1-6).
#
# Что делает:
#   1. Снимает pg_dump с ЖИВОЙ базы через уже работающий postgres-контейнер
#      (read-only операция, ничего не блокирует и не меняет).
#   2. Поднимает ОТДЕЛЬНЫЙ одноразовый postgres:16-alpine контейнер в своей
#      сети — никак не связан с боевым stack, случайный пароль, без
#      опубликованных портов.
#   3. Восстанавливает дамп В ЭТОТ отдельный контейнер.
#   4. Определяет состояние ТОЛЬКО восстановленной копии:
#      - legacy без _prisma_migrations: проверяет точный baseline, затем
#        resolve + deploy;
#      - существующая Prisma-история: проверяет failed rows, непрерывный
#        prefix и checksum каждой применённой миграции, затем deploy.
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
umask 077

DEPLOY_PATH="${1:?usage: rehearse-loyalty-migration.sh <deploy_path> <trusted_sha>}"
TRUSTED_SHA="${2:?usage: rehearse-loyalty-migration.sh <deploy_path> <trusted_sha>}"
cd "$DEPLOY_PATH"

REHEARSAL_ID="loyalty-rehearsal-$$"
REHEARSAL_NET="${REHEARSAL_ID}-net"
REHEARSAL_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
DUMP_FILE="/tmp/${REHEARSAL_ID}.dump"
SCHEMA_CONTEXT=$(mktemp -d "/tmp/${REHEARSAL_ID}-schema.XXXXXX")

cleanup() {
    echo "=== Уборка временных ресурсов ==="
    docker rm -f -v "$REHEARSAL_ID" >/dev/null 2>&1 || true
    docker network rm "$REHEARSAL_NET" >/dev/null 2>&1 || true
    rm -f -- "$DUMP_FILE"
    rm -rf -- "$SCHEMA_CONTEXT"
}
trap cleanup EXIT

fail() {
    echo "✗ $*"
    exit 1
}

sha256_file() {
    sha256sum "$1" | awk '{print $1}' | tr 'A-F' 'a-f'
}

validate_checked_in_baseline() {
    baseline_schema="$SCHEMA_CONTEXT/packages/database/prisma/baselines/0_legacy_baseline.prisma"
    baseline_sql="$SCHEMA_CONTEXT/packages/database/prisma/migrations/0_legacy_baseline/migration.sql"
    pinned_schema_sha="441c03dfc60c931d3cc22329f2651e744655279d2c332096eaf983976991a419"
    pinned_sql_sha="646f98459abb9d4ed6746810f403188b45270656c5e6ea20e89d53465a870a08"

    [ -f "$baseline_schema" ] || fail "В доверенном коммите отсутствует baseline schema."
    [ -f "$baseline_sql" ] || fail "В доверенном коммите отсутствует baseline migration.sql."
    [ "$(sha256_file "$baseline_schema")" = "$pinned_schema_sha" ] || \
        fail "Checksum baseline schema не совпадает с закреплённым значением."
    [ "$(sha256_file "$baseline_sql")" = "$pinned_sql_sha" ] || \
        fail "Checksum baseline SQL не совпадает с закреплённым значением."
    echo "✓ Закреплённые checksum baseline подтверждены."
}

build_expected_migration_list() {
    EXPECTED_MIGRATIONS="$SCHEMA_CONTEXT/expected-migrations.txt"
    EXPECTED_UNSORTED="$SCHEMA_CONTEXT/expected-migrations.unsorted.txt"
    : > "$EXPECTED_UNSORTED"
    for migration_dir in "$SCHEMA_CONTEXT"/packages/database/prisma/migrations/*; do
        [ -d "$migration_dir" ] || continue
        migration_name=$(basename "$migration_dir")
        [ -f "$migration_dir/migration.sql" ] || \
            fail "У миграции $migration_name нет migration.sql."
        case "$migration_name" in
            *[!A-Za-z0-9_-]*) fail "Недопустимое имя migration directory." ;;
        esac
        printf '%s\n' "$migration_name" >> "$EXPECTED_UNSORTED"
    done
    LC_ALL=C sort "$EXPECTED_UNSORTED" > "$EXPECTED_MIGRATIONS"

    [ -s "$EXPECTED_MIGRATIONS" ] || fail "В доверенном коммите нет миграций."
    [ "$(sed -n '1p' "$EXPECTED_MIGRATIONS")" = "0_legacy_baseline" ] || \
        fail "Первая миграция доверенного набора — не 0_legacy_baseline."
}

# Проверяет только служебную Prisma-историю на изолированной копии. В файл
# попадают лишь имена миграций и checksum, никаких пользовательских данных.
validate_clone_migration_history() {
    require_complete="${1:-false}"
    HISTORY_FILE="$SCHEMA_CONTEXT/applied-migrations.tsv"
    APPLIED_NAMES="$SCHEMA_CONTEXT/applied-migration-names.txt"
    EXPECTED_PREFIX="$SCHEMA_CONTEXT/expected-applied-prefix.txt"

    failed_count=$(docker exec "$REHEARSAL_ID" psql -U postgres -d rehearsal -Atqc \
        'SELECT count(*) FROM public."_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL;')
    [ "$failed_count" = "0" ] || fail "В clone найдены незавершённые/failed Prisma migrations: $failed_count."

    duplicate_count=$(docker exec "$REHEARSAL_ID" psql -U postgres -d rehearsal -Atqc \
        'SELECT count(*) FROM (SELECT migration_name FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL GROUP BY migration_name HAVING count(*) <> 1) AS duplicates;')
    [ "$duplicate_count" = "0" ] || fail "В clone найдены дубли активных Prisma migrations."

    docker exec "$REHEARSAL_ID" psql -U postgres -d rehearsal -AtF '|' -c \
        'SELECT migration_name, checksum FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY started_at, migration_name;' \
        > "$HISTORY_FILE"
    cut -d '|' -f 1 "$HISTORY_FILE" > "$APPLIED_NAMES"
    applied_count=$(wc -l < "$APPLIED_NAMES" | tr -d ' ')
    expected_count=$(wc -l < "$EXPECTED_MIGRATIONS" | tr -d ' ')

    [ "$applied_count" -gt 0 ] || fail "Таблица _prisma_migrations есть, но активная история пуста."
    [ "$applied_count" -le "$expected_count" ] || \
        fail "В clone применено больше миграций, чем есть в доверенном коммите."
    sed -n "1,${applied_count}p" "$EXPECTED_MIGRATIONS" > "$EXPECTED_PREFIX"
    if ! cmp -s "$APPLIED_NAMES" "$EXPECTED_PREFIX"; then
        echo "Ожидаемый prefix миграций:"
        sed 's/^/  /' "$EXPECTED_PREFIX"
        echo "Фактическая активная история clone:"
        sed 's/^/  /' "$APPLIED_NAMES"
        fail "История Prisma не является точным непрерывным prefix доверенного набора."
    fi

    while IFS='|' read -r migration_name recorded_checksum; do
        case "$migration_name" in
            *[!A-Za-z0-9_-]*) fail "Недопустимое имя в Prisma migration history." ;;
        esac
        migration_sql="$SCHEMA_CONTEXT/packages/database/prisma/migrations/$migration_name/migration.sql"
        [ -f "$migration_sql" ] || fail "В истории есть неизвестная миграция $migration_name."
        normalized_checksum=$(printf '%s' "$recorded_checksum" | tr 'A-F' 'a-f')
        case "$normalized_checksum" in
            *[!0-9a-f]*|'') fail "Некорректный checksum миграции $migration_name в Prisma history." ;;
        esac
        [ "${#normalized_checksum}" -eq 64 ] || \
            fail "Некорректная длина checksum миграции $migration_name в Prisma history."
        [ "$(sha256_file "$migration_sql")" = "$normalized_checksum" ] || \
            fail "Checksum применённой миграции $migration_name не совпадает с доверенным SQL."
    done < "$HISTORY_FILE"

    if [ "$require_complete" = "true" ] && [ "$applied_count" -ne "$expected_count" ]; then
        fail "После migrate deploy история неполна: $applied_count/$expected_count."
    fi

    echo "✓ Prisma history: $applied_count/$expected_count миграций, точный prefix и checksum подтверждены."
}

# Рабочая директория на сервере обновляется только confirmed-деплоем, а его
# как раз ещё не было — schema/migrations там могут быть старые. Берём их
# из уже проверенного (fetch-ом с канонического URL) коммита, не из
# рабочего дерева.
echo "=== 0/6: Достаём packages/database из доверенного коммита $TRUSTED_SHA ==="
git archive "$TRUSTED_SHA" -- packages/database | tar -x -C "$SCHEMA_CONTEXT"
validate_checked_in_baseline
build_expected_migration_list

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

MIGRATION_TABLE_EXISTS=$(docker exec "$REHEARSAL_ID" psql -U postgres -d rehearsal -Atqc \
    "SELECT to_regclass('public.\"_prisma_migrations\"') IS NOT NULL;")
case "$MIGRATION_TABLE_EXISTS" in
    f)
        MIGRATION_MODE="legacy"
        echo "✓ Обнаружена legacy-база без _prisma_migrations: требуется точный diff + resolve baseline."
        ;;
    t)
        MIGRATION_MODE="existing-history"
        echo "✓ Обнаружена существующая Prisma migration history: legacy diff/resolve пропускаются."
        validate_clone_migration_history false
        ;;
    *)
        fail "Не удалось однозначно определить наличие _prisma_migrations в clone."
        ;;
esac

docker run --rm --network "$REHEARSAL_NET" \
    -e DATABASE_URL="$CLONE_DATABASE_URL" \
    -e MIGRATION_MODE="$MIGRATION_MODE" \
    -v "$SCHEMA_CONTEXT/packages/database:/app/packages/database:ro" \
    -w /app/packages/database \
    node:20-alpine sh -c "
        set -e
        apk add --no-cache openssl >/dev/null
        echo '--- fetching prisma@5.22 (npx --yes, isolated from any workspace context) ---'
        npx --yes prisma@5.22 --version
        if [ \"\$MIGRATION_MODE\" = 'legacy' ]; then
            echo '--- legacy migrate diff (ожидаем пустой diff, exit 0) ---'
            npx --yes prisma@5.22 migrate diff \
                --from-url \"\$DATABASE_URL\" \
                --to-schema-datamodel prisma/baselines/0_legacy_baseline.prisma \
                --script --exit-code
            echo '--- legacy migrate resolve --applied 0_legacy_baseline ---'
            npx --yes prisma@5.22 migrate resolve --applied 0_legacy_baseline --schema prisma/schema.prisma
        else
            echo '--- existing history validated; legacy diff/resolve intentionally skipped ---'
        fi
        echo '--- migrate deploy (применит только pending migrations) ---'
        npx --yes prisma@5.22 migrate deploy --schema prisma/schema.prisma
        echo '--- migrate status ---'
        npx --yes prisma@5.22 migrate status --schema prisma/schema.prisma
    "

echo "=== Проверяем полную Prisma history после migrate deploy ==="
validate_clone_migration_history true

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
