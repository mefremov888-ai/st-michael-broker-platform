# Mango Office: production setup

Пошаговая пользовательская инструкция для администраторов и операторов:
[`docs/mango-user-guide.md`](./mango-user-guide.md).

Этот документ описывает настройку без записи реальных ключей в репозиторий и без прямых SQL-изменений production.

## Конфигурация

API-контейнер принимает:

- `MANGO_API_KEY` — код ВАТС;
- `MANGO_API_SALT` — секрет подписи запросов и входящих webhook;
- `MANGO_API_URL` — базовый VPBX URL;
- `MANGO_CALLBACK_URL` — legacy integration-webhook шаблон; URL может содержать credential-like query parameters и считается секретом;
- `MANGO_OUTBOUND_LINE` — исходящий Caller ID, 10–15 цифр.

Непустое значение `SystemSetting`, сохранённое через `Админка → Интеграции`, имеет приоритет над env и применяется без рестарта. Env остаётся fallback для bootstrap. В GitHub Actions значения задаются только через одноимённые Repository/Environment secrets; в `.env.example` остаются пустые шаблоны.

Оба URL валидируются до сохранения и повторно непосредственно перед запросом. `MANGO_API_URL` допускает только официальный `https://app.mango-office.ru/vpbx`, а legacy callback — только `https://integration-webhook.mango-office.ru/webhookapp/common` с query-плейсхолдерами `EmployeeNUM` и `TelNumbr`. Userinfo, нестандартный порт, fragment, другой host/path и HTTP запрещены; HTTP-клиент не следует редиректам.

Для новых звонков предпочтителен подписанный VPBX callback: он передаёт `command_id` и позволяет надёжно связать event webhook с локальной записью. Legacy `MANGO_CALLBACK_URL` сохранён для совместимости. Этот путь не передаёт сгенерированный кабинетом command ID в Mango, поэтому при нём корреляция остаётся fallback по телефону и недавнему звонку.

В настройках Mango отдельно зарегистрируйте публичный HTTPS endpoint событий звонка `https://<host>/api/webhooks/mango/call-result`. Это endpoint для event/status уведомлений, а не для синхронного ответа команды `/commands/callback`. Ответ команды вида `{"result": 1000}` означает лишь, что команда принята, и намеренно не завершает локальную запись звонка.

## EmployeeNUM сотрудников

Это внутренние номера Mango, не amoCRM `responsible_user_id`:

| Сотрудник | Mango EmployeeNUM |
|---|---:|
| Арефьева Юлия | 15 |
| Кириллова Ксения | 30 |
| Корнева Александра | 17 |
| Уланов Артём | 18 |
| Цветкова Надежда | 14 |

Настраивать только вручную в `Админка → Брокеры → карточка сотрудника → Mango EmployeeNUM`. API принимает строку из 1–20 цифр, не позволяет назначить один номер двум сотрудникам и поддерживает очистку пустым значением. Уникальность дополнительно обеспечивается индексом PostgreSQL, поэтому конкурентная попытка назначения возвращает конфликт и не пишет audit-событие. Назначение разрешено только записям с ролью `MANAGER`/`ADMIN` и журналируется без записи самого номера в audit payload.

Если используется API, сначала найдите и зафиксируйте UUID каждой карточки сотрудника, затем применяйте `PATCH /admin/brokers/{uuid}/mango-employee-num` по одному UUID. Не обновляйте по ФИО и не запускайте SQL-скрипты: совпадение имени не является устойчивым идентификатором.

## Безопасный dry-run

1. Не выполняя изменений, откройте пять карточек, проверьте UUID, роль и текущее значение EmployeeNUM.
2. Составьте таблицу `UUID → ожидаемый EmployeeNUM` и убедитесь, что каждый UUID и каждый номер уникальны.
3. Проверьте, что GitHub secrets заданы, а в репозитории и логах нет их значений.
4. Сохраните один EmployeeNUM через UI и перечитайте карточку. Ошибка конфликта должна остановить настройку без перезаписи другой карточки.
5. Выполните один согласованный тестовый callback. До подтверждения Caller ID и доставки подписанного webhook не запускайте массовые/production звонки.
6. После проверки настройте остальные четыре карточки по одной и повторно перечитайте их.

## Репетиция миграции на clone

Перед production-деплоем примените additive-миграцию Mango к актуальному clone базы. Её первый gate ищет повторяющиеся непустые `mango_employee_num` и аварийно завершает всю транзакцию до добавления колонки/индекса. При таком отказе не удаляйте строки и не выбирайте запись автоматически: зафиксируйте конфликтующие UUID, вручную исправьте назначения через карточки сотрудников, заново снимите clone и повторите миграцию. На успешной репетиции проверьте, что появилась nullable колонка `calls.mango_event_seq` и unique index `brokers_mango_employee_num_key`; исторические `NULL` остаются допустимыми.

## Webhook и ротация

Официальный VPBX POST имеет `Content-Type: application/x-www-form-urlencoded` и поля `vpbx_api_key`, `sign`, `json`. Подпись вычисляется по **точной, ещё не распарсенной строке** `json`:

```text
sha256(vpbx_api_key + json + vpbx_api_salt)
```

`/api/webhooks/mango/call-result` всегда работает fail-closed. Если полная пара `MANGO_API_KEY` + `MANGO_API_SALT` не настроена, endpoint возвращает `503` и не меняет звонки. При настроенной паре он требует совпадающий API key и корректную подпись: отсутствующие/malformed поля, неправильный ключ или подпись получают `401`; подписанный, но невалидный JSON получает `400`. Для старых установок сохранён JSON body + `x-mango-sign`, но подпись в этом режиме вычисляется той же SHA-256 конкатенацией, а не HMAC. Неизвестный статус игнорируется и не превращается в успешный звонок. После ротации обновите SystemSetting или GitHub secret и сразу проверьте подписанный fixture.

Для realtime event используйте официальный payload с `call_state`, `call_id`, `command_id`, `seq`, вложенными `from.number` / `to.number` и, для завершения, `disconnect_reason`. `Appeared`, `Connected` и `OnHold` не являются итогом и не меняют локальный terminal status. Это также не даёт опоздавшему non-terminal событию откатить уже завершённый звонок. Для `Disconnected` применяются явные правила:

| `disconnect_reason` | Локальный статус |
|---|---|
| `1000` | игнорируется: промежуточное завершение первого технического callback-leg |
| `1100`, `1110`, `1120` | `COMPLETED` |
| `1111` | `NO_ANSWER` |
| `1121` | `BUSY` |
| `1122`–`1124`, `1130`–`1134`, `42xx` | `UNAVAILABLE` |
| остальные, включая `2xxx`, `32xx`, `34xx`, `5001`, `5003` | `FAILED` |

Произвольный код `11xx` не считается успехом. Для официального `call_state` поле `seq` обязательно и хранится в `calls.mango_event_seq`. Обновление выполняется одним условным SQL update: принимается только событие с большим `seq`; равное или меньшее считается повторным/опоздавшим. Старый нормализованный payload без `seq` поддерживается только пока локальная запись имеет статус `INITIATED` и ещё не связана с официальной последовательностью. Поэтому ни опоздавшее official событие, ни legacy payload не перезаписывают более новый terminal результат.

Сверяйте формат и регистрацию событий с официальной документацией:

- [модель взаимодействия API ВАТС](https://docs.mango-office.ru/ru/5_api-i-razrabotka/1_api-mango-office/4_obschie_polozheniya_o_vzaimodeystvii_sistem/1_2_model_vzaimodeystviya/2_1_1_api_vats.html);
- [общие вопросы REST API ВАТС](https://www.mango-office.ru/support/integratsiya-api/restapivatshelp/obshchie_voprosy_po_api_vats_mango_office/);
- [официальное уведомление о вызове и `call_state`](https://docs.mango-office.ru/ru/5_api-i-razrabotka/1_api-mango-office/5_opisanie_metodov_api_virtualnoy_ats_mango/1_1_api_realtime/3_1_2_uvedomlenie_o_vyzove.html);
- [пример исходящего callback](https://docs.mango-office.ru/ru/5_api-i-razrabotka/1_api-mango-office/8_primery_povedeniya/initsiirovanie_ishodyaschego_vyzova.html);
- [официальный integration-webhook Контакт-центра](https://dev.mango-office.ru/support/integratsiya-api/vebkhuki/integratsiyayskc/).

Ключи, когда-либо отправленные в чат, письмо или тикет открытым текстом, считать скомпрометированными. Перед production-включением:

1. перевыпустить API key/salt в Mango;
2. отозвать старые значения;
3. записать новые только в GitHub secrets или защищённую админ-настройку;
4. перезапустить/задеплоить API при изменении env fallback;
5. проверить исходящий callback и webhook;
6. убедиться, что старой подписью webhook больше не принимается.

Не помещайте реальные key, salt, callback URL или содержимое webhook с персональными данными в git, команды shell, скриншоты и CI-логи.
