import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runServerMonitor, moscowJobDay, parseServerConfig, sanitizedStatus, validateServerState } from './monitor-plaud-server-runner.mjs';
import { getPlaudOutput } from './monitor-plaud-file-names.mjs';

const initialNow = Date.parse('2026-10-11T06:00:00.000Z');
const token = '123456789:synthetic_token_for_local_tests_only';
const recipient = '454322520';
const privateName = 'PrivateClientSynthetic';
const output = `Recordings in the last 7 days: 1\n  0123456789abcdef0123456789abcdef  ${privateName}  2026-10-10  10m\n`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plaud-server-test-'));
  const clock = { value: initialNow };
  const calls = [];
  let cliCalls = 0;
  let messageId = 100;
  const env = { OPS_TELEGRAM_BOT_TOKEN: token, OPS_ALERT_CHAT_ID: recipient, PLAUD_NAME_STATE_FILE: path.join(directory, 'state.json'), ...overrides.env };
  const dependencies = {
    env,
    now: () => clock.value,
    runCli: async days => { cliCalls += 1; assert.equal(days, 7); return overrides.cli ? overrides.cli(cliCalls) : output; },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      const call = { url, options, body };
      calls.push(call);
      const custom = await overrides.respond?.(call, calls);
      if (custom) return custom;
      if (url.endsWith('/getMe')) return json({ ok: true, result: { is_bot: true, username: 'brokerStMichaelbot', id: 123456789 } });
      if (url.endsWith('/sendMessage')) return json({ ok: true, result: { message_id: messageId++ } });
      throw new Error('Unexpected URL');
    },
  };
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { clock, calls, env, dependencies, directory, run: mode => runServerMonitor({ ...dependencies, mode }), state: async () => JSON.parse(await fs.readFile(env.PLAUD_NAME_STATE_FILE, 'utf8')), stateText: () => fs.readFile(env.PLAUD_NAME_STATE_FILE, 'utf8'), sends: () => calls.filter(call => call.url.endsWith('/sendMessage')), cliCalls: () => cliCalls };
}

test('Moscow job day changes at 21:00 UTC, not host midnight', () => {
  assert.equal(moscowJobDay(Date.parse('2026-10-10T20:59:59Z')), '2026-10-10');
  assert.equal(moscowJobDay(Date.parse('2026-10-10T21:00:00Z')), '2026-10-11');
});

test('successful daily run persists acknowledgments, not names, IDs, report text or tokens', async t => {
  const app = await fixture(t);
  const result = await app.run();
  assert.equal(result.exitCode, 0);
  assert.equal(result.status.status, 'SUCCEEDED');
  assert.deepEqual(result.status.counts, { recordings: 1, misnamed: 1 });
  assert.equal(app.sends().length, 1);
  assert.match(app.sends()[0].body.text, new RegExp(privateName));
  assert.equal(app.sends()[0].body.chat_id, recipient);
  const state = await app.state();
  assert.equal(state.report.recipients[0].parts[0].message_id, 100);
  assert.equal(state.report.recipients[0].parts[0].status, 'DELIVERED');
  assert.equal((await app.stateText()).includes(privateName) || (await app.stateText()).includes(recipient) || (await app.stateText()).includes(token), false);
  assert.equal(JSON.stringify(result.status).includes('report_sha256') || JSON.stringify(result.status).includes('recipient_hash'), false);
  assert.ok(app.calls.every(call => call.options.redirect === 'error'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(app.env.PLAUD_NAME_STATE_FILE)).mode & 0o777, 0o600);
});

test('same Moscow day success is a no-op; next Moscow day sends once again', async t => {
  const app = await fixture(t);
  await app.run();
  app.clock.value += 300_000;
  assert.equal((await app.run()).exitCode, 0);
  assert.equal(app.cliCalls(), 1);
  assert.equal(app.sends().length, 1);
  app.clock.value = Date.parse('2026-10-11T21:00:00Z');
  assert.equal((await app.run()).exitCode, 0);
  assert.equal(app.sends().length, 2);
  assert.equal((await app.state()).job_day, '2026-10-12');
});

