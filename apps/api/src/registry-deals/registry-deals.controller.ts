import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@st-michael/shared';
import { RegistryDealsService } from './registry-deals.service';
import { RegistrySeriesQueryDto } from './registry-deals.dto';

@ApiTags('registry-deals')
@Controller('admin/registry-deals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
@ApiBearerAuth()
export class RegistryDealsController {
  constructor(private readonly registryDealsService: RegistryDealsService) {}

  @Get('agencies')
  @ApiOperation({ summary: 'Registry deals aggregated by agency (paid DDU only)' })
  async getAgencies() {
    return this.registryDealsService.getAgencies();
  }

  @Get('summary')
  @ApiOperation({ summary: 'Registry deals totals by source/broker/agency, paid deals and paid bookings' })
  async getSummary() {
    return this.registryDealsService.getSummary();
  }

  // 2026-09-07: ряды по дням / неделям / месяцам (сделки по дате оплаты ДДУ,
  // платные брони по дате оплаты ДВОУ, фиксации по дате подачи), разрез по проекту.
  @Get('series')
  @ApiOperation({ summary: 'Deals / paid bookings / fixations series by day, week or month' })
  async getSeries(@Query() query: RegistrySeriesQueryDto) {
    return this.registryDealsService.getSeries(query);
  }
}
