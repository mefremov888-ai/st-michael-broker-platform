import { Module } from '@nestjs/common';
import { ClientFixationController } from './client-fixation.controller';
import { ClientFixationService } from './client-fixation.service';
import { DatabaseModule } from '../database/database.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [DatabaseModule, NotificationModule],
  controllers: [ClientFixationController],
  providers: [ClientFixationService],
  exports: [ClientFixationService],
})
export class ClientFixationModule {}