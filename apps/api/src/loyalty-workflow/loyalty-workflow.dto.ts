import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
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
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
} from "class-validator";

export const LOYALTY_BASE_INPUTS = [
  "ANNA",
  "OUR",
  "anna",
  "our",
  "ours",
] as const;
export const LOYALTY_ENTITY_INPUTS = [
  "BROKER",
  "AGENCY",
  "broker",
  "agency",
  "brokers",
  "agencies",
] as const;

export const BROKER_CALL_RESULTS = [
  "INFORMED",
  "DO_NOT_CALL",
  "NOT_INTERESTED",
  "NO_ANSWER",
  "SEND_INFORMATION",
  "BROKER_TOUR_BOOKED",
  "BROKER_TOUR_DECLINED",
  "INVALID_PHONE",
  "NOT_A_BROKER",
] as const;
export const AGENCY_CALL_RESULTS = [
  "NO_ANSWER",
  "COOPERATION_DECLINED",
  "BROKER_TOUR_SCHEDULED",
  "CALLBACK",
  "SEND_INFORMATION",
  "AGREEMENTS_EXIST",
  "COOPERATION_AGREED",
] as const;
export const ALL_CALL_RESULTS = Array.from(
  new Set([...BROKER_CALL_RESULTS, ...AGENCY_CALL_RESULTS]),
);
export const TASK_STATUSES = ["OPEN", "COMPLETED", "CANCELLED"] as const;
export const CAMPAIGN_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "COMPLETED",
  "ARCHIVED",
] as const;
export const ENGAGEMENT_TYPES = [
  "GIFT",
  "AWARD",
  "PRIVATE_EVENT",
  "INDIVIDUAL_TERMS",
  "PERSONAL_DISCOUNT",
  "PERSONAL_COMMISSION",
] as const;
export const LOYALTY_PERMISSIONS = [
  "READ_ALL",
  "READ_OWN_QUEUE",
  "CALL_EXECUTE",
  "CALL_ASSIGN",
  "ENTITY_EDIT",
  "REFERENCE_MANAGE",
  "EXPORT",
  "IMPORT",
  "RECONCILE",
  "AUDIT_READ",
  "ANALYTICS_SYNC",
] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class LoyaltyScopeDto {
  @IsIn(LOYALTY_BASE_INPUTS)
  base!: string;

  @IsIn(LOYALTY_ENTITY_INPUTS)
  entityType!: string;
}

export class LoyaltyOptionalScopeDto {
  @IsOptional()
  @IsIn(LOYALTY_BASE_INPUTS)
  base?: string;

  @IsOptional()
  @IsIn(LOYALTY_ENTITY_INPUTS)
  entityType?: string;
}

export class LoyaltyListQueryDto extends LoyaltyOptionalScopeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 100;
}

export class CampaignListQueryDto extends LoyaltyListQueryDto {
  @IsOptional()
  @IsIn(CAMPAIGN_STATUSES)
  status?: string;
}

export class CampaignDetailQueryDto extends LoyaltyListQueryDto {}

export class AssignmentSelectionDto {
  @IsIn(["IDS", "FILTER"])
  mode!: "IDS" | "FILTER";

  @ValidateIf((object, value) => object.mode === "IDS" || value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsUUID("4", { each: true })
  ids?: string[];

  @ValidateIf(
    (object, value) => object.mode === "FILTER" || value !== undefined,
  )
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  filterHash?: string;

  @ValidateIf(
    (object, value) => object.mode === "FILTER" || value !== undefined,
  )
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000000)
  expectedCount?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsUUID("4", { each: true })
  excludedIds?: string[];
}

export class CreateCampaignDto extends LoyaltyScopeDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string;

  @IsObject()
  filterSnapshot!: Record<string, unknown>;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  filterHash!: string;

  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID("4")
  snapshotId!: string | null;

  @ValidateNested()
  @IsDefined()
  @Type(() => AssignmentSelectionDto)
  selection!: AssignmentSelectionDto;
}

export class ExpectedVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class AssignmentBatchDto {
  @IsUUID("4")
  assigneeId!: string;

  @ValidateNested()
  @IsDefined()
  @Type(() => AssignmentSelectionDto)
  selection!: AssignmentSelectionDto;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class QueueQueryDto extends LoyaltyListQueryDto {
  @IsOptional()
  @IsUUID("4")
  assigneeId?: string;

  @IsOptional()
  @IsUUID("4")
  campaignId?: string;

  @IsOptional()
  @IsIn(["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"])
  status?: string;
}

export class CreateAttemptDto extends ExpectedVersionDto {
  @IsOptional()
  @IsUUID("4")
  assignmentId?: string;

