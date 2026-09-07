#!/usr/bin/env node
/**
 * Синхронизирует материалы с публичной папки Яндекс.Диска в нашу таблицу Document.
 *
 * Источник: переменная окружения YANDEX_DISK_PUBLIC_KEY (URL публичной папки),
 * либо аргумент: node scripts/sync-yandex-disk.js https://disk.yandex.ru/d/xxx
 *
 * Что делает:
 * 1. Рекурсивно обходит все папки публичной шары через Яндекс REST API
 * 2. Для каждого файла создаёт/обновляет Document запись:
 *    - category = 'materials'
 *    - subcategory = имя родительской папки (например "Зорге9 (фото)")
 *    - fileUrl = публичная ссылка на файл (открывается в превью Яндекса)
 *    - name = имя файла
 *    - type = расширение
 * 3. Удаляет Document записи которые больше не существуют на Яндекс.Диске
 *    (только те что были созданы этим скриптом — по префиксу description)
 *
 * Запуск: node scripts/sync-yandex-disk.js [public_url]
 * Cron: scheduler.service.ts — каждые 12 часов
 */

// Default: публичная папка "Брокерам" с материалами от заказчика (2026-05-06).
// Можно переопределить аргументом или env YANDEX_DISK_PUBLIC_KEY.
const DEFAULT_PUBLIC_KEY = 'https://disk.yandex.ru/d/8_w-xQ8PR3uz3w';
const PUBLIC_KEY = process.argv[2] || process.env.YANDEX_DISK_PUBLIC_KEY || DEFAULT_PUBLIC_KEY;

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  try {
    ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
  } catch (e) {
    console.error('Cannot find @prisma/client. Run `npm install` in packages/database first.');
    process.exit(1);
  }
}

const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';

async function fetchResource(path = '/', limit = 200) {
  const url = new URL(API);
  url.searchParams.set('public_key', PUBLIC_KEY);
  url.searchParams.set('path', path);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Yandex API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function collectFiles(path, parentName, files) {
  const data = await fetchResource(path);
  const items = data?._embedded?.items || [];
  for (const it of items) {
    if (it.type === 'dir') {
      // recurse — use this dir's name as subcategory for nested files
      await collectFiles(it.path, it.name, files);
    } else if (it.type === 'file') {
      files.push({
        name: it.name,
        size: it.size || 0,
        path: it.path,
        publicUrl: it.public_url || PUBLIC_KEY,
        directLink: it.file || null,
        subcategory: parentName,
        modified: it.modified || it.created || null,
        mimeType: it.mime_type || null,
      });
    }
  }
}

(async () => {
  console.log('Sync Yandex.Disk → CMS materials');
  console.log('Public key:', PUBLIC_KEY);
  console.log('');

  const files = [];
  await collectFiles('/', 'Материалы', files);
  console.log(`Found ${files.length} files in ${[...new Set(files.map((f) => f.subcategory))].length} folders\n`);

  if (files.length === 0) {
    console.log('No files found. Exiting.');
    return;
  }

  const prisma = new PrismaClient();

  // Track existing yandex-synced documents to detect removals
  const existing = await prisma.document.findMany({
    where: {
      category: 'materials',
      description: { startsWith: '[yandex-disk:' },
    },
  });

  const seenPaths = new Set();
  let created = 0;
  let updated = 0;

  for (const f of files) {
    seenPaths.add(f.path);
    const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'FILE').toUpperCase();
    const description = `[yandex-disk:${f.path}]`;

    // ВАЖНО: directLink (it.file) от Я.Диска истекает за ~3 часа — для лендинга
    // непригоден. Сохраняем ТОЛЬКО публичную ссылку папки/файла (publicUrl) —
    // она вечная. Клик ведёт на Я.Диск, где видно превью и можно скачать.
    // Минус: пользователю нужен один лишний клик (Я.Диск → Скачать).
    // Идеальное решение — API-proxy endpoint /api/public/documents/:id/download
    // который на запрос получает свежий directLink через Я.API и редиректит.
    // Делать в отдельном PR.
    const fileUrl = f.publicUrl || f.directLink;

    const found = existing.find((d) => d.description === description);
    if (found) {
      await prisma.document.update({
        where: { id: found.id },
        data: {
          name: f.name,
          type: ext,
          subcategory: f.subcategory,
          fileUrl,
          fileSize: f.size,
        },
      });
      updated++;
    } else {
      await prisma.document.create({
        data: {
          name: f.name,
          description,
          type: ext,
          category: 'materials',
          subcategory: f.subcategory,
          fileUrl,
          fileSize: f.size,
          isPublic: true,
          sortOrder: 0,
        },
      });
      created++;
    }
  }

  // Remove yandex-synced docs that are no longer on the disk
  let removed = 0;
  for (const d of existing) {
    const path = d.description?.match(/\[yandex-disk:(.+)\]/)?.[1];
    if (path && !seenPaths.has(path)) {
      await prisma.document.delete({ where: { id: d.id } });
      removed++;
    }
  }

  console.log(`✓ Создано:    ${created}`);
  console.log(`✓ Обновлено:  ${updated}`);
  console.log(`✓ Удалено:    ${removed}`);
  console.log('\nГотово. Материалы доступны на /materials и в админке /admin/documents.');

  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
