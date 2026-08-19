import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LoyaltyBaseController } from './loyalty-base.controller';
import { LoyaltyBaseService } from './loyalty-base.service';

@Module({
  imports: [AuthModule],
  controllers: [LoyaltyBaseController],
  providers: [LoyaltyBaseService],
  exports: [LoyaltyBaseService],
})
export class LoyaltyBaseModule {}
