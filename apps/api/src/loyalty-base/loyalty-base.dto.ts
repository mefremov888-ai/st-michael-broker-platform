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
const AGGREGATE_QUALITIES = [
  "SOURCE_REPORTED",
  "PARTIAL",
  "UNVERIFIED",
] as const;
const AGGREGATE_EXACTNESS = ["EXACT", "APPROXIMATE", "UNKNOWN"] as const;
const AGGREGATE_PERIOD_KINDS = [
  "LIFETIME",
  "DATE_RANGE",
  "MONTHLY_BREAKDOWN",
  "UNKNOWN",
] as const;
const RECONCILIATION_STATUSES = ["OPEN", "RESOLVED", "DISMISSED"] as const;
const RECONCILIATION_DECISIONS = [
  "LINK",
  "KEEP_SEPARATE",
  "REJECT_MATCH",
  "SUPPLEMENT",
  "ARCHIVE",
  "UNLINK",
] as const;
const RECONCILIATION_CATEGORIES = [
  "PHONE_MATCHED",
  "ANNA_ONLY",
  "CABINET_ONLY",
  "PHONE_TO_MULTIPLE_CARDS",
  "INVALID_PHONE",
  "NAME_OR_AGENCY_CONFLICT",
  "EXCLUDED_OR_STALE",
] as const;
const LOYALTY_SEGMENTS = [
  "NOT_CALLED_CURRENT_MONTH",
  "NEW_BROKER",
  "BT_WITHOUT_FIXATION",
  "BIRTHDAY_TODAY",
] as const;
const LOYALTY_CALL_RESULTS = [
  "INFORMED",
  "DO_NOT_CALL",
  "NOT_INTERESTED",
  "NO_ANSWER",
  "SEND_INFORMATION",
  "BROKER_TOUR_BOOKED",
  "BROKER_TOUR_DECLINED",
  "INVALID_PHONE",
  "NOT_A_BROKER",
  "COOPERATION_DECLINED",
  "BROKER_TOUR_SCHEDULED",
  "CALLBACK",
  "AGREEMENTS_EXIST",
  "COOPERATION_AGREED",
  // Deprecated input aliases retained for old clients. Responses/facets use
  // the workflow enum above.
  "SEND_INFO",
  "SCHEDULED_TOUR",
  "REFUSED_TOUR",
  "INVALID_NUMBER",
  "NOT_BROKER",
  "REFUSED_COOPERATION",
  "CALLBACK",
  "AGREEMENTS",
  "COOPERATION_AGREED",
] as const;
const LOYALTY_CALL_SCENARIOS = [
  "NOT_CALLED_IN_PERIOD",
  "CALLED_IN_PERIOD",
  "BT_DROPPED",
  "BT_FIXATION_NO_MEETING",
  "BT_MEETING_NO_DEAL",
  "NEW_NO_BT",
  "HAS_DEALS",
  "UNASSIGNED",
  "BT_VISITED",
  "BT_NOT_VISITED",
  "SITE_PLACED",
  "SITE_NOT_PLACED",
  "INDIVIDUAL_TERMS",
  "NO_INDIVIDUAL_TERMS",
  "HAS_MEETINGS",
  "NO_MEETINGS",
] as const;
const LOYALTY_SPECIALIZATIONS = [
  "Бизнес / премиум",
  "Коммерция — аренда",
  "Коммерция — продажа",
  "Вторичка",
  "COMM",
  "RESIDENTIAL",
  "BOTH",
] as const;
const LOYALTY_WORK_FORMATS = [
  "Агентство",
  "Частный брокер",
  "Координатор",
] as const;
const LOYALTY_STAGES = [
  "Новый",
  "Звонили",
  "Приглашён на БТ",
  "Был на БТ",
  "Фиксация",
  "Встреча",
  "Сделка",
  "Повторные сделки / VIP",
  "Новое",
  "Установлен контакт",
  "Назначена встреча",
  "Согласован БТ",
  "БТ проведён",
  "Размещение на сайте",
  "Активный партнёр",
  "VIP партнёр",
  "NEW_BROKER",
  "BROKER_TOUR",
  "FIXATION",
  "MEETING",
  "DEAL",
] as const;
const LOYALTY_STATUSES = [
  "TOP_SELLER",
  "SELLER",
  "OFFERING",
  "FIXATING",
  "BROKER_TOUR",
  "DORMANT",
  "NEW",
  "VIP_PARTNER",
  "SELLING_PARTNER",
  "ACTIVE_PARTNER",
  "FIXATING_PARTNER",
  "WARM_PARTNER",
  "STARTING_PARTNER",
  "DORMANT_PARTNER",
  "NEW_AGENCY",
] as const;
const LOYALTY_DATA_QUALITY_FILTERS = [
  "FULL",
  "NEEDS_COMPLETION",
  "NOT_FOUND_IN_CRM",
  "CONFLICT",
] as const;
const LOYALTY_PARTNERSHIP_STATUSES = [
  "Новое",
  "Установлен контакт",
  "Назначена встреча",
  "Согласован БТ",
  "БТ проведён",
  "Размещение на сайте",
  "Активный партнёр",
  "VIP партнёр",
] as const;
const LOYALTY_SORT_FIELDS = [
  "name",
  "city",
  "lastCallAt",
  "fixations",
  "meetings",
  "deals",
  "dealAmount",
  "brokerTours",
  "brokerCount",
  "rating",
  "updatedAt",
] as const;
const LOYALTY_COLUMN_CONTACT_FILTERS = ["HAS_PHONE", "NO_PHONE"] as const;
const LOYALTY_COLUMN_ACTIVITY_FILTERS = [
  "BT_VISITED",
  "BT_NOT_VISITED",
  "HAS_FIXATIONS",
  // 2026-09-04 (решение владельца, вариант В): «Есть фиксации» остаётся
  // lifetime-фильтром; «Действующая фиксация» — отдельное значение, где
  // срок фиксации/уникальности ещё не истёк. Поддержано только в «Нашей
  // базе» для брокеров (у Анны и агентств нет сроков фиксаций).
  "HAS_ACTIVE_FIXATIONS",
  "NO_FIXATIONS",
  "HAS_MEETINGS",
  "NO_MEETINGS",
] as const;
// «Не звонить»: exclude — скрыть doNotCall-брокеров, only — показать только
// их, отсутствие значения — показать всех (по умолчанию).
const LOYALTY_DO_NOT_CALL_FILTERS = ["exclude", "only"] as const;
const LOYALTY_COLUMN_CALL_FILTERS = [
  "CALLED_IN_PERIOD",
  "NOT_CALLED_IN_PERIOD",
] as const;
const LOYALTY_COLUMN_DEAL_FILTERS = [
  "HAS_DEALS",
  "NO_DEALS",
  "ONE_TO_TWO",
  "ONE_TO_FOUR",
  "THREE_PLUS",
  "FIVE_PLUS",
] as const;

