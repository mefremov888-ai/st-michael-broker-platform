import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { XMLParser } from 'fast-xml-parser';

const FEEDS = [
  {
    url: process.env.PROFITBASE_FEED_ZORGE || 'https://pb7828.profitbase.ru/export/profitbase_xml/cccbe8c77d59ace56d69e0b05cb11ced?scheme=https',
    project: 'ZORGE9',
  },
  {
    url: process.env.PROFITBASE_FEED_SILVER || 'https://pb7828.profitbase.ru/export/profitbase_xml/9829a3c5d6882f1a1cb12906ee9025ee?scheme=https',
    project: 'SILVER_BOR',
  },
];

@Injectable()
export class CatalogService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async syncFromFeed() {
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalOffers = 0;

    for (const feed of FEEDS) {
      const result = await this.syncSingleFeed(feed.url, feed.project);
      totalCreated += result.created;
      totalUpdated += result.updated;
      totalSkipped += result.skipped;
      totalOffers += result.total;
    }

    return { created: totalCreated, updated: totalUpdated, skipped: totalSkipped, total: totalOffers };
  }

  private async syncSingleFeed(feedUrl: string, defaultProject: string) {
    const res = await fetch(feedUrl);
    if (!res.ok) throw new BadRequestException(`Feed fetch failed: ${res.status}`);

    const xml = await res.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => name === 'offer' || name === 'image' || name === 'custom-field' || name === 'special-offer',
    });
    const parsed = parser.parse(xml);
    const offers = parsed?.['realty-feed']?.offer || [];

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const offer of offers) {
      const externalId = String(offer['@_internal-id'] || '');
      if (!externalId) { skipped++; continue; }

      const lotNumber = String(offer.number || '');
      if (lotNumber.toLowerCase().includes('test') || lotNumber.toLowerCase().includes('тест')) { skipped++; continue; }

      const status = this.mapStatus(offer.status);
      const rooms = this.mapRooms(offer.rooms, offer.studio);
      const sqm = Number(offer?.area?.value || 0);
      const price = Number(offer?.price?.value || 0);
      const pricePerSqm = Number(offer?.['price-meter']?.value || (sqm > 0 ? Math.round(price / sqm) : 0));

      const projectName = offer?.object?.name || '';
      const project = this.mapProject(projectName) || defaultProject;

      const propertyType = offer?.property_type || null;
      const images = Array.isArray(offer.image) ? offer.image : offer.image ? [offer.image] : [];
      const imageUrl = (img: any): string | null => (typeof img === 'string' ? img : img?.['#text'] || null);
      const planImage = images.find((img: any) => (img?.['@_type'] || '') === 'plan');
      const planImageUrl = imageUrl(planImage);
      // ProfitBase tags the apartment plan(s) as type="plan" and a separate
      // per-floor site plan as type="plan floor" (one per floor, shared by
      // every unit on it) — distinct from the generic house/facade/building
      // photos that follow. Reuses Lot.layoutUrl, which already existed for
      // exactly this but was only ever populated by the ProfitBase webhook,
      // never by this feed sync.
      const planFloorImage = images.find((img: any) => (img?.['@_type'] || '') === 'plan floor');
      const layoutUrl = imageUrl(planFloorImage);
      // Everything except type="plan" — offers often carry 2-3 apartment-plan
      // renders, and only the first (planImageUrl above) is shown; the rest
      // duplicate what personal Yandex.Disk photos already cover, so they're
      // dropped here rather than surfacing again in the "remaining feed
      // photos" tail. type="plan floor" (layoutUrl) is kept — it's placed
      // separately by computePhotoOrder. See docs/yandex-disk-photos-feed.md.
      const feedImageUrls = images
        .filter((img: any) => (img?.['@_type'] || '') !== 'plan')
        .map(imageUrl)
        .filter((url: string | null): url is string => Boolean(url));

      // Parse additional features from custom-fields / property_type
      const customFields = Array.isArray(offer['custom-field']) ? offer['custom-field'] : offer['custom-field'] ? [offer['custom-field']] : [];

      // Helper: get value of a custom field by name match, return numeric or string
      const getCF = (namePattern: RegExp): string => {
        const cf = customFields.find((f: any) => namePattern.test(String(f?.name || '')));
        return cf?.value ? String(cf.value).trim() : '';
      };

      // Feature is present if specific "area" field > 0 OR yes/да checkbox
      const isTruthyValue = (v: string): boolean => {
        if (!v) return false;
        const s = v.toLowerCase().trim();
        if (['0', 'нет', 'no', 'false', '-', ''].includes(s)) return false;
        // If numeric — check > 0
        const n = Number(s.replace(',', '.'));
        if (!isNaN(n)) return n > 0;
        // "да"/"yes"/"true"/any text → truthy
        return true;
      };

      const balconyValue = getCF(/балкон/i);
      const loggiaValue = getCF(/лоджи/i);
      const hasBalcony = isTruthyValue(balconyValue) || isTruthyValue(loggiaValue);

      const terraceValue = getCF(/террас/i);
      const hasTerrace = isTruthyValue(terraceValue);

      // Penthouse: only if property_type explicitly says so
      const isPenthouse = /пентхаус|penthouse/i.test(String(offer?.property_type || ''));

      // Extended features (TZ catalog filters §7)
      const isCornerLayout = isTruthyValue(getCF(/уголов/i));
      const hasStorage = isTruthyValue(getCF(/кладов/i));
      const twoBathrooms = isTruthyValue(getCF(/два сан|2 сан/i));
      const hasMasterBedroom = isTruthyValue(getCF(/мастер.?спальн/i));
      const isUrbanVilla = /урбан.?вилл/i.test(String(offer?.property_type || ''));
      const isViewLot = isTruthyValue(getCF(/видов/i));
      // Hi-flat: ceiling height ≥ 4.0 m
      const ceilingValue = getCF(/потолк|потолок|высота потолк/i);
      const ceilingNum = Number(ceilingValue.replace(',', '.'));
      const isHighFlat = !isNaN(ceilingNum) && ceilingNum >= 4.0;

      // Parse special-offers (discount)
      const specialOffersRaw = offer?.['special-offers']?.['special-offer'];
      const specialOffers = Array.isArray(specialOffersRaw) ? specialOffersRaw : specialOffersRaw ? [specialOffersRaw] : [];
      let discountPrice: number | null = null;
      let discountPercent: number | null = null;
      let discountName: string | null = null;
      if (specialOffers.length > 0) {
        // Pick the best (largest) discount
        const best = specialOffers.reduce((best: any, cur: any) => {
          const curPrice = Number(cur?.['discount-price'] || 0);
          const bestPrice = Number(best?.['discount-price'] || Infinity);
          return curPrice && curPrice < bestPrice ? cur : best;
        }, specialOffers[0]);
        discountPrice = Number(best?.['discount-price'] || 0) || null;
        const unit = (best?.['discount-unit'] || '').toUpperCase();
        if (unit === 'PERCENT') discountPercent = Number(best?.value || 0) || null;
        discountName = best?.name || null;
      }

      const data = {
        number: String(offer.number || ''),
        project: project as any,
        building: offer?.house?.name || '',
        floor: Number(offer.floor || 0),
        rooms,
        sqm,
        price,
        pricePerSqm,
        status: status as any,
        propertyType,
        layoutUrl,
        planImageUrl,
        feedImageUrls,
        description: offer?.['window-view'] || null,
        floorsTotal: Number(offer?.house?.['floors-total'] || 0) || null,
        buildingSection: offer?.['building-section'] ? String(offer['building-section']) : null,
        windowView: offer?.['window-view'] || null,
        builtYear: Number(offer?.house?.['built-year'] || 0) || null,
        readyQuarter: Number(offer?.house?.['ready-quarter'] || 0) || null,
        buildingState: offer?.house?.['building-state'] || null,
        hasBalcony,
        hasTerrace,
        isPenthouse,
        isCornerLayout,
        hasStorage,
        twoBathrooms,
        hasMasterBedroom,
        isUrbanVilla,
        isViewLot,
        isHighFlat,
        discountPrice,
        discountPercent,
        discountName,
      };

      try {
        const existing = await this.prisma.lot.findUnique({ where: { externalId } });
        if (existing) {
          await this.prisma.lot.update({ where: { externalId }, data });
          updated++;
        } else {
          await this.prisma.lot.create({ data: { ...data, externalId } });
          created++;
        }
      } catch {
        skipped++;
      }
    }

    return { created, updated, skipped, total: offers.length };
  }


  private mapStatus(status: string): string {
    const s = (status || '').toUpperCase();
    if (s === 'AVAILABLE' || s === 'FREE') return 'AVAILABLE';
    if (s === 'BOOKED' || s === 'RESERVED') return 'BOOKED';
    if (s === 'SOLD') return 'SOLD';
    if (s === 'UNAVAILABLE') return 'SOLD';
    return 'AVAILABLE';
  }

  private mapRooms(rooms: any, studio: any): string {
    if (String(studio) === '1') return 'Студия';
    if (!rooms && rooms !== 0) return 'Студия';
    return String(rooms);
  }

  private mapProject(name: string): string {
    const n = name.toLowerCase();
    if (n.includes('зорге') || n.includes('zorge')) return 'ZORGE9';
    if (n.includes('серебр') || n.includes('silver')) return 'SILVER_BOR';
    return 'ZORGE9';
  }

  async getLots(filters: {
    project?: string;
    status?: string;
    rooms?: string;
    floor?: number;
    floorMin?: number;
    floorMax?: number;
    priceMin?: number;
    priceMax?: number;
    sqmMin?: number;
    sqmMax?: number;
    building?: string;
    propertyType?: string;
    windowView?: string;
    readyYear?: number | string;
    hasBalcony?: boolean | string;
    hasTerrace?: boolean | string;
    isPenthouse?: boolean | string;
    isCornerLayout?: boolean | string;
    hasStorage?: boolean | string;
    twoBathrooms?: boolean | string;
    hasMasterBedroom?: boolean | string;
    isUrbanVilla?: boolean | string;
    isViewLot?: boolean | string;
    isHighFlat?: boolean | string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = Number(filters.page) || 1;
    const limit = Number(filters.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {
      NOT: [
        { number: { contains: 'TEST', mode: 'insensitive' } },
        { number: { contains: 'ТЕСТ', mode: 'insensitive' } },
      ],
    };
    if (filters.project) where.project = filters.project;
    if (filters.status) where.status = filters.status;
    else where.status = { not: 'SOLD' };
    if (filters.rooms) where.rooms = filters.rooms;
    if (filters.building) where.building = filters.building;
    if (filters.propertyType) {
      where.propertyType = { contains: filters.propertyType, mode: 'insensitive' };
    }
    if (filters.windowView) {
      where.windowView = { contains: filters.windowView, mode: 'insensitive' };
    }
    if (filters.readyYear) {
      // Bug fix 2026-06-02: фронт может прислать 'done' для запроса всех
      // уже сданных лотов (Зорге 9 — 2023/2024). Группируем в одну опцию.
      if (String(filters.readyYear) === 'done') {
        where.builtYear = { lt: new Date().getFullYear() };
      } else {
        where.builtYear = Number(filters.readyYear);
      }
    }

    const toBool = (v: any) => v === true || v === 'true' || v === '1' || v === 1;
    if (filters.hasBalcony && toBool(filters.hasBalcony)) where.hasBalcony = true;
    if (filters.hasTerrace && toBool(filters.hasTerrace)) where.hasTerrace = true;
    if (filters.isPenthouse && toBool(filters.isPenthouse)) where.isPenthouse = true;
    if (filters.isCornerLayout && toBool(filters.isCornerLayout)) where.isCornerLayout = true;
    if (filters.hasStorage && toBool(filters.hasStorage)) where.hasStorage = true;
    if (filters.twoBathrooms && toBool(filters.twoBathrooms)) where.twoBathrooms = true;
    if (filters.hasMasterBedroom && toBool(filters.hasMasterBedroom)) where.hasMasterBedroom = true;
    if (filters.isUrbanVilla && toBool(filters.isUrbanVilla)) where.isUrbanVilla = true;
    if (filters.isViewLot && toBool(filters.isViewLot)) where.isViewLot = true;
    if (filters.isHighFlat && toBool(filters.isHighFlat)) where.isHighFlat = true;

    if (filters.floor || filters.floorMin || filters.floorMax) {
      where.floor = {};
      if (filters.floor) where.floor = Number(filters.floor);
      else {
        if (filters.floorMin) where.floor.gte = Number(filters.floorMin);
        if (filters.floorMax) where.floor.lte = Number(filters.floorMax);
      }
    }

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
      this.prisma.lot.findMany({ where, skip, take: limit, orderBy }),
      this.prisma.lot.count({ where }),
    ]);

    // Get distinct property types for filters (exclude SOLD)
    const notSold = { status: { not: 'SOLD' as any } };
    const propertyTypes = await this.prisma.lot.groupBy({
      by: ['propertyType'],
      where: { propertyType: { not: null }, ...notSold },
      _count: true,
    });

    // Get distinct projects (exclude SOLD)
    const projects = await this.prisma.lot.groupBy({
      by: ['project'],
      where: notSold,
      _count: true,
    });

    // КБ6 (2026-05-25): фильтр «Корпус» учитывает project + propertyType +
    // rooms, чтобы не показывать корпуса, в которых нет лотов с выбранным
    // типом/комнатностью.
    const buildingsWhere: any = { ...notSold, building: { not: '' } };
    if (filters.project) buildingsWhere.project = filters.project;
    if (filters.propertyType) buildingsWhere.propertyType = { contains: filters.propertyType, mode: 'insensitive' };
    if (filters.rooms) buildingsWhere.rooms = filters.rooms;
    const buildings = await this.prisma.lot.groupBy({
      by: ['building'],
      where: buildingsWhere,
      _count: true,
      orderBy: { building: 'asc' },
    });

    // Feature counts (respect project filter) — to hide checkboxes for features absent in project
    const featureWhere: any = { ...notSold };
    if (filters.project) featureWhere.project = filters.project;
    const [
      balconyCount, terraceCount, penthouseCount,
      cornerCount, storageCount, twoBathCount,
      masterBedroomCount, urbanVillaCount, viewLotCount, highFlatCount,
    ] = await Promise.all([
      this.prisma.lot.count({ where: { ...featureWhere, hasBalcony: true } }),
      this.prisma.lot.count({ where: { ...featureWhere, hasTerrace: true } }),
      this.prisma.lot.count({ where: { ...featureWhere, isPenthouse: true } }),
      this.prisma.lot.count({ where: { ...featureWhere, isCornerLayout: true } }),
      this.prisma.lot.count({ where: { ...featureWhere, hasStorage: true } }),
      this.prisma.lot.count({ where: { ...featureWhere, twoBathrooms: true } }),
      this.prisma.lot.count({ where: { ...featureWhere, hasMasterBedroom: true } }),
      this.prisma.lot.count({ where: { ...featureWhere, isUrbanVilla: true } }),
      this.prisma.lot.count({ where: { ...featureWhere, isViewLot: true } }),
      this.prisma.lot.count({ where: { ...featureWhere, isHighFlat: true } }),
    ]);

    // Distinct window views
    const views = await this.prisma.lot.groupBy({
      by: ['windowView'],
      where: { ...notSold, windowView: { not: null } },
      _count: true,
    });

    // Distinct ready years
    const years = await this.prisma.lot.groupBy({
      by: ['builtYear'],
      where: { ...notSold, builtYear: { not: null } },
      _count: true,
      orderBy: { builtYear: 'asc' },
    });

    return {
      lots,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      filters: {
        propertyTypes: propertyTypes.map((p) => ({ type: p.propertyType, count: p._count })),
        projects: projects.map((p) => ({ project: p.project, count: p._count })),
        buildings: buildings.map((b) => ({ building: b.building, count: b._count })),
        views: views.map((v) => ({ view: v.windowView, count: v._count })),
        years: years.map((y) => ({ year: y.builtYear, count: y._count })),
        featureCounts: {
          hasBalcony: balconyCount,
          hasTerrace: terraceCount,
          isPenthouse: penthouseCount,
          isCornerLayout: cornerCount,
          hasStorage: storageCount,
          twoBathrooms: twoBathCount,
          hasMasterBedroom: masterBedroomCount,
          isUrbanVilla: urbanVillaCount,
          isViewLot: viewLotCount,
          isHighFlat: highFlatCount,
        },
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
