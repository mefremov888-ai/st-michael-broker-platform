import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CommissionService } from './commission.service';

@ApiTags('commission')
@Controller('commission')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CommissionController {
  constructor(private readonly commissionService: CommissionService) {}

  @Get('my')
  @ApiOperation({ summary: 'Get my commission info' })
  @ApiResponse({ status: 200, description: 'Commission info' })
  async getMyCommission() {
    return this.commissionService.getMyCommission();
  }

  @Post('calculate')
  @ApiOperation({ summary: 'Calculate commission' })
  @ApiResponse({ status: 200, description: 'Calculated commission' })
  async calculateCommission(@Body() body: any) {
    return this.commissionService.calculateCommission(body);
  }
}