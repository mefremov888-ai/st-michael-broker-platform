import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class FavoritesService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async list(brokerId: string) {
    const favorites = await this.prisma.favoriteLot.findMany({
      where: { brokerId },
      include: { lot: true },
      orderBy: { createdAt: 'desc' },
    });
    return favorites.map((f) => ({
      id: f.id,
      addedAt: f.createdAt,
      lot: f.lot,
    }));
  }

  async listIds(brokerId: string) {
    const favorites = await this.prisma.favoriteLot.findMany({
      where: { brokerId },
      select: { lotId: true },
    });
    return favorites.map((f) => f.lotId);
  }

  async add(brokerId: string, lotId: string) {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (!lot) throw new NotFoundException('Lot not found');
    // upsert по уникальному (brokerId, lotId) — повторный POST не падает.
    return this.prisma.favoriteLot.upsert({
      where: { brokerId_lotId: { brokerId, lotId } },
      create: { brokerId, lotId },
      update: {},
    });
  }

  async remove(brokerId: string, lotId: string) {
    await this.prisma.favoriteLot.deleteMany({
      where: { brokerId, lotId },
    });
    return { ok: true };
  }
}
