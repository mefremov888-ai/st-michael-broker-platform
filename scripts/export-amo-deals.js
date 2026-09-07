#!/usr/bin/env node
/**
 * 2026-09-04: разовая read-only выгрузка сделок из amoCRM для сквозной
 * аналитики ДДУ (сшивка: amo ↔ Google-реестр продаж ↔ старая база кабинета).
 *
 * Что выгружает: лиды клиентских воронок, у которых заполнен «№ договора»
 * (558577) ЛИБО статус «Успешно реализовано» (142). Для каждого — номер/дата/
 * тип договора, стоимость в ДДУ, комиссия, привязанные контакты (кто из них
 * брокер), связь с нашей БД (deal.amoLeadId, broker.amoContactId).
 *
 * ФИО клиентов НЕ выгружаются. Телефоны НЕ выгружаются.
 * Вывод: NDJSON между маркерами ===EXPORT-BEGIN=== / ===EXPORT-END===
 * (забирается из лога workflow run).
 *
 * Запуск в контейнере api (workflow export-amo-deals.yml):
 *   node /app/scripts/export-amo-deals.js
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const F = {
  CONTRACT_NUMBER: 558577,
  CONTRACT_DATE: 558353,
  CONTRACT_TYPE: 617493,
  PRICE_DDU: 833065,
  PRICE_NO_DISCOUNT: 833045,
  PRICE_WITH_DISCOUNT: 833069,
  SQM: 604555,
  COMMISSION_AMOUNT: 673171,
  COMMISSION_RATE: 673169,
  IS_BROKER_CONTACT: 835415,
  CC_ID_PARENT: 839249,
};

function cfRaw(entity, fieldId) {
  const f = (entity.custom_fields_values || []).find((x) => x.field_id === fieldId);
  return f?.values?.[0]?.value ?? null;
}
const isTruthy = (v) =>
  v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'да';

(async () => {
  // Без NestFactory(AppModule): полный контекст запускает шедулеры (кроны
  // синка) внутри скрипта — дублирование и записи в БД из read-only выгрузки.
  // Токены amo загружаем напрямую из SystemSetting (как amo-token-bootstrap),
  // hook на refresh обязателен — refresh_token ротируется при каждом использовании.
  const {
    AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook,
  } = require('/app/packages/integrations/dist/amo-crm.adapter');
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();

  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: ['AMO_ACCESS_TOKEN', 'AMO_REFRESH_TOKEN'] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  setAmoTokens(
    byKey.get('AMO_ACCESS_TOKEN') || process.env.AMO_ACCESS_TOKEN || '',
    byKey.get('AMO_REFRESH_TOKEN') || process.env.AMO_REFRESH_TOKEN || '',
  );
  setAmoTokenRefreshHook(async (tokens) => {
    for (const [key, value] of [['AMO_ACCESS_TOKEN', tokens.access], ['AMO_REFRESH_TOKEN', tokens.refresh]]) {
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value, updatedBy: 'export-amo-deals' },
        create: { key, value, updatedBy: 'export-amo-deals' },
      });
    }
    console.error('amo tokens refreshed and persisted');
  });

  const amo = new AmoCrmAdapter();

  try {
    // ─── 0. Воронки и статусы: id → имя (разрешаем конфликт СерБор/Берзарина) ───
    const pipes = await amo['request']('/leads/pipelines');
    const pipeNames = {};
    const statusNames = {};
    for (const p of pipes?._embedded?.pipelines || []) {
      pipeNames[p.id] = p.name;
      for (const s of p._embedded?.statuses || []) statusNames[`${p.id}:${s.id}`] = s.name;
    }
    console.log('PIPELINES:', JSON.stringify(pipeNames));

    // Клиентские воронки (КЦ + объектные). Воронку брокеров (10787390) не трогаем.
    const CLIENT_PIPES = [7600542, 7600546, 7600550, 7600554];

    // ─── 1. Брокеры из нашей БД: amoContactId → broker.id ───
    const dbBrokers = await prisma.$queryRaw`
      SELECT id, amo_contact_id::text AS amo_contact_id
      FROM brokers WHERE amo_contact_id IS NOT NULL AND merged_into_id IS NULL
    `;
    const brokerByAmoContact = new Map(dbBrokers.map((b) => [String(b.amo_contact_id), b.id]));

    // Контакты-брокеры прямо из amo (checkbox «Брокер» 835415)
    const amoBrokerContacts = new Set();
    let cp = 1;
    for (;;) {
      let res;
      try {
        res = await amo['request'](`/contacts?page=${cp}&limit=250`);
      } catch (e) {
        console.error(`contacts p${cp}: ${e?.message || e} — стоп.`);
        break;
      }
      const list = res?._embedded?.contacts || [];
      if (list.length === 0) break;
      for (const c of list) {
        if (isTruthy(cfRaw(c, F.IS_BROKER_CONTACT))) amoBrokerContacts.add(c.id);
      }
      if (!res?._links?.next) break;
      cp++;
      await sleep(150);
    }
    console.log(`Контактов-брокеров в amo (checkbox): ${amoBrokerContacts.size}; в БД с amoContactId: ${brokerByAmoContact.size}`);

    // ─── 2. Сделки кабинета: amoLeadId → deal.id ───
    const dbDeals = await prisma.$queryRaw`
      SELECT id, amo_deal_id::text AS amo_lead_id FROM deals WHERE amo_deal_id IS NOT NULL
    `;
    const dealByAmoLead = new Map(dbDeals.map((d) => [String(d.amo_lead_id), d.id]));
    console.log(`Сделок в БД кабинета с amoLeadId: ${dealByAmoLead.size}`);

    // ─── 3. Лиды клиентских воронок ───
    const out = [];
    const stats = { scanned: 0, withContract: 0, success: 0, exported: 0 };
    for (const pid of CLIENT_PIPES) {
      let p = 1;
      for (;;) {
        let res;
        try {
          res = await amo['request'](`/leads?filter[pipeline_id]=${pid}&page=${p}&limit=250&with=contacts`);
        } catch (e) {
          console.error(`leads pipe=${pid} p${p}: ${e?.message || e} — стоп.`);
          break;
        }
        const list = res?._embedded?.leads || [];
        if (list.length === 0) break;
        for (const l of list) {
          stats.scanned++;
          const contractNumber = cfRaw(l, F.CONTRACT_NUMBER);
          const isSuccess = l.status_id === 142;
          if (contractNumber) stats.withContract++;
          if (isSuccess) stats.success++;
          if (!contractNumber && !isSuccess) continue;
          const contactIds = (l._embedded?.contacts || []).map((c) => ({
            id: c.id,
            main: !!c.is_main,
            isBroker: amoBrokerContacts.has(c.id) || brokerByAmoContact.has(String(c.id)),
            dbBrokerId: brokerByAmoContact.get(String(c.id)) || null,
          }));
          out.push({
            leadId: l.id,
            pipeline: pipeNames[l.pipeline_id] || l.pipeline_id,
            status: statusNames[`${l.pipeline_id}:${l.status_id}`] || l.status_id,
            statusId: l.status_id,
            price: l.price ?? null,
            createdAt: l.created_at ?? null,
            closedAt: l.closed_at ?? null,
            contractNumber: contractNumber != null ? String(contractNumber) : null,
            contractDate: cfRaw(l, F.CONTRACT_DATE),
            contractType: cfRaw(l, F.CONTRACT_TYPE),
            priceDdu: cfRaw(l, F.PRICE_DDU),
            priceNoDiscount: cfRaw(l, F.PRICE_NO_DISCOUNT),
            priceWithDiscount: cfRaw(l, F.PRICE_WITH_DISCOUNT),
            sqm: cfRaw(l, F.SQM),
            commissionAmount: cfRaw(l, F.COMMISSION_AMOUNT),
            commissionRate: cfRaw(l, F.COMMISSION_RATE),
            ccIdParent: cfRaw(l, F.CC_ID_PARENT),
            dbDealId: dealByAmoLead.get(String(l.id)) || null,
            contacts: contactIds,
          });
          stats.exported++;
        }
        if (!res?._links?.next) break;
        p++;
        await sleep(150);
      }
      console.log(`— воронка ${pipeNames[pid] || pid}: просканировано, накоплено ${out.length} —`);
    }

    console.log('STATS:', JSON.stringify(stats));
    console.log('===EXPORT-BEGIN===');
    for (const row of out) console.log(JSON.stringify(row));
    console.log('===EXPORT-END===');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
