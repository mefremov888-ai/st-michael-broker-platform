#!/usr/bin/env node
// One authoritative media tree for both surfaces. Files are verified before
// any Document/layout changes; old files remain recoverable after the swap.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const SOURCE = 'https://disk.yandex.ru/d/Pf1bqSQkEG62sw';
let ROOT = '/Новая версия';
function sourceRoot(value) {
  if (!['/Новая версия', '/Версия ИИ'].includes(value)) throw new Error('Unsupported media source');
  return value;
}
const MEDIA = /\.(jpe?g|png|webp|gif|heic|avif|bmp|tiff?|mp4|mov|webm|m4v|avi|mkv)$/i;
const VIDEO = /\.(mp4|mov|webm|m4v|avi|mkv)$/i;
const PROJECTS = { 'Зорге 9': ['zorge', 'ZORGE9'], 'Квартал Серебряный бор': ['berarina', 'SILVER_BOR'] };
const split = s => String(s || '').split('/').map(p => p.trim()).filter(Boolean);
const clean = s => s.replace(/[^\p{L}\p{N}\s.,()\-_]/gu, '_').replace(/\s+/g, ' ').trim();
const urlFor = rel => '/files/yandex/' + rel.split('/').map(encodeURIComponent).join('/');

function material(it, root = ROOT) {
  sourceRoot(root);
  if (!it.path.startsWith(root + '/')) throw new Error('Resource outside source subtree');
  const parts = it.path.slice(root.length + 1).split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\\'))) throw new Error('Unsafe source path');
  const project = PROJECTS[parts[0]];
  if (!project || !MEDIA.test(it.name)) throw new Error('Unexpected project/file: ' + it.path);
  const folder = parts.slice(0, -1).map(p => p.trim()).join('/');
  // Source contains names differing only in case and starred/non-starred names.
  // Stable suffix prevents collisions on either Windows or Linux.
  const ext = path.extname(it.name);
  const basename = clean(it.name.slice(0, -ext.length));
  const suffix = crypto.createHash('sha256').update(it.path).digest('hex').slice(0, 12);
  const rel = [root.slice(1), ...parts.slice(0, -1).map(clean), basename + '-' + suffix + ext.toLowerCase()].join('/');
  const browserRel = rel.replace(/\.heic$/i, '.jpg');
  return { ...it, folder, rel, browserRel, fileUrl: urlFor(browserRel), originalFileUrl: urlFor(rel), project: project[1], groupId: project[0] };
}

function coverTargets(f) {
  const stars = f.name.match(/(\*+)\.[^.]+$/)?.[1].length || 0;
  if (!stars) return [];
  if (stars > 3) throw new Error('Unknown cover marker: ' + f.path);
  const parts = split(f.folder);
  const targets = [parts.join('/')];
  if (stars >= 2 && parts.length > 1) targets.push(parts.slice(0, -1).join('/'));
  if (stars === 3) {
    // Explicit owner instruction: evening Zorge video covers Видео, NOT Зорге 9.
    if (!/^Вечерний Зорге —\s+1\*{3}\.MOV$/i.test(f.name) || parts[0] !== 'Зорге 9') {
      throw new Error('Unspecified triple-star cover: ' + f.path);
    }
    targets.push('Зорге 9/Видео');
  }
  return [...new Set(targets)];
}

