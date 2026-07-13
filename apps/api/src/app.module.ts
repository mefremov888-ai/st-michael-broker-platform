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
import { BrokerCallsModule } from './broker-calls/broker-calls.module';
import { NotificationModule } from './notification/notification.module';
import { DocumentsModule } from './documents/documents.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './audit/audit.module';
import { HealthController } from './health.controller';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AmocrmModule } from './amocrm/amocrm.module';
import { AdminModule } from './admin/admin.module';
import { CmsModule } from './cms/cms.module';
import { OfferModule } from './offer/offer.module';
import { PrivacyModule } from './privacy/privacy.module';
import { FavoritesModule } from './favorites/favorites.module';
import { AgenciesModule } from './agencies/agencies.module';
import { AmoTokenBootstrapService } from './common/amo-token-bootstrap.service';
import { MangoBootstrapService } from './common/mango-bootstrap.service';

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
    BrokerCallsModule,
    NotificationModule,
    DocumentsModule,
    AnalyticsModule,
    WebhooksModule,
    SchedulerModule,
    AmocrmModule,
    AdminModule,
    CmsModule,
    OfferModule,
    PrivacyModule,
    FavoritesModule,
    AgenciesModule,
  ],
  controllers: [HealthController],
  providers: [AmoTokenBootstrapService, MangoBootstrapService],
})
export class AppModule {}