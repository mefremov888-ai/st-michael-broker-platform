import { Controller, Post, Body, BadRequestException, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ClientFixationService } from './client-fixation.service';
import { FixationFailureInterceptor } from './fixation-failure.interceptor';

@ApiTags('clients')
@Controller('public/quick-fix')
export class QuickFixController {
  constructor(private readonly clientFixationService: ClientFixationService) {}

  @Post()
  @UseInterceptors(FixationFailureInterceptor)
  @ApiOperation({ summary: 'Public quick fixation from landing page' })
  async quickFix(@Body() body: any) {
    const clientPhone = String(body?.clientPhone || '').trim();
    const clientFullName = String(body?.clientFullName || '').trim();
    const brokerPhone = String(body?.brokerPhone || '').trim();

    if (!clientPhone || !clientFullName || !brokerPhone) {
      throw new BadRequestException('Все поля обязательны');
    }

    return this.clientFixationService.quickFix({ clientPhone, clientFullName, brokerPhone });
  }
}
