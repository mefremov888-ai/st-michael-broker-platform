import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AgenciesService } from './agencies.service';

@ApiTags('public-agencies')
@Controller('public/agencies')
export class AgenciesController {
  constructor(private readonly agencies: AgenciesService) {}

  // Поиск-подсказки по началу ИНН для формы регистрации.
  // Возвращает массив { inn, name, fullName, type, status, address }.
  // Если ключ DADATA_API_KEY не задан — пустой массив (UI просто не покажет
  // dropdown, форма работает как раньше).
  @Get('suggest')
  @ApiOperation({ summary: 'Подсказки юр.лиц/ИП по началу ИНН (Dadata)' })
  @Header('Cache-Control', 'no-store')
  async suggest(@Query('q') q?: string) {
    return this.agencies.suggest(q || '');
  }
}
