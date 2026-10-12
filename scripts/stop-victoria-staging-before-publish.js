// Only stop this exact known AI staging implementation before it can publish.
// Keep every staged media file. Never stop the API or a scheduled legacy sync.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = '/app/uploads';
const expectedScriptSha = '6c90b37b072789f86414742f525cdd76035a44c01bed925e7e0c47bbe39fe9cc';
function candidates() {
  return fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).filter(p => {
    try {
      const args = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').split('\0').filter(Boolean);
      return args.length === 2 && /(^|\/)node$/.test(args[0]) && args[1] === '/app/scripts/materials-new-version.js';
    } catch { return false; }
  }).map(Number);
}
function originals(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? originals(dir + '/' + e.name) : /-[a-f0-9]{12}\.[^.]+$/.test(e.name) ? 1 : 0), 0);
}
async function main() {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/app/scripts/materials-new-version.js')).digest('hex'), expectedScriptSha);
  const list = candidates(); assert.equal(list.length, 1);
  const pid = list[0]; assert.equal(fs.statSync('/proc/' + pid).uid, process.getuid());
  // Check only these two non-secret process identity fields; never print environment.
  const environment = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
  assert.ok(environment.includes('MATERIALS_MODE=apply'));
  assert.ok(environment.includes('MATERIALS_SOURCE_ROOT=/Версия ИИ'));
  const { PrismaClient } = require('@st-michael/database');
  const db = new PrismaClient();
  let stopped = false;
  try {
    process.kill(pid, 'SIGSTOP'); stopped = true;
    const ready = originals(root + '/yandex/Версия ИИ');
    // The pinned implementation cannot dispatch any DB writes until all 1074
    // originals and posters exist. With it frozen and fewer than 900 originals,
    // its write phase is unreachable. Readbacks also guard unexpected state.
    assert.ok(ready > 0 && ready < 900);
    const source = await db.systemSetting.findUnique({ where: { key: 'MATERIALS_SOURCE_ROOT' } });
    assert.ok(!source || source.value === '/Новая версия');
    assert.equal(await db.document.count({ where: { category: 'materials', description: { startsWith: '[yandex-local:/Версия ИИ/' } } }), 0);
    assert.equal(await db.document.count({ where: { category: 'materials', description: { startsWith: '[yandex-local:/Новая версия/' } } }), 429);
    assert.deepEqual(candidates(), [pid]);
    process.kill(pid, 'SIGTERM'); process.kill(pid, 'SIGCONT'); stopped = false;
    for (let i = 0; i < 50 && candidates().includes(pid); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(!candidates().includes(pid), 'Staging process must exit');
    assert.deepEqual(fs.readdirSync(root + '/.materials-new-version.lock'), []);
    fs.rmdirSync(root + '/.materials-new-version.lock');
    console.log(JSON.stringify({ stoppedExactAIStaging: true, preservedOriginals: ready, databaseWrites: false, apiRestarted: false }));
  } finally {
    if (stopped) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await db.$disconnect();
  }
}
main().catch(e => { console.error('Safe staging stop refused: ' + e.name); process.exitCode = 1; });
