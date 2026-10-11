#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReport, findMisnamedRecordings, getPlaudOutput, parsePlaudRecentChecked, splitTelegramMessage } from './monitor-plaud-file-names.mjs';

const EXPECTED_BOT_USERNAME = 'brokerstmichaelbot';
const DEFAULT_STATE_FILE = '/var/lib/plaud-name-monitor/state.json';
const MAX_PARTS = 20;
const MAX_SENDS_PER_REPORT = 40;
const MAX_ATTEMPTS = 3;
const MAX_JSON_BYTES = 256 * 1024;
const STATES = new Set(['CHECKING', 'SENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN']);
const PART_STATES = new Set(['PENDING', 'SENDING', 'DELIVERED', 'RETRY_WAIT', 'FAILED', 'UNKNOWN']);
const FIXED_ERROR_NOTICE = '🔴 PLAUD — проверка названий не выполнена.\nПроверьте доступность PLAUD CLI и его авторизацию. Названия и результаты пока не подтверждены. Техническая ошибка зафиксирована; повторный отчёт появится после успешной проверки.';
const FIXED_WATCHDOG_NOTICE = '🔴 PLAUD: ежедневная проверка и/или доставка уведомления сегодня не подтверждена. Проверьте состояние сервиса и авторизацию PLAUD. Контроль не запускает повторную проверку и не повторяет сообщения с неизвестным результатом доставки.';
const error = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(value).digest('hex');
const iso = value => new Date(value).toISOString();
const validInstant = value => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  const time = Date.parse(value);
  return Boolean(match && Number.isFinite(time) && iso(time) === `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`);
};
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && validInstant(`${value}T00:00:00Z`);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

export function moscowJobDay(now = Date.now()) {
  return iso(now + 3 * 60 * 60_000).slice(0, 10);
}

function lookbackDays(env) {
  const days = Number(env.PLAUD_NAME_LOOKBACK_DAYS || 7);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw error('lookback_configuration_invalid');
  return days;
}

export function parseServerConfig(env = process.env, { credentials = true } = {}) {
  const stateFile = String(env.PLAUD_NAME_STATE_FILE || DEFAULT_STATE_FILE);
  if (!path.isAbsolute(stateFile) || stateFile.includes('\0') || stateFile.endsWith(path.sep)) throw error('state_configuration_invalid');
  const config = { stateFile, days: lookbackDays(env) };
  if (!credentials) return config;
  const token = String(env.OPS_TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!/^\d{6,}:[A-Za-z0-9_-]{25,}$/.test(token)) throw error('telegram_configuration_invalid');
  const chatIds = [...new Set([env.OPS_ALERT_CHAT_IDS, env.OPS_ALERT_CHAT_ID].flatMap(value => String(value || '').split(/[\s,;]+/u)).filter(Boolean))].sort();
  if (!chatIds.length || chatIds.length > 20 || chatIds.some(value => !/^-?[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)) || Math.abs(Number(value)) >= 2 ** 52)) throw error('recipient_configuration_invalid');
  const expectedBotId = env.PLAUD_NAME_EXPECTED_BOT_ID;
  if (expectedBotId !== undefined && (!/^[1-9]\d{0,15}$/.test(expectedBotId) || !Number.isSafeInteger(Number(expectedBotId)))) throw error('bot_configuration_invalid');
  return { ...config, token, chatIds, expectedBotId: expectedBotId ? Number(expectedBotId) : null };
}

