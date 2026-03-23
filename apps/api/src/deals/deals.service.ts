import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class DealsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getDeals() {
    // TODO: Implement with broker context
    return { deals: [], total: 0 };
  }

  async getDeal(id: string) {
    const deal = await this.prisma.deal.findUnique({
      where: { id },
      include: { client: true, lot: true, agency: true },
    });

    if (!deal) {
      throw new Error('Deal not found');
    }

    return deal;
  }

  async attachAgency(id: string, data: { agencyId: string; reason: string }) {
    const deal = await this.prisma.deal.update({
      where: { id },
      data: { agencyId: data.agencyId },
    });

    // TODO: Log audit

    return { deal, message: 'Agency attached successfully' };
  }
}