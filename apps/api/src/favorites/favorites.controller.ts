import { Controller, Get, Post, Delete, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { FavoritesService } from './favorites.service';

@ApiTags('favorites')
@Controller('favorites')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get()
  @ApiOperation({ summary: 'Список избранных лотов брокера' })
  @ApiResponse({ status: 200, description: 'Массив { lot, addedAt }' })
  async list(@CurrentUser() user: CurrentUserPayload) {
    return this.favoritesService.list(user.id);
  }

  @Get('ids')
  @ApiOperation({ summary: 'Только ID избранных лотов (для быстрой подсветки в каталоге)' })
  async listIds(@CurrentUser() user: CurrentUserPayload) {
    return this.favoritesService.listIds(user.id);
  }

  @Post(':lotId')
  @ApiOperation({ summary: 'Добавить лот в избранное' })
  async add(@CurrentUser() user: CurrentUserPayload, @Param('lotId') lotId: string) {
    return this.favoritesService.add(user.id, lotId);
  }

  @Delete(':lotId')
  @ApiOperation({ summary: 'Убрать лот из избранного' })
  async remove(@CurrentUser() user: CurrentUserPayload, @Param('lotId') lotId: string) {
    return this.favoritesService.remove(user.id, lotId);
  }
}