test('attempt is persisted before send, and an ambiguous timeout is never retried', async t => {
  let app;
  app = await fixture(t, { respond: async call => {
    if (!call.url.endsWith('/sendMessage')) return;
    const state = await app.state();
    assert.equal(state.report.recipients[0].parts[0].status, 'SENDING');
    assert.equal(state.report.recipients[0].parts[0].attempt_count, 1);
    throw new Error(`Timeout ${privateName} ${token}`);
  } });
  const first = await app.run();
  assert.equal(first.status.status, 'UNKNOWN');
  assert.equal(first.exitCode, 1);
  assert.equal((await app.run()).status.status, 'UNKNOWN');
  assert.equal(app.sends().length, 1);
  assert.equal(app.cliCalls(), 1);
  assert.equal((await app.stateText()).includes(privateName) || JSON.stringify(first).includes(token), false);
});

test('HTTP 5xx and malformed 200 acknowledgments are UNKNOWN, not automatically resent', async t => {
  for (const response of [() => json({ ok: false, error_code: 500 }, 500), () => json({ ok: true, result: {} }), () => new Response('not JSON', { status: 200 })]) {
    const app = await fixture(t, { respond: call => call.url.endsWith('/sendMessage') ? response() : undefined });
    assert.equal((await app.run()).status.status, 'UNKNOWN');
    await app.run();
    assert.equal(app.sends().length, 1);
  }
});

test('known HTTP 429 is retried after retry_after, with deterministic report timestamp', async t => {
  const app = await fixture(t, { respond: (call, calls) => call.url.endsWith('/sendMessage') && calls.filter(item => item.url.endsWith('/sendMessage')).length === 1 ? json({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, 429) : undefined });
  const first = await app.run();
  assert.equal(first.status.status, 'FAILED');
  assert.equal(first.status.report.retry_wait_parts, 1);
  assert.equal((await app.run()).exitCode, 1);
  assert.equal(app.sends().length, 1);
  app.clock.value += 300_000;
  assert.equal((await app.run()).status.status, 'SUCCEEDED');
  assert.equal(app.sends().length, 2);
  assert.equal(app.sends()[0].body.text, app.sends()[1].body.text);
  assert.match(app.sends()[1].body.text, /09:00/);
  assert.equal((await app.state()).report.recipients[0].parts[0].attempt_count, 2);
});

test('429 attempts are capped at three per day and ordinary 4xx are not retried', async t => {
  const app = await fixture(t, { respond: call => call.url.endsWith('/sendMessage') ? json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429) : undefined });
  for (let attempt = 0; attempt < 5; attempt++) { await app.run(); app.clock.value += 300_000; }
  assert.equal(app.sends().length, 3);
  assert.equal((await app.state()).report.recipients[0].parts[0].status, 'FAILED');
  const rejected = await fixture(t, { respond: call => call.url.endsWith('/sendMessage') ? json({ ok: false, error_code: 403 }, 403) : undefined });
  await rejected.run(); await rejected.run();
  assert.equal(rejected.sends().length, 1);
  assert.equal((await rejected.state()).status, 'FAILED');
});

test('partial delivery skips acknowledged chunks and recipients on safe retry', async t => {
  let rejected = false;
  const app = await fixture(t, { env: { OPS_ALERT_CHAT_IDS: '454322520,123456789' }, cli: () => `Recordings in the last 7 days: 45\n${Array.from({ length: 45 }, (_, index) => `  ${String(index).padStart(32, '0')}  ${privateName}${index}${'x'.repeat(100)}  2026-10-10  10m`).join('\n')}`, respond: call => {
    if (call.url.endsWith('/sendMessage') && call.body.chat_id === '123456789' && !rejected) { rejected = true; return json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429); }
  } });
  const first = await app.run();
  assert.ok(first.status.report.chunk_count > 1);
  const acknowledgedTexts = app.sends().filter(call => call.body.chat_id === recipient).map(call => call.body.text);
  app.clock.value += 300_000;
  const result = await app.run();
  assert.equal(result.status.status, 'SUCCEEDED');
  assert.deepEqual(app.sends().filter(call => call.body.chat_id === recipient).map(call => call.body.text), acknowledgedTexts);
  assert.equal(app.sends().filter(call => call.body.chat_id === '123456789' && call.body.text === app.sends()[0].body.text).length, 2);
});

test('changed names after an attempted partial report stop UNKNOWN without mixing chunks', async t => {
  const app = await fixture(t, { cli: number => number === 1 ? output : output.replace(privateName, 'ChangedSyntheticClient'), respond: call => call.url.endsWith('/sendMessage') ? json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429) : undefined });
  await app.run();
  app.clock.value += 300_000;
  const second = await app.run();
  assert.equal(second.status.status, 'UNKNOWN');
  assert.equal(second.errorCode, 'report_changed_after_attempt');
  assert.equal(app.sends().length, 1);
  assert.equal((await app.stateText()).includes('ChangedSyntheticClient'), false);
});

test('unacknowledged SENDING after crash is promoted UNKNOWN and never replayed', async t => {
  const app = await fixture(t);
  const filesystem = { ...fs, writeFile: async (file, content, options) => {
    if (JSON.parse(content).report?.recipients[0]?.parts[0]?.status === 'DELIVERED') throw new Error('Simulated disk failure after Telegram accepted');
    return fs.writeFile(file, content, options);
  } };
  await assert.rejects(runServerMonitor({ ...app.dependencies, filesystem }), { code: 'state_persist_failed' });
  assert.equal((await app.state()).report.recipients[0].parts[0].status, 'SENDING');
  const recovered = await app.run();
  assert.equal(recovered.status.status, 'UNKNOWN');
  assert.equal(app.sends().length, 1);
});

test('CLI failures emit one fixed error notice and may recover with a normal report', async t => {
  const app = await fixture(t, { cli: count => { if (count < 3) throw new Error(`CLI stderr ${privateName} ${token}`); return output; } });
  const first = await app.run();
  assert.equal(first.status.status, 'FAILED');
  assert.equal(first.status.check_status, 'FAILED');
  assert.equal(first.errorCode, 'plaud_cli_failed');
  await app.run();
  assert.equal(app.sends().length, 1);
  assert.equal(app.sends()[0].body.text.includes(privateName) || app.sends()[0].body.text.includes(token), false);
  const recovered = await app.run();
  assert.equal(recovered.status.status, 'SUCCEEDED');
  assert.equal(app.sends().length, 2);
  assert.match(app.sends()[1].body.text, new RegExp(privateName));
});

test('UNKNOWN error-notice delivery is not replayed but does not block later CLI recovery', async t => {
  const app = await fixture(t, { cli: count => { if (count === 1) throw new Error('Transient synthetic CLI failure'); return output; }, respond: (call, calls) => {
    if (call.url.endsWith('/sendMessage') && calls.filter(item => item.url.endsWith('/sendMessage')).length === 1) throw new Error('Ambiguous error notice delivery');
  } });
  const first = await app.run();
  assert.equal(first.status.status, 'UNKNOWN');
  assert.equal(first.status.check_status, 'FAILED');
  app.clock.value += 300_000;
  const second = await app.run();
  assert.equal(second.status.status, 'SUCCEEDED');
  assert.equal(second.status.error_notice.unknown_parts, 1);
  assert.equal(second.status.report.delivered_parts, 1);
  assert.equal(app.sends().length, 2);
  assert.match(app.sends()[1].body.text, new RegExp(privateName));
  await app.run();
  assert.equal(app.sends().length, 2);
});

