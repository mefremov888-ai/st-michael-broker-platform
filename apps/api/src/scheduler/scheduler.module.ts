import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';
import { SchedulerService } from './scheduler.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
