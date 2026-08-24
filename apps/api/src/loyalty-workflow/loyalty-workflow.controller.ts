import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@st-michael/shared";
import type { Response } from "express";
import {
  CurrentUser,
  CurrentUserPayload,
} from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import {
  AssignmentBatchDto,
  CampaignDetailQueryDto,
  CampaignListQueryDto,
  CorrectAttemptDto,
  CorrectEventDto,
  CreateAttemptDto,
  CreateCampaignDto,
  CreateEventDto,
  CreateGrantDto,
  CreateSavedViewDto,
  CreateTaskDto,
  EventListQueryDto,
  ExpectedVersionDto,
  GrantListQueryDto,
  QueueQueryDto,
  ReplaceGrantProfileDto,
  SavedViewListQueryDto,
  TaskListQueryDto,
  UpdateSavedViewDto,
  UpdateTaskDto,
} from "./loyalty-workflow.dto";
import { LoyaltyWorkflowService } from "./loyalty-workflow.service";

@ApiTags("loyalty-workflow")
@ApiBearerAuth()
@Controller("loyalty-workflow")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class LoyaltyWorkflowController {
  constructor(private readonly workflow: LoyaltyWorkflowService) {}

  @Get("permissions/effective")
  @ApiOperation({
    summary: "Return the caller's effective loyalty permissions",
  })
  effectivePermissions(@CurrentUser() user: CurrentUserPayload) {
    return this.workflow.effectivePermissions(user);
  }

  @Get("operators")
  operators(@CurrentUser() user: CurrentUserPayload) {
    return this.workflow.operators(user);
  }

  @Get("campaigns")
  campaigns(
    @Query() query: CampaignListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.listCampaigns(query, user);
  }

  @Post("campaigns")
  @ApiOperation({ summary: "Create a server-side call campaign draft" })
  createCampaign(
    @Body() body: CreateCampaignDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.createCampaign(body, user);
  }

  @Get("campaigns/:id/export")
  async exportCampaign(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.workflow.exportCampaign(id, user);
    response.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "X-Export-Row-Count": String(result.rowCount),
      "X-Export-SHA256": result.sha256,
    });
    return new StreamableFile(result.stream);
  }

  @Get("campaigns/:id")
  campaign(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Query() query: CampaignDetailQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.campaign(id, user, query);
  }

  @Post("campaigns/:id/activate")
  activateCampaign(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: ExpectedVersionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.activateCampaign(id, body.expectedVersion, user);
  }

  @Post("campaigns/:id/archive")
  archiveCampaign(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: ExpectedVersionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.archiveCampaign(id, body.expectedVersion, user);
  }

  @Post("campaigns/:id/assignments/preview")
  previewAssignments(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: AssignmentBatchDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.previewAssignments(id, body, user);
  }

  @Post("campaigns/:id/assignments")
  createAssignments(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: AssignmentBatchDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.createAssignments(id, body, user);
  }

  @Get("queue")
  queue(
    @Query() query: QueueQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.queue(query, user);
  }

  @Post("assignments/:assignmentId/attempts")
  createAttempt(
    @Param("assignmentId", new ParseUUIDPipe({ version: "4" }))
    assignmentId: string,
    @Body() body: CreateAttemptDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.createAttempt(assignmentId, body, user);
  }

  @Get("assignments/:assignmentId/attempts")
  attempts(
    @Param("assignmentId", new ParseUUIDPipe({ version: "4" }))
    assignmentId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.listAttempts(assignmentId, user);
  }

  @Post("assignments/:assignmentId/attempts/:attemptId/corrections")
  correctAttempt(
    @Param("assignmentId", new ParseUUIDPipe({ version: "4" }))
    assignmentId: string,
    @Param("attemptId", new ParseUUIDPipe({ version: "4" })) attemptId: string,
    @Body() body: CorrectAttemptDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.correctAttempt(assignmentId, attemptId, body, user);
  }

  @Get("tasks")
  tasks(
    @Query() query: TaskListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.listTasks(query, user);
  }

  @Post("tasks")
  createTask(
    @Body() body: CreateTaskDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.createTask(body, user);
  }

  @Get("tasks/:id")
  task(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.task(id, user);
  }

  @Patch("tasks/:id")
  updateTask(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: UpdateTaskDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.updateTask(id, body, user);
  }

  @Delete("tasks/:id")
  cancelTask(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: ExpectedVersionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.cancelTask(id, body.expectedVersion, user);
  }

  @Get("events")
  events(
    @Query() query: EventListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.listEvents(query, user);
  }

  @Post("events")
  createEvent(
    @Body() body: CreateEventDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.createEvent(body, user);
  }

  @Get("events/:id")
  event(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.event(id, user);
  }

  @Post("events/:id/archive")
  archiveEvent(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: ExpectedVersionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.archiveEvent(id, body.expectedVersion, user);
  }

  @Post("events/:id/restore")
  restoreEvent(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: ExpectedVersionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.restoreEvent(id, body.expectedVersion, user);
  }

  @Post("events/:id/corrections")
  correctEvent(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: CorrectEventDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.correctEvent(id, body, user);
  }

  @Get("saved-views")
  savedViews(
    @Query() query: SavedViewListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.listSavedViews(query, user);
  }

  @Post("saved-views")
  createSavedView(
    @Body() body: CreateSavedViewDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.createSavedView(body, user);
  }

  @Patch("saved-views/:id")
  updateSavedView(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: UpdateSavedViewDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.updateSavedView(id, body, user);
  }

  @Delete("saved-views/:id")
  deleteSavedView(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.deleteSavedView(id, user);
  }

  @Get("grants")
  grants(
    @Query() query: GrantListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.listGrants(query, user);
  }

  @Get("grant-targets")
  grantTargets(@CurrentUser() user: CurrentUserPayload) {
    return this.workflow.grantTargets(user);
  }

  @Post("grants/profile")
  replaceGrantProfile(
    @Body() body: ReplaceGrantProfileDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.replaceGrantProfile(body, user);
  }

  @Post("grants")
  createGrant(
    @Body() body: CreateGrantDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.createGrant(body, user);
  }

  @Delete("grants/:id")
  revokeGrant(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workflow.revokeGrant(id, user);
  }
}
