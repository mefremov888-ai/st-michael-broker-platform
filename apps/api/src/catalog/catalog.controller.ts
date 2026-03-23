import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CatalogService } from './catalog.service';

@ApiTags('catalog')
@Controller('lots')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Get lots catalog' })
  @ApiResponse({ status: 200, description: 'List of lots' })
  async getLots(@Query() query: any) {
    return this.catalogService.getLots(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get lot details' })
  @ApiResponse({ status: 200, description: 'Lot details' })
  async getLot(@Param('id') id: string) {
    return this.catalogService.getLot(id);
  }
}