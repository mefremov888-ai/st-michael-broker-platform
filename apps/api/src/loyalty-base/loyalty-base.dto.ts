import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";

const ENTITY_TYPES = ["BROKER", "AGENCY"] as const;
const CONTACT_POINT_TYPES = [
  "PHONE",
  "EMAIL",
  "TELEGRAM",
  "WHATSAPP",
  "OTHER",
] as const;
const EXTERNAL_SYSTEMS = [
  "AMOCRM",
  "BROKER_CABINET",
  "GOOGLE_SHEETS",
  "ANNA_FILE",
  "MANUAL",
] as const;
const EXTERNAL_ENTITY_TYPES = ["CONTACT", "COMPANY", "LEAD", "OTHER"] as const;
const ACTIVITY_TYPES = [
  "FIXATION",
  "MEETING",
  "DEAL",
  "BROKER_TOUR",
  "CALL",
] as const;
const ACTIVITY_VERDICTS = ["INCLUDED", "EXCLUDED", "UNKNOWN"] as const;
const RECONCILIATION_STATUSES = ["OPEN", "RESOLVED", "DISMISSED"] as const;
const RECONCILIATION_DECISIONS = [
  "LINK",
  "KEEP_SEPARATE",
  "REJECT_MATCH",
  "UNLINK",
] as const;
const LOYALTY_SEGMENTS = [
  "NOT_CALLED_CURRENT_MONTH",
  "NEW_BROKER",
  "BT_WITHOUT_FIXATION",
  "BIRTHDAY_TODAY",
] as const;

export class LoyaltyOverviewQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class LoyaltyListQueryDto {
  @IsDefined()
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

  @IsOptional()
  @Transform(({ value }) => {
    if (value === false || value === "false") return "exclude";
    if (value === true || value === "true") return "only";
    if (value === "all") return "include";
    return value;
  })
  @IsIn(["exclude", "include", "only"])
  archived: "exclude" | "include" | "only" = "exclude";

  @IsOptional()
  @IsString()
  @Length(1, 100)
  city?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  hasAmo?: boolean;

  @IsOptional()
  @IsIn(ACTIVITY_TYPES)
  activityType?: (typeof ACTIVITY_TYPES)[number];

  @IsOptional()
  @IsIn(LOYALTY_SEGMENTS)
  segment?: (typeof LOYALTY_SEGMENTS)[number];
}

export class LoyaltyNestedListFiltersDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (value === false || value === "false") return "exclude";
    if (value === true || value === "true") return "only";
    if (value === "all") return "include";
    return value;
  })
  @IsIn(["exclude", "include", "only"])
  archived?: "exclude" | "include" | "only";

  @IsOptional()
  @IsString()
  @Length(1, 100)
  city?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  hasAmo?: boolean;

  @IsOptional()
  @IsIn(ACTIVITY_TYPES)
  activityType?: (typeof ACTIVITY_TYPES)[number];

  @IsOptional()
  @IsIn(LOYALTY_SEGMENTS)
  segment?: (typeof LOYALTY_SEGMENTS)[number];
}

// Sensitive search text belongs in a POST body, never in URLs/access logs.
export class LoyaltySearchDto extends LoyaltyListQueryDto {
  @IsString()
  @Length(1, 160)
  search!: string;

  // Compatibility for clients that group non-sensitive filters. Flat fields
  // remain canonical; the controller normalizes this object before use.
  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyNestedListFiltersDto)
  filters?: LoyaltyNestedListFiltersDto;
}

export class LoyaltyContactPointDto {
  @IsIn(CONTACT_POINT_TYPES)
  type!: (typeof CONTACT_POINT_TYPES)[number];

