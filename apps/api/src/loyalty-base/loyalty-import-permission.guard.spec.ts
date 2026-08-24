import { ForbiddenException } from "@nestjs/common";
import { LoyaltyImportPermissionGuard } from "./loyalty-import-permission.guard";

const user: any = {
  id: "manager-1",
  role: "MANAGER",
  phone: "",
  fullName: "Manager",
};
const context: any = {
  switchToHttp: () => ({ getRequest: () => ({ user }) }),
};

describe("LoyaltyImportPermissionGuard pre-buffer authorization", () => {
  it("stops a denied request before the interceptor and handler paths", async () => {
    const permissions: any = {
      require: jest
        .fn()
        .mockRejectedValue(new ForbiddenException("Insufficient permissions")),
    };
    const guard = new LoyaltyImportPermissionGuard(permissions);
    const handler = jest.fn();
    const interceptorPath = jest.fn(async () => handler());
    const requestPipeline = async () => {
      await guard.canActivate(context);
      return interceptorPath();
    };

    await expect(requestPipeline()).rejects.toBeInstanceOf(ForbiddenException);
    expect(permissions.require).toHaveBeenCalledWith(user, "IMPORT");
    expect(interceptorPath).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("admits a granted request to the interceptor and handler paths", async () => {
    const permissions: any = {
      require: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new LoyaltyImportPermissionGuard(permissions);
    const handler = jest.fn().mockResolvedValue("handled");
    const interceptorPath = jest.fn(async () => handler());
    const requestPipeline = async () => {
      await guard.canActivate(context);
      return interceptorPath();
    };

    await expect(requestPipeline()).resolves.toBe("handled");
    expect(permissions.require).toHaveBeenCalledWith(user, "IMPORT");
    expect(interceptorPath).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
