export interface ProfitbaseLot {
  id: string;
  number: string;
  building: string;
  floor: number;
  rooms: string;
  sqm: number;
  price: number;
  pricePerSqm: number;
  status: string;
  layout_url?: string;
  plan_image_url?: string;
  description?: string;
  project?: string;
  updated_at: string;
}

export interface LotFilters {
  project?: string;
  building?: string;
  floor?: number;
  rooms?: string;
  priceMin?: number;
  priceMax?: number;
  status?: string;
}

export interface IProfitbaseAdapter {
  getLots(filters?: LotFilters): Promise<ProfitbaseLot[]>;
  getLotById(id: string): Promise<ProfitbaseLot>;
  syncLots(): Promise<{ created: number; updated: number }>;
}

export class ProfitbaseAdapter implements IProfitbaseAdapter {
  private baseUrl: string;
  private apiKey: string;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor() {
    this.baseUrl = (process.env.PROFITBASE_BASE_URL || '').replace(/\/$/, '');
    this.apiKey = process.env.PROFITBASE_API_KEY || '';
  }

  private async authenticate(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    if (!this.baseUrl || !this.apiKey) {
      throw new Error('PROFITBASE_BASE_URL and PROFITBASE_API_KEY must be set');
    }

    const res = await fetch(`${this.baseUrl}/json/authentication`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'api-key',
        credentials: { pb_api_key: this.apiKey },
      }),
    });

    if (!res.ok) throw new Error(`Profitbase auth failed: ${res.status}`);
    const data: any = await res.json();
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + 3500 * 1000; // ~1 hour
    return this.accessToken!;
  }

  private async request(path: string, params?: Record<string, string>): Promise<any> {
    const token = await this.authenticate();
    const url = new URL(`${this.baseUrl}/json${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) throw new Error(`Profitbase API error: ${res.status} ${path}`);
    return res.json();
  }

  private mapStatus(pbStatus: string): string {
    const s = pbStatus?.toLowerCase() || '';
    if (s === 'free' || s === 'available' || s === 'свободно') return 'AVAILABLE';
    if (s === 'booked' || s === 'забронировано' || s === 'бронь') return 'BOOKED';
    if (s === 'sold' || s === 'продано') return 'SOLD';
    return 'AVAILABLE';
  }

  private mapRooms(rooms: any): string {
    if (!rooms && rooms !== 0) return 'Студия';
    const r = String(rooms).toLowerCase();
    if (r === '0' || r.includes('студ') || r === 'studio') return 'Студия';
    return String(rooms);
  }

  private mapLot(raw: any): ProfitbaseLot {
    const sqm = Number(raw.area || raw.sqm || raw.total_area || 0);
    const price = Number(raw.price || 0);
    return {
      id: String(raw.id || raw.external_id || ''),
      number: String(raw.number || raw.flat_number || raw.name || ''),
      building: String(raw.house?.name || raw.building || raw.house_name || raw.corpus || '1'),
      floor: Number(raw.floor || 0),
      rooms: this.mapRooms(raw.rooms || raw.rooms_count || raw.room_count),
      sqm,
      price,
      pricePerSqm: sqm > 0 ? Math.round(price / sqm) : 0,
      status: this.mapStatus(raw.status || raw.sale_status || ''),
      layout_url: raw.layout_url || raw.plan_url || null,
      plan_image_url: raw.plan_image_url || raw.image_url || raw.plan || null,
      description: raw.description || null,
      project: raw.project || null,
      updated_at: raw.updated_at || new Date().toISOString(),
    };
  }

  async getLots(filters?: LotFilters): Promise<ProfitbaseLot[]> {
    const params: Record<string, string> = {};
    if (filters?.status) params.status = filters.status;
    if (filters?.building) params.house = filters.building;
    if (filters?.rooms) params.rooms = filters.rooms;

    const data = await this.request('/property', params);
    const items = Array.isArray(data) ? data : data?.data || data?.items || data?.properties || [];
    return items.map((item: any) => this.mapLot(item));
  }

  async getLotById(id: string): Promise<ProfitbaseLot> {
    const data = await this.request(`/property/${id}`);
    const raw = data?.data || data;
    return this.mapLot(raw);
  }

  async syncLots(): Promise<{ created: number; updated: number }> {
    const lots = await this.getLots();
    return { created: lots.length, updated: 0 };
  }
}
