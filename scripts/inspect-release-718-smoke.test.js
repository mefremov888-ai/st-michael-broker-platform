const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { validateInputs, summarizeDocuments, safeTimestamp, boundedJson, verifyAgencyCounts, stage, classifyFailure, reportFailure } = require('./inspect-release-718-smoke');
test('exact deployed SHA and explicit send flag are required', () => {
  const env = { SMOKE_EXPECTED_SHA: 'a'.repeat(40), GIT_SHA: 'a'.repeat(40), PRODUCTION_PG_SYSTEM_IDENTIFIER: '123', PRODUCTION_MIN_BROKER_ROWS: '100' };
  validateInputs(env);
  assert.throws(() => validateInputs({ ...env, GIT_SHA: 'b'.repeat(40) }));
  assert.throws(() => validateInputs({ ...env, SMOKE_CONFIRM_SEND: 'yes' }));
  assert.throws(() => validateInputs({ ...env, PRODUCTION_PG_SYSTEM_IDENTIFIER: '' }));
});
test('obsolete documents are detected without logging their payloads', () => {
  assert.equal(summarizeDocuments([{ name: 'Условия сотрудничества октябрь' }]).obsoleteAbsent, true);
  assert.equal(summarizeDocuments([{ name: 'Условия вознаграждения для брокеров на октябрь 2026 г.' }]).obsoleteAbsent, true);
  for (const name of ['Условия рассрочки Квартал Серебряный бор', 'Условия вознаграждения для брокеров на август 2026 г.', 'Условия вознаграждения партнёром St Michael']) {
    assert.equal(summarizeDocuments([{ name }]).obsoleteAbsent, false);
  }
});
test('JSON streaming rejects and cancels before buffering an excessive response', async () => {
  assert.deepEqual(await boundedJson(new Response('{"ok":true}')), { ok: true });
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedJson(new Response(body), 16));
  assert.equal(cancelled, true);
});
test('compiled service smoke uses three period cases and never outputs entity data', async () => {
  const calls = [];
  const expected = { total: 8, with_fixations: 3, with_meetings: 4, with_both: 2 };
  const service = { async list(base, entity, query, search, canonical) {
    calls.push({ base, entity, query, canonical });
    const total = canonical.fixationPeriod && canonical.meetingPeriod ? 2 : canonical.fixationPeriod ? 3 : 4;
    return { total, items: [{ id: 'private', periodMetrics: { fixations: 1, meetings: 1 } }] };
  } };
  assert.deepEqual(await verifyAgencyCounts(service, { from: '2026-10-01', to: '2026-10-11' }, expected), { with_fixations: 3, with_meetings: 4, with_both: 2 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.base === 'ours' && call.entity === 'AGENCY' && call.canonical.includeLowSignal === true));
  await assert.rejects(verifyAgencyCounts(service, {}, { ...expected, with_both: 3 }));
});
test('only normalized timestamps escape stored JSON', () => {
  assert.equal(safeTimestamp('secret-value'), null);
  assert.equal(safeTimestamp('2026-10-11T14:00:00Z'), '2026-10-11T14:00:00.000Z');
});

test('diagnostics expose only allowlisted stages and safe classifications', () => {
  const log = [];
  const previousLog = console.log;
  const previousError = console.error;
  console.log = value => log.push(value);
  console.error = value => log.push(value);
  try {
    stage('agency_sql_counts');
    reportFailure({ code: 'P2010', message: 'SELECT secret_phone FROM private_data', stack: 'private_stack' });
    reportFailure({ code: 'attacker_secret', message: 'broker_private_email' });
    reportFailure({ code: 'P2010', meta: { code: '57014', message: 'SELECT secret_phone FROM private_data' } });
    reportFailure({ name: 'PrismaClientUnknownRequestError', cause: { code: '57014', message: 'broker_private_cause' }, message: 'broker_private_message' });
    reportFailure(Object.defineProperty({}, 'meta', { get() { throw new Error('broker_private_getter'); } }));
    assert.deepEqual(JSON.parse(log[1]), { failure: 'RELEASE_SMOKE_FAILED', stage: 'agency_sql_counts', code: 'P2010' });
    assert.equal(JSON.parse(log[2]).code, 'UNCLASSIFIED');
    assert.equal(JSON.parse(log[3]).sqlFailure, 'STATEMENT_TIMEOUT_OR_CANCELED');
    assert.deepEqual(JSON.parse(log[4]), { failure: 'RELEASE_SMOKE_FAILED', stage: 'agency_sql_counts', code: 'PRISMA_UNKNOWN_REQUEST', sqlFailure: 'STATEMENT_TIMEOUT_OR_CANCELED' });
    assert.deepEqual(JSON.parse(log[5]), { failure: 'RELEASE_SMOKE_FAILED', stage: 'agency_sql_counts', code: 'UNCLASSIFIED' });
    assert.throws(() => stage('broker_private_email'));
    assert.doesNotMatch(log.join('\n'), /secret_phone|private_data|private_stack|broker_private_email|broker_private_cause|broker_private_message|broker_private_getter|attacker_secret/);
  } finally { console.log = previousLog; console.error = previousError; }
});

