import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { HEALTH_REDIS_QUEUE } from './health.constants';
import { HealthService } from './health.service';

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue({ name: HEALTH_REDIS_QUEUE }),
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
