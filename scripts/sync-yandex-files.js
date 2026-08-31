#!/usr/bin/env node
/**
 * Скачивает материалы с нескольких публичных папок Яндекс.Диска в
 * /app/uploads/yandex/<относительный путь> и миниатюры в yandex-thumbs.
 *
 * Источники по умолчанию:
 *   1) новая папка проектов (ЗОРГЕ 9 / КСБ)
 *   2) архив старых материалов (фото, reels, рендеры, условия)
 *   3) презентации → локальная папка «Презентации»
 *
 * CLEAN_ORPHANS удаляет только то, чего нет ни в одном источнике.
 *
 *   node scripts/sync-yandex-files.js [public_url]
 *   CLEAN_ORPHANS=0 node scripts/sync-yandex-files.js
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MATERIALS = 'https://disk.yandex.ru/d/Pf1bqSQkEG62sw';
const DEFAULT_ARCHIVE = 'https://disk.yandex.ru/d/xgzI7yrg50iYNg';
const DEFAULT_PRESENTATIONS = 'https://disk.yandex.ru/d/r1QvoJpLNquhjg';

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || '/app/uploads';
const TARGET_DIR = path.join(UPLOAD_ROOT, 'yandex');
const THUMB_DIR = path.join(UPLOAD_ROOT, 'yandex-thumbs');
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const CLEAN_ORPHANS = process.env.CLEAN_ORPHANS !== '0' && process.env.CLEAN_ORPHANS !== 'false';

function uniqueSources() {
  const raw = [
    {
      name: 'materials',
      key: process.argv[2] || process.env.YANDEX_DISK_PUBLIC_KEY || DEFAULT_MATERIALS,
      prefix: '',
    },
    {
      name: 'archive',
      key: process.env.YANDEX_DISK_ARCHIVE_KEY || DEFAULT_ARCHIVE,
      prefix: '',
    },
    {
      name: 'presentations',
      key: process.env.YANDEX_DISK_PRESENTATIONS_KEY || DEFAULT_PRESENTATIONS,
      prefix: 'Презентации',
    },
  ];
  const seen = new Set();
  return raw.filter((src) => {
    const id = `${src.key}||${src.prefix}`;
    if (!src.key || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

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

async function fetchResource(publicKey, p = '/', offset = 0, limit = 1000) {
  const url = new URL(API);
  url.searchParams.set('public_key', publicKey);
  url.searchParams.set('path', p);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('preview_size', 'M');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Yandex API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getDownloadHref(publicKey, filePath) {
  const url = new URL(DOWNLOAD_API);
  url.searchParams.set('public_key', publicKey);
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

function pickPreview(it) {
  const sizes = it?.sizes || [];
  const preferred =
    sizes.find((s) => s.name === 'M') ||
    sizes.find((s) => s.name === 'L') ||
    sizes.find((s) => s.name === 'S');
  return preferred?.url || it?.preview || null;
}

async function refreshPreview(publicKey, diskPath) {
  const data = await fetchResource(publicKey, diskPath, 0, 1);
  if (data?.type === 'file') return pickPreview(data);
  const items = data?._embedded?.items || [];
  const match = items.find((it) => it.path === diskPath);
  return pickPreview(match || data);
}

function projectFromRel(relDir) {
  const s = relDir || '';
  if (/зорг/i.test(s)) return 'ZORGE9';
  if (/ксб|серебрян/i.test(s)) return 'SILVER_BOR';
  return null;
}

async function collectFiles(publicKey, p, relDir, files) {
  let offset = 0;
  for (;;) {
    const data = await fetchResource(publicKey, p, offset);
    const items = data?._embedded?.items || [];
    for (const it of items) {
      if (it.type === 'dir') {
        const nextRel = joinRel(relDir, sanitizeSegment(it.name));
        await collectFiles(publicKey, it.path, nextRel, files);
      } else if (it.type === 'file') {
        files.push({
          publicKey,
          name: it.name,
          size: it.size || 0,
          path: it.path,
          relativeDir: relDir,
          nameSafe: sanitizeSegment(it.name),
          preview: pickPreview(it),
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

function removeEmptyDirs(dir, root) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) removeEmptyDirs(path.join(dir, ent.name), root);
  }
  const leftover = fs.readdirSync(dir);
  if (leftover.length === 0 && path.resolve(dir) !== path.resolve(root)) {
    fs.rmdirSync(dir);
  }
}

function thumbRelFor(rel) {
  return `${rel}.thumb.jpg`;
}

function thumbPathFor(rel) {
  return path.join(THUMB_DIR, ...thumbRelFor(rel).split('/'));
}

async function ensureThumb(f) {
  const rel = joinRel(f.relativeDir, f.nameSafe);
  const dest = thumbPathFor(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 2000) {
    return { rel: thumbRelFor(rel), skipped: true, bytes: 0 };
  }
  let href = f.preview;
  if (!href) href = await refreshPreview(f.publicKey, f.path);
  if (!href) return { rel: thumbRelFor(rel), skipped: true, bytes: 0 };
  try {
    const bytes = await downloadTo(href, dest);
    return { rel: thumbRelFor(rel), skipped: false, bytes };
  } catch (e) {
    href = await refreshPreview(f.publicKey, f.path);
    if (!href) throw e;
    const bytes = await downloadTo(href, dest);
    return { rel: thumbRelFor(rel), skipped: false, bytes };
  }
}

function publicUrlFor(relDir, nameSafe) {
  const segments = [...(relDir ? relDir.split('/') : []), nameSafe].map((s) => encodeURIComponent(s));
  return `/files/yandex/${segments.join('/')}`;
}

(async () => {
  const sources = uniqueSources();
  console.log('=== Yandex.Disk files sync ===');
  for (const src of sources) {
    console.log(`source ${src.name}: ${src.key}${src.prefix ? ` → ${src.prefix}/` : ''}`);
  }
  console.log('target:    ', TARGET_DIR);
  console.log('thumbs:    ', THUMB_DIR);
  console.log('mode:      ', FORCE ? 'FORCE re-download' : 'skip same-size');
  console.log('orphans:   ', CLEAN_ORPHANS ? 'delete missing from all sources' : 'keep extra local files');
  console.log('');

  if (!fs.existsSync(TARGET_DIR)) fs.mkdirSync(TARGET_DIR, { recursive: true });
  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

  const files = [];
  for (const src of sources) {
    const before = files.length;
    await collectFiles(src.key, '/', src.prefix, files);
    console.log(`  ${src.name}: ${files.length - before} files`);
  }
  const folders = [...new Set(files.map((f) => f.relativeDir || '(root)'))];
  console.log(`Found ${files.length} files in ${folders.length} folders`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let thumbsDownloaded = 0;
  let thumbsSkipped = 0;
  let thumbsFailed = 0;
  let totalBytes = 0;
  let thumbBytes = 0;
  const prisma = new PrismaClient();
  const keepRel = new Set();
  const keepThumbRel = new Set();
  const seenDiskPaths = new Set();

  console.log('Downloading grid thumbnails...');
  for (const f of files) {
    const rel = joinRel(f.relativeDir, f.nameSafe);
    keepThumbRel.add(thumbRelFor(rel));
    try {
      const thumb = await ensureThumb(f);
      if (thumb.skipped) thumbsSkipped++;
      else {
        thumbsDownloaded++;
        thumbBytes += thumb.bytes;
        console.log(`▣ ${rel} (${(thumb.bytes / 1024).toFixed(0)}KB)`);
      }
    } catch (e) {
      thumbsFailed++;
      console.error(`  FAIL thumb ${f.path}: ${e.message}`);
    }
  }

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
      const href = await getDownloadHref(f.publicKey, f.path);
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
    removeEmptyDirs(TARGET_DIR, TARGET_DIR);

    const thumbs = [];
    listLocalFiles(THUMB_DIR, '', thumbs);
    for (const item of thumbs) {
      if (keepThumbRel.has(item.rel)) continue;
      try {
        fs.unlinkSync(item.full);
        removedFiles++;
        console.log(`✕ orphan thumb ${item.rel}`);
      } catch (e) {
        console.error(`  FAIL unlink thumb ${item.rel}: ${e.message}`);
      }
    }
    removeEmptyDirs(THUMB_DIR, THUMB_DIR);

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
  console.log(`Thumbs: downloaded ${thumbsDownloaded}, skipped ${thumbsSkipped}, failed ${thumbsFailed}`);
  console.log(`Removed orphan files: ${removedFiles}, orphan documents: ${removedDocs}`);
  console.log(`Bytes downloaded: ${(totalBytes / 1024 / 1024).toFixed(1)} MB, thumbs: ${(thumbBytes / 1024 / 1024).toFixed(1)} MB`);
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
