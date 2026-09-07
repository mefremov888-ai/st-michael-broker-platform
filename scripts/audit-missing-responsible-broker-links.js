#!/usr/bin/env node
/**
 * Read-only аудит уже созданных фиксаций: проверяет, прикреплён ли к
 * amoCRM-лиду фактический брокер (responsibleBroker || broker).
 *
 * Гарантии безопасности:
 *   - БД: только SELECT через Prisma;
 *   - amoCRM: только GET, без AmoCrmAdapter и его OAuth refresh;
 *   - никаких APPLY/POST/PATCH и никаких файлов на диске.
 *
 * Параметры окружения:
 *   AUDIT_DAYS  — окно по Client.createdAt, default 30, max 3650;
 *   AUDIT_LIMIT — максимум Client, default 200, max 1000.
 *
 * Запуск в production через workflow:
 *   task=audit-missing-responsible-broker-links
 */

const KC_PIPELINE_ID = 7600542;
const CLASSIFICATIONS = [
  'broker_attached',
  'missing_broker_link',
  'broker_amo_id_missing',
  'lead_missing',
  'non_kc_pipeline',
  'api_error',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boundedInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : '(нет)';
}

function tokenApiDomain(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.api_domain === 'string' ? payload.api_domain : '';
  } catch {
    return '';
  }
}

function effectiveBroker(client) {
  return client.responsibleBroker || client.broker || null;
}

function classify({ fetchResult, pipelineId, contactIds, amoContactId }) {
  if (fetchResult === 'lead_missing') return 'lead_missing';
  if (fetchResult === 'api_error') return 'api_error';
  if (pipelineId !== KC_PIPELINE_ID) return 'non_kc_pipeline';
  if (!amoContactId) return 'broker_amo_id_missing';
  return contactIds.includes(Number(amoContactId)) ? 'broker_attached' : 'missing_broker_link';
}

async function fetchLeadReadOnly(baseUrl, accessToken, leadId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${baseUrl}/leads/${leadId}?with=contacts`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'st-michael-read-only-broker-link-audit/1.0',
      },
      signal: controller.signal,
    });
    if (response.status === 404) return { kind: 'lead_missing', error: 'HTTP 404' };
    if (!response.ok) return { kind: 'api_error', error: `HTTP ${response.status}` };
    const lead = await response.json();
    return { kind: 'ok', lead };
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'GET timeout' : String(error?.message || error).slice(0, 160);
    return { kind: 'api_error', error: message };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const days = boundedInt(process.env.AUDIT_DAYS, 30, 1, 3650);
  const limit = boundedInt(process.env.AUDIT_LIMIT, 200, 1, 1000);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();

  try {
    let dbAccessToken = '';
    try {
      const setting = await prisma.systemSetting.findUnique({
        where: { key: 'AMO_ACCESS_TOKEN' },
        select: { value: true },
      });
      dbAccessToken = setting?.value || '';
    } catch (error) {
      console.warn(`[audit] AMO_ACCESS_TOKEN из SystemSetting недоступен: ${error?.message || error}`);
    }

    const accessToken = dbAccessToken || process.env.AMO_ACCESS_TOKEN || '';
    if (!accessToken) throw new Error('AMO_ACCESS_TOKEN отсутствует в SystemSetting и env');

    const subdomain = process.env.AMO_SUBDOMAIN || 'stmichael';
    const baseDomain = process.env.AMO_BASE_DOMAIN || 'amocrm.ru';
    const apiDomain = process.env.AMO_API_DOMAIN || tokenApiDomain(accessToken) || `${subdomain}.${baseDomain}`;
    const baseUrl = `https://${apiDomain}/api/v4`;

    const clients = await prisma.client.findMany({
      where: {
        amoLeadId: { not: null },
        createdAt: { gte: since },
      },
      include: {
        broker: { select: { id: true, phone: true, amoContactId: true } },
        responsibleBroker: { select: { id: true, phone: true, amoContactId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    console.log('════════════════════════════════════════════════════');
    console.log('READ-ONLY AUDIT: связи ответственного брокера с amoCRM-лидом');
    console.log(`Окно: ${days} дней (с ${since.toISOString()}), limit=${limit}, найдено=${clients.length}`);
    console.log('БД: только SELECT; amoCRM: только GET; изменения отключены безусловно.');
    console.log('════════════════════════════════════════════════════');

    const summary = Object.fromEntries(CLASSIFICATIONS.map((key) => [key, 0]));
    const snapshot = [];
    const leadCache = new Map();

    for (const client of clients) {
      const leadId = Number(client.amoLeadId);
      const broker = effectiveBroker(client);
      const responsibleBrokerId = broker?.id || client.responsibleBrokerId || client.brokerId || null;
      const amoContactId = broker?.amoContactId ? Number(broker.amoContactId) : null;

      let leadResult = leadCache.get(leadId);
      if (!leadResult) {
        leadResult = await fetchLeadReadOnly(baseUrl, accessToken, leadId);
        leadCache.set(leadId, leadResult);
        // Не превышаем обычный amoCRM rate limit даже при уникальных лидах.
        await sleep(180);
      }

      const lead = leadResult.kind === 'ok' ? leadResult.lead : null;
      const pipelineId = lead ? Number(lead.pipeline_id) : null;
      const contactIds = lead
        ? (lead._embedded?.contacts || []).map((contact) => Number(contact.id)).filter(Number.isFinite)
        : [];
      const classification = classify({
        fetchResult: leadResult.kind,
        pipelineId,
        contactIds,
        amoContactId,
      });
      summary[classification]++;

      const row = {
        classification,
        clientId: client.id,
        clientCreatedAt: client.createdAt?.toISOString() || null,
        leadId,
        pipelineId,
        contactIds,
        ownerBrokerId: client.brokerId,
        responsibleBrokerId,
        delegated: Boolean(client.responsibleBrokerId && client.responsibleBrokerId !== client.brokerId),
        amoContactId,
        clientPhoneMasked: maskPhone(client.phone),
        brokerPhoneMasked: maskPhone(broker?.phone),
        ...(leadResult.error ? { error: leadResult.error } : {}),
      };
      snapshot.push(row);

      console.log(
        `${classification.padEnd(22)} lead=${leadId} contacts=[${contactIds.join(',')}] `
          + `broker=${responsibleBrokerId || '—'}/amo#${amoContactId || '—'} `
          + `client=${row.clientPhoneMasked} brokerPhone=${row.brokerPhoneMasked}`,
      );
    }

    console.log('');
    console.log('═══ СВОДКА ═══');
    for (const key of CLASSIFICATIONS) console.log(`  ${key}: ${summary[key]}`);
    console.log(`  total: ${snapshot.length}`);
    console.log('');
    console.log('=== AUDIT_JSON_SNAPSHOT_START ===');
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      readOnly: true,
      query: { days, limit, since: since.toISOString() },
      summary,
      records: snapshot,
    }, null, 2));
    console.log('=== AUDIT_JSON_SNAPSHOT_END ===');
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  boundedInt,
  maskPhone,
  tokenApiDomain,
  effectiveBroker,
  classify,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('Audit failed:', error?.message || error);
    process.exit(1);
  });
}
