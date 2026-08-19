import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { MangoCallSafetyService } from "./mango-call-safety.service";

@Module({
  imports: [BullModule.registerQueue({ name: "mango-call-safety" })],
  providers: [MangoCallSafetyService],
  exports: [MangoCallSafetyService],
})
export class MangoCallSafetyModule {}
