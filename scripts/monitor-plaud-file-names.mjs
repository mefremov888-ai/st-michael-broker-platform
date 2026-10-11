#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MOSCOW_TIME_ZONE = 'Europe/Moscow';
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_TELEGRAM_TEXT = 3900;

const recordingLine = /^\s*(\S+)\s{2,}(.+?)\s{2,}(\d{4}-\d{2}-\d{2})\s{2,}(\S+)\s*$/u;
const requiredName = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(.+)$/u;
const genericNames = new Set([
  'new recording',
  'recording',
  'новая запись',
  'запись',
  'встреча',
  'клиент',
]);

export function stripAnsi(value) {
  return String(value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '');
}

export function parsePlaudRecent(output) {
  const recordings = [];
  for (const rawLine of stripAnsi(output).split(/\r?\n/u)) {
    const match = rawLine.match(recordingLine);
    if (!match) continue;
    const [, id, name, createdDate, duration] = match;
    if (id.toUpperCase() === 'ID' || !/^[-\w]{16,}$/u.test(id)) continue;
    recordings.push({ id, name: name.trim(), createdDate, duration });
  }
  return recordings;
}

/** A zero-row parser result is not proof of an empty account. Server mode
 * accepts zero only with the CLI's explicit, matching zero-count header. */
export function parsePlaudRecentChecked(output, days) {
  const text = stripAnsi(output);
  const headers = [...text.matchAll(/^\s*Recordings in the last (\d+) days:\s*(\d+)\s*$/gmu)];
  const recordings = parsePlaudRecent(text);
  if (headers.length > 1 || (headers.length === 1 && (Number(headers[0][1]) !== days || Number(headers[0][2]) !== recordings.length)) || (recordings.length === 0 && (headers.length !== 1 || Number(headers[0][2]) !== 0))) {
    throw Object.assign(new Error('plaud_output_untrusted'), { code: 'plaud_output_untrusted' });
  }
  return recordings;
}

function isRealCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function validateRecordingName(name) {
  const normalized = String(name ?? '').trim().replace(/\s+/gu, ' ');
  const match = normalized.match(requiredName);
  if (!match) return { valid: false, reason: 'нет даты, времени или имени клиента по шаблону' };

  const [, y, mo, d, h, mi, s, clientName] = match;
  const values = [y, mo, d, h, mi, s].map(Number);
  if (
    !isRealCalendarDate(values[0], values[1], values[2]) ||
    values[3] > 23 ||
    values[4] > 59 ||
    values[5] > 59
  ) {
    return { valid: false, reason: 'некорректная дата или время' };
  }

  const cleanClientName = clientName.trim();
  if (cleanClientName.length < 2 || !/\p{L}/u.test(cleanClientName)) {
    return { valid: false, reason: 'не указано имя клиента' };
  }
  if (genericNames.has(cleanClientName.toLocaleLowerCase('ru-RU'))) {
    return { valid: false, reason: 'вместо имени указано общее слово' };
  }
  return { valid: true };
}

export function findMisnamedRecordings(recordings) {
  return recordings.flatMap((recording) => {
    const validation = validateRecordingName(recording.name);
    return validation.valid ? [] : [{ ...recording, reason: validation.reason }];
  });
}

function moscowStamp(now = new Date()) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: MOSCOW_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

