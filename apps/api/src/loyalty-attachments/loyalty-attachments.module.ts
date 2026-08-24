import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LoyaltyPermissionModule } from "../loyalty-workflow/loyalty-permission.module";
import { LoyaltyAttachmentsController } from "./loyalty-attachments.controller";
import {
  LoyaltyAttachmentEditGuard,
  LoyaltyAttachmentReadGuard,
} from "./loyalty-attachments.guard";
import { LoyaltyAttachmentsService } from "./loyalty-attachments.service";

@Module({
  imports: [AuthModule, LoyaltyPermissionModule],
  controllers: [LoyaltyAttachmentsController],
  providers: [
    LoyaltyAttachmentsService,
    LoyaltyAttachmentReadGuard,
    LoyaltyAttachmentEditGuard,
  ],
  exports: [LoyaltyAttachmentsService],
})
export class LoyaltyAttachmentsModule {}
