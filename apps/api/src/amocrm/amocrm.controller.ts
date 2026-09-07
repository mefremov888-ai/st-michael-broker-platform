import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@st-michael/shared';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { AmocrmService } from './amocrm.service';

@ApiTags('amocrm')
@Controller('amocrm')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AmocrmController {
  constructor(private readonly amocrmService: AmocrmService) {}

  // Диагностический эндпоинт: возвращает raw lead JSON с custom_fields_values.
  // Только админ. Нужен для аудита полей amoCRM (sqm, цена и т.д.). Правка 2026-05-12.
  @Get('inspect-lead/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin: inspect raw amoCRM lead by id (with all custom fields)' })
  async inspectLead(@Param('id') id: string) {
    return this.amocrmService.inspectLead(Number(id));
  }

  @Post('sync-my-deals')
  @ApiOperation({ summary: 'Pull all deals/clients from amoCRM linked to current broker' })
  async syncMyDeals(@CurrentUser() user: CurrentUserPayload) {
    return this.amocrmService.syncMyDealsAndClients(user.id);
  }

  @Get('account')
  @ApiOperation({ summary: 'Get amoCRM account info (test connection)' })
  async getAccount() {
    return this.amocrmService.getAccount();
  }

  @Get('pipelines')
  @ApiOperation({ summary: 'Get all pipelines' })
  async getPipelines() {
    return this.amocrmService.getPipelines();
  }

  @Get('contact-fields')
  @ApiOperation({ summary: 'Get contact custom fields' })
  async getContactFields() {
    return this.amocrmService.getContactFields();
  }

  @Get('company-fields')
  @ApiOperation({ summary: 'Get company custom fields' })
  async getCompanyFields() {
    return this.amocrmService.getCompanyFields();
  }

  @Get('users')
  @ApiOperation({ summary: 'Get amoCRM users (managers/brokers)' })
  async getUsers() {
    return this.amocrmService.getUsers();
  }

  @Post('sync-broker-by-phone')
  @ApiOperation({ summary: 'Find broker contact in amoCRM by phone, return linked deals/clients' })
  async syncBroker(@Body() body: { phone: string; brokerId?: string; inn?: string }) {
    return this.amocrmService.syncBrokerByPhone(body.phone, body.brokerId, body.inn);
  }
}
