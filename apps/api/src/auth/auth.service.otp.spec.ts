import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { UserStatus } from "@st-michael/database";
import { AuthService } from "./auth.service";

function broker(overrides: Record<string, unknown> = {}) {
  return {
    id: "broker-1",
    phone: "+79990000000",
    fullName: "Test Broker",
    email: "b@example.test",
    role: "BROKER",
    status: UserStatus.ACTIVE,
    passwordHash: "hash",
    funnelStage: "NEW_BROKER",
    brokerAgencies: [],
    amoContactId: null,
    ...overrides,
  };
}

function createHarness(opts: { registerEnabled?: boolean } = {}) {
  const prisma: any = {
    broker: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    agency: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    brokerAgency: { findFirst: jest.fn(), create: jest.fn() },
    siteContent: { findUnique: jest.fn() },
    offerAcceptance: { create: jest.fn() },
    privacyAcceptance: { create: jest.fn() },
  };
  const jwtService = { sign: jest.fn().mockReturnValue("token"), verify: jest.fn() };
  const otp = {
    isPurposeEnabled: jest.fn(async (p: string) => (p === "REGISTER" ? Boolean(opts.registerEnabled) : true)),
    request: jest.fn().mockResolvedValue({ ok: true, expiresInSec: 600, retryAfterSec: 60 }),
    verify: jest.fn().mockResolvedValue(undefined),
  };
  const sms = { publicOptions: jest.fn().mockResolvedValue({ login: true, register: false, passwordReset: true }) };
  const service = new AuthService(
    prisma,
    jwtService as any,
    { add: jest.fn() } as any,
    { syncFromFeed: jest.fn().mockResolvedValue({}) } as any,
    otp as any,
    sms as any,
  );
  (service as any).syncBrokerProfileToAmo = jest.fn().mockResolvedValue(undefined);
  (service as any).syncBrokerFromAmo = jest.fn().mockResolvedValue(undefined);
  return { prisma, jwtService, otp, sms, service };
}