test('failure classifier uses only structural allowlists and never parses messages', () => {
  assert.deepEqual(classifyFailure({ name: 'PrismaClientUnknownRequestError' }), { code: 'PRISMA_UNKNOWN_REQUEST' });
  assert.deepEqual(classifyFailure({ name: 'PrismaClientKnownRequestError' }), { code: 'PRISMA_KNOWN_REQUEST' });
  assert.deepEqual(classifyFailure({ name: 'PrismaClientRustPanicError' }), { code: 'PRISMA_ENGINE_PANIC' });
  assert.deepEqual(classifyFailure({ name: 'PrismaClientInitializationError' }), { code: 'PRISMA_INITIALIZATION' });
  assert.deepEqual(classifyFailure({ name: 'PrismaClientValidationError' }), { code: 'PRISMA_VALIDATION' });
  assert.deepEqual(classifyFailure({ code: '57014' }), { code: 'DATABASE', sqlFailure: 'STATEMENT_TIMEOUT_OR_CANCELED' });
  assert.deepEqual(classifyFailure({ code: 'P2010', meta: { database_error_code: '25006' } }), { code: 'P2010', sqlFailure: 'READ_ONLY_VIOLATION' });
  assert.deepEqual(classifyFailure({ code: 'P2010', cause: { meta: { code: '42P01' } } }), { code: 'P2010', sqlFailure: 'MISSING_TABLE' });
  assert.deepEqual(classifyFailure({ message: 'canceling statement due to statement timeout 57014 private_sql' }), { code: 'UNCLASSIFIED' });
  assert.deepEqual(classifyFailure({ name: 'PrismaClientUnknownRequestError_private', code: 'private_57014', meta: { code: 'private' } }), { code: 'UNCLASSIFIED' });
  for (const field of ['code', 'name', 'meta', 'cause']) {
    const error = Object.defineProperty({}, field, { get() { throw new Error(`private_${field}`); } });
    assert.deepEqual(classifyFailure(error), { code: 'UNCLASSIFIED' });
  }
  assert.deepEqual(classifyFailure(new Proxy({}, { get() { throw new Error('private_proxy'); } })), { code: 'UNCLASSIFIED' });
});

test('failed service reads and failed parity comparisons retain different stages', async () => {
  const marks = [];
  await assert.rejects(verifyAgencyCounts({ list: async () => { throw new Error('private'); } }, {}, {}, value => marks.push(value)));
  assert.deepEqual(marks, ['service_with_fixations']);
  marks.length = 0;
  const previousLog = console.log;
  const log = [];
  console.log = value => log.push(value);
  try {
    await assert.rejects(verifyAgencyCounts({ list: async () => ({ total: 3, items: [{ private: 'not printed' }] }) }, {}, { total: 5, with_fixations: 2 }, value => marks.push(value)));
    assert.deepEqual(marks, ['service_with_fixations', 'parity_with_fixations']);
    assert.deepEqual(JSON.parse(log[0]), { releaseSmokeCountMismatch: 'with_fixations', expected: 2, actual: 3 });
    assert.doesNotMatch(log.join(''), /private|printed/);
  } finally { console.log = previousLog; }
});

test('agency SQL uses service UTC date labels, not broker Moscow instant boundaries', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const service = fs.readFileSync(path.join(__dirname, '../apps/api/src/loyalty-base/loyalty-base.service.ts'), 'utf8');
  const smoke = fs.readFileSync(require.resolve('./inspect-release-718-smoke'), 'utf8');
  assert.match(service, /toISOString\(\)\.slice\(0, 10\)/);
  assert.match(service, /p\.fromIso\.slice\(0, 10\)/);
  assert.match(service, /p\.toIso\.slice\(0, 10\)/);
  assert.match(smoke, /c\.created_at::date BETWEEN p\.start AND p\.finish/);
  assert.match(smoke, /m\.date::date BETWEEN p\.start AND p\.finish/);
  assert.match(smoke, /c\.fixation_status IN \('FIXED','EXPIRED'\) OR c\.uniqueness_status IN \('CONDITIONALLY_UNIQUE','EXPIRED'\)/);
  // A 00:30 Moscow activity is the prior UTC day: current agency metrics
  // intentionally follow that UTC label. A Moscow-date SQL rewrite differs.
  assert.equal(new Date('2026-10-01T00:30:00+03:00').toISOString().slice(0, 10), '2026-09-30');
});
test('smoke does not boot Nest or run any migrations', () => {
  const source = readFileSync(require.resolve('./inspect-release-718-smoke'), 'utf8');
  assert.doesNotMatch(source, /NestFactory|createApplicationContext|migrate|\.\$disconnect\(\).*delete/);
  assert.match(source, /REPEATABLE READ READ ONLY/);
  assert.match(source, /apiParityVerified: false/);
  assert.match(source, /SMOKE_CONFIRM_SEND === 'true'/);
  assert.match(source, /startsWith\('content-freshness:'/);
});
test('workflow pins SSH host and checks container plus checkout SHA before smoke', () => {
  const workflow = readFileSync(require('node:path').join(__dirname, '../.github/workflows/inspect-release-718-smoke.yml'), 'utf8');
  assert.match(workflow, /default: false/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /fingerprints\[0\].*EXPECTED_SSH_FINGERPRINT/);
  assert.match(workflow, /git rev-parse HEAD.*expected_sha/);
  assert.match(workflow, /docker exec st-michael-api sh -c 'printf %s "\$GIT_SHA"'/);
  assert.match(workflow, /bundle_hash.*sha256sum/);
  assert.match(workflow, /flock -s -n 9/);
  assert.match(workflow, /test "\$SOURCE_REF" = refs\/heads\/master/);
  assert.match(workflow, /DOCKER_HOST/);
  assert.match(workflow, /com\.docker\.compose\.service/);
  assert.doesNotMatch(workflow, /docker compose up|restart|git pull|system prune/);
  assert.match(workflow, /printf '\\ninspect\(\)\.catch/);
});
