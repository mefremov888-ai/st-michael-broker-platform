const test = require('node:test');
const assert = require('node:assert/strict');
const { isHealthyFullName, phoneKey } = require('./backfill-display-names');

test('здоровое ФИО: два и более слова буквами', () => {
  assert.equal(isHealthyFullName('Иванов Иван'), true);
  assert.equal(isHealthyFullName('Иванов Иван Иванович'), true);
  assert.equal(isHealthyFullName('Ma Li'), true); // латиница, ровно 5 символов
  assert.equal(isHealthyFullName('Салтыкова-Щедрина Анна'), true); // дефис внутри слова
  assert.equal(isHealthyFullName("O'Neil John"), true); // апостроф внутри слова
  assert.equal(isHealthyFullName('  Иванов   Иван  '), true); // лишние пробелы схлопываются
});

test('нездоровое ФИО: цифры, мусор, символы', () => {
  assert.equal(isHealthyFullName('Вася 89261234567'), false); // телефон вместо фамилии
  assert.equal(isHealthyFullName('89261234567'), false);
  assert.equal(isHealthyFullName('Вася В.'), false); // точка — не буква
  assert.equal(isHealthyFullName('@vasya_broker ник'), false);
  assert.equal(isHealthyFullName(''), false);
  assert.equal(isHealthyFullName(null), false);
});

test('нездоровое ФИО: одно слово', () => {
  assert.equal(isHealthyFullName('Мария'), false);
  assert.equal(isHealthyFullName('тест'), false);
});

test('нездоровое ФИО: стоп-слова', () => {
  assert.equal(isHealthyFullName('тест тест'), false);
  assert.equal(isHealthyFullName('Test Broker'), false); // test — стоп-слово в любом регистре
  assert.equal(isHealthyFullName('Агент Смирнов'), false);
  assert.equal(isHealthyFullName('Риелтор Москва'), false);
});

test('нездоровое ФИО: длина вне 5–60', () => {
  assert.equal(isHealthyFullName('И О'), false); // короче 5
  assert.equal(isHealthyFullName('А '.repeat(31).trim()), false); // 61 символ
});

test('phoneKey: последние 10 цифр', () => {
  assert.equal(phoneKey('+7 (926) 123-45-67'), '9261234567');
  assert.equal(phoneKey('89261234567'), '9261234567');
  assert.equal(phoneKey('79261234567'), '9261234567');
  assert.equal(phoneKey('12345'), null);
  assert.equal(phoneKey(null), null);
});
