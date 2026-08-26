import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ClientFixationController } from './client-fixation.controller';
import { QuickFixController } from './quick-fix.controller';
import { ClientFixationService } from './client-fixation.service';
import { DatabaseModule } from '../database/database.module';
import { AmoCrmAdapter } from '@st-michael/integrations';
import { FixationFailureInterceptor } from './fixation-failure.interceptor';
import { ClientFixationSafetyService } from './client-fixation-safety.service';
import { AmoFixationPhoneLockModule } from '../common/amo-fixation-phone-lock.module';

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue({ name: 'notifications' }),
    AmoFixationPhoneLockModule,
  ],
  controllers: [ClientFixationController, QuickFixController],
  providers: [
    ClientFixationService,
    ClientFixationSafetyService,
    AmoCrmAdapter,
    FixationFailureInterceptor,
  ],
  exports: [ClientFixationService],
})
export class ClientFixationModule {}