test('zero parsed rows without explicit zero header never produce a healthy report', async t => {
  const invalid = await fixture(t, { cli: () => 'Authentication failed; private server error' });
  const result = await invalid.run();
  assert.equal(result.status.status, 'FAILED');
  assert.equal(result.errorCode, 'plaud_output_untrusted');
  assert.equal(invalid.sends()[0].body.text.includes('Непереименованных встреч не найдено'), false);
  const valid = await fixture(t, { cli: () => 'Recordings in the last 7 days: 0\n' });
  assert.equal((await valid.run()).status.status, 'SUCCEEDED');
  assert.deepEqual((await valid.state()).counts, { recordings: 0, misnamed: 0 });
});

test('getMe must bind the technical broker bot before every send', async t => {
  for (const bot of [{ is_bot: true, username: 'otherbot', id: 123456789 }, { is_bot: false, username: 'brokerStMichaelbot', id: 123456789 }]) {
    const app = await fixture(t, { respond: call => call.url.endsWith('/getMe') ? json({ ok: true, result: bot }) : undefined });
    await assert.rejects(app.run(), { code: 'telegram_bot_mismatch' });
    assert.equal(app.sends().length, 0);
  }
  const app = await fixture(t, { env: { PLAUD_NAME_EXPECTED_BOT_ID: '987654321' } });
  await assert.rejects(app.run(), { code: 'telegram_bot_mismatch' });
  assert.equal(app.sends().length, 0);
});

test('check-config performs only getMe and returns numeric configuration summary', async t => {
  const app = await fixture(t);
  const result = await app.run('check-config');
  assert.equal(result.exitCode, 0);
  assert.equal(result.status.recipient_count, 1);
  assert.equal(result.status.bot_verified, true);
  assert.equal(app.cliCalls(), 0);
  assert.equal(app.sends().length, 0);
  await assert.rejects(fs.stat(app.env.PLAUD_NAME_STATE_FILE), { code: 'ENOENT' });
});

test('dry-run and check-only do not require Telegram credentials, send, or write state', async t => {
  const app = await fixture(t, { env: { OPS_TELEGRAM_BOT_TOKEN: '', OPS_ALERT_CHAT_ID: '' } });
  for (const mode of ['dry-run', 'check-only']) {
    const result = await app.run(mode);
    assert.equal(result.status.notification_sent, false);
    assert.deepEqual(result.status.counts, { recordings: 1, misnamed: 1 });
    assert.equal(JSON.stringify(result).includes(privateName), false);
  }
  assert.equal(app.calls.length, 0);
  await assert.rejects(fs.stat(app.env.PLAUD_NAME_STATE_FILE), { code: 'ENOENT' });
});

test('status reads only sanitized metadata without CLI, Telegram, or rewriting state', async t => {
  const app = await fixture(t);
  assert.deepEqual((await app.run('status')).status, { status: 'NOT_RUN' });
  await app.run();
  const before = await app.stateText();
  const callCount = app.calls.length;
  app.clock.value += 300_000;
  const status = await app.run('status');
  assert.equal(status.status.status, 'SUCCEEDED');
  assert.equal(app.calls.length, callCount);
  assert.equal(app.cliCalls(), 1);
  assert.equal(await app.stateText(), before);
  assert.equal(JSON.stringify(status).includes('recipient_hash') || JSON.stringify(status).includes('report_sha256'), false);
});

test('watchdog is readonly when today check and all acknowledgments succeeded', async t => {
  const app = await fixture(t);
  await app.run();
  const before = await app.stateText();
  const calls = app.calls.length;
  app.clock.value += 15 * 60_000;
  const result = await app.run('watchdog');
  assert.equal(result.exitCode, 0);
  assert.equal(result.status.verification_status, 'CONFIRMED');
  assert.equal(await app.stateText(), before);
  assert.equal(app.calls.length, calls);
  assert.equal(app.cliCalls(), 1);
});

test('watchdog sends one fixed unconfirmed notice, never CLI, and keeps failure exit code', async t => {
  const app = await fixture(t);
  app.clock.value += 15 * 60_000;
  const first = await app.run('watchdog');
  assert.equal(first.exitCode, 1);
  assert.equal(first.status.verification_status, 'UNCONFIRMED');
  assert.equal(first.status.watchdog_notice.delivered_parts, 1);
  await app.run('watchdog');
  assert.equal(app.sends().length, 1);
  assert.equal(app.cliCalls(), 0);
  assert.match(app.sends()[0].body.text, /доставка уведомления сегодня не подтверждена/);
});

