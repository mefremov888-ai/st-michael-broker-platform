#!/usr/bin/env node
/**
 * 2026-07-17: Обогащение «безымянных» брокеров данными из amoCRM по телефону.
 *
 * По аудиту базы: 1098 записей «(без имени)», 168 записей телефон-вместо-имени.
 * Решение пользователя: обогатить из amo, НИЧЕГО НЕ УДАЛЯТЬ.
 *
 * Для каждого брокера с плохим именем ищем контакт в amo по номеру:
 *   - имя контакта (если осмысленное) → fullName
 *   - email / telegram / whatsapp / должность → только в ПУСТЫЕ поля
 *   - amoContactId → если у брокера нет связи и контакт не занят другим брокером
 *
 * Запуск в контейнере api (через workflow enrich-brokers-from-amo.yml):
 *   node /app/scripts/enrich-brokers-from-amo.js            # dry-run (по умолчанию)
 *   node /app/scripts/enrich-brokers-from-amo.js --apply    # записать изменения
 *   node /app/scripts/enrich-brokers-from-amo.js --limit 50 # для теста
 *
 * Rate-лимит amo ~7 req/s — идём последовательно с паузой 250мс (~4 req/s).
 */

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i === -1) return null;
  const n = Number(args[i + 1]);
  return isNaN(n) ? null : n;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Имя считается «плохим», если пустое, «(без имени)», или это просто телефон.
function isBadName(name) {
  const t = String(name || '').trim();
  if (!t) return true;
  if (t.toLowerCase() === '(без имени)') return true;
  if (/^[-+0-9() ]+$/.test(t)) return true;
  return false;
}

// Имя из amo годится, если оно само не «плохое» и длиннее 2 символов.
// 2026-07-17 (по dry-run): в amo встречаются имена-заглушки — «брокер»,
// «Не оставлял заявку» и т.п. Такими не обогащаем (связь amoContactId
// при этом всё равно проставляется).
const STOP_NAMES = new Set(['брокер', 'клиент', 'тест', 'без имени', 'не оставлял заявку']);
function isGoodCandidate(name) {
  const t = String(name || '').trim();
  if (isBadName(t) || t.length <= 2) return false;
  if (STOP_NAMES.has(t.toLowerCase())) return false;
  if (/^не оставлял/i.test(t)) return false;
  return true;
}

function cfValue(contact, fieldId) {
  const f = (contact.custom_fields_values || []).find((x) => x.field_id === fieldId);
  const v = f?.values?.[0]?.value;
  return v == null ? null : String(v).trim() || null;
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
  const { AMO_CONTACT_FIELDS } = require('/app/packages/integrations/dist/amo-crm.fields');
  const { PrismaClient } = require('@st-michael/database');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = new PrismaClient();
  const amo = new AmoCrmAdapter();

  try {
    const candidates = await prisma.$queryRaw`
      SELECT id, full_name, phone, email, telegram_username, whatsapp_username,
             position, amo_contact_id
      FROM brokers
      WHERE role = 'BROKER'
        AND merged_into_id IS NULL
        AND (
          btrim(coalesce(full_name, '')) = ''
          OR lower(btrim(full_name)) = '(без имени)'
          OR full_name ~ '^[-+0-9() ]+$'
        )
      ORDER BY created_at ASC
      LIMIT ${LIMIT || 1000000}
    `;

    console.log(`Режим: ${APPLY ? 'APPLY (пишем в БД)' : 'DRY-RUN (только показываем)'}`);
    console.log(`Кандидатов с плохим именем: ${candidates.length}`);
    console.log('───────────────────────────────────');

    const stats = { found: 0, renamed: 0, enriched: 0, linked: 0, notFound: 0, badAmoName: 0, errors: 0 };

    for (let i = 0; i < candidates.length; i++) {
      const b = candidates[i];
      if (i > 0 && i % 100 === 0) {
        console.log(`— прогресс: ${i}/${candidates.length} —`);
      }
      try {
        let contact = await amo.findContactByPhone(b.phone);
        if (!contact) {
          stats.notFound++;
          await sleep(250);
          continue;
        }
        stats.found++;
        if (!contact.custom_fields_values) {
          contact = (await amo.getContact(contact.id)) || contact;
          await sleep(250);
        }

        const patch = {};
        if (isGoodCandidate(contact.name)) {
          patch.fullName = String(contact.name).trim();
        } else {
          stats.badAmoName++;
        }

        const email = cfValue(contact, AMO_CONTACT_FIELDS.EMAIL);
        const tg = cfValue(contact, AMO_CONTACT_FIELDS.TELEGRAM_USERNAME);
        const wa = cfValue(contact, AMO_CONTACT_FIELDS.WHATSAPP_USERNAME);
        const position = cfValue(contact, AMO_CONTACT_FIELDS.POSITION);
        if (!b.email && email) patch.email = email;
        if (!b.telegram_username && tg) patch.telegramUsername = tg;
        if (!b.whatsapp_username && wa) patch.whatsappUsername = wa;
        if (!b.position && position) patch.position = position;

        if (!b.amo_contact_id) {
          const taken = await prisma.broker.findUnique({
            where: { amoContactId: BigInt(contact.id) },
            select: { id: true },
          });
          if (!taken) patch.amoContactId = BigInt(contact.id);
        }

        if (Object.keys(patch).length === 0) {
          await sleep(250);
          continue;
        }

        const summary = Object.entries(patch)
          .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
          .join(', ');
        console.log(`${b.phone}  "${String(b.full_name).slice(0, 20)}" → ${summary}`);

        if (APPLY) {
          await prisma.broker.update({ where: { id: b.id }, data: patch });
        }
        if (patch.fullName) stats.renamed++;
        if (patch.email || patch.telegramUsername || patch.whatsappUsername || patch.position) stats.enriched++;
        if (patch.amoContactId) stats.linked++;
      } catch (e) {
        stats.errors++;
        console.error(`ERROR ${b.phone}: ${e?.message || e}`);
      }
      await sleep(250);
    }

    console.log('───────────────────────────────────');
    console.log('ИТОГО:');
    console.log(`  найдено в amo:        ${stats.found}`);
    console.log(`  не найдено в amo:     ${stats.notFound}`);
    console.log(`  имя исправлено:       ${stats.renamed}${APPLY ? '' : ' (dry-run)'}`);
    console.log(`  имя в amo тоже плохое: ${stats.badAmoName}`);
    console.log(`  контакты обогащены:   ${stats.enriched}${APPLY ? '' : ' (dry-run)'}`);
    console.log(`  связано с amo (id):   ${stats.linked}${APPLY ? '' : ' (dry-run)'}`);
    console.log(`  ошибок:               ${stats.errors}`);
  } finally {
    await prisma.$disconnect();
    await app.close();
  }
})().catch((e) => {
  console.error('Fatal:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
