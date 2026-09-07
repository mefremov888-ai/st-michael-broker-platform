import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from "class-validator";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class GoogleLoyaltyDryRunDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{20,100}$/)
  spreadsheetId?: string;
}

export class AmoLoyaltyDryRunDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_000)
  maxPages: number = 2_000;
}

export class LoyaltySyncRunsQueryDto {
  @IsOptional()
  @IsIn(["GOOGLE_SHEETS", "AMOCRM"])
  source?: "GOOGLE_SHEETS" | "AMOCRM";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 30;
}