function buildLayout(saved, files) {
  const next = structuredClone(saved);
  if (next.version !== 1 || !Array.isArray(next.rules) || !Array.isArray(next.groups)) throw new Error('Invalid saved layout');
  const ids = new Set(Object.values(PROJECTS).map(p => p[0]));
  next.groups = next.groups.filter(g => !ids.has(g.id));
  for (const [title, [id]] of Object.entries(PROJECTS)) next.groups.push({ id, title, visibleOnLanding: true, visibleInCabinet: true, sortOrder: id === 'zorge' ? 40 : 50 });
  // Retain separate cooperation/presentation rules. Replace only old media rules.
  next.rules = next.rules.filter(r => !ids.has(r.groupId) || /презентац/i.test(r.prefix));
  for (const [title, [groupId]] of Object.entries(PROJECTS)) {
    const firstFolders = [...new Set(files.filter(f => f.groupId === groupId).map(f => split(f.folder)[1]))];
    for (const [i, folder] of firstFolders.entries()) {
      if (!folder) throw new Error('Media directly in project root is unsupported');
      next.rules.push({ id: 'new-' + groupId + '-' + i, prefix: title + '/' + folder, displayName: folder, groupId, kind: 'as_is', visibleOnLanding: true, visibleInCabinet: true, sortOrder: 40 + i });
    }
  }
  const projectPath = p => /^(Зорге 9|Квартал Серебряный [Бб]ор)(\/|$)/.test(p);
  next.covers = Object.fromEntries(Object.entries(next.covers || {}).filter(([p]) => !projectPath(p)));
  next.looseFolders = Object.fromEntries(Object.entries(next.looseFolders || {}).filter(([p]) => !projectPath(p)));
  // A single-star file names this folder specifically. A double/triple-star
  // file also covers ancestors; the more specific single-star choice wins
  // in its own folder (the real source contains these overlapping markers).
  const coverRanks = new Map();
  for (const f of files) for (const target of coverTargets(f)) {
    const stars = f.name.match(/(\*+)\.[^.]+$/)[1].length;
    const rank = target === f.folder ? stars : 10 + stars;
    const oldRank = coverRanks.get(target);
    if (oldRank !== undefined && oldRank < rank) continue;
    if (oldRank === rank && next.covers[target] !== f.fileUrl) throw new Error('Conflicting covers: ' + target);
    next.covers[target] = f.fileUrl;
    coverRanks.set(target, rank);
  }
  // Unmarked folders use their first image/video thumbnail, identical on both surfaces.
  for (const f of [...files].sort((a, b) => Number(VIDEO.test(a.name)) - Number(VIDEO.test(b.name)) || a.path.localeCompare(b.path, 'ru'))) {
    const parts = split(f.folder);
    for (let depth = 1; depth <= parts.length; depth++) {
      const key = parts.slice(0, depth).join('/');
      next.covers[key] ||= f.fileUrl;
    }
  }
  // Separate document folders can use a retired project photograph as cover.
  // Keep those folders/documents, but point their covers at the new media too.
  const newUrls = new Set(files.map(f => f.fileUrl));
  for (const [folder, url] of Object.entries(next.covers)) {
    if (!url.startsWith('/files/yandex/') || newUrls.has(url)) continue;
    const decoded = decodeURIComponent(url);
    const title = /ксб|серебрян/i.test(decoded) ? 'Квартал Серебряный бор' : /зорг/i.test(decoded) ? 'Зорге 9' : null;
    if (title && next.covers[title]) next.covers[folder] = next.covers[title];
  }
  return next;
}

function replaceable(d, layout) {
  if (d.category !== 'materials' || !MEDIA.test(d.name || d.fileUrl || '')) return false;
  if (d.project === 'ZORGE9' || d.project === 'SILVER_BOR') return true;
  const folder = split(d.subcategory).join('/');
  return layout.rules.some(r => ['zorge', 'berarina'].includes(r.groupId) && (folder === r.prefix || folder.startsWith(r.prefix + '/'))) || /зорг|ксб|серебрян/i.test(folder);
}

