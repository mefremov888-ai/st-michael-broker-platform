import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LoyaltyPermissionModule } from "../loyalty-workflow/loyalty-permission.module";
import { LoyaltyManualController } from "./loyalty-manual.controller";
import { LoyaltyManualService } from "./loyalty-manual.service";

@Module({
  imports: [AuthModule, LoyaltyPermissionModule],
  controllers: [LoyaltyManualController],
  providers: [LoyaltyManualService],
})
export class LoyaltyManualModule {}
