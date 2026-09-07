import {
  Body, Controller, Get, Header, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '@st-michael/shared';
import { OfferService } from './offer.service';

@ApiTags('offer')
@Controller('offer')
export class OfferController {
  constructor(private readonly offerService: OfferService) {}

  @Get('current')
  async getCurrent() {
    return this.offerService.getCurrent();
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('my')
  async myAcceptance(@CurrentUser() user: CurrentUserPayload) {
    return this.offerService.getMyAcceptance(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('accept')
  async accept(@CurrentUser() user: CurrentUserPayload, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || null;
    const ua = (req.headers['user-agent'] as string) || null;
    return this.offerService.accept(user.id, ip, ua);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('my/document')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async myDocument(@CurrentUser() user: CurrentUserPayload, @Res() res: Response) {
    const html = await this.offerService.getSignedDocumentHtml(user.id);
    res.send(html);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @Post('admin/update')
  async update(@CurrentUser() user: CurrentUserPayload, @Body() body: any) {
    return this.offerService.updateCurrent(
      { title: body.title, body: body.body, version: body.version },
      user.id,
    );
  }
}
