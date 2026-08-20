#!/bin/bash
# Скрипт обновления продакшна запускается только защищённым GitHub workflow,
# который передаёт точный EXPECTED_DEPLOY_SHA. Прямой deploy latest-master
# запрещён: без SHA скрипт завершается до сборки/миграций.
#
# Что делает:
#   1) Подтягивает свежий master из git origin
#   2) Пересобирает Docker-образы и перезапускает контейнеры
#   3) До замены API проверяет baseline и применяет миграции одноразовым контейнером
#   4) Проверяет readiness нового API и состояние миграций
#
# Идемпотентен — можно запускать сколько угодно раз подряд.

set -euo pipefail
if [ -n "${DEPLOY_REPO_DIR:-}" ]; then
    cd "$DEPLOY_REPO_DIR"
else
    cd "$(dirname "$0")"
fi

for REQUIRED_TOOL in git docker curl flock sha256sum awk grep sed tar mktemp rm cp readlink sudo; do
    if ! command -v "$REQUIRED_TOOL" >/dev/null 2>&1; then
        echo "Required deployment tool is missing: $REQUIRED_TOOL"
        exit 1
    fi
done
if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is required; the legacy docker-compose client is not supported."
    exit 1
fi

if [ "${DEPLOY_LOCK_HELD:-0}" = "1" ]; then
    if [ "$(readlink /proc/$$/fd/8 2>/dev/null || true)" != "/tmp/st-michael-production-deploy.lock" ] \
        || ! flock -n 8; then
        echo "DEPLOY_LOCK_HELD was set without the inherited production lock."
        exit 1
    fi
else
    exec 9>/tmp/st-michael-production-deploy.lock
    if ! flock -n 9; then
        echo "Another production deploy/migration process holds the server lock."
        exit 1
    fi
fi

ENV_STAGING_FILE=""
RELEASE_CONTEXT=""
cleanup_temporary_files() {
    case "${ENV_STAGING_FILE:-}" in
        "$(pwd)"/.env.staging.*) rm -f -- "$ENV_STAGING_FILE" ;;
        "") ;;
        *) echo "Refusing to remove unexpected env staging path: $ENV_STAGING_FILE" >&2 ;;
    esac
    case "${RELEASE_CONTEXT:-}" in
        /tmp/st-michael-release.*) rm -rf -- "$RELEASE_CONTEXT" ;;
        "") ;;
        *) echo "Refusing to remove unexpected release context: $RELEASE_CONTEXT" >&2 ;;
    esac
}
trap cleanup_temporary_files EXIT

# Включаем BuildKit — нужен для:
#   - cache mounts в Dockerfile (RUN --mount=type=cache,target=/root/.npm)
#   - syntax=docker/dockerfile:1.6 директивы
# Без BuildKit npm install прогоняется с нуля каждый раз → сборка ~40 минут
# вместо ~5. См. docker/Dockerfile.api и docker/Dockerfile.web.
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

echo "==> Рабочая директория: $(pwd)"

PREVIOUS_DEPLOY_SHA=$(git rev-parse HEAD)
export PREVIOUS_DEPLOY_SHA

COMPOSE_CMD="docker compose"
echo "==> Используем: $COMPOSE_CMD"

# Bind every Compose command (including the clean-context build below) to the
# existing production project. This prevents a different working-directory
# name from creating a second set of volumes/containers.
COMPOSE_PROJECT_NAME=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' st-michael-postgres 2>/dev/null || true)
if [ -z "$COMPOSE_PROJECT_NAME" ]; then
    echo "Cannot determine the existing production Compose project from st-michael-postgres."
    exit 1
fi
export COMPOSE_PROJECT_NAME

# 1) Pull latest master
echo ""
echo "==> [1/5] Pulling latest master..."
if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then
    echo "    ✗ Production checkout has tracked local changes."
    echo "      Deployment will not erase an unreviewed hotfix/configuration; reconcile it through a reviewed commit first."
    exit 1