export class LoyaltyOverviewQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  // 2026-09-07: источник фиксаций — старый кабинет / новый кабинет / оба.
  @IsOptional()
  @IsIn(["old", "new", "all"])
  cabinetSource?: "old" | "new" | "all";

  // 2026-09-08: база Анны — сцепка с кабинетом: linked / unlinked.
  @IsOptional()
  @IsIn(["linked", "unlinked"])
  linkedOurs?: "linked" | "unlinked";
}

// 2026-09-08: воронка брокера (БТ → фиксация → встреча → бронь → сделка).
export class LoyaltyFunnelQueryDto {
  // Период по дате брокер-тура (когорта). Пусто — за всё время.
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  // strict — событие засчитывается, только если оно не раньше даты тура;
  // all — за всё время (брокеры без даты тура тоже входят).
  @IsOptional()
  @IsIn(["strict", "all"])
  mode?: "strict" | "all";

  @IsOptional()
  @IsIn(["old", "new", "all"])
  cabinetSource?: "old" | "new" | "all";
}

// 2026-09-07: карточка контакта принимает выбранный «Период встреч и сделок»,
// чтобы применить его к периодным метрикам карточки (как в списке).
export class LoyaltyDetailQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  // 2026-09-07: источник фиксаций — старый кабинет / новый кабинет / оба.
  @IsOptional()
  @IsIn(["old", "new", "all"])
  cabinetSource?: "old" | "new" | "all";
}

