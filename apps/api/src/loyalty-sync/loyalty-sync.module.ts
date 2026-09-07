import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LoyaltyPermissionModule } from "../loyalty-workflow/loyalty-permission.module";
import { LoyaltySyncController } from "./loyalty-sync.controller";
import { LoyaltySyncService } from "./loyalty-sync.service";

@Module({
  imports: [AuthModule, LoyaltyPermissionModule],
  controllers: [LoyaltySyncController],
  providers: [LoyaltySyncService],
  exports: [LoyaltySyncService],
})
export class LoyaltySyncModule {}