fi
EXPECTED_ORIGIN_URL="https://github.com/sereganikitin/st-michael-broker-platform.git"
CURRENT_ORIGIN_URL=$(git remote get-url origin)
if [ "$CURRENT_ORIGIN_URL" != "$EXPECTED_ORIGIN_URL" ]; then
    echo "    origin differs from the canonical production repository; correcting it without printing the old URL."
    git remote set-url origin "$EXPECTED_ORIGIN_URL"
fi
git fetch origin
ACTUAL_MASTER_SHA=$(git rev-parse origin/master)
if ! printf '%s' "${EXPECTED_DEPLOY_SHA:-}" | grep -Eq '^[0-9a-f]{40}$'; then
    echo "    ✗ EXPECTED_DEPLOY_SHA (40 lowercase hex characters) is required."
    echo "      Run deployment through the reviewed GitHub workflow; direct latest-master deploys are forbidden."
    exit 1
fi
if [ "$ACTUAL_MASTER_SHA" != "$EXPECTED_DEPLOY_SHA" ]; then
    echo "    ✗ origin/master changed after the workflow started."
    echo "      expected: $EXPECTED_DEPLOY_SHA"
    echo "      actual:   $ACTUAL_MASTER_SHA"
    echo "      Refusing to deploy an unverified commit."
    exit 1
fi
git reset --hard origin/master
echo "    HEAD: $(git log --oneline -1)"

# Update optional integration credentials while holding the same server-side
# lock as migrations/rollout. Values are read from the workflow environment,
# never interpolated into shell source, and are persisted as literal quoted
# dotenv values so spaces, `$` and JSON punctuation are preserved.
SERVER_ENV_FILE="$(pwd)/.env"
if [ ! -f "$SERVER_ENV_FILE" ]; then
    echo "    ✗ Server .env is missing; refusing to create an insecure default config."
    exit 1
fi
umask 077
chmod 600 "$SERVER_ENV_FILE"

for REQUIRED_VAR in POSTGRES_PASSWORD JWT_SECRET; do
    REQUIRED_VALUE=$(awk -F= -v key="$REQUIRED_VAR" '$1==key {sub(/^[^=]*=/, ""); print; exit}' "$SERVER_ENV_FILE")
    case "$REQUIRED_VALUE" in
        \'*\') REQUIRED_VALUE=${REQUIRED_VALUE:1:${#REQUIRED_VALUE}-2} ;;
        \"*\") REQUIRED_VALUE=${REQUIRED_VALUE:1:${#REQUIRED_VALUE}-2} ;;
    esac
    if [ -z "$REQUIRED_VALUE" ]; then
        echo "    ✗ $REQUIRED_VAR is missing in server .env."
        exit 1
    fi
    if [ "$REQUIRED_VAR" = "POSTGRES_PASSWORD" ] \
        && { [ "$REQUIRED_VALUE" = "postgres" ] || [ ${#REQUIRED_VALUE} -lt 16 ]; }; then
        echo "    ✗ POSTGRES_PASSWORD is default/too short."
        exit 1
    fi
    if [ "$REQUIRED_VAR" = "JWT_SECRET" ] \
        && { [ "$REQUIRED_VALUE" = "change-me-in-production" ] || [ ${#REQUIRED_VALUE} -lt 32 ]; }; then
        echo "    ✗ JWT_SECRET is default/too short."
        exit 1
    fi
done

ENV_STAGING_FILE=$(mktemp "$(pwd)/.env.staging.XXXXXX")
cp "$SERVER_ENV_FILE" "$ENV_STAGING_FILE"
chmod 600 "$ENV_STAGING_FILE"

update_env_value() {
    local var_name="$1"
    local var_value="$2"
    local escaped_value
    local env_tmp
    case "$var_value" in
        *$'\r'*|*$'\n'*)
            echo "    ✗ $var_name must be one line; minify JSON and keep \\n as escaped characters."
            return 1
            ;;
    esac
    env_tmp=$(mktemp "${ENV_STAGING_FILE}.tmp.XXXXXX")
    if ! awk -v var="$var_name" '
        BEGIN { skip=0 }
        $0 ~ "^" var "=" { skip=1; next }
        skip && /^[A-Z_][A-Z0-9_]*=/ { skip=0 }
        !skip { print }
    ' "$ENV_STAGING_FILE" > "$env_tmp"; then
        rm -f -- "$env_tmp"
        return 1
    fi
    mv "$env_tmp" "$ENV_STAGING_FILE"
    escaped_value=$(printf '%s' "$var_value" | sed "s/'/\\\\'/g")
    printf "%s='%s'\n" "$var_name" "$escaped_value" >> "$ENV_STAGING_FILE"
    echo "    $var_name accepted (${#var_value} characters)."
}

for VAR_NAME in \
    AMO_ACCESS_TOKEN AMO_CLIENT_ID AMO_CLIENT_SECRET AMO_REFRESH_TOKEN \
    MANGO_API_KEY MANGO_API_SALT MANGO_API_URL MANGO_CALLBACK_URL MANGO_OUTBOUND_LINE \
    SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM SMTP_SECURE \
    DADATA_API_KEY ANTHROPIC_API_KEY GOOGLE_SERVICE_ACCOUNT_JSON \
    TELEGRAM_BOT_TOKEN OPS_TELEGRAM_BOT_TOKEN OPS_ALERT_CHAT_ID OPS_ALERT_CHAT_IDS; do
    VAR_VALUE=$(printenv "$VAR_NAME" || true)
    if [ -n "$VAR_VALUE" ]; then
        update_env_value "$VAR_NAME" "$VAR_VALUE"
    fi
done
# 2026-08-20: пишем реально задеплоенный SHA в .env, читается через
# GET /api/health (см. health.controller.ts) — способ проверить, что сервер
# на самом деле обновился, а не просто "workflow прошёл зелёным".
update_env_value "GIT_SHA" "$EXPECTED_DEPLOY_SHA"
chmod 600 "$ENV_STAGING_FILE"
docker compose --env-file "$ENV_STAGING_FILE" config --quiet >/dev/null

# `git reset --hard` does not remove untracked or ignored files. We still flag
# unexpected untracked paths for operators, but image builds below use a clean
# `git archive` of the exact reviewed SHA so ignored PII/artifacts cannot enter
# Docker through `COPY . .`.
git cat-file -e "$EXPECTED_DEPLOY_SHA:.dockerignore" || {
    echo "    ✗ Reviewed commit does not contain .dockerignore."
    exit 1
}
git diff --quiet --exit-code || {
    echo "    ✗ Tracked server checkout differs from the reviewed commit."
    exit 1
}
UNTRACKED_FILES=$(git ls-files --others --exclude-standard)
UNEXPECTED_UNTRACKED=$(printf '%s\n' "$UNTRACKED_FILES" | awk '
    NF == 0 { next }
    /^uploads\// { next }
    /^docker\/ssl\// { next }
    /^\.env\.staging\.[A-Za-z0-9]+$/ { next }
    { print }
')
if [ -n "$UNEXPECTED_UNTRACKED" ]; then
    echo "    ✗ Unexpected untracked files in production checkout:"
    printf '%s\n' "$UNEXPECTED_UNTRACKED"
    echo "      Move/review them manually; deployment will not delete files automatically."
    exit 1
fi

RELEASE_CONTEXT=$(mktemp -d /tmp/st-michael-release.XXXXXX)
git archive "$EXPECTED_DEPLOY_SHA" | tar -x -C "$RELEASE_CONTEXT"
if [ "$(git -C "$RELEASE_CONTEXT" rev-parse --is-inside-work-tree 2>/dev/null || true)" = "true" ]; then
    echo "Clean release context unexpectedly contains Git metadata."
    exit 1
fi

verify_prisma_baseline() {
    if [ -z "${PRODUCTION_PG_SYSTEM_IDENTIFIER:-}" ]; then
        echo "    ✗ PRODUCTION_PG_SYSTEM_IDENTIFIER is required; refusing an unbound production database."
        exit 1
    fi
    if ! printf '%s' "${PRODUCTION_MIN_BROKER_ROWS:-}" | grep -Eq '^[1-9][0-9]*$'; then
        echo "    ✗ PRODUCTION_MIN_BROKER_ROWS must be a reviewed positive integer."
        exit 1
    fi

    ACTUAL_DATABASE=$($COMPOSE_CMD exec -T postgres psql -U postgres -d broker_platform -Atqc \
        "SELECT current_database()")
    ACTUAL_SYSTEM_IDENTIFIER=$($COMPOSE_CMD exec -T postgres psql -U postgres -d broker_platform -Atqc \
        "SELECT system_identifier FROM pg_control_system()")
    if [ "$ACTUAL_DATABASE" != "broker_platform" ] \
        || [ "$ACTUAL_SYSTEM_IDENTIFIER" != "$PRODUCTION_PG_SYSTEM_IDENTIFIER" ]; then
        echo "    ✗ Production database identity mismatch."
        echo "      expected database=broker_platform system_identifier=$PRODUCTION_PG_SYSTEM_IDENTIFIER"
        echo "      actual   database=$ACTUAL_DATABASE system_identifier=$ACTUAL_SYSTEM_IDENTIFIER"
        exit 1
    fi

    LEGACY_SCHEMA_EXISTS=$($COMPOSE_CMD exec -T postgres psql -U postgres -d broker_platform -Atqc \
        "SELECT to_regclass('public.brokers') IS NOT NULL")
    MIGRATION_HISTORY_EXISTS=$($COMPOSE_CMD exec -T postgres psql -U postgres -d broker_platform -Atqc \
        "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")

    # This workflow is production-update only. A missing brokers table means a
    # wrong/empty volume or Compose project, never a fresh-install signal.
    if [ "$LEGACY_SCHEMA_EXISTS" != "t" ]; then
        echo "    ✗ Production brokers table is missing; refusing to initialize an empty database."
        exit 1
    fi

    BROKER_ROWS=$($COMPOSE_CMD exec -T postgres psql -U postgres -d broker_platform -Atqc \
        "SELECT COUNT(*) FROM public.brokers")
    if ! printf '%s' "$BROKER_ROWS" | grep -Eq '^[0-9]+$' \
        || [ "$BROKER_ROWS" -lt "$PRODUCTION_MIN_BROKER_ROWS" ]; then
        echo "    ✗ Broker row-count invariant failed: actual=$BROKER_ROWS minimum=$PRODUCTION_MIN_BROKER_ROWS."
        exit 1
    fi

    if [ "$MIGRATION_HISTORY_EXISTS" != "t" ]; then
        echo "    ✗ Deployment blocked before container replacement: legacy database has no Prisma baseline."
        echo "      Follow packages/database/prisma/migrations/README.md on an isolated clone first."
        exit 1
    fi

    UNFINISHED_MIGRATIONS=$($COMPOSE_CMD exec -T postgres psql -U postgres -d broker_platform -Atqc \
        "SELECT COUNT(*) FROM public.\"_prisma_migrations\" WHERE finished_at IS NULL AND rolled_back_at IS NULL")
    if [ "$UNFINISHED_MIGRATIONS" -ne 0 ]; then
        echo "    ✗ Deployment blocked before container replacement: unfinished Prisma migration rows: $UNFINISHED_MIGRATIONS."
        exit 1
    fi

    BASELINE_APPLIED=$($COMPOSE_CMD exec -T postgres psql -U postgres -d broker_platform -Atqc \
        "SELECT EXISTS (SELECT 1 FROM public.\"_prisma_migrations\" WHERE migration_name = '0_legacy_baseline' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)")
    if [ "$BASELINE_APPLIED" != "t" ]; then
        echo "    ✗ Deployment blocked before container replacement: 0_legacy_baseline is not recorded as applied."
        echo "      Follow packages/database/prisma/migrations/README.md; never mark it applied without the clone fingerprint check."
        exit 1
    fi

    EXPECTED_BASELINE_CHECKSUM=$(sha256sum packages/database/prisma/migrations/0_legacy_baseline/migration.sql | awk '{print $1}')
    STORED_BASELINE_CHECKSUM=$($COMPOSE_CMD exec -T postgres psql -U postgres -d broker_platform -Atqc \
        "SELECT checksum FROM public.\"_prisma_migrations\" WHERE migration_name = '0_legacy_baseline' AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1")
    if [ "$STORED_BASELINE_CHECKSUM" != "$EXPECTED_BASELINE_CHECKSUM" ]; then
        echo "    ✗ Deployment blocked before container replacement: baseline checksum does not match the reviewed SQL."
        exit 1
    fi
}

echo ""
echo "==> Preflight existing PostgreSQL/Redis before any build or replacement..."
for REQUIRED_CONTAINER in \
    st-michael-postgres st-michael-redis st-michael-api st-michael-web st-michael-nginx; do
    if [ "$(docker inspect --format '{{.State.Running}}' "$REQUIRED_CONTAINER" 2>/dev/null || true)" != "true" ]; then
        echo "    ✗ Existing production container is not running: $REQUIRED_CONTAINER"
        echo "      This update-only workflow will not create/restart infrastructure implicitly."
        exit 1
    fi
done
if ! docker exec st-michael-postgres pg_isready -U postgres -d broker_platform >/dev/null 2>&1; then
    echo "    ✗ Existing production PostgreSQL is not ready; nothing has been replaced."
    exit 1
fi
if [ "$(docker exec st-michael-redis redis-cli ping 2>/dev/null || true)" != "PONG" ]; then
    echo "    ✗ Existing production Redis is not ready; nothing has been replaced."
    exit 1
fi
if ! docker exec st-michael-api wget -qO- http://localhost:4000/api/health 2>/dev/null \
    | grep -q '"status":"ok"'; then
    echo "    ✗ Existing production API is not healthy enough to serve as a rollback target."
    exit 1
fi
if ! curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    https://broker.stmichael.ru/ > /dev/null; then
    echo "    ✗ Existing external site is unavailable; use the incident runbook, not normal deployment."
    exit 1
fi
verify_prisma_baseline
mv "$ENV_STAGING_FILE" "$SERVER_ENV_FILE"
ENV_STAGING_FILE=""
chmod 600 "$SERVER_ENV_FILE"
echo "    ✓ Existing database identity, baseline and Redis preflight passed"

# 2) Rebuild images while the current containers continue serving traffic.
echo ""
echo "==> [2/5] Rebuild образов..."
ROLLBACK_DIR=/var/backups/stmichael/releases
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$ROLLBACK_DIR"
RELEASE_TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
ROLLBACK_RECORD="$ROLLBACK_DIR/release-$RELEASE_TIMESTAMP.txt"
ROLLBACK_OVERRIDE="$ROLLBACK_DIR/rollback-$RELEASE_TIMESTAMP.yml"
ROLLBACK_API_TAG="st-michael-rollback-api:$RELEASE_TIMESTAMP"
ROLLBACK_WEB_TAG="st-michael-rollback-web:$RELEASE_TIMESTAMP"
PREVIOUS_API_IMAGE=$(docker inspect --format '{{.Image}}' st-michael-api 2>/dev/null || true)
PREVIOUS_WEB_IMAGE=$(docker inspect --format '{{.Image}}' st-michael-web 2>/dev/null || true)
PREVIOUS_NGINX_IMAGE=$(docker inspect --format '{{.Image}}' st-michael-nginx 2>/dev/null || true)
for PREVIOUS_IMAGE in "$PREVIOUS_API_IMAGE" "$PREVIOUS_WEB_IMAGE" "$PREVIOUS_NGINX_IMAGE"; do
    if ! printf '%s' "$PREVIOUS_IMAGE" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
        echo "    ✗ Cannot capture a valid previous application image for fast rollback."
        exit 1
    fi
done
docker tag "$PREVIOUS_API_IMAGE" "$ROLLBACK_API_TAG"
docker tag "$PREVIOUS_WEB_IMAGE" "$ROLLBACK_WEB_TAG"
{
    echo "previous_commit=${PREVIOUS_DEPLOY_SHA:-unknown}"
    echo "target_commit=$EXPECTED_DEPLOY_SHA"
    echo "previous_api_image=$PREVIOUS_API_IMAGE"
    echo "previous_web_image=$PREVIOUS_WEB_IMAGE"
    echo "previous_nginx_image=$PREVIOUS_NGINX_IMAGE"
} > "$ROLLBACK_RECORD"
chmod 600 "$ROLLBACK_RECORD"
{
    echo "services:"
    echo "  api:"
    echo "    image: \"$ROLLBACK_API_TAG\""
    echo '    entrypoint: ["/bin/sh", "-c", "exec node apps/api/dist/main.js"]'
    echo "  web:"
    echo "    image: \"$ROLLBACK_WEB_TAG\""
} > "$ROLLBACK_OVERRIDE"
chmod 600 "$ROLLBACK_OVERRIDE"
echo "    rollback metadata: $ROLLBACK_RECORD"
echo "    rollback override: $ROLLBACK_OVERRIDE"

reload_nginx_upstreams() {
    # nginx resolves static upstream hostnames when it loads the configuration.
    # Recreated api/web containers can receive new Docker IPs, so a graceful
    # reload is required after both rollout and rollback. Existing workers keep
    # serving traffic if validation or reload fails.
    if ! $COMPOSE_CMD exec -T nginx nginx -t; then
        echo "    ✗ nginx configuration validation failed."
        return 1
    fi
    if ! $COMPOSE_CMD exec -T nginx nginx -s reload; then
        echo "    ✗ nginx graceful reload failed."
        return 1
    fi
}

rollback_application() {
    echo "    Attempting fast application rollback; additive DB migrations stay applied."
    if ! $COMPOSE_CMD -f docker-compose.yml -f "$ROLLBACK_OVERRIDE" up -d \
        --no-deps --no-build --pull never --force-recreate api web; then
        echo "    ✗ Fast rollback command failed; page the production operator immediately."
        return 1
    fi
    if ! reload_nginx_upstreams; then
        echo "    ✗ Previous images started, but nginx could not refresh their Docker addresses."
        return 1
    fi
    for i in {1..30}; do
        if $COMPOSE_CMD exec -T api wget -qO- http://localhost:4000/api/health 2>/dev/null \
            | grep -q '"status":"ok"'; then
            if curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
                https://broker.stmichael.ru/ > /dev/null; then
                echo "    ✓ Previous API/web images restored. Investigate before retrying deploy."
                return 0
            fi
        fi
        sleep 2
    done
    echo "    ✗ Previous images were started but rollback smoke-test failed; page the production operator."
    return 1
}

fail_after_rollout() {
    local reason="$1"
    echo "    ✗ $reason"
    $COMPOSE_CMD logs --tail=120 api web 2>/dev/null || true
    rollback_application || true
    exit 1
}
# 2026-06-25: строим api и web ПО ОЧЕРЕДИ, не параллельно. При пустом
# buildkit кеше параллельный `npm install` для api + web суммарно жрёт
# >2 ГБ RAM → OOM-killer убивает процесс → SSH сессия рвётся без exit
# кода (run 28107132638, 28179889464). После того как кеш слоя npm install
# прогрелся — оба билда становятся CACHED и параллелизм безопасен,
# но последовательная сборка работает в любом случае.
docker compose --project-name "$COMPOSE_PROJECT_NAME" \
    --project-directory "$RELEASE_CONTEXT" --env-file "$SERVER_ENV_FILE" \
    -f "$RELEASE_CONTEXT/docker-compose.yml" build api
docker compose --project-name "$COMPOSE_PROJECT_NAME" \
    --project-directory "$RELEASE_CONTEXT" --env-file "$SERVER_ENV_FILE" \
    -f "$RELEASE_CONTEXT/docker-compose.yml" build web

# 3) Apply migrations with the NEW image before replacing the healthy API.
# Prisma Migrate was introduced after the legacy production database already
# existed, so the one-time baseline must have been rehearsed and recorded.
# This is an update-only workflow; fresh/empty databases are always rejected.
echo ""
echo "==> [3/5] Preflight baseline и Prisma migrations..."
$COMPOSE_CMD run --rm --no-deps --entrypoint npx api prisma migrate deploy \
    --schema=/app/packages/database/prisma/schema.prisma
echo "    ✓ Миграции применены до замены API"

# Replace application containers only after migration success. PostgreSQL,
# Redis and nginx are deliberately not recreated here: infrastructure/config
# restarts need a separate maintenance window and must not cause surprise
# downtime during an application release.
if ! $COMPOSE_CMD up -d --no-deps api web; then
    fail_after_rollout "Application container replacement failed."
fi
if ! reload_nginx_upstreams; then
    fail_after_rollout "nginx could not refresh the recreated API/web upstream addresses."
fi

# 4) Wait for API to be ready
echo ""
echo "==> [4/5] Ждём готовности API..."
API_READY=0
for i in {1..30}; do
    if $COMPOSE_CMD exec -T api wget -qO- http://localhost:4000/api/health/ready 2>/dev/null \
        | grep -q '"status":"ok"'; then
        echo "    API, PostgreSQL и Redis готовы"
        API_READY=1
        break
    fi
    sleep 2
done
if [ "$API_READY" -ne 1 ]; then
    fail_after_rollout "Readiness не пройден: проверить API, PostgreSQL, Redis и обязательные миграции."
fi

echo "    Проверяю обязательные контейнеры..."
RUNNING_SERVICES=$($COMPOSE_CMD ps --status running --services)
for SERVICE in postgres redis api web nginx; do
    if ! printf '%s\n' "$RUNNING_SERVICES" | grep -qx "$SERVICE"; then
        $COMPOSE_CMD ps || true
        fail_after_rollout "Контейнер $SERVICE не работает после rollout."
    fi
done

echo "    Проверяю nginx и внешний HTTPS route..."
if ! curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    http://127.0.0.1/ > /dev/null; then
    fail_after_rollout "Local nginx smoke-test failed after rollout."
fi
EXTERNAL_READY=0
for i in {1..12}; do
    if curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
        https://broker.stmichael.ru/api/health/ready \
        | grep -q '"status":"ok"'; then
        EXTERNAL_READY=1
        break
    fi
    sleep 5
done
if [ "$EXTERNAL_READY" -ne 1 ]; then
    fail_after_rollout "External HTTPS readiness failed after rollout."
fi
if ! curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    https://broker.stmichael.ru/ > /dev/null; then
    fail_after_rollout "External web smoke-test failed after rollout."
fi
echo "    ✓ web, nginx and external HTTPS are available"

# 5) Verify migration state. Production never uses db push/accept-data-loss:
# custom CHECK constraints, partial indexes and deferred triggers live in SQL migrations.
echo ""
echo "==> [5/5] Проверка миграций и обновление CMS-контента..."
if ! $COMPOSE_CMD exec -T api npx prisma migrate status \
    --schema=/app/packages/database/prisma/schema.prisma; then
    fail_after_rollout "New API reports an invalid Prisma migration state."
fi
echo "    ✓ Все Prisma migrations применены"

# 2026-05-26 КРИТИЧНЫЙ ФИКС: раньше скрипт делал UPSERT и стирал правки
# админа из /admin/content при каждом деплое. Теперь — только CREATE
# (sites без записи), а в этом случае мы и так полагаемся на
# cms.seedDefaults() при старте API. Запуск отдельным скриптом убран.
# Для ручной перезаписи запустить вручную:
#   $COMPOSE_CMD exec api node /app/scripts/refresh-cms-content.js          # safe: skip existing
#   $COMPOSE_CMD exec api node -e 'process.env.FORCE=1' /app/scripts/refresh-cms-content.js  # force
# или: $COMPOSE_CMD exec -e FORCE=1 api node /app/scripts/refresh-cms-content.js
echo "    (refresh-cms-content пропущен — правки админа сохраняются между деплоями)"

# Data seeds and amoCRM inspection are intentionally not part of application
# deployment. Run their dedicated reviewed workflows after rollout if needed;
# a code/migration release must not mutate unrelated business content.
echo "    (business seeds and amoCRM inspection skipped by design)"

# Status check
echo ""
echo "==> Состояние контейнеров:"
$COMPOSE_CMD ps

echo ""
echo "✓ Деплой завершён успешно"
echo "  Сайт: https://72.56.241.199/"
echo "  Свежий коммит: $(git log --oneline -1)"
