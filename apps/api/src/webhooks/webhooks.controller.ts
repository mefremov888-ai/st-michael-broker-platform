import { Controller, Post, Body, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('amo/lead-update')
  @ApiOperation({ summary: 'amoCRM lead update webhook' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  async amoLeadUpdate(@Body() body: any, @Headers() headers: any) {
    return this.webhooksService.handleAmoLeadUpdate(body, headers);
  }

  @Post('amo/contact-update')
  @ApiOperation({ summary: 'amoCRM contact update webhook' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  async amoContactUpdate(@Body() body: any, @Headers() headers: any) {
    return this.webhooksService.handleAmoContactUpdate(body, headers);
  }

  @Post('mango/call-result')
  @ApiOperation({ summary: 'Mango call result webhook' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  async mangoCallResult(@Body() body: any, @Headers() headers: any) {
    return this.webhooksService.handleMangoCallResult(body, headers);
  }

  @Post('profitbase/lot-update')
  @ApiOperation({ summary: 'Profitbase lot update webhook' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  async profitbaseLotUpdate(@Body() body: any, @Headers() headers: any) {
    return this.webhooksService.handleProfitbaseLotUpdate(body, headers);
  }
}