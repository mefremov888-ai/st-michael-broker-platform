import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

export const BROKER_CALL_RESULTS = [
  "NDZ",
  "DOUBLE_NDZ",
  "HUNG_UP",
  "INFORMED",
  "ALREADY_KNOWS",
  "ONLY_SEND_INFO",
  "SCHEDULED_TOUR",
  "IN_PROGRESS",
  "REFUSED_TOUR",
  "WRONG_NUMBER",
  "NOT_A_BROKER",
  "NOT_BROKER_ANYMORE",
  "REFUSED_COMMUNICATION",
  "ASKED_NOT_TO_CALL",
  "NEGATIVE",
  "NOT_RELEVANT",
] as const;

export type BrokerCallResultCode = (typeof BROKER_CALL_RESULTS)[number];

export class UpdateMangoEmployeeNumDto {
  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(64)
  @Matches(/^\s*(?:\d{1,20})?\s*$/, {
    message:
      "mangoEmployeeNum должен содержать от 1 до 20 цифр либо быть пустым",
  })
  mangoEmployeeNum!: string | null;
}

export class MangoCallDto {
  @IsUUID()
  brokerId!: string;

  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}

export class AssignCallCenterBrokersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  brokerIds!: string[];

  @IsUUID()
  managerId!: string;
}

export class UnassignCallCenterBrokersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  brokerIds!: string[];
}

export class LogCallCenterCallDto {
  @IsUUID()
  brokerId!: string;

  @IsIn(BROKER_CALL_RESULTS)
  result!: BrokerCallResultCode;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comment?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  campaign?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400)
  duration?: number | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  nextCallAtOverride?: string | null;

  @IsOptional()
  @IsBoolean()
  doNotCallOverride?: boolean | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  brokerTourDate?: string | null;
}

export class UpdateIntegrationSettingDto {
  @IsString()
  @MaxLength(16_384)
  value!: string;
}
