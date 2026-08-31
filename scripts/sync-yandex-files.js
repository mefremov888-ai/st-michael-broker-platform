#!/usr/bin/env node
/**
 * Скачивает файлы с публичной папки Яндекс.Диска в /app/uploads/yandex/<относительный путь>
 * и записывает Document.fileUrl = /files/yandex/<относительный путь> в БД.
 *
 * Структура папок на диске сохраняется целиком (проект → тип → альбом → файл).
 * По умолчанию удаляет локальные файлы и Document-записи синка, которых
 * больше нет на Я.Диске (старые неразнесённые материалы).
 *
 * Запуск:
 *   node scripts/sync-yandex-files.js [public_url]
 *   FORCE=1 node scripts/sync-yandex-files.js
 *   CLEAN_ORPHANS=0 node scripts/sync-yandex-files.js   # не чистить лишнее
 *
 * Cron: scheduler.service.ts handleYandexDiskFilesSync — раз в сутки.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PUBLIC_KEY = 'https://disk.yandex.ru/d/Pf1bqSQkEG62sw';
const PUBLIC_KEY = process.argv[2] || process.env.YANDEX_DISK_PUBLIC_KEY || DEFAULT_PUBLIC_KEY;
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || '/app/uploads';
const TARGET_DIR = path.join(UPLOAD_ROOT, 'yandex');
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const CLEAN_ORPHANS = process.env.CLEAN_ORPHANS !== '0' && process.env.CLEAN_ORPHANS !== 'false';

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  try {
    ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
  } catch (e) {
    console.error('Cannot find @prisma/client');
    process.exit(1);
  }
}

const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const DOWNLOAD_API = 'https://cloud-api.yandex.net/v1/disk/public/resources/download';

async function fetchResource(p = '/', offset = 0, limit = 1000) {
  const url = new URL(API);
  url.searchParams.set('public_key', PUBLIC_KEY);
  url.searchParams.set('path', p);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Yandex API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getDownloadHref(filePath) {
  const url = new URL(DOWNLOAD_API);
  url.searchParams.set('public_key', PUBLIC_KEY);
  url.searchParams.set('path', filePath);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`download link ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return d.href;
}

function sanitizeSegment(s) {
  const cleaned = String(s || '')
    .replace(/[^\p{L}\p{N}\s.,()\-_]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

function joinRel(...parts) {
  return parts.filter(Boolean).join('/');
}

function projectFromRel(relDir) {
  const top = (relDir || '').split('/')[0] || '';
  if (/зорг/i.test(top)) return 'ZORGE9';
  if (/ксб|серебрян/i.test(top)) return 'SILVER_BOR';
  return null;
}

async function collectFiles(p, relDir, files) {
  let offset = 0;
  for (;;) {
    const data = await fetchResource(p, offset);
    const items = data?._embedded?.items || [];
    for (const it of items) {
      if (it.type === 'dir') {
        const nextRel = joinRel(relDir, sanitizeSegment(it.name));
        await collectFiles(it.path, nextRel, files);
      } else if (it.type === 'file') {
        files.push({
          name: it.name,
          size: it.size || 0,
          path: it.path,
          relativeDir: relDir,
          nameSafe: sanitizeSegment(it.name),
        });
      }
    }
    const total = data?._embedded?.total ?? items.length;
    offset += items.length;
    if (items.length === 0 || offset >= total) break;
  }
}

async function downloadTo(href, dest) {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const tmp = dest + '.tmp';
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

function listLocalFiles(dir, rel, out) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.endsWith('.tmp')) continue;
    const nextRel = joinRel(rel, ent.name);
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listLocalFiles(full, nextRel, out);
    else out.push({ full, rel: nextRel });
  }
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) removeEmptyDirs(path.join(dir, ent.name));
  }
  const leftover = fs.readdirSync(dir);
  if (leftover.length === 0 && path.resolve(dir) !== path.resolve(TARGET_DIR)) {
    fs.rmdirSync(dir);
  }
}

function publicUrlFor(relDir, nameSafe) {
  const segments = [...(relDir ? relDir.split('/') : []), nameSafe].map((s) => encodeURIComponent(s));
  return `/files/yandex/${segments.join('/')}`;
}

(async () => {
  console.log('=== Yandex.Disk files sync ===');
  console.log('public_key:', PUBLIC_KEY);
  console.log('target:    ', TARGET_DIR);
  console.log('mode:      ', FORCE ? 'FORCE re-download' : 'skip same-size');
  console.log('orphans:   ', CLEAN_ORPHANS ? 'delete missing' : 'keep extra local files');
  console.log('');

  if (!fs.existsSync(TARGET_DIR)) fs.mkdirSync(TARGET_DIR, { recursive: true });

  const files = [];
  await collectFiles('/', '', files);
  const folders = [...new Set(files.map((f) => f.relativeDir || '(root)'))];
  console.log(`Found ${files.length} files in ${folders.length} folders`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let totalBytes = 0;
  const prisma = new PrismaClient();
  const keepRel = new Set();
  const seenDiskPaths = new Set();

  for (const f of files) {
    const localDir = f.relativeDir
      ? path.join(TARGET_DIR, ...f.relativeDir.split('/'))
      : TARGET_DIR;
    const localPath = path.join(localDir, f.nameSafe);
    const rel = joinRel(f.relativeDir, f.nameSafe);
    keepRel.add(rel);
    seenDiskPaths.add(f.path);
    const publicUrl = publicUrlFor(f.relativeDir, f.nameSafe);

    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

    const exists = fs.existsSync(localPath);
    if (exists && !FORCE) {
      const stat = fs.statSync(localPath);
      if (stat.size === f.size) {
        skipped++;
        await upsertDocument(prisma, f, publicUrl);
        continue;
      }
    }

    try {
      console.log(`↓ ${rel} (${(f.size / 1024 / 1024).toFixed(1)}MB)`);
      const href = await getDownloadHref(f.path);
      const bytes = await downloadTo(href, localPath);
      totalBytes += bytes;
      downloaded++;
      await upsertDocument(prisma, f, publicUrl);
    } catch (e) {
      console.error(`  FAIL ${f.path}: ${e.message}`);
      failed++;
    }
  }

  let removedFiles = 0;
  let removedDocs = 0;
  if (CLEAN_ORPHANS) {
    const local = [];
    listLocalFiles(TARGET_DIR, '', local);
    for (const item of local) {
      if (keepRel.has(item.rel)) continue;
      try {
        fs.unlinkSync(item.full);
        removedFiles++;
        console.log(`✕ orphan file ${item.rel}`);
      } catch (e) {
        console.error(`  FAIL unlink ${item.rel}: ${e.message}`);
      }
    }
    removeEmptyDirs(TARGET_DIR);

    const existing = await prisma.document.findMany({
      where: {
        category: 'materials',
        OR: [
          { description: { startsWith: '[yandex-local:' } },
          { description: { startsWith: '[yandex-disk:' } },
        ],
      },
      select: { id: true, description: true },
    });
    for (const d of existing) {
      const diskPath = d.description?.match(/\[yandex-(?:local|disk):(.+)\]/)?.[1];
      if (diskPath && !seenDiskPaths.has(diskPath)) {
        await prisma.document.delete({ where: { id: d.id } });
        removedDocs++;
      }
    }
  }

  await prisma.$disconnect();

  console.log('');
  console.log(`Downloaded: ${downloaded}, skipped: ${skipped}, failed: ${failed}`);
  console.log(`Removed orphan files: ${removedFiles}, orphan documents: ${removedDocs}`);
  console.log(`Bytes downloaded: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function upsertDocument(prisma, f, publicUrl) {
  const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'FILE').toUpperCase();
  const description = `[yandex-local:${f.path}]`;
  const found = await prisma.document.findFirst({
    where: { category: 'materials', description },
  });
  const data = {
    name: f.name,
    type: ext,
    category: 'materials',
    subcategory: f.relativeDir || null,
    project: projectFromRel(f.relativeDir),
    fileUrl: publicUrl,
    fileSize: f.size,
    isPublic: true,
    sortOrder: 0,
    description,
  };
  if (found) {
    await prisma.document.update({ where: { id: found.id }, data });
  } else {
    await prisma.document.create({ data });
  }
}
