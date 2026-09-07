import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

// 2026-07-03: verbose 'query' + 'info' логи отключены в проде.
// Причина: gsheets-sync (*/30 min) делает 10K SELECT + 10K UPDATE
// за ~100 сек и каждый пишется в docker-json-log. Замер 2026-07-03
// показал: во время cron'а api/health отвечает 4.7 сек вместо 80 мс —
// docker-log-writer тормозит event loop. Логи api вырастают до 900+ MB
// за 11 часов. При PRISMA_LOG=verbose можно вернуть локально для отладки.
const prismaProvider = {
  provide: 'PrismaClient',
  useFactory: () => {
    const verbose = process.env.PRISMA_LOG === 'verbose'
      || (process.env.NODE_ENV !== 'production' && process.env.PRISMA_LOG !== 'quiet');
    const prisma = new PrismaClient({
      log: verbose ? ['query', 'info', 'warn', 'error'] : ['warn', 'error'],
    });
    return prisma;
  },
};

@Global()
@Module({
  providers: [prismaProvider],
  exports: ['PrismaClient'],
})
export class DatabaseModule {}