  @IsString()
  @Length(1, 320)
  value!: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class LoyaltyExternalIdentityDto {
  @IsIn(EXTERNAL_SYSTEMS)
  system!: (typeof EXTERNAL_SYSTEMS)[number];

  @IsIn(EXTERNAL_ENTITY_TYPES)
  entityType!: (typeof EXTERNAL_ENTITY_TYPES)[number];

  @IsString()
  @Length(1, 128)
  externalId!: string;

  @IsOptional()
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @Length(1, 1000)
  url?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class LoyaltyActivityDto {
  @IsIn(EXTERNAL_SYSTEMS)
  sourceSystem!: (typeof EXTERNAL_SYSTEMS)[number];

  @IsString()
  @Length(1, 128)
  externalId!: string;

  @IsIn(ACTIVITY_TYPES)
  type!: (typeof ACTIVITY_TYPES)[number];

  @IsISO8601({ strict: true })
  occurredAt!: string;

  // A string keeps monetary input exact before it reaches Decimal(18,2).
  @IsOptional()
  @Matches(/^\d{1,16}(?:\.\d{1,2})?$/)
  amount?: string;

  @IsOptional()
  @IsString()
  @IsIn(["RUB"])
  currency?: string;

  @IsOptional()
  @IsIn(["DDU"])
  contractType?: "DDU";

  @IsOptional()
  @IsIn(ACTIVITY_VERDICTS)
  verdict?: (typeof ACTIVITY_VERDICTS)[number];

  @IsOptional()
  @IsString()
  @Length(1, 100)
  reasonCode?: string;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  externalIdentityId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class LoyaltyOrganizationRoleDto {
  @IsString()
  @Length(1, 128)
  organizationExternalKey!: string;

  @IsString()
  @Length(1, 120)
  role!: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsISO8601({ strict: true })
  validFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  validTo?: string;

  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;
}

export class LoyaltyImportRecordDto {
  // Stable source identity, supplied by the importer. It must not be derived
  // automatically from a mutable phone/name.
  @IsString()
  @Length(1, 128)
  externalKey!: string;

  @IsIn(ENTITY_TYPES)
  entityType!: (typeof ENTITY_TYPES)[number];

  @IsString()
  @Length(1, 256)
  displayName!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000000)
  sourceRowNumber?: number;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  sourceExternalId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  city?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{8,14}$/)
  taxId?: string;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LoyaltyContactPointDto)
  contactPoints?: LoyaltyContactPointDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LoyaltyExternalIdentityDto)
  externalIdentities?: LoyaltyExternalIdentityDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => LoyaltyActivityDto)
  activities?: LoyaltyActivityDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LoyaltyOrganizationRoleDto)
  organizationRoles?: LoyaltyOrganizationRoleDto[];
}

export class LoyaltyImportDto {
  @IsString()
  @Length(1, 160)
  sourceName!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,80}$/)
  ruleVersion!: string;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  expectedRecords!: number;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  expectedUniquePhones!: number;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  expectedActivities!: number;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500000)
  expectedExternalIdentities!: number;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  expectedIncludedFixations!: number;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  expectedIncludedMeetings!: number;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  expectedIncludedDeals!: number;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  expectedIncludedBrokerTours!: number;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  expectedIncludedCalls!: number;

  @IsDefined()
  @Matches(/^\d{1,16}(?:\.\d{1,2})?$/)
  expectedIncludedDealAmount!: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  confirmCoverageDrop?: boolean;

  // Filled by the client from dry-run when staging. Null explicitly binds to
  // an empty dataset; dry-run itself may omit it.
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  expectedActiveSnapshotId?: string | null;

  // Required by stage (not by dry-run). It is excluded from the hash input.
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  expectedContentHash?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => LoyaltyImportRecordDto)
  records!: LoyaltyImportRecordDto[];
}

export class LoyaltyPublishDto {
  @IsDefined()
  @IsBoolean()
  confirmed!: boolean;

  @IsDefined()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  expectedContentHash!: string;

  // Null explicitly means "I staged against an empty dataset". Requiring the
  // property prevents a stale staged snapshot from silently replacing a newer
  // active snapshot after a concurrent publish.
  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  expectedActiveSnapshotId!: string | null;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  confirmCoverageDrop?: boolean;
}

export class LoyaltyReconciliationQueryDto {
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

  @IsOptional()
  @IsIn(RECONCILIATION_STATUSES)
  status?: (typeof RECONCILIATION_STATUSES)[number];

  @IsOptional()
  @IsIn(ENTITY_TYPES)
  entityType?: (typeof ENTITY_TYPES)[number];

  @IsOptional()
  @IsIn(["anna", "ours", "all"])
  base?: "anna" | "ours" | "all";
}

export class LoyaltyNestedReconciliationFiltersDto {
  @IsOptional()
  @IsIn(RECONCILIATION_STATUSES)
  status?: (typeof RECONCILIATION_STATUSES)[number];

  @IsOptional()
  @IsIn(ENTITY_TYPES)
  entityType?: (typeof ENTITY_TYPES)[number];

  @IsOptional()
  @IsIn(["anna", "ours", "all"])
  base?: "anna" | "ours" | "all";
}

export class LoyaltyReconciliationSearchDto extends LoyaltyReconciliationQueryDto {
  @IsString()
  @Length(1, 160)
  search!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyNestedReconciliationFiltersDto)
  filters?: LoyaltyNestedReconciliationFiltersDto;
}

export class LoyaltyReconciliationDecisionDto {
  @IsString()
  @Length(1, 64)
  caseId!: string;

  @IsIn(RECONCILIATION_DECISIONS)
  decision!: (typeof RECONCILIATION_DECISIONS)[number];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class LoyaltyLinkUnlinkDto {
  @IsUUID()
  linkId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class LoyaltyEntityUpdateDto {
  @IsDefined()
  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  displayName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  city?: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class LoyaltyEntityArchiveDto {
  @IsDefined()
  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;
}
