import { Controller, Get, Patch, Post, Delete, Param, Body, Query, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { UserRole } from '@st-michael/shared';
import { AdminService } from './admin.service';
import { GoogleSheetsSyncService } from './google-sheets-sync.service';

@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
@ApiBearerAuth()
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly gsheets: GoogleSheetsSyncService,
  ) {}

  @Get('brokers')
  @ApiOperation({ summary: 'List all brokers (admin/manager only)' })
  async listBrokers(@Query() query: any) {
    return this.adminService.listBrokers(query);
  }

  @Get('brokers/:id')
  @ApiOperation({ summary: 'Get broker details with stats' })
  async getBroker(@Param('id') id: string) {
    return this.adminService.getBroker(id);
  }

  @Patch('brokers/:id')
  @ApiOperation({ summary: 'Update broker (admin only)' })
  @Roles(UserRole.ADMIN)
  async updateBroker(@Param('id') id: string, @Body() body: any) {
    return this.adminService.updateBroker(id, body);
  }

  @Patch('brokers/:id/role')
  @ApiOperation({ summary: 'Change broker role (admin only)' })
  @Roles(UserRole.ADMIN)
  async changeRole(@Param('id') id: string, @Body() body: { role: 'BROKER' | 'MANAGER' | 'ADMIN' }) {
    return this.adminService.changeRole(id, body.role);
  }

  @Patch('brokers/:id/status')
  @ApiOperation({ summary: 'Change broker status (admin only)' })
  @Roles(UserRole.ADMIN)
  async changeStatus(@Param('id') id: string, @Body() body: { status: 'ACTIVE' | 'BLOCKED' | 'PENDING' }) {
    return this.adminService.changeStatus(id, body.status);
  }

  @Get('brokers/:id/deals')
  @ApiOperation({ summary: 'Get any broker deals' })
  async brokerDeals(@Param('id') id: string, @Query() query: any) {
    return this.adminService.brokerDeals(id, query);
  }

  @Get('brokers/:id/clients')
  @ApiOperation({ summary: 'Get any broker clients' })
  async brokerClients(@Param('id') id: string, @Query() query: any) {
    return this.adminService.brokerClients(id, query);
  }

  @Get('brokers/:id/meetings')
  @ApiOperation({ summary: 'Get any broker meetings' })
  async brokerMeetings(@Param('id') id: string, @Query() query: any) {
    return this.adminService.brokerMeetings(id, query);
  }

  @Patch('brokers/:id/sync-amo')
  @ApiOperation({ summary: 'Trigger amoCRM sync for specific broker' })
  async syncBrokerAmo(@Param('id') id: string) {
    return this.adminService.syncBrokerAmo(id);
  }

  @Delete('brokers/:id')
  @ApiOperation({ summary: 'Delete broker with all related data (admin only)' })
  @Roles(UserRole.ADMIN)
  async deleteBroker(@Param('id') id: string) {
    return this.adminService.deleteBroker(id);
  }

  @Post('brokers/import-from-amo')
  @ApiOperation({ summary: 'Bulk import brokers from amoCRM broker pipeline (10787390)' })
  @Roles(UserRole.ADMIN)
  async importBrokersFromAmo() {
    return this.adminService.importBrokersFromAmo();
  }

  @Post('brokers/import-from-xlsx')
  @ApiOperation({ summary: 'Import brokers from uploaded XLSX file (admin only, TZ v3 §3)' })
  @ApiConsumes('multipart/form-data')
  @Roles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async importBrokersFromXlsx(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: {
      filter?: string;
      callFlag?: string;
      dryRun?: string;
      limit?: string;
      includeCoords?: string;
    },
  ) {
    return this.adminService.importBrokersFromXlsx(file, body);
  }

  @Get('brokers/import-jobs/:id')
  @ApiOperation({ summary: 'Poll import job status (admin only)' })
  @Roles(UserRole.ADMIN)
  async getImportJob(@Param('id') id: string) {
    return this.adminService.getImportJob(id);
  }

  @Post('brokers/amo-coverage')
  @ApiOperation({ summary: 'Dry-run анализ: кого из amoCRM нет в нашей базе (admin only)' })
  @Roles(UserRole.ADMIN)
  async startAmoCoverage() {
    return this.adminService.startAmoCoverageAnalysis();
  }

  // ─── Колл-центр (TZ v3 §5) ─────────────────────────────────────────

  @Get('call-center/queue')
  @ApiOperation({ summary: 'Очередь обзвона: брокеры isInBase=true, отсортированные по приоритету' })
  async callCenterQueue(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    // 2026-06-03: пробрасываем currentUserId для фильтра assignment=mine.
    return this.adminService.getCallCenterQueue({ ...query, currentUserId: user.id });
  }

  @Get('call-center/managers')
  @ApiOperation({ summary: 'Список менеджеров КЦ для дропдауна назначения' })
  async listKcManagers() {
    return this.adminService.listKcManagers();
  }

  @Post('call-center/assign')
  @ApiOperation({ summary: 'Назначить выбранных брокеров на менеджера КЦ' })
  async assignBrokers(@Body() body: { brokerIds: string[]; managerId: string }) {
    return this.adminService.assignBrokersToManager(body.brokerIds || [], body.managerId);
  }

  @Post('call-center/unassign')
  @ApiOperation({ summary: 'Снять назначение менеджера с выбранных брокеров' })
  async unassignBrokers(@Body() body: { brokerIds: string[] }) {
    return this.adminService.unassignBrokers(body.brokerIds || []);
  }

  @Post('call-center/log-call')
  @ApiOperation({ summary: 'Зафиксировать звонок: создаёт CallLog и обновляет category/doNotCall/nextCallAt' })
  async logCall(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: {
      brokerId: string;
      result: string;
      comment?: string;
      campaign?: string;
      duration?: number;
      nextCallAtOverride?: string;
      doNotCallOverride?: boolean;
      brokerTourDate?: string;
    },
  ) {
    return this.adminService.logCall(user.id, body);
  }

  @Get('call-center/stats')
  @ApiOperation({ summary: 'KPI оператора и команды на сегодня/неделю/месяц' })
  async callCenterStats(@CurrentUser() user: CurrentUserPayload) {
    return this.adminService.getCallCenterStats(user.id);
  }

  // A3 fix 2026-05-24: UI решения конфликтов уникальности.
  @Get('uniqueness-conflicts')
  @ApiOperation({ summary: 'Список клиентов в UNDER_REVIEW (конфликт фиксации) с инфой о конкурентном брокере' })
  async uniquenessConflicts() {
    return this.adminService.getUniquenessConflicts();
  }

  // Bug fix 2026-05-25: диагностика amo (живой ли токен).
  // 2026-05-29: ручной триггер синка Я.Диска (помимо ежедневного крона).
  // Возвращает сразу — синк идёт в фоне, лог в server-stdout.
  @Post('yandex-sync')
  @ApiOperation({ summary: 'Запустить синхронизацию материалов с Я.Диска (в фоне)' })
  @Roles(UserRole.ADMIN)
  async yandexSync() {
    return this.adminService.triggerYandexSync();
  }

  @Get('amo-health')
  @ApiOperation({ summary: 'Быстрая проверка amo: токен жив? account отвечает?' })
  async amoHealth() {
    return this.adminService.checkAmoHealth();
  }

  // 2026-07-09: заменяет старый /admin/amo-failed-clients. Показывает
  // все заявки от брокеров (Client + Meeting + Call + OfferAcceptance)
  // с фильтрами по типу, статусу amo, периоду и поиску.
  // Доступ: MANAGER + ADMIN.
  @Get('broker-applications')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Все заявки от брокеров: фиксации, встречи, звонки, акцепты' })
  async brokerApplications(@Query() query: any) {
    return this.adminService.getBrokerApplications({
      page: Number(query.page) || 1,
      limit: Number(query.limit) || 50,
      type: query.type,
      amoStatus: query.amoStatus,
      search: query.search,
      startDate: query.startDate,
      endDate: query.endDate,
    });
  }

  @Post('clients/:id/retry-amo-sync')
  @ApiOperation({ summary: 'Повторить попытку передать заявку в amoCRM' })
  async retryAmoSync(@Param('id') id: string) {
    return this.adminService.retryAmoSync(id);
  }

  // ─── Mailings ─────────────────────────────────────────────

  @Post('mailings/preview')
  @ApiOperation({ summary: 'Preview recipients matching filters' })
  async previewMailing(@Body() body: any) {
    return this.adminService.previewMailing(body?.filters || {});
  }

  @Post('mailings/send')
  @ApiOperation({ summary: 'Send broadcast to filtered brokers' })
  async sendMailing(@CurrentUser() user: CurrentUserPayload, @Body() body: any) {
    return this.adminService.sendMailing(user.id, {
      subject: body.subject,
      body: body.body,
      channels: body.channels,
      filters: body.filters || {},
    });
  }

  @Get('mailings')
  @ApiOperation({ summary: 'List broadcast history' })
  async listMailings(@Query() query: any) {
    return this.adminService.listMailings(query);
  }

  // ─── Meetings (admin-wide) ────────────────────────────────

  @Get('meetings')
  @ApiOperation({ summary: 'List all meetings (admin/manager)' })
  async listAllMeetings(@Query() query: any) {
    return this.adminService.listAllMeetings(query);
  }

  @Patch('meetings/:id/status')
  @ApiOperation({ summary: 'Confirm or cancel a meeting (admin/manager)' })
  async updateMeetingStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { status: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' },
  ) {
    return this.adminService.updateMeetingStatus(id, body.status, user.id);
  }

  // ─── Commission Policies (admin only) ─────────────────────
  // CRUD политик начисления комиссии (PROGRESSIVE/FLAT с периодом действия).
  // Правка 2026-05-13.

  @Get('commission-policies')
  @ApiOperation({ summary: 'List all commission policies' })
  async listCommissionPolicies(@Query() query: any) {
    return this.adminService.listCommissionPolicies(query);
  }

  @Post('commission-policies')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create commission policy (admin only)' })
  async createCommissionPolicy(@Body() body: any) {
    return this.adminService.createCommissionPolicy(body);
  }

  @Patch('commission-policies/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update commission policy (admin only)' })
  async updateCommissionPolicy(@Param('id') id: string, @Body() body: any) {
    return this.adminService.updateCommissionPolicy(id, body);
  }

  @Delete('commission-policies/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete commission policy (admin only)' })
  async deleteCommissionPolicy(@Param('id') id: string) {
    return this.adminService.deleteCommissionPolicy(id);
  }
  // ─── Google Sheets sync (admin only) ─────────────────────
  // 2026-06-09: ручной триггер синка брокерской базы из Google Sheet
  // + статус последнего запуска. Cron каждые 30 мин — в scheduler.
  @Get('gsheets-brokers/status')
  @ApiOperation({ summary: 'Статус последнего синка из Google Sheets' })
  @Roles(UserRole.ADMIN)
  getGSheetsStatus() {
    return this.gsheets.getLastResult();
  }

  @Post('gsheets-brokers/sync-now')
  @ApiOperation({ summary: 'Запустить синк из Google Sheets немедленно (manual)' })
  @Roles(UserRole.ADMIN)
  triggerGSheetsSync() {
    return this.gsheets.sync();
  }

  // ─── Integration settings (admin only) ───────────────────
  // 2026-06-04: KV-настройки для интеграций (Morekit URL и т.п.),
  // которые админ хочет менять из UI без релиза/SSH.
  @Get('integration-settings')
  @ApiOperation({ summary: 'Текущие значения настроек интеграций (с env-fallback)' })
  @Roles(UserRole.ADMIN)
  async getIntegrationSettings() {
    return this.adminService.getIntegrationSettings();
  }

  @Patch('integration-settings/:key')
  @ApiOperation({ summary: 'Обновить настройку интеграции (whitelist ключей)' })
  @Roles(UserRole.ADMIN)
  async updateIntegrationSetting(
    @CurrentUser() user: CurrentUserPayload,
    @Param('key') key: string,
    @Body() body: { value: string },
  ) {
    return this.adminService.updateIntegrationSetting(key, body.value || '', user.id);
  }

  // ─── Reassign client to another broker (manager/admin) ────
  @Patch('clients/:id/reassign-broker')
  @ApiOperation({ summary: 'Передать клиента другому брокеру (manager/admin)' })
  async reassignClient(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { newBrokerId: string; reason: string },
  ) {
    return this.adminService.reassignClient(id, body.newBrokerId, body.reason, user.id);
  }

  // 2026-06-19: пометить/снять флаг «координатор» у брокера. У координатора
  // в форме фиксации становится обязательным выбор реального брокера, ведущего
  // клиента (из брокеров его агентства).
  @Patch('brokers/:id/coordinator')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Пометить брокера как координатора (только ADMIN)' })
  async setBrokerCoordinator(
    @Param('id') id: string,
    @Body() body: { isCoordinator: boolean },
  ) {
    return this.adminService.setBrokerCoordinator(id, !!body.isCoordinator);
  }

  // 2026-06-17: ручная смена uniquenessStatus админом из кабинета брокера.
  // Только для критических случаев — когда автоматика не довела клиента до
  // правильного статуса.
  @Patch('clients/:id/uniqueness-status')
  @ApiOperation({ summary: 'Смена uniquenessStatus клиента (admin only, критические случаи)' })
  async setClientUniquenessStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { status: 'CONDITIONALLY_UNIQUE' | 'UNDER_REVIEW' | 'REJECTED'; reason: string },
  ) {
    return this.adminService.setClientUniquenessStatus(id, body.status, body.reason, user.id);
  }

}
