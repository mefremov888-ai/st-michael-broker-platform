#!/usr/bin/env node
// Read-only progress and post-publication evidence. Never modifies lock/files/DB.
const fs = require('node:fs');
const path = require('node:path');
function count(dir) {
  const result = { ready: 0, partial: 0, bytes: 0 };
  if (!fs.existsSync(dir)) return result;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const filename = path.join(dir, item.name);
    if (item.isDirectory()) {
      const child = count(filename);
      for (const key of Object.keys(result)) result[key] += child[key];
    } else if (item.name.endsWith('.partial') && /-[a-f0-9]{12}\./i.test(item.name)) result.partial++;
    else if (/-[a-f0-9]{12}\.[^.]+(?:\.thumb\.jpg)?$/i.test(item.name)) { result.ready++; result.bytes += fs.statSync(filename).size; }
  }
  return result;
}
async function main() {
  const { PrismaClient } = require('@st-michael/database');
  const db = new PrismaClient();
  try {
    const root = process.env.UPLOAD_ROOT || '/app/uploads';
    const free = fs.statfsSync(root);
    const source = await db.systemSetting.findUnique({ where: { key: 'MATERIALS_SOURCE_ROOT' } });
    const sourceRoot = source?.value || '/Новая версия';
    const allNewPathDocs = await db.document.findMany({ where: { category: 'materials', description: { startsWith: '[yandex-local:' + sourceRoot + '/' } } });
    const docs = allNewPathDocs.filter(d => /-[a-f0-9]{12}\.[^.]+$/i.test(d.fileUrl));
    const setting = await db.systemSetting.findUnique({ where: { key: 'MATERIALS_FOLDER_LAYOUT' } });
    const layout = setting ? JSON.parse(setting.value) : null;
    console.log(JSON.stringify({ sourceRoot, transferActive: fs.existsSync(path.join(root, '.materials-new-version.lock')), originals: count(path.join(root, 'yandex', sourceRoot.slice(1))), stagingAI: count(path.join(root, 'yandex', 'Версия ИИ')), thumbnails: count(path.join(root, 'yandex-thumbs', sourceRoot.slice(1))), published: docs.length, freeBytes: free.bavail * free.bsize, projectCounts: Object.fromEntries(['ZORGE9', 'SILVER_BOR'].map(p => [p, docs.filter(d => d.project === p).length])), tripleStarVideoCover: layout?.covers?.['Зорге 9/Видео'] }));
  } finally { await db.$disconnect(); }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
