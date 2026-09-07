#!/usr/bin/env node
/**
 * 2026-09-07: локальный тест чистых функций backfill-meetings.js (без БД/amo).
 * Запуск: node scripts/backfill-meetings.test.js
 * Главное: решение статуса встречи по лиду (правило КЦ 142, mapMeetingStatus,
 * лид удалён, неоднозначный вывод) и идемпотентность amo-меток.
 */
const {
  decideMeetingOutcome,
  normalizePhoneKey,
  phoneKeyCandidates,
  brokerLeadMeetingType,
  appendAmoMark,
  leadMeetingDate,
  leadMeetingType,
  MARK_UNCONFIRMED,
  MARK_LEAD_DELETED,
} = require('./backfill-meetings.js');

// Локальная копия семантики mapMeetingStatus (packages/integrations):
// 143 → CANCELLED, «встреча проведена и далее» → COMPLETED, иначе PENDING.
const HELD = new Set([62907430, 62907358, 62907570, 28905214, 29126935, 142]);
const mapMeetingStatusStub = (statusId) => {
  if (statusId === 143) return 'CANCELLED';
  if (HELD.has(statusId)) return 'COMPLETED';
  return 'PENDING';
};

let failed = 0;
const check = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(expect)}`);
  } else {
    console.log(`ok   ${name}`);
  }
};

// ─── decideMeetingOutcome ───
const outcome = (lead) => decideMeetingOutcome(lead, mapMeetingStatusStub).outcome;

check('лид удалён (null)', outcome(null), 'LEAD_DELETED');
check('статус 143 → CANCELLED', outcome({ pipeline_id: 7600542, status_id: 143 }), 'CANCELLED');
check('КЦ 7600542 + 142 → COMPLETED', outcome({ pipeline_id: 7600542, status_id: 142 }), 'COMPLETED');
check('142 в другой воронке → COMPLETED (mapMeetingStatus)', outcome({ pipeline_id: 7600546, status_id: 142 }), 'COMPLETED');
check('«встреча проведена» Зорге → COMPLETED', outcome({ pipeline_id: 7600546, status_id: 62907430 }), 'COMPLETED');
check('ранняя стадия → UNCONFIRMED', outcome({ pipeline_id: 7600542, status_id: 62907118 }), 'UNCONFIRMED');
check('«встреча назначена» КЦ → UNCONFIRMED', outcome({ pipeline_id: 7600542, status_id: 62907286 }), 'UNCONFIRMED');
check('лид без status_id → UNCONFIRMED', outcome({ pipeline_id: 7600542 }), 'UNCONFIRMED');

// ─── appendAmoMark (идемпотентность) ───
check('метка на пустой comment', appendAmoMark(null, MARK_UNCONFIRMED), MARK_UNCONFIRMED);
check('метка добавляется новой строкой', appendAmoMark('Клиент: X', MARK_UNCONFIRMED), `Клиент: X\n${MARK_UNCONFIRMED}`);
check('повторная метка не дублируется', appendAmoMark(`Клиент: X\n${MARK_UNCONFIRMED}`, MARK_UNCONFIRMED), null);
check('«лид удалён» не перекрывает существующую метку', appendAmoMark(MARK_UNCONFIRMED, MARK_LEAD_DELETED), null);

// ─── normalizePhoneKey ───
check('+7 и 8 дают один ключ', normalizePhoneKey('+7 (916) 111-22-33'), normalizePhoneKey('8 916 111 22 33'));
check('ключ = последние 10 цифр', normalizePhoneKey('+79161112233'), '9161112233');
check('короткий номер не мэтчится', normalizePhoneKey('12345'), null);
check('пусто → null', normalizePhoneKey(''), null);

// ─── phoneKeyCandidates (брокер-мэтч, LAYER=history_brokers) ───
// Причина 84/4500: slice(-10) на «номер + добавочный» давал мусорный ключ.
check('чистый +7 → один ключ', phoneKeyCandidates('+7 (916) 111-22-33'), { keys: ['9161112233'], badFormat: false });
check('8XXXXXXXXXX → тот же ключ', phoneKeyCandidates('8 916 111 22 33'), { keys: ['9161112233'], badFormat: false });
check('10 цифр без кода страны', phoneKeyCandidates('9161112233'), { keys: ['9161112233'], badFormat: false });
check('добавочный в хвосте НЕ ломает ключ', phoneKeyCandidates('89161112233 доб. 45'), { keys: ['9161112233'], badFormat: false });
check('два номера через запятую → два ключа', phoneKeyCandidates('79161112233, 79261112234'), { keys: ['9161112233', '9261112234'], badFormat: false });
check('два номера через « и »', phoneKeyCandidates('89161112233 и 89261112234'), { keys: ['9161112233', '9261112234'], badFormat: false });
check('короткий номер → badFormat', phoneKeyCandidates('12345'), { keys: [], badFormat: true });
check('пусто → без ключей и без badFormat', phoneKeyCandidates(''), { keys: [], badFormat: false });
check('длинный не-российский → badFormat', phoneKeyCandidates('001234567890123'), { keys: [], badFormat: true });
check('дубль одного номера в двух форматах → один ключ', phoneKeyCandidates('+79161112233; 8(916)111-22-33'), { keys: ['9161112233'], badFormat: false });

// ─── brokerLeadMeetingType ───
check('поле «Встреча» = Брокер-тур → BROKER_TOUR', brokerLeadMeetingType({ custom_fields_values: [{ field_name: 'Встреча', values: [{ value: 'Брокер-тур' }] }] }), 'BROKER_TOUR');
check('«тур» в названии лида → BROKER_TOUR', brokerLeadMeetingType({ name: 'Запись на Брокер-Тур 12.05' }), 'BROKER_TOUR');
check('слово «брокер» без «тур» → OFFICE_VISIT (в этом слое все встречи с брокерами)', brokerLeadMeetingType({ name: 'Фиксация брокера Иванова' }), 'OFFICE_VISIT');
check('пустой лид → OFFICE_VISIT', brokerLeadMeetingType({}), 'OFFICE_VISIT');

// ─── leadMeetingDate / leadMeetingType ───
const leadWithField = {
  closed_at: 1700000000,
  custom_fields_values: [
    { field_name: 'Дата и время встречи', values: [{ value: 1690000000 }] },
    { field_name: 'Встреча', values: [{ value: 'Брокер-тур' }] },
  ],
};
check('дата из поля «Дата и время встречи»', leadMeetingDate(leadWithField)?.toISOString(), new Date(1690000000 * 1000).toISOString());
check('fallback на closed_at', leadMeetingDate({ closed_at: 1700000000 })?.toISOString(), new Date(1700000000 * 1000).toISOString());
check('нет дат → null', leadMeetingDate({}), null);
check('тип «Брокер-тур» → BROKER_TOUR', leadMeetingType(leadWithField), 'BROKER_TOUR');
check('тип по умолчанию → OFFICE_VISIT', leadMeetingType({}), 'OFFICE_VISIT');

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\nВсе проверки прошли');
