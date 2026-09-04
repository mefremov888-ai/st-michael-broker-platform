#!/usr/bin/env node
/**
 * 2026-09-04: заливка «Реестра сделок» (сквозная аналитика ДДУ) в таблицу
 * registry_deals. Вход — JSON-файл вида {"rows":[{rowKey, source,
 * contractNumber, project, signedAt, amount, agencyNameRaw, agencyCanonical,
 * amoLeadId, brokerId, brokerAmoContactId}, ...]}, подготовленный локально
 * (сшивка Google-реестра и выгрузки export-amo-deals.js).
 *
 * Что делает: upsert по rowKey батчами по 200 в prisma.$transaction.
 * НИЧЕГО не удаляет. brokerId валидируется существованием в brokers —
 * несуществующие обнуляются (счётчик skippedBrokerMissing).
 *
 * Запуск в контейнере api (workflow apply-registry-deals.yml):
 *   node /app/scripts/upload-registry-deals.js /app/rd.json [--dry-run]
 *
 * --dry-run: только подсчёт (created/updated/skippedBrokerMissing), в базу
 * не пишется ни одной строки.
 */

const fs = require('fs');

const BATCH_SIZE = 200;
const VALID_SOURCES = new Set(['REGISTRY', 'BOTH', 'AMO_ONLY']);
const VALID_PROJECTS = new Set(['ZORGE9', 'SILVER_BOR']);

const toBigIntOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return BigInt(v);
};

(async () => {
  const filePath = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!filePath || filePath === '--dry-run') {
    console.error('Usage: node upload-registry-deals.js <path-to-json> [--dry-run]');
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rows = parsed?.rows;
  if (!Array.isArray(rows)) {
    console.error('FATAL: входной JSON должен иметь вид {"rows":[...]}');
    process.exit(1);
  }
  console.log(`Строк во входном файле: ${rows.length}${dryRun ? ' (DRY-RUN: без записи)' : ''}`);

  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();

  const stats = {
    total: rows.length,
    created: 0,
    updated: 0,
    skippedBrokerMissing: 0, // brokerId не найден в brokers → записан как null
    skippedInvalidRow: 0, // нет rowKey/source/contractNumber или source вне словаря
  };

  try {
    // ─── Валидация brokerId: существование в brokers ───
    const dbBrokers = await prisma.broker.findMany({ select: { id: true } });
    const brokerIds = new Set(dbBrokers.map((b) => b.id));
    console.log(`Брокеров в БД: ${brokerIds.size}`);

    // ─── Нормализация строк ───
    const prepared = [];
    const seenKeys = new Set();
    for (const row of rows) {
      if (!row?.rowKey || !row.contractNumber || !VALID_SOURCES.has(row.source)) {
        stats.skippedInvalidRow++;
        continue;
      }
      if (seenKeys.has(row.rowKey)) {
        // Дубль rowKey внутри файла — последний победил бы недетерминированно,
        // внутри одной $transaction это ещё и deadlock-риск. Считаем как invalid.
        stats.skippedInvalidRow++;
        continue;
      }
      seenKeys.add(row.rowKey);

      let brokerId = row.brokerId ?? null;
      if (brokerId && !brokerIds.has(brokerId)) {
        stats.skippedBrokerMissing++;
        brokerId = null;
      }

      prepared.push({
        rowKey: String(row.rowKey),
        source: row.source,
        contractNumber: String(row.contractNumber),
        project: VALID_PROJECTS.has(row.project) ? row.project : null,
        signedAt: row.signedAt ? new Date(row.signedAt) : null, // YYYY-MM-DD
        amount: row.amount ?? null,
        agencyNameRaw: row.agencyNameRaw ?? null,
        agencyCanonical: row.agencyCanonical ?? null,
        amoLeadId: toBigIntOrNull(row.amoLeadId),
        brokerId,
        brokerAmoContactId: toBigIntOrNull(row.brokerAmoContactId),
      });
    }

    // ─── Upsert по rowKey батчами ───
    for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
      const batch = prepared.slice(i, i + BATCH_SIZE);
      const keys = batch.map((r) => r.rowKey);
      const existing = await prisma.registryDeal.findMany({
        where: { rowKey: { in: keys } },
        select: { rowKey: true },
      });
      const existingKeys = new Set(existing.map((r) => r.rowKey));
      for (const key of keys) {
        if (existingKeys.has(key)) stats.updated++;
        else stats.created++;
      }

      if (!dryRun) {
        await prisma.$transaction(
          batch.map((data) =>
            prisma.registryDeal.upsert({
              where: { rowKey: data.rowKey },
              create: data,
              update: data,
            }),
          ),
        );
      }
      console.log(`— батч ${Math.floor(i / BATCH_SIZE) + 1}: обработано ${Math.min(i + BATCH_SIZE, prepared.length)}/${prepared.length} —`);
    }

    console.log('RESULT:', JSON.stringify({ ...stats, dryRun }));
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