test('watchdog ambiguous notification is not retried and does not mutate primary status', async t => {
  const app = await fixture(t, { respond: call => { if (call.url.endsWith('/sendMessage')) throw new Error('Timeout'); } });
  await app.run();
  const primaryBefore = await app.stateText();
  const first = await app.run('watchdog');
  assert.equal(first.exitCode, 1);
  assert.equal(first.status.watchdog_notice.unknown_parts, 1);
  await app.run('watchdog');
  assert.equal(app.sends().length, 2);
  assert.equal(await app.stateText(), primaryBefore);
});

test('corrupt primary ledger triggers one watchdog notice without overwriting it', async t => {
  const app = await fixture(t);
  const invalidState = '{"untrusted":"synthetic_corruption"';
  await fs.writeFile(app.env.PLAUD_NAME_STATE_FILE, invalidState, { mode: 0o600 });
  const first = await app.run('watchdog');
  assert.equal(first.status.main_state_valid, false);
  assert.equal(first.status.verification_status, 'UNCONFIRMED');
  assert.equal(first.status.watchdog_notice.delivered_parts, 1);
  await app.run('watchdog');
  assert.equal(app.sends().length, 1);
  assert.equal(app.cliCalls(), 0);
  assert.equal(await app.stateText(), invalidState);
  const sidecar = await fs.readFile(`${app.env.PLAUD_NAME_STATE_FILE}.watchdog.json`, 'utf8');
  assert.equal(sidecar.includes(recipient) || sidecar.includes(token), false);
});

test('watchdog dedupe survives repair of an invalid primary ledger', async t => {
  const app = await fixture(t, { cli: () => { throw new Error('Synthetic CLI unavailable'); } });
  await fs.writeFile(app.env.PLAUD_NAME_STATE_FILE, 'invalid', { mode: 0o600 });
  await app.run('watchdog');
  await fs.unlink(app.env.PLAUD_NAME_STATE_FILE);
  await app.run();
  assert.equal(app.sends().length, 2); // first watchdog notice + distinct CLI error notice
  await app.run('watchdog');
  assert.equal(app.sends().length, 2);
});

test('durable write fsyncs temp before rename and directory before sending', async t => {
  const app = await fixture(t);
  const events = [];
  const filesystem = { ...fs, open: async (file, flags) => {
    const handle = await fs.open(file, flags);
    return { sync: async () => { events.push(file.endsWith('.tmp') ? 'file_sync' : 'directory_sync'); await handle.sync(); }, close: () => handle.close() };
  }, rename: async (...args) => { events.push('rename'); return fs.rename(...args); } };
  const fetchImpl = async (...args) => {
    if (String(args[0]).endsWith('/sendMessage')) {
      assert.equal(events.at(-1), 'directory_sync');
      assert.deepEqual(events.slice(-3), ['file_sync', 'rename', 'directory_sync']);
    }
    return app.dependencies.fetchImpl(...args);
  };
  if (process.platform === 'win32') {
    // Real directory open is unsupported on Windows; emulate a successful Linux
    // directory fsync while keeping all file fsyncs real for this order test.
    const realOpen = filesystem.open;
    filesystem.open = async (file, flags) => file === path.dirname(app.env.PLAUD_NAME_STATE_FILE) ? { sync: async () => events.push('directory_sync'), close: async () => {} } : realOpen(file, flags);
  }
  assert.equal((await runServerMonitor({ ...app.dependencies, filesystem, fetchImpl })).exitCode, 0);
});

test('failed durable attempt persistence prevents any send', async t => {
  const app = await fixture(t);
  const filesystem = { ...fs, writeFile: async (file, content, options) => {
    if (JSON.parse(content).report?.recipients[0]?.parts[0]?.status === 'SENDING') throw new Error('Synthetic disk fault');
    return fs.writeFile(file, content, options);
  } };
  await assert.rejects(runServerMonitor({ ...app.dependencies, filesystem }), { code: 'state_persist_failed' });
  assert.equal(app.sends().length, 0);
});

