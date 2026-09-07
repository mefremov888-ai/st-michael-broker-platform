#!/usr/bin/env node
/**
 * Пересинхронизирует все сделки и клиентов из amoCRM для ВСЕХ активных брокеров.
 * Использует существующий SchedulerService.handleAmoCrmSync() через NestJS
 * standalone application context.
 *
 * Запуск через workflow: task=sync-amocrm-all (никакого JWT не нужно — запускается
 * через GitHub Actions SSH в docker контейнер).
 *
 * После запуска: Agency.totalSqmSold пересчитается, уровни комиссий обновятся.
 */

(async () => {
  // Импортируем скомпилированный NestJS-приложение (внутри docker /app — это apps/api).
  const { NestFactory } = require('@nestjs/core');

  // AppModule находится в /app/apps/api/dist/ (monorepo layout, entrypoint
  // запускает `node apps/api/dist/main.js`).
  let AppModule, SchedulerService;
  try {
    ({ AppModule } = require('/app/apps/api/dist/app.module'));
    ({ SchedulerService } = require('/app/apps/api/dist/scheduler/scheduler.service'));
  } catch (e) {
    console.error('Cannot load Nest modules from /app/apps/api/dist. Did nest build run?');
    console.error(e);
    process.exit(1);
  }

  console.log('Bootstrapping Nest standalone context...');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  try {
    const scheduler = app.get(SchedulerService);
    console.log('Running handleAmoCrmSync()...');
    await scheduler.handleAmoCrmSync();
    console.log('✓ Sync complete');
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
