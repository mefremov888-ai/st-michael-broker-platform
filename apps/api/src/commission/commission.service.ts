import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient, CommissionLevel, CommissionMode } from '@st-michael/database';

/**
 * Найти активную политику комиссии для проекта на заданную дату.
 * Если политика не найдена — возвращает null (вызывающий должен fallback на хардкод).
 *
 * Правка 2026-05-13: реализация политик с переключением PROGRESSIVE↔FLAT
 * с произвольными периодами действия.
 */
export async function findActivePolicy(
  prisma: any,
  project: string,
  date: Date = new Date(),
): Promise<any | null> {
  const policy = await prisma.commissionPolicy.findFirst({
    where: {
      project,
      isActive: true,
      startDate: { lte: date },
      endDate: { gte: date },
    },
    orderBy: { startDate: 'desc' },
  });
  return policy;
}

/**
 * Расчёт ставки комиссии с учётом активной политики на дату.
 * Если policy.mode = FLAT → возвращает policy.flatRate.
 * Если policy.mode = PROGRESSIVE → ищет уровень в policy.levels по totalSqm.
 * Если policy не найдена → fallback на хардкод COMMISSION_RATES.
 */
export async function rateForWithPolicy(
  prisma: any,
  project: string,
  totalSqm: number,
  date: Date = new Date(),
): Promise<{ rate: number; level: string | null; mode: CommissionMode | 'FALLBACK' }> {
  const policy = await findActivePolicy(prisma, project, date);
  if (!policy) {
    // Fallback на хардкод (старая логика на случай если БД пуста).
    const level = levelForSqm(project, totalSqm);
    return { rate: rateFor(project, level), level, mode: 'FALLBACK' };
  }
  if (policy.mode === 'FLAT') {
    return { rate: Number(policy.flatRate || 0), level: null, mode: 'FLAT' };
  }
  // PROGRESSIVE — берём шкалу из policy.levels.
  const levels = (policy.levels as any[]) || [];
  // Сортируем по minSqm desc и берём первый matching.
  const sorted = [...levels].sort((a, b) => Number(b.minSqm) - Number(a.minSqm));
  const matched = sorted.find((l: any) => totalSqm >= Number(l.minSqm)) || sorted[sorted.length - 1];
  return {
    rate: Number(matched?.rate || 0),
    level: matched?.level || 'START',
    mode: 'PROGRESSIVE',
  };
}

// Commission rates by project and level (per ТЗ "Условия_вознаграждения_объединённая_шкала")
// Period: with 1 January through 30 June 2026.
export const COMMISSION_RATES: Record<string, Record<string, number>> = {
  ZORGE9: {
    START: 5.0,
    BASIC: 5.5,
    STRONG: 6.0,
    PREMIUM: 6.5,
    ELITE: 7.0,
    CHAMPION: 7.5,
    LEGEND: 8.0,
  },
  SILVER_BOR: {
    START: 5.0,
    BASIC: 5.25,
    STRONG: 5.5,
    PREMIUM: 5.75,
    ELITE: 6.0,
    CHAMPION: 6.25,
    // Серебряный Бор не имеет уровня LEGEND — максимум CHAMPION 6.25%
  },
};

// Thresholds — РАЗНЫЕ для каждого проекта (минимум м² для уровня).
// Уровень считается по общему накопленному метражу агентства, но шкала своя на проект.
export const LEVEL_THRESHOLDS_BY_PROJECT: Record<string, { level: CommissionLevel; minSqm: number }[]> = {
  ZORGE9: [
    { level: CommissionLevel.LEGEND, minSqm: 700 },
    { level: CommissionLevel.CHAMPION, minSqm: 500 },
    { level: CommissionLevel.ELITE, minSqm: 320 },
    { level: CommissionLevel.PREMIUM, minSqm: 200 },
    { level: CommissionLevel.STRONG, minSqm: 120 },
    { level: CommissionLevel.BASIC, minSqm: 60 },
    { level: CommissionLevel.START, minSqm: 0 },
  ],
  SILVER_BOR: [
    { level: CommissionLevel.CHAMPION, minSqm: 400 },
    { level: CommissionLevel.ELITE, minSqm: 280 },
    { level: CommissionLevel.PREMIUM, minSqm: 171 },
    { level: CommissionLevel.STRONG, minSqm: 96 },
    { level: CommissionLevel.BASIC, minSqm: 48 },
    { level: CommissionLevel.START, minSqm: 0 },
  ],
};

