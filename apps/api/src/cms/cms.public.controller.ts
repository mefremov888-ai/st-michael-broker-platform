import { Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AmoCrmAdapter } from '@st-michael/integrations';
import { CmsService } from './cms.service';

@ApiTags('public-cms')
@Controller('public/cms')
export class PublicCmsController {
  // 2026-05-27: AmoCrmAdapter напрямую для публичной health-проверки.
  // Не возвращает секреты, только status/error.
  private amo = new AmoCrmAdapter();

  constructor(private readonly cms: CmsService) {}

  // Публичная диагностика amoCRM — без JWT, чтобы можно было быстро
  // проверить через curl или браузер. Не возвращает токен/секреты,
  // только {ok, accountName, error, latencyMs}.
  @Get('amo-health')
  @ApiOperation({ summary: 'Public health-check amoCRM (no auth)' })
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  async publicAmoHealth() {
    const tokenConfigured = !!process.env.AMO_ACCESS_TOKEN;
    if (!tokenConfigured) {
      return { ok: false, tokenConfigured: false, error: 'AMO_ACCESS_TOKEN не настроен в .env' };
    }
    const started = Date.now();
    // 2026-08-17: диагностика блокировки WAF amoCRM по IP — сверяем egress IP
    // сервера с IP домена сайта, чтобы понять какой адрес слать в поддержку.
    const egressIp = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .then((j: any) => j.ip)
      .catch(() => null);
    try {
      const acc = await this.amo.getAccount();
      return {
        ok: true,
        tokenConfigured: true,
        accountName: acc?.name || acc?.subdomain || null,
        accountId: acc?.id || null,
        latencyMs: Date.now() - started,
        egressIp,
      };
    } catch (e: any) {
      return {
        ok: false,
        tokenConfigured: true,
        error: String(e?.message || e).slice(0, 500),
        latencyMs: Date.now() - started,
        egressIp,
      };
    }
  }

  // Cache-Control: no-store — чтобы после правок в /admin/content
  // лендинг сразу видел свежие значения, без задержки от CDN/service worker.
  @Get('content')
  @ApiOperation({ summary: 'All landing content blocks (with defaults if missing)' })
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  async allContent() {
    return this.cms.getAllContent();
  }

  @Get('content/:key')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  async oneBlock(@Param('key') key: string) {
    return { key, value: await this.cms.getContent(key) };
  }

  @Get('events')
  @ApiOperation({ summary: 'Active landing events (defaults to upcoming only)' })
  async events(@Query('all') all?: string) {
    const onlyFuture = all !== '1' && all !== 'true';
    return this.cms.listEvents({ onlyActive: true, onlyFuture });
  }

  @Get('projects')
  @ApiOperation({ summary: 'Active landing projects' })
  async projects() {
    return this.cms.listProjects(true);
  }

  @Get('projects/:slug')
  async projectBySlug(@Param('slug') slug: string) {
    return this.cms.getProjectBySlug(slug);
  }

  @Get('promos')
  @ApiOperation({ summary: 'Active promo slider items' })
  async promos() {
    return this.cms.listPromos(true);
  }

  @Get('news')
  @ApiOperation({ summary: 'Active news cards' })
  async news() {
    return this.cms.listNews(true);
  }

  // Активные политики комиссии по проектам — для динамической шкалы на лендинге.
  // Возвращает активные на сегодня policies: { project, mode, flatRate, levels }.
  // Лендинг сам выбирает что отрисовать: если mode=FLAT — «Фиксированная X%»;
  // если PROGRESSIVE — таблица levels из БД (а не из CMS).
  @Get('commission-policies/active')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  async activeCommissionPolicies() {
    return this.cms.getActiveCommissionPolicies();
  }

  @Post('contact')
  @ApiOperation({ summary: 'Submit contact / lead form (public)' })
  async submitContact(@Body() body: any, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || null;
    const ua = (req.headers['user-agent'] as string) || null;
    const created = await this.cms.createContactRequest(
      {
        name: body?.name,
        phone: body?.phone,
        email: body?.email,
        message: body?.message,
        source: body?.source || 'landing-contact',
        eventId: body?.eventId,
      },
      ip,
      ua,
    );
    return { ok: true, id: created.id };
  }
}