export class LoyaltyListFiltersDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  // 2026-09-07: источник фиксаций — старый кабинет / новый кабинет / оба.
  @IsOptional()
  @IsIn(["old", "new", "all"])
  cabinetSource?: "old" | "new" | "all";

  // 2026-09-08: база Анны — сцепка с кабинетом: linked / unlinked.
  @IsOptional()
  @IsIn(["linked", "unlinked"])
  linkedOurs?: "linked" | "unlinked";

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsIn(LOYALTY_SORT_FIELDS)
  sortBy?: (typeof LOYALTY_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(["asc", "desc"])
  sortOrder?: "asc" | "desc";

  @IsDefined()
  @Transform(({ value }) => {
    if (value === false || value === "false") return "exclude";
    if (value === true || value === "true") return "only";
    if (value === "all") return "include";
    return value;
  })
  @IsIn(["exclude", "include", "only"])
  archived: "exclude" | "include" | "only" = "exclude";

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  includeLowSignal?: boolean;

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

  @IsOptional()
  @IsIn(LOYALTY_CALL_RESULTS)
  callResult?: (typeof LOYALTY_CALL_RESULTS)[number];

  @IsOptional()
  @IsUUID("4")
  callCampaign?: string;

  @IsOptional()
  @IsIn(LOYALTY_CALL_SCENARIOS)
  callScenario?: (typeof LOYALTY_CALL_SCENARIOS)[number];

  @IsOptional()
  @IsString()
  @Length(1, 160)
  assignee?: string;

  @IsOptional()
  @IsIn(LOYALTY_SPECIALIZATIONS)
  specialization?: (typeof LOYALTY_SPECIALIZATIONS)[number];

  @IsOptional()
  @IsIn(["MOSCOW", "REGION"])
  geography?: "MOSCOW" | "REGION";

  @IsOptional()
  @IsIn(LOYALTY_WORK_FORMATS)
  workFormat?: (typeof LOYALTY_WORK_FORMATS)[number];

  @IsOptional()
  @IsIn(LOYALTY_STAGES)
  stage?: (typeof LOYALTY_STAGES)[number];

  @IsOptional()
  @IsIn(LOYALTY_STATUSES)
  status?: (typeof LOYALTY_STATUSES)[number];

  @IsOptional()
  @IsIn(LOYALTY_DATA_QUALITY_FILTERS)
  dataQuality?: (typeof LOYALTY_DATA_QUALITY_FILTERS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  dealsMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  dealsMax?: number;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  dealsInPeriod?: boolean;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  noDeals?: boolean;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  called?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  staleDays?: number;

  @IsOptional()
  @IsIn(LOYALTY_PARTNERSHIP_STATUSES)
  partnershipStatus?: (typeof LOYALTY_PARTNERSHIP_STATUSES)[number];

  @IsOptional()
  @IsIn(["Крупное", "Среднее", "Небольшое"])
  agencySize?: "Крупное" | "Среднее" | "Небольшое";

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  brokerTourVisited?: boolean;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  websitePresent?: boolean;

  @IsOptional()
  @IsIn(["YES", "NO", "IN_PROGRESS"])
  projectsOnSite?: "YES" | "NO" | "IN_PROGRESS";

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  individualTerms?: boolean;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  specialTermsProposed?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  meetingsMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  meetingsMax?: number;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  rewardPresent?: boolean;

  // Плоский транспорт фильтра «не звонить» (канонический — в
  // LoyaltyCanonicalFilterDto.doNotCall). Только «Наша база» / брокеры.
  @IsOptional()
  @IsIn(LOYALTY_DO_NOT_CALL_FILTERS)
  doNotCall?: (typeof LOYALTY_DO_NOT_CALL_FILTERS)[number];
}

export class LoyaltyListQueryDto extends LoyaltyListFiltersDto {
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
}

export class LoyaltyNestedListFiltersDto extends LoyaltyListFiltersDto {}

export class LoyaltyFilterPeriodDto {
  @IsISO8601({ strict: true })
  from!: string;

  @IsISO8601({ strict: true })
  to!: string;
}

export class LoyaltyFilterRangeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  max?: number;
}

