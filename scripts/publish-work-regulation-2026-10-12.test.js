const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { NEW, PDF_HASH, PDF_SIZE, isOldWork, parseIds, plan, verifyPdf, verifyEnvironment, applyRecords } = require('./publish-work-regulation-2026-10-12');
const old = () => ({ id: 'old-work-id', name: 'reglament_raboty.pdf', category: 'cooperation', type: 'PDF', fileUrl: '/files/cooperation/old.pdf', isPublic: true, description: null, subcategory: null, project: null, fileSize: 201300, sortOrder: 2, updatedAt: new Date('2026-10-11T10:00:00Z') });
test('only old WORK documents qualify; advertising/offer/rewards never qualify', () => {
  assert.equal(isOldWork(old()), true);
  for (const name of ['Регламент размещения рекламы', 'Регламент работы рекламы', 'Договор-оферта', 'Условия вознаграждения', 'Регламент работы оферта']) assert.equal(isOldWork({ ...old(), name }), false);
  assert.equal(isOldWork({ ...old(), category: 'marketing' }), false);
});
test('unknown old IDs require inspection; exact IDs only authorize archive', () => {
  const review = plan([old()]);
  assert.equal(review.action, 'review-old-work-document-ids');
  assert.equal(plan([old()], ['old-work-id']).action, 'publish');
  assert.equal(plan([old()], ['other-id']).action, 'review-old-work-document-ids');
  assert.notEqual(plan([{ ...old(), updatedAt: new Date() }]).expectedOldHash, review.expectedOldHash);
  assert.throws(() => plan([{ ...old(), name: 'Регламент размещения рекламы' }]));
  assert.throws(() => parseIds('["id","id"]'));
  assert.throws(() => parseIds('["../../etc"]'));
});
test('idempotence needs exact published metadata with no old public WORK row', () => {
  const current = { ...NEW, sortOrder: 2, updatedAt: new Date() };
  assert.equal(plan([current, { ...old(), isPublic: false }]).action, 'already-published');
  assert.throws(() => plan([current, old()]));
  assert.throws(() => plan([{ ...current, name: 'Changed' }]));
  assert.throws(() => plan([current, { ...current, id: 'other' }]));
});
test('reviewed binary is pinned and wrong bytes refuse', () => {
  const bytes = readFileSync(require('node:path').join(__dirname, '../assets/cooperation/work-regulation-2026-10-12.pdf'));
  verifyPdf(bytes);
  assert.equal(bytes.length, PDF_SIZE);
  assert.match(PDF_HASH, /^[0-9a-f]{64}$/);
  assert.throws(() => verifyPdf(Buffer.from('%PDF-wrong')));
});
test('apply requires live SHA, identity, approved IDs and fresh verified backup', () => {
  const env = { MODE: 'plan', EXPECTED_DEPLOYED_SHA: 'a'.repeat(40), GIT_SHA: 'a'.repeat(40), PRODUCTION_PG_SYSTEM_IDENTIFIER: '123', PRODUCTION_MIN_BROKER_ROWS: '100', APPROVED_OLD_IDS: '[]' };
  verifyEnvironment(env);
  assert.throws(() => verifyEnvironment({ ...env, MODE: 'apply' }));
  const apply = { ...env, MODE: 'apply', CONFIRM_APPLY: 'true', EXPECTED_OLD_HASH: 'b'.repeat(64), VERIFIED_BACKUP_SHA256: 'c'.repeat(64), VERIFIED_BACKUP_AT: new Date().toISOString() };
  verifyEnvironment(apply);
  assert.throws(() => verifyEnvironment({ ...apply, GIT_SHA: 'd'.repeat(40) }));
  assert.throws(() => verifyEnvironment({ ...apply, VERIFIED_BACKUP_AT: new Date(Date.now() - 21600001).toISOString() }));
});
test('scoped script never deletes old records/files or writes offers/rewards/advertising', () => {
  const code = readFileSync(require.resolve('./publish-work-regulation-2026-10-12'), 'utf8');
  assert.match(code, /REPEATABLE READ READ ONLY/);
  assert.match(code, /pg_advisory_xact_lock/);
  assert.match(code, /openSync\(TARGET, 'wx'/);
  assert.match(code, /ownedIdentity/);
  assert.match(code, /fchmodSync\(fd, 0o644\)/);
  assert.doesNotMatch(code, /document\.delete|offerAcceptance\.|siteContent\.|execSync/);
  const workflow = readFileSync(require('node:path').join(__dirname, '../.github/workflows/publish-work-regulation-2026-10-12.yml'), 'utf8');
  assert.match(workflow, /options: \[plan, apply\]\s+default: plan/);
  assert.match(workflow, /head_sha == \$sha/);
  assert.match(workflow, /test "\$reviewed_blob" = "\$deployed_blob"/);
  assert.match(workflow, /APPROVED_OLD_IDS="\$approved_ids"/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /flock -x -n 9/);
  assert.match(workflow, /pg_restore --exit-on-error --no-owner --file=\/dev\/null/);
  assert.doesNotMatch(workflow, /docker compose up|git pull|restart|system prune|SOURCE_AD_PDF/);
});
function fixture(failure) {
  let rows = [old()];
  const tx = { $executeRawUnsafe: async () => 1, document: {
    findMany: async () => rows,
    updateMany: async ({ where, data }) => {
      if (failure === 'cas') return { count: 0 };
      const found = rows.filter(row => row.id === where.id && row.isPublic === where.isPublic && +row.updatedAt === +where.updatedAt);
      found.forEach(row => Object.assign(row, data));
      return { count: found.length };
    },
    create: async ({ data }) => { if (failure === 'create') throw new Error('create fails'); rows.push({ ...data, updatedAt: new Date() }); },
  } };
  return { rows: () => rows, async transaction(fn) { const saved = structuredClone(rows); try { await fn(tx); } catch (error) { rows = saved; throw error; } } };
}
test('atomic archive/create is idempotent; stale hash or failed CAS/create rolls back', async () => {
  const ids = ['old-work-id'];
  const hash = plan([old()], ids).expectedOldHash;
  const db = fixture();
  await db.transaction(tx => applyRecords(tx, hash, ids));
  assert.equal(db.rows().length, 2);
  assert.equal(db.rows()[0].isPublic, false);
  const before = JSON.stringify(db.rows());
  await db.transaction(tx => applyRecords(tx, hash, ids));
  assert.equal(JSON.stringify(db.rows()), before);
  for (const failure of ['cas', 'create', 'hash']) {
    const broken = fixture(failure);
    await assert.rejects(broken.transaction(tx => applyRecords(tx, failure === 'hash' ? '0'.repeat(64) : hash, ids)));
    assert.equal(broken.rows().length, 1);
    assert.equal(broken.rows()[0].isPublic, true);
  }
});
