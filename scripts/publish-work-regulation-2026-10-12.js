'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
// Exact reviewed and visually verified PDF; never accept unpinned replacement bytes.
const PDF_HASH = '55f22d405f018b4668b5bf64748b08597796bfd97a6c2db162b4847c5d3f9906';
const PDF_SIZE = 97222;
const NEW = { id: '61220260-1012-5a00-8000-000000000001', name: 'Регламент работы с брокерами — редакция 12.10.2026', category: 'cooperation', subcategory: null, project: null, description: 'Редакция 12 октября 2026 года', type: 'PDF', fileSize: PDF_SIZE, fileUrl: '/files/cooperation/work-regulation-2026-10-12.pdf', isPublic: true };
const TARGET = '/app/uploads/cooperation/work-regulation-2026-10-12.pdf';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function snapshot(row) {
  return { id: row.id, name: row.name, category: row.category, subcategory: row.subcategory ?? null, project: row.project ?? null, description: row.description ?? null, fileUrl: row.fileUrl, isPublic: row.isPublic, type: row.type, fileSize: row.fileSize, sortOrder: row.sortOrder, updatedAt: new Date(row.updatedAt).toISOString() };
}
function isOldWork(row) {
  return row.id !== NEW.id && /(?:регламент.*работ|reglament[_ -]?rabot)/i.test(row.name) && !/(?:реклам|advertis|вознаграж|оферт)/i.test(row.name) && ['cooperation', 'materials'].includes(row.category) && row.type === 'PDF';
}
function parseIds(value = '[]') {
  const ids = JSON.parse(value);
  assert.ok(Array.isArray(ids) && ids.length <= 20 && ids.every(id => /^[a-z0-9-]{1,80}$/i.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  return ids.sort();
}
function plan(rows, approvedIds = []) {
  const ordered = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const current = ordered.filter(row => row.id === NEW.id || row.fileUrl === NEW.fileUrl || row.description === NEW.description || row.name === NEW.name);
  assert.ok(current.length <= 1);
  const old = ordered.filter(row => row.id !== NEW.id);
  assert.ok(old.every(isOldWork), 'Unexpected document in scoped case');
  const publicOld = old.filter(row => row.isPublic);
  const expectedOldHash = sha(JSON.stringify({ rows: ordered.map(snapshot), next: NEW, pdfHash: PDF_HASH }));
  if (current.length) {
    for (const [key, value] of Object.entries(NEW)) assert.equal(current[0][key], value);
    assert.equal(publicOld.length, 0, 'Old public WORK document remains');
    return { action: 'already-published', expectedOldHash, old, publicOld, sortOrder: current[0].sortOrder };
  }
  const actualIds = publicOld.map(row => row.id).sort();
  const ready = JSON.stringify(actualIds) === JSON.stringify([...approvedIds].sort());
  return { action: ready ? 'publish' : 'review-old-work-document-ids', expectedOldHash, old, publicOld, sortOrder: publicOld.length ? Math.min(...publicOld.map(row => row.sortOrder)) : 2 };
}
function verifyPdf(bytes) {
  assert.match(PDF_HASH, /^[a-f0-9]{64}$/);
  assert.ok(PDF_SIZE > 0);
  assert.equal(bytes.length, PDF_SIZE);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(sha(bytes), PDF_HASH);
}
function verifyEnvironment(env) {
  assert.match(env.EXPECTED_DEPLOYED_SHA || '', /^[a-f0-9]{40}$/);
  assert.equal(env.GIT_SHA, env.EXPECTED_DEPLOYED_SHA);
  assert.match(env.PRODUCTION_PG_SYSTEM_IDENTIFIER || '', /^\d+$/);
  assert.match(env.PRODUCTION_MIN_BROKER_ROWS || '', /^[1-9]\d*$/);
  assert.ok(['plan', 'apply'].includes(env.MODE));
  parseIds(env.APPROVED_OLD_IDS);
  if (env.MODE === 'apply') {
    assert.equal(env.CONFIRM_APPLY, 'true');
    assert.match(env.EXPECTED_OLD_HASH || '', /^[a-f0-9]{64}$/);
    assert.match(env.VERIFIED_BACKUP_SHA256 || '', /^[a-f0-9]{64}$/);
    const age = Date.now() - Date.parse(env.VERIFIED_BACKUP_AT || '');
    assert.ok(Number.isFinite(age) && age >= 0 && age <= 21600000);
  }
}
async function readCase(tx, ids) {
  const rows = await tx.document.findMany({ where: { OR: [
    { id: NEW.id }, { fileUrl: NEW.fileUrl }, { description: NEW.description }, { name: NEW.name },
    { name: { contains: 'Регламент', mode: 'insensitive' } }, { name: { contains: 'reglament', mode: 'insensitive' } },
  ] } });
  const relevant = rows.filter(row => isOldWork(row) || row.id === NEW.id || row.fileUrl === NEW.fileUrl || row.description === NEW.description || row.name === NEW.name);
  return plan(relevant, ids);
}
async function applyRecords(tx, expectedHash, ids) {
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('publish-work-regulation-2026-10-12'))");
  const current = await readCase(tx, ids);
  if (current.action === 'already-published') return;
  assert.equal(current.action, 'publish');
  assert.equal(current.expectedOldHash, expectedHash);
  for (const row of current.publicOld) {
    const changed = await tx.document.updateMany({ where: { ...snapshot(row), updatedAt: row.updatedAt }, data: { isPublic: false, description: '[archived:work-regulation-2026-10-12]' + (row.description || '') } });
    assert.equal(changed.count, 1);
  }
  await tx.document.create({ data: { ...NEW, sortOrder: current.sortOrder } });
  assert.equal((await readCase(tx, ids)).action, 'already-published');
}
async function verifyPublicHash() {
  const response = await fetch('https://broker.stmichael.ru' + NEW.fileUrl, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      assert.ok(bytes <= PDF_SIZE);
      hash.update(value.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  assert.equal(bytes, PDF_SIZE);
  assert.equal(hash.digest('hex'), PDF_HASH);
}
async function run(env = process.env) {
  verifyEnvironment(env);
  const ids = parseIds(env.APPROVED_OLD_IDS);
  assert.ok(env.SOURCE_PDF && fs.lstatSync(env.SOURCE_PDF).isFile() && !fs.lstatSync(env.SOURCE_PDF).isSymbolicLink());
  const bytes = fs.readFileSync(env.SOURCE_PDF);
  verifyPdf(bytes);
  const { PrismaClient } = require('/app/node_modules/@st-michael/database');
  const prisma = new PrismaClient();
  let ownedIdentity = null;
  let committed = false;
  try {
    const current = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const identity = await tx.$queryRawUnsafe('SELECT system_identifier::text AS id FROM pg_control_system()');
      assert.equal(identity[0]?.id, env.PRODUCTION_PG_SYSTEM_IDENTIFIER);
      assert.ok(await tx.broker.count() >= Number(env.PRODUCTION_MIN_BROKER_ROWS));
      return readCase(tx, ids);
    });
    console.log(JSON.stringify({ action: current.action, expectedOldHash: current.expectedOldHash, oldWorkCandidates: current.old.map(snapshot), archiveIds: current.publicOld.map(row => row.id), sourcePdfHash: PDF_HASH, targetUrl: NEW.fileUrl, offerAdvertisingRewardsAndAcceptancesUntouched: true }));
    if (env.MODE === 'plan') return;
    if (current.action !== 'already-published') {
      assert.equal(current.action, 'publish');
      assert.equal(current.expectedOldHash, env.EXPECTED_OLD_HASH);
    }
    assert.equal(fs.realpathSync(path.dirname(TARGET)), '/app/uploads/cooperation');
    try {
      const fd = fs.openSync(TARGET, 'wx', 0o644);
      try {
        const stat = fs.fstatSync(fd);
        ownedIdentity = `${stat.dev}:${stat.ino}`;
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.fchmodSync(fd, 0o644);
      } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    assert.ok(fs.lstatSync(TARGET).isFile() && !fs.lstatSync(TARGET).isSymbolicLink());
    verifyPdf(fs.readFileSync(TARGET));
    await verifyPublicHash();
    await prisma.$transaction(tx => applyRecords(tx, env.EXPECTED_OLD_HASH, ids), { timeout: 20000 });
    committed = true;
    await verifyPublicHash();
    console.log(JSON.stringify({ publicationCommitted: true, publicDownloadHashVerified: true, document: NEW, oldFilesPreserved: true }));
  } finally {
    if (!committed && ownedIdentity) {
      try {
        const stat = fs.lstatSync(TARGET);
        if (!stat.isSymbolicLink() && `${stat.dev}:${stat.ino}` === ownedIdentity && await prisma.document.count({ where: { fileUrl: NEW.fileUrl } }) === 0) fs.unlinkSync(TARGET);
      } catch { console.log('new_uncommitted_file_cleanup_not_confirmed'); }
    }
    await prisma.$disconnect();
  }
}
module.exports = { NEW, PDF_HASH, PDF_SIZE, snapshot, isOldWork, parseIds, plan, verifyPdf, verifyEnvironment, readCase, applyRecords, run };
if (require.main === module) {
  const watchdog = setTimeout(() => { console.error('WORK_REGULATION_PUBLICATION_TIMEOUT'); process.exit(1); }, 90000);
  run().catch(() => { console.error('WORK_REGULATION_PUBLICATION_FAILED'); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
}
