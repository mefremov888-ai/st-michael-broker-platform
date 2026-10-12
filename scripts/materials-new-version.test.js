const { test } = require('node:test');
const assert = require('node:assert/strict');
const { material, coverTargets, buildLayout, replaceable, sourceRoot, fetchHeaders } = require('./materials-new-version');
const make = (name, folder = 'Зорге 9/Фото/Лобби') => material({ name, path: '/Новая версия/' + folder + '/' + name, size: 100 });
const saved = { version: 1, groups: [], rules: [{ prefix: 'ЗОРГЕ 9', groupId: 'zorge' }, { prefix: 'Условия сотрудничества', groupId: null }], covers: { 'Зорге 9/Фото': 'old', 'Условия сотрудничества': 'keep' }, looseFolders: { 'Зорге 9/Видео': 'УТП' } };
test('stalled headers abort promptly while a responding large body keeps its transfer deadline', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/headers') res.flushHeaders();
    setTimeout(() => res.end('body'), 200);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await assert.rejects(fetchHeaders(base + '/stall', 2000, 50));
    const response = await fetchHeaders(base + '/headers', 2000, 50);
    assert.equal(await response.text(), 'body');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('Victoria source is explicit, isolated, and preserves approved hierarchy', () => {
  const f = material({ name: 'Фото — 01.jpg', path: '/Версия ИИ/Зорге 9/Архитектура/Фото/Фото — 01.jpg', size: 1 }, '/Версия ИИ');
  assert.equal(f.folder, 'Зорге 9/Архитектура/Фото');
  assert.ok(f.rel.startsWith('Версия ИИ/'));
  assert.throws(() => sourceRoot('/'));
  assert.throws(() => material({ name: 'x.jpg', path: '/Версия ИИ/Зорге 9/../x.jpg' }, '/Версия ИИ'));
  const c = require('../data/victoria-covers-20261012.json');
  assert.equal(c.length, 80);
  assert.equal(c.filter(x => x.folder && /^[a-f0-9]{64}$/.test(x.sha256)).length, 79);
  assert.equal(new Set(c.map(x => x.folder)).size, 80);
});
test('one/two stars and explicit triple-video destination', () => {
  assert.deepEqual(coverTargets(make('Лобби*.jpg')), ['Зорге 9/Фото/Лобби']);
  assert.deepEqual(coverTargets(make('Лобби**.jpg')), ['Зорге 9/Фото/Лобби', 'Зорге 9/Фото']);
  const triple = make('Вечерний Зорге — 1***.MOV', 'Зорге 9/Видео/Теплый период — весна, лето, осень');
  assert.deepEqual(coverTargets(triple), [triple.folder, 'Зорге 9/Видео']);
  assert.throws(() => coverTargets(make('Неизвестно***.jpg')));
});
test('preserve hierarchy, replace old covers and virtual folders, keep cooperation', () => {
  const f = make('Лобби**.jpg');
  const layout = buildLayout(saved, [f]);
  assert.equal(layout.covers['Зорге 9/Фото'], f.fileUrl);
  assert.equal(layout.covers['Условия сотрудничества'], 'keep');
  assert.deepEqual(layout.looseFolders, {});
  assert.ok(layout.rules.some(r => r.prefix === 'Зорге 9/Фото' && r.kind === 'as_is' && r.displayName === 'Фото'));
  assert.ok(layout.rules.some(r => r.prefix === 'Условия сотрудничества'));
});
test('case/star filename collisions avoided; traversal/outside source rejected', () => {
  assert.notEqual(make('IMG.MOV').rel.toLowerCase(), make('IMG.mov').rel.toLowerCase());
  assert.notEqual(make('Лобби*.jpg').rel, make('Лобби_.jpg').rel);
  assert.throws(() => material({ name: 'a.jpg', path: '/Старое/a.jpg' }));
});
test('explicit conflicting covers fail closed', () => {
  assert.throws(() => buildLayout(saved, [make('1*.jpg'), make('2*.jpg')]), /Conflicting covers/);
});
test('single-star folder cover takes priority over ancestor-cover propagation', () => {
  const direct = make('Для папки*.jpg');
  const ancestor = make('Для родителя**.jpg');
  for (const files of [[direct, ancestor], [ancestor, direct]]) {
    const layout = buildLayout(saved, files);
    assert.equal(layout.covers[direct.folder], direct.fileUrl);
    assert.equal(layout.covers['Зорге 9/Фото'], ancestor.fileUrl);
  }
});
test('retirement scoped to old project media, not cooperation or calculator', () => {
  assert.ok(replaceable({ category: 'materials', name: 'old.jpg', subcategory: 'ЗОРГЕ 9/Фото' }, saved));
  assert.ok(!replaceable({ category: 'cooperation', name: 'old.jpg', project: 'ZORGE9' }, saved));
  assert.ok(!replaceable({ category: 'materials', name: 'Условия.pdf', project: 'ZORGE9' }, saved));
  assert.ok(!replaceable({ category: 'materials', name: 'calculator.html', project: 'SILVER_BOR' }, saved));
});
test('document-folder covers do not reference retired project media', () => {
  const f = make('Лобби*.jpg');
  const before = { ...saved, covers: { 'Условия сотрудничества': '/files/yandex/ЗОРГЕ 9/old.jpg' } };
  const after = buildLayout(before, [f]);
  assert.equal(after.covers['Условия сотрудничества'], f.fileUrl);
});
test('HEIC original retained, compatible JPEG used on both UI surfaces', () => {
  const f = make('Благоустройство.heic');
  assert.ok(f.originalFileUrl.endsWith('.heic'));
  assert.ok(f.fileUrl.endsWith('.jpg'));
  assert.notEqual(f.browserRel, f.rel);
});
