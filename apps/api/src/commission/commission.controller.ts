import { Controller, Get, Post, Body, UseGuards, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { CommissionService } from './commission.service';
import { commissionCalculationDtoSchema } from '@st-michael/shared';

@ApiTags('commission')
@Controller('commission')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CommissionController {
  constructor(private readonly commissionService: CommissionService) {}

  @Get('my')
  @ApiOperation({ summary: 'Get my commission info' })
  @ApiResponse({ status: 200, description: 'Commission info with level, rates, progress' })
  async getMyCommission(@CurrentUser() user: CurrentUserPayload) {
    return this.commissionService.getMyCommission(user.id);
  }

  @Get('deals')
  @ApiOperation({ summary: 'Get my commission deal history' })
  @ApiResponse({ status: 200, description: 'List of deals with commissions' })
  async getMyDeals(@CurrentUser() user: CurrentUserPayload) {
    return this.commissionService.getBrokerCommission(user.id);
  }

  @Post('calculate')
  @ApiOperation({ summary: 'Calculate commission for a deal' })
  @ApiResponse({ status: 200, description: 'Calculated commission' })
  async calculateCommission(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const data = commissionCalculationDtoSchema.parse(body) as {
      amount: number;
      project: string;
      paymentMode: 'FULL' | 'INSTALLMENT' | 'SUBSIDIZED_MORTGAGE';
    };
    return this.commissionService.calculateCommission({ ...data, brokerId: user.id });
  }
}
