import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { SERIES_GRANULARITIES, SERIES_PROJECTS } from './registry-series';

// 2026-09-07: параметры ряда «по дням / неделям / месяцам» (сделки по дате
// оплаты ДДУ, платные брони по дате оплаты ДВОУ, фиксации по дате подачи).
export class RegistrySeriesQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsIn(SERIES_GRANULARITIES)
  granularity?: 'day' | 'week' | 'month';

  @IsOptional()
  @IsIn(SERIES_PROJECTS as unknown as string[])
  project?: 'ZORGE9' | 'SILVER_BOR' | 'TOLBUKHINA';
}
