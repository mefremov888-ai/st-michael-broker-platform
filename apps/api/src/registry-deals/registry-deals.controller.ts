import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@st-michael/shared';
import { RegistryDealsService } from './registry-deals.service';

@ApiTags('registry-deals')
@Controller('admin/registry-deals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
@ApiBearerAuth()
export class RegistryDealsController {
  constructor(private readonly registryDealsService: RegistryDealsService) {}

  @Get('agencies')
  @ApiOperation({ summary: 'Registry deals aggregated by agency (DDU analytics)' })
  async getAgencies() {
    return this.registryDealsService.getAgencies();
  }

  @Get('summary')
  @ApiOperation({ summary: 'Registry deals totals by source/broker/agency' })
  async getSummary() {
    return this.registryDealsService.getSummary();
  }
}
