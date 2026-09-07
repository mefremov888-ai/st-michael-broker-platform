import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LoyaltyBaseModule } from "../loyalty-base/loyalty-base.module";
import { LoyaltyPermissionModule } from "../loyalty-workflow/loyalty-permission.module";
import { LoyaltyReconciliationV2Controller } from "./loyalty-reconciliation-v2.controller";
import { LoyaltyReconciliationV2Service } from "./loyalty-reconciliation-v2.service";

@Module({
  imports: [AuthModule, LoyaltyBaseModule, LoyaltyPermissionModule],
  controllers: [LoyaltyReconciliationV2Controller],
  providers: [LoyaltyReconciliationV2Service],
  exports: [LoyaltyReconciliationV2Service],
})
export class LoyaltyReconciliationV2Module {}
