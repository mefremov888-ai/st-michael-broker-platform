import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  controllers: [MeetingsController],
  providers: [MeetingsService],
})
export class MeetingsModule {}