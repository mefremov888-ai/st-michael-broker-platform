import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { UserStatus } from "@st-michael/database";
import * as bcrypt from "bcrypt";
import { AuthService } from "./auth.service";

function broker(overrides: Record<string, unknown> = {}) {
  return {
    id: "broker-1",
    phone: "+79990000000",
    fullName: "Test Broker",
    email: null,
    role: "BROKER",
    status: UserStatus.ACTIVE,
    passwordHash: "hash",
    brokerAgencies: [],
    amoContactId: null,
    ...overrides,
  };
}

function createHarness() {
  const prisma: any = {
    broker: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    agency: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    brokerAgency: { findFirst: jest.fn(), create: jest.fn() },
    siteContent: { findUnique: jest.fn() },
    offerAcceptance: { create: jest.fn() },
    privacyAcceptance: { create: jest.fn() },
  };
  const jwtService = {
    sign: jest.fn().mockReturnValue("token"),
    verify: jest.fn(),
  };
  const catalogService = { syncFromFeed: jest.fn().mockResolvedValue({}) };
  const service = new AuthService(
    prisma,
    jwtService as any,
    { add: jest.fn() } as any,
    catalogService as any,
  );
  (service as any).syncBrokerProfileToAmo = jest
    .fn()
    .mockResolvedValue(undefined);
  return { prisma, jwtService, service };
}

describe("AuthService active-account boundary", () => {
  beforeEach(() => {
    AuthService.lastFeedSyncAt = Date.now();
  });

  it("activates only an existing PENDING BROKER without a password", async () => {
    const { prisma, service } = createHarness();
    prisma.broker.findUnique
      .mockResolvedValueOnce(
        broker({ status: UserStatus.PENDING, passwordHash: null }),
      )
      .mockResolvedValueOnce({ amoContactId: null });
    prisma.broker.update.mockResolvedValue({ id: "broker-1" });

    await expect(
      service.register({
        phone: "+79990000000",
        fullName: "Test Broker",
        password: "safe-password",
      }),
    ).resolves.toMatchObject({ brokerId: "broker-1" });
    expect(prisma.broker.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "broker-1" },
        data: expect.objectContaining({ status: UserStatus.ACTIVE }),
      }),
    );
    expect(prisma.broker.create).not.toHaveBeenCalled();
  });

  it.each(["MANAGER", "ADMIN"])(
    "rejects public activation of a passwordless PENDING %s",
    async (role) => {
      const { prisma, service } = createHarness();
      prisma.broker.findUnique.mockResolvedValue(
        broker({ role, status: UserStatus.PENDING, passwordHash: null }),
      );

      await expect(
        service.register({
          phone: "+79990000000",
          fullName: "Staff Account",
          password: "safe-password",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.broker.update).not.toHaveBeenCalled();
      expect(prisma.broker.create).not.toHaveBeenCalled();
    },
  );

  it("keeps NEEDS_ACTIVATION for a passwordless PENDING BROKER", async () => {
    const { prisma, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(
      broker({ status: UserStatus.PENDING, passwordHash: null }),
    );

    await expect(
      service.login({ phone: "+79990000000", password: "x" }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "NEEDS_ACTIVATION" }),
    });
  });

  it.each(["MANAGER", "ADMIN"])(
    "rejects passwordless PENDING %s without exposing public activation",
    async (role) => {
      const { prisma, service } = createHarness();
      prisma.broker.findUnique.mockResolvedValue(
        broker({ role, status: UserStatus.PENDING, passwordHash: null }),
      );

      await expect(
        service.login({ phone: "+79990000000", password: "x" }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ACCOUNT_UNAVAILABLE" }),
      });
    },
  );

  it("rejects a PENDING account that already has a password before signing JWTs", async () => {
    const { prisma, jwtService, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue(
      broker({ role: "MANAGER", status: UserStatus.PENDING }),
    );

    await expect(
      service.login({ phone: "+79990000000", password: "x" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("still signs tokens for an ACTIVE staff account", async () => {
    const { prisma, jwtService, service } = createHarness();
    const passwordHash = await bcrypt.hash("safe-password", 4);
    prisma.broker.findUnique.mockResolvedValue(
      broker({ role: "MANAGER", status: UserStatus.ACTIVE, passwordHash }),
    );

    await expect(
      service.login({ phone: "+79990000000", password: "safe-password" }),
    ).resolves.toMatchObject({ accessToken: "token", refreshToken: "token" });
    expect(jwtService.sign).toHaveBeenCalledTimes(2);
  });

  it("rejects refresh and existing access JWTs as soon as status becomes PENDING", async () => {
    const { prisma, jwtService, service } = createHarness();
    jwtService.verify.mockReturnValue({ sub: "broker-1" });
    prisma.broker.findUnique.mockResolvedValue(
      broker({ status: UserStatus.PENDING }),
    );

    await expect(service.refreshToken("refresh")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.validateBroker("broker-1")).resolves.toBeNull();
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("does not issue or consume password-reset tokens for inactive accounts", async () => {
    const { prisma, service } = createHarness();
    prisma.broker.findFirst.mockResolvedValue(null);
    await service.forgotPassword("shared@example.test");
    expect(prisma.broker.findFirst).toHaveBeenCalledWith({
      where: {
        email: "shared@example.test",
        status: UserStatus.ACTIVE,
        passwordHash: { not: null },
      },
    });
    expect(prisma.broker.update).not.toHaveBeenCalled();

    prisma.broker.findUnique.mockResolvedValue(
      broker({
        status: UserStatus.PENDING,
        passwordResetExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await expect(
      service.resetPassword("reset-token", "new-safe-password"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
