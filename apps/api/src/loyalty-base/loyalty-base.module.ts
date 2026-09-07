import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LoyaltyBaseController } from "./loyalty-base.controller";
import { LoyaltyBaseService } from "./loyalty-base.service";
import { LoyaltyImportPermissionGuard } from "./loyalty-import-permission.guard";
import { LoyaltyPermissionModule } from "../loyalty-workflow/loyalty-permission.module";

@Module({
  imports: [AuthModule, LoyaltyPermissionModule],
  controllers: [LoyaltyBaseController],
  providers: [LoyaltyBaseService, LoyaltyImportPermissionGuard],
  exports: [LoyaltyBaseService],
})
export class LoyaltyBaseModule {}
