import { Controller, Get, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DealsService } from './deals.service';

@ApiTags('deals')
@Controller('deals')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Get()
  @ApiOperation({ summary: 'Get broker deals' })
  @ApiResponse({ status: 200, description: 'List of deals' })
  async getDeals() {
    return this.dealsService.getDeals();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get deal details' })
  @ApiResponse({ status: 200, description: 'Deal details' })
  async getDeal(@Param('id') id: string) {
    return this.dealsService.getDeal(id);
  }

  @Patch(':id/attach-agency')
  @ApiOperation({ summary: 'Attach agency to deal' })
  @ApiResponse({ status: 200, description: 'Agency attached' })
  async attachAgency(@Param('id') id: string, @Body() body: any) {
    return this.dealsService.attachAgency(id, body);
  }
}