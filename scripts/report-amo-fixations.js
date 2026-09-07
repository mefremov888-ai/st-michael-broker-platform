#!/usr/bin/env node
/**
 * 2026-07-22: Отчёт «кто фиксирует уникальность В САМОЙ amoCRM» (read-only).
 *
 * Фиксации через наш кабинет — только малая часть; основной поток идёт
 * руками менеджеров/КЦ прямо в amo. Этот скрипт смотрит две стороны amo:
 *
 *  A. «Воронка брокеров» (10787390): сколько брокеров на каких стадиях,
 *     кто дошёл до «Фиксации на уникальность» и дальше.
 *  B. Клиентские воронки (КЦ, Зорге, Берзарина, Толбухина): лиды, к
 *     которым прикреплён контакт-брокер (checkbox «Брокер» 835415 или
 *     контакт есть в нашей таблице brokers) — это и есть фиксации
 *     клиентов брокерами. Считаем по брокерам.
 *
 * Всё скрещивается с отметкой «Был на брокер-туре» (842303) и с
 * фиксациями в нашей БД. Ничего не пишет. Телефоны маскируются.
 *
 * Запуск в контейнере api (workflow report-amo-fixations.yml):
 *   node /app/scripts/report-amo-fixations.js
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const mask = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d ? '***' + d.slice(-4) : '(нет)';
};

function cfRaw(entity, fieldId) {
  const f = (entity.custom_fields_values || []).find((x) => x.field_id === fieldId);
  return f?.values?.[0]?.value ?? null;
}
const isTruthy = (v) =>
  v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'да';

function contactPhones(contact) {
  const f = (contact.custom_fields_values || []).find((x) => x.field_code === 'PHONE');
  return (f?.values || []).map((v) => String(v.value || '')).filter(Boolean);
}

(async () => {
  const { NestFactory } = require('@nestjs/core');
  let AppModule;
  try {
    ({ AppModule } = require('/app/apps/api/dist/app.module'));
  } catch (e) {
    console.error('Cannot load Nest:', e?.message);
    process.exit(1);
  }
  const { AmoCrmAdapter } = require('/app/packages/integrations/dist/amo-crm.adapter');
  const { PrismaClient } = require('@st-michael/database');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = new PrismaClient();
  const amo = new AmoCrmAdapter();

  const PIPES = {
    BROKERS: 10787390,
    KC: 7600542,
    ZORGE9: 7600550,
    BERZARINA: 7600546,
    TOLBUKHINA: 7600554,
  };
  const BROKER_STAGE = {
    84932446: 'Новый брокер',
    84932450: 'Брокер-тур',
    84932454: 'ФИКСАЦИИ НА УНИКАЛЬНОСТЬ',
    84932514: 'Встреча',
    84932518: 'Сделка',
    142: 'Успешно',
    143: 'Закрыто',
  };
  const IS_BROKER = 835415;
  const TOUR_VISITED = 842303;

  try {
    // ─── 1. Все контакты amo: карта id → {name, phones, isBroker, tour} ───
    const contacts = new Map();
    let page = 1;
    let scanned = 0;
    for (;;) {
      let res;
      try {
        res = await amo['request'](`/contacts?page=${page}&limit=250`);
      } catch (e) {
        console.error(`contacts p${page}: ${e?.message || e} — стоп.`);
        break;
      }
      const list = res?._embedded?.contacts || [];
      if (list.length === 0) break;
      scanned += list.length;
      for (const c of list) {
        contacts.set(c.id, {
          name: String(c.name || '').trim() || '(без имени)',
          phones: contactPhones(c),
          isBroker: isTruthy(cfRaw(c, IS_BROKER)),
          tour: isTruthy(cfRaw(c, TOUR_VISITED)),
        });
      }
      if (page % 40 === 0) console.log(`— контакты: ${scanned} —`);
      if (!res?._links?.next) break;
      page++;
      await sleep(150);
    }
    console.log(`Контактов в amo: ${scanned}; из них брокеров (checkbox): ${[...contacts.values()].filter((c) => c.isBroker).length}; с туром: ${[...contacts.values()].filter((c) => c.tour).length}`);

    // Наши брокеры из БД (для матчинга и фиксаций кабинета)
    const dbBrokers = await prisma.$queryRaw`
      SELECT b.id, b.full_name, b.phone, b.amo_contact_id::text AS amo_contact_id,
             count(c.id) FILTER (WHERE c.uniqueness_status = 'CONDITIONALLY_UNIQUE')::int AS unique_fix
      FROM brokers b
      LEFT JOIN clients c ON c.broker_id = b.id
      WHERE b.merged_into_id IS NULL
      GROUP BY b.id, b.full_name, b.phone, b.amo_contact_id
    `;
    const dbByAmoId = new Map();
    const dbByPhone = new Map();
    for (const b of dbBrokers) {
      if (b.amo_contact_id) dbByAmoId.set(String(b.amo_contact_id), b);
      const p = last10(b.phone);
      if (p) dbByPhone.set(p, b);
    }
    const isKnownBroker = (cid) => {
      const c = contacts.get(cid);
      if (!c) return dbByAmoId.has(String(cid));
      if (c.isBroker) return true;
      if (dbByAmoId.has(String(cid))) return true;
      return c.phones.some((ph) => dbByPhone.has(last10(ph)));
    };

    // ─── 2. Лиды по воронкам ───
    async function scanLeads(pipelineId, label) {
      const leads = [];
      let p = 1;
      for (;;) {
        let res;
        try {
          res = await amo['request'](`/leads?filter[pipeline_id]=${pipelineId}&page=${p}&limit=250&with=contacts`);
        } catch (e) {
          console.error(`${label} p${p}: ${e?.message || e} — стоп.`);
          break;
        }
        const list = res?._embedded?.leads || [];
        if (list.length === 0) break;
        for (const l of list) {
          leads.push({
            id: l.id,
            status: l.status_id,
            contacts: (l._embedded?.contacts || []).map((c) => c.id),
          });
        }
        if (!res?._links?.next) break;
        p++;
        await sleep(150);
      }
      console.log(`${label}: лидов ${leads.length}`);
      return leads;
    }

    // ─── A. Воронка брокеров ───
    console.log('');
    console.log('═══ A. «ВОРОНКА БРОКЕРОВ» в amo — по стадиям ═══');
    const brokerLeads = await scanLeads(PIPES.BROKERS, 'Воронка брокеров');
    const byStage = new Map();
    for (const l of brokerLeads) byStage.set(l.status, (byStage.get(l.status) || 0) + 1);
    for (const [st, cnt] of [...byStage.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${BROKER_STAGE[st] || `стадия ${st}`}: ${cnt}`);
    }
    const FIX_STAGES = new Set([84932454, 84932514, 84932518, 142]);
    const fixStageLeads = brokerLeads.filter((l) => FIX_STAGES.has(l.status));
    console.log('');
    console.log(`Брокеры на стадии «Фиксации на уникальность» и дальше (${fixStageLeads.length} лидов):`);
    for (const l of fixStageLeads) {
      for (const cid of l.contacts) {
        const c = contacts.get(cid);
        if (!c) continue;
        console.log(`  - ${c.name} (${mask(c.phones[0])}) | ${BROKER_STAGE[l.status]} | тур: ${c.tour ? 'да' : 'нет'}`);
      }
    }

    // ─── B. Клиентские воронки: фиксации брокеров ───
    console.log('');
    console.log('═══ B. КЛИЕНТСКИЕ ЛИДЫ С ПРИКРЕПЛЁННЫМ БРОКЕРОМ (= фиксации в amo) ═══');
    const perBroker = new Map(); // cid → {total, active, won, lost}
    for (const [pipeName, pipeId] of [['КЦ', PIPES.KC], ['Зорге 9', PIPES.ZORGE9], ['Берзарина', PIPES.BERZARINA], ['Толбухина', PIPES.TOLBUKHINA]]) {
      const leads = await scanLeads(pipeId, `Воронка ${pipeName}`);
      for (const l of leads) {
        const brokerIds = l.contacts.filter((cid) => isKnownBroker(cid));
        for (const cid of brokerIds) {
          const s = perBroker.get(cid) || { total: 0, active: 0, won: 0, lost: 0 };
          s.total++;
          if (l.status === 142) s.won++;
          else if (l.status === 143) s.lost++;
          else s.active++;
          perBroker.set(cid, s);
        }
      }
    }

    const rows = [...perBroker.entries()]
      .map(([cid, s]) => {
        const c = contacts.get(cid) || { name: `contact ${cid}`, phones: [], tour: false };
        const db = dbByAmoId.get(String(cid)) || c.phones.map((ph) => dbByPhone.get(last10(ph))).find(Boolean) || null;
        return { cid, name: c.name, phone: c.phones[0], tour: c.tour, cab: db ? db.unique_fix : 0, ...s };
      })
      .sort((a, b) => b.total - a.total);

    console.log('');
    console.log(`Брокеров с ≥1 клиентским лидом в amo: ${rows.length}`);
    console.log('брокер | телефон | лидов всего | активных | успешных | закрытых | тур | фиксаций в кабинете');
    console.log('───────────────────────────────────────────');
    for (const r of rows) {
      console.log(`${r.name} | ${mask(r.phone)} | ${r.total} | ${r.active} | ${r.won} | ${r.lost} | ${r.tour ? 'да' : 'нет'} | ${r.cab || '—'}`);
    }

    console.log('');
    console.log('═══ ИТОГО ═══');
    const tourTotal = [...contacts.values()].filter((c) => c.tour).length;
    const rowsTour = rows.filter((r) => r.tour);
    console.log(`  Было на брокер-туре (amo):                    ${tourTotal}`);
    console.log(`  Брокеров с фиксациями (клиентские лиды amo):  ${rows.length}`);
    console.log(`  Из них были на туре:                          ${rowsTour.length}`);
    console.log(`  Лидов от брокеров всего:                      ${rows.reduce((a, r) => a + r.total, 0)}`);
    console.log(`  Туристы без единой фиксации:                  ${tourTotal - rowsTour.length}`);
    console.log('');
    console.log('=== Конец отчёта ===');
  } finally {
    await prisma.$disconnect();
    await app.close();
  }
})().catch((e) => {
  console.error('Fatal:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
