import {
  SMS_MAX_CHARS,
  fixationExpiryText,
  loginCodeText,
  maskCodeInText,
  otpText,
  passwordResetCodeText,
  registerCodeText,
  shortClientName,
  shortDate,
} from "./sms-templates";

describe("sms-templates (тексты, согласованные 24.09.2026)", () => {
  const code = "482913";

  it("четыре текста укладываются в одну СМС (≤70 знаков)", () => {
    const texts = [
      loginCodeText(code),
      registerCodeText(code),
      passwordResetCodeText(code),
      fixationExpiryText("Иванов Александр Петрович", new Date("2026-10-20T09:00:00+03:00")),
    ];
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(loginCodeText(code)).toBe("Код входа в кабинет брокера: 482913. Никому не сообщайте.");
    expect(registerCodeText(code)).toBe("Код подтверждения номера: 482913. Действует 10 минут.");
    expect(passwordResetCodeText(code)).toBe("Код для смены пароля: 482913. Если это не вы — не вводите его.");
  });

  it("код с ведущими нулями не теряется", () => {
    expect(otpText("LOGIN", "000123")).toContain("000123");
    expect(otpText("REGISTER", "007007")).toContain("007007");
    expect(otpText("PASSWORD_RESET", "010101")).toContain("010101");
  });

  it("клиент в СМС — фамилия и инициал, без телефона", () => {
    expect(shortClientName("Иванов Александр Петрович")).toBe("Иванов А.");
    expect(shortClientName("Виктор")).toBe("Виктор");
    expect(shortClientName("")).toBe("клиента");
    const text = fixationExpiryText("Иванов Александр", new Date("2026-10-20T09:00:00+03:00"));
    expect(text).toBe("Закрепление клиента Иванов А. истекает 20.10. Продлить — в кабинете.");
  });

  it("дата — по Москве, даже если UTC ещё вчера", () => {
    expect(shortDate(new Date("2026-10-19T22:30:00Z"))).toBe("20.10");
  });

  it("длинная фамилия не выбивает за 70 знаков", () => {
    const long = "Константинопольская-Задунайская Александра";
    const text = fixationExpiryText(long, new Date("2026-10-20T09:00:00+03:00"));
    expect(text.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(text).toMatch(/^Закрепление клиента /);
    expect(text).toMatch(/истекает 20\.10\. Продлить — в кабинете\.$/);
  });

  it("в журнале код маскируется", () => {
    expect(maskCodeInText(loginCodeText(code))).toBe("Код входа в кабинет брокера: ••••••. Никому не сообщайте.");
    expect(maskCodeInText("Закрепление клиента Иванов А. истекает 20.10.")).toBe("Закрепление клиента Иванов А. истекает 20.10.");
  });
});
