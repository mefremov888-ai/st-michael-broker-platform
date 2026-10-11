const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { OLD, OLD_MATERIAL, ARCHIVED_MATERIAL_DESCRIPTION, NEW, NEW_AD, plan, verifyPdf, verifyEnvironment, applyRecords } = require('./publish-rewards-october-2026');
const old = () => ({ ...OLD, isPublic: true, type: 'PDF', fileSize: 97000, sortOrder: 0, updatedAt: new Date('2026-10-11T12:00:00Z') });
const material = () => ({ ...OLD_MATERIAL, isPublic: true, sortOrder: 0, updatedAt: new Date('2026-09-29T04:00:38.209Z') });
const publishedMaterial = () => ({ ...material(), isPublic: false, description: ARCHIVED_MATERIAL_DESCRIPTION });
test('exact old document only; date/URL drift changes plan or refuses', () => {
  const expected = plan(old(), [], material(), []);
  assert.equal(expected.action, 'publish');
  assert.match(expected.expectedOldHash, /^[a-f0-9]{64}$/);
  assert.throws(() => plan({ ...old(), fileUrl: '/files/other.pdf' }, [], material(), []));
  assert.notEqual(plan({ ...old(), updatedAt: new Date() }, [], material(), []).expectedOldHash, expected.expectedOldHash);
  assert.notEqual(plan(old(), [], { ...material(), updatedAt: new Date() }, []).expectedOldHash, expected.expectedOldHash);
  assert.throws(() => plan(old(), [], { ...material(), name: 'Another file' }, []));
  assert.throws(() => plan(old(), [], material(), [{ ...NEW_AD, id: 'existing-other' }]));
});
test('idempotence requires exact new metadata and archived exact old row', () => {
  assert.equal(plan({ ...old(), isPublic: false }, [{ ...NEW, sortOrder: 0 }], publishedMaterial(), [{ ...NEW_AD, sortOrder: 1 }]).action, 'already-published');
  assert.throws(() => plan(old(), [{ ...NEW, sortOrder: 0 }], material(), []));
  assert.throws(() => plan({ ...old(), isPublic: false }, [{ ...NEW, name: 'Changed', sortOrder: 0 }], publishedMaterial(), [{ ...NEW_AD, sortOrder: 1 }]));
  assert.throws(() => plan(old(), [{ ...NEW }, { ...NEW }], material(), []));
  assert.throws(() => plan({ ...old(), isPublic: false }, [{ ...NEW, sortOrder: 0 }], { ...material(), isPublic: false }, [{ ...NEW_AD, sortOrder: 1 }]));
  assert.throws(() => plan({ ...old(), isPublic: false }, [{ ...NEW, sortOrder: 0 }], publishedMaterial(), [{ ...NEW_AD, sortOrder: 1 }, { ...NEW_AD }]));
});
test('apply cannot run without explicit confirmation, case hash and fresh backup attestation', () => {
  const env = { MODE: 'plan', EXPECTED_DEPLOYED_SHA: 'a'.repeat(40), GIT_SHA: 'a'.repeat(40), PRODUCTION_PG_SYSTEM_IDENTIFIER: '123', PRODUCTION_MIN_BROKER_ROWS: '100' };
  verifyEnvironment(env);
  assert.throws(() => verifyEnvironment({ ...env, MODE: 'apply' }));
  const apply = { ...env, MODE: 'apply', CONFIRM_APPLY: 'true', EXPECTED_OLD_HASH: 'a'.repeat(64), VERIFIED_BACKUP_SHA256: 'b'.repeat(64), VERIFIED_BACKUP_AT: new Date().toISOString() };
  verifyEnvironment(apply);
  assert.throws(() => verifyEnvironment({ ...apply, VERIFIED_BACKUP_AT: '2026-01-01' }));
  assert.throws(() => verifyEnvironment({ ...apply, VERIFIED_BACKUP_AT: new Date(Date.now() - 21600001).toISOString() }));
});
test('PDF verification does not accept another file or placeholder', () => {
  assert.throws(() => verifyPdf(Buffer.from('%PDF-fake')));
});
test('writes are scoped, exclusive and old files and offer acceptances are untouched', () => {
  const code = readFileSync(require.resolve('./publish-rewards-october-2026'), 'utf8');
  assert.match(code, /openSync\(target, 'wx'/);
  assert.match(code, /REPEATABLE READ READ ONLY/);
  assert.match(code, /pg_advisory_xact_lock/);
  assert.match(code, /where: \{ \.\.\.pinned, isPublic: true, updatedAt: row\.updatedAt \}/);
  assert.match(code, /await verifyPublicHash\(doc, expectedHash\)/);
  assert.match(code, /ownedFileIdentity/);
  assert.match(code, /fchmodSync\(fd, 0o644\)/);
  assert.match(code, /90000/);
  assert.doesNotMatch(code, /document\.delete|offerAcceptance\.|siteContent\.|execSync|unlinkSync\(source/);
});

test('workflow defaults to plan, uses existing exact-SHA backups and strict production identity', () => {
  const path = require('node:path');
  const text = readFileSync(path.join(__dirname, '../.github/workflows/publish-rewards-october-2026.yml'), 'utf8');
  assert.match(text, /options: \[plan, apply\]\s+default: plan/);
  assert.match(text, /PUBLISH_APPROVED_CURRENT_TWO_PDFS/);
  assert.match(text, /expected_old_hash/);
  assert.match(text, /head_sha == \$sha/);
  assert.match(text, /\/var\/backups\/stmichael\/loyalty-predeploy/);
  assert.match(text, /loyalty-predeploy-\$\{source_sha\}-run\$\{backup_run\}-attempt\$\{backup_attempt\}\.dump/);
  assert.match(text, /-le 21600/);
  assert.match(text, /pg_restore --exit-on-error --no-owner --file=\/dev\/null/);
  assert.match(text, /StrictHostKeyChecking=yes/);
  assert.match(text, /flock -x -n 9/);
  assert.match(text, /DOCKER_HOST/);
  assert.match(text, /com\.docker\.compose\.service/);
  assert.match(text, /base64 -w 0 "\$archive"/);
  assert.match(text, /git show "\$SOURCE_SHA:\$file"/);
  assert.doesNotMatch(text, /docker compose up|restart|git pull|system prune|pg_restore.*-d broker_platform/);
});

function databaseFixture(failure) {
  let rows = [old(), material()];
  let writes = 0;
  const matches = (row, where) => Object.entries(where).every(([key, value]) => value && typeof value === 'object' && !(value instanceof Date) ? String(row[key]).toLowerCase().includes(value.contains.toLowerCase()) : value instanceof Date ? new Date(row[key]).getTime() === value.getTime() : row[key] === value);
  const tx = { $executeRawUnsafe: async () => 1, document: {
    findUnique: async ({ where }) => rows.find(row => row.id === where.id),
    findMany: async ({ where }) => rows.filter(row => where.OR.some(item => matches(row, item))),
    updateMany: async ({ where, data }) => {
      writes++;
      if (failure === 'second-cas' && writes === 2) return { count: 0 };
      const found = rows.filter(row => matches(row, where));
      found.forEach(row => Object.assign(row, data));
      return { count: found.length };
    },
    create: async ({ data }) => {
      if (failure === 'second-create' && data.id === NEW_AD.id) throw new Error('test create failure');
      rows.push({ ...data, updatedAt: new Date() });
      return data;
    },
  } };
  return { rows: () => rows, async transaction(fn) {
    const saved = structuredClone(rows);
    try { return await fn(tx); } catch (error) { rows = saved; throw error; }
  } };
}

test('one atomic transaction archives exact two rows, publishes exact two PDFs and rerun writes nothing', async () => {
  const db = databaseFixture();
  const hash = plan(old(), [], material(), []).expectedOldHash;
  await db.transaction(tx => applyRecords(tx, hash));
  assert.equal(db.rows().length, 4);
  assert.equal(db.rows().find(row => row.id === OLD_MATERIAL.id).description, ARCHIVED_MATERIAL_DESCRIPTION);
  assert.equal(db.rows().filter(row => row.isPublic).length, 2);
  const before = JSON.stringify(db.rows());
  await db.transaction(tx => applyRecords(tx, hash));
  assert.equal(JSON.stringify(db.rows()), before);
});

test('CAS/create failure rolls back both old archives and all newly created rows in transaction harness', async () => {
  for (const failure of ['second-cas', 'second-create']) {
    const db = databaseFixture(failure);
    await assert.rejects(db.transaction(tx => applyRecords(tx, plan(old(), [], material(), []).expectedOldHash)));
    assert.equal(db.rows().length, 2);
    assert.ok(db.rows().every(row => row.isPublic));
    assert.equal(db.rows()[1].description, OLD_MATERIAL.description);
  }
  const db = databaseFixture();
  await assert.rejects(db.transaction(tx => applyRecords(tx, '0'.repeat(64))));
  assert.ok(db.rows().every(row => row.isPublic));
});
