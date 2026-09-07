import "reflect-metadata";
import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@st-michael/shared";
import { LoyaltyManualController } from "./loyalty-manual.controller";

const manager = {
  id: "manager-1",
  role: "MANAGER",
  phone: "",
  fullName: "Manager",
} as any;
const entityId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";

function harness() {
  const manual: any = {
    create: jest.fn().mockResolvedValue({ id: entityId }),
    listPoints: jest.fn().mockResolvedValue([]),
    createPoint: jest.fn().mockResolvedValue({ id: childId }),
    updatePoint: jest.fn().mockResolvedValue({ id: childId }),
    listAgencyContactPeople: jest.fn().mockResolvedValue([]),
    createAgencyContactPerson: jest.fn().mockResolvedValue({ id: childId }),
    updateAgencyContactPerson: jest.fn().mockResolvedValue({ id: childId }),
  };
  const permissions: any = {
    require: jest.fn().mockResolvedValue(undefined),
    requireAll: jest.fn().mockResolvedValue(undefined),
  };
  return {
    manual,
    permissions,
    controller: new LoyaltyManualController(manual, permissions),
  };
}

describe("LoyaltyManualController RBAC", () => {
  it("admits only ADMIN/MANAGER at the route boundary", () => {
    expect(Reflect.getMetadata("roles", LoyaltyManualController)).toEqual([
      UserRole.ADMIN,
      UserRole.MANAGER,
    ]);
  });

  it("requires READ_ALL before either list operation", async () => {
    const { controller, manual, permissions } = harness();

    await controller.listPoints(
      "BROKER",
      entityId,
      { includeArchived: false },
      manager,
    );
    await controller.listAgencyContactPeople(
      entityId,
      { includeArchived: true },
      manager,
    );

    expect(permissions.require).toHaveBeenNthCalledWith(1, manager, "READ_ALL");
    expect(permissions.require).toHaveBeenNthCalledWith(2, manager, "READ_ALL");
    expect(manual.listPoints).toHaveBeenCalledTimes(1);
    expect(manual.listAgencyContactPeople).toHaveBeenCalledTimes(1);
  });

  it("requires READ_ALL and ENTITY_EDIT before every mutation", async () => {
    const { controller, permissions } = harness();

    await controller.create({ name: "Contact" } as any, manager);
    await controller.createPoint(
      "BROKER",
      entityId,
      { type: "PHONE", value: "+79990000001" } as any,
      manager,
    );
    await controller.updatePoint(
      "BROKER",
      entityId,
      childId,
      { expectedVersion: 1, value: "+79990000002" } as any,
      manager,
    );
    await controller.createAgencyContactPerson(
      entityId,
      { displayName: "Contact" } as any,
      manager,
    );
    await controller.updateAgencyContactPerson(
      entityId,
      childId,
      { expectedVersion: 1, displayName: "Updated" } as any,
      manager,
    );

    expect(permissions.requireAll).toHaveBeenCalledTimes(5);
    for (const call of permissions.requireAll.mock.calls) {
      expect(call).toEqual([manager, ["READ_ALL", "ENTITY_EDIT"]]);
    }
  });

  it("fails closed before a manual write when grants are missing", async () => {
    const { controller, manual, permissions } = harness();
    permissions.requireAll.mockRejectedValue(
      new ForbiddenException("Insufficient permissions"),
    );

    await expect(
      controller.create({ name: "Contact" } as any, manager),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(manual.create).not.toHaveBeenCalled();
  });
});
