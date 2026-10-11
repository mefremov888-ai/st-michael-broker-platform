import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  buildReport,
  findMisnamedRecordings,
  parsePlaudRecent,
  parsePlaudRecentChecked,
  splitTelegramMessage,
  validateRecordingName,
  main,
} from './monitor-plaud-file-names.mjs';

const fixture = `
Recordings in the last 7 days: 4

  0123456789abcdef0123456789abcdef  2026-09-30 11:30:37  2026-09-30  2h11m
  abcdef0123456789abcdef0123456789  2026-09-29 19:17:41 Иван Иванович  2026-09-29  57m40s
  fedcba9876543210fedcba9876543210  11-22 Консультация: Покупка апартаментов  2026-09-23  1h10m
  11111111111111111111111111111111  2026-09-20 15:37:59 Анна  2026-09-20  33m08s
`;

test('parses full untruncated names from plaud recent output', () => {
  const rows = parsePlaudRecent(fixture);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].name, '2026-09-29 19:17:41 Иван Иванович');
});

test('accepts required timestamp and client name', () => {
  assert.equal(validateRecordingName('2026-09-29 19:17:41 Иван Иванович').valid, true);
  assert.equal(validateRecordingName('2026-09-20 15:37:59 Анна').valid, true);
});

test('rejects timestamp-only, legacy, generic and impossible names', () => {
  assert.equal(validateRecordingName('2026-09-30 11:30:37').valid, false);
  assert.equal(validateRecordingName('11-22 Консультация: Покупка апартаментов').valid, false);
  assert.equal(validateRecordingName('2026-09-30 11:30:37 Клиент').valid, false);
  assert.equal(validateRecordingName('2026-02-31 25:70:00 Иван').valid, false);
});

test('finds only recordings that need renaming', () => {
  const rows = parsePlaudRecent(fixture);
  const misnamed = findMisnamedRecordings(rows);
  assert.deepEqual(misnamed.map((row) => row.name), [
    '2026-09-30 11:30:37',
    '11-22 Консультация: Покупка апартаментов',
  ]);
});

test('builds both success and warning reports without exposing tokens', () => {
  const rows = parsePlaudRecent(fixture);
  const warning = buildReport(rows, findMisnamedRecordings(rows), 7, new Date('2026-10-02T06:00:00Z'));
  assert.match(warning, /Нужно переименовать: 2 из 4/u);
  assert.match(warning, /ГГГГ-ММ-ДД ЧЧ:ММ:СС Имя клиента/u);

  const success = buildReport(rows.slice(1, 2), [], 7, new Date('2026-10-02T06:00:00Z'));
  assert.match(success, /Непереименованных встреч не найдено/u);
});

test('splits long Telegram messages under the configured limit', () => {
  const chunks = splitTelegramMessage(['header', ...Array.from({ length: 30 }, (_, i) => `${i}. ${'x'.repeat(20)}`)].join('\n'), 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});

test('server parser accepts zero only with explicit matching CLI header', () => {
  assert.deepEqual(parsePlaudRecentChecked('Recordings in the last 7 days: 0\n', 7), []);
  for (const output of ['', 'Login required', '{"files":[]}', 'Recordings in the last 7 days: 3', 'Recordings in the last 8 days: 0']) assert.throws(() => parsePlaudRecentChecked(output, 7), { code: 'plaud_output_untrusted' });
  assert.equal(parsePlaudRecentChecked(fixture, 7).length, 4);
});

test('splitter bounds single long lines without splitting surrogate pairs', () => {
  const value = `header\n${'🧩'.repeat(3000)}\ntail`;
  const chunks = splitTelegramMessage(value, 100);
  assert.ok(chunks.every(chunk => chunk.length <= 100 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk)));
  assert.equal(chunks.join('').replace(/\n/g, ''), value.replace(/\n/g, ''));
});

test('legacy manual dry-run logs counts and fixed failures, never report names or raw errors', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plaud-manual-log-test-'));
  const file = path.join(directory, 'synthetic.txt');
  const previousArgs = process.argv;
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const previousError = console.error;
  const logs = [];
  t.after(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  try {
    process.argv = [process.execPath, 'monitor-plaud-file-names.mjs', '--input', file, '--dry-run'];
    console.log = value => logs.push(String(value));
    console.error = value => logs.push(String(value));
    await writeFile(file, fixture);
    await main();
    await writeFile(file, 'SensitiveSyntheticErrorWithToken');
    await main();
    assert.equal(logs.some(line => line.includes('Иван') || line.includes('Анна') || line.includes('SensitiveSyntheticErrorWithToken')), false);
    assert.deepEqual(JSON.parse(logs[0]), { status: 'CHECKED', lookback_days: 7, recordings: 4, misnamed: 2 });
    assert.deepEqual(JSON.parse(logs[1]), { status: 'FAILED', error: 'plaud_output_untrusted' });
  } finally { process.argv = previousArgs; process.exitCode = previousExitCode; console.log = previousLog; console.error = previousError; }
});

