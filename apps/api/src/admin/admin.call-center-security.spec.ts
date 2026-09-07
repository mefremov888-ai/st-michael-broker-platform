import { ForbiddenException } from "@nestjs/common";
import { AdminService } from "./admin.service";

function createHarness() {
  const prisma: any = {
    broker: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    call: { create: jest.fn() },
    callLog: { create: jest.fn() },
  };
  const mangoCallSafety = {
    execute: jest.fn((_request: unknown, action: () => Promise<unknown>) =>
      action(),
    ),
  };
  const service = new AdminService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    mangoCallSafety as any,
  );
  return { prisma, service, mangoCallSafety };
}

describe("AdminService call-center authorization", () => {
  it("forces a MANAGER queue to the current assignment even for assignment=all", async () => {
    const { prisma, service } = createHarness();
    await service.getCallCenterQueue({
      currentUserId: "manager-1",
      currentUserRole: "MANAGER",
      assignment: "all",
    });

    expect(prisma.broker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assignedManagerId: "manager-1" }),
      }),
    );
    expect(prisma.broker.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ assignedManagerId: "manager-1" }),
    });
  });

  it("keeps an ADMIN queue unrestricted when assignment=all", async () => {
    const { prisma, service } = createHarness();
    await service.getCallCenterQueue({
      currentUserId: "admin-1",
      currentUserRole: "ADMIN",
      assignment: "all",
    });

    const where = prisma.broker.findMany.mock.calls[0][0].where;
    expect(where.assignedManagerId).toBeUndefined();
  });

  it("rejects a MANAGER Mango call to another operator assignment", async () => {
    const { prisma, service, mangoCallSafety } = createHarness();
    prisma.broker.findUnique
      .mockResolvedValueOnce({ id: "manager-1", mangoEmployeeNum: "17" })
      .mockResolvedValueOnce({
        id: "broker-1",
        assignedManagerId: "manager-2",
        doNotCall: false,
        phone: "+79990000000",
      });
    const initiate = jest.fn();
    (service as any).mango = { initiateCallbackFromExtension: initiate };

    await expect(
      service.mangoCallBroker("manager-1", "broker-1", "MANAGER", "idem-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mangoCallSafety.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "manager-1", targetId: "broker-1" }),
      expect.any(Function),
    );
    expect(initiate).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
  });

  it("rejects a MANAGER manual log for another operator assignment", async () => {
    const { prisma, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue({
      id: "broker-1",
      assignedManagerId: "manager-2",
    });

    await expect(
      service.logCall(
        "manager-1",
        { brokerId: "broker-1", result: "NDZ" },
        "MANAGER",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.callLog.create).not.toHaveBeenCalled();
    expect(prisma.broker.update).not.toHaveBeenCalled();
  });

  it("uses a safe projection and hides EmployeeNUM from MANAGER details", async () => {
    const { prisma, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue({ id: "broker-1" });
    await service.getBroker("broker-1", false);

    const select = prisma.broker.findUnique.mock.calls[0][0].select;
    expect(select.passwordHash).toBeUndefined();
    expect(select.passwordResetToken).toBeUndefined();
    expect(select.passwordResetExpiresAt).toBeUndefined();
    expect(select.telegramChatId).toBeUndefined();
    expect(select.mangoEmployeeNum).toBeUndefined();
  });

  it("includes EmployeeNUM only for an ADMIN detail projection", async () => {
    const { prisma, service } = createHarness();
    prisma.broker.findUnique.mockResolvedValue({ id: "broker-1" });
    await service.getBroker("broker-1", true);

    expect(
      prisma.broker.findUnique.mock.calls[0][0].select.mangoEmployeeNum,
    ).toBe(true);
  });
});
