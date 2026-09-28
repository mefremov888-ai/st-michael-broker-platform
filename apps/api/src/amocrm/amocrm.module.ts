import { Module } from '@nestjs/common';
import { AmocrmController } from './amocrm.controller';
import { AmocrmService } from './amocrm.service';
import { AmoTouchSyncService } from './amo-touch-sync.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [AmocrmController],
  // 2026-09-28: ночной синк касаний amo → BrokerAmoContactSync (крон в scheduler).
  providers: [AmocrmService, AmoTouchSyncService],
  exports: [AmocrmService, AmoTouchSyncService],
})
export class AmocrmModule {}
