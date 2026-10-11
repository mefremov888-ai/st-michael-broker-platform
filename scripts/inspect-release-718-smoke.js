/* Narrow release smoke. No Nest application context, migrations or jobs. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const BASE = 'https://broker.stmichael.ru';
const OLD = ['Условия рассрочки Квартал Серебряный бор', 'Условия вознаграждения для брокеров на август 2026 г.', 'Условия вознаграждения партнёром St Michael'];
const SAFE_FAILURE = 'RELEASE_SMOKE_FAILED';
function validateInputs(env) {
  assert.match(env.SMOKE_EXPECTED_SHA || '', /^[0-9a-f]{40}$/);
  assert.equal(env.GIT_SHA, env.SMOKE_EXPECTED_SHA);
  assert.match(env.PRODUCTION_PG_SYSTEM_IDENTIFIER || '', /^\d+$/);
  assert.match(env.PRODUCTION_MIN_BROKER_ROWS || '', /^[1-9]\d*$/);
  assert.ok(['false', 'true'].includes(env.SMOKE_CONFIRM_SEND || 'false'));
}
function summarizeDocuments(docs) {
  assert.ok(Array.isArray(docs));
  assert.ok(docs.length <= 2000);
  return {
    publicCooperationCount: docs.length,
    obsoleteAbsent: OLD.every(name => !docs.some(d => d.name === name)),
  };
}
function safeTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
async function boundedJson(response, limit = 2_000_000) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= limit);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
async function publicJson(suffix) {
  const response = await fetch(BASE + suffix, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  return boundedJson(response);
}
async function verifyAgencyCounts(service, period, expected) {
  const actual = {};
  for (const [kind, filter, fields] of [
    ['with_fixations', { fixationPeriod: period }, ['fixations']],
    ['with_meetings', { meetingPeriod: period }, ['meetings']],
    ['with_both', { fixationPeriod: period, meetingPeriod: period }, ['fixations', 'meetings']],
  ]) {
    const response = await service.list('ours', 'AGENCY', { page: 1, pageSize: 1 }, undefined, { includeLowSignal: true, ...filter });
    assert.equal(response.total, expected[kind]);
    assert.ok(response.total >= 0 && response.total <= expected.total);
    for (const item of response.items) for (const field of fields) assert.ok(item.periodMetrics?.[field] > 0);
    actual[kind] = response.total;
  }
  return actual;
}
async function inspect(env = process.env) {
  validateInputs(env);
  const apiRoot = '/app/apps/api/dist';
  const compiled = fs.readFileSync(path.join(apiRoot, 'scheduler/content-freshness.service.js'), 'utf8');
  const moduleCode = fs.readFileSync(path.join(apiRoot, 'scheduler/scheduler.module.js'), 'utf8');
  const loyaltyCode = fs.readFileSync(path.join(apiRoot, 'loyalty-base/loyalty-base.service.js'), 'utf8');
  assert.ok(compiled.includes('15 9 * * *') && compiled.includes('Europe/Moscow'));
  assert.match(moduleCode, /providers:[\s\S]*ContentFreshnessService/);
  assert.ok(loyaltyCode.includes('const explicitDealPredicate') && loyaltyCode.includes('const noMeetings'));
  const health = await publicJson('/api/health');
  assert.equal(health.deployedSha, env.SMOKE_EXPECTED_SHA);
  const documents = summarizeDocuments(await publicJson('/api/public/documents?category=cooperation'));
  assert.equal(documents.obsoleteAbsent, true);
  const offer = await publicJson('/api/offer/current');
  assert.ok(typeof offer.body === 'string' && offer.body.length > 100 && typeof offer.version === 'string');
  const { PrismaClient } = require('/app/node_modules/@st-michael/database');
  const prisma = new PrismaClient();
  try {
    const report = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20000ms'");
      const identity = await tx.$queryRawUnsafe('SELECT system_identifier::text AS id FROM pg_control_system()');
      assert.equal(identity[0]?.id, env.PRODUCTION_PG_SYSTEM_IDENTIFIER);
      assert.ok(await tx.broker.count() >= Number(env.PRODUCTION_MIN_BROKER_ROWS));
      const metadata = [];
      for (const project of ['ZORGE9', 'SILVER_BOR']) {
        const row = await tx.systemSetting.findUnique({ where: { key: 'catalog.feed.freshness.' + project }, select: { value: true } });
        let value = null;
        try { value = JSON.parse(row?.value || 'null'); } catch { /* unknown */ }
        metadata.push({ project, lastSuccessfulImportAt: safeTimestamp(value?.lastSuccessfulImportAt), sourceGeneratedAt: safeTimestamp(value?.sourceGeneratedAt) });
      }
      // Independent current-membership counts, NOT complete API parity. Registry
      // agency-name aliases intentionally are not approximated by this query.
      const rows = await tx.$queryRawUnsafe(`
        WITH periods AS (
          SELECT date_trunc('month', now() AT TIME ZONE 'Europe/Moscow')::date AS start,
                 (now() AT TIME ZONE 'Europe/Moscow')::date AS finish
        ), activity AS (
          SELECT a.id,
            EXISTS (SELECT 1 FROM broker_agencies ba JOIN clients c ON c.broker_id = ba.broker_id, periods p
              WHERE ba.agency_id = a.id AND c.created_at::date BETWEEN p.start AND p.finish
              AND (c.fixation_status IN ('FIXED','EXPIRED') OR c.uniqueness_status IN ('CONDITIONALLY_UNIQUE','EXPIRED'))) AS fixes,
            EXISTS (SELECT 1 FROM broker_agencies ba JOIN meetings m ON m.broker_id = ba.broker_id, periods p
              WHERE ba.agency_id = a.id AND m.date::date BETWEEN p.start AND p.finish
              AND m.status IN ('CONFIRMED','COMPLETED') AND m.type <> 'BROKER_TOUR') AS meetings
          FROM agencies a
        ) SELECT count(*)::int AS total,
          count(*) FILTER (WHERE fixes)::int AS with_fixations,
          count(*) FILTER (WHERE meetings)::int AS with_meetings,
          count(*) FILTER (WHERE fixes AND meetings)::int AS with_both FROM activity`);
      const periodRows = await tx.$queryRawUnsafe(`SELECT to_char(date_trunc('month', now() AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM-DD') AS "from", to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS "to"`);
      const { LoyaltyBaseService } = require(path.join(apiRoot, 'loyalty-base/loyalty-base.service'));
      const actual = await verifyAgencyCounts(new LoyaltyBaseService(tx), periodRows[0], rows[0]);
      return { catalogMetadata: metadata, currentMonthAgencySqlCounts: rows[0], currentMonthAgencyServiceCounts: actual, fixationMeetingParityVerified: true, apiParityVerified: false };
    }, { timeout: 90000 });
    console.log(JSON.stringify({ deployedSha: env.SMOKE_EXPECTED_SHA, freshnessRegistered: true, cron: '09:15 Europe/Moscow', ...documents, offerPresent: true, ...report }));
    if (env.SMOKE_CONFIRM_SEND === 'true') {
      // Explicit opt-in only: this can notify ops and reserve daily dedup keys.
      const { ConfigService } = require('/app/node_modules/@nestjs/config');
      const { CatalogService } = require(path.join(apiRoot, 'catalog/catalog.service'));
      const { OpsAlertService } = require(path.join(apiRoot, 'ops-alert/ops-alert.service'));
      const { ContentFreshnessService } = require(path.join(apiRoot, 'scheduler/content-freshness.service'));
      const stateWrites = { reservationsCreated: 0, statesUpdated: 0 };
      const settings = new Proxy(prisma.systemSetting, { get(target, key) {
        if (!['findUnique', 'create', 'upsert'].includes(String(key))) throw new Error(SAFE_FAILURE);
        return async args => {
          const settingKey = args.where?.key || args.data?.key || args.create?.key;
          assert.ok(String(settingKey).startsWith('content-freshness:'));
          assert.match(String(settingKey), /^content-freshness:(?:state:(?:catalog|conditions)(?:-check)?|alert:(?:catalog|conditions)(?:-check)?:\d{4}-\d{2}-\d{2}:(?:warning|recovered))$/);
          const result = await target[key](args);
          if (key === 'create') stateWrites.reservationsCreated++;
          if (key === 'upsert') stateWrites.statesUpdated++;
          return result;
        };
      } });
      const alertService = new OpsAlertService(new ConfigService());
      const delivery = { attempted: 0, confirmed: 0, unconfirmed: 0 };
      const trackedAlerts = { async sendSafely(...args) {
        delivery.attempted++;
        let sent = false;
        try { sent = await alertService.sendSafely(...args); } catch { /* unconfirmed */ }
        if (sent === true) delivery.confirmed++; else delivery.unconfirmed++;
        return sent;
      } };
      await new ContentFreshnessService({ systemSetting: settings, document: { findMany: prisma.document.findMany.bind(prisma.document) } }, new CatalogService(prisma), trackedAlerts).check();
      console.log(JSON.stringify({ freshnessCheckInvoked: true, delivery, stateWrites, noDeliveryAttemptMade: delivery.attempted === 0 }));
      if (delivery.unconfirmed) throw new Error(SAFE_FAILURE);
    }
  } finally { await prisma.$disconnect(); }
}
module.exports = { validateInputs, summarizeDocuments, safeTimestamp, boundedJson, verifyAgencyCounts, inspect };
if (require.main === module) inspect().catch(() => { console.error(SAFE_FAILURE); process.exitCode = 1; });