export function validateServerState(state) {
  if (!exactKeys(state, ['version', 'job_day', 'lookback_days', 'first_started_at', 'last_updated_at', 'status', 'check_status', 'checked_at', 'counts', 'report', 'error_notice', 'watchdog_notice']) || state.version !== 1 || !validDay(state.job_day) || !Number.isInteger(state.lookback_days) || state.lookback_days < 1 || state.lookback_days > 30 || !validInstant(state.first_started_at) || !validInstant(state.last_updated_at) || !STATES.has(state.status) || !['PENDING', 'SUCCEEDED', 'FAILED'].includes(state.check_status) || (state.checked_at !== undefined && !validInstant(state.checked_at))) throw error('state_invalid');
  if (!exactKeys(state.counts, ['recordings', 'misnamed']) || !Number.isSafeInteger(state.counts.recordings) || !Number.isSafeInteger(state.counts.misnamed) || state.counts.recordings < 0 || state.counts.misnamed < 0 || state.counts.misnamed > state.counts.recordings) throw error('state_invalid');
  if (state.report === undefined || state.error_notice === undefined) throw error('state_invalid');
  for (const plan of [state.report, state.error_notice, state.watchdog_notice]) {
    if (plan === null || plan === undefined) continue;
    if (!exactKeys(plan, ['report_sha256', 'chunk_count', 'recipients']) || !/^[a-f0-9]{64}$/.test(plan.report_sha256 || '') || !Number.isInteger(plan.chunk_count) || plan.chunk_count < 1 || plan.chunk_count > MAX_PARTS || !Array.isArray(plan.recipients) || !plan.recipients.length || plan.recipients.length > 20 || plan.recipients.length * plan.chunk_count > MAX_SENDS_PER_REPORT) throw error('state_invalid');
    const hashes = new Set();
    for (const recipient of plan.recipients) {
      if (!exactKeys(recipient, ['recipient_hash', 'parts']) || !/^[a-f0-9]{64}$/.test(recipient.recipient_hash || '') || hashes.has(recipient.recipient_hash) || !Array.isArray(recipient.parts) || recipient.parts.length !== plan.chunk_count) throw error('state_invalid');
      hashes.add(recipient.recipient_hash);
      for (const [index, part] of recipient.parts.entries()) {
        if (!exactKeys(part, ['part_index', 'status', 'attempt_count', 'last_attempt_at', 'retry_at', 'message_id', 'acked_at']) || part.part_index !== index || !PART_STATES.has(part.status) || !Number.isInteger(part.attempt_count) || part.attempt_count < 0 || part.attempt_count > MAX_ATTEMPTS || ['last_attempt_at', 'retry_at', 'acked_at'].some(key => part[key] !== undefined && !validInstant(part[key])) || (part.message_id !== undefined && (!Number.isSafeInteger(part.message_id) || part.message_id <= 0)) || (part.status === 'DELIVERED' && (!part.message_id || !part.acked_at))) throw error('state_invalid');
      }
    }
  }
  if (state.status === 'SUCCEEDED' && aggregateStatus(state) !== 'SUCCEEDED') throw error('state_invalid');
  return state;
}

function planSummary(plan) {
  if (!plan) return null;
  const parts = plan.recipients.flatMap(item => item.parts);
  return { chunk_count: plan.chunk_count, recipient_count: plan.recipients.length, total_parts: parts.length, delivered_parts: parts.filter(part => part.status === 'DELIVERED').length, unknown_parts: parts.filter(part => ['UNKNOWN', 'SENDING'].includes(part.status)).length, failed_parts: parts.filter(part => part.status === 'FAILED').length, retry_wait_parts: parts.filter(part => part.status === 'RETRY_WAIT').length, attempts: parts.reduce((sum, part) => sum + part.attempt_count, 0) };
}

export function sanitizedStatus(state) {
  if (!state) return { status: 'NOT_RUN' };
  return { version: state.version, job_day: state.job_day, first_started_at: state.first_started_at, last_updated_at: state.last_updated_at, status: state.status, check_status: state.check_status, checked_at: state.checked_at, lookback_days: state.lookback_days, counts: state.counts, report: planSummary(state.report), error_notice: planSummary(state.error_notice), watchdog_notice: planSummary(state.watchdog_notice) };
}

async function readState(file, filesystem) {
  try {
    const info = await filesystem.stat(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024 || (process.platform !== 'win32' && (info.mode & 0o077))) throw error('state_invalid');
    return validateServerState(JSON.parse(await filesystem.readFile(file, 'utf8')));
  } catch (cause) { if (cause.code === 'ENOENT') return null; throw error('state_invalid'); }
}

async function saveState(file, state, filesystem, now) {
  state.last_updated_at = iso(now());
  validateServerState(state);
  await filesystem.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await filesystem.writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    const temporaryHandle = await filesystem.open(temporary, 'r+');
    try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }
    await filesystem.rename(temporary, file);
    // Persist the directory entry as well as the file bytes before any send.
    // Windows cannot open directories for fsync; production is Linux and must
    // never ignore a failed directory sync there.
    let directoryHandle;
    try {
      directoryHandle = await filesystem.open(path.dirname(file), 'r');
      await directoryHandle.sync();
    } catch (cause) {
      if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'ENOTSUP', 'EINVAL'].includes(cause.code)) throw cause;
    } finally { await directoryHandle?.close(); }
  } catch { await filesystem.unlink(temporary).catch(() => undefined); throw error('state_persist_failed'); }
}

