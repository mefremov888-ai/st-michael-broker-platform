import { Controller, Post, Get, Patch, Body, Param, UseGuards, Query, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { ClientFixationService } from './client-fixation.service';
import {
  fixClientDtoSchema,
  extendUniquenessDtoSchema,
  resolveUniquenessDtoSchema,
  paginationQuerySchema,
} from '@st-michael/shared';
import { UserRole, UniquenessStatus, Project } from '@st-michael/shared';

@ApiTags('clients')
@Controller('clients')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ClientFixationController {
  constructor(private readonly clientFixationService: ClientFixationService) {}

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Import clients from Excel file' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'Import result' })
  async importClients(
    @CurrentUser() user: CurrentUserPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Файл не загружен');
    return this.clientFixationService.importClients(user.id, file.buffer);
  }

  @Post('fix')
  @ApiOperation({ summary: 'Fix client uniqueness' })
  @ApiResponse({ status: 201, description: 'Client fixed successfully' })
  async fixClient(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    const data = fixClientDtoSchema.parse(body) as any;
    return this.clientFixationService.fixClient(user.id, data);
  }

  // 2026-06-19: список коллег по агентству — для координаторов в форме фиксации,
  // чтобы они выбирали реального брокера, ведущего клиента.
  @Get('agency-colleagues')
  @ApiOperation({ summary: 'Brokers from same agencies as the current user (for coordinator workflow)' })
  async getAgencyColleagues(
    @CurrentUser() user: CurrentUserPayload,
    @Query('search') search?: string,
  ) {
    return this.clientFixationService.getAgencyColleagues(user.id, search || '');
  }

  // 2026-06-29 (refactor): список агентств брокера — для формы создания
  // нового брокера в разделе «Брокер» формы фиксации.
  @Get('my-agencies')
  @ApiOperation({ summary: 'Agencies of the current broker (for new-broker form)' })
  async getMyAgencies(@CurrentUser() user: CurrentUserPayload) {
    return this.clientFixationService.getMyAgencies(user.id);
  }

  // 2026-06-29 (refactor): любой брокер может создать нового брокера
  // прямо из формы фиксации, выбрав «Фиксирую на другого». Новый
  // привязывается к выбранному агентству создателя.
  @Post('create-new-broker')
  @ApiOperation({ summary: 'Create a new broker (auto-assigned to creator primary agency)' })
  async createNewBroker(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { fullName?: string; phone?: string; email?: string },
  ) {
    const fullName = String(body?.fullName || '').trim();
    const phone = String(body?.phone || '').trim();
    const email = body?.email ? String(body.email).trim() : undefined;
    if (!fullName || fullName.length < 2) {
      throw new BadRequestException({ message: 'Введите ФИО', field: 'fullName' });
    }
    if (!/^\+7\d{10}$/.test(phone)) {
      throw new BadRequestException({ message: 'Телефон должен быть в формате +7XXXXXXXXXX', field: 'phone' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException({ message: 'Неверный формат email', field: 'email' });
    }
    // 2026-07-01: agencyId и customInn убраны — бэк сам подставит primary
    // агентство того кто фиксирует.
    return this.clientFixationService.createBrokerByCreator(user.id, { fullName, phone, email });
  }

  @Get()
  @ApiOperation({ summary: 'Get broker clients' })
  @ApiResponse({ status: 200, description: 'List of clients' })
  async getClients(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    const pagination = paginationQuerySchema.parse(query);
    return this.clientFixationService.getClients(user.id, {
      ...pagination,
      status: query.status,
      project: query.project,
      search: query.search,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get client details' })
  @ApiResponse({ status: 200, description: 'Client details' })
  async getClient(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.clientFixationService.getClient(id, user.id);
  }

  @Post(':id/extend')
  @ApiOperation({ summary: 'Extend uniqueness period' })
  @ApiResponse({ status: 200, description: 'Uniqueness extended' })
  async extendUniqueness(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = extendUniquenessDtoSchema.parse(body) as { reason: string; comment?: string };
    return this.clientFixationService.extendUniqueness(id, user.id, data);
  }

  @Patch(':id/fix')
  @ApiOperation({ summary: 'Mark client as fixed' })
  @ApiResponse({ status: 200, description: 'Client marked as fixed' })
  async markFixed(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.clientFixationService.markFixed(id, user.id);
  }

  @Patch(':id/resolve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Resolve uniqueness conflict (manager only)' })
  @ApiResponse({ status: 200, description: 'Conflict resolved' })
  async resolveUniqueness(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = resolveUniquenessDtoSchema.parse(body) as { status: UniquenessStatus; reason: string };
    return this.clientFixationService.resolveUniqueness(id, user.id, data);
  }
}
