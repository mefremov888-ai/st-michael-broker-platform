import { Controller, Post, Get, Patch, Body, Param, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ClientFixationService } from './client-fixation.service';
import { fixClientDtoSchema, extendUniquenessDtoSchema, resolveUniquenessDtoSchema } from '@st-michael/shared';
import { UserRole } from '@st-michael/shared';

@ApiTags('clients')
@Controller('clients')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ClientFixationController {
  constructor(private readonly clientFixationService: ClientFixationService) {}

  @Post('fix')
  @ApiOperation({ summary: 'Fix client uniqueness' })
  @ApiResponse({ status: 201, description: 'Client fixed successfully' })
  async fixClient(@Body() body: any) {
    const data = fixClientDtoSchema.parse(body);
    return this.clientFixationService.fixClient(data);
  }

  @Get()
  @ApiOperation({ summary: 'Get broker clients' })
  @ApiResponse({ status: 200, description: 'List of clients' })
  async getClients(@Query() query: any) {
    return this.clientFixationService.getClients(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get client details' })
  @ApiResponse({ status: 200, description: 'Client details' })
  async getClient(@Param('id') id: string) {
    return this.clientFixationService.getClient(id);
  }

  @Post(':id/extend')
  @ApiOperation({ summary: 'Extend uniqueness period' })
  @ApiResponse({ status: 200, description: 'Uniqueness extended' })
  async extendUniqueness(@Param('id') id: string, @Body() body: any) {
    const data = extendUniquenessDtoSchema.parse(body);
    return this.clientFixationService.extendUniqueness(id, data);
  }

  @Patch(':id/fix')
  @ApiOperation({ summary: 'Mark client as fixed' })
  @ApiResponse({ status: 200, description: 'Client marked as fixed' })
  async markFixed(@Param('id') id: string) {
    return this.clientFixationService.markFixed(id);
  }

  @Patch(':id/resolve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Resolve uniqueness conflict (manager only)' })
  @ApiResponse({ status: 200, description: 'Conflict resolved' })
  async resolveUniqueness(@Param('id') id: string, @Body() body: any) {
    const data = resolveUniquenessDtoSchema.parse(body);
    return this.clientFixationService.resolveUniqueness(id, data);
  }
}