async function telegramJson(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) { await response.body?.cancel(); throw error('telegram_response_invalid'); }
  if (!response.body) throw error('telegram_response_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel(); throw error('telegram_response_invalid'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw error('telegram_response_invalid'); }
  finally { reader.releaseLock(); }
}

async function botVerified(config, fetchImpl) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/getMe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const payload = await telegramJson(response);
    if (!response.ok || payload?.ok !== true || payload.result?.is_bot !== true || String(payload.result.username || '').toLowerCase() !== EXPECTED_BOT_USERNAME || (config.expectedBotId && payload.result.id !== config.expectedBotId)) throw error('telegram_bot_mismatch');
  } catch (cause) { throw error(cause.code === 'telegram_bot_mismatch' ? 'telegram_bot_mismatch' : 'telegram_verification_failed'); }
}

function notificationPlan(message, config) {
  const chunks = splitTelegramMessage(message);
  if (chunks.length > MAX_PARTS || chunks.length * config.chatIds.length > MAX_SENDS_PER_REPORT) throw error('report_limit_exceeded');
  return { chunks, state: { report_sha256: digest(message), chunk_count: chunks.length, recipients: config.chatIds.map(chatId => ({ recipient_hash: digest(chatId), parts: chunks.map((_, index) => ({ part_index: index, status: 'PENDING', attempt_count: 0 })) })) } };
}

function reportMatches(plan, rendered) {
  return plan.report_sha256 === rendered.state.report_sha256 && plan.chunk_count === rendered.state.chunk_count && plan.recipients.map(item => item.recipient_hash).join(',') === rendered.state.recipients.map(item => item.recipient_hash).join(',');
}

function markInflightUnknown(state) {
  let changed = false;
  for (const plan of [state.report, state.error_notice].filter(Boolean)) for (const part of plan.recipients.flatMap(item => item.parts)) if (part.status === 'SENDING') { part.status = 'UNKNOWN'; changed = true; }
  if (changed) state.status = 'UNKNOWN';
  return changed;
}

async function deliver(plan, chunks, state, config, dependencies) {
  const { fetchImpl, filesystem, now, overallStatus = true } = dependencies;
  for (const [recipientIndex, recipient] of plan.recipients.entries()) {
    const chatId = config.chatIds[recipientIndex];
    if (recipient.recipient_hash !== digest(chatId)) throw error('recipient_plan_mismatch');
    for (const part of recipient.parts) {
      if (['DELIVERED', 'UNKNOWN', 'FAILED'].includes(part.status)) continue;
      if (part.status === 'RETRY_WAIT' && Date.parse(part.retry_at) > now()) continue;
      if (part.attempt_count >= MAX_ATTEMPTS) { part.status = 'FAILED'; await saveState(config.stateFile, state, filesystem, now); continue; }
      part.status = 'SENDING';
      part.attempt_count += 1;
      part.last_attempt_at = iso(now());
      delete part.retry_at;
      if (overallStatus) state.status = 'SENDING';
      await saveState(config.stateFile, state, filesystem, now);
      let response;
      let payload;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: chunks[part.part_index], link_preview_options: { is_disabled: true }, protect_content: true }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
        payload = await telegramJson(response);
      } catch { part.status = 'UNKNOWN'; }
      if (response && part.status !== 'UNKNOWN') {
        if (response.ok && payload?.ok === true && Number.isSafeInteger(payload.result?.message_id) && payload.result.message_id > 0) { part.status = 'DELIVERED'; part.message_id = payload.result.message_id; part.acked_at = iso(now()); }
        else if (response.status === 429 && payload?.ok === false && payload.error_code === 429) {
          const retrySeconds = payload.parameters?.retry_after;
          if (part.attempt_count >= MAX_ATTEMPTS || !Number.isInteger(retrySeconds) || retrySeconds < 1 || retrySeconds > 86_400) part.status = 'FAILED';
          else { part.status = 'RETRY_WAIT'; part.retry_at = iso(now() + retrySeconds * 1000); }
        } else if (response.status >= 400 && response.status < 500) part.status = 'FAILED';
        else part.status = 'UNKNOWN';
      }
      await saveState(config.stateFile, state, filesystem, now);
    }
  }
}

function aggregateStatus(state) {
  const plan = state.check_status === 'SUCCEEDED' ? state.report : state.error_notice;
  const parts = plan?.recipients.flatMap(item => item.parts) || [];
  if (parts.some(part => ['SENDING', 'UNKNOWN'].includes(part.status))) return 'UNKNOWN';
  if (state.check_status === 'SUCCEEDED' && parts.length && parts.every(part => part.status === 'DELIVERED')) return 'SUCCEEDED';
  return 'FAILED';
}

