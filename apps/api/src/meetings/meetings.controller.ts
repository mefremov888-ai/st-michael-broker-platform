import { Controller, Get, Post, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MeetingsService } from './meetings.service';

@ApiTags('meetings')
@Controller('meetings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get broker meetings' })
  @ApiResponse({ status: 200, description: 'List of meetings' })
  async getMeetings() {
    return this.meetingsService.getMeetings();
  }

  @Post()
  @ApiOperation({ summary: 'Create meeting' })
  @ApiResponse({ status: 201, description: 'Meeting created' })
  async createMeeting(@Body() body: any) {
    return this.meetingsService.createMeeting(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update meeting' })
  @ApiResponse({ status: 200, description: 'Meeting updated' })
  async updateMeeting(@Param('id') id: string, @Body() body: any) {
    return this.meetingsService.updateMeeting(id, body);
  }

  @Post(':id/sign-act')
  @ApiOperation({ summary: 'Sign inspection act' })
  @ApiResponse({ status: 200, description: 'Act signed' })
  async signAct(@Param('id') id: string) {
    return this.meetingsService.signAct(id);
  }
}