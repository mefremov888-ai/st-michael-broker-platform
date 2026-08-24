import { ForbiddenException } from "@nestjs/common";
import { LOYALTY_PERMISSIONS } from "./loyalty-workflow.dto";
import { LoyaltyPermissionService } from "./loyalty-permission.service";

const admin = { id: "admin-1", role: "ADMIN", phone: "", fullName: "Admin" };
const manager = {
  id: "manager-1",
  role: "MANAGER",
  phone: "",
  fullName: "Manager",
};
const broker = {
  id: "broker-1",
  role: "BROKER",
  phone: "",
  fullName: "Broker",
};

function harness() {
  const prisma: any = {
    loyaltyUserGrant: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return { prisma, service: new LoyaltyPermissionService(prisma) };
}

describe("LoyaltyPermissionService", () => {
  it("gives ADMIN every permission without querying grants", async () => {
    const { prisma, service } = harness();
    await expect(
      service.requireAll(admin, [...LOYALTY_PERMISSIONS]),
    ).resolves.toBeUndefined();
    await expect(service.effective(admin)).resolves.toMatchObject({
      role: "ADMIN",
      permissions: [...LOYALTY_PERMISSIONS],
      defaults: { ownQueue: true, ownAttempts: true, ownTasks: true },
    });
    expect(prisma.loyaltyUserGrant.findMany).not.toHaveBeenCalled();
  });

  it("fails closed for BROKER before a database lookup", async () => {
    const { prisma, service } = harness();
    await expect(service.require(broker, "READ_ALL")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.effective(broker)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.loyaltyUserGrant.findFirst).not.toHaveBeenCalled();
  });

  it("gives MANAGER no implicit call permissions", async () => {
    const { service } = harness();
    await expect(
      service.require(manager, "CALL_EXECUTE"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.require(manager, "READ_OWN_QUEUE"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.require(manager, "READ_ALL")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("requires every active grant for compound operations", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findMany.mockResolvedValue([
      { permission: "READ_ALL" },
      { permission: "EXPORT" },
    ]);
    await expect(
      service.requireAll(manager, ["READ_ALL", "RECONCILE", "EXPORT"]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    prisma.loyaltyUserGrant.findMany.mockResolvedValue([
      { permission: "READ_ALL" },
      { permission: "RECONCILE" },
      { permission: "EXPORT" },
    ]);
    await expect(
      service.requireAll(manager, ["READ_ALL", "RECONCILE", "EXPORT"]),
    ).resolves.toBeUndefined();
  });

  it("accepts any active grant for alternative capabilities", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findFirst.mockResolvedValue({ id: "grant-call" });

    await expect(
      service.requireAny(manager, ["READ_OWN_QUEUE", "CALL_EXECUTE"]),
    ).resolves.toBeUndefined();
    expect(prisma.loyaltyUserGrant.findFirst).toHaveBeenCalledWith({
      where: {
        userId: manager.id,
        permission: { in: ["READ_OWN_QUEUE", "CALL_EXECUTE"] },
        revokedAt: null,
      },
      select: { id: true },
    });
  });

  it("returns only active explicit grants for UI gating", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findMany.mockResolvedValue([
      { permission: "READ_ALL" },
      { permission: "AUDIT_READ" },
    ]);
    await expect(service.effective(manager)).resolves.toMatchObject({
      role: "MANAGER",
      permissions: ["READ_ALL", "AUDIT_READ"],
      defaults: { ownQueue: false, ownAttempts: false, ownTasks: false },
    });
  });

  it("supports an operator bundle without granting observer or analyst users call access", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findMany.mockResolvedValue([
      { permission: "READ_OWN_QUEUE" },
      { permission: "CALL_EXECUTE" },
    ]);
    await expect(service.effective(manager)).resolves.toMatchObject({
      permissions: ["READ_OWN_QUEUE", "CALL_EXECUTE"],
      defaults: { ownQueue: true, ownAttempts: true, ownTasks: true },
    });
  });

  it("marks the own queue available for a CALL_EXECUTE-only operator", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findMany.mockResolvedValue([
      { permission: "CALL_EXECUTE" },
    ]);
    await expect(service.effective(manager)).resolves.toMatchObject({
      permissions: ["CALL_EXECUTE"],
      defaults: { ownQueue: true, ownAttempts: true, ownTasks: true },
    });
  });
});
