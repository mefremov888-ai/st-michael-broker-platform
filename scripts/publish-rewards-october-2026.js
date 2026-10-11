'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const PDF_HASH = 'e2161fa26b105b3cec99a2e234315fb64fda1c2fd12b1db13107cc11697ce80d';
const PDF_SIZE = 1274759;
const OLD = { id: '5c2a4040-0e48-4bd6-8164-02d8a09cdc69', name: 'Условия сотрудничества сентябрь', category: 'cooperation', description: '[landing-rewards-button]', fileUrl: '/files/cooperation/33f2417b-965c-4efb-837d-982cb359d30b.pdf' };
const NEW = { id: 'e2161fa2-6b10-5b3c-ac99-a2e234315fb6', name: 'Условия вознаграждения ST MICHAEL — октябрь 2026', category: 'cooperation', description: '[landing-rewards-button]', type: 'PDF', fileSize: PDF_SIZE, fileUrl: '/files/cooperation/rewards-2026-10-11-e2161fa26b105b3c.pdf', isPublic: true };
const TARGET = '/app/uploads/cooperation/rewards-2026-10-11-e2161fa26b105b3c.pdf';
const OLD_MATERIAL = { id: 'b6dc68fe-f420-4b3f-8a66-559430e95589', name: 'Условия_вознаграждения_ST_MICHAEL_сентябрь_2026.pdf', category: 'materials', subcategory: 'Условия вознаграждения', description: '[yandex-local:/Условия вознаграждения  /Условия_вознаграждения_ST_MICHAEL_сентябрь_2026.pdf]', type: 'PDF', project: null, fileSize: 452625, fileUrl: '/files/yandex/%D0%A3%D1%81%D0%BB%D0%BE%D0%B2%D0%B8%D1%8F%20%D0%B2%D0%BE%D0%B7%D0%BD%D0%B0%D0%B3%D1%80%D0%B0%D0%B6%D0%B4%D0%B5%D0%BD%D0%B8%D1%8F/%D0%A3%D1%81%D0%BB%D0%BE%D0%B2%D0%B8%D1%8F_%D0%B2%D0%BE%D0%B7%D0%BD%D0%B0%D0%B3%D1%80%D0%B0%D0%B6%D0%B4%D0%B5%D0%BD%D0%B8%D1%8F_ST_MICHAEL_%D1%81%D0%B5%D0%BD%D1%82%D1%8F%D0%B1%D1%80%D1%8C_2026.pdf' };
const AD_HASH = 'da2ec1f91970b80cc5ff44fc076527e4b66c9f1b5d7cb883b793d93eac3c4085';
const AD_SIZE = 221309;
const NEW_AD = { id: 'da2ec1f9-1970-580c-85ff-44fc076527e4', name: 'Регламент размещения рекламы', category: 'cooperation', description: null, subcategory: null, project: null, type: 'PDF', fileSize: AD_SIZE, fileUrl: '/files/cooperation/advertising-regulation-2026-10-11-da2ec1f91970b80c.pdf', isPublic: true };
const AD_TARGET = '/app/uploads/cooperation/advertising-regulation-2026-10-11-da2ec1f91970b80c.pdf';
const ARCHIVED_MATERIAL_DESCRIPTION = '[archived:cooperation-current]' + OLD_MATERIAL.description;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function snapshotHash(row) {
  return sha(JSON.stringify({ id: row.id, name: row.name, category: row.category, subcategory: row.subcategory ?? null, project: row.project ?? null, description: row.description, fileUrl: row.fileUrl, isPublic: row.isPublic, type: row.type, fileSize: row.fileSize, sortOrder: row.sortOrder, updatedAt: new Date(row.updatedAt).toISOString() }));
}
function plan(old, candidates, oldMaterial, advertisingCandidates) {
  assert.ok(old && oldMaterial);
  for (const [key, value] of Object.entries(OLD)) assert.equal(old[key], value);
  for (const [key, value] of Object.entries(OLD_MATERIAL)) {
    assert.equal(oldMaterial[key], key === 'description' && (candidates.length || advertisingCandidates.length) ? ARCHIVED_MATERIAL_DESCRIPTION : value);
  }
  assert.ok(candidates.length <= 1 && advertisingCandidates.length <= 1);
  const expectedOldHash = sha(JSON.stringify({ old: snapshotHash(old), oldMaterial: snapshotHash(oldMaterial), rewardsCount: candidates.length, rewards: NEW, advertisingCount: advertisingCandidates.length, advertising: NEW_AD }));
  if (candidates.length || advertisingCandidates.length) {
    assert.equal(candidates.length, 1);
    assert.equal(advertisingCandidates.length, 1);
    for (const [key, value] of Object.entries(NEW)) assert.equal(candidates[0][key], value);
    for (const [key, value] of Object.entries(NEW_AD)) assert.equal(advertisingCandidates[0][key], value);
    assert.equal(candidates[0].sortOrder, old.sortOrder);
    assert.equal(advertisingCandidates[0].sortOrder, old.sortOrder + 1);
    assert.equal(old.isPublic, false);
    assert.equal(oldMaterial.isPublic, false);
    return { action: 'already-published', expectedOldHash };
  }
  assert.equal(old.isPublic, true);
  assert.equal(oldMaterial.isPublic, true);
  return { action: 'publish', expectedOldHash };
}
function verifyPdf(buffer, hash = PDF_HASH, size = PDF_SIZE) {
  assert.equal(buffer.length, size);
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.equal(sha(buffer), hash);
}
function verifyEnvironment(env) {
  assert.match(env.EXPECTED_DEPLOYED_SHA || '', /^[0-9a-f]{40}$/);
  assert.equal(env.GIT_SHA, env.EXPECTED_DEPLOYED_SHA);
  assert.match(env.PRODUCTION_PG_SYSTEM_IDENTIFIER || '', /^\d+$/);
  assert.match(env.PRODUCTION_MIN_BROKER_ROWS || '', /^[1-9]\d*$/);
  assert.ok(env.MODE === 'plan' || env.MODE === 'apply');
  if (env.MODE === 'apply') {
    assert.equal(env.CONFIRM_APPLY, 'true');
    assert.match(env.EXPECTED_OLD_HASH || '', /^[0-9a-f]{64}$/);
    assert.match(env.VERIFIED_BACKUP_SHA256 || '', /^[0-9a-f]{64}$/);
    const age = Date.now() - Date.parse(env.VERIFIED_BACKUP_AT || '');
    assert.ok(Number.isFinite(age) && age >= 0 && age <= 21600000);
  }
}
async function verifyPublicHash(doc, expectedHash) {
  const response = await fetch('https://broker.stmichael.ru' + doc.fileUrl, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert.ok(bytes <= doc.fileSize);
      hash.update(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  assert.equal(bytes, doc.fileSize);
  assert.equal(hash.digest('hex'), expectedHash);
}
async function readCase(tx) {
  const old = await tx.document.findUnique({ where: { id: OLD.id } });
  const oldMaterial = await tx.document.findUnique({ where: { id: OLD_MATERIAL.id } });
  const candidates = await tx.document.findMany({ where: { OR: [{ id: NEW.id }, { fileUrl: NEW.fileUrl }, { name: NEW.name }] } });
  // Fail closed on any pre-existing advertising document in this named case.
  const advertisingCandidates = await tx.document.findMany({ where: { OR: [{ id: NEW_AD.id }, { fileUrl: NEW_AD.fileUrl }, { name: { contains: NEW_AD.name, mode: 'insensitive' } }] } });
  return { old, oldMaterial, candidates, advertisingCandidates, ...plan(old, candidates, oldMaterial, advertisingCandidates) };
}
async function applyRecords(tx, expectedOldHash) {
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('publish-rewards-e2161fa2'))");
  const current = await readCase(tx);
  if (current.action === 'already-published') return;
  assert.equal(current.expectedOldHash, expectedOldHash);
  for (const [pinned, row] of [[OLD, current.old], [OLD_MATERIAL, current.oldMaterial]]) {
    const data = pinned === OLD_MATERIAL ? { isPublic: false, description: ARCHIVED_MATERIAL_DESCRIPTION } : { isPublic: false };
    const changed = await tx.document.updateMany({ where: { ...pinned, isPublic: true, updatedAt: row.updatedAt }, data });
    assert.equal(changed.count, 1);
  }
  await tx.document.create({ data: { ...NEW, sortOrder: current.old.sortOrder } });
  await tx.document.create({ data: { ...NEW_AD, sortOrder: current.old.sortOrder + 1 } });
  assert.equal((await readCase(tx)).action, 'already-published');
}
async function run(env = process.env) {
  verifyEnvironment(env);
  const source = env.SOURCE_PDF;
  assert.ok(source && fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink());
  const bytes = fs.readFileSync(source);
  verifyPdf(bytes);
  assert.ok(env.SOURCE_AD_PDF && fs.lstatSync(env.SOURCE_AD_PDF).isFile() && !fs.lstatSync(env.SOURCE_AD_PDF).isSymbolicLink());
  const adBytes = fs.readFileSync(env.SOURCE_AD_PDF);
  verifyPdf(adBytes, AD_HASH, AD_SIZE);
  const { PrismaClient } = require('/app/node_modules/@st-michael/database');
  const prisma = new PrismaClient();
  const createdFiles = [];
  let committed = false;
  try {
    const readPlan = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const identity = await tx.$queryRawUnsafe('SELECT system_identifier::text AS id FROM pg_control_system()');
      assert.equal(identity[0]?.id, env.PRODUCTION_PG_SYSTEM_IDENTIFIER);
      assert.ok(await tx.broker.count() >= Number(env.PRODUCTION_MIN_BROKER_ROWS));
      const current = await readCase(tx);
      return { action: current.action, expectedOldHash: current.expectedOldHash };
    });
    console.log(JSON.stringify({ ...readPlan, sourcePdfHash: PDF_HASH, advertisingPdfHash: AD_HASH, targetUrls: [NEW.fileUrl, NEW_AD.fileUrl], oldMaterialId: OLD_MATERIAL.id, offerAndAcceptancesUntouched: true }));
    if (env.MODE === 'plan') return;
    if (readPlan.action !== 'already-published') assert.equal(readPlan.expectedOldHash, env.EXPECTED_OLD_HASH);
    assert.equal(fs.realpathSync('/app/uploads/cooperation'), '/app/uploads/cooperation');
    for (const [target, buffer, doc, expectedHash] of [[TARGET, bytes, NEW, PDF_HASH], [AD_TARGET, adBytes, NEW_AD, AD_HASH]]) {
    assert.equal(path.dirname(target), '/app/uploads/cooperation');
    try {
      const fd = fs.openSync(target, 'wx', 0o644);
      try {
        const stat = fs.fstatSync(fd);
        createdFiles.push({ target, doc, ownedFileIdentity: `${stat.dev}:${stat.ino}` });
        fs.writeFileSync(fd, buffer);
        fs.fsyncSync(fd);
        // Explicitly restore nginx-readable permissions even under umask 077.
        fs.fchmodSync(fd, 0o644);
      } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    assert.ok(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink());
    verifyPdf(fs.readFileSync(target), expectedHash, doc.fileSize);
    // Verify nginx's persistent-volume mapping before changing any document row.
    await verifyPublicHash(doc, expectedHash);
    }
    await prisma.$transaction(async tx => {
      await applyRecords(tx, env.EXPECTED_OLD_HASH);
    }, { timeout: 20000 });
    committed = true;
    await Promise.all([verifyPublicHash(NEW, PDF_HASH), verifyPublicHash(NEW_AD, AD_HASH)]);
    console.log(JSON.stringify({ publicationCommitted: true, publicDownloadHashesVerified: true, oldRecordsArchived: 2, publishedPdfs: 2, sourcePdfHash: PDF_HASH, advertisingPdfHash: AD_HASH }));
  } finally {
    for (const { target, doc, ownedFileIdentity } of committed ? [] : createdFiles) {
      // Never delete an existing or referenced file. If DB is unavailable, leave
      // the verified orphan for inspection/retry rather than guessing ownership.
      try {
        const stat = fs.lstatSync(target);
        if (await prisma.document.count({ where: { fileUrl: doc.fileUrl } }) === 0 && !stat.isSymbolicLink() && `${stat.dev}:${stat.ino}` === ownedFileIdentity) fs.unlinkSync(target);
      } catch { console.log('new_uncommitted_file_cleanup_not_confirmed'); }
    }
    await prisma.$disconnect();
  }
}
module.exports = { OLD, OLD_MATERIAL, ARCHIVED_MATERIAL_DESCRIPTION, NEW, NEW_AD, PDF_HASH, PDF_SIZE, AD_HASH, AD_SIZE, TARGET, AD_TARGET, plan, snapshotHash, verifyPdf, verifyEnvironment, readCase, applyRecords, run };
if (require.main === module) {
  // Bound the process itself, not just the docker CLI: no publisher can remain
  // running after the SSH workflow releases its production lock.
  const watchdog = setTimeout(() => { console.error('REWARDS_PUBLICATION_TIMEOUT'); process.exit(1); }, 90000);
  run().catch(() => { console.error('REWARDS_PUBLICATION_FAILED'); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
}