describe("AuthService — коды по СМС", () => {
  beforeEach(() => { AuthService.lastFeedSyncAt = Date.now(); });

  it("smsOptions отдаёт флаги без секретов", async () => {
    const { service } = createHarness();
    await expect(service.smsOptions()).resolves.toEqual({ login: true, register: false, passwordReset: true });
  });

  it("вход по коду: проверяет код и выдаёт те же токены, что вход по паролю", async () => {
    const { prisma, otp, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(broker());
    const res = await service.loginByCode({ phone: "+79990000000", code: "482913" });
    expect(otp.verify).toHaveBeenCalledWith({ purpose: "LOGIN", phone: "+79990000000", code: "482913" });
    expect(res.accessToken).toBe("token");
    expect(res.broker.id).toBe("broker-1");
  });

  it("вход по коду: неизвестный номер → NEEDS_REGISTRATION, код не проверяется", async () => {
    const { prisma, otp, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(null);
    await expect(service.loginByCode({ phone: "+79990000000", code: "482913" })).rejects.toMatchObject({
      response: { code: "NEEDS_REGISTRATION" },
    });
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it("вход по коду: карточка ожидает активации → как при входе по паролю", async () => {
    const { prisma, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(broker({ status: UserStatus.PENDING, passwordHash: null }));
    await expect(service.loginByCode({ phone: "+79990000000", code: "482913" })).rejects.toMatchObject({
      response: { code: "NEEDS_ACTIVATION" },
    });
    prisma.broker.findUnique.mockResolvedValue(broker({ status: UserStatus.BLOCKED }));
    await expect(service.loginByCode({ phone: "+79990000000", code: "482913" })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("запрос кода для входа уходит только существующему активному брокеру", async () => {
    const { prisma, otp, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(broker());
    await service.requestOtp("LOGIN", "+79990000000", "1.1.1.1");
    expect(otp.request).toHaveBeenCalledWith({ purpose: "LOGIN", phone: "+79990000000", ip: "1.1.1.1", brokerId: "broker-1" });
  });

  it("смена пароля: на чужой/несуществующий номер ответ тот же, СМС не уходит", async () => {
    const { prisma, otp, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(null);
    await expect(service.requestOtp("PASSWORD_RESET", "+79990000000")).resolves.toMatchObject({ ok: true });
    prisma.broker.findUnique.mockResolvedValue(broker({ status: UserStatus.PENDING }));
    await expect(service.requestOtp("PASSWORD_RESET", "+79990000000")).resolves.toMatchObject({ ok: true });
    expect(otp.request).not.toHaveBeenCalled();
  });

  it("регистрация: номер занят активной карточкой → PHONE_TAKEN с вариантом восстановления", async () => {
    const { prisma, otp, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(broker());
    await expect(service.requestOtp("REGISTER", "+79990000000")).rejects.toMatchObject({
      response: { code: "PHONE_TAKEN", recovery: "forgot_password" },
    });
    expect(otp.request).not.toHaveBeenCalled();
  });

  it("регистрация: свободный номер и импортированная карточка без пароля получают код", async () => {
    const { prisma, otp, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(null);
    await service.requestOtp("REGISTER", "+79990000000");
    prisma.broker.findUnique.mockResolvedValue(broker({ status: UserStatus.PENDING, passwordHash: null }));
    await service.requestOtp("REGISTER", "+79990000000");
    expect(otp.request).toHaveBeenCalledTimes(2);
    expect(otp.request.mock.calls[1][0].brokerId).toBe("broker-1");
  });

  it("register: при включённом подтверждении без кода — 400 на поле smsCode", async () => {
    const { prisma, service } = createHarness({ registerEnabled: true });
    prisma.broker.findUnique.mockResolvedValue(null);
    await expect(
      service.register({ phone: "+79990000000", fullName: "Test Broker", password: "safe-password" }),
    ).rejects.toMatchObject({ response: { code: "SMS_CODE_REQUIRED", field: "smsCode" } });
  });

  it("register: неверный код останавливает регистрацию до записи в БД", async () => {
    const { prisma, otp, service } = createHarness({ registerEnabled: true });
    prisma.broker.findUnique.mockResolvedValue(null);
    otp.verify.mockRejectedValueOnce(new BadRequestException({ message: "Код неверный или истёк", code: "OTP_INVALID", field: "smsCode" }));
    await expect(
      service.register({ phone: "+79990000000", fullName: "Test Broker", password: "safe-password", smsCode: "000000" }),
    ).rejects.toMatchObject({ response: { code: "OTP_INVALID" } });
    expect(prisma.broker.create).not.toHaveBeenCalled();
  });

  it("register: без включённого подтверждения код не требуется (как раньше)", async () => {
    const { prisma, otp, service } = createHarness({ registerEnabled: false });
    prisma.broker.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ amoContactId: null });
    prisma.broker.create.mockResolvedValue({ id: "broker-2" });
    await service.register({ phone: "+79990000000", fullName: "Test Broker", password: "safe-password" });
    expect(otp.verify).not.toHaveBeenCalled();
    expect(prisma.broker.create).toHaveBeenCalled();
  });

  it("новый пароль по коду: проверяет код и пишет хеш, старая ссылка из письма гасится", async () => {
    const { prisma, otp, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(broker());
    await service.resetPasswordByCode({ phone: "+79990000000", code: "482913", password: "new-password-1" });
    expect(otp.verify).toHaveBeenCalledWith({ purpose: "PASSWORD_RESET", phone: "+79990000000", code: "482913" });
    const data = prisma.broker.update.mock.calls[0][0].data;
    expect(data.passwordHash).toBeTruthy();
    expect(data.passwordHash).not.toBe("new-password-1");
    expect(data.passwordResetToken).toBeNull();
  });

  it("новый пароль по коду: несуществующий номер — тот же ответ, что неверный код", async () => {
    const { prisma, otp, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(null);
    await expect(
      service.resetPasswordByCode({ phone: "+79990000000", code: "482913", password: "new-password-1" }),
    ).rejects.toMatchObject({ response: { code: "OTP_INVALID" } });
    expect(otp.verify).not.toHaveBeenCalled();
  });
});