// Canonical POST-body filter used by list selection and CSV export. Flat
// fields remain a backwards-compatible transport and are normalized by the
// service before predicates are evaluated.
export class LoyaltyCanonicalFilterDto {
  @IsOptional()
  @IsBoolean()
  includeLowSignal?: boolean;

  // 2026-09-07: источник фиксаций — старый кабинет / новый кабинет / оба.
  @IsOptional()
  @IsIn(["old", "new", "all"])
  cabinetSource?: "old" | "new" | "all";

  // 2026-09-08: база Анны — сцепка с кабинетом: linked / unlinked.
  @IsOptional()
  @IsIn(["linked", "unlinked"])
  linkedOurs?: "linked" | "unlinked";

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyFilterPeriodDto)
  callPeriod?: LoyaltyFilterPeriodDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyFilterPeriodDto)
  activityPeriod?: LoyaltyFilterPeriodDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("4", { each: true })
  campaignIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsIn(LOYALTY_CALL_RESULTS, { each: true })
  lastCallResults?: Array<(typeof LOYALTY_CALL_RESULTS)[number]>;

  @IsOptional()
  @IsIn(LOYALTY_CALL_SCENARIOS)
  scenario?: (typeof LOYALTY_CALL_SCENARIOS)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Length(1, 160, { each: true })
  assigneeIds?: string[];

  @IsOptional()
  @IsBoolean()
  unassigned?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(LOYALTY_SPECIALIZATIONS, { each: true })
  specializations?: Array<(typeof LOYALTY_SPECIALIZATIONS)[number]>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(["MOSCOW", "REGION"], { each: true })
  geography?: Array<"MOSCOW" | "REGION">;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(LOYALTY_WORK_FORMATS, { each: true })
  workFormats?: Array<(typeof LOYALTY_WORK_FORMATS)[number]>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsIn(LOYALTY_STAGES, { each: true })
  relationshipStages?: Array<(typeof LOYALTY_STAGES)[number]>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(LOYALTY_STATUSES, { each: true })
  brokerStatuses?: Array<(typeof LOYALTY_STATUSES)[number]>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(LOYALTY_DATA_QUALITY_FILTERS, { each: true })
  dataQuality?: Array<(typeof LOYALTY_DATA_QUALITY_FILTERS)[number]>;

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyFilterRangeDto)
  dealCount?: LoyaltyFilterRangeDto;

  @IsOptional()
  @IsBoolean()
  dealsInPeriod?: boolean;

  @IsOptional()
  @IsBoolean()
  bt?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyFilterRangeDto)
  meetings?: LoyaltyFilterRangeDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsIn(LOYALTY_PARTNERSHIP_STATUSES, { each: true })
  partnershipStatuses?: Array<(typeof LOYALTY_PARTNERSHIP_STATUSES)[number]>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(["Крупное", "Среднее", "Небольшое"], { each: true })
  agencySizes?: Array<"Крупное" | "Среднее" | "Небольшое">;

  @IsOptional()
  @IsBoolean()
  websitePresent?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(["YES", "NO", "IN_PROGRESS"], { each: true })
  projectsOnSite?: Array<"YES" | "NO" | "IN_PROGRESS">;

  @IsOptional()
  @IsBoolean()
  individualTerms?: boolean;

  @IsOptional()
  @IsBoolean()
  specialTermsProposed?: boolean;

  @IsOptional()
  @IsBoolean()
  rewardPresent?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  staleDays?: number;

  // «Не звонить» (Broker.doNotCall): только «Наша база» / брокеры.
  // По умолчанию фильтр НЕ применяется — список показывает всех.
  @IsOptional()
  @IsIn(LOYALTY_DO_NOT_CALL_FILTERS)
  doNotCall?: (typeof LOYALTY_DO_NOT_CALL_FILTERS)[number];
}

