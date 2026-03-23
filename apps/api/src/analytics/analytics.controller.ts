import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@Controller('analytics')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get dashboard metrics' })
  @ApiResponse({ status: 200, description: 'Dashboard data' })
  async getDashboard() {
    return this.analyticsService.getDashboard();
  }

  @Get('funnel')
  @ApiOperation({ summary: 'Get broker funnel' })
  @ApiResponse({ status: 200, description: 'Funnel data' })
  async getFunnel(@Query() query: any) {
    return this.analyticsService.getFunnel(query);
  }
}