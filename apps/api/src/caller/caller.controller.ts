import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { CallerService } from './caller.service';
import { UserRole } from '@st-michael/shared';

@ApiTags('calls')
@Controller('calls')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CallerController {
  constructor(private readonly callerService: CallerService) {}

  @Get()
  @ApiOperation({ summary: 'Get call history' })
  @ApiResponse({ status: 200, description: 'Paginated call history' })
  async getCalls(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    return this.callerService.getCalls(user.id, query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get call statistics' })
  @ApiResponse({ status: 200, description: 'Call stats' })
  async getCallStats(@CurrentUser() user: CurrentUserPayload) {
    return this.callerService.getCallStats(user.id);
  }

  @Post('schedule')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Schedule call campaign (manager only)' })
  @ApiResponse({ status: 201, description: 'Campaign scheduled' })
  async scheduleCalls(@Body() body: any) {
    return this.callerService.scheduleCalls(body);
  }
}
