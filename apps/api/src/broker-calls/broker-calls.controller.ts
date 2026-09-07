import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@st-michael/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { BrokerCallsService } from './broker-calls.service';
import { InitiateBrokerCallDto } from './broker-calls.dto';

@ApiTags('broker-calls')
@Controller('broker-calls')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
@ApiBearerAuth()
export class BrokerCallsController {
  constructor(private readonly svc: BrokerCallsService) {}

  @Post('initiate')
  @ApiOperation({
    summary: 'Сотрудник КЦ звонит клиенту через Mango (внутренний номер)',
  })
  @ApiResponse({ status: 201, description: 'Звонок поставлен в очередь Mango' })
  async initiate(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: InitiateBrokerCallDto,
  ) {
    return this.svc.initiate(user, body.clientId, body.idempotencyKey);
  }

  @Get()
  @ApiOperation({ summary: 'Журнал звонков сотрудника КЦ (фильтр по clientId)' })
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