async function runWatchdog(config, dependencies) {
  const { filesystem, fetchImpl, now } = dependencies;
  const day = moscowJobDay(now());
  let primary = null;
  let mainStateValid = true;
  try { primary = await readState(config.stateFile, filesystem); }
  catch { mainStateValid = false; }
  if (primary?.job_day === day && primary.status === 'SUCCEEDED' && aggregateStatus(primary) === 'SUCCEEDED') return { exitCode: 0, status: { ...sanitizedStatus(primary), mode: 'WATCHDOG', verification_status: 'CONFIRMED' } };
  // A separate alert ledger is never allowed to overwrite an invalid primary
  // ledger. It also prevents a second alert after that primary is repaired.
  const watchdogConfig = { ...config, stateFile: `${config.stateFile}.watchdog.json` };
  let state = await readState(watchdogConfig.stateFile, filesystem);
  if (state && (state.job_day > day || Date.parse(state.first_started_at) > now() + 300_000)) throw error('state_clock_invalid');
  if (!state || state.job_day !== day) state = { version: 1, job_day: day, lookback_days: config.days, first_started_at: iso(now()), last_updated_at: iso(now()), status: 'FAILED', check_status: 'FAILED', counts: { recordings: 0, misnamed: 0 }, report: null, error_notice: null, watchdog_notice: null };
  const rendered = notificationPlan(FIXED_WATCHDOG_NOTICE, config);
  if (state.watchdog_notice && !reportMatches(state.watchdog_notice, rendered)) throw error('recipient_plan_mismatch');
  state.watchdog_notice ||= rendered.state;
  for (const part of state.watchdog_notice.recipients.flatMap(item => item.parts)) if (part.status === 'SENDING') part.status = 'UNKNOWN';
  await saveState(watchdogConfig.stateFile, state, filesystem, now);
  await botVerified(config, fetchImpl);
  await deliver(state.watchdog_notice, rendered.chunks, state, watchdogConfig, { fetchImpl, filesystem, now, overallStatus: false });
  state.status = state.watchdog_notice.recipients.some(item => item.parts.some(part => part.status === 'UNKNOWN')) ? 'UNKNOWN' : 'FAILED';
  await saveState(watchdogConfig.stateFile, state, filesystem, now);
  return { exitCode: 1, status: { mode: 'WATCHDOG', job_day: day, status: state.status, verification_status: 'UNCONFIRMED', main_state_valid: mainStateValid, primary_status: primary?.job_day === day ? primary.status : 'NOT_RUN', watchdog_notice: planSummary(state.watchdog_notice) } };
}

/** Caller must hold the external flock for the full invocation. Normal runs
 * persist only delivery metadata; dry/status modes never change state. */