// Compute level for given total sqm sold within a specific project's scale.
// Thresholds are sorted descending — pick first match.
export function levelForSqm(project: string, totalSqm: number): CommissionLevel {
  const scale = LEVEL_THRESHOLDS_BY_PROJECT[project] || LEVEL_THRESHOLDS_BY_PROJECT.ZORGE9;
  for (const t of scale) {
    if (totalSqm >= t.minSqm) return t.level;
  }
  return CommissionLevel.START;
}

// Get rate for project + level (with safe fallback if SB doesn't have LEGEND).
export function rateFor(project: string, level: CommissionLevel | string): number {
  const projectRates = COMMISSION_RATES[project] || COMMISSION_RATES.ZORGE9;
  return projectRates[level as string] ?? projectRates.START ?? 5.0;
}

const INSTALLMENT_DISCOUNT = 0.5;

@Injectable()
export class CommissionService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getMyCommission(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      include: {
        brokerAgencies: {
          include: { agency: true },
          where: { isPrimary: true },
          take: 1,
        },
      },
    });

    if (!broker) throw new NotFoundException('Broker not found');

    const primaryAgency = broker.brokerAgencies[0]?.agency;
    const totalSqmSold = primaryAgency ? Number(primaryAgency.totalSqmSold) : 0;

    // Правка 2026-07-01: возвращаем не только текущую ставку и режим, но и
    // scales — актуальную шкалу для проекта из активной политики (или
    // хардкод-fallback). Раньше UI кабинета рендерил шкалу из своего
    // хардкода — правки админа в /admin/commission-policies не долетали.
    const rates: Record<string, number> = {};
    const modes: Record<string, string> = {};
    const scales: Record<string, Array<{ level: string; minSqm: number; rate: number }> | null> = {};
    const flatRates: Record<string, number | null> = {};
    for (const project of ['ZORGE9', 'SILVER_BOR']) {
      const r = await rateForWithPolicy(this.prisma, project, totalSqmSold);
      rates[project] = r.rate;
      modes[project] = r.mode;

      const policy = await findActivePolicy(this.prisma, project);
      if (policy?.mode === 'FLAT') {
        scales[project] = null;
        flatRates[project] = Number(policy.flatRate || 0);
      } else if (policy?.mode === 'PROGRESSIVE' && Array.isArray(policy.levels)) {
        scales[project] = (policy.levels as any[]).map((l: any) => ({
          level: String(l.level),
          minSqm: Number(l.minSqm),
          rate: Number(l.rate),
        }));
        flatRates[project] = null;
      } else {
        // Fallback на хардкод.
        const thresholds = LEVEL_THRESHOLDS_BY_PROJECT[project] || [];
        const asc = [...thresholds].sort((a, b) => a.minSqm - b.minSqm);
        scales[project] = asc.map((t) => ({
          level: t.level,
          minSqm: t.minSqm,
          rate: rateFor(project, t.level),
        }));
        flatRates[project] = null;
      }
    }

    // Правка 2026-07-01: прогресс к следующему уровню считаем по порогам
    // активной политики, а не по хардкоду. Для FLAT прогресс скрываем.
    let level: any = null;
    let nextLevel: any = null;
    let nextLevelSqm: number | null = null;
    let progress = 0;
    if (modes.ZORGE9 !== 'FLAT') {
      const zorgeScale = scales.ZORGE9 || [];
      const ascending = [...zorgeScale].sort((a, b) => a.minSqm - b.minSqm);
      // Текущий уровень = самый высокий, для которого totalSqmSold >= minSqm.
      let current = ascending[0] || null;
      for (const s of ascending) {
        if (totalSqmSold >= s.minSqm) current = s;
      }
      level = current?.level || 'START';
      const currentIdx = ascending.findIndex((s) => s.level === level);
      const next = ascending[currentIdx + 1];
      if (next) {
        nextLevel = next.level;
        nextLevelSqm = next.minSqm;
        progress = Math.min(100, Math.round((totalSqmSold / next.minSqm) * 100));
      } else {
        progress = 100;
      }
    }

    // Get commission stats
    const deals = await this.prisma.deal.findMany({
      where: { brokerId, status: { in: ['PAID', 'COMMISSION_PAID'] } },
      select: { commissionAmount: true, commissionRate: true, project: true },
    });

    const totalEarned = deals.reduce((sum, d) => sum + Number(d.commissionAmount), 0);
    const quarterlyBonus = primaryAgency?.quarterlyBonusStreak || 0;

    return {
      level,
      rates,
      modes, // { ZORGE9: 'FLAT' | 'PROGRESSIVE' | 'FALLBACK', SILVER_BOR: ... }
      scales, // 2026-07-01: шкала уровней из активной политики (null для FLAT).
      flatRates, // 2026-07-01: фикс-ставка из FLAT политики (null для PROGRESSIVE).
      totalSqmSold,
      progress,
      nextLevel,
      nextLevelSqm,
      totalEarned,
      quarterlyBonusStreak: quarterlyBonus,
      agency: primaryAgency
        ? { id: primaryAgency.id, name: primaryAgency.name, inn: primaryAgency.inn }
        : null,
    };
  }

  async calculateCommission(data: {
    amount: number;
    project: string;
    paymentMode: 'FULL' | 'INSTALLMENT' | 'SUBSIDIZED_MORTGAGE';
    brokerId: string;
  }) {
    // 2026-07-01: раньше калькулятор требовал agencyInn в форме. Теперь
    // берём primary-агентство брокера напрямую из БД — брокер и так знает
    // от какого агентства работает.
    const broker = await this.prisma.broker.findUnique({
      where: { id: data.brokerId },
      include: {
        brokerAgencies: {
          include: { agency: true },
          where: { isPrimary: true },
          take: 1,
        },
      },
    });
    const agency = broker?.brokerAgencies[0]?.agency;
    const totalSqm = agency ? Number(agency.totalSqmSold) : 0;

    // 2026-07-02: параметры «Рассрочка» и «Субсидированная ипотека» теперь
    // свои для каждого проекта — читаем *ByProject[project], fallback на
    // старое общее поле, затем на константу (0.5% и 4%).
    const commissionCms = await this.prisma.siteContent.findUnique({ where: { key: 'commission' } });
    const cmsValue = (commissionCms?.value || {}) as any;
    const iep = cmsValue?.installmentEnabledByProject || {};
    const idp = cmsValue?.installmentDiscountByProject || {};
    const sep = cmsValue?.subsidizedMortgageEnabledByProject || {};
    const srp = cmsValue?.subsidizedMortgageRateByProject || {};
    const installmentDiscount = Number(idp?.[data.project] ?? cmsValue?.installmentDiscount ?? INSTALLMENT_DISCOUNT);
    const subsidizedMortgageRate = Number(srp?.[data.project] ?? cmsValue?.subsidizedMortgageRate ?? 4);
    const installmentEnabled = (iep?.[data.project] !== undefined ? iep[data.project] : cmsValue?.installmentEnabled) !== false;
    const subsidizedMortgageEnabled = (sep?.[data.project] !== undefined ? sep[data.project] : cmsValue?.subsidizedMortgageEnabled) !== false;

    // Учитываем активную политику (FLAT / PROGRESSIVE) из /admin/commission-policies.
    const r = await rateForWithPolicy(this.prisma, data.project, totalSqm);
    let rate = r.rate;
    const level = r.level; // Для FLAT — null (в UI показываем «Фиксированная»).
    const mode = r.mode; // 'FLAT' | 'PROGRESSIVE' | 'FALLBACK'

    // Применяем модификатор по типу оплаты (после ставки из политики).
    // Если админ выключил вариант в CMS — модификатор не применяем
    // (клиент выберет вариант, а на бэке отработает как FULL).
    let effectivePaymentMode: typeof data.paymentMode = data.paymentMode;
    if (data.paymentMode === 'INSTALLMENT' && installmentEnabled) {
      rate = Math.max(0, rate - installmentDiscount);
    } else if (data.paymentMode === 'SUBSIDIZED_MORTGAGE' && subsidizedMortgageEnabled) {
      rate = subsidizedMortgageRate;
    } else {
      effectivePaymentMode = 'FULL';
    }

    const commission = (data.amount * rate) / 100;

    return {
      amount: data.amount,
      level,
      mode,
      rate,
      commission,
      paymentMode: effectivePaymentMode,
      installmentDiscount,
      installmentEnabled,
      subsidizedMortgageRate,
      subsidizedMortgageEnabled,
      agencyName: agency?.name || null,
    };
  }

  async getBrokerCommission(brokerId: string) {
    const deals = await this.prisma.deal.findMany({
      where: { brokerId, status: { in: ['SIGNED', 'PAID', 'COMMISSION_PAID'] } },
      include: { client: { select: { fullName: true } }, lot: { select: { number: true } } },
      orderBy: { signedAt: 'desc' },
    });

    return deals.map((deal) => ({
      id: deal.id,
      clientName: deal.client.fullName,
      lotNumber: deal.lot?.number || null,
      project: deal.project,
      amount: Number(deal.amount),
      sqm: Number(deal.sqm),
      rate: Number(deal.commissionRate),
      commission: Number(deal.commissionAmount),
      status: deal.status,
      isInstallment: deal.isInstallment,
      // signedAt — дата из amoCRM, createdAt — день нашего синка. Правка 2026-05-13.
      signedAt: deal.signedAt,
      createdAt: deal.createdAt,
    }));
  }
}
