import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@st-michael/shared";
import {
  CurrentUser,
  CurrentUserPayload,
} from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import {
  AmoLoyaltyDryRunDto,
  GoogleLoyaltyDryRunDto,
  LoyaltySyncRunsQueryDto,
} from "./loyalty-sync.dto";
import { LoyaltySyncService } from "./loyalty-sync.service";

@ApiTags("loyalty-sync")
@ApiBearerAuth()
@Controller("loyalty-sync")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class LoyaltySyncController {
  constructor(private readonly sync: LoyaltySyncService) {}

  @Post("google/dry-run")
  @ApiOperation({
    summary: "Read and attest all four approved Google tabs without publishing",
  })
  googleDryRun(
    @Body() body: GoogleLoyaltyDryRunDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.sync.googleDryRun(body, user);
  }

  @Post("amo/dry-run")
  @ApiOperation({
    summary: "Perform a complete bounded GET-only amoCRM coverage scan",
  })
  amoDryRun(
    @Body() body: AmoLoyaltyDryRunDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.sync.amoDryRun(body, user);
  }

  @Get("runs")
  runs(
    @Query() query: LoyaltySyncRunsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.sync.runs(query, user);
  }
}
