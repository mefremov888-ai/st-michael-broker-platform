import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { BrokerCallsService } from './broker-calls.service';
import { InitiateBrokerCallDto } from './broker-calls.dto';

@ApiTags('broker-calls')
@Controller('broker-calls')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BrokerCallsController {
  constructor(private readonly svc: BrokerCallsService) {}

  @Post('initiate')
  @ApiOperation({ summary: 'Брокер инициирует callback клиенту через Mango' })
  @ApiResponse({ status: 201, description: 'Звонок поставлен в очередь Mango' })
  async initiate(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: InitiateBrokerCallDto,
  ) {
    return this.svc.initiate(user.id, body.clientId, body.idempotencyKey);
  }

  @Get()
  @ApiOperation({ summary: 'Журнал звонков брокера (фильтр по clientId)' })
  async getCalls(
    @CurrentUser() user: CurrentUserPayload,
    @Query('clientId') clientId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.getCalls(user.id, {
      clientId,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
