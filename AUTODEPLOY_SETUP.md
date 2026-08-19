# Настройка защищённого production deploy

**Цель:** после merge в `master` GitHub автоматически выполняет build/tests.
Production SSH deploy запускается отдельно через `Run workflow`, только для
точного SHA текущего `master`, после подтверждения backup/clone rehearsal и
approval защищённого Environment `production`.

**Время на разовую настройку:** ~5–10 минут.
**После настройки:** проверки автоматические, production rollout намеренно
требует ручного подтверждения и approval.

---

## Что нужно от тебя (Сергей)

1. SSH-ключ от сервера 72.56.241.199 (тот, которым ты заходишь сам — или новый специально для GitHub)
2. Знание пути на сервере где лежит репо (например `/opt/st-michael` или `/root/st-michael-broker-platform`)
3. Доступ в **Settings → Secrets and variables → Actions** в репозитории `sereganikitin/st-michael-broker-platform`

---

## Шаг 1. (Рекомендую) Создать отдельный SSH-ключ для GitHub

Если уже есть ключ — пропускай шаг и используй его. Если нет — на твоём компе:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github-deploy -N "" -C "github-actions-deploy"
```

Создаст два файла:
- `~/.ssh/github-deploy` — приватный ключ (его в GitHub секрет)
- `~/.ssh/github-deploy.pub` — публичный (его на сервер)

## Шаг 2. Авторизовать ключ на сервере

```bash
# Скопировать публичный ключ на сервер 72.56.241.199
ssh-copy-id -i ~/.ssh/github-deploy.pub <user>@72.56.241.199
# Или вручную добавить содержимое github-deploy.pub в ~/.ssh/authorized_keys на сервере
```

Проверь что заходит:
```bash
ssh -i ~/.ssh/github-deploy <user>@72.56.241.199 "echo OK"
```
Должно вывести `OK`.

## Шаг 3. Добавить deploy-секреты и production variables

В репо `sereganikitin/st-michael-broker-platform` → **Settings → Secrets and variables → Actions → New repository secret**:

| Имя секрета | Значение | Пример |
|---|---|---|
| `DEPLOY_HOST` | IP или домен сервера | `72.56.241.199` |
| `DEPLOY_USER` | SSH-юзер | `root` или `deploy` или твой логин |
| `DEPLOY_SSH_KEY` | Содержимое **приватного** ключа `~/.ssh/github-deploy` (от `-----BEGIN ...` до `-----END ...` включительно) | `-----BEGIN OPENSSH PRIVATE KEY-----`<br>`...`<br>`-----END OPENSSH PRIVATE KEY-----` |
| `DEPLOY_PATH` | Путь к репо на сервере | `/opt/st-michael-broker-platform` |

Опционально — если SSH-порт не 22:
| `DEPLOY_PORT` | Порт | `2222` |

В **Settings → Environments → production** включи required reviewers,
запрети self-approval и разреши deployment только из `master`. В environment
добавь две переменные (не secrets):

| Имя | Что записать |
|---|---|
| `PRODUCTION_PG_SYSTEM_IDENTIFIER` | точный `system_identifier`, полученный read-only preflight workflow |
| `PRODUCTION_MIN_BROKER_ROWS` | согласованный нижний порог количества брокеров, меньше которого deploy запрещён |

Токены интеграций добавляются как GitHub Secrets по инструкциям
`docs/telegram-ops-monitoring.md` и `docs/mango-setup.md`. Многострочный Google
Service Account JSON сначала сохрани как валидный однострочный minified JSON;
workflow намеренно отклоняет секреты с реальными переводами строк.

## Шаг 4. Убедиться что на сервере есть `deploy-update.sh`

Зайди на сервер, проверь:
```bash
cd /opt/st-michael-broker-platform   # подставь твой путь
ls -la deploy-update.sh
```

Для первого migration-aware релиза не запускай старую копию скрипта вручную.
Сначала merge reviewed PR, затем выполни baseline/clone runbook из
`packages/database/prisma/migrations/README.md`; deployment запускается только
защищённым workflow для точного SHA `master`.

## Шаг 5. Тест workflow

После успешного backup, restore на изолированном clone и baseline rehearsal:

1. GitHub → **Actions → Deploy to production**.
2. Открой зелёный verify-run для текущего SHA `master`.
3. Нажми **Run workflow**, выбери `master`.
4. Поставь `confirm_production = true`.
5. Нажми **Run workflow** и дождись approval второго reviewer для environment
   `production`.

Deploy выполняется только после повторной сборки и тестов exact SHA. В логах
будут: проверка SHA/БД, чистая сборка образов, `prisma migrate deploy`, rollout,
readiness PostgreSQL+Redis, контейнеры, nginx и внешний HTTPS.

Если что-то падает — лог расскажет что именно. Чаще всего:
- неверный путь в `DEPLOY_PATH` → проверь
- нет прав на `~/.ssh/authorized_keys` на сервере → `chmod 600 ~/.ssh/authorized_keys`
- нет Docker Compose v2 или host tools → установить их до повторного запуска;
  fallback на legacy `docker-compose` намеренно отсутствует
- не совпадает DB identity/count → остановиться и проверить volume/project, а
  не снижать проверку вслепую

---

## Что происходит в workflow

`push` в `master` запускает только build/tests. Production SSH deployment
запускается исключительно вручную через `workflow_dispatch` с подтверждением и
approval защищённого environment.

GitHub Actions подключается к серверу по SSH и выполняет `bash deploy-update.sh`, который:

1. Проверяет обязательный SHA, server lock и identity существующей production БД.
2. Собирает API/web из чистого `git archive` exact SHA, пока старый сервис жив.
3. До замены контейнеров выполняет только `prisma migrate deploy`; `db push` и
   `--accept-data-loss` в production запрещены.
4. Заменяет только `api` и `web`, выполняет graceful reload уже работающего
   `nginx`, чтобы он разрешил новые Docker-адреса, затем проверяет
   `/api/health/ready`, web и внешний HTTPS. PostgreSQL, Redis и nginx этот
   application workflow не пересоздаёт; изменение их портов/образов выполняется в отдельное
   согласованное maintenance window.
5. Сохраняет SHA и прежние image IDs для расследования/отката. Business seeds,
   amo inspection и принудительное обновление CMS не запускаются.

Время зависит от чистой Docker-сборки и миграций; рассчитывай до 75 минут,
особенно при холодном cache.

---

## Что меняется в твоём workflow после настройки

**Было:**
1. mefremov888-ai создаёт PR
2. Сергей ревьювит, мержит
3. Сергей идёт на сервер, делает `git pull && docker compose up -d --build`
4. Сергей запускает `refresh-cms-content.js` если нужно

**Стало:**
1. mefremov888-ai создаёт PR.
2. Сергей ревьювит и мержит; автоматический verify обязан стать зелёным.
3. Ответственный оператор подтверждает backup/clone/baseline, запускает manual
   workflow и второй reviewer разрешает production environment.

Заказчик правит контент через админку (`/admin/content`, `/admin/promos`) — это вообще не требует мержей или деплоя, всё в БД.

---

## Безопасность

- Приватный ключ хранится **только** в GitHub Secrets — он зашифрован, виден только в момент запуска workflow, в логах не печатается.
- При угрозе компрометации — удали публичный ключ с сервера (`~/.ssh/authorized_keys`) и сгенерируй новый.
- Ограничивай deploy key отдельным системным пользователем и минимальными sudo
  permissions. Не задавай forced command только `bash deploy-update.sh`: workflow
  передаёт обязательные SHA/DB identity variables и выполняет безопасный bootstrap.

---

## Откат при проблеме

Перед rollout скрипт фиксирует старые image IDs и создаёт локальные rollback
tags/override в `/var/backups/stmichael/releases`. Если новый `api`/`web` не
проходит readiness, container или внешний HTTPS smoke, скрипт автоматически
возвращает предыдущие образы и запускает старый API напрямую, не вызывая его
legacy migration-entrypoint. Additive DB migrations при этом остаются
применёнными; автоматического отката данных нет. Workflow завершится красным,
даже если старое приложение успешно восстановлено — назначенный production
operator обязан проверить сайт и открыть incident.

После аварийного восстановления не делай прямой `git reset`/обычный
`docker compose up` на сервере. Ручной `Run workflow`
всегда разворачивает только текущий `master`: workflow
сверяет event SHA с `origin/master` и откажется выкатывать тег, старый commit
или master, который изменился после запуска. Для отката сначала создать
reviewed revert-коммит/PR в `master`, дождаться CI и approval environment
`production`, затем запустить обычный deploy. Не использовать старые
backup-ветки как непроверенный источник production-кода. Если миграция уже
применена, отдельно следовать migration runbook: откат кода не является откатом
данных.

---

## Контакты при вопросах

Заказчик (mefremov888-ai) — https://github.com/mefremov888-ai
