import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@st-michael/shared";
import type { Response } from "express";
import { memoryStorage } from "multer";
import {
  CurrentUser,
  CurrentUserPayload,
} from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ExpectedVersionDto } from "../loyalty-workflow/loyalty-workflow.dto";
import {
  LoyaltyAttachmentsService,
  MAX_LOYALTY_ATTACHMENT_BYTES,
} from "./loyalty-attachments.service";
import {
  LoyaltyAttachmentEditGuard,
  LoyaltyAttachmentReadGuard,
} from "./loyalty-attachments.guard";

const rfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

@ApiTags("loyalty-attachments")
@ApiBearerAuth()
@Controller("loyalty-attachments")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class LoyaltyAttachmentsController {
  constructor(private readonly attachments: LoyaltyAttachmentsService) {}

  @Post("events/:eventId")
  @UseGuards(LoyaltyAttachmentEditGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: {
        files: 1,
        fields: 0,
        parts: 1,
        fileSize: MAX_LOYALTY_ATTACHMENT_BYTES,
      },
    }),
  )
  upload(
    @Param("eventId", new ParseUUIDPipe({ version: "4" })) eventId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.attachments.upload(eventId, file, user);
  }

  @Get(":id")
  @UseGuards(LoyaltyAttachmentReadGuard)
  async download(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) response: Response,
  ) {
    const attachment = await this.attachments.download(id, user);
    response.set({
      "Content-Disposition": `attachment; filename="loyalty-attachment"; filename*=UTF-8''${rfc5987(attachment.fileName)}`,
      "Content-Length": String(attachment.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    return new StreamableFile(attachment.data, { type: attachment.mimeType });
  }

  @Delete(":id")
  @UseGuards(LoyaltyAttachmentEditGuard)
  archive(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: ExpectedVersionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.attachments.archive(id, body.expectedVersion, user);
  }
}