export async function runServerMonitor(options = {}) {
  const env = options.env || process.env;
  const mode = options.mode || 'run';
  const filesystem = options.filesystem || fs;
  const now = options.now || Date.now;
  const fetchImpl = options.fetchImpl || fetch;
  if (!['run', 'status', 'check-config', 'check-only', 'dry-run', 'watchdog'].includes(mode)) throw error('mode_invalid');
  const config = parseServerConfig(env, { credentials: ['run', 'check-config', 'watchdog'].includes(mode) });
  if (mode === 'status') return { exitCode: 0, status: sanitizedStatus(await readState(config.stateFile, filesystem)) };
  if (mode === 'check-config') { await botVerified(config, fetchImpl); return { exitCode: 0, status: { mode: 'CHECK_CONFIG', status: 'SUCCEEDED', bot_verified: true, recipient_count: config.chatIds.length, lookback_days: config.days } }; }
  if (mode === 'watchdog') return runWatchdog(config, { filesystem, fetchImpl, now });
  const runCli = options.runCli || (days => getPlaudOutput(days, { command: '/usr/bin/plaud', fixturePath: null, safeErrors: true, env }));
  const day = moscowJobDay(now());
  const check = async () => {
    const output = await runCli(config.days);
    if (typeof output !== 'string' || Buffer.byteLength(output) > 4 * 1024 * 1024) throw error('plaud_output_untrusted');
    const recordings = parsePlaudRecentChecked(output, config.days);
    const misnamed = findMisnamedRecordings(recordings);
    return { recordings, misnamed };
  };
  if (['check-only', 'dry-run'].includes(mode)) {
    const checked = await check();
    return { exitCode: 0, status: { mode: 'CHECK_ONLY', status: 'SUCCEEDED', job_day: day, lookback_days: config.days, counts: { recordings: checked.recordings.length, misnamed: checked.misnamed.length }, notification_sent: false } };
  }
  let state = await readState(config.stateFile, filesystem);
  if (state && (state.job_day > day || Date.parse(state.first_started_at) > now() + 300_000)) throw error('state_clock_invalid');
  if (!state || state.job_day !== day) {
    state = { version: 1, job_day: day, lookback_days: config.days, first_started_at: iso(now()), last_updated_at: iso(now()), status: 'CHECKING', check_status: 'PENDING', counts: { recordings: 0, misnamed: 0 }, report: null, error_notice: null, watchdog_notice: null };
    await saveState(config.stateFile, state, filesystem, now);
  } else if (state.lookback_days !== config.days) throw error('state_configuration_changed');
  if (markInflightUnknown(state)) await saveState(config.stateFile, state, filesystem, now);
  const primaryUnknown = state.report?.recipients.some(recipient => recipient.parts.some(part => ['UNKNOWN', 'SENDING'].includes(part.status))) || (state.status === 'UNKNOWN' && state.check_status === 'SUCCEEDED' && state.report);
  // An UNKNOWN error-alert delivery must never be replayed, but it must not
  // prevent a fresh CLI check and a distinct successful daily report.
  if (state.status === 'SUCCEEDED' || primaryUnknown) return { exitCode: state.status === 'SUCCEEDED' ? 0 : 1, status: sanitizedStatus(state) };
  let checked;
  let checkError = null;
  try { checked = await check(); }
  catch (cause) { checkError = ['plaud_output_untrusted', 'plaud_cli_failed'].includes(cause.code) ? cause.code : 'plaud_cli_failed'; }
  if (checked) {
    const report = buildReport(checked.recordings, checked.misnamed, config.days, new Date(state.first_started_at));
    const rendered = notificationPlan(report, config);
    if (state.report && !reportMatches(state.report, rendered) && state.report.recipients.some(recipient => recipient.parts.some(part => part.attempt_count > 0))) {
      state.status = 'UNKNOWN';
      await saveState(config.stateFile, state, filesystem, now);
      return { exitCode: 1, status: sanitizedStatus(state), errorCode: 'report_changed_after_attempt' };
    }
    state.check_status = 'SUCCEEDED'; state.checked_at = iso(now());
    state.counts = { recordings: checked.recordings.length, misnamed: checked.misnamed.length };
    if (!state.report || !reportMatches(state.report, rendered)) state.report = rendered.state;
    await saveState(config.stateFile, state, filesystem, now);
    await botVerified(config, fetchImpl);
    await deliver(state.report, rendered.chunks, state, config, { fetchImpl, filesystem, now });
  } else {
    state.check_status = 'FAILED'; state.checked_at = iso(now());
    const rendered = notificationPlan(FIXED_ERROR_NOTICE, config);
    if (state.error_notice && !reportMatches(state.error_notice, rendered)) { state.status = 'UNKNOWN'; await saveState(config.stateFile, state, filesystem, now); return { exitCode: 1, status: sanitizedStatus(state), errorCode: 'recipient_plan_mismatch' }; }
    state.error_notice ||= rendered.state;
    await saveState(config.stateFile, state, filesystem, now);
    await botVerified(config, fetchImpl);
    await deliver(state.error_notice, rendered.chunks, state, config, { fetchImpl, filesystem, now });
  }
  state.status = aggregateStatus(state);
  await saveState(config.stateFile, state, filesystem, now);
  return { exitCode: state.status === 'SUCCEEDED' ? 0 : 1, status: sanitizedStatus(state), ...(checkError ? { errorCode: checkError } : {}) };
}

async function main() {
  try {
    const flags = process.argv.slice(2);
    if (flags.length > 1 || (flags.length && !['--status', '--check-config', '--check-only', '--dry-run', '--watchdog'].includes(flags[0]))) throw error('arguments_invalid');
    const result = await runServerMonitor({ mode: flags[0]?.slice(2) || 'run' });
    console.log(JSON.stringify(result.status));
    if (result.errorCode) console.error(JSON.stringify({ error: result.errorCode }));
    process.exitCode = result.exitCode;
  } catch (cause) { console.error(JSON.stringify({ status: 'FAILED', error: /^[a-z_]{1,64}$/.test(cause.code || '') ? cause.code : 'operation_failed' })); process.exitCode = 1; }
}

const invokedPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) await main();
