#!/usr/bin/env node
/**
 * 2026-09-07: backfill встреч кабинета из amoCRM — три независимых слоя.
 *
 * Контекст: фильтр «Есть встречи» в базе лояльности видит только
 * CONFIRMED/COMPLETED, а большинство строк meetings — вечный PENDING:
 * статус-синк смотрит только свежие лиды, исторические встречи из amo
 * в кабинет никогда не импортировались. Требование владельца: встречи,
 * по которым статус вернуть НЕ удалось, должны быть ЯВНО видны
 * («статус не подтверждён — нет ответа из amo»), а не сливаться с
 * обычным «ожидает».
 *
 * Слои (env LAYER=status|history|mark, каждый со своим dry-run):
 *
 *   LAYER=status  — дотянуть статусы существующих PENDING-встреч:
 *     по клиентскому amo_lead_id сходить в amo (GET /leads/{id},
 *     пауза ~280мс между запросами), по статусу лида решить
 *     COMPLETED/CANCELLED (mapMeetingStatus + правило «воронка КЦ
 *     7600542, статус 142 = встреча состоялась» — подтверждено
 *     владельцем). Лид найден, но вывод неоднозначен → оставить
 *     PENDING + пометка в comment «[amo:статус не подтверждён]»
 *     (только для встреч с датой в прошлом — будущий PENDING легитимен).
 *     Лид 404/удалён → пометка «[amo:лид удалён]».
 *
 *   LAYER=history — импорт исторических встреч: лиды воронки КЦ
 *     7600542 в статусе 142 (закрытые успешные), контакт которых
 *     мэтчится по телефону на clients.phone → создать Meeting
 *     status=COMPLETED (дедуп по (client_id, дата::date)).
 *     Мэтч только на brokers.phone (без клиента) здесь по-прежнему НЕ
 *     создаёт встречу — эти лиды забирает LAYER=history_brokers (ниже),
 *     появившийся после миграции client_id → nullable. Брокер-туры из
 *     Broker.brokerTour* создаёт LAYER=tours.
 *
 *   LAYER=mark    — видимость «статус не вернулся» без похода в amo:
 *     PENDING-встречи с датой в прошлом, у клиента которых НЕТ
 *     amo_lead_id (спросить amo не о чем) → идемпотентно дополнить
 *     comment меткой «[amo:статус не подтверждён]». UI показывает по
 *     метке оранжевый бейдж (админка встреч + карточка брокера в базе
 *     лояльности). Схема НЕ меняется, миграций нет.
 *
 *   LAYER=history_brokers — 2026-09-07: встречи КЦ «с брокером». Те же
 *     лиды КЦ 7600542/142, но контакт лида — БРОКЕР (dry-run history
 *     показал: клиентский мэтч почти пуст, встречи КЦ — с брокерами).
 *     Мэтч телефона контакта на brokers.phone + broker_phones через
 *     кандидатные ключи (см. phoneKeyCandidates: добавочные «доб. NNN»
 *     и несколько номеров в одном значении ломали старый slice(-10) —
 *     одна из причин, почему первый прогон дал только 84 мэтча).
 *     Слитые (merged) брокеры резолвятся в каноничного. Требует
 *     миграции 20260907120000_meeting_client_optional (client_id NULL):
 *     создаётся Meeting broker_id=брокер, client_id=NULL,
 *     status=COMPLETED, type=BROKER_TOUR если лид говорит «тур», иначе
 *     OFFICE_VISIT; дедуп по (broker_id, дата::date, type). Dry-run
 *     печатает распределение «не смэтчился» по причинам: номера нет в
 *     базе вообще / номер у слитого merged-брокера (нерезолвится) /
 *     неразборчивый формат.
 *
 *   LAYER=tours   — 2026-09-07: брокер-туры из Broker.brokerTourDate →
 *     Meeting type=BROKER_TOUR, client_id=NULL, status=COMPLETED (дедуп
 *     тот же (broker_id, дата::date, type)). brokerTourVisited=true без
 *     даты — пропуск со счётчиком no_tour_date_skipped.
 *
 * Боевой режим: DRY_RUN=0 (workflow apply-meetings-backfill.yml требует
 * dry_run=false И confirm_apply=true). Любое другое значение — dry-run.
 *
 * Доступ к amo — SystemSetting-токены + refresh-hook БЕЗ NestFactory
 * (тот же приём, что canary-amo-check.js / export-amo-deals.js).
 * Логи PII-free: только id встреч/клиентов/лидов, без ФИО и телефонов.
 *
 * Запуск в контейнере api:
 *   DRY_RUN=1 LAYER=status          node /app/scripts/backfill-meetings.js
 *   DRY_RUN=1 LAYER=history         node /app/scripts/backfill-meetings.js
 *   DRY_RUN=1 LAYER=history_brokers node /app/scripts/backfill-meetings.js
 *   DRY_RUN=1 LAYER=tours           node /app/scripts/backfill-meetings.js
 *   DRY_RUN=1 LAYER=mark            node /app/scripts/backfill-meetings.js
 */

