import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@st-michael/shared";
import {
  CurrentUser,
  CurrentUserPayload,
} from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";
import {
  CreateLoyaltyAgencyContactPersonDto,
  CreateLoyaltyContactPointDto,
  CreateLoyaltyManualContactDto,
  LoyaltyContactPointListQueryDto,
  UpdateLoyaltyContactPointDto,
  UpdateLoyaltyAgencyContactPersonDto,
} from "./loyalty-manual.dto";
import { LoyaltyManualService } from "./loyalty-manual.service";

@ApiTags("loyalty-workflow")
@ApiBearerAuth()
@Controller("loyalty-workflow")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class LoyaltyManualController {
  constructor(
    private readonly manual: LoyaltyManualService,
    private readonly permissions: LoyaltyPermissionService,
  ) {}

  @Post("contacts")
  @ApiOperation({
    summary:
      "Create an Anna-only manual overlay without mutating a published snapshot",
  })
  async create(
    @Body() body: CreateLoyaltyManualContactDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return this.manual.create(body, user.id);
  }

  @Get("contacts/:entityType/:entityId/points")
  async listPoints(
    @Param("entityType") entityType: string,
    @Param("entityId", new ParseUUIDPipe({ version: "4" })) entityId: string,
    @Query() query: LoyaltyContactPointListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.manual.listPoints(
      entityType,
      entityId,
      query.includeArchived === true,
    );
  }

  @Post("contacts/:entityType/:entityId/points")
  async createPoint(
    @Param("entityType") entityType: string,
    @Param("entityId", new ParseUUIDPipe({ version: "4" })) entityId: string,
    @Body() body: CreateLoyaltyContactPointDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return this.manual.createPoint(entityType, entityId, body, user.id);
  }

  @Patch("contacts/:entityType/:entityId/points/:pointId")
  async updatePoint(
    @Param("entityType") entityType: string,
    @Param("entityId", new ParseUUIDPipe({ version: "4" })) entityId: string,
    @Param("pointId", new ParseUUIDPipe({ version: "4" })) pointId: string,
    @Body() body: UpdateLoyaltyContactPointDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return this.manual.updatePoint(
      entityType,
      entityId,
      pointId,
      body,
      user.id,
    );
  }

  @Get("contacts/AGENCY/:entityId/people")
  async listAgencyContactPeople(
    @Param("entityId", new ParseUUIDPipe({ version: "4" })) entityId: string,
    @Query() query: LoyaltyContactPointListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.require(user, "READ_ALL");
    return this.manual.listAgencyContactPeople(
      entityId,
      query.includeArchived === true,
    );
  }

  @Post("contacts/AGENCY/:entityId/people")
  async createAgencyContactPerson(
    @Param("entityId", new ParseUUIDPipe({ version: "4" })) entityId: string,
    @Body() body: CreateLoyaltyAgencyContactPersonDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return this.manual.createAgencyContactPerson(entityId, body, user.id);
  }

  @Patch("contacts/AGENCY/:entityId/people/:contactPersonId")
  async updateAgencyContactPerson(
    @Param("entityId", new ParseUUIDPipe({ version: "4" })) entityId: string,
    @Param("contactPersonId", new ParseUUIDPipe({ version: "4" }))
    contactPersonId: string,
    @Body() body: UpdateLoyaltyAgencyContactPersonDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.permissions.requireAll(user, ["READ_ALL", "ENTITY_EDIT"]);
    return this.manual.updateAgencyContactPerson(
      entityId,
      contactPersonId,
      body,
      user.id,
    );
  }
}