export class LoyaltyColumnFiltersDto {
  @IsOptional()
  @IsIn(LOYALTY_COLUMN_CONTACT_FILTERS)
  contact?: (typeof LOYALTY_COLUMN_CONTACT_FILTERS)[number];

  @IsOptional()
  @IsIn(LOYALTY_STATUSES)
  statusStage?: (typeof LOYALTY_STATUSES)[number];

  @IsOptional()
  @IsIn(LOYALTY_COLUMN_ACTIVITY_FILTERS)
  activity?: (typeof LOYALTY_COLUMN_ACTIVITY_FILTERS)[number];

  @IsOptional()
  @IsIn(LOYALTY_COLUMN_CALL_FILTERS)
  calls?: (typeof LOYALTY_COLUMN_CALL_FILTERS)[number];

  @IsOptional()
  @IsString()
  @Length(1, 160)
  assignee?: string;

  @IsOptional()
  @IsIn(LOYALTY_COLUMN_DEAL_FILTERS)
  deals?: (typeof LOYALTY_COLUMN_DEAL_FILTERS)[number];
}

// Sensitive search text belongs in a POST body, never in URLs/access logs.
export class LoyaltySearchDto extends LoyaltyListQueryDto {
  @IsOptional()
  @IsString()
  @Length(0, 160)
  search = "";

  // Compatibility for clients that group non-sensitive filters. Flat fields
  // remain canonical; the controller normalizes this object before use.
  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyNestedListFiltersDto)
  filters?: LoyaltyNestedListFiltersDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyCanonicalFilterDto)
  filter?: LoyaltyCanonicalFilterDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyColumnFiltersDto)
  columns?: LoyaltyColumnFiltersDto;
}

// 2026-09-08: «Контрольные показатели активности» по текущей выборке
// списка: тело — как у search, плюс период рейтинга (summaryPeriod).
export class LoyaltyActivitySummaryDto extends LoyaltySearchDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyFilterPeriodDto)
  summaryPeriod?: LoyaltyFilterPeriodDto;
}

export class LoyaltyExportDto extends LoyaltyListFiltersDto {
  @IsOptional()
  @IsString()
  @Length(0, 160)
  search = "";

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyNestedListFiltersDto)
  filters?: LoyaltyNestedListFiltersDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyCanonicalFilterDto)
  filter?: LoyaltyCanonicalFilterDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyColumnFiltersDto)
  columns?: LoyaltyColumnFiltersDto;
}

