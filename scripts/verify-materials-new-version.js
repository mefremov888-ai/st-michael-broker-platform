#!/usr/bin/env node
// Full post-publication audit: both UI mappings + public API + every original
// and thumbnail. Read-only, no login impersonation, no file/DB writes.
const assert = require('node:assert/strict');
const { PrismaClient } = require('@st-michael/database');
const { withDisplaySubcategory } = require('@st-michael/shared');
const origin = 'https://broker.stmichael.ru';
async function request(url, options = {}) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const response = await fetch(new URL(url, origin), { ...options, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(response.status + ' ' + url);
      return response;
    } catch (e) { last = e; }
  }
  throw last;
}
async function main() {
  const db = new PrismaClient();
  try {
    const source = await db.systemSetting.findUnique({ where: { key: 'MATERIALS_SOURCE_ROOT' } });
    const root = source?.value || '/Новая версия';
    const { inventory } = require('./materials-new-version');
    const expected = await inventory(root, [], [], root);
    const docs = await db.document.findMany({ where: { category: 'materials', description: { startsWith: '[yandex-local:' + root + '/' } } });
    assert.equal(docs.length, expected.files.length, 'Published source count');
    for (const f of expected.files) assert.ok(docs.some(d => d.description === '[yandex-local:' + f.path + ']' && d.fileUrl === f.fileUrl), 'Source file included');
    assert.ok(docs.every(d => /-[a-f0-9]{12}\.[^.]+$/i.test(d.fileUrl)), 'All originals use the verified publication paths');
    const saved = await db.systemSetting.findUnique({ where: { key: 'MATERIALS_FOLDER_LAYOUT' } });
    const layout = JSON.parse(saved.value);
    const landing = withDisplaySubcategory(docs, layout, 'landing');
    const cabinet = withDisplaySubcategory(docs, layout, 'cabinet');
    const topology = a => a.map(d => d.id + ':' + d.subcategory).sort();
    assert.deepEqual(topology(landing), topology(cabinet), 'Landing/cabinet hierarchy must match');
    assert.equal(landing.length, docs.length, 'Every new material visible on both surfaces');
    for (const d of landing) assert.equal(d.subcategory, docs.find(old => old.id === d.id).subcategory, 'Source hierarchy preserved');
    const publicPayload = await (await request('/api/public/documents?category=materials&limit=2000')).json();
    const publicDocs = Array.isArray(publicPayload) ? publicPayload : publicPayload.documents;
    assert.ok(Array.isArray(publicDocs), 'Public API response');
    for (const d of docs) assert.ok(publicDocs.some(p => p.id === d.id && p.fileUrl === d.fileUrl), 'Public API contains ' + d.name);
    let cursor = 0, verified = 0;
    const errors = [];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < docs.length) {
        const d = docs[cursor++];
        try {
          const original = await request(d.fileUrl, { method: 'HEAD' });
          assert.equal(Number(original.headers.get('content-length')), d.fileSize, 'Original byte length: ' + d.name);
          const thumbUrl = d.fileUrl.replace('/files/yandex/', '/files/yandex-thumbs/') + '.thumb.jpg';
          const thumbnail = await request(thumbUrl, { method: 'HEAD' });
          assert.match(thumbnail.headers.get('content-type') || '', /image\/jpeg/i, 'Thumbnail MIME');
          assert.ok(Number(thumbnail.headers.get('content-length')) > 0, 'Thumbnail not empty');
          verified++;
        } catch (e) { errors.push(d.name + ': ' + e.message); }
      }
    }));
    const cooperation = await (await request('/api/public/documents?category=cooperation')).json();
    const publishedCooperation = Array.isArray(cooperation) ? cooperation : cooperation.documents;
    assert.ok(publishedCooperation.some(d => /Условия вознаграждения ST MICHAEL/i.test(d.name)));
    assert.ok(publishedCooperation.some(d => /Калькулятор рассрочки/i.test(d.name) && /\.html$/i.test(d.fileUrl)));
    for (const d of publishedCooperation) await request(d.fileUrl, { method: 'HEAD' });
    for (const url of new Set(Object.values(layout.covers || {}))) {
      const coverUrl = url.startsWith('/files/yandex/') ? url.replace('/files/yandex/', '/files/yandex-thumbs/') + '.thumb.jpg' : url;
      await request(coverUrl, { method: 'HEAD' });
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ result: 'PASS', materials: docs.length, originalsHttpVerified: verified, thumbnailsHttpVerified: verified, identicalHierarchy: true, cooperationDocuments: publishedCooperation.map(d => d.name), videoCover: layout.covers['Зорге 9/Видео'] }));
  } finally { await db.$disconnect(); }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
