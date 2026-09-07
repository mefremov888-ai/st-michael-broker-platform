import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { CallerController } from './caller.controller';
import { CallerService } from './caller.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue({ name: 'calls' }),
  ],
  controllers: [CallerController],
  providers: [CallerService],
})
export class CallerModule {}
