import { BadRequestException, Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { fixationClientWhere } from '../loyalty-base/loyalty-base.service';
import {
  SERIES_MAX_BUCKETS,
  SeriesBucket,
  SeriesCounts,
  SeriesGranularity,
  SeriesProject,
  buildSeries,
  enumerateBuckets,
} from './registry-series';

// 2026-09-04: read-only аналитика по «Реестру сделок» (таблица registry_deals,
// заливается scripts/upload-registry-deals.js). Никаких записей в БД.
//
// 2026-09-07 (правило владельца): сделка = факт оплаты ДДУ («Дата оплаты
// ДДУ», paidAt); строки без paidAt сделками не считаются. Платная бронь =
// оплаченный ДВОУ (dvouPaidAt). «Дата ДДУ» (signedAt) — справочная.

export interface RegistryAgencyRow {
  agencyCanonical: string;
  deals: number;
  amountSum: number;
  firstDeal: Date | null;
  lastDeal: Date | null;
  linkedLeads: number;
  paidBookings: number;
}

export interface RegistrySummary {
  total: number;
  bySource: Record<string, number>;
  withBroker: number;
  withAgency: number;
  /** Строки с датой оплаты ДДУ — это и есть «сделки» по правилу владельца. */
  paidDeals: number;
  /** Строки без даты оплаты ДДУ (договор не оплачен / план / нет данных). */
  unpaidRows: number;
  /** Строки с оплаченным ДВОУ — платные брони. */
  paidBookings: number;
}

export interface RegistrySeries {
  granularity: SeriesGranularity;
  period: { from: string; to: string };
  project: SeriesProject | null;
  buckets: SeriesBucket[];
  totals: SeriesCounts;
  totalsByProject: Record<string, SeriesCounts>;
  methodology: {
    deals: string;
    paidBookings: string;
    fixations: string;
    calendar: string;
  };
}

const PAID_DEAL_WHERE = { paidAt: { not: null } } as const;
const PAID_BOOKING_WHERE = { dvouPaidAt: { not: null } } as const;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

@Injectable()
export class RegistryDealsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getAgencies(): Promise<RegistryAgencyRow[]> {
    const groups = await this.prisma.registryDeal.groupBy({
      by: ['agencyCanonical'],
      where: { agencyCanonical: { not: null }, ...PAID_DEAL_WHERE },
      _count: { _all: true },
      _sum: { amount: true },
      _min: { paidAt: true },
      _max: { paidAt: true },
    });

    // linkedLeads (сделки, сшитые с лидом amo) и платные брони — отдельные
    // groupBy: prisma не умеет условный COUNT внутри одной группировки.
    const [linked, bookings] = await Promise.all([
      this.prisma.registryDeal.groupBy({
        by: ['agencyCanonical'],
        where: { agencyCanonical: { not: null }, ...PAID_DEAL_WHERE, amoLeadId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.registryDeal.groupBy({
        by: ['agencyCanonical'],
        where: { agencyCanonical: { not: null }, ...PAID_BOOKING_WHERE },
        _count: { _all: true },
      }),
    ]);
    const linkedByAgency = new Map(
      linked.map((g) => [g.agencyCanonical as string, g._count._all]),
    );
    const bookingsByAgency = new Map(
      bookings.map((g) => [g.agencyCanonical as string, g._count._all]),
    );

    const rows = new Map<string, RegistryAgencyRow>();
    for (const g of groups) {
      const key = g.agencyCanonical as string;
      rows.set(key, {
        agencyCanonical: key,
        deals: g._count._all,
        amountSum: g._sum.amount ? Number(g._sum.amount) : 0,
        firstDeal: g._min.paidAt ?? null,
        lastDeal: g._max.paidAt ?? null,
        linkedLeads: linkedByAgency.get(key) ?? 0,
        paidBookings: bookingsByAgency.get(key) ?? 0,
      });
    }
    // Агентство только с бронями (без оплаченных ДДУ) тоже показываем.
    for (const [key, count] of bookingsByAgency) {
      if (rows.has(key)) continue;
      rows.set(key, {
        agencyCanonical: key,
        deals: 0,
        amountSum: 0,
        firstDeal: null,
        lastDeal: null,
        linkedLeads: 0,
        paidBookings: count,
      });
    }

    return [...rows.values()].sort(
      (a, b) => b.deals - a.deals || b.paidBookings - a.paidBookings,
    );
  }

  async getSummary(): Promise<RegistrySummary> {
    const [total, sourceGroups, withBroker, withAgency, paidDeals, paidBookings] =
      await Promise.all([
        this.prisma.registryDeal.count(),
        this.prisma.registryDeal.groupBy({
          by: ['source'],
          _count: { _all: true },
        }),
        this.prisma.registryDeal.count({ where: { brokerId: { not: null } } }),
        this.prisma.registryDeal.count({
          where: { agencyCanonical: { not: null } },
        }),
        this.prisma.registryDeal.count({ where: PAID_DEAL_WHERE }),
        this.prisma.registryDeal.count({ where: PAID_BOOKING_WHERE }),
      ]);

    const bySource: Record<string, number> = {};
    for (const g of sourceGroups) bySource[g.source] = g._count._all;

    return {
      total,
      bySource,
      withBroker,
      withAgency,
      paidDeals,
      unpaidRows: Math.max(0, total - paidDeals),
      paidBookings,
    };
  }

  /**
   * Ряд по дням / неделям / месяцам: сделки (paidAt), платные брони
   * (dvouPaidAt), фиксации (Client.createdAt, те же условия, что в «Нашей
   * базе»: FIXED/EXPIRED или условно-уникален/истёк, брокер действующий).
   * По умолчанию — последние 12 месяцев помесячно.
   */
  async getSeries(query: {
    from?: string;
    to?: string;
    granularity?: SeriesGranularity;
    project?: SeriesProject;
    cabinetSource?: 'old' | 'new' | 'all';
  }): Promise<RegistrySeries> {
    const granularity: SeriesGranularity = query.granularity || 'month';
    const now = new Date();
    const to = query.to ? new Date(query.to) : now;
    const from = query.from
      ? new Date(query.from)
      : (() => {
          // Начало месяца (МСК) 11 месяцев назад — 12 корзин.
          const shifted = new Date(now.getTime() + MSK_OFFSET_MS);
          return new Date(
            Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() - 11, 1) - MSK_OFFSET_MS,
          );
        })();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Некорректные даты периода');
    }
    if (to.getTime() < from.getTime()) {
      throw new BadRequestException('Дата «по» раньше даты «с»');
    }
    if (enumerateBuckets(from, to, granularity).length > SERIES_MAX_BUCKETS) {
      throw new BadRequestException(
        `Слишком длинный период для шага «${granularity}»: не больше ${SERIES_MAX_BUCKETS} точек`,
      );
    }
    const projectWhere = query.project ? { project: query.project } : {};
    const range = { gte: from, lte: to };

    const [dealRows, bookingRows, fixationRows] = await Promise.all([
      this.prisma.registryDeal.findMany({
        where: { paidAt: range, ...projectWhere },
        select: { paidAt: true, amount: true, project: true },
      }),
      this.prisma.registryDeal.findMany({
        where: { dvouPaidAt: range, ...projectWhere },
        select: { dvouPaidAt: true, dvouAmount: true, project: true },
      }),
      this.prisma.client.findMany({
        where: {
          ...fixationClientWhere(query.cabinetSource),
          createdAt: range,
          broker: { is: { role: 'BROKER', mergedIntoId: null } },
          ...projectWhere,
        },
        select: { createdAt: true, project: true },
      }),
    ]);

    const series = buildSeries(
      { from, to, granularity },
      {
        deals: dealRows.map((r) => ({ date: r.paidAt, project: r.project, amount: r.amount })),
        paidBookings: bookingRows.map((r) => ({
          date: r.dvouPaidAt,
          project: r.project,
          amount: r.dvouAmount,
        })),
        fixations: fixationRows.map((r) => ({ date: r.createdAt, project: r.project })),
      },
    );

    return {
      granularity,
      period: { from: from.toISOString(), to: to.toISOString() },
      project: query.project || null,
      ...series,
      methodology: {
        deals:
          'Строки «Реестра сделок» с «Датой оплаты ДДУ» (столбец H реестра) в корзине; сумма — «Стоимость по ДДУ». Неоплаченные договоры не считаются.',
        paidBookings:
          'Строки «Реестра сделок» с датой оплаты ДВОУ (столбец E) в корзине; сумма — «ДВОУ, руб» (столбец AA).',
        fixations:
          'Клиенты кабинета с фиксацией (зафиксирован / истёкшая фиксация / условно уникален / истекла) у действующего брокера, по дате подачи заявки.',
        calendar: 'Календарь Europe/Moscow: день — московские сутки, неделя — с понедельника, месяц — календарный.',
      },
    };
  }
}
