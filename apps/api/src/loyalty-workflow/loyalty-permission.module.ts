import { Module } from "@nestjs/common";
import { LoyaltyPermissionService } from "./loyalty-permission.service";

@Module({
  providers: [LoyaltyPermissionService],
  exports: [LoyaltyPermissionService],
})
export class LoyaltyPermissionModule {}
