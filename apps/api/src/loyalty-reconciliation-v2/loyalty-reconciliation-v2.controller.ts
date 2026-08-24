import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  StreamableFile,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { UserRole } from "@st-michael/shared";
import {
  CurrentUser,
  CurrentUserPayload,
} from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { LoyaltyFullScanBusyFilter } from "../loyalty-base/loyalty-full-scan-busy.filter";
import {
  LoyaltyReconciliationCoverageQueryDto,
  LoyaltyReconciliationGroupExportDto,
  LoyaltyReconciliationGroupSearchDto,
  LoyaltyReconciliationV2DecisionDto,
} from "./loyalty-reconciliation-v2.dto";
import { LoyaltyReconciliationV2Service } from "./loyalty-reconciliation-v2.service";

@ApiTags("loyalty-reconciliation-v2")
@ApiBearerAuth()
@Controller("loyalty-reconciliation-v2")
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(LoyaltyFullScanBusyFilter)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class LoyaltyReconciliationV2Controller {
  constructor(
    private readonly reconciliation: LoyaltyReconciliationV2Service,
  ) {}

  @Get("definitions")
  @ApiOperation({ summary: "Definitions for all seven reconciliation groups" })
  definitions(@CurrentUser() user: CurrentUserPayload) {
    return this.reconciliation.definitions(user);
  }

  @Get("coverage")
  @ApiOperation({
    summary: "PII-free group counts, overlap and unclassified coverage",
  })
  coverage(
    @Query() query: LoyaltyReconciliationCoverageQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.reconciliation.coverage(query, user);
  }

  @Post("groups/search")
  @ApiOperation({
    summary: "Search one isolated ANNA or OURS reconciliation group",
  })
  search(
    @Body() body: LoyaltyReconciliationGroupSearchDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.reconciliation.search(body, user);
  }

  @Post("groups/export")
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: "Export one masked reconciliation group as CSV" })
  async export(
    @Body() body: LoyaltyReconciliationGroupExportDto,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.reconciliation.exportCsv(body, user);
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.filename}"`,
    );
    response.setHeader("X-Export-Row-Count", String(result.rowCount));
    response.setHeader("X-Filter-Hash", result.filterHash);
    return new StreamableFile(result.buffer);
  }

  @Post("decisions")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      "Resolve an existing candidate without merging or deleting either base",
  })
  decide(
    @Body() body: LoyaltyReconciliationV2DecisionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.reconciliation.decide(body, user);
  }
}