function compactName(name, max = 120) {
  const normalized = String(name).replace(/\s+/gu, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export function buildReport(recordings, misnamed, days, now = new Date()) {
  const heading = `PLAUD - проверка названий (${moscowStamp(now)} МСК)`;
  if (misnamed.length === 0) {
    return [
      `✅ ${heading}`,
      `Проверены записи за последние ${days} дн.: ${recordings.length}.`,
      'Непереименованных встреч не найдено.',
    ].join('\n');
  }

  const lines = [
    `⚠️ ${heading}`,
    `Нужно переименовать: ${misnamed.length} из ${recordings.length}.`,
    'Шаблон: ГГГГ-ММ-ДД ЧЧ:ММ:СС Имя клиента',
    '',
  ];
  for (const [index, recording] of misnamed.entries()) {
    lines.push(`${index + 1}. ${compactName(recording.name)}`);
    lines.push(`   Создана: ${recording.createdDate}; причина: ${recording.reason}`);
  }
  lines.push('', 'Пожалуйста, переименуйте записи в PLAUD.');
  return lines.join('\n');
}

export function splitTelegramMessage(message, limit = MAX_TELEGRAM_TEXT) {
  if (!Number.isInteger(limit) || limit < 2 || limit > MAX_TELEGRAM_TEXT) throw new Error('Invalid Telegram message limit');
  if (message.length <= limit) return [message];
  const chunks = [];
  let current = '';
  for (const line of message.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = '';
    for (const point of line) {
      if (current.length + point.length > limit) { chunks.push(current); current = ''; }
      current += point;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function configuredChatIds(env) {
  return [...new Set(
    [env.OPS_ALERT_CHAT_IDS, env.OPS_ALERT_CHAT_ID]
      .flatMap((value) => String(value || '').split(/[\s,;]+/u))
      .map((value) => value.trim())
      .filter(Boolean),
  )];
}

export async function sendTelegram(message, env = process.env, fetchImpl = fetch) {
  const token = String(env.OPS_TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatIds = configuredChatIds(env);
  if (!token || chatIds.length === 0) {
    throw new Error('Не настроены OPS_TELEGRAM_BOT_TOKEN и OPS_ALERT_CHAT_ID(S)');
  }

  for (const chatId of chatIds) {
    for (const text of splitTelegramMessage(message)) {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) {
        throw new Error(`Telegram отклонил сообщение: HTTP ${response.status}`);
      }
    }
  }
}

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export async function getPlaudOutput(days, options = {}) {
  const fixturePath = options.fixturePath === undefined ? readArgument('--input') : options.fixturePath;
  if (fixturePath) return readFile(fixturePath, 'utf8');

  const command = options.command || (process.platform === 'win32' ? 'plaud.cmd' : 'plaud');
  const spawn = options.spawnSyncImpl || spawnSync;
  const result = spawn(command, ['recent', '--days', String(days)], {
    encoding: 'utf8',
    env: { ...(options.env || process.env), NO_COLOR: '1' },
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error && !options.safeErrors) throw result.error;
  if (result.error || result.status !== 0) {
    if (options.safeErrors) throw Object.assign(new Error('plaud_cli_failed'), { code: 'plaud_cli_failed' });
  }
  if (result.status !== 0) {
    throw new Error(stripAnsi(result.stderr || result.stdout || `PLAUD CLI завершился с кодом ${result.status}`));
  }
  return result.stdout;
}

export async function main() {
  const days = Number(readArgument('--days', process.env.PLAUD_NAME_LOOKBACK_DAYS || DEFAULT_LOOKBACK_DAYS));
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days должен быть целым числом от 1 до 30');
  const shouldNotify = !process.argv.includes('--dry-run');
  let errorCategory = 'plaud_cli_failed';

  try {
    const output = await getPlaudOutput(days);
    errorCategory = 'plaud_output_untrusted';
    const recordings = parsePlaudRecentChecked(output, days);
    const misnamed = findMisnamedRecordings(recordings);
    const report = buildReport(recordings, misnamed, days);
    // Detailed names belong in the authorized Telegram report, never CI logs.
    console.log(JSON.stringify({ status: 'CHECKED', lookback_days: days, recordings: recordings.length, misnamed: misnamed.length }));
    errorCategory = 'telegram_send_failed';
    if (shouldNotify) await sendTelegram(report);
  } catch {
    const alert = '🔴 PLAUD - проверка названий не выполнена.\nПроверьте доступность PLAUD CLI, авторизацию и настройки технического бота. Названия записей пока не подтверждены.';
    console.error(JSON.stringify({ status: 'FAILED', error: errorCategory }));
    if (shouldNotify) await sendTelegram(alert).catch(() => undefined);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}

