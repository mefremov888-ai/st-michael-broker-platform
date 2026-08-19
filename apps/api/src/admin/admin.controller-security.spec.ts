import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@st-michael/shared";
import { AdminController } from "./admin.controller";
import { WebhooksController } from "../webhooks/webhooks.controller";

describe("Mango controller security metadata", () => {
  it.each(["listKcManagers", "assignBrokers", "unassignBrokers"] as const)(
    "keeps %s ADMIN-only",
    (method) => {
      expect(
        Reflect.getMetadata("roles", AdminController.prototype[method]),
      ).toEqual([UserRole.ADMIN]);
    },
  );

  it("answers the Mango webhook with explicit HTTP 200", () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        WebhooksController.prototype.mangoCallResult,
      ),
    ).toBe(200);
  });
});
