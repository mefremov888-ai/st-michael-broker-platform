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
  Res,
  StreamableFile,
  UploadedFile,
  UseFilters,
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
import type { Response } from "express";
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
  LoyaltyChangesQueryDto,
  LoyaltyDisplayNameUpdateDto,
  LoyaltyEntityArchiveDto,
  LoyaltyEntityUpdateDto,
  LoyaltyDetailQueryDto,
  LoyaltyExportDto,
  LoyaltyActivitySummaryDto,
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
import { LoyaltyFullScanBusyFilter } from "./loyalty-full-scan-busy.filter";
import { LoyaltyImportPermissionGuard } from "./loyalty-import-permission.guard";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";

const importUploadOptions = {
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 },
};

@ApiTags("loyalty-base")
@ApiBearerAuth()
@Controller("loyalty-base")
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(LoyaltyFullScanBusyFilter)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class LoyaltyBaseController {
  constructor(
    private readonly loyalty: LoyaltyBaseService,
    private readonly permissions: LoyaltyPermissionService,
  ) {}

  @Get(":base/overview")
  @ApiOperation({
    summary:
      "Loyalty base KPI overview (ANNA snapshot or read-only OUR projection)",
  })
  async overview(
    @Param("base") base: string,
    @Query() query: LoyaltyOverviewQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.overview(base, query);
  }

  @Get(":base/brokers")
  async listBrokers(
    @Param("base") base: string,
    @Query() query: LoyaltyListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.list(base, "BROKER", query);
  }

  @Post(":base/brokers/search")
  @ApiOperation({
    summary: "Search brokers with sensitive filters in request body",
  })
  async searchBrokers(
    @Param("base") base: string,
    @Body() body: LoyaltySearchDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.search(base, "BROKER", body);
  }

  // 2026-09-08: «Контрольные показатели активности» по текущим фильтрам.
  @Post(":base/brokers/activity-summary")
  @ApiOperation({
    summary:
      "Activity KPI (fixations, meetings, paid bookings, deals) over the current filtered broker selection",
  })
  async brokerActivitySummary(
    @Param("base") base: string,
    @Body() body: LoyaltyActivitySummaryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.activitySummary(base, "BROKER", body);
  }

  @Post(":base/brokers/export")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: "Export the filtered broker selection as a masked UTF-8 CSV",
  })
  async exportBrokers(
    @Param("base") base: string,
    @Body() body: LoyaltyExportDto,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "EXPORT"]);
    const result = await this.loyalty.exportCsv(base, "BROKER", body, user?.id);
    this.applyCsvHeaders(response, result);
    return new StreamableFile(result.stream);
  }

  @Get(":base/brokers/:id")
  async brokerDetail(
    @Param("base") base: string,
    @Param("id") id: string,
    @Query() query: LoyaltyDetailQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.detail(base, "BROKER", id, query);
  }

  // 2026-09-07: кнопка «Исправить имя» в карточке брокера «Нашей базы».
  // Правит ТОЛЬКО Broker.displayName («имя для работы» для КЦ, source
  // 'manual'); самоназвание брокера (fullName) не трогается и в его
  // кабинете ничего не меняется. Доступ: роли ADMIN/MANAGER (класс-guard)
  // + READ_ALL (как у остальных ручек «Нашей базы»). Аудит:
  // AuditLog action DISPLAY_NAME_EDIT.
  @Patch("ours/brokers/:id/display-name")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: "Edit the working display name of a cabinet broker (ours base)",
  })
  async updateOurBrokerDisplayName(
    @Param("id") id: string,
    @Body() body: LoyaltyDisplayNameUpdateDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.updateOurBrokerDisplayName(
      id,
      body.displayName,
      user?.id,
    );
  }

  @Get(":base/agencies")
  async listAgencies(
    @Param("base") base: string,
    @Query() query: LoyaltyListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.list(base, "AGENCY", query);
  }

  @Post(":base/agencies/search")
  @ApiOperation({
    summary: "Search agencies with sensitive filters in request body",
  })
  async searchAgencies(
    @Param("base") base: string,
    @Body() body: LoyaltySearchDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.search(base, "AGENCY", body);
  }

  @Post(":base/agencies/activity-summary")
  @ApiOperation({
    summary:
      "Activity KPI over the current filtered agency selection (brokers of the agencies + registry rows by agency name)",
  })
  async agencyActivitySummary(
    @Param("base") base: string,
    @Body() body: LoyaltyActivitySummaryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.activitySummary(base, "AGENCY", body);
  }

  @Post(":base/agencies/export")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: "Export the filtered agency selection as a masked UTF-8 CSV",
  })
  async exportAgencies(
    @Param("base") base: string,
    @Body() body: LoyaltyExportDto,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "EXPORT"]);
    const result = await this.loyalty.exportCsv(base, "AGENCY", body, user?.id);
    this.applyCsvHeaders(response, result);
    return new StreamableFile(result.stream);
  }

  @Get(":base/agencies/:id")
  async agencyDetail(
    @Param("base") base: string,
    @Param("id") id: string,
    @Query() query: LoyaltyDetailQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.loyalty.detail(base, "AGENCY", id, query);
  }

  @Get("anna/brokers/:id/changes")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: "Read the audit history of an Anna broker" })
  async brokerChanges(
    @Param("id") id: string,
    @Query() query: LoyaltyChangesQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "AUDIT_READ"]);
    return this.loyalty.entityChanges("BROKER", id, query);
  }

  @Get("anna/agencies/:id/changes")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: "Read the audit history of an Anna agency" })
  async agencyChanges(
    @Param("id") id: string,
    @Query() query: LoyaltyChangesQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "AUDIT_READ"]);
    return this.loyalty.entityChanges("AGENCY", id, query);
  }

  @Patch("anna/brokers/:id")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async updateAnnaBroker(
    @Param("id") id: string,
    @Body() body: LoyaltyEntityUpdateDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return this.loyalty.updateAnnaEntity("BROKER", id, body, user?.id);
  }

  @Delete("anna/brokers/:id")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async archiveAnnaBroker(
    @Param("id") id: string,
    @Body() body: LoyaltyEntityArchiveDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return this.loyalty.archiveAnnaEntity(
      "BROKER",
      id,
      body.expectedUpdatedAt,
      user?.id,
    );
  }

  @Patch("anna/agencies/:id")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async updateAnnaAgency(
    @Param("id") id: string,
    @Body() body: LoyaltyEntityUpdateDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return this.loyalty.updateAnnaEntity("AGENCY", id, body, user?.id);
  }

  @Delete("anna/agencies/:id")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async archiveAnnaAgency(
    @Param("id") id: string,
    @Body() body: LoyaltyEntityArchiveDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return this.loyalty.archiveAnnaEntity(
      "AGENCY",
      id,
      body.expectedUpdatedAt,
      user?.id,
    );
  }

  @Post("anna/import/dry-run")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiConsumes("multipart/form-data")
  @UseGuards(LoyaltyImportPermissionGuard)
  @UseInterceptors(FileInterceptor("file", importUploadOptions))
  async dryRunImport(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<any> {
    await this.permissions.require(user, "IMPORT");
    return this.loyalty.dryRunImport(
      await this.validatedImportDocument(file, body),
    );
  }

  @Post("anna/import/stage")
  @Roles(UserRole.ADMIN)
  @ApiConsumes("multipart/form-data")
  @UseGuards(LoyaltyImportPermissionGuard)
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
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async reconciliation(
    @Query() query: LoyaltyReconciliationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "RECONCILE"]);
    return this.loyalty.reconciliation(query);
  }

  @Post("reconciliation/search")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async reconciliationSearch(
    @Body() body: LoyaltyReconciliationSearchDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "RECONCILE"]);
    const normalized = Object.assign(
      new LoyaltyReconciliationQueryDto(),
      body,
      body.filters || {},
    );
    return this.loyalty.reconciliation(normalized, body.search.trim());
  }

  @Get("reconciliation/anna-only")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async unmatchedAnna(
    @Query() query: LoyaltyReconciliationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "RECONCILE"]);
    return this.loyalty.unmatchedAnnaRecords(query);
  }

  @Get("reconciliation/cabinet-only")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async unmatchedCabinet(
    @Query() query: LoyaltyReconciliationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "RECONCILE"]);
    return this.loyalty.unmatchedCabinetEntities(query);
  }

  @Get("reconciliation/links")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async activeLinks(
    @Query() query: LoyaltyReconciliationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "RECONCILE"]);
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

  private applyCsvHeaders(
    response: Response,
    result: {
      fileName: string;
      rowCount: number;
      truncated: boolean;
      filterHash: string;
    },
  ) {
    response.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "X-Export-Row-Count": String(result.rowCount),
      "X-Export-Truncated": String(result.truncated),
      "X-Loyalty-Filter-Hash": result.filterHash,
    });
  }
}
