import { ForbiddenException } from "@nestjs/common";
import {
  LoyaltyAttachmentEditGuard,
  LoyaltyAttachmentReadGuard,
} from "./loyalty-attachments.guard";

const user: any = { id: "manager-1", role: "MANAGER" };
const context: any = {
  switchToHttp: () => ({ getRequest: () => ({ user }) }),
};

describe("loyalty attachment pre-body guards", () => {
  it("requires READ_ALL before a protected download", async () => {
    const permissions: any = {
      require: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new LoyaltyAttachmentReadGuard(permissions);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(permissions.require).toHaveBeenCalledWith(user, "READ_ALL");
  });

  it("requires both edit grants before multipart upload parsing", async () => {
    const permissions: any = {
      requireAll: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new LoyaltyAttachmentEditGuard(permissions);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(permissions.requireAll).toHaveBeenCalledWith(user, [
      "READ_ALL",
      "ENTITY_EDIT",
    ]);
  });

  it("propagates a denied grant without reaching the route handler", async () => {
    const permissions: any = {
      requireAll: jest
        .fn()
        .mockRejectedValue(new ForbiddenException("Insufficient permissions")),
    };
    const guard = new LoyaltyAttachmentEditGuard(permissions);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
