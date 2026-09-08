import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OpsInboxController } from './ops-inbox.controller';
import { OpsInboxService } from './ops-inbox.service';

// 2026-09-08: входящие ops-бота техподдержки (ответы владельца/Анны) →
// таблица ops_inbox_messages → рабочая сессия ассистента.
@Module({
  imports: [ConfigModule],
  controllers: [OpsInboxController],
  providers: [OpsInboxService],
  exports: [OpsInboxService],
})
export class OpsInboxModule {}
