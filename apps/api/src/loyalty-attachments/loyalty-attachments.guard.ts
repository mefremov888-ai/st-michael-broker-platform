import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { CurrentUserPayload } from "../auth/current-user.decorator";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";

@Injectable()
export class LoyaltyAttachmentReadGuard implements CanActivate {
  constructor(private readonly permissions: LoyaltyPermissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest().user as CurrentUserPayload;
    await this.permissions.require(user, "READ_ALL");
    return true;
  }
}

@Injectable()
export class LoyaltyAttachmentEditGuard implements CanActivate {
  constructor(private readonly permissions: LoyaltyPermissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest().user as CurrentUserPayload;
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return true;
  }
}
