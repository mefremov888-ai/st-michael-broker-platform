import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';
import { SchedulerService } from './scheduler.service';
import { DatabaseModule } from '../database/database.module';
import { CatalogModule } from '../catalog/catalog.module';
import { AdminModule } from '../admin/admin.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { CmsModule } from '../cms/cms.module';
import { AmoFixationPhoneLockModule } from '../common/amo-fixation-phone-lock.module';
import { ClientFixationModule } from '../client-fixation/client-fixation.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    CatalogModule,
    // 2026-06-09: scheduler дёргает GoogleSheetsSyncService раз в 30 мин.
    AdminModule,
    AmocrmModule,
    // 2026-08-12: CmsService нужен для syncNewsFromStm в handleStmNewsSync.
    CmsModule,
    AmoFixationPhoneLockModule,
    // 2026-08-31: крон сам заводит контакт брокера в amoCRM, иначе фиксация
    // висит в очереди до ручного провижининга.
    ClientFixationModule,
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
