import { notHistoricalClientWhere } from '../common/historical-client';
import { BadRequestException, Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class AnalyticsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  private parseAdminPeriod(filters: { startDate?: string; endDate?: string }) {
    const now = new Date();
    const from = filters.startDate !== undefined
      ? this.parsePeriodDate(filters.startDate, false)
      : new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    let to: Date;
    let toExclusive: Date;
    if (filters.endDate !== undefined) {
      const parsedEnd = this.parsePeriodDate(filters.endDate, true);
      if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(filters.endDate)) {
        toExclusive = new Date(parsedEnd.getTime() + 24 * 60 * 60 * 1000);
        to = new Date(toExclusive.getTime() - 1);
      } else {
        to = parsedEnd;
        toExclusive = new Date(to.getTime() + 1);
      }
    } else {
      to = now;
      toExclusive = new Date(now.getTime() + 1);
    }

    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('startDate must be before or equal to endDate');
    }

    return { from, to, toExclusive };
  }

  private parsePeriodDate(value: string, isEnd: boolean) {
    const dateOnlyMatch = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
    if (dateOnlyMatch) {
      const year = Number(dateOnlyMatch[1]);
      const month = Number(dateOnlyMatch[2]);
      const day = Number(dateOnlyMatch[3]);
      const check = new Date(Date.UTC(year, month - 1, day));
      if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day
      ) {
        throw new BadRequestException(`Invalid ${isEnd ? 'endDate' : 'startDate'}`);
      }
      // Europe/Moscow has a fixed UTC+03:00 offset for the reporting period.
      return new Date(`${value}T00:00:00.000+03:00`);
    }

    const isoDateTime = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:[.][0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
    const parsed = new Date(value);
    if (!isoDateTime.test(value) || Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid ${isEnd ? 'endDate' : 'startDate'}`);
    }
    return parsed;
  }

  private toMoscowDateKey(date: Date) {
    return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  async getDashboard(brokerId: string) {
    // 2026-07-03: на дашборде показываем ТОЛЬКО клиентов-владельцев (creator).
    // Делегированные (когда А фиксирует на Б) в дашборд Б не входят: комиссия,
    // м² в уровень, статистика — всё это идёт создателю (А). У Б они видны
    // только в списке /clients как «Исполнитель по фиксации».
    // Раньше был OR по responsibleBrokerId — из-за этого у Б в дашборде
    // считались клиенты, за которых он не получает ни денег, ни зачёта.
    // 2026-09-07: исторические фиксации старого кабинета в дашборд брокера
    // не входят (видны только ADMIN/MANAGER).
    const clientOwnership = { brokerId, ...notHistoricalClientWhere } as any;
    const [
      totalClients,
      activeFixations,
      rejectedFixations,
      expiredFixations,
      delegatedToMe,
      totalDeals,
      pendingDeals,
      paidDeals,
      commissionStats,
      upcomingMeetings,
    ] = await Promise.all([
      this.prisma.client.count({ where: clientOwnership }),
      this.prisma.client.count({
        where: {
          ...clientOwnership,
          uniquenessStatus: 'CONDITIONALLY_UNIQUE',
          uniquenessExpiresAt: { gt: new Date() },
        },
      }),
      // 2026-07-08: считаем «Не уникален» — нужно для % успеха уникальности.
      this.prisma.client.count({
        where: { ...clientOwnership, uniquenessStatus: 'REJECTED' },
      }),
      this.prisma.client.count({
        where: {
          ...clientOwnership,
          uniquenessStatus: 'EXPIRED',
        },
      }),
      // Делегированные КО МНЕ (я responsibleBroker, не создатель). Нужны
      // отдельным числом, чтобы брокер видел клиентов, которых ведёт от А,
      // но за которых не получит комиссию.
      this.prisma.client.count({
        where: {
          responsibleBrokerId: brokerId,
          AND: [{ NOT: { brokerId } }, notHistoricalClientWhere],
        },
      }),
      this.prisma.deal.count({ where: { brokerId } }),
      this.prisma.deal.count({ where: { brokerId, status: 'PENDING' } }),
      this.prisma.deal.count({ where: { brokerId, status: { in: ['PAID', 'COMMISSION_PAID'] } } }),
      this.prisma.deal.aggregate({
        where: { brokerId, status: { in: ['PAID', 'COMMISSION_PAID'] } },
        _sum: { commissionAmount: true, amount: true },
      }),
      this.prisma.meeting.count({
        where: {
          brokerId,
          date: { gte: new Date() },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      }),
    ]);

    // Fixations expiring in next 7 days
    const expiringFixations = await this.prisma.client.count({
      where: {
        ...clientOwnership,
        uniquenessStatus: 'CONDITIONALLY_UNIQUE',
        uniquenessExpiresAt: {
          gt: new Date(),
          lt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      },
    });

    // 2026-07-08: % успеха уникальности. Считаем среди «завершённых»
    // фиксаций (все статусы кроме UNDER_REVIEW) — сколько из них дошли
    // до CONDITIONALLY_UNIQUE. Показывает, насколько успешно брокер
    // проходит правила уникальности КЦ.
    const uniqueFixationsForRatio = await this.prisma.client.count({
      where: {
        ...clientOwnership,
        uniquenessStatus: 'CONDITIONALLY_UNIQUE',
      },
    });
    const finalizedFixations = uniqueFixationsForRatio + rejectedFixations + expiredFixations;
    const uniquenessSuccessRate = finalizedFixations > 0
      ? Math.round((uniqueFixationsForRatio / finalizedFixations) * 100)
      : 0;

    return {
      clients: {
        total: totalClients,
        activeFixations,
        expiredFixations,
        expiringFixations,
        // 2026-07-08: новые метрики
        uniquenessSuccessRate,   // % «Уникален» среди завершённых фиксаций
        delegatedToMe,           // клиенты, которых я веду за другого брокера
      },
      deals: {
        total: totalDeals,
        pending: pendingDeals,
        paid: paidDeals,
        totalAmount: Number(commissionStats._sum.amount || 0),
      },
      commission: {
        totalEarned: Number(commissionStats._sum.commissionAmount || 0),
      },
      meetings: {
        upcoming: upcomingMeetings,
      },
    };
  }

  // 2026-07-07: удалён неиспользуемый метод getFunnel() — эндпоинт
  // GET /analytics/funnel был мёртвым кодом (фронтенд его не дёргал),
  // распределение по стадиям воронки живёт внутри getAdminOverview
  // (funnelByStage).

  // Admin overview — implements ТЗ §15.6
  async getAdminOverview(filters: { startDate?: string; endDate?: string }) {
    const { from, to, toExclusive } = this.parseAdminPeriod(filters);
    const canonicalBrokerFilter = { role: 'BROKER', mergedIntoId: null } as const;
    const canonicalBrokers: Array<{
      id: string;
      fullName: string;
      phone: string;
      brokerTourVisited: boolean;
      brokerTourDate: Date | null;
    }> = await this.prisma.broker.findMany({
      where: canonicalBrokerFilter,
      select: {
        id: true,
        fullName: true,
        phone: true,
        brokerTourVisited: true,
        brokerTourDate: true,
      },
    });
    const canonicalBrokerIdList = canonicalBrokers.map((broker) => broker.id);
    const canonicalBrokerIds = new Set(canonicalBrokerIdList);

    // ─── Broker registrations ────────────────────────────
    const [totalBrokers, activeBrokers, blockedBrokers, newInPeriod] = await Promise.all([
      this.prisma.broker.count({ where: canonicalBrokerFilter }),
      this.prisma.broker.count({ where: { ...canonicalBrokerFilter, status: 'ACTIVE' } }),
      this.prisma.broker.count({ where: { ...canonicalBrokerFilter, status: 'BLOCKED' } }),
      this.prisma.broker.count({
        where: { ...canonicalBrokerFilter, createdAt: { gte: from, lt: toExclusive } },
      }),
    ]);

    // Registration trend — group by day for the period
    const allBrokersInPeriod = await this.prisma.broker.findMany({
      where: { ...canonicalBrokerFilter, createdAt: { gte: from, lt: toExclusive } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const regByDay = new Map<string, number>();
    for (const b of allBrokersInPeriod) {
      const day = this.toMoscowDateKey(b.createdAt);
      regByDay.set(day, (regByDay.get(day) || 0) + 1);
    }
    const registrationTrend = [...regByDay.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // ─── Fixations by effective broker (внутри периода) ───────
    // Для импортированных amo-заявок бизнес-дата — amoCreatedAt;
    // createdAt остаётся fallback для заявок из кабинета/импорта.
    // Для делегированной фиксации эффективный брокер = responsibleBrokerId,
    // а brokerId хранится как автор подачи.
    const fixationDateFilter = {
      AND: [
        {
          OR: [
            { amoCreatedAt: { gte: from, lt: toExclusive } },
            { amoCreatedAt: null, createdAt: { gte: from, lt: toExclusive } },
          ],
        },
        {
          OR: [
            { responsibleBrokerId: { in: canonicalBrokerIdList } },
            { responsibleBrokerId: null, brokerId: { in: canonicalBrokerIdList } },
          ],
        },
      ],
    } as any;
    const fixationGroups = await this.prisma.client.groupBy({
      by: ['brokerId', 'responsibleBrokerId', 'uniquenessStatus', 'fixationStatus'],
      where: fixationDateFilter,
      _count: true,
    });

    type BrokerFixationAggregate = {
      brokerId: string;
      total: number;
      conditionallyUnique: number;
      rejected: number;
      underReview: number;
      expired: number;
      fixed: number;
      submittedBySelf: number;
      submittedByOthers: number;
      submitterCounts: Map<string, number>;
    };

    const fixationByEffectiveBroker = new Map<string, BrokerFixationAggregate>();
    let conditionallyUnique = 0;
    let rejected = 0;
    let underReview = 0;
    let expired = 0;
    let fixed = 0;

    for (const group of fixationGroups as any[]) {
      const count = Number(group._count || 0);
      const effectiveBrokerId = group.responsibleBrokerId ?? group.brokerId;
      if (!canonicalBrokerIds.has(effectiveBrokerId)) continue;
      let aggregate = fixationByEffectiveBroker.get(effectiveBrokerId);
      if (!aggregate) {
        aggregate = {
          brokerId: effectiveBrokerId,
          total: 0,
          conditionallyUnique: 0,
          rejected: 0,
          underReview: 0,
          expired: 0,
          fixed: 0,
          submittedBySelf: 0,
          submittedByOthers: 0,
          submitterCounts: new Map<string, number>(),
        };
        fixationByEffectiveBroker.set(effectiveBrokerId, aggregate);
      }

      aggregate.total += count;
      if (group.uniquenessStatus === 'CONDITIONALLY_UNIQUE') {
        aggregate.conditionallyUnique += count;
        conditionallyUnique += count;
      } else if (group.uniquenessStatus === 'REJECTED') {
        aggregate.rejected += count;
        rejected += count;
      } else if (group.uniquenessStatus === 'UNDER_REVIEW') {
        aggregate.underReview += count;
        underReview += count;
      } else if (group.uniquenessStatus === 'EXPIRED') {
        aggregate.expired += count;
        expired += count;
      }
      if (group.fixationStatus === 'FIXED') {
        aggregate.fixed += count;
        fixed += count;
      }

      if (group.brokerId === effectiveBrokerId) aggregate.submittedBySelf += count;
      else aggregate.submittedByOthers += count;
      aggregate.submitterCounts.set(
        group.brokerId,
        (aggregate.submitterCounts.get(group.brokerId) || 0) + count,
      );
    }
    const totalFixations = conditionallyUnique + rejected + underReview + expired;

    // ─── Deals funnel (в периоде) ────────────────────────
    // A1 fix: используем signedAt если есть, иначе createdAt (для сделок
    // которые были засинканы позже фактической даты подписания)
    const dealPeriodFilter = {
      OR: [
        { signedAt: { gte: from, lt: toExclusive } },
        { AND: [{ signedAt: null }, { createdAt: { gte: from, lt: toExclusive } }] },
      ],
    };
    const dealStatusCounts = await this.prisma.deal.groupBy({
      by: ['status'],
      where: dealPeriodFilter,
      _count: true,
      _sum: { amount: true, commissionAmount: true },
    });
    const dealsFunnel = dealStatusCounts.map((d) => ({
      status: d.status,
      count: d._count,
      totalAmount: Number(d._sum.amount || 0),
      totalCommission: Number(d._sum.commissionAmount || 0),
    }));

    // ─── Top brokers (by paid commission in period) ──────
    const topBrokerRows = await this.prisma.deal.groupBy({
      by: ['brokerId'],
      where: {
        status: { in: ['PAID', 'COMMISSION_PAID'] },
        ...dealPeriodFilter,
      },
      _sum: { amount: true, commissionAmount: true },
      _count: true,
      orderBy: { _sum: { commissionAmount: 'desc' } },
      take: 10,
    });
    const brokerIds = topBrokerRows.map((r) => r.brokerId);
    const brokerMeta = brokerIds.length
      ? await this.prisma.broker.findMany({
          where: { id: { in: brokerIds } },
          select: { id: true, fullName: true, phone: true },
        })
      : [];
    const brokerMap = new Map(brokerMeta.map((b) => [b.id, b]));
    const topBrokers = topBrokerRows.map((r) => ({
      brokerId: r.brokerId,
      fullName: brokerMap.get(r.brokerId)?.fullName || '—',
      phone: brokerMap.get(r.brokerId)?.phone || '',
      dealsCount: r._count,
      totalAmount: Number(r._sum.amount || 0),
      totalCommission: Number(r._sum.commissionAmount || 0),
    }));

    // ─── Per-project stats (в периоде) ──────────────────
    const projectGroups = await this.prisma.deal.groupBy({
      by: ['project', 'status'],
      where: dealPeriodFilter,
      _count: true,
      _sum: { amount: true, commissionAmount: true, sqm: true },
    });
    const projectStats: Record<string, any> = {};
    for (const g of projectGroups) {
      const key = g.project;
      if (!projectStats[key]) {
        projectStats[key] = {
          project: key,
          totalDeals: 0,
          paidDeals: 0,
          totalAmount: 0,
          totalCommission: 0,
          totalSqm: 0,
        };
      }
      projectStats[key].totalDeals += g._count;
      if (g.status === 'PAID' || g.status === 'COMMISSION_PAID') {
        projectStats[key].paidDeals += g._count;
        projectStats[key].totalAmount += Number(g._sum.amount || 0);
        projectStats[key].totalCommission += Number(g._sum.commissionAmount || 0);
        projectStats[key].totalSqm += Number(g._sum.sqm || 0);
      }
    }

    // ─── Funnel stage distribution ───────────────────────
    // 2026-07-07 (багфикс): раньше воронка считалась за всё время, не
    // учитывая выбранный период — пользователь выбирал «Месяц», а видел
    // распределение всех брокеров за всю историю. Теперь фильтруем
    // группировку по createdAt in [from, to] — цифры совпадают с
    // «Новых в периоде» и графиком регистраций.
    const funnelGroups = await this.prisma.broker.groupBy({
      by: ['funnelStage'],
      where: { ...canonicalBrokerFilter, createdAt: { gte: from, lt: toExclusive } },
      _count: true,
    });
    const funnelByStage = funnelGroups.map((f) => ({ stage: f.funnelStage, count: f._count }));

    // ─── Broker-tour → Fixation → Deal funnel (в периоде) ─
    // 2026-07-07: сквозная воронка брокер-туров. Показывает, сколько
    // брокеров, посетивших тур в выбранном периоде, потом сделали
    // уникальную фиксацию и довели её до сделки. Ключевая метрика для
    // управления — раньше в аналитике не было вообще.
    const brokersOnTour = await this.prisma.broker.findMany({
      where: {
        role: 'BROKER',
        mergedIntoId: null,
        brokerTourVisited: true,
        brokerTourDate: { gte: from, lt: toExclusive },
      },
      select: { id: true, brokerTourDate: true },
    });
    const tourBrokerIds = brokersOnTour.map((b) => b.id);
    const tourBrokerIdSet = new Set(tourBrokerIds);
    const convertedBrokerIds = new Set<string>();
    let tourWithFixation = 0;
    let tourWithDeal = 0;
    if (tourBrokerIds.length > 0) {
      // Когорта задаётся датой тура в выбранном периоде, а конверсия —
      // lifetime после тура (верхнюю границу `to` намеренно не применяем).
      // Для делегированной заявки считаем responsibleBrokerId, иначе brokerId.
      const tourDateByBroker = new Map(
        brokersOnTour
          .filter((broker) => broker.brokerTourDate)
          .map((broker) => [broker.id, broker.brokerTourDate as Date]),
      );
      const earliestTourDate = new Date(
        Math.min(...Array.from(tourDateByBroker.values()).map((date) => date.getTime())),
      );
      const effectiveTourBrokerFilter = {
        OR: [
          { responsibleBrokerId: { in: tourBrokerIds } },
          { responsibleBrokerId: null, brokerId: { in: tourBrokerIds } },
        ],
      };
      const postEarliestTourFixationFilter = {
        OR: [
          { amoCreatedAt: { gt: earliestTourDate } },
          { amoCreatedAt: null, createdAt: { gt: earliestTourDate } },
        ],
      };
      const [tourFixationCandidates, tourDealCandidates] = await Promise.all([
        this.prisma.client.findMany({
          where: {
            AND: [effectiveTourBrokerFilter, postEarliestTourFixationFilter],
          },
          select: {
            brokerId: true,
            responsibleBrokerId: true,
            amoCreatedAt: true,
            createdAt: true,
          },
        }),
        this.prisma.deal.findMany({
          where: {
            status: { in: ['PAID', 'COMMISSION_PAID'] },
            AND: [
              {
                OR: [
                  { signedAt: { gt: earliestTourDate } },
                  { signedAt: null, createdAt: { gt: earliestTourDate } },
                ],
              },
              {
                client: {
                  AND: [effectiveTourBrokerFilter, postEarliestTourFixationFilter],
                },
              },
            ],
          },
          select: {
            signedAt: true,
            createdAt: true,
            client: {
              select: {
                brokerId: true,
                responsibleBrokerId: true,
                amoCreatedAt: true,
                createdAt: true,
              },
            },
          },
        }),
      ]);
      for (const client of tourFixationCandidates) {
        const effectiveBrokerId = client.responsibleBrokerId ?? client.brokerId;
        const tourDate = tourDateByBroker.get(effectiveBrokerId);
        const fixationDate = client.amoCreatedAt ?? client.createdAt;
        if (tourDate && fixationDate > tourDate) convertedBrokerIds.add(effectiveBrokerId);
      }
      const dealBrokerIds = new Set<string>();
      for (const deal of tourDealCandidates) {
        const effectiveBrokerId = deal.client.responsibleBrokerId ?? deal.client.brokerId;
        const tourDate = tourDateByBroker.get(effectiveBrokerId);
        const fixationDate = deal.client.amoCreatedAt ?? deal.client.createdAt;
        const dealDate = deal.signedAt ?? deal.createdAt;
        if (tourDate && fixationDate > tourDate && dealDate > tourDate) {
          dealBrokerIds.add(effectiveBrokerId);
        }
      }
      tourWithFixation = convertedBrokerIds.size;
      tourWithDeal = dealBrokerIds.size;
    }
    const brokerTourFunnel = {
      tourVisited: tourBrokerIds.length,
      withAnyFixation: tourWithFixation,
      withFixation: tourWithFixation,
      withDeal: tourWithDeal,
      toAnyFixationPct: tourBrokerIds.length > 0
        ? Math.round((tourWithFixation / tourBrokerIds.length) * 100)
        : 0,
      toFixationPct: tourBrokerIds.length > 0
        ? Math.round((tourWithFixation / tourBrokerIds.length) * 100)
        : 0,
      toDealPct: tourBrokerIds.length > 0
        ? Math.round((tourWithDeal / tourBrokerIds.length) * 100)
        : 0,
    };

    // ─── Аналитика по источникам брокеров (в периоде) ─────
    // 2026-07-07: Broker.source в БД был, но в аналитике не показывался.
    // Позволяет оценить эффективность каналов привлечения: лендинг vs
    // холодный обзвон vs брокер-туры.
    const sourceGroups = await this.prisma.broker.groupBy({
      by: ['source'],
      where: { ...canonicalBrokerFilter, createdAt: { gte: from, lt: toExclusive } },
      _count: true,
    });
    const bySource = sourceGroups
      .filter((s) => s.source)
      .map((s) => ({ source: s.source as string, count: s._count }))
      .sort((a, b) => b.count - a.count);

    // ─── Полная статистика по canonical brokers ───────────
    // В выдаче остаются и брокеры с нулём фиксаций; слитые карточки и
    // служебные роли не показываем. Для авторов подачи отдаём только ФИО.
    const missingSubmitterIds = Array.from(
      new Set((fixationGroups as any[]).map((group) => group.brokerId as string)),
    ).filter((id) => !canonicalBrokerIds.has(id));
    const extraSubmitters: Array<{ id: string; fullName: string }> = missingSubmitterIds.length
      ? await this.prisma.broker.findMany({
          where: { id: { in: missingSubmitterIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const brokerNameById = new Map<string, string>([
      ...canonicalBrokers.map((broker) => [broker.id, broker.fullName] as [string, string]),
      ...extraSubmitters.map((broker) => [broker.id, broker.fullName] as [string, string]),
    ]);

    const fixationsByBroker = canonicalBrokers
      .map((broker) => {
        const aggregate = fixationByEffectiveBroker.get(broker.id);
        const submitters = aggregate
          ? Array.from(aggregate.submitterCounts.entries())
              .map(([submitterId, count]) => ({
                brokerId: submitterId,
                fullName: brokerNameById.get(submitterId) || '—',
                count,
              }))
              .sort((a, b) => b.count - a.count || a.fullName.localeCompare(b.fullName, 'ru'))
          : [];
        return {
          brokerId: broker.id,
          fullName: broker.fullName,
          phone: broker.phone,
          brokerTourVisited: broker.brokerTourVisited,
          brokerTourDate: broker.brokerTourDate,
          brokerTourInPeriod: tourBrokerIdSet.has(broker.id),
          fixationAfterTour: convertedBrokerIds.has(broker.id),
          total: aggregate?.total || 0,
          conditionallyUnique: aggregate?.conditionallyUnique || 0,
          rejected: aggregate?.rejected || 0,
          underReview: aggregate?.underReview || 0,
          expired: aggregate?.expired || 0,
          fixed: aggregate?.fixed || 0,
          submittedBySelf: aggregate?.submittedBySelf || 0,
          submittedByOthers: aggregate?.submittedByOthers || 0,
          submitters,
        };
      })
      .sort((a, b) => b.total - a.total || a.fullName.localeCompare(b.fullName, 'ru'));

    // Сохраняем старый контракт UI, но строим его из новой корректной
    // агрегации: effective broker + effective fixation date.
    const canonicalBrokerById = new Map(canonicalBrokers.map((broker) => [broker.id, broker]));
    const topFixationBrokers = fixationsByBroker
      .filter((broker) => broker.conditionallyUnique > 0)
      .sort((a, b) => b.conditionallyUnique - a.conditionallyUnique)
      .slice(0, 10)
      .map((broker) => ({
        brokerId: broker.brokerId,
        fullName: broker.fullName,
        phone: canonicalBrokerById.get(broker.brokerId)?.phone || '',
        uniqueFixations: broker.conditionallyUnique,
      }));

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      brokers: {
        total: totalBrokers,
        active: activeBrokers,
        blocked: blockedBrokers,
        newInPeriod,
        registrationTrend,
        funnelByStage,
      },
      fixations: {
        total: totalFixations,
        conditionallyUnique,
        rejected,
        underReview,
        expired,
        fixed,
        uniqueRatio: totalFixations > 0 ? Math.round((conditionallyUnique / totalFixations) * 100) : 0,
      },
      deals: { funnel: dealsFunnel },
      topBrokers,
      // 2026-07-07: новые блоки — сквозная воронка брокер-туров и топ по
      // уникальным фиксациям. UI должен добавить их в /admin/analytics.
      brokerTourFunnel,
      fixationsByBroker,
      topFixationBrokers,
      bySource,
      projects: Object.values(projectStats),
    };
  }

  async getBrokerAnalytics(brokerId: string, period: { startDate?: string; endDate?: string }) {
    const dateFilter: any = {};
    if (period.startDate) dateFilter.gte = new Date(period.startDate);
    if (period.endDate) dateFilter.lte = new Date(period.endDate);
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    const [
      clientsCreated,
      uniqueFixations,
      meetingsHeld,
      dealsClosed,
      callsMade,
    ] = await Promise.all([
      this.prisma.client.count({
        where: {
          brokerId,
          ...notHistoricalClientWhere,
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
      }),
      // 2026-07-07: раньше конверсия считалась как dealsClosed / clientsCreated —
      // это неправильно: в знаменателе учитывались клиенты в UNDER_REVIEW и
      // REJECTED, у которых сделки быть не могло в принципе. Теперь считаем
      // «Фиксация → Сделка»: сколько % уникальных фиксаций дошли до PAID.
      this.prisma.client.count({
        where: {
          brokerId,
          ...notHistoricalClientWhere,
          uniquenessStatus: 'CONDITIONALLY_UNIQUE',
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
      }),
      this.prisma.meeting.count({
        where: {
          brokerId,
          status: 'COMPLETED',
          ...(hasDateFilter ? { date: dateFilter } : {}),
        },
      }),
      this.prisma.deal.count({
        where: {
          brokerId,
          status: { in: ['PAID', 'COMMISSION_PAID'] },
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
      }),
      this.prisma.call.count({
        where: {
          brokerId,
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
      }),
    ]);

    return {
      period: {
        startDate: period.startDate || null,
        endDate: period.endDate || null,
      },
      metrics: {
        clientsCreated,
        uniqueFixations,
        meetingsHeld,
        dealsClosed,
        callsMade,
        // «% фиксаций, которые дошли до сделки» — правильная воронка брокера.
        conversionRate: uniqueFixations > 0
          ? Math.round((dealsClosed / uniqueFixations) * 100)
          : 0,
      },
    };
  }
}
