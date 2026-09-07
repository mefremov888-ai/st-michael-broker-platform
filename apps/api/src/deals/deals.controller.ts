import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { DealsService } from './deals.service';
import {
  createDealDtoSchema,
  updateDealDtoSchema,
  attachAgencyDtoSchema,
  paginationQuerySchema,
} from '@st-michael/shared';
import { UserRole } from '@st-michael/shared';

@ApiTags('deals')
@Controller('deals')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Get()
  @ApiOperation({ summary: 'Get broker deals' })
  @ApiResponse({ status: 200, description: 'Paginated list of deals' })
  async getDeals(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    const pagination = paginationQuerySchema.parse(query);
    return this.dealsService.getDeals(user.id, {
      ...pagination,
      status: query.status,
      project: query.project,
    });
  }

  // KPI-сводка по ВСЕМ сделкам брокера (правка #2 из аудита 2026-05-22).
  // Раньше /deals UI считал totalAmount по limit=100 сделок — у активного
  // брокера с >100 сделок цифра врала. Этот endpoint считает агрегаты
  // на стороне БД без лимита.
  @Get('summary')
  @ApiOperation({ summary: 'KPI summary по всем сделкам брокера (без пагинации)' })
  async getDealsSummary(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    return this.dealsService.getDealsSummary(user.id, {
      status: query.status,
      project: query.project,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get deal details' })
  @ApiResponse({ status: 200, description: 'Deal details' })
  async getDeal(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.dealsService.getDeal(id, user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new deal' })
  @ApiResponse({ status: 201, description: 'Deal created' })
  async createDeal(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    const data = createDealDtoSchema.parse(body) as any;
    return this.dealsService.createDeal(user.id, data);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update deal' })
  @ApiResponse({ status: 200, description: 'Deal updated' })
  async updateDeal(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = updateDealDtoSchema.parse(body) as any;
    return this.dealsService.updateDeal(id, user.id, data);
  }

  @Patch(':id/attach-agency')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Attach agency to deal (manager only)' })
  @ApiResponse({ status: 200, description: 'Agency attached' })
  async attachAgency(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = attachAgencyDtoSchema.parse(body) as { agencyId: string; reason: string };
    return this.dealsService.attachAgency(id, user.id, data);
  }
}
