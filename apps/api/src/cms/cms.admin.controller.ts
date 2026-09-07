import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@st-michael/shared';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { CmsService } from './cms.service';

@ApiTags('admin-cms')
@Controller('admin/cms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
@ApiBearerAuth()
export class AdminCmsController {
  constructor(private readonly cms: CmsService) {}

  // ─── Content blocks ─────────────────────

  @Get('content')
  @ApiOperation({ summary: 'List all content blocks' })
  async list() {
    return this.cms.getAllContent();
  }

  @Get('content/:key')
  async getBlock(@Param('key') key: string) {
    return { key, value: await this.cms.getContent(key) };
  }

  @Patch('content/:key')
  @ApiOperation({ summary: 'Upsert content block' })
  // 2026-05-26: расширил роли — раньше только ADMIN, что вызывало 403
  // когда MANAGER пытался сохранить через /admin/content. Теперь MANAGER тоже
  // может править блоки (история правок всё фиксирует — кто и когда менял).
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async upsert(
    @Param('key') key: string,
    @Body() body: { value: any },
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.cms.upsertContent(key, body.value, user?.id);
  }

  // КБ6 #45 (2026-05-25): история правок CMS-блока.
  @Get('content/:key/history')
  @ApiOperation({ summary: 'История правок блока (последние 50)' })
  async listRevisions(@Param('key') key: string) {
    return this.cms.listRevisions(key);
  }

  @Post('content/revisions/:id/restore')
  @ApiOperation({ summary: 'Откатить блок к выбранной revision' })
  @Roles(UserRole.ADMIN)
  async restoreRevision(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.cms.restoreRevision(id, user?.id);
  }

  // ─── Events ─────────────────────────────

  @Get('events')
  async listEvents(@Query('all') all?: string) {
    return this.cms.listEvents({ onlyActive: false, onlyFuture: all !== '1' });
  }

  @Post('events')
  @Roles(UserRole.ADMIN)
  async createEvent(@Body() body: any) {
    return this.cms.createEvent(body);
  }

  @Patch('events/:id')
  @Roles(UserRole.ADMIN)
  async updateEvent(@Param('id') id: string, @Body() body: any) {
    return this.cms.updateEvent(id, body);
  }

  @Delete('events/:id')
  @Roles(UserRole.ADMIN)
  async deleteEvent(@Param('id') id: string) {
    return this.cms.deleteEvent(id);
  }

  // ─── Projects ───────────────────────────

  @Get('projects')
  async listProjects() {
    return this.cms.listProjects(false);
  }

  @Post('projects')
  @Roles(UserRole.ADMIN)
  async createProject(@Body() body: any) {
    return this.cms.createProject(body);
  }

  @Patch('projects/:id')
  @Roles(UserRole.ADMIN)
  async updateProject(@Param('id') id: string, @Body() body: any) {
    return this.cms.updateProject(id, body);
  }

  @Delete('projects/:id')
  @Roles(UserRole.ADMIN)
  async deleteProject(@Param('id') id: string) {
    return this.cms.deleteProject(id);
  }

  // ─── Promos ─────────────────────────────

  @Get('promos')
  async listPromos() {
    return this.cms.listPromos(false);
  }

  @Post('promos')
  @Roles(UserRole.ADMIN)
  async createPromo(@Body() body: any) {
    return this.cms.createPromo(body);
  }

  @Patch('promos/:id')
  @Roles(UserRole.ADMIN)
  async updatePromo(@Param('id') id: string, @Body() body: any) {
    return this.cms.updatePromo(id, body);
  }

  @Delete('promos/:id')
  @Roles(UserRole.ADMIN)
  async deletePromo(@Param('id') id: string) {
    return this.cms.deletePromo(id);
  }

  // ─── News ─────────────────────────────

  @Get('news')
  async listNews() {
    return this.cms.listNews(false);
  }

  @Post('news')
  @Roles(UserRole.ADMIN)
  async createNews(@Body() body: any) {
    return this.cms.createNews(body);
  }

  @Patch('news/:id')
  @Roles(UserRole.ADMIN)
  async updateNews(@Param('id') id: string, @Body() body: any) {
    return this.cms.updateNews(id, body);
  }

  @Delete('news/:id')
  @Roles(UserRole.ADMIN)
  async deleteNews(@Param('id') id: string) {
    return this.cms.deleteNews(id);
  }

  // 2026-08-12: ручной запуск синка новостей с stmichael.ru
  @Post('news/sync-stm')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async syncNewsFromStm() {
    return this.cms.syncNewsFromStm();
  }

  // ─── Contact requests ──────────────────

  @Get('contact-requests')
  async listContactRequests(@Query() query: any) {
    return this.cms.listContactRequests(query);
  }

  @Patch('contact-requests/:id/processed')
  async markProcessed(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.cms.markContactProcessed(id, user.id);
  }

  // ─── Bootstrap ──────────────────────────

  @Post('seed-defaults')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Insert default landing content if missing (idempotent)' })
  async seedDefaults() {
    return this.cms.seedDefaults();
  }
}