  @Transform(trim)
  @IsString()
  @Length(8, 80)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  submissionId!: string;

  @IsIn(ALL_CALL_RESULTS)
  result!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  comment?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  nextStep?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  nextActionAt?: string;
}

export class CorrectAttemptDto {
  @Transform(trim)
  @IsString()
  @Length(8, 80)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  submissionId!: string;

  @IsIn(ALL_CALL_RESULTS)
  result!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  comment?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  nextStep?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  nextActionAt?: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  correctionReason!: string;
}

export class OwnedEntityDto extends LoyaltyScopeDto {
  @IsUUID("4")
  ownerId!: string;
}

export class TaskListQueryDto extends LoyaltyListQueryDto {
  @IsOptional()
  @IsUUID("4")
  ownerId?: string;

  @IsOptional()
  @IsUUID("4")
  assignedToId?: string;

  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: string;
}

export class CreateTaskDto extends OwnedEntityDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  title!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsUUID("4")
  assignedToId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  dueAt?: string;

  @IsOptional()
  @IsUUID("4")
  assignmentId?: string;
}

export class UpdateTaskDto extends ExpectedVersionDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(TASK_STATUSES)
  status?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID("4")
  assignedToId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  dueAt?: string | null;
}

export class EventListQueryDto extends LoyaltyListQueryDto {
  @IsOptional()
  @IsUUID("4")
  ownerId?: string;

  @IsOptional()
  @IsIn(ENGAGEMENT_TYPES)
  type?: string;

  @IsOptional()
  @Transform(({ value }) => value === "true" || value === true)
  @IsBoolean()
  includeArchived: boolean = false;
}

export class CreateEventDto extends OwnedEntityDto {
  @IsIn(ENGAGEMENT_TYPES)
  type!: string;

  @IsISO8601({ strict: true })
  occurredAt!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  comment?: string;

  @IsOptional()
  @Matches(/^\d{1,16}(?:\.\d{1,2})?$/)
  amount?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  value?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  validUntil?: string;

  @IsOptional()
  @IsUrl({ protocols: ["https"], require_protocol: true, require_tld: false })
  @Matches(/^https:\/\//i)
  @MaxLength(1000)
  attachmentUrl?: string;

  @IsOptional()
  @IsUrl({ protocols: ["https"], require_protocol: true, require_tld: false })
  @Matches(/^https:\/\//i)
  @MaxLength(1000)
  basisUrl?: string;
}

export class CorrectEventDto {
  @IsIn(ENGAGEMENT_TYPES)
  type!: string;

  @IsISO8601({ strict: true })
  occurredAt!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  comment?: string;

  @IsOptional()
  @Matches(/^\d{1,16}(?:\.\d{1,2})?$/)
  amount?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  value?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  validUntil?: string;

  @IsOptional()
  @IsUrl({ protocols: ["https"], require_protocol: true, require_tld: false })
  @Matches(/^https:\/\//i)
  @MaxLength(1000)
  attachmentUrl?: string;

  @IsOptional()
  @IsUrl({ protocols: ["https"], require_protocol: true, require_tld: false })
  @Matches(/^https:\/\//i)
  @MaxLength(1000)
  basisUrl?: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  correctionReason!: string;
}

export class SavedViewListQueryDto extends LoyaltyOptionalScopeDto {}

export class CreateSavedViewDto extends LoyaltyScopeDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsObject()
  filters!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isShared: boolean = false;
}

export class UpdateSavedViewDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  filters?: Record<string, unknown>;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isShared?: boolean;
}

export class GrantListQueryDto {
  @IsOptional()
  @IsUUID("4")
  userId?: string;

  @IsOptional()
  @Transform(({ value }) => value === "true" || value === true)
  @IsBoolean()
  includeRevoked: boolean = false;
}

export class CreateGrantDto {
  @IsUUID("4")
  userId!: string;

  @IsIn(LOYALTY_PERMISSIONS)
  permission!: string;
}

export class ReplaceGrantProfileDto {
  @IsUUID("4")
  userId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LOYALTY_PERMISSIONS.length)
  @ArrayUnique()
  @IsIn(LOYALTY_PERMISSIONS, { each: true })
  permissions!: string[];
}

export class ArchiveReasonDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
