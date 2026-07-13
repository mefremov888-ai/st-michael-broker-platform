import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { rateFor, rateForWithPolicy } from '../commission/commission.service';

@Injectable()
export class DealsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  // KPI-сводка по ВСЕМ сделкам брокера (без пагинации) — для дашборда.
  async getDealsSummary(brokerId: string, query: { status?: string; project?: string }) {
    const where: any = { brokerId };
    if (query.status) where.status = query.status;
    if (query.project) where.project = query.project;

    const agg = await this.prisma.deal.aggregate({
      where,
      _count: { id: true },
      _sum: { amount: true, commissionAmount: true, sqm: true },
    });

    const paidAgg = await this.prisma.deal.aggregate({
      where: { ...where, status: { in: ['PAID', 'COMMISSION_PAID'] } },
      _sum: { commissionAmount: true },
    });

    return {
      total: agg._count.id,
      totalAmount: Number(agg._sum.amount ?? 0),
      totalCommission: Number(agg._sum.commissionAmount ?? 0),
      totalSqm: Number(agg._sum.sqm ?? 0),
      paidCommission: Number(paidAgg._sum.commissionAmount ?? 0),
    };
  }

  async getDeals(
    brokerId: string,
    query: {
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      status?: string;
      project?: string;
    },
  ) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = { brokerId };
    if (query.status) {
      where.status = query.status;
    } else {
      // By default show only real deal stages, exclude PENDING and CANCELLED
      where.status = { in: ['SIGNED', 'PAID', 'COMMISSION_PAID'] };
    }
    if (query.project) where.project = query.project;

    // Сортировка по дате сделки из amoCRM (signedAt), fallback на createdAt.
    // Правка 2026-05-13: сделки видны в реальном временном порядке.
    const orderBy: any = {};
    orderBy[query.sortBy || 'signedAt'] = query.sortOrder || 'desc';

    const [deals, total] = await Promise.all([
      this.prisma.deal.findMany({
        where,
        include: {
          client: { select: { id: true, fullName: true, phone: true } },
          lot: { select: { id: true, number: true, building: true, floor: true, rooms: true } },
          agency: { select: { id: true, name: true, inn: true } },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.deal.count({ where }),
    ]);

    return {
      deals,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getDeal(id: string, brokerId: string) {
    const deal = await this.prisma.deal.findUnique({
      where: { id },
      include: {
        client: true,
        lot: true,
        agency: true,
        broker: { select: { id: true, fullName: true, phone: true } },
      },
    });

    if (!deal) throw new NotFoundException('Deal not found');

    // Brokers can only see their own deals
    if (deal.brokerId !== brokerId) {
      const requester = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (requester?.role === 'BROKER') {
        throw new NotFoundException('Deal not found');
      }
    }

    return deal;
  }

  async createDeal(
    brokerId: string,
    data: {
      clientId: string;
      lotId?: string;
      project: string;
      contractType?: string;
      amount: number;
      sqm: number;
    },
  ) {
    // Verify client belongs to broker
    const client = await this.prisma.client.findUnique({ where: { id: data.clientId } });
    if (!client) throw new NotFoundException('Client not found');
    if (client.brokerId !== brokerId) throw new BadRequestException('Client does not belong to you');

    // Get broker's primary agency for commission calculation
    const brokerAgency = await this.prisma.brokerAgency.findFirst({
      where: { brokerId, isPrimary: true },
      include: { agency: true },
    });

    // Calculate commission rate — учитываем активную политику из админки
    // (правка 2026-07-01). Раньше был хардкод rateFor(project, agency.commissionLevel),
    // из-за чего ручное POST /deals не уважало FLAT/PROGRESSIVE политики
    // в /admin/commission-policies. rateForWithPolicy — тот же helper что и
    // в amo-sync и калькуляторе, единый источник истины.
    const totalSqm = Number(brokerAgency?.agency?.totalSqmSold || 0);
    const policyResult = await rateForWithPolicy(this.prisma, data.project, totalSqm);
    const rate = policyResult.rate;
    const commissionAmount = (data.amount * rate) / 100;

    const deal = await this.prisma.deal.create({
      data: {
        clientId: data.clientId,
        brokerId,
        lotId: data.lotId,
        agencyId: brokerAgency?.agencyId,
        project: data.project as any,
        contractType: data.contractType as any,
        amount: data.amount,
        sqm: data.sqm,
        commissionRate: rate,
        commissionAmount,
      },
      include: { client: true, lot: true },
    });

    // Update client status
    await this.prisma.client.update({
      where: { id: data.clientId },
      data: { status: 'DEAL' },
    });

    // Update broker funnel stage
    await this.prisma.broker.update({
      where: { id: brokerId },
      data: { funnelStage: 'DEAL' },
    });

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        userId: brokerId,
        action: 'DEAL_CREATED',
        entity: 'Deal',
        entityId: deal.id,
        payload: { clientId: data.clientId, amount: data.amount },
      },
    });

    return deal;
  }

  async updateDeal(
    id: string,
    brokerId: string,
    data: { contractType?: string; amount?: number; sqm?: number; status?: string },
  ) {
    const deal = await this.prisma.deal.findUnique({ where: { id } });
    if (!deal) throw new NotFoundException('Deal not found');
    if (deal.brokerId !== brokerId) {
      const requester = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (requester?.role === 'BROKER') throw new BadRequestException('Not your deal');
    }

    const updateData: any = {};
    if (data.contractType) updateData.contractType = data.contractType;
    if (data.amount) {
      updateData.amount = data.amount;
      updateData.commissionAmount = (data.amount * Number(deal.commissionRate)) / 100;
    }
    if (data.sqm) updateData.sqm = data.sqm;
    if (data.status) {
      updateData.status = data.status;
      if (data.status === 'SIGNED') updateData.signedAt = new Date();
      if (data.status === 'PAID') updateData.paidAt = new Date();
    }

    const updated = await this.prisma.deal.update({
      where: { id },
      data: updateData,
      include: { client: true, lot: true },
    });

    return updated;
  }

  async attachAgency(id: string, managerId: string, data: { agencyId: string; reason: string }) {
    const deal = await this.prisma.deal.findUnique({ where: { id } });
    if (!deal) throw new NotFoundException('Deal not found');

    const updated = await this.prisma.deal.update({
      where: { id },
      data: { agencyId: data.agencyId },
      include: { agency: true },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: managerId,
        action: 'AGENCY_ATTACHED',
        entity: 'Deal',
        entityId: id,
        payload: { agencyId: data.agencyId, reason: data.reason },
      },
    });

    return { deal: updated, message: 'Agency attached successfully' };
  }
}
