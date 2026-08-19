import { JwtStrategy } from "./jwt.strategy";

describe("JwtStrategy current account boundary", () => {
  const previousJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-only-jwt-secret-at-least-32-characters";
  });

  afterAll(() => {
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
  });

  it("rejects a token owner that is no longer ACTIVE", async () => {
    const authService = { validateBroker: jest.fn().mockResolvedValue(null) };
    const strategy = new JwtStrategy({} as any, authService as any);

    await expect(
      strategy.validate({
        sub: "broker-1",
        role: "ADMIN",
        phone: "+79990000000",
      }),
    ).resolves.toBeNull();
  });

  it("uses the current database role instead of the stale JWT role", async () => {
    const authService = {
      validateBroker: jest.fn().mockResolvedValue({
        id: "broker-1",
        phone: "+79990000000",
        fullName: "Current User",
        role: "BROKER",
        status: "ACTIVE",
      }),
    };
    const strategy = new JwtStrategy({} as any, authService as any);

    await expect(
      strategy.validate({
        sub: "broker-1",
        role: "ADMIN",
        phone: "+79990000000",
      }),
    ).resolves.toMatchObject({ role: "BROKER" });
  });
});
