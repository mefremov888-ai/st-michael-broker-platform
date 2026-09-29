import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramNewsService } from './telegram-news.service';

// 2026-09-29: посты закрытого Telegram-канала компании → landing_news
// (блок «Новости» на лендинге). Апдейты приходят из поллера OpsInboxService.
@Module({
  imports: [ConfigModule],
  providers: [TelegramNewsService],
  exports: [TelegramNewsService],
})
export class TelegramNewsModule {}
