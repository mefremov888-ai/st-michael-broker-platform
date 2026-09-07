#!/usr/bin/env node
/**
 * 2026-09-07: локальный тест правил cleanup-test-clients.js (без БД).
 * Запуск: node scripts/cleanup-test-clients.test.js
 * Главная проверка: реальные клиенты («Ксения Цепляева», «Ашот»,
 * «Юрий Вадимович», «Тестов Иван»…) правилами НЕ ловятся.
 */
const { testClientRule } = require("./cleanup-test-clients.js");

const cases = [
  // ─── тестовые: должны ловиться ───
  { fullName: "test 44 Михаил", phone: "+79161112233", expect: true },
  { fullName: "Михаил Тест47", phone: "+79161112234", expect: true },
  { fullName: "мих тест63", phone: "+79161112235", expect: true },
  { fullName: "тест1 тест", phone: "+79161112236", expect: true },
  { fullName: "DDD", phone: "+79161112237", expect: true },
  { fullName: "НДЗ", phone: "+79161112238", expect: true },
  { fullName: "те", phone: "+79161112239", expect: true },
  { fullName: "2 1", phone: "+79161112240", expect: true },
  { fullName: "Тест звонок", phone: "+79161112241", expect: true },
  { fullName: "Иван Иванов", phone: "+79991234444", expect: true }, // серия 1234
  { fullName: "Пётр Петров", phone: "+79999999911", expect: true }, // серия 9999
  { fullName: "Сидор", phone: "+79991235001", expect: true }, // серия 1235
  { fullName: "ТЕСТ", phone: "+79161112242", expect: true }, // слово тест капсом
  // ─── реальные: НЕ должны ловиться ───
  { fullName: "Ксения Цепляева", phone: "+79261997991", expect: false },
  { fullName: "Ашот", phone: "+79161112243", expect: false },
  { fullName: "Юрий Вадимович", phone: "+79161112244", expect: false },
  { fullName: "Тестов Иван", phone: "+79161112245", expect: false }, // фамилия — не слово «тест»
  { fullName: "Протестировать заявку", phone: "+79161112246", expect: false },
  { fullName: "Мария Контестова", phone: "+79161112247", expect: false },
  { fullName: "Анна", phone: "+79990000001", expect: false }, // +7999, но не тестовая серия
];

let failed = 0;
for (const c of cases) {
  const rule = testClientRule(c);
  const got = rule !== null;
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(
    `${ok ? "OK  " : "FAIL"} «${c.fullName}» ${c.phone} → ` +
      `${got ? `кандидат (${rule})` : "не кандидат"}${ok ? "" : `, ожидалось: ${c.expect ? "кандидат" : "не кандидат"}`}`,
  );
}
console.log(`\n${cases.length - failed}/${cases.length} проверок прошло`);
if (failed > 0) process.exit(1);
