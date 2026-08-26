import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import {
  AMO_FIXATION_PHONE_LOCK_QUEUE,
  AmoFixationPhoneLockService,
} from "./amo-fixation-phone-lock.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: AMO_FIXATION_PHONE_LOCK_QUEUE }),
  ],
  providers: [AmoFixationPhoneLockService],
  exports: [AmoFixationPhoneLockService],
})
export class AmoFixationPhoneLockModule {}
