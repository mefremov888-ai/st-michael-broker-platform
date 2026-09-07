/**
 * Одноразовая read-only выборка (07.09.2026): кто те контакты успешных
 * КЦ-встреч (pipeline 7600542, статус 142), чьих телефонов нет ни среди
 * брокеров, ни среди клиентов кабинета (~4 496 по dry-run бэкфилла).
 * Версии владельца: прямые покупатели с рекламы / брокеры вне базы /
 * импорт контактов из Telegram. Скрипт листает воронку и собирает ПЕРВЫЕ
 * SAMPLE_LIMIT несовпавших контактов: имя, теги, дата создания, ответственный.
 * Телефоны НЕ печатаются. Ничего не пишет ни в БД, ни в amo.
 *
 * Хелперы телефонов продублированы 1-в-1 из scripts/backfill-meetings.js.
 */
const { PrismaClient } = require('/app/node_modules/@prisma/client');

const KC_PIPELINE_ID = 7600542;
const KC_MEETING_HELD_STATUS = 142;
const AMO_PHONE_FIELD_ID = 557903;
const AMO_PAUSE_MS = 280;
const SAMPLE_LIMIT = Number(process.env.SAMPLE_LIMIT || 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizePhoneKey(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    return digits.slice(1);
  }
  if (digits.length > 11 && (digits[0] === '7' || digits[0] === '8')) {
    return digits.slice(1, 11);
  }
  return null;
}

function phoneKeyCandidates(raw) {
  const keys = new Set();
  let badFormat = false;
  const parts = String(raw || '').split(/[,;/]|(?:\s(?:или|доб)\.?\s)/i);
  for (const part of parts) {
    const key = normalizePhoneKey(part);
    if (key) keys.add(key);
    else if (part.replace(/\D/g, '').length >= 5) badFormat = true;
  }
  return { keys: [...keys], badFormat };
}

async function initAmo(prisma) {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } =
    require('/app/packages/integrations/dist/amo-crm.adapter');
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: ['AMO_ACCESS_TOKEN', 'AMO_REFRESH_TOKEN'] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  setAmoTokens(byKey.get('AMO_ACCESS_TOKEN') || '', byKey.get('AMO_REFRESH_TOKEN') || '');
  setAmoTokenRefreshHook(async (tokens) => {
    for (const [key, value] of [
      ['AMO_ACCESS_TOKEN', tokens.access],
      ['AMO_REFRESH_TOKEN', tokens.refresh],
    ]) {
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value, updatedBy: 'sample-unmatched-contacts' },
        create: { key, value, updatedBy: 'sample-unmatched-contacts' },
      });
    }
  });
  return new AmoCrmAdapter();
}

async function buildKnownPhoneKeys(prisma) {
  const known = new Set();
  const add = (raw) => {
    const k = normalizePhoneKey(raw);
    if (k) known.add(k);
  };
  for (const b of await prisma.broker.findMany({ select: { phone: true } })) add(b.phone);
  for (const p of await prisma.brokerPhone.findMany({ select: { phone: true } })) add(p.phone);
  for (const c of await prisma.client.findMany({ select: { phone: true } })) add(c.phone);
  return known;
}

async function main() {
  const prisma = new PrismaClient();
  const amo = await initAmo(prisma);
  const known = await buildKnownPhoneKeys(prisma);
  console.log(`известных ключей телефонов в кабинете: ${known.size}`);

  const samples = [];
  const tagStats = new Map();
  const seenContacts = new Set();
  let scanned = 0;
  let success = 0;
  let unmatched = 0;
  let page = 1;

  outer: for (;;) {
    let res;
    try {
      res = await amo['request'](
        `/leads?filter[pipeline_id]=${KC_PIPELINE_ID}&page=${page}&limit=250&with=contacts`,
      );
    } catch (e) {
      console.error(`leads page=${page}: ${e?.message || e} — стоп.`);
      break;
    }
    const list = res?._embedded?.leads || [];
    if (list.length === 0) break;
    for (const lead of list) {
      scanned++;
      if (Number(lead.status_id) !== KC_MEETING_HELD_STATUS) continue;
      success++;
      const contacts = lead?._embedded?.contacts || [];
      const main = contacts.find((c) => c.is_main) || contacts[0];
      if (!main?.id || seenContacts.has(main.id)) continue;
      seenContacts.add(main.id);

      let contact;
      try {
        await sleep(AMO_PAUSE_MS);
        const cres = await amo['request'](`/contacts/${main.id}`);
        contact = cres;
      } catch {
        continue;
      }
      const keys = new Set();
      for (const field of contact?.custom_fields_values || []) {
        const isPhone = field.field_id === AMO_PHONE_FIELD_ID || field.field_code === 'PHONE';
        if (!isPhone) continue;
        for (const v of field.values || []) {
          for (const k of phoneKeyCandidates(v?.value).keys) keys.add(k);
        }
      }
      if (keys.size === 0) continue;
      const matched = [...keys].some((k) => known.has(k));
      if (matched) continue;

      unmatched++;
      const tags = (contact?._embedded?.tags || []).map((t) => t.name);
      for (const t of tags) tagStats.set(t, (tagStats.get(t) || 0) + 1);
      samples.push({
        contactId: contact.id,
        name: String(contact?.name || '(без имени)').slice(0, 60),
        tags: tags.join(', ') || '—',
        createdAt: contact?.created_at
          ? new Date(contact.created_at * 1000).toISOString().slice(0, 10)
          : '—',
        leadId: lead.id,
        leadName: String(lead?.name || '').slice(0, 50),
      });
      if (samples.length >= SAMPLE_LIMIT) break outer;
    }
    if (!res?._links?.next) break;
    page++;
    await sleep(AMO_PAUSE_MS);
  }

  console.log(`просмотрено лидов: ${scanned}, успешных 142: ${success}, несовпавших собрано: ${unmatched}`);
  console.log('');
  console.log('=== ВЫБОРКА НЕСОВПАВШИХ КОНТАКТОВ (имя | теги | создан | лид) ===');
  for (const s of samples) {
    console.log(
      `  ${s.name} | теги: ${s.tags} | создан: ${s.createdAt} | контакт ${s.contactId} | лид ${s.leadId} «${s.leadName}»`,
    );
  }
  console.log('');
  console.log('=== ЧАСТОТА ТЕГОВ в выборке ===');
  for (const [tag, n] of [...tagStats.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n} × ${tag}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(`FATAL: ${e?.message || e}`);
  process.exit(1);
});
