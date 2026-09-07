import { Injectable, Inject, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { setAmoTokens, setAmoTokenRefreshHook, getAmoTokens } from '@st-michael/integrations';

/**
 * 2026-06-05: на старте API подтягиваем amoCRM-токены из SystemSetting
 * (с env-fallback) и регистрируем persistence-hook — после refresh новые
 * токены сохраняются в БД.
 *
 * Зачем: без этого access_token живёт ровно сколько ему отпущено amoCRM
 * (от 24 часов до года), потом → 401 в проде → все фиксации в amoSyncStatus=FAILED.
 * С этим — адаптер сам обновляет токен через AMO_REFRESH_TOKEN, новые
 * токены попадают в БД и переживают рестарт контейнера.
 */
@Injectable()
export class AmoTokenBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AmoTokenBootstrapService.name);

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async onApplicationBootstrap(): Promise<void> {
    // 1. Загружаем токены из БД (приоритет над env).
    try {
      const rows = await this.prisma.systemSetting.findMany({
        where: { key: { in: ['AMO_ACCESS_TOKEN', 'AMO_REFRESH_TOKEN'] } },
        select: { key: true, value: true },
      });
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      const dbAccess = byKey.get('AMO_ACCESS_TOKEN') || '';
      const dbRefresh = byKey.get('AMO_REFRESH_TOKEN') || '';
      const envAccess = process.env.AMO_ACCESS_TOKEN || '';
      const envRefresh = process.env.AMO_REFRESH_TOKEN || '';
      const access = dbAccess || envAccess;
      const refresh = dbRefresh || envRefresh;
      if (access || refresh) {
        setAmoTokens(access, refresh);
        this.logger.log(
          `Loaded amo tokens: access=${access ? 'set' : 'EMPTY'} (${dbAccess ? 'DB' : 'env'}), refresh=${refresh ? 'set' : 'EMPTY'} (${dbRefresh ? 'DB' : 'env'})`,
        );
      } else {
        this.logger.warn('AMO tokens not set in DB or env — все amo-операции упадут');
      }
    } catch (e: any) {
      this.logger.warn(`Failed to load amo tokens from DB: ${e?.message || e}. Используем env-fallback.`);
    }

    // 2. Регистрируем persistence hook — на каждый успешный refresh новые
    //    токены сохраняются в SystemSetting, переживая рестарт контейнера.
    setAmoTokenRefreshHook(async (tokens) => {
      try {
        await this.prisma.systemSetting.upsert({
          where: { key: 'AMO_ACCESS_TOKEN' },
          update: { value: tokens.access, updatedBy: 'amo-auto-refresh' },
          create: { key: 'AMO_ACCESS_TOKEN', value: tokens.access, updatedBy: 'amo-auto-refresh' },
        });
        await this.prisma.systemSetting.upsert({
          where: { key: 'AMO_REFRESH_TOKEN' },
          update: { value: tokens.refresh, updatedBy: 'amo-auto-refresh' },
          create: { key: 'AMO_REFRESH_TOKEN', value: tokens.refresh, updatedBy: 'amo-auto-refresh' },
        });
        await this.prisma.auditLog.create({
          data: {
            action: 'AMO_TOKEN_REFRESHED',
            entity: 'SystemSetting',
            entityId: 'AMO_ACCESS_TOKEN',
            payload: { accessLength: tokens.access.length, refreshLength: tokens.refresh.length },
          },
        });
        this.logger.log('amo tokens persisted to DB after refresh');
      } catch (e: any) {
        this.logger.error(`Failed to persist refreshed amo tokens: ${e?.message || e}`);
      }
    });
  }
}
