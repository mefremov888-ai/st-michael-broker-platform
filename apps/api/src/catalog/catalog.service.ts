import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class CatalogService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getLots(filters: any) {
    const where: any = {};

    if (filters.project) where.project = filters.project;
    if (filters.status) where.status = filters.status;
    if (filters.rooms) where.rooms = filters.rooms;
    if (filters.floor) where.floor = filters.floor;
    if (filters.priceMin) where.price = { gte: filters.priceMin };
    if (filters.priceMax) where.price = { ...where.price, lte: filters.priceMax };
    if (filters.sqmMin) where.sqm = { gte: filters.sqmMin };
    if (filters.sqmMax) where.sqm = { ...where.sqm, lte: filters.sqmMax };

    const lots = await this.prisma.lot.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return { lots, total: lots.length };
  }

  async getLot(id: string) {
    const lot = await this.prisma.lot.findUnique({
      where: { id },
    });

    if (!lot) {
      throw new Error('Lot not found');
    }

    return lot;
  }
}