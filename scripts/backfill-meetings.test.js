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
