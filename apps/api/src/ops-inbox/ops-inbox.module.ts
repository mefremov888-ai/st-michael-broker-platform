import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OpsInboxController } from './ops-inbox.controller';
import { OpsInboxService } from './ops-inbox.service';
import { TelegramNewsModule } from '../telegram-news/telegram-news.module';

// 2026-09-08: входящие ops-бота техподдержки (ответы владельца/Анны) →
// таблица ops_inbox_messages → рабочая сессия ассистента.
// 2026-09-29: тот же опрос отдаёт посты Telegram-канала в TelegramNewsModule.
@Module({
  imports: [ConfigModule, TelegramNewsModule],
  controllers: [OpsInboxController],
  providers: [OpsInboxService],
  exports: [OpsInboxService],
})
export class OpsInboxModule {}
