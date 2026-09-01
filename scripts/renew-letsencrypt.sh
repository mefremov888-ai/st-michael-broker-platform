#!/usr/bin/env bash
# Продление Let's Encrypt для broker.stmichael.ru.
#
# Сертификат лежит на хосте в /etc/letsencrypt и bind-mount в nginx.
# HTTP-01 должен отдаваться с :80 БЕЗ редиректа на HTTPS — иначе при
# просроченном сертификате Let's Encrypt не проходит challenge
# (браузер показывает NET::ERR_CERT_DATE_INVALID).
#
# Использование:
#   renew-letsencrypt.sh <deploy_path> <trusted_sha> [force]
#
# trusted_sha — коммит, из которого берём nginx.conf / docker-compose.yml
# и на который (если HTTP-01 ещё не работает) переводим git checkout,
# чтобы на диске не осталось грязного дерева и следующий deploy.yml
# не упёрся в «tracked local changes». Образы api/web этот скрипт
# НЕ пересобирает.
set -euo pipefail
# Challenge-файлы читает nginx внутри контейнера (пользователь nginx).
# umask 077 оставлял бы их 600 — HTTP-01 тогда 403.
umask 022

DEPLOY_PATH="${1:?usage: renew-letsencrypt.sh <deploy_path> <trusted_sha> [force]}"
TRUSTED_SHA="${2:?usage: renew-letsencrypt.sh <deploy_path> <trusted_sha> [force]}"
FORCE="${3:-false}"
CANONICAL_REPOSITORY="https://github.com/sereganikitin/st-michael-broker-platform.git"
DOMAIN="broker.stmichael.ru"
WEBROOT="/var/www/certbot"
ACME_HEALTH_TOKEN="renew-health"
CERTBOT_IMAGE="certbot/certbot:v2.11.0"

fail() {
  echo "✗ $*" >&2
  exit 1
}

[[ "$DEPLOY_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "Invalid deploy path"
case "$DEPLOY_PATH/" in *"/../"*|*"/./"*|*"//"*) fail "Unsafe deploy path" ;; esac
[[ "$TRUSTED_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "Invalid trusted SHA"
[[ "$FORCE" == "true" || "$FORCE" == "false" ]] || fail "force must be true or false"

cd "$DEPLOY_PATH"

echo "=== Текущий сертификат (до продления) ==="
echo | openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer || echo "(не удалось прочитать текущий сертификат)"
if command -v certbot >/dev/null 2>&1; then
  certbot certificates || true
fi

ensure_webroot() {
  if mkdir -p "$WEBROOT/.well-known/acme-challenge" 2>/dev/null; then
    :
  else
    sudo -n mkdir -p "$WEBROOT/.well-known/acme-challenge"
  fi
  printf 'ok\n' > "$WEBROOT/.well-known/acme-challenge/$ACME_HEALTH_TOKEN" 2>/dev/null \
    || sudo -n sh -c "printf 'ok\\n' > '$WEBROOT/.well-known/acme-challenge/$ACME_HEALTH_TOKEN'"
  chmod 755 "$WEBROOT" "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge" 2>/dev/null \
    || sudo -n chmod 755 "$WEBROOT" "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge"
  chmod 644 "$WEBROOT/.well-known/acme-challenge/$ACME_HEALTH_TOKEN" 2>/dev/null \
    || sudo -n chmod 644 "$WEBROOT/.well-known/acme-challenge/$ACME_HEALTH_TOKEN"
}

dump_acme_debug() {
  echo "=== debug HTTP-01 ==="
  ls -ld "$WEBROOT" "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge" \
    "$WEBROOT/.well-known/acme-challenge/$ACME_HEALTH_TOKEN" || true
  docker exec st-michael-nginx ls -la /var/www/certbot/.well-known/acme-challenge/ || echo "nginx не видит $WEBROOT"
  echo "--- curl Host: $DOMAIN ---"
  curl -sS -D- -o /tmp/acme-health.body --connect-timeout 5 --max-time 10 \
    -H "Host: $DOMAIN" "http://127.0.0.1/.well-known/acme-challenge/$ACME_HEALTH_TOKEN" || true
  echo "--- body ---"
  cat /tmp/acme-health.body 2>/dev/null || true
  echo
}

acme_http_ok() {
  local code body
  code=$(curl -sS -o /tmp/acme-health.body -w '%{http_code}' --connect-timeout 5 --max-time 10 \
    -H "Host: $DOMAIN" "http://127.0.0.1/.well-known/acme-challenge/$ACME_HEALTH_TOKEN" || true)
  body=$(tr -d '\r\n' < /tmp/acme-health.body 2>/dev/null || true)
  [ "$code" = "200" ] && [ "$body" = "ok" ]
}

apply_nginx_from_trusted_sha() {
  echo "=== HTTP-01 ещё не отдаётся — применяю nginx/compose из $TRUSTED_SHA ==="
  if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then
    fail "В checkout есть локальные изменения. Сначала разберите их, иначе продление сертификата оставит дерево грязным и заблокирует следующий деплой."
  fi

  git fetch "$CANONICAL_REPOSITORY" "$TRUSTED_SHA"
  fetched=$(git rev-parse FETCH_HEAD)
  [ "$fetched" = "$TRUSTED_SHA" ] || fail "Canonical fetch SHA mismatch"

  current=$(git rev-parse HEAD)
  if [ "$current" != "$TRUSTED_SHA" ]; then
    echo "git reset --hard $TRUSTED_SHA (было $current). Образы api/web не пересобираются."
    git reset --hard "$TRUSTED_SHA"
  fi

  grep -q 'acme-challenge' docker/nginx.conf || fail "trusted SHA nginx.conf has no ACME location"
  grep -q '/var/www/certbot:/var/www/certbot' docker-compose.yml || fail "trusted SHA compose is missing certbot webroot mount"

  docker compose up -d nginx --force-recreate --no-deps
  sleep 2
  docker exec st-michael-nginx nginx -t
  if ! acme_http_ok; then
    dump_acme_debug
    fail "После обновления nginx HTTP-01 health-файл всё ещё не отдаётся с :80"
  fi
  echo "✓ HTTP-01 на :80 работает"
}

run_certbot_webroot() {
  local rc=0
  local force_args=()
  if [ "$FORCE" = "true" ]; then
    force_args=(--force-renewal)
  fi

  set +e
  if command -v certbot >/dev/null 2>&1; then
    echo "=== certbot на хосте, webroot $WEBROOT ==="
    certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
      --non-interactive --agree-tos --cert-name "$DOMAIN" \
      --preferred-challenges http \
      ${force_args[@]+"${force_args[@]}"}
    rc=$?
  else
    echo "=== certbot в Docker ($CERTBOT_IMAGE), webroot $WEBROOT ==="
    docker run --rm \
      -v /etc/letsencrypt:/etc/letsencrypt \
      -v /var/lib/letsencrypt:/var/lib/letsencrypt \
      -v "$WEBROOT:$WEBROOT" \
      "$CERTBOT_IMAGE" \
      certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
      --non-interactive --agree-tos --register-unsafely-without-email \
      --cert-name "$DOMAIN" --preferred-challenges http \
      ${force_args[@]+"${force_args[@]}"}
    rc=$?
  fi
  set -e
  return "$rc"
}

run_certbot_standalone_fallback() {
  echo "=== webroot не сработал, fallback: standalone (кратко останавливаю nginx) ==="
  docker stop st-michael-nginx
  set +e
  docker run --rm -p 80:80 \
    -v /etc/letsencrypt:/etc/letsencrypt \
    -v /var/lib/letsencrypt:/var/lib/letsencrypt \
    "$CERTBOT_IMAGE" \
    certonly --standalone -d "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email \
    --cert-name "$DOMAIN" --preferred-challenges http --force-renewal
  local rc=$?
  set -e
  docker start st-michael-nginx
  sleep 2
  [ "$rc" -eq 0 ] || fail "certbot standalone тоже не смог выпустить сертификат (exit $rc)"
}

verify_public_https() {
  echo "=== Проверка нового сертификата ==="
  docker exec st-michael-nginx nginx -s reload
  sleep 1

  local enddate end_epoch now_epoch
  enddate=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null \
    | openssl x509 -noout -enddate | sed 's/^notAfter=//')
  [ -n "$enddate" ] || fail "Не удалось прочитать notAfter нового сертификата"
  echo "notAfter=$enddate"
  end_epoch=$(date -u -d "$enddate" +%s)
  now_epoch=$(date -u +%s)
  if [ $((end_epoch - now_epoch)) -lt 604800 ]; then
    fail "Сертификат истекает меньше чем через 7 дней: $enddate"
  fi

  local code
  code=$(curl -sS -o /tmp/tls-health.json -w '%{http_code}' --connect-timeout 5 --max-time 15 \
    --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health")
  [ "$code" = "200" ] || fail "HTTPS /api/health вернул $code (ожидали 200 без -k)"
  grep -q '"status"' /tmp/tls-health.json || true
  echo "✓ HTTPS для $DOMAIN снова валиден, /api/health = 200"
}

ensure_webroot

if acme_http_ok; then
  echo "✓ HTTP-01 на :80 уже работает, nginx/compose не трогаю"
else
  apply_nginx_from_trusted_sha
fi

if ! run_certbot_webroot; then
  echo "webroot certbot завершился ошибкой"
  run_certbot_standalone_fallback
fi

verify_public_https
echo "=== Продление TLS завершено ==="
