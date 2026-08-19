import { Module } from '@nestjs/common';
import { BrokerCallsController } from './broker-calls.controller';
import { BrokerCallsService } from './broker-calls.service';
import { DatabaseModule } from '../database/database.module';
import { MangoCallSafetyModule } from '../common/mango-call-safety.module';

@Module({
  imports: [DatabaseModule, MangoCallSafetyModule],
  controllers: [BrokerCallsController],
  providers: [BrokerCallsService],
})
export class BrokerCallsModule {}
