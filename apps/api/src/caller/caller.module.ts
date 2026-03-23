import { Module } from '@nestjs/common';
import { CallerController } from './caller.controller';
import { CallerService } from './caller.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [CallerController],
  providers: [CallerService],
})
export class CallerModule {}