export class LoyaltyChangesQueryDto {
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

// Source-reported rollups are intentionally distinct from LoyaltyActivityDto.
// A count without an event id/date remains aggregate evidence and must never be
// expanded into invented activity rows.
export class LoyaltySourceAggregateDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,80}$/)
  sourceKind!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,80}$/)
  sourceVersion!: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  sourceLabel?: string;

  @IsIn(AGGREGATE_QUALITIES)
  quality!: (typeof AGGREGATE_QUALITIES)[number];

  @IsIn(AGGREGATE_EXACTNESS)
  exactness!: (typeof AGGREGATE_EXACTNESS)[number];

  @IsIn(AGGREGATE_PERIOD_KINDS)
  periodKind!: (typeof AGGREGATE_PERIOD_KINDS)[number];

  @IsOptional()
  @IsISO8601({ strict: true })
  periodFrom?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  periodTo?: string | null;

  @IsBoolean()
  contributesToSourceSummary!: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  fixationCount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  meetingCount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  dealCount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  brokerTourCount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  callCount?: number | null;

  @IsOptional()
  @Matches(/^\d{1,16}(?:\.\d{1,2})?$/)
  dealAmount?: string | null;

  @IsOptional()
  @IsIn(["RUB"])
  currency?: "RUB" | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  lastFixationAt?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  lastMeetingAt?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  lastDealAt?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  lastCallAt?: string | null;

  @IsOptional()
  @IsBoolean()
  brokerTourVisited?: boolean | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  brokerTourAt?: string | null;

  @IsOptional()
  @IsObject()
  dealsByMonth?: Record<string, number> | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsObject({ each: true })
  callBreakdown?: Array<Record<string, unknown>> | null;

  @IsOptional()
  @IsObject()
  provenance?: Record<string, unknown> | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  reportedAt?: string | null;
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

  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltySourceAggregateDto)
  sourceAggregate?: LoyaltySourceAggregateDto;
}

export class LoyaltySourceReportedGroupManifestDto {
  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  records!: number;

  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  fixations!: number | null;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  fixationKnownRecords!: number;

  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  meetings!: number | null;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  meetingKnownRecords!: number;

  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  deals!: number | null;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  dealKnownRecords!: number;

  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  brokerTours!: number | null;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  brokerTourKnownRecords!: number;

  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20000000)
  calls!: number | null;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  callKnownRecords!: number;

  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @Matches(/^\d{1,16}(?:\.\d{1,2})?$/)
  dealAmount!: string | null;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  dealAmountKnownRecords!: number;
}

export class LoyaltySourceReportedSummaryManifestDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => LoyaltySourceReportedGroupManifestDto)
  brokers!: LoyaltySourceReportedGroupManifestDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => LoyaltySourceReportedGroupManifestDto)
  agencies!: LoyaltySourceReportedGroupManifestDto;
}

export class LoyaltyActivityCoverageDto {
  @IsIn(["PARTIAL", "FULL_SNAPSHOT"])
  mode!: "PARTIAL" | "FULL_SNAPSHOT";

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  coveredRecords!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsIn(ACTIVITY_TYPES, { each: true })
  activityTypes!: (typeof ACTIVITY_TYPES)[number][];

  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,100}$/)
  sourceRunId!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  sourceContentHash!: string;

  @IsISO8601({ strict: true })
  observedThrough!: string;
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

  // Any event-bearing import must declare what was actually scanned. Merely
  // seeing one event never proves that missing calls/deals are exact zeroes.
  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyActivityCoverageDto)
  activityCoverage?: LoyaltyActivityCoverageDto;

  // Optional for backward compatibility with event-only imports. It becomes
  // mandatory in service validation as soon as any record has an aggregate.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  expectedSourceAggregates?: number;

  // Required by service validation whenever sourceAggregate is present. The
  // two groups are intentionally independent and are never added together.
  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltySourceReportedSummaryManifestDto)
  expectedSourceReportedSummary?: LoyaltySourceReportedSummaryManifestDto;

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

  @IsOptional()
  @IsIn(RECONCILIATION_CATEGORIES)
  category?: (typeof RECONCILIATION_CATEGORIES)[number];
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

  @IsOptional()
  @IsIn(RECONCILIATION_CATEGORIES)
  category?: (typeof RECONCILIATION_CATEGORIES)[number];
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

// 2026-09-07: правка «имени для работы» брокера кабинета из карточки
// «Нашей базы» (PATCH ours/brokers/:id/display-name). Пустая строка —
// сброс (снова показывается самоназвание брокера).
export class LoyaltyDisplayNameUpdateDto {
  @IsDefined()
  @IsString()
  @Length(0, 256)
  displayName!: string;
}
