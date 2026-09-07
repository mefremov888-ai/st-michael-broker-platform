import { Injectable, Inject, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { setMangoConfig } from '@st-michael/integrations';

/**
 * 2026-06-08: на старте API подтягиваем Mango-конфигурацию из SystemSetting
 * (с env-fallback). Логика та же что и для AmoTokenBootstrapService.
 *
 * Зачем: позволяем менять API-ключ / salt / URL Mango из админ-UI без
 * SSH и рестарта. После сохранения через /admin/integrations adapter
 * сразу подхватывает новое значение.
 */
@Injectable()
export class MangoBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MangoBootstrapService.name);

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const rows = await this.prisma.systemSetting.findMany({
        where: {
          key: {
            in: [
              'MANGO_API_KEY',
              'MANGO_API_SALT',
              'MANGO_API_URL',
              'MANGO_CALLBACK_URL',
              'MANGO_OUTBOUND_LINE',
            ],
          },
        },
        select: { key: true, value: true },
      });
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      const cfg: Partial<{
        apiKey: string;
        apiSalt: string;
        apiUrl: string;
        callbackUrl: string;
        outboundLine: string;
      }> = {};
      if (byKey.get('MANGO_API_KEY')) cfg.apiKey = byKey.get('MANGO_API_KEY');
      if (byKey.get('MANGO_API_SALT')) cfg.apiSalt = byKey.get('MANGO_API_SALT');
      if (byKey.get('MANGO_API_URL')) cfg.apiUrl = byKey.get('MANGO_API_URL');
      if (byKey.get('MANGO_CALLBACK_URL')) cfg.callbackUrl = byKey.get('MANGO_CALLBACK_URL');
      if (byKey.get('MANGO_OUTBOUND_LINE')) cfg.outboundLine = byKey.get('MANGO_OUTBOUND_LINE');
      if (Object.keys(cfg).length > 0) {
        setMangoConfig(cfg);
        this.logger.log(
          `Loaded Mango config from DB: ${Object.keys(cfg).join(', ')}`,
        );
      } else {
        this.logger.log('Mango config: используем env (в БД нет)');
      }
    } catch (e: any) {
      this.logger.warn(`Failed to load Mango config from DB: ${e?.message || e}`);
    }
  }
}
