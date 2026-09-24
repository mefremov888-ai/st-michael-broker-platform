import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { SmsService } from "./sms.service";
import { OtpService } from "./otp.service";

// 2026-09-24: СМС Центр — отправка с журналом и одноразовые коды.
// Подключается в Auth (коды), Notification (уведомления из очереди),
// Scheduler (статусы доставки) и Admin (настройки, тест, журнал).
@Module({
  imports: [DatabaseModule],
  providers: [SmsService, OtpService],
  exports: [SmsService, OtpService],
})
export class SmsModule {}
