import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bull';
import { AuthModule } from './auth/auth.module';
import { ClientFixationModule } from './client-fixation/client-fixation.module';
import { CatalogModule } from './catalog/catalog.module';
import { DealsModule } from './deals/deals.module';
import { CommissionModule } from './commission/commission.module';
import { MeetingsModule } from './meetings/meetings.module';
import { CallerModule } from './caller/caller.module';
import { NotificationModule } from './notification/notification.module';
import { DocumentsModule } from './documents/documents.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './audit/audit.module';
import { HealthController } from './health.controller';
import { SchedulerModule } from './scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1 minute
        limit: 100, // requests per ttl
      },
    ]),
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
    }),
    DatabaseModule,
    AuditModule,
    AuthModule,
    ClientFixationModule,
    CatalogModule,
    DealsModule,
    CommissionModule,
    MeetingsModule,
    CallerModule,
    NotificationModule,
    DocumentsModule,
    AnalyticsModule,
    WebhooksModule,
    SchedulerModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}