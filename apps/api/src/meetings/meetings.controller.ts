import { Controller, Delete, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { MeetingsService } from './meetings.service';
import { UserRole } from '@st-michael/shared';
import { createMeetingDtoSchema, updateMeetingDtoSchema, paginationQuerySchema } from '@st-michael/shared';

@ApiTags('meetings')
@Controller('meetings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get broker meetings' })
  @ApiResponse({ status: 200, description: 'Paginated list of meetings' })
  async getMeetings(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    const pagination = paginationQuerySchema.parse(query);
    return this.meetingsService.getMeetings(user.id, {
      ...pagination,
      status: query.status,
      type: query.type,
    });
  }

  // 2026-07-01: календарь встреч из amoCRM (read-only) для кабинета брокера.
  @Get('amocrm-calendar')
  @ApiOperation({ summary: 'amoCRM tasks (task_type=Meeting) for broker leads' })
  async getAmoCalendar(@CurrentUser() user: CurrentUserPayload) {
    return this.meetingsService.getAmoCrmCalendar(user.id);
  }

  // ─── Slots: list available slots (broker-facing) ─────────

  @Get('slots/available')
  @ApiOperation({ summary: 'List available slots (with capacity info)' })
  async getAvailableSlots(@Query() query: any) {
    return this.meetingsService.getAvailableSlots({
      date: query.date,
      from: query.from,
      to: query.to,
      type: query.type,
    });
  }

  // ─── Slots: admin/manager management ────────────────────

  @Get('slots')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async listSlots(@Query() query: any) {
    return this.meetingsService.listSlotsAdmin({ from: query.from, to: query.to });
  }

  @Post('slots')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async createSlots(@Body() body: any) {
    return this.meetingsService.createSlots({
      startsAt: body.startsAt,
      durationMin: body.durationMin,
      capacity: body.capacity,
      type: body.type,
      days: body.days,
      times: body.times,
    });
  }

  @Patch('slots/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async updateSlot(@Param('id') id: string, @Body() body: any) {
    return this.meetingsService.updateSlot(id, {
      capacity: body.capacity,
      durationMin: body.durationMin,
      isActive: body.isActive,
      startsAt: body.startsAt,
    });
  }

  @Delete('slots/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async deleteSlot(@Param('id') id: string) {
    return this.meetingsService.deleteSlot(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get meeting details' })
  @ApiResponse({ status: 200, description: 'Meeting details' })
  async getMeeting(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meetingsService.getMeeting(id, user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create meeting' })
  @ApiResponse({ status: 201, description: 'Meeting created' })
  async createMeeting(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    const data = createMeetingDtoSchema.parse(body) as any;
    return this.meetingsService.createMeeting(user.id, data);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update meeting' })
  @ApiResponse({ status: 200, description: 'Meeting updated' })
  async updateMeeting(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = updateMeetingDtoSchema.parse(body) as any;
    return this.meetingsService.updateMeeting(id, user.id, data);
  }

  @Post(':id/sign-act')
  @ApiOperation({ summary: 'Sign inspection act' })
  @ApiResponse({ status: 200, description: 'Act signed, client fixation updated' })
  async signAct(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meetingsService.signAct(id, user.id);
  }
}
