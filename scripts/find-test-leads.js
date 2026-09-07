#!/usr/bin/env node
/**
 * Поиск «тестовых» лидов в amoCRM — кандидатов на удаление.
 * НИЧЕГО НЕ УДАЛЯЕТ. Только печатает список.
 *
 * Условия (2026-06-17 v2 — по ТЗ пользователя):
 *   - UTM source = «Заявка от брокера» (field_id 618551), ИЛИ
 *   - Имя лида / имя контакта содержит "тест" / "test"
 *
 * Запуск: workflow seed-data, task=find-test-leads
 */

const PIPELINES = {
  7600542: 'КЦ',
  7600546: 'Берзарина(СБ)',
  7600550: 'Зорге9',
  7600554: 'Толбухина',
  10787390: 'Брокеры',
};

const UTM_SOURCE_FIELD_ID = 618551; // «Источник / utm_source»
const BROKER_UTM_VALUE = 'Заявка от брокера';
const TEST_RE = /(test|тест)/i;

(async () => {
  const subdomain = process.env.AMO_SUBDOMAIN || 'stmichael';
  const domain = process.env.AMO_BASE_DOMAIN || 'amocrm.ru';
  const apiDomain = process.env.AMO_API_DOMAIN || `${subdomain}.${domain}`;
  const BASE = `https://${apiDomain}/api/v4`;
  const TOKEN = process.env.AMO_ACCESS_TOKEN;
  if (!TOKEN) {
    console.error('AMO_ACCESS_TOKEN missing');
    process.exit(1);
  }

  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  async function fetchAllLeadsInPipeline(pipelineId) {
    const out = [];
    let page = 1;
    while (true) {
      const url = `${BASE}/leads?filter[pipeline_id][]=${pipelineId}&with=contacts&limit=250&page=${page}`;
      const r = await fetch(url, { headers });
      if (r.status === 204 || r.status === 404) break;
      if (!r.ok) {
        console.error(`HTTP ${r.status} on pipeline ${pipelineId} page ${page}`);
        break;
      }
      const data = await r.json();
      const leads = data?._embedded?.leads || [];
      if (!leads.length) break;
      out.push(...leads);
      if (leads.length < 250) break;
      page++;
      if (page > 50) break;
    }
    return out;
  }

  const contactCache = new Map();
  async function getContactName(id) {
    if (contactCache.has(id)) return contactCache.get(id);
    try {
      const r = await fetch(`${BASE}/contacts/${id}`, { headers });
      if (!r.ok) { contactCache.set(id, ''); return ''; }
      const c = await r.json();
      const name = String(c?.name || '').trim();
      contactCache.set(id, name);
      return name;
    } catch {
      contactCache.set(id, '');
      return '';
    }
  }

  function getUtmSource(lead) {
    const f = (lead.custom_fields_values || []).find((x) => x.field_id === UTM_SOURCE_FIELD_ID);
    if (!f) return '';
    return String(f.values?.[0]?.value || '');
  }

  const candidates = [];
  for (const [pid, pname] of Object.entries(PIPELINES)) {
    console.log(`\n--- ${pname} (${pid}) ---`);
    const leads = await fetchAllLeadsInPipeline(Number(pid));
    console.log(`  всего лидов: ${leads.length}`);
    let countBrokerUtm = 0;
    let countTestName = 0;
    for (const lead of leads) {
      const leadName = String(lead.name || '');
      const utmSource = getUtmSource(lead);
      const isBrokerUtm = utmSource === BROKER_UTM_VALUE;

      // Имя контакта берём только если нужно — если уже brokerUtm, всё равно резолвим для отображения.
      const contactRefs = lead._embedded?.contacts || [];
      let cname = '';
      const needsContactCheck = !isBrokerUtm; // если уже broker — контакт нужен только для отображения
      for (const ref of contactRefs) {
        if (!ref?.id) continue;
        const n = await getContactName(ref.id);
        if (n) { cname = n; break; }
      }

      const nameHasTest = TEST_RE.test(leadName) || TEST_RE.test(cname);

      if (isBrokerUtm) countBrokerUtm++;
      if (nameHasTest) countTestName++;

      if (isBrokerUtm || nameHasTest) {
        candidates.push({
          leadId: lead.id,
          pipelineName: pname,
          statusId: lead.status_id,
          createdAt: lead.created_at ? new Date(lead.created_at * 1000).toISOString().slice(0, 10) : '—',
          leadName,
          contactName: cname,
          matchedBy: [
            isBrokerUtm ? 'broker-utm' : null,
            nameHasTest ? 'test-name' : null,
          ].filter(Boolean).join('+'),
        });
      }
    }
    console.log(`  broker-utm: ${countBrokerUtm}, test-name: ${countTestName}`);
  }

  candidates.sort((a, b) => String(a.pipelineName).localeCompare(String(b.pipelineName)) || a.leadId - b.leadId);

  console.log(`\n═══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Кандидаты на удаление: ${candidates.length}`);
  console.log(`═══════════════════════════════════════════════════════════════════════════════════`);
  console.log(
    `leadId    | pipeline       | status   | created    | match        | leadName                       | contactName`,
  );
  console.log(
    `----------|----------------|----------|------------|--------------|--------------------------------|------------`,
  );
  for (const c of candidates) {
    console.log(
      `${String(c.leadId).padEnd(9)} | ${c.pipelineName.padEnd(14)} | ${String(c.statusId).padEnd(8)} | ${c.createdAt.padEnd(10)} | ${c.matchedBy.padEnd(12)} | ${c.leadName.slice(0, 30).padEnd(30)} | ${c.contactName}`,
    );
  }
  console.log(`\nЕсли список ОК — следующим шагом сделаю delete-test-leads с этими ID.`);
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
