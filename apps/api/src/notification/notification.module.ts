import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { NotificationService } from './notification.service';
import { NotificationProcessor } from './notification.processor';
import { NotificationController } from './notification.controller';
import { DatabaseModule } from '../database/database.module';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [
    DatabaseModule,
    // 2026-09-24: канал SMS уходит через СМС Центр (только утверждённые виды).
    SmsModule,
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationProcessor],
  exports: [NotificationService],
})
export class NotificationModule {}
