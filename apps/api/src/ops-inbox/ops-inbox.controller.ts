import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { OpsInboxService } from './ops-inbox.service';

// 2026-09-08: входящие ops-бота техподдержки для рабочей сессии ассистента.
// Доступ — заголовок x-ops-inbox-token (SystemSetting OPS_INBOX_TOKEN).
// Без JWT: сессия ассистента работает вне кабинета; токен длинный и случайный,
// эндпоинт не отдаёт ничего, кроме сообщений самого бота.
@ApiTags('ops-inbox')
@Controller('ops/inbox')
export class OpsInboxController {
  constructor(private readonly inbox: OpsInboxService) {}

  @Get()
  @ApiOperation({ summary: 'Входящие сообщения ops-бота (после указанного id)' })
  async list(
    @Headers('x-ops-inbox-token') token: string | undefined,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    await this.inbox.assertAccess(token);
    return this.inbox.list(after || undefined, Number(limit) || 50);
  }

  @Post('handled')
  @ApiOperation({ summary: 'Отметить сообщения обработанными' })
  async handled(
    @Headers('x-ops-inbox-token') token: string | undefined,
    @Body() body: { ids?: string[] },
  ) {
    await this.inbox.assertAccess(token);
    return this.inbox.markHandled(Array.isArray(body?.ids) ? body.ids.map(String) : []);
  }

  @Post('reply')
  @ApiOperation({ summary: 'Ответить в чат тем же ботом' })
  async reply(
    @Headers('x-ops-inbox-token') token: string | undefined,
    @Body() body: { chatId?: string; text?: string },
  ) {
    await this.inbox.assertAccess(token);
    const chatId = String(body?.chatId || '').trim();
    const text = String(body?.text || '').trim();
    if (!chatId || !text) return { ok: false, error: 'chatId и text обязательны' };
    return this.inbox.reply(chatId, text);
  }

  @Get(':id/file')
  @ApiOperation({ summary: 'Скачать файл из входящего сообщения' })
  async file(
    @Headers('x-ops-inbox-token') token: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.inbox.assertAccess(token);
    const file = await this.inbox.file(id);
    response.setHeader('content-type', file.mimeType);
    response.setHeader(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    return new StreamableFile(file.buffer);
  }
}