const KC_PIPELINE_ID = 7600542;
const KC_MEETING_HELD_STATUS = 142; // «Успешно реализовано» = встреча состоялась (КЦ)
const CLOSED_LOST_STATUS = 143;

const MARK_UNCONFIRMED = '[amo:статус не подтверждён]';
const MARK_LEAD_DELETED = '[amo:лид удалён]';
const MARK_PREFIX = '[amo:';

const IMPORT_COMMENT = 'Импорт из amoCRM (КЦ, встреча состоялась)';

// Пауза между одиночными GET-запросами к amo (требование: 250–300мс).
const AMO_PAUSE_MS = 280;
const SAMPLE_LIMIT = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Чистая функция решения статуса встречи по лиду amo.
 * lead === null → лид удалён в amo (404/пустой ответ).
 * mapMeetingStatusFn — mapMeetingStatus из @st-michael/integrations
 * (передаётся параметром, чтобы функцию можно было тестировать без dist).
 */
function decideMeetingOutcome(lead, mapMeetingStatusFn) {
  if (!lead) return { outcome: 'LEAD_DELETED', reason: 'лид не найден в amo' };
  const statusId = Number(lead.status_id);
  const pipelineId = Number(lead.pipeline_id);
  if (!Number.isFinite(statusId)) {
    return { outcome: 'UNCONFIRMED', reason: 'у лида нет status_id' };
  }
  if (statusId === CLOSED_LOST_STATUS) {
    return { outcome: 'CANCELLED', reason: 'статус 143 (закрыто и не реализовано)' };
  }
  // Правило владельца: воронка КЦ + 142 = встреча точно состоялась.
  if (pipelineId === KC_PIPELINE_ID && statusId === KC_MEETING_HELD_STATUS) {
    return { outcome: 'COMPLETED', reason: 'воронка КЦ 7600542, статус 142' };
  }
  const mapped = mapMeetingStatusFn(statusId);
  if (mapped === 'COMPLETED') {
    return { outcome: 'COMPLETED', reason: `mapMeetingStatus(${statusId})` };
  }
  if (mapped === 'CANCELLED') {
    return { outcome: 'CANCELLED', reason: `mapMeetingStatus(${statusId})` };
  }
  return { outcome: 'UNCONFIRMED', reason: `статус ${statusId} не даёт однозначного вывода` };
}

/**
 * Канонический ключ телефона для мэтчинга: последние 10 цифр
 * (российские номера: +7/8 взаимозаменяемы). Меньше 10 цифр —
 * мэтчить небезопасно, возвращаем null.
 */
function normalizePhoneKey(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * 2026-09-07: кандидатные 10-значные ключи из СЫРОГО значения телефона.
 *
 * Почему не normalizePhoneKey (slice(-10)): amo хранит телефоны в
 * произвольном виде — «89161112233 доб. 45» даёт 13 цифр, и последние 10
 * («6111223345») это хвост номера + добавочный, мэтч на брокеров БД
 * (+7XXXXXXXXXX) молча промахивается. Аналогично «79161112233, 79261112233»
 * (два номера в одном значении) давал мусорный ключ. Это одна из причин,
 * почему первый history-прогон смэтчил лишь 84 лида из ~4.5к.
 *
 * Правила:
 *   - значение режем по разделителям (, ; / «или» «и») — в одном поле
 *     бывает несколько номеров;
 *   - кусок → только цифры:
 *       10 цифр                  → ключ как есть;
 *       11 цифр, первая 7 или 8  → последние 10 (код страны отброшен);
 *       >11 цифр, первая 7 или 8 → цифры 2..11 (номер идёт первым,
 *                                  добавочный приклеен в хвост);
 *       иначе                    → неразборчивый формат (badFormat).
 * Возвращает { keys: string[], badFormat: boolean }.
 */
function phoneKeyCandidates(raw) {
  const keys = new Set();
  let badFormat = false;
  // \b не работает с кириллицей — разделители «или»/«и» ловим через \s.
  const chunks = String(raw || '').split(/[,;\/]|\s(?:или|и)\s/);
  for (const chunk of chunks) {
    const digits = chunk.replace(/\D/g, '');
    if (!digits) continue;
    if (digits.length === 10) {
      keys.add(digits);
    } else if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
      keys.add(digits.slice(1));
    } else if (digits.length > 11 && (digits[0] === '7' || digits[0] === '8')) {
      keys.add(digits.slice(1, 11));
    } else {
      badFormat = true;
    }
  }
  return { keys: [...keys], badFormat };
}

/**
 * Тип встречи «КЦ ↔ брокер»: лид говорит «тур» (поле «Встреча» или
 * название лида, там живёт бренд «Брокер-тур») → BROKER_TOUR, иначе
 * OFFICE_VISIT. Слово «брокер» само по себе тут НЕ признак тура — в этом
 * слое ВСЕ встречи с брокерами (ср. leadMeetingType, где «брокер»
 * означал брокер-тур в клиентских лидах).
 */
function brokerLeadMeetingType(lead) {
  const text = `${leadCustomField(lead, 'Встреча') || ''} ${lead?.name || ''}`.toLowerCase();
  if (text.includes('тур') || text.includes('tour')) return 'BROKER_TOUR';
  return 'OFFICE_VISIT';
}

/**
 * Идемпотентное добавление amo-метки в comment встречи.
 * Возвращает новый comment или null, если какая-либо amo-метка уже стоит
 * (не дублируем и не переписываем).
 */
function appendAmoMark(comment, mark) {
  const current = comment || '';
  if (current.includes(MARK_PREFIX)) return null;
  return current ? `${current}\n${mark}` : mark;
}

/** Значение кастом-поля лида по имени (как в amocrm.service/scheduler). */
function leadCustomField(lead, fieldName) {
  const fields = lead?.custom_fields_values || [];
  const field = fields.find((f) => f.field_name === fieldName);
  return field?.values?.[0]?.value ?? null;
}

/** Дата встречи лида: поле «Дата и время встречи» → closed_at → created_at. */
function leadMeetingDate(lead) {
  const raw = leadCustomField(lead, 'Дата и время встречи');
  for (const candidate of [raw, lead?.closed_at, lead?.created_at]) {
    const num = Number(candidate);
    if (Number.isFinite(num) && num > 0) {
      const date = new Date(num * 1000);
      if (!isNaN(date.getTime())) return date;
    }
  }
  return null;
}

/** Тип встречи из поля «Встреча» (как amocrm.service.mapMeetingType). */
function leadMeetingType(lead) {
  const v = String(leadCustomField(lead, 'Встреча') || '').toLowerCase();
  if (v.includes('онлайн') || v.includes('online') || v.includes('zoom')) return 'ONLINE';
  if (v.includes('тур') || v.includes('брокер')) return 'BROKER_TOUR';
  return 'OFFICE_VISIT';
}

/** Ключ дня yyyy-mm-dd (UTC) для дедупа по (client_id, date::date). */
function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

module.exports = {
  decideMeetingOutcome,
  normalizePhoneKey,
  phoneKeyCandidates,
  brokerLeadMeetingType,
  appendAmoMark,
  leadMeetingDate,
  leadMeetingType,
  dayKey,
  KC_PIPELINE_ID,
  KC_MEETING_HELD_STATUS,
  MARK_UNCONFIRMED,
  MARK_LEAD_DELETED,
};

// ─────────────────────────────────────────────────────────────────────────────

function printCounters(title, counters) {
  console.log(`=== ${title} ===`);
  for (const [key, value] of Object.entries(counters)) {
    console.log(`  ${key}: ${value}`);
  }
}

function pushSample(samples, key, entry) {
  if (!samples[key]) samples[key] = [];
  if (samples[key].length < SAMPLE_LIMIT) samples[key].push(entry);
}

function printSamples(samples) {
  for (const [key, list] of Object.entries(samples)) {
    if (!list.length) continue;
    console.log(`  примеры ${key}:`);
    for (const entry of list) console.log(`    ${entry}`);
  }
}

async function initAmo(prisma, updatedBy) {
  const {
    AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook,
  } = require('/app/packages/integrations/dist/amo-crm.adapter');
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
    for (const [key, value] of [
      ['AMO_ACCESS_TOKEN', tokens.access],
      ['AMO_REFRESH_TOKEN', tokens.refresh],
    ]) {
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value, updatedBy },
        create: { key, value, updatedBy },
      });
    }
    console.error('amo tokens refreshed and persisted');
  });
  return new AmoCrmAdapter();
}

/** GET /leads/{id}: { lead } | { deleted: true } | { error: message }. */
async function fetchLead(amo, leadId) {
  try {
    const lead = await amo['request'](`/leads/${leadId}?with=contacts`);
    // 204 No Content → null: сущности нет.
    if (!lead) return { deleted: true };
    return { lead };
  } catch (e) {
    const message = e?.message || String(e);
    if (/amoCRM 404 /.test(message)) return { deleted: true };
    return { error: message };
  }
}

// ─── LAYER=status ────────────────────────────────────────────────────────────

async function runStatusLayer(prisma, dryRun) {
  const { mapMeetingStatus } = require('/app/packages/integrations/dist/amo-crm.fields');
  const amo = await initAmo(prisma, 'backfill-meetings');
  const now = new Date();

  const meetings = await prisma.meeting.findMany({
    where: { status: 'PENDING' },
    select: {
      id: true,
      date: true,
      comment: true,
      client: { select: { id: true, amoLeadId: true } },
    },
    orderBy: { date: 'asc' },
  });

  const counters = {
    pending_total: meetings.length,
    no_amo_lead: 0,
    already_marked: 0,
    to_completed: 0,
    to_cancelled: 0,
    unconfirmed_marked: 0,
    unconfirmed_future_left: 0,
    lead_deleted_marked: 0,
    fetch_errors: 0,
  };
  const samples = {};
  const leadCache = new Map();

  for (const meeting of meetings) {
    const amoLeadId = meeting.client?.amoLeadId;
    if (!amoLeadId) {
      counters.no_amo_lead++;
      continue; // обрабатывает LAYER=mark
    }
    const leadKey = String(amoLeadId);
    if (!leadCache.has(leadKey)) {
      leadCache.set(leadKey, await fetchLead(amo, leadKey));
      await sleep(AMO_PAUSE_MS);
    }
    const fetched = leadCache.get(leadKey);
    if (fetched.error) {
      counters.fetch_errors++;
      pushSample(samples, 'fetch_errors', `meeting=${meeting.id} lead=${leadKey}: ${fetched.error}`);
      continue;
    }
    const decision = decideMeetingOutcome(fetched.deleted ? null : fetched.lead, mapMeetingStatus);
    const line = `meeting=${meeting.id} lead=${leadKey} date=${dayKey(meeting.date)} → ${decision.outcome} (${decision.reason})`;

    if (decision.outcome === 'COMPLETED' || decision.outcome === 'CANCELLED') {
      const key = decision.outcome === 'COMPLETED' ? 'to_completed' : 'to_cancelled';
      counters[key]++;
      pushSample(samples, key, line);
      if (!dryRun) {
        await prisma.meeting.update({
          where: { id: meeting.id },
          data: { status: decision.outcome },
        });
      }
      continue;
    }

    if (decision.outcome === 'LEAD_DELETED') {
      const nextComment = appendAmoMark(meeting.comment, MARK_LEAD_DELETED);
      if (nextComment === null) {
        counters.already_marked++;
        continue;
      }
      counters.lead_deleted_marked++;
      pushSample(samples, 'lead_deleted_marked', line);
      if (!dryRun) {
        await prisma.meeting.update({
          where: { id: meeting.id },
          data: { comment: nextComment },
        });
      }
      continue;
    }

    // UNCONFIRMED: метка только для встреч с датой в прошлом —
    // будущий PENDING легитимно «ожидает».
    if (meeting.date >= now) {
      counters.unconfirmed_future_left++;
      continue;
    }
    const nextComment = appendAmoMark(meeting.comment, MARK_UNCONFIRMED);
    if (nextComment === null) {
      counters.already_marked++;
      continue;
    }
    counters.unconfirmed_marked++;
    pushSample(samples, 'unconfirmed_marked', line);
    if (!dryRun) {
      await prisma.meeting.update({
        where: { id: meeting.id },
        data: { comment: nextComment },
      });
    }
  }

  printCounters(`LAYER=status (${dryRun ? 'DRY-RUN' : 'APPLY'})`, counters);
  printSamples(samples);
}

// ─── LAYER=history ───────────────────────────────────────────────────────────

/**
 * Лиды воронки КЦ со статусом 142 («встреча состоялась»). Пагинация по 250,
 * counters.kc_leads_scanned / counters.kc_success_142 инкрементируются.
 */
async function fetchKcSuccessLeads(amo, counters) {
  const successLeads = [];
  let page = 1;
  for (;;) {
    let res;
    try {
      res = await amo['request'](
        `/leads?filter[pipeline_id]=${KC_PIPELINE_ID}&page=${page}&limit=250&with=contacts`,
      );
    } catch (e) {
      console.error(`leads page=${page}: ${e?.message || e} — стоп пагинации.`);
      break;
    }
    const list = res?._embedded?.leads || [];
    if (list.length === 0) break;
    for (const lead of list) {
      counters.kc_leads_scanned++;
      if (Number(lead.status_id) === KC_MEETING_HELD_STATUS) {
        counters.kc_success_142++;
        successLeads.push(lead);
      }
    }
    if (!res?._links?.next) break;
    page++;
    await sleep(AMO_PAUSE_MS);
  }
  return successLeads;
}

/** id основного контакта по каждому лиду; лиды без контакта → counters.without_contact. */
function mainContactIdByLead(successLeads, counters) {
  const contactIdByLead = new Map();
  for (const lead of successLeads) {
    const contacts = lead?._embedded?.contacts || [];
    const main = contacts.find((c) => c.is_main) || contacts[0];
    if (!main?.id) {
      counters.without_contact++;
      continue;
    }
    contactIdByLead.set(lead.id, Number(main.id));
  }
  return contactIdByLead;
}

const AMO_PHONE_FIELD_ID = 557903;

/** Кандидатные ключи телефонов контакта amo + флаг неразборчивого формата. */
function contactPhoneCandidates(contact) {
  const keys = new Set();
  let badFormat = false;
  for (const field of contact?.custom_fields_values || []) {
    const isPhone =
      field.field_id === AMO_PHONE_FIELD_ID || field.field_code === 'PHONE';
    if (!isPhone) continue;
    for (const v of field.values || []) {
      const parsed = phoneKeyCandidates(v?.value);
      for (const key of parsed.keys) keys.add(key);
      if (parsed.badFormat) badFormat = true;
    }
  }
  return { keys: [...keys], badFormat };
}

async function runHistoryLayer(prisma, dryRun) {
  const amo = await initAmo(prisma, 'backfill-meetings');

  const counters = {
    kc_leads_scanned: 0,
    kc_success_142: 0,
    without_contact: 0,
    contact_not_fetched: 0,
    contact_without_phone: 0,
    matched_client: 0,
    matched_broker_only_skipped: 0,
    unmatched_phone: 0,
    ambiguous_client_skipped: 0,
    no_meeting_date: 0,
    dedup_existing: 0,
    to_create: 0,
    created: 0,
    broker_tours_candidates_not_created: 0,
  };
  const samples = {};

  // 1. Лиды воронки КЦ со статусом 142 (закрытые успешные).
  const successLeads = await fetchKcSuccessLeads(amo, counters);

  // 2. Контакты этих лидов (телефоны) — пачками по 250.
  const contactIdByLead = mainContactIdByLead(successLeads, counters);
  const contactMap = await amo.getContactsByIds([...new Set(contactIdByLead.values())]);

  const contactPhoneKeys = (contact) => {
    const keys = new Set();
    for (const field of contact?.custom_fields_values || []) {
      const isPhone =
        field.field_id === AMO_PHONE_FIELD_ID || field.field_code === 'PHONE';
      if (!isPhone) continue;
      for (const v of field.values || []) {
        const key = normalizePhoneKey(v?.value);
        if (key) keys.add(key);
      }
    }
    return [...keys];
  };

  // 3. Телефонные индексы кабинета.
  const clients = await prisma.client.findMany({
    select: { id: true, phone: true, brokerId: true, amoLeadId: true, createdAt: true },
  });
  const clientsByPhone = new Map();
  for (const client of clients) {
    const key = normalizePhoneKey(client.phone);
    if (!key) continue;
    if (!clientsByPhone.has(key)) clientsByPhone.set(key, []);
    clientsByPhone.get(key).push(client);
  }
  const brokers = await prisma.broker.findMany({
    where: { mergedIntoId: null },
    select: { id: true, phone: true, phones: { select: { phone: true } } },
  });
  const brokerIdsByPhone = new Map();
  for (const broker of brokers) {
    for (const raw of [broker.phone, ...broker.phones.map((p) => p.phone)]) {
      const key = normalizePhoneKey(raw);
      if (!key) continue;
      if (!brokerIdsByPhone.has(key)) brokerIdsByPhone.set(key, new Set());
      brokerIdsByPhone.get(key).add(broker.id);
    }
  }

  // 4. Мэтчинг и план создания.
  const plan = [];
  for (const lead of successLeads) {
    const contactId = contactIdByLead.get(lead.id);
    if (!contactId) continue; // уже посчитан как without_contact
    const contact = contactMap.get(contactId);
    if (!contact) {
      counters.contact_not_fetched++;
      continue;
    }
    const phoneKeys = contactPhoneKeys(contact);
    if (!phoneKeys.length) {
      counters.contact_without_phone++;
      continue;
    }
    const clientCandidates = [];
    for (const key of phoneKeys) {
      for (const client of clientsByPhone.get(key) || []) {
        if (!clientCandidates.some((c) => c.id === client.id)) clientCandidates.push(client);
      }
    }
    let client = null;
    if (clientCandidates.length === 1) {
      client = clientCandidates[0];
    } else if (clientCandidates.length > 1) {
      client =
        clientCandidates.find((c) => c.amoLeadId && String(c.amoLeadId) === String(lead.id)) || null;
      if (!client) {
        counters.ambiguous_client_skipped++;
        pushSample(samples, 'ambiguous_client_skipped', `lead=${lead.id} кандидатов=${clientCandidates.length}`);
        continue;
      }
    }
    if (!client) {
      const brokerOnly = phoneKeys.some((key) => brokerIdsByPhone.has(key));
      if (brokerOnly) {
        // Встречу «КЦ ↔ брокер» без клиента создаёт LAYER=history_brokers
        // (после миграции client_id → nullable) — здесь только считаем.
        counters.matched_broker_only_skipped++;
        pushSample(samples, 'matched_broker_only_skipped', `lead=${lead.id}`);
      } else {
        counters.unmatched_phone++;
      }
      continue;
    }
    counters.matched_client++;
    const date = leadMeetingDate(lead);
    if (!date) {
      counters.no_meeting_date++;
      pushSample(samples, 'no_meeting_date', `lead=${lead.id} client=${client.id}`);
      continue;
    }
    plan.push({ lead, client, date, type: leadMeetingType(lead) });
  }

  // 5. Дедуп по (client_id, дата::date) против существующих встреч.
  const planClientIds = [...new Set(plan.map((p) => p.client.id))];
  const existingDays = new Set();
  const BATCH = 500;
  for (let i = 0; i < planClientIds.length; i += BATCH) {
    const rows = await prisma.meeting.findMany({
      where: { clientId: { in: planClientIds.slice(i, i + BATCH) } },
      select: { clientId: true, date: true },
    });
    for (const row of rows) existingDays.add(`${row.clientId}:${dayKey(row.date)}`);
  }

  const monthCounts = new Map();
  const toCreate = [];
  for (const item of plan) {
    const dedupKey = `${item.client.id}:${dayKey(item.date)}`;
    if (existingDays.has(dedupKey)) {
      counters.dedup_existing++;
      continue;
    }
    existingDays.add(dedupKey); // два 142-лида на один день клиента → одна встреча
    toCreate.push(item);
    const mk = monthKey(item.date);
    monthCounts.set(mk, (monthCounts.get(mk) || 0) + 1);
  }
  counters.to_create = toCreate.length;

  if (!dryRun) {
    for (const item of toCreate) {
      await prisma.meeting.create({
        data: {
          clientId: item.client.id,
          brokerId: item.client.brokerId,
          type: item.type,
          date: item.date,
          status: 'COMPLETED',
          comment: IMPORT_COMMENT,
        },
      });
      counters.created++;
    }
  }

  // 6. Брокер-туры: создаёт LAYER=tours (после миграции client_id →
  // nullable) — здесь по-прежнему только считаем кандидатов для сверки.
  counters.broker_tours_candidates_not_created = await prisma.broker.count({
    where: {
      mergedIntoId: null,
      OR: [{ brokerTourVisited: true }, { brokerTourDate: { not: null } }],
    },
  });

  printCounters(`LAYER=history (${dryRun ? 'DRY-RUN' : 'APPLY'})`, counters);
  const months = [...monthCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('  топ-месяцы создаваемых встреч:');
  for (const [mk, count] of months) console.log(`    ${mk}: ${count}`);
  printSamples(samples);
  for (const item of toCreate.slice(0, SAMPLE_LIMIT)) {
    console.log(`  пример to_create: lead=${item.lead.id} client=${item.client.id} date=${dayKey(item.date)} type=${item.type}`);
  }
}

// ─── LAYER=history_brokers ───────────────────────────────────────────────────

const IMPORT_COMMENT_BROKER = 'Импорт из amoCRM (КЦ, встреча с брокером)';
const IMPORT_COMMENT_TOUR = 'Импорт из amoCRM (брокер-тур)';

/**
 * Дедуп-ключ встречи «с брокером»: (broker_id, дата::date, type).
 */
function brokerDedupKey(brokerId, date, type) {
  return `${brokerId}:${dayKey(date)}:${type}`;
}

/**
 * Индексы телефонов брокеров: активные и слитые (merged) отдельно.
 * merged-брокеры резолвятся в каноничного по цепочке mergedIntoId
 * (защита от циклов); нерезолвящиеся дают null в mergedByKey.
 */
async function buildBrokerPhoneIndexes(prisma) {
  const brokers = await prisma.broker.findMany({
    select: {
      id: true,
      phone: true,
      mergedIntoId: true,
      phones: { select: { phone: true } },
    },
  });
  const byId = new Map(brokers.map((b) => [b.id, b]));
  const resolveCanonical = (id) => {
    let cur = byId.get(id);
    const seen = new Set();
    while (cur && cur.mergedIntoId) {
      if (seen.has(cur.id)) return null; // цикл в цепочке слияний
      seen.add(cur.id);
      cur = byId.get(cur.mergedIntoId);
    }
    return cur && !cur.mergedIntoId ? cur.id : null;
  };
  const activeByKey = new Map(); // ключ → Set(brokerId), только не-слитые
  const mergedByKey = new Map(); // ключ → Set(canonicalId | null)
  for (const broker of brokers) {
    for (const raw of [broker.phone, ...broker.phones.map((p) => p.phone)]) {
      for (const key of phoneKeyCandidates(raw).keys) {
        if (broker.mergedIntoId === null) {
          if (!activeByKey.has(key)) activeByKey.set(key, new Set());
          activeByKey.get(key).add(broker.id);
        } else {
          if (!mergedByKey.has(key)) mergedByKey.set(key, new Set());
          mergedByKey.get(key).add(resolveCanonical(broker.id));
        }
      }
    }
  }
  return { activeByKey, mergedByKey };
}

async function runHistoryBrokersLayer(prisma, dryRun) {
  const amo = await initAmo(prisma, 'backfill-meetings');

  const counters = {
    kc_leads_scanned: 0,
    kc_success_142: 0,
    without_contact: 0,
    contact_not_fetched: 0,
    contact_without_phone: 0,
    client_matched_skipped: 0, // территория LAYER=history — не дублируем
    matched_broker: 0,
    matched_via_merged: 0,
    ambiguous_broker_skipped: 0,
    unmatched_phone_not_in_db: 0, // номера нет ни у кого в базе
    unmatched_merged_unresolved: 0, // номер у merged-брокера, каноничный не резолвится
    unmatched_bad_format: 0, // из значения не извлечь ни одного 10-значного ключа
    no_meeting_date: 0,
    dedup_existing: 0,
    to_create: 0,
    created: 0,
  };
  const samples = {};

  // 1. Те же лиды КЦ 142, что и в LAYER=history.
  const successLeads = await fetchKcSuccessLeads(amo, counters);
  const contactIdByLead = mainContactIdByLead(successLeads, counters);
  const contactMap = await amo.getContactsByIds([...new Set(contactIdByLead.values())]);

  // 2. Индексы телефонов: клиенты (чтобы не дублировать LAYER=history) и брокеры.
  const clients = await prisma.client.findMany({
    select: { id: true, phone: true },
  });
  const clientKeys = new Set();
  for (const client of clients) {
    for (const key of phoneKeyCandidates(client.phone).keys) clientKeys.add(key);
  }
  const { activeByKey, mergedByKey } = await buildBrokerPhoneIndexes(prisma);

  // 3. Мэтчинг.
  const plan = [];
  for (const lead of successLeads) {
    const contactId = contactIdByLead.get(lead.id);
    if (!contactId) continue; // уже посчитан как without_contact
    const contact = contactMap.get(contactId);
    if (!contact) {
      counters.contact_not_fetched++;
      continue;
    }
    const { keys: phoneKeys, badFormat } = contactPhoneCandidates(contact);
    if (!phoneKeys.length) {
      if (badFormat) {
        counters.unmatched_bad_format++;
        pushSample(samples, 'unmatched_bad_format', `lead=${lead.id} contact=${contactId}`);
      } else {
        counters.contact_without_phone++;
      }
      continue;
    }
    // Контакт мэтчится на клиента → встречу с клиентом делает LAYER=history.
    if (phoneKeys.some((key) => clientKeys.has(key))) {
      counters.client_matched_skipped++;
      continue;
    }
    const activeIds = new Set();
    for (const key of phoneKeys) {
      for (const id of activeByKey.get(key) || []) activeIds.add(id);
    }
    let brokerId = null;
    let viaMerged = false;
    if (activeIds.size === 1) {
      brokerId = [...activeIds][0];
    } else if (activeIds.size > 1) {
      counters.ambiguous_broker_skipped++;
      pushSample(samples, 'ambiguous_broker_skipped', `lead=${lead.id} кандидатов=${activeIds.size}`);
      continue;
    } else {
      // Номер только у слитых брокеров → резолвим в каноничного.
      const canonicals = new Set();
      let sawMerged = false;
      for (const key of phoneKeys) {
        for (const id of mergedByKey.get(key) || []) {
          sawMerged = true;
          if (id) canonicals.add(id);
        }
      }
      if (canonicals.size === 1) {
        brokerId = [...canonicals][0];
        viaMerged = true;
      } else if (canonicals.size > 1) {
        counters.ambiguous_broker_skipped++;
        pushSample(samples, 'ambiguous_broker_skipped', `lead=${lead.id} merged-кандидатов=${canonicals.size}`);
        continue;
      } else if (sawMerged) {
        counters.unmatched_merged_unresolved++;
        pushSample(samples, 'unmatched_merged_unresolved', `lead=${lead.id}`);
        continue;
      } else {
        counters.unmatched_phone_not_in_db++;
        continue;
      }
    }
    counters[viaMerged ? 'matched_via_merged' : 'matched_broker']++;
    const date = leadMeetingDate(lead);
    if (!date) {
      counters.no_meeting_date++;
      pushSample(samples, 'no_meeting_date', `lead=${lead.id} broker=${brokerId}`);
      continue;
    }
    plan.push({ lead, brokerId, date, type: brokerLeadMeetingType(lead) });
  }

  // 4. Дедуп по (broker_id, дата::date, type) против существующих встреч.
  const planBrokerIds = [...new Set(plan.map((p) => p.brokerId))];
  const existingKeys = new Set();
  const BATCH = 500;
  for (let i = 0; i < planBrokerIds.length; i += BATCH) {
    const rows = await prisma.meeting.findMany({
      where: { brokerId: { in: planBrokerIds.slice(i, i + BATCH) } },
      select: { brokerId: true, date: true, type: true },
    });
    for (const row of rows) {
      existingKeys.add(brokerDedupKey(row.brokerId, row.date, row.type));
    }
  }

  const monthCounts = new Map();
  const toCreate = [];
  for (const item of plan) {
    const dedupKey = brokerDedupKey(item.brokerId, item.date, item.type);
    if (existingKeys.has(dedupKey)) {
      counters.dedup_existing++;
      continue;
    }
    existingKeys.add(dedupKey); // два 142-лида на один день брокера → одна встреча
    toCreate.push(item);
    const mk = monthKey(item.date);
    monthCounts.set(mk, (monthCounts.get(mk) || 0) + 1);
  }
  counters.to_create = toCreate.length;

  if (!dryRun) {
    for (const item of toCreate) {
      await prisma.meeting.create({
        data: {
          // clientId НЕ задаём: встреча «КЦ ↔ брокер» без клиента
          // (миграция 20260907120000_meeting_client_optional).
          brokerId: item.brokerId,
          type: item.type,
          date: item.date,
          status: 'COMPLETED',
          comment: IMPORT_COMMENT_BROKER,
        },
      });
      counters.created++;
    }
  }

  printCounters(`LAYER=history_brokers (${dryRun ? 'DRY-RUN' : 'APPLY'})`, counters);
  const unmatched =
    counters.unmatched_phone_not_in_db +
    counters.unmatched_merged_unresolved +
    counters.unmatched_bad_format;
  console.log('  распределение «не смэтчился»:');
  console.log(`    номера нет в базе вообще: ${counters.unmatched_phone_not_in_db}`);
  console.log(`    номер у слитого merged-брокера (не резолвится): ${counters.unmatched_merged_unresolved}`);
  console.log(`    неразборчивый формат телефона: ${counters.unmatched_bad_format}`);
  console.log(`    всего: ${unmatched}`);
  const months = [...monthCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('  топ-месяцы создаваемых встреч:');
  for (const [mk, count] of months) console.log(`    ${mk}: ${count}`);
  printSamples(samples);
  for (const item of toCreate.slice(0, SAMPLE_LIMIT)) {
    console.log(`  пример to_create: lead=${item.lead.id} broker=${item.brokerId} date=${dayKey(item.date)} type=${item.type}`);
  }
}

// ─── LAYER=tours ─────────────────────────────────────────────────────────────

async function runToursLayer(prisma, dryRun) {
  const counters = {
    tour_brokers_total: 0,
    no_tour_date_skipped: 0, // brokerTourVisited=true, но даты нет
    dedup_existing: 0,
    to_create: 0,
    created: 0,
  };
  const samples = {};

  const brokers = await prisma.broker.findMany({
    where: {
      mergedIntoId: null,
      OR: [{ brokerTourVisited: true }, { brokerTourDate: { not: null } }],
    },
    select: { id: true, brokerTourVisited: true, brokerTourDate: true },
  });
  counters.tour_brokers_total = brokers.length;

  const withDate = brokers.filter((b) => b.brokerTourDate);
  counters.no_tour_date_skipped = brokers.length - withDate.length;

  // Дедуп по (broker_id, дата::date, BROKER_TOUR).
  const existingKeys = new Set();
  const BATCH = 500;
  const ids = withDate.map((b) => b.id);
  for (let i = 0; i < ids.length; i += BATCH) {
    const rows = await prisma.meeting.findMany({
      where: { brokerId: { in: ids.slice(i, i + BATCH) }, type: 'BROKER_TOUR' },
      select: { brokerId: true, date: true, type: true },
    });
    for (const row of rows) {
      existingKeys.add(brokerDedupKey(row.brokerId, row.date, row.type));
    }
  }

  const toCreate = [];
  for (const broker of withDate) {
    const dedupKey = brokerDedupKey(broker.id, broker.brokerTourDate, 'BROKER_TOUR');
    if (existingKeys.has(dedupKey)) {
      counters.dedup_existing++;
      continue;
    }
    existingKeys.add(dedupKey);
    toCreate.push(broker);
  }
  counters.to_create = toCreate.length;

  if (!dryRun) {
    for (const broker of toCreate) {
      await prisma.meeting.create({
        data: {
          brokerId: broker.id,
          type: 'BROKER_TOUR',
          date: broker.brokerTourDate,
          status: 'COMPLETED',
          comment: IMPORT_COMMENT_TOUR,
        },
      });
      counters.created++;
    }
  }

  printCounters(`LAYER=tours (${dryRun ? 'DRY-RUN' : 'APPLY'})`, counters);
  for (const broker of toCreate.slice(0, SAMPLE_LIMIT)) {
    pushSample(samples, 'to_create', `broker=${broker.id} date=${dayKey(broker.brokerTourDate)}`);
  }
  printSamples(samples);
}

// ─── LAYER=mark ──────────────────────────────────────────────────────────────

async function runMarkLayer(prisma, dryRun) {
  const now = new Date();
  const meetings = await prisma.meeting.findMany({
    where: { status: 'PENDING', date: { lt: now } },
    select: {
      id: true,
      date: true,
      comment: true,
      client: { select: { amoLeadId: true } },
    },
    orderBy: { date: 'asc' },
  });

  const counters = {
    pending_past_total: meetings.length,
    has_amo_lead_skipped: 0, // их дотягивает LAYER=status
    already_marked: 0,
    to_mark: 0,
    marked: 0,
  };
  const samples = {};

  for (const meeting of meetings) {
    if (meeting.client?.amoLeadId) {
      counters.has_amo_lead_skipped++;
      continue;
    }
    const nextComment = appendAmoMark(meeting.comment, MARK_UNCONFIRMED);
    if (nextComment === null) {
      counters.already_marked++;
      continue;
    }
    counters.to_mark++;
    pushSample(samples, 'to_mark', `meeting=${meeting.id} date=${dayKey(meeting.date)}`);
    if (!dryRun) {
      await prisma.meeting.update({
        where: { id: meeting.id },
        data: { comment: nextComment },
      });
      counters.marked++;
    }
  }

  printCounters(`LAYER=mark (${dryRun ? 'DRY-RUN' : 'APPLY'})`, counters);
  printSamples(samples);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const layer = String(process.env.LAYER || '').toLowerCase();
  if (!['status', 'history', 'history_brokers', 'tours', 'mark'].includes(layer)) {
    console.error('Задайте LAYER=status|history|history_brokers|tours|mark');
    process.exit(2);
  }
  // Боевой режим ТОЛЬКО при DRY_RUN=0; всё остальное — dry-run.
  const dryRun = process.env.DRY_RUN !== '0';
  console.log(`backfill-meetings: LAYER=${layer} DRY_RUN=${dryRun ? '1' : '0'}`);

  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();
  try {
    if (layer === 'status') await runStatusLayer(prisma, dryRun);
    else if (layer === 'history') await runHistoryLayer(prisma, dryRun);
    else if (layer === 'history_brokers') await runHistoryBrokersLayer(prisma, dryRun);
    else if (layer === 'tours') await runToursLayer(prisma, dryRun);
    else await runMarkLayer(prisma, dryRun);
    console.log('=== Готово ===');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}
