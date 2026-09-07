import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CatalogService } from './catalog.service';

@ApiTags('catalog')
@Controller('lots')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Post('sync')
  @ApiOperation({ summary: 'Sync lots from Profitbase XML feed' })
  @ApiResponse({ status: 200, description: 'Sync result' })
  async syncFromFeed() {
    return this.catalogService.syncFromFeed();
  }

  @Get()
  @ApiOperation({ summary: 'Get lots catalog with filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of lots with stats' })
  async getLots(@Query() query: any) {
    return this.catalogService.getLots(query);
  }

  @Get('rooms')
  @ApiOperation({ summary: 'Get available room types with counts' })
  @ApiResponse({ status: 200, description: 'Room types breakdown' })
  async getAvailableRooms(@Query('project') project?: string) {
    return this.catalogService.getAvailableRooms(project);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get catalog statistics' })
  @ApiResponse({ status: 200, description: 'Catalog stats by project' })
  async getStats() {
    return this.catalogService.getStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get lot details' })
  @ApiResponse({ status: 200, description: 'Lot details with deals' })
  async getLot(@Param('id') id: string) {
    return this.catalogService.getLot(id);
  }
}
