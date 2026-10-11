const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { OLD, NEW, plan, verifyPdf, verifyEnvironment } = require('./publish-rewards-october-2026');
const old = () => ({ ...OLD, isPublic: true, type: 'PDF', fileSize: 97000, sortOrder: 0, updatedAt: new Date('2026-10-11T12:00:00Z') });
test('exact old document only; date/URL drift changes plan or refuses', () => {
  const expected = plan(old(), []);
  assert.equal(expected.action, 'publish');
  assert.match(expected.expectedOldHash, /^[a-f0-9]{64}$/);
  assert.throws(() => plan({ ...old(), fileUrl: '/files/other.pdf' }, []));
  assert.notEqual(plan({ ...old(), updatedAt: new Date() }, []).expectedOldHash, expected.expectedOldHash);
});
test('idempotence requires exact new metadata and archived exact old row', () => {
  assert.equal(plan({ ...old(), isPublic: false }, [{ ...NEW, sortOrder: 0 }]).action, 'already-published');
  assert.throws(() => plan(old(), [{ ...NEW, sortOrder: 0 }]));
  assert.throws(() => plan({ ...old(), isPublic: false }, [{ ...NEW, name: 'Changed', sortOrder: 0 }]));
  assert.throws(() => plan(old(), [{ ...NEW }, { ...NEW }]));
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
  assert.match(code, /openSync\(TARGET, 'wx'/);
  assert.match(code, /REPEATABLE READ READ ONLY/);
  assert.match(code, /pg_advisory_xact_lock/);
  assert.match(code, /where: \{ \.\.\.OLD, isPublic: true, updatedAt: old\.updatedAt \}/);
  assert.match(code, /await verifyPublicHash\(\)/);
  assert.match(code, /ownedFileIdentity/);
  assert.match(code, /fchmodSync\(fd, 0o644\)/);
  assert.match(code, /90000/);
  assert.doesNotMatch(code, /document\.delete|offerAcceptance\.|siteContent\.|execSync|unlinkSync\(source/);
});

test('workflow defaults to plan, uses existing exact-SHA backups and strict production identity', () => {
  const path = require('node:path');
  const text = readFileSync(path.join(__dirname, '../.github/workflows/publish-rewards-october-2026.yml'), 'utf8');
  assert.match(text, /options: \[plan, apply\]\s+default: plan/);
  assert.match(text, /PUBLISH_APPROVED_OCTOBER_REWARDS/);
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
