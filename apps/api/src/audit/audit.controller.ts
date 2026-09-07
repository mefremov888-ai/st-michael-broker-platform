import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { AuditService } from './audit.service';
import { UserRole } from '@st-michael/shared';

@ApiTags('audit')
@Controller('audit')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('my')
  @ApiOperation({ summary: 'Get my audit logs' })
  @ApiResponse({ status: 200, description: 'Paginated audit logs' })
  async getMyLogs(@CurrentUser() user: CurrentUserPayload, @Query() query: any) {
    return this.auditService.getByUser(user.id, query);
  }

  @Get('recent')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get recent audit logs (manager only)' })
  @ApiResponse({ status: 200, description: 'Recent audit logs' })
  async getRecent(@Query('limit') limit?: string) {
    return this.auditService.getRecent(limit ? parseInt(limit) : 50);
  }

  @Get('entity/:entity/:entityId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get audit logs for entity (manager only)' })
  @ApiResponse({ status: 200, description: 'Entity audit logs' })
  async getByEntity(@Param('entity') entity: string, @Param('entityId') entityId: string) {
    return this.auditService.getByEntity(entity, entityId);
  }
}
