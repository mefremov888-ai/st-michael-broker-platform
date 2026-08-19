import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UserRole } from "@st-michael/shared";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/roles.decorator";
import {
  CurrentUser,
  CurrentUserPayload,
} from "../auth/current-user.decorator";
import {
  LoyaltyEntityArchiveDto,
  LoyaltyEntityUpdateDto,
  LoyaltyImportDto,
  LoyaltyListQueryDto,
  LoyaltyLinkUnlinkDto,
  LoyaltyOverviewQueryDto,
  LoyaltyPublishDto,
  LoyaltyReconciliationDecisionDto,
  LoyaltyReconciliationQueryDto,
  LoyaltyReconciliationSearchDto,
  LoyaltySearchDto,
} from "./loyalty-base.dto";
import { LoyaltyBaseService } from "./loyalty-base.service";

const importUploadOptions = {
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 },
};

@ApiTags("loyalty-base")
@ApiBearerAuth()
@Controller("loyalty-base")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class LoyaltyBaseController {
  constructor(private readonly loyalty: LoyaltyBaseService) {}

  @Get(":base/overview")
  @ApiOperation({
    summary:
      "Loyalty base KPI overview (ANNA snapshot or read-only OUR projection)",
  })
  overview(
    @Param("base") base: string,
    @Query() query: LoyaltyOverviewQueryDto,
  ) {
    return this.loyalty.overview(base, query);
  }

  @Get(":base/brokers")
  listBrokers(
    @Param("base") base: string,
    @Query() query: LoyaltyListQueryDto,
  ) {
    return this.loyalty.list(base, "BROKER", query);
  }

  @Post(":base/brokers/search")
  @ApiOperation({
    summary: "Search brokers with sensitive filters in request body",
  })
  searchBrokers(@Param("base") base: string, @Body() body: LoyaltySearchDto) {
    return this.loyalty.search(base, "BROKER", body);
  }

  @Get(":base/brokers/:id")
  brokerDetail(@Param("base") base: string, @Param("id") id: string) {
    return this.loyalty.detail(base, "BROKER", id);
  }

  @Get(":base/agencies")
  listAgencies(
    @Param("base") base: string,
    @Query() query: LoyaltyListQueryDto,
  ) {
    return this.loyalty.list(base, "AGENCY", query);
  }

  @Post(":base/agencies/search")
  @ApiOperation({
    summary: "Search agencies with sensitive filters in request body",
  })
  searchAgencies(@Param("base") base: string, @Body() body: LoyaltySearchDto) {
    return this.loyalty.search(base, "AGENCY", body);
  }

  @Get(":base/agencies/:id")
  agencyDetail(@Param("base") base: string, @Param("id") id: string) {
    return this.loyalty.detail(base, "AGENCY", id);
  }

  @Patch("anna/brokers/:id")
  @Roles(UserRole.ADMIN)
  updateAnnaBroker(
    @Param("id") id: string,
    @Body() body: LoyaltyEntityUpdateDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.loyalty.updateAnnaEntity("BROKER", id, body, user?.id);
  }

  @Delete("anna/brokers/:id")
  @Roles(UserRole.ADMIN)
  archiveAnnaBroker(
    @Param("id") id: string,
    @Body() body: LoyaltyEntityArchiveDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.loyalty.archiveAnnaEntity(
      "BROKER",
      id,
      body.expectedUpdatedAt,
      user?.id,
    );
  }

  @Patch("anna/agencies/:id")
  @Roles(UserRole.ADMIN)
  updateAnnaAgency(
    @Param("id") id: string,
    @Body() body: LoyaltyEntityUpdateDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.loyalty.updateAnnaEntity("AGENCY", id, body, user?.id);
  }

  @Delete("anna/agencies/:id")
  @Roles(UserRole.ADMIN)
  archiveAnnaAgency(
    @Param("id") id: string,
    @Body() body: LoyaltyEntityArchiveDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.loyalty.archiveAnnaEntity(
      "AGENCY",
      id,
      body.expectedUpdatedAt,
      user?.id,
    );
  }

  @Post("anna/import/dry-run")
  @Roles(UserRole.ADMIN)
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(FileInterceptor("file", importUploadOptions))
  async dryRunImport(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ): Promise<any> {
    return this.loyalty.dryRunImport(
      await this.validatedImportDocument(file, body),
    );
  }

  @Post("anna/import/stage")
  @Roles(UserRole.ADMIN)
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(FileInterceptor("file", importUploadOptions))
  async stageImport(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.loyalty.stageImport(
      await this.validatedImportDocument(file, body),
      user?.id,
    );
  }

  @Post("anna/import/:snapshotId/publish")
  @Roles(UserRole.ADMIN)
  publishImport(
    @Param("snapshotId") snapshotId: string,
    @Body() body: LoyaltyPublishDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    if (body.confirmed !== true)
      throw new BadRequestException("confirmed=true is required");
    return this.loyalty.publishSnapshot(snapshotId, body, user?.id);
  }

  @Get("reconciliation")
  @Roles(UserRole.ADMIN)
  reconciliation(@Query() query: LoyaltyReconciliationQueryDto) {
    return this.loyalty.reconciliation(query);
  }

  @Post("reconciliation/search")
  @Roles(UserRole.ADMIN)
  reconciliationSearch(@Body() body: LoyaltyReconciliationSearchDto) {
    const normalized = Object.assign(
      new LoyaltyReconciliationQueryDto(),
      body,
      body.filters || {},
    );
    return this.loyalty.reconciliation(normalized, body.search.trim());
  }

  @Get("reconciliation/anna-only")
  @Roles(UserRole.ADMIN)
  unmatchedAnna(@Query() query: LoyaltyReconciliationQueryDto) {
    return this.loyalty.unmatchedAnnaRecords(query);
  }

  @Get("reconciliation/cabinet-only")
  @Roles(UserRole.ADMIN)
  unmatchedCabinet(@Query() query: LoyaltyReconciliationQueryDto) {
    return this.loyalty.unmatchedCabinetEntities(query);
  }

  @Get("reconciliation/links")
  @Roles(UserRole.ADMIN)
  activeLinks(@Query() query: LoyaltyReconciliationQueryDto) {
    return this.loyalty.activeLinks(query);
  }

  @Post("reconciliation/links/unlink")
  @Roles(UserRole.ADMIN)
  unlinkActiveLink(
    @Body() body: LoyaltyLinkUnlinkDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.loyalty.unlinkActiveLink(body, user?.id);
  }

  @Post("reconciliation")
  @Roles(UserRole.ADMIN)
  decideReconciliation(
    @Body() body: LoyaltyReconciliationDecisionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.loyalty.decideReconciliation(body, user?.id);
  }

  private async validatedImportDocument(
    file: Express.Multer.File | undefined,
    body: unknown,
  ): Promise<LoyaltyImportDto> {
    let raw: any = body;
    if (file) {
      if (file.size > 10 * 1024 * 1024)
        throw new BadRequestException("Import file exceeds 10 MB");
      if (
        !["application/json", "text/json", "application/octet-stream"].includes(
          file.mimetype,
        )
      ) {
        throw new BadRequestException("Import file must be JSON");
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true })
          .decode(file.buffer)
          .replace(/^\uFEFF/, "");
        raw = JSON.parse(text);
      } catch {
        throw new BadRequestException("Import file is not valid UTF-8 JSON");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new BadRequestException("Import document must be a JSON object");
      }
      // Multipart fields are separate from file content. Only the hash is
      // merged; every imported record still comes from the validated file.
      const multipart =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      if (multipart.expectedContentHash)
        raw.expectedContentHash = multipart.expectedContentHash;
      if (multipart.confirmCoverageDrop !== undefined)
        raw.confirmCoverageDrop = multipart.confirmCoverageDrop;
      if (multipart.expectedActiveSnapshotId !== undefined) {
        raw.expectedActiveSnapshotId =
          multipart.expectedActiveSnapshotId === "null" ||
          multipart.expectedActiveSnapshotId === ""
            ? null
            : multipart.expectedActiveSnapshotId;
      }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new BadRequestException("Import document must be a JSON object");
    }
    const document = plainToInstance(LoyaltyImportDto, raw);
    const errors = await validate(document, {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false, value: false },
    });
    if (errors.length) {
      const issues: Array<{ property: string; codes: string[] }> = [];
      const collect = (entries: typeof errors, prefix = "") => {
        for (const error of entries) {
          const property = prefix
            ? `${prefix}.${error.property}`
            : error.property;
          if (error.constraints)
            issues.push({ property, codes: Object.keys(error.constraints) });
          if (error.children?.length)
            collect(error.children as typeof errors, property);
          if (issues.length >= 100) return;
        }
      };
      collect(errors);
      throw new BadRequestException({
        message: "Invalid import document",
        issues,
      });
    }
    return document;
  }
}
