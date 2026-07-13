import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BrokerImportJobsService } from './broker-import-jobs.service';
import { GoogleSheetsSyncService } from './google-sheets-sync.service';
import { DatabaseModule } from '../database/database.module';
import { AmocrmModule } from '../amocrm/amocrm.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    DatabaseModule,
    AmocrmModule,
    AuthModule,
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  controllers: [AdminController],
  providers: [AdminService, BrokerImportJobsService, GoogleSheetsSyncService],
  // 2026-07-06: AdminService экспортируется — SchedulerService дёргает его
  // importBrokersFromAmo раз в сутки (см. handleAmoBrokersSync).
  exports: [GoogleSheetsSyncService, AdminService],
})
export class AdminModule {}
