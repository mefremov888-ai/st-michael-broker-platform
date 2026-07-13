import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { AnalyticsService } from './analytics.service';
import { UserRole } from '@st-michael/shared';

@ApiTags('analytics')
@Controller('analytics')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get dashboard metrics for current broker' })
  @ApiResponse({ status: 200, description: 'Dashboard data' })
  async getDashboard(@CurrentUser() user: CurrentUserPayload) {
    return this.analyticsService.getDashboard(user.id);
  }

  // 2026-07-07: удалён @Get('funnel') — мёртвый эндпоинт, фронтенд его
  // не дёргал. Распределение по стадиям воронки уже возвращается
  // внутри /admin/overview (funnelByStage).

  @Get('my')
  @ApiOperation({ summary: 'Get personal broker analytics' })
  @ApiResponse({ status: 200, description: 'Broker analytics' })
  async getMyAnalytics(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    return this.analyticsService.getBrokerAnalytics(user.id, {
      startDate: query.startDate,
      endDate: query.endDate,
    });
  }

  @Get('admin/overview')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin platform-wide analytics (ТЗ §15.6)' })
  async getAdminOverview(@Query() query: any) {
    return this.analyticsService.getAdminOverview({
      startDate: query.startDate,
      endDate: query.endDate,
    });
  }
}
