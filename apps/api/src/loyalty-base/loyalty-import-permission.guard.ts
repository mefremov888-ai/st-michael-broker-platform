import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { CurrentUserPayload } from "../auth/current-user.decorator";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";

/**
 * Runs before Nest interceptors, so a denied multipart request never reaches
 * Multer's in-memory buffering path. The controller keeps its permission check
 * as defense in depth after parsing.
 */
@Injectable()
export class LoyaltyImportPermissionGuard implements CanActivate {
  constructor(private readonly permissions: LoyaltyPermissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest().user as CurrentUserPayload;
    await this.permissions.require(user, "IMPORT");
    return true;
  }
}
