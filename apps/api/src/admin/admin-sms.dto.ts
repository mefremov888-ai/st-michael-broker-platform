import { IsIn, IsString, Matches } from 'class-validator';
import { SMS_KINDS, SmsKind } from '../sms/sms-templates';

// 2026-09-24: тестовая отправка СМС из админки «Интеграции».
export class SmsTestDto {
  @IsString()
  @Matches(/^\+7\d{10}$/, { message: 'Номер в формате +7XXXXXXXXXX' })
  phone!: string;

  @IsString()
  @IsIn(SMS_KINDS as unknown as string[])
  sample!: SmsKind;
}
