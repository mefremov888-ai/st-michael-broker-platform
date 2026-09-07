#!/usr/bin/env node
/**
 * 2026-09-05: канарейка amoCRM для формы фиксации клиентов.
 *
 * Делает ОДИН читающий запрос к amoCRM — поиск контакта по заведомо
 * несуществующему номеру +79000000001 — тем же путём, каким форма фиксации
 * проверяет уникальность клиента (AmoCrmAdapter.findContactByPhone).
 *
 * Успех = amo ответила (пустой результат — это тоже успех).
 * Провал = исключение (amo недоступна/токен мёртв/лимит) → exit 1.
 *
 * Токены amo загружаются напрямую из SystemSetting через Prisma, БЕЗ
 * NestFactory(AppModule): полный контекст поднимает шедулеры (кроны синка)
 * внутри скрипта. Hook на refresh обязателен — refresh_token ротируется
 * при каждом использовании (тот же приём, что export-amo-deals.js).
 *
 * Запуск (workflow canary-fixation.yml): скрипт доставляется на сервер через
 * git show из канонического master и подаётся контейнеру api на stdin:
 *   git show <sha>:scripts/canary-amo-check.js | docker compose exec -T api node
 *
 * Вывод: строка CANARY_OK либо CANARY_FAIL CANARY_CODE=<код> (workflow
 * вынимает код для текста алерта).
 */

const CANARY_PHONE = '+79000000001';

(async () => {
  const {
    AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook,
  } = require('/app/packages/integrations/dist/amo-crm.adapter');
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();

  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ['AMO_ACCESS_TOKEN', 'AMO_REFRESH_TOKEN'] } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    setAmoTokens(
      byKey.get('AMO_ACCESS_TOKEN') || process.env.AMO_ACCESS_TOKEN || '',
      byKey.get('AMO_REFRESH_TOKEN') || process.env.AMO_REFRESH_TOKEN || '',
    );
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [
        ['AMO_ACCESS_TOKEN', tokens.access],
        ['AMO_REFRESH_TOKEN', tokens.refresh],
      ]) {
        await prisma.systemSetting.upsert({
          where: { key },
          update: { value, updatedBy: 'canary-amo-check' },
          create: { key, value, updatedBy: 'canary-amo-check' },
        });
      }
      console.error('amo tokens refreshed and persisted');
    });

    const amo = new AmoCrmAdapter();
    // Нестрогий поиск = ровно один GET /contacts?query=... Найти ничего —
    // нормально; исключение здесь означает, что и реальная проверка
    // уникальности при фиксации сейчас падает.
    const contact = await amo.findContactByPhone(CANARY_PHONE);
    console.log(`CANARY_OK found=${contact ? contact.id : 'none'}`);
  } catch (e) {
    const code =
      e?.status ??
      e?.response?.status ??
      e?.code ??
      (e?.message ? String(e.message).slice(0, 80) : 'unknown');
    console.log(`CANARY_FAIL CANARY_CODE=${String(code).replace(/\s+/g, '_')}`);
    console.error('canary error:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
