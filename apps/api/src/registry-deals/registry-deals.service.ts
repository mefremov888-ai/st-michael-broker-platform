import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

// 2026-09-04: read-only аналитика по «Реестру сделок» (таблица registry_deals,
// заливается scripts/upload-registry-deals.js). Никаких записей в БД.

export interface RegistryAgencyRow {
  agencyCanonical: string;
  deals: number;
  amountSum: number;
  firstDeal: Date | null;
  lastDeal: Date | null;
  linkedLeads: number;
}

export interface RegistrySummary {
  total: number;
  bySource: Record<string, number>;
  withBroker: number;
  withAgency: number;
}

@Injectable()
export class RegistryDealsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getAgencies(): Promise<RegistryAgencyRow[]> {
    const groups = await this.prisma.registryDeal.groupBy({
      by: ['agencyCanonical'],
      where: { agencyCanonical: { not: null } },
      _count: { _all: true },
      _sum: { amount: true },
      _min: { signedAt: true },
      _max: { signedAt: true },
    });

    // linkedLeads (сделки, сшитые с лидом amo) — отдельный groupBy: prisma
    // не умеет условный COUNT внутри одной группировки.
    const linked = await this.prisma.registryDeal.groupBy({
      by: ['agencyCanonical'],
      where: { agencyCanonical: { not: null }, amoLeadId: { not: null } },
      _count: { _all: true },
    });
    const linkedByAgency = new Map(
      linked.map((g) => [g.agencyCanonical as string, g._count._all]),
    );

    return groups
      .map((g) => ({
        agencyCanonical: g.agencyCanonical as string,
        deals: g._count._all,
        amountSum: g._sum.amount ? Number(g._sum.amount) : 0,
        firstDeal: g._min.signedAt ?? null,
        lastDeal: g._max.signedAt ?? null,
        linkedLeads: linkedByAgency.get(g.agencyCanonical as string) ?? 0,
      }))
      .sort((a, b) => b.deals - a.deals);
  }

  async getSummary(): Promise<RegistrySummary> {
    const [total, sourceGroups, withBroker, withAgency] = await Promise.all([
      this.prisma.registryDeal.count(),
      this.prisma.registryDeal.groupBy({
        by: ['source'],
        _count: { _all: true },
      }),
      this.prisma.registryDeal.count({ where: { brokerId: { not: null } } }),
      this.prisma.registryDeal.count({
        where: { agencyCanonical: { not: null } },
      }),
    ]);

    const bySource: Record<string, number> = {};
    for (const g of sourceGroups) bySource[g.source] = g._count._all;

    return { total, bySource, withBroker, withAgency };
  }
}
