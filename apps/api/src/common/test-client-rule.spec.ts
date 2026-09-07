import { isTestClient, testClientRule } from "./test-client-rule";

describe("test-client-rule (общее правило чистки и синка amo → кабинет)", () => {
  it("ловит слово «тест»/«test», тестовые телефоны и точные имена-мусор", () => {
    expect(testClientRule({ fullName: "Михаил Тест47", phone: "+79161234567" })).toBe("name-word");
    expect(testClientRule({ fullName: "test 44 Михаил", phone: "+79161234567" })).toBe("name-word");
    expect(testClientRule({ fullName: "Иванов Иван", phone: "+79991234567" })).toBe("phone");
    expect(testClientRule({ fullName: "Иванов Иван", phone: "+79999999912" })).toBe("phone");
    expect(testClientRule({ fullName: "2 1", phone: "+79161112233" })).toBe("exact-name");
    expect(testClientRule({ fullName: "Тест звонок", phone: "+79060617800" })).toBe("exact-name");
  });

  it("не ловит реальные имена и safelist", () => {
    expect(isTestClient({ fullName: "Тестов Иван", phone: "+79161234567" })).toBe(false);
    expect(isTestClient({ fullName: "Протестировать", phone: "+79161234567" })).toBe(false);
    expect(isTestClient({ fullName: "Иванов Иван", phone: "+79161234567" })).toBe(false);
    expect(isTestClient({ fullName: "тест тест", phone: "+79261997991" })).toBe(false);
    expect(isTestClient({ fullName: null, phone: null })).toBe(false);
  });
});
