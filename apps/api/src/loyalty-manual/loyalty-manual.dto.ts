import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class CreateLoyaltyManualContactDto {
  @IsIn(["anna", "ANNA"])
  base!: string;

  @IsIn(["BROKER", "AGENCY", "broker", "agency", "brokers", "agencies"])
  entityType!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(80)
  phone?: string;

  @IsOptional()
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  city?: string;
}

export const LOYALTY_OVERRIDE_CONTACT_TYPES = [
  "PHONE",
  "EMAIL",
  "TELEGRAM",
  "WHATSAPP",
  "OTHER",
] as const;

export class CreateLoyaltyContactPointDto {
  @IsIn(LOYALTY_OVERRIDE_CONTACT_TYPES)
  type!: (typeof LOYALTY_OVERRIDE_CONTACT_TYPES)[number];

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  value!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class LoyaltyAgencyContactPersonPointDto extends CreateLoyaltyContactPointDto {
  @IsOptional()
  @IsUUID("4")
  id?: string;
}

export class UpdateLoyaltyContactPointDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  value?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class LoyaltyContactPointListQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  includeArchived?: boolean;
}

export const LOYALTY_CONTACT_PERSON_STATUSES = [
  "CURRENT",
  "FORMER",
  "UNKNOWN",
] as const;

export class CreateLoyaltyAgencyContactPersonDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  displayName!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  role?: string;

  @IsOptional()
  @IsIn(LOYALTY_CONTACT_PERSON_STATUSES)
  actualityStatus?: (typeof LOYALTY_CONTACT_PERSON_STATUSES)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LoyaltyAgencyContactPersonPointDto)
  contactPoints?: LoyaltyAgencyContactPersonPointDto[];
}

export class UpdateLoyaltyAgencyContactPersonDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  displayName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  role?: string;

  @IsOptional()
  @IsIn(LOYALTY_CONTACT_PERSON_STATUSES)
  actualityStatus?: (typeof LOYALTY_CONTACT_PERSON_STATUSES)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LoyaltyAgencyContactPersonPointDto)
  contactPoints?: LoyaltyAgencyContactPersonPointDto[];

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
