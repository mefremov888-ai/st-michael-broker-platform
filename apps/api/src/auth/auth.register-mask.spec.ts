import { maskEmail, maskPersonName } from "./auth.service";

describe("register: маскирование в ответе «номер занят»", () => {
  it("maskPersonName", () => {
    expect(maskPersonName("Кравченко Наталья Владимировна")).toBe("Кравченко Н. В.");
    expect(maskPersonName("Иванов")).toBe("Иванов");
    expect(maskPersonName("")).toBe("без имени");
  });
  it("maskEmail", () => {
    expect(maskEmail("kravchenko@mail.ru")).toBe("k***o@mail.ru");
    expect(maskEmail("ab@x.ru")).toBe("a***@x.ru");
    expect(maskEmail(null)).toBeNull();
  });
});