test('state validation rejects plaintext extra fields and impossible success', async t => {
  const app = await fixture(t);
  await app.run();
  const state = await app.state();
  assert.throws(() => validateServerState({ ...state, raw_report: privateName }), { code: 'state_invalid' });
  state.report.recipients[0].parts[0].status = 'UNKNOWN';
  assert.throws(() => validateServerState(state), { code: 'state_invalid' });
  assert.equal(JSON.stringify(sanitizedStatus(await app.state())).includes('report_sha256'), false);
});

test('configuration is numeric-ID based, finite, and requires an absolute private state path', () => {
  const good = { OPS_TELEGRAM_BOT_TOKEN: token, OPS_ALERT_CHAT_ID: recipient, PLAUD_NAME_STATE_FILE: path.resolve(os.tmpdir(), 'state.json') };
  assert.equal(parseServerConfig(good).days, 7);
  assert.deepEqual(parseServerConfig({ ...good, OPS_ALERT_CHAT_IDS: '454322520;-1001234567890,454322520' }).chatIds, ['-1001234567890', recipient]);
  for (const changed of [{ OPS_ALERT_CHAT_ID: '@someone' }, { OPS_ALERT_CHAT_ID: '0' }, { PLAUD_NAME_LOOKBACK_DAYS: '31' }, { PLAUD_NAME_LOOKBACK_DAYS: 'NaN' }, { PLAUD_NAME_STATE_FILE: 'state.json' }, { PLAUD_NAME_EXPECTED_BOT_ID: '@bot' }]) assert.throws(() => parseServerConfig({ ...good, ...changed }));
});

test('server CLI uses fixed command, argv, bounded time/buffer and sanitized failures', async () => {
  const calls = [];
  const spawnSyncImpl = (...args) => { calls.push(args); return { status: 1, stderr: `${privateName} ${token}` }; };
  await assert.rejects(getPlaudOutput(7, { command: '/usr/bin/plaud', fixturePath: null, safeErrors: true, env: { HOME: '/root' }, spawnSyncImpl }), { code: 'plaud_cli_failed', message: 'plaud_cli_failed' });
  assert.equal(calls[0][0], '/usr/bin/plaud');
  assert.deepEqual(calls[0][1], ['recent', '--days', '7']);
  assert.equal(calls[0][2].timeout, 120_000);
  assert.equal(calls[0][2].maxBuffer, 4 * 1024 * 1024);
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe']);
});

test('both CLI entrypoints execute when invoked through a release-directory symlink', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plaud-entry-symlink-test-'));
  const linkedScripts = path.join(directory, 'current');
  const sourceScripts = path.dirname(fileURLToPath(import.meta.url));
  await fs.symlink(sourceScripts, linkedScripts, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(async () => { await fs.unlink(linkedScripts); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const stateFile = path.join(directory, 'state.json');
  const server = spawnSync(process.execPath, [path.join(linkedScripts, 'monitor-plaud-server-runner.mjs'), '--status'], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PLAUD_NAME_STATE_FILE: stateFile } });
  assert.equal(server.status, 0, server.stderr);
  assert.deepEqual(JSON.parse(server.stdout), { status: 'NOT_RUN' });
  const syntheticInput = path.join(directory, 'input.txt');
  await fs.writeFile(syntheticInput, output);
  const legacy = spawnSync(process.execPath, [path.join(linkedScripts, 'monitor-plaud-file-names.mjs'), '--input', syntheticInput, '--dry-run'], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PLAUD_NAME_LOOKBACK_DAYS: '7' } });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.deepEqual(JSON.parse(legacy.stdout), { status: 'CHECKED', lookback_days: 7, recordings: 1, misnamed: 1 });
  assert.equal(legacy.stdout.includes(privateName), false);
});