async function retry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 3) throw e;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** i));
    }
  }
}
async function json(endpoint, diskPath, extra = {}) {
  const url = new URL('https://cloud-api.yandex.net/v1/disk/public/resources' + endpoint);
  for (const [key, val] of Object.entries({ public_key: SOURCE, path: diskPath, ...extra })) url.searchParams.set(key, String(val));
  return retry(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Yandex API ' + response.status);
    return response.json();
  });
}
async function inventory(diskPath = ROOT, files = [], dirs = [], root = ROOT) {
  sourceRoot(root);
  for (let offset = 0; ;) {
    const data = await json('', diskPath, { offset, limit: 1000, preview_size: '1024x768' });
    if (data.type !== 'dir' || !data._embedded) throw new Error('Incomplete inventory: ' + diskPath);
    const items = data._embedded.items;
    for (const it of items) {
      if (it.type === 'dir') { dirs.push(it.path); await inventory(it.path, files, dirs, root); }
      else files.push(material(it, root));
    }
    offset += items.length;
    if (offset >= data._embedded.total) break;
    if (!items.length) throw new Error('Incomplete pagination');
  }
  if (diskPath === root) {
    if (files.length < 400) throw new Error('Source unexpectedly small: ' + files.length);
    const paths = new Set(files.map(f => f.rel.toLowerCase()));
    if (paths.size !== files.length) throw new Error('Local filename collision');
  }
  return { files, dirs };
}
async function fileHash(filename, algorithm) {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function validFile(filename, f) {
  if (!fs.existsSync(filename) || fs.statSync(filename).size !== f.size) return false;
  const algorithm = f.sha256 ? 'sha256' : f.md5 ? 'md5' : null;
  if (!algorithm) throw new Error('Missing source checksum: ' + f.path);
  return await fileHash(filename, algorithm) === f[algorithm];
}
async function download(f, dest) {
  if (await validFile(dest, f)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await retry(async () => {
    const { href } = await json('/download', f.path);
    const response = await fetch(href, { signal: AbortSignal.timeout(30 * 60000) });
    if (!response.ok) throw new Error('Download ' + response.status);
    const tmp = dest + '.partial';
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp));
    if (!await validFile(tmp, f)) throw new Error('Checksum mismatch: ' + f.path);
    fs.renameSync(tmp, dest);
  });
  return true;
}
async function thumbnail(f, original, dest, sharp) {
  if (fs.existsSync(dest)) {
    try { const meta = await sharp(dest).metadata(); if (meta.width >= 200 && meta.height >= 100) return; } catch (_) { /* regenerate */ }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await retry(async () => {
    let input = original;
    if (VIDEO.test(f.name)) {
      const resource = await json('', f.path, { preview_size: '1024x768' });
      const href = resource.preview || resource.sizes?.find(s => s.name === 'L')?.url;
      if (!href) throw new Error('No video poster: ' + f.path);
      const response = await fetch(href, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error('Poster ' + response.status);
      input = Buffer.from(await response.arrayBuffer());
    }
    const tmp = dest + '.partial';
    await sharp(input).rotate().resize({ width: 1024, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(tmp);
    const meta = await sharp(tmp).metadata();
    if (!meta.width || !meta.height || meta.width < 200 || meta.height < 100) throw new Error('Invalid/small thumbnail: ' + f.path);
    fs.renameSync(tmp, dest);
  });
}

async function browserImage(f, original, dest, sharp) {
  if (f.browserRel === f.rel) return original;
  if (fs.existsSync(dest)) {
    try { const meta = await sharp(dest).metadata(); if (meta.width >= 200 && meta.height >= 100) return dest; } catch (_) { /* regenerate */ }
  }
  // Keep the checksum-verified HEIC original unchanged. Yandex's own decoder
  // provides its largest available JPEG for browsers that cannot display HEIC;
  // do not disable libheif security limits to decode the original locally.
  await retry(async () => {
    const resource = await json('', f.path, { preview_size: '4000x4000' });
    if (!resource.preview) throw new Error('No browser-compatible HEIC preview: ' + f.path);
    const response = await fetch(resource.preview, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('HEIC JPEG ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    const tmp = dest + '.partial';
    await sharp(bytes).rotate().jpeg({ quality: 95 }).toFile(tmp);
    const meta = await sharp(tmp).metadata();
    if (meta.width < 200 || meta.height < 100) throw new Error('Invalid HEIC JPEG preview');
    fs.renameSync(tmp, dest);
    console.log('HEIC_BROWSER_JPEG ' + JSON.stringify({ path: f.path, width: meta.width, height: meta.height, original: f.originalFileUrl }));
  });
  return dest;
}

async function main() {
  const mode = process.env.MATERIALS_MODE || 'apply';
  const uploadRoot = path.resolve(process.env.UPLOAD_ROOT || '/app/uploads');
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();
  const lock = path.join(uploadRoot, '.materials-new-version.lock');
  let locked = false;
  try {
    if (mode !== 'inspect') {
      try { fs.mkdirSync(lock); locked = true; } catch (e) { if (e.code === 'EEXIST') throw new Error('Materials synchronization already running (or stale lock needs inspection)'); throw e; }
    }
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'MATERIALS_FOLDER_LAYOUT' } });
    if (!setting) throw new Error('Saved layout required');
    const saved = JSON.parse(setting.value);
    const savedSource = await prisma.systemSetting.findUnique({ where: { key: 'MATERIALS_SOURCE_ROOT' } });
    ROOT = sourceRoot(process.env.MATERIALS_SOURCE_ROOT || savedSource?.value || '/Новая версия');
    const docs = await prisma.document.findMany({});
    const { files, dirs } = await inventory();
    const next = buildLayout(saved, files);
    const obsolete = docs.filter(d => replaceable(d, saved) && !files.some(f => d.description === '[yandex-local:' + f.path + ']'));
    const free = fs.statfsSync(uploadRoot);
    const needed = files.reduce((sum, f) => sum + (fs.existsSync(path.join(uploadRoot, 'yandex', f.rel)) ? 0 : f.size), 0);
    let sharpAvailable = false;
    try { require('sharp'); sharpAvailable = true; } catch (_) { /* inspect reports missing dependency */ }
    const report = { mode, sharpAvailable, files: files.length, directories: dirs.length, bytes: files.reduce((sum, f) => sum + f.size, 0), obsoleteMedia: obsolete.length, preservedDocuments: docs.length - obsolete.length, covers: Object.keys(next.covers).length, freeBytes: free.bavail * free.bsize, downloadBytes: needed };
    console.log(JSON.stringify(report));
    for (const f of files) if (coverTargets(f).length) console.log('COVER ' + f.path + ' => ' + coverTargets(f).join(' | '));
    console.log('COOPERATION ' + JSON.stringify(docs.filter(d => d.category === 'cooperation').map(d => ({ name: d.name, fileUrl: d.fileUrl, isPublic: d.isPublic }))));
    if (mode === 'inspect') return;
    if (report.freeBytes < needed + 2 * 1024 ** 3) throw new Error('Insufficient staging space (2GB reserve required)');
    const sharp = require('sharp');
    if (ROOT === '/Версия ИИ') {
      const coverDir = path.join(uploadRoot, 'materials-backups', 'victoria-covers-20261012', 'covers');
      const names = fs.readdirSync(coverDir);
      const folders = new Set(dirs.map(d => d.slice(ROOT.length + 1).normalize('NFC')));
      for (const cover of require('../data/victoria-covers-20261012.json').filter(c => c.folder)) {
        const name = names.find(n => n.normalize('NFC') === cover.file);
        if (!name || !folders.has(cover.folder) || await fileHash(path.join(coverDir, name), 'sha256') !== cover.sha256) throw new Error('Approved covers preflight failed');
      }
    }
    let cursor = 0, done = 0;
    const errors = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (cursor < files.length) {
        const f = files[cursor++];
        try {
          const original = path.join(uploadRoot, 'yandex', f.rel);
          await download(f, original);
          const browser = await browserImage(f, original, path.join(uploadRoot, 'yandex', f.browserRel), sharp);
          await thumbnail(f, browser, path.join(uploadRoot, 'yandex-thumbs', f.browserRel + '.thumb.jpg'), sharp);
          console.log('VERIFIED ' + (++done) + '/' + files.length + ' ' + f.path);
        } catch (e) { errors.push(f.path + ': ' + e.message); }
      }
    }));
    if (errors.length) throw new Error('No DB changes. Failed staging: ' + errors.join('\n'));
    if (ROOT === '/Версия ИИ') {
      const covers = require('../data/victoria-covers-20261012.json');
      const coverDir = path.join(uploadRoot, 'materials-backups', 'victoria-covers-20261012', 'covers');
      const coverNames = fs.readdirSync(coverDir);
      const folders = new Set(dirs.map(d => d.slice(ROOT.length + 1).normalize('NFC')));
      for (const cover of covers.filter(c => c.folder)) {
        if (!cover.sha256 || !folders.has(cover.folder)) throw new Error('Missing approved cover/folder: ' + cover.folder);
        const originalName = coverNames.find(name => name.normalize('NFC') === cover.file);
        if (!originalName) throw new Error('Missing approved cover');
        const original = path.join(coverDir, originalName);
        if (await fileHash(original, 'sha256') !== cover.sha256) throw new Error('Cover checksum mismatch');
        const rel = 'materials-covers/victoria-20261012/' + cover.sha256 + '.jpg';
        const dest = path.join(uploadRoot, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(dest)) {
          const meta = await sharp(original).metadata();
          if (!meta.width || !meta.height) throw new Error('Invalid approved cover');
          await sharp(original).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 90 }).toFile(dest + '.partial');
          fs.renameSync(dest + '.partial', dest);
        }
        next.covers[cover.folder] = '/files/' + rel;
      }
    }
    const sourceAfter = await inventory();
    const sourceIdentity = list => list.map(f => f.path + ':' + f.size + ':' + (f.sha256 || f.md5)).sort().join('\n');
    if (sourceIdentity(sourceAfter.files) !== sourceIdentity(files) || [...sourceAfter.dirs].sort().join('\n') !== [...dirs].sort().join('\n')) throw new Error('Source changed during staging; no DB changes');
    // Re-read: no overwriting an administrator's edits made during a long transfer.
    const currentSetting = await prisma.systemSetting.findUnique({ where: { key: setting.key } });
    if (currentSetting.value !== setting.value) throw new Error('Layout changed during staging; rerun');
    const currentDocs = await prisma.document.findMany({});
    const remove = currentDocs.filter(d => replaceable(d, saved) && !files.some(f => d.description === '[yandex-local:' + f.path + ']'));
    const backupParent = path.join(uploadRoot, 'materials-backups');
    const backupRoot = path.join(backupParent, new Date().toISOString().replace(/[:.]/g, '-'));
    // nginx runs as another UID: private backups must not be downloadable.
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(backupParent, 0o700);
    fs.chmodSync(backupRoot, 0o700);
    fs.writeFileSync(path.join(backupRoot, 'documents-layout.json'), JSON.stringify({ documents: currentDocs, setting, sourceSetting: savedSource, files, removeIds: remove.map(d => d.id) }, null, 2), { mode: 0o600 });
    await prisma.$transaction(async tx => {
      const fresh = await tx.systemSetting.findUnique({ where: { key: setting.key } });
      if (fresh.value !== setting.value) throw new Error('Concurrent layout change');
      const freshSource = await tx.systemSetting.findUnique({ where: { key: 'MATERIALS_SOURCE_ROOT' } });
      if ((freshSource?.value || null) !== (savedSource?.value || null)) throw new Error('Concurrent source change');
      for (const f of files) {
        const description = '[yandex-local:' + f.path + ']';
        const matches = await tx.document.findMany({ where: { category: 'materials', description } });
        if (matches.length > 1) throw new Error('Duplicate material records: ' + f.path);
        const data = { name: f.name.replace(/\*+(?=\.[^.]+$)/, '').replace(/\.heic$/i, '.jpg'), type: path.extname(f.browserRel).slice(1).toUpperCase(), category: 'materials', subcategory: f.folder, project: f.project, fileUrl: f.fileUrl, fileSize: fs.statSync(path.join(uploadRoot, 'yandex', f.browserRel)).size, isPublic: true, sortOrder: 0, description };
        if (matches.length) await tx.document.update({ where: { id: matches[0].id }, data });
        else await tx.document.create({ data });
      }
      await tx.document.deleteMany({ where: { id: { in: remove.map(d => d.id) }, category: 'materials' } });
      await tx.systemSetting.update({ where: { key: setting.key }, data: { value: JSON.stringify(next) } });
      await tx.systemSetting.upsert({ where: { key: 'MATERIALS_SOURCE_ROOT' }, create: { key: 'MATERIALS_SOURCE_ROOT', value: ROOT }, update: { value: ROOT } });
      const count = await tx.document.count({ where: { category: 'materials', description: { startsWith: '[yandex-local:' + ROOT + '/' } } });
      if (count !== files.length) throw new Error('Published count mismatch');
    }, { timeout: 120000 });
    // Recoverable retirement: only files referenced by retired media, never PDFs,
    // calculator or still-referenced files. No recursive delete or global sweep.
    const remaining = await prisma.document.findMany({ select: { fileUrl: true } });
    const keep = new Set([...remaining.map(d => d.fileUrl), ...Object.values(next.covers || {})]);
    let retired = 0;
    for (const d of remove) {
      if (keep.has(d.fileUrl) || !d.fileUrl.startsWith('/files/yandex/')) continue;
      const rel = decodeURIComponent(d.fileUrl.slice('/files/'.length));
      for (const candidate of [rel, rel.replace(/^yandex\//, 'yandex-thumbs/') + '.thumb.jpg']) {
        const src = path.resolve(uploadRoot, candidate);
        if (!src.startsWith(uploadRoot + path.sep)) throw new Error('Unsafe retirement path');
        const dest = path.join(backupRoot, 'files', candidate);
        if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(src, dest); retired++; }
      }
    }
    console.log('PUBLISHED ' + JSON.stringify({ files: files.length, removedOldMedia: remove.length, retiredFiles: retired, backup: backupRoot }));
  } finally {
    if (locked) fs.rmdirSync(lock);
    await prisma.$disconnect();
  }
}
module.exports = { material, coverTargets, buildLayout, replaceable, inventory, validFile, main, sourceRoot };
if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
