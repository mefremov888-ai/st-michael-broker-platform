/**
 * 2026-09-07: правило «тестовый клиент» — общее для чистки
 * (scripts/cleanup-test-clients.js) и для синка amo → кабинет.
 *
 * Зачем в синке: 07.09 чистка удалила 108 тестовых клиентов, а к вечеру
 * синк amo → кабинет (scheduler + syncMyDealsAndClients) создал 61 из них
 * заново — тестовые лиды по-прежнему живут в amo. Пока их не удалят руками в
 * amo, синк такие лиды пропускает (со счётчиком в логе), в кабинет они
 * не попадают.
 *
 * Правила (клиент тестовый, если выполняется ЛЮБОЕ) — синхронно со скриптом:
 *   (a) в имени отдельное слово «тест»/«test» (допускаются цифры сразу после
 *       слова: «Тест47», «тест1»; «Протестировать» и фамилия «Тестов» не ловятся);
 *   (b) телефон ~ ^\+7999(9999|1234|1235|1236);
 *   (c) имя точно из списка: DDD, НДЗ, те, 2 1, Тест звонок.
 * Исключение — safelist телефонов реальных клиентов.
 */
export const TEST_CLIENT_WORD_RE =
  /(^|[^а-яёa-z])(тест|test)\d*([^а-яёa-z0-9]|$)/i;
export const TEST_CLIENT_PHONE_RE = /^\+7999(9999|1234|1235|1236)/;
export const TEST_CLIENT_EXACT_NAMES = new Set([
  "DDD",
  "НДЗ",
  "те",
  "2 1",
  "Тест звонок",
]);
/** Реальные клиенты, которых никогда не считаем тестовыми (страховка). */
export const TEST_CLIENT_SAFE_PHONES = new Set(["+79261997991"]);

export type TestClientRule = "name-word" | "phone" | "exact-name";

export function testClientRule(client: {
  fullName?: string | null;
  phone?: string | null;
}): TestClientRule | null {
  const name = String(client.fullName || "").trim();
  const phone = String(client.phone || "").trim();
  if (TEST_CLIENT_SAFE_PHONES.has(phone)) return null;
  if (TEST_CLIENT_EXACT_NAMES.has(name)) return "exact-name";
  if (TEST_CLIENT_WORD_RE.test(name)) return "name-word";
  if (TEST_CLIENT_PHONE_RE.test(phone)) return "phone";
  return null;
}

export function isTestClient(client: {
  fullName?: string | null;
  phone?: string | null;
}): boolean {
  return testClientRule(client) !== null;
}
