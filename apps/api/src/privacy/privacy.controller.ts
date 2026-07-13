import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { PrivacyService } from './privacy.service';

@ApiTags('privacy')
@Controller('privacy')
export class PrivacyController {
  constructor(private readonly privacyService: PrivacyService) {}

  @Get('current')
  async getCurrent() {
    return this.privacyService.getCurrent();
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('my')
  async myAcceptance(@CurrentUser() user: CurrentUserPayload) {
    return this.privacyService.getMyAcceptance(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('accept')
  async accept(@CurrentUser() user: CurrentUserPayload, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || null;
    const ua = (req.headers['user-agent'] as string) || null;
    return this.privacyService.accept(user.id, ip, ua);
  }
}
