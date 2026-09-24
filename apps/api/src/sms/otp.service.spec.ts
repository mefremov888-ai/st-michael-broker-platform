import { BadRequestException, HttpException } from "@nestjs/common";
import {
  OTP_INVALID_MESSAGE,
  OTP_MAX_ATTEMPTS,
  OTP_PHONE_PER_HOUR,
  OtpService,
  hashOtp,
} from "./otp.service";

/**
 * Маленькая «база» phone_otps в памяти — чтобы проверять реальный поток:
 * выдача → лимиты → проверка → попытки → гашение.
 */
function createHarness(opts: { enabled?: boolean; sendOk?: boolean } = {}) {
  const rows: any[] = [];
  const matches = (row: any, where: any) => {
    for (const [k, v] of Object.entries(where || {})) {
      if (v && typeof v === "object" && "gte" in (v as any)) {
        if (!(row[k] >= (v as any).gte)) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  };
  const prisma: any = {
    phoneOtp: {
      findFirst: jest.fn(async ({ where }: any) => {
        const list = rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt);
        return list[0] || null;
      }),
      count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of rows) if (matches(r, where)) { Object.assign(r, data); count++; }
        return { count };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { attempts: 0, consumedAt: null, smsMessageId: null, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
  };
  const sent: any[] = [];
  const sms: any = {
    getSettings: jest.fn().mockResolvedValue({ login: "l", apiKey: "k" }),
    isKindEnabled: jest.fn().mockReturnValue(opts.enabled !== false),
    send: jest.fn(async (input: any) => {
      sent.push(input);
      return opts.sendOk === false
        ? { ok: false, messageId: "m-fail", error: "[3] недостаточно средств" }
        : { ok: true, messageId: `m-${sent.length}` };
    }),
  };
  const service = new OtpService(prisma, sms);
  return { service, prisma, sms, rows, sent };
}

const PHONE = "+79990000000";
const codeFromText = (text: string) => /(\d{6})/.exec(text)![1];

describe("OtpService", () => {
  const originalPepper = process.env.OTP_PEPPER;
  beforeAll(() => { process.env.OTP_PEPPER = "test-pepper"; });
  afterAll(() => { process.env.OTP_PEPPER = originalPepper; });

  it("выдаёт 6-значный код, хранит хеш (не код) и отправляет согласованный текст", async () => {
    const { service, rows, sent } = createHarness();
    const res = await service.request({ purpose: "LOGIN", phone: PHONE, ip: "1.1.1.1" });
    expect(res).toEqual({ ok: true, expiresInSec: 600, retryAfterSec: 60 });
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("LOGIN_CODE");
    expect(sent[0].text).toMatch(/^Код входа в кабинет брокера: \d{6}\. Никому не сообщайте\.$/);
    const code = codeFromText(sent[0].text);
    expect(rows[0].codeHash).not.toContain(code);
    expect(rows[0].codeHash).toBe(hashOtp(rows[0].id, code));
    expect(rows[0].smsMessageId).toBe("m-1");
    const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
    expect(ttl).toBeGreaterThan(9.9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("повторный запрос раньше минуты — 429 с retryAfterSec", async () => {
    const { service } = createHarness();
    await service.request({ purpose: "LOGIN", phone: PHONE });
    await expect(service.request({ purpose: "LOGIN", phone: PHONE })).rejects.toMatchObject({
      status: 429,
      response: { code: "OTP_TOO_SOON" },
    });
  });

  it("не больше 5 кодов в час на номер", async () => {
    const { service, rows } = createHarness();
    for (let i = 0; i < OTP_PHONE_PER_HOUR; i++) {
      await service.request({ purpose: "LOGIN", phone: PHONE });
      // сдвигаем «время выдачи» назад, чтобы пройти минутный интервал
      for (const r of rows) r.createdAt = new Date(r.createdAt.getTime() - 61_000);
    }
    await expect(service.request({ purpose: "LOGIN", phone: PHONE })).rejects.toMatchObject({
      status: 429,
      response: { code: "OTP_PHONE_LIMIT" },
    });
  });

  it("лимит по IP: 10 в час", async () => {
    const { service, rows } = createHarness();
    for (let i = 0; i < 10; i++) {
      await service.request({ purpose: "REGISTER", phone: `+7999000${String(i).padStart(4, "0")}`, ip: "5.5.5.5" });
      for (const r of rows) r.createdAt = new Date(r.createdAt.getTime() - 61_000);
    }
    await expect(service.request({ purpose: "REGISTER", phone: "+79990009999", ip: "5.5.5.5" })).rejects.toMatchObject({
      status: 429,
      response: { code: "OTP_IP_LIMIT" },
    });
  });

  it("верный код гасится один раз; повторно не подходит", async () => {
    const { service, sent, rows } = createHarness();
    await service.request({ purpose: "LOGIN", phone: PHONE });
    const code = codeFromText(sent[0].text);
    await expect(service.verify({ purpose: "LOGIN", phone: PHONE, code })).resolves.toBeUndefined();
    expect(rows[0].consumedAt).toBeInstanceOf(Date);
    await expect(service.verify({ purpose: "LOGIN", phone: PHONE, code })).rejects.toThrow(OTP_INVALID_MESSAGE);
  });

  it("код одного назначения не подходит для другого", async () => {
    const { service, sent } = createHarness();
    await service.request({ purpose: "REGISTER", phone: PHONE });
    const code = codeFromText(sent[0].text);
    await expect(service.verify({ purpose: "LOGIN", phone: PHONE, code })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("после 5 неверных попыток код сгорает, даже если потом ввести верный", async () => {
    const { service, sent, rows } = createHarness();
    await service.request({ purpose: "LOGIN", phone: PHONE });
    const code = codeFromText(sent[0].text);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await expect(service.verify({ purpose: "LOGIN", phone: PHONE, code: wrong })).rejects.toThrow(OTP_INVALID_MESSAGE);
    }
    expect(rows[0].attempts).toBe(OTP_MAX_ATTEMPTS);
    expect(rows[0].consumedAt).toBeInstanceOf(Date);
    await expect(service.verify({ purpose: "LOGIN", phone: PHONE, code })).rejects.toThrow(OTP_INVALID_MESSAGE);
  });

  it("просроченный код не принимается", async () => {
    const { service, sent, rows } = createHarness();
    await service.request({ purpose: "LOGIN", phone: PHONE });
    const code = codeFromText(sent[0].text);
    rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(service.verify({ purpose: "LOGIN", phone: PHONE, code })).rejects.toThrow(OTP_INVALID_MESSAGE);
  });

  it("новый запрос гасит прежний код того же назначения", async () => {
    const { service, sent, rows } = createHarness();
    await service.request({ purpose: "LOGIN", phone: PHONE });
    const first = codeFromText(sent[0].text);
    for (const r of rows) r.createdAt = new Date(r.createdAt.getTime() - 61_000);
    await service.request({ purpose: "LOGIN", phone: PHONE });
    expect(rows[0].consumedAt).toBeInstanceOf(Date);
    await expect(service.verify({ purpose: "LOGIN", phone: PHONE, code: first })).rejects.toThrow(OTP_INVALID_MESSAGE);
  });

  it("СМС не ушла — код гасится, наружу 502 без деталей провайдера", async () => {
    const { service, rows } = createHarness({ sendOk: false });
    let err: any;
    try { await service.request({ purpose: "LOGIN", phone: PHONE }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(502);
    expect(err.getResponse()).toMatchObject({ code: "SMS_SEND_FAILED" });
    expect(JSON.stringify(err.getResponse())).not.toContain("недостаточно средств");
    expect(rows[0].consumedAt).toBeInstanceOf(Date);
  });

  it("выключенный вид — 400 SMS_OTP_DISABLED, ничего не отправляется", async () => {
    const { service, sent } = createHarness({ enabled: false });
    await expect(service.request({ purpose: "LOGIN", phone: PHONE })).rejects.toMatchObject({ response: { code: "SMS_OTP_DISABLED" } });
    expect(sent).toHaveLength(0);
  });

  it("плохой формат номера — 400", async () => {
    const { service } = createHarness();
    await expect(service.request({ purpose: "LOGIN", phone: "89990000000" })).rejects.toMatchObject({ response: { code: "OTP_BAD_PHONE" } });
  });
});
