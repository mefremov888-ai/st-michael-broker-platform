import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class CatalogService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getLots(filters: {
    project?: string;
    status?: string;
    rooms?: string;
    floor?: number;
    priceMin?: number;
    priceMax?: number;
    sqmMin?: number;
    sqmMax?: number;
    building?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.project) where.project = filters.project;
    if (filters.status) where.status = filters.status;
    if (filters.rooms) where.rooms = filters.rooms;
    if (filters.building) where.building = filters.building;
    if (filters.floor) where.floor = Number(filters.floor);

    if (filters.priceMin || filters.priceMax) {
      where.price = {};
      if (filters.priceMin) where.price.gte = Number(filters.priceMin);
      if (filters.priceMax) where.price.lte = Number(filters.priceMax);
    }

    if (filters.sqmMin || filters.sqmMax) {
      where.sqm = {};
      if (filters.sqmMin) where.sqm.gte = Number(filters.sqmMin);
      if (filters.sqmMax) where.sqm.lte = Number(filters.sqmMax);
    }

    const orderBy: any = {};
    orderBy[filters.sortBy || 'price'] = filters.sortOrder || 'asc';

    const [lots, total] = await Promise.all([
      this.prisma.lot.findMany({
        where,
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.lot.count({ where }),
    ]);

    // Aggregate stats
    const stats = await this.prisma.lot.aggregate({
      where,
      _min: { price: true, sqm: true },
      _max: { price: true, sqm: true },
      _avg: { price: true, pricePerSqm: true },
    });

    return {
      lots,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      stats: {
        priceMin: Number(stats._min.price || 0),
        priceMax: Number(stats._max.price || 0),
        priceAvg: Math.round(Number(stats._avg.price || 0)),
        sqmMin: Number(stats._min.sqm || 0),
        sqmMax: Number(stats._max.sqm || 0),
        avgPricePerSqm: Math.round(Number(stats._avg.pricePerSqm || 0)),
      },
    };
  }

  async getLot(id: string) {
    const lot = await this.prisma.lot.findUnique({
      where: { id },
      include: {
        deals: {
          select: { id: true, status: true, createdAt: true },
          where: { status: { not: 'CANCELLED' } },
        },
      },
    });

    if (!lot) throw new NotFoundException('Lot not found');

    return lot;
  }

  async getAvailableRooms(project?: string) {
    const where: any = { status: 'AVAILABLE' };
    if (project) where.project = project;

    const lots = await this.prisma.lot.groupBy({
      by: ['rooms'],
      where,
      _count: true,
      _min: { price: true },
      _max: { price: true },
    });

    return lots.map((g) => ({
      rooms: g.rooms,
      count: g._count,
      priceMin: Number(g._min.price),
      priceMax: Number(g._max.price),
    }));
  }

  async getStats() {
    const [total, available, booked, sold] = await Promise.all([
      this.prisma.lot.count(),
      this.prisma.lot.count({ where: { status: 'AVAILABLE' } }),
      this.prisma.lot.count({ where: { status: 'BOOKED' } }),
      this.prisma.lot.count({ where: { status: 'SOLD' } }),
    ]);

    const byProject = await this.prisma.lot.groupBy({
      by: ['project'],
      _count: true,
      _avg: { price: true },
    });

    return {
      total,
      available,
      booked,
      sold,
      byProject: byProject.map((p) => ({
        project: p.project,
        count: p._count,
        avgPrice: Math.round(Number(p._avg.price || 0)),
      })),
    };
  }
}
