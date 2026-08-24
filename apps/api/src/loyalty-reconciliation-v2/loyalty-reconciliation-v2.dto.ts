import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from "class-validator";

export const LOYALTY_RECONCILIATION_GROUPS = [
  "PHONE_MATCHED",
  "ANNA_ONLY",
  "CABINET_ONLY",
  "PHONE_TO_MULTIPLE_CARDS",
  "INVALID_PHONE",
  "NAME_OR_AGENCY_CONFLICT",
  "EXCLUDED_OR_STALE",
] as const;

export type LoyaltyReconciliationGroup =
  (typeof LOYALTY_RECONCILIATION_GROUPS)[number];

const BASES = ["anna", "ours"] as const;
const ENTITY_TYPES = ["BROKER", "AGENCY"] as const;
const STATUSES = ["OPEN", "RESOLVED", "DISMISSED"] as const;
const ACTIONS = [
  "LINK",
  "KEEP_SEPARATE",
  "SUPPLEMENT",
  "ARCHIVE",
  "UNLINK",
] as const;

export class LoyaltyReconciliationCoverageQueryDto {
  @IsIn(BASES)
  base!: (typeof BASES)[number];

  @IsOptional()
  @IsIn(ENTITY_TYPES)
  entityType?: (typeof ENTITY_TYPES)[number];
}

export class LoyaltyReconciliationGroupSearchDto extends LoyaltyReconciliationCoverageQueryDto {
  @IsIn(LOYALTY_RECONCILIATION_GROUPS)
  category!: LoyaltyReconciliationGroup;

  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  // Search can contain PII, therefore it deliberately exists only in the
  // POST body DTO and never in a GET/query DTO.
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 160)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 30;
}

export class LoyaltyReconciliationGroupExportDto extends LoyaltyReconciliationGroupSearchDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  maxRows = 10000;
}

export class LoyaltyReconciliationV2DecisionDto {
  @IsString()
  @Length(1, 64)
  caseId!: string;

  @IsIn(ACTIONS)
  action!: (typeof ACTIONS)[number];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(3, 1000)
  reason!: string;

  @IsOptional()
  @IsObject()
  fieldResolutions?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  targetId?: string;
}
