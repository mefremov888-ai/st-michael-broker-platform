import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Enriches Lot.photos with personal photos from Yandex.Disk, on top of the
 * ProfitBase feed images already synced by CatalogService.
 *
 * Two public Yandex.Disk folders are used (no OAuth token — public API):
 *  - Source 1: personal photos matched by ProfitBase externalId, for all
 *    buildings — folder name contains "id: <externalId>".
 *  - Source 2: personal photos matched by apartment number, Corpus 3 (Soho)
 *    only — folder tree is floor/section/"<name> - <apt>.<subIndex>".
 *    Only consulted when Source 1 has no match for the lot.
 *
 * Final gallery order written to Lot.photos:
 *   [plan image] + [floor plan (Lot.layoutUrl, type="plan floor" in the feed)]
 *   + [personal Yandex.Disk photos] + [remaining feed images]
 *
 * Full background: docs/yandex-disk-photos-feed.md.
 */

const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const DOWNLOAD_API = 'https://cloud-api.yandex.net/v1/disk/public/resources/download';

export const SOURCE_1_PUBLIC_KEY =
  process.env.YANDEX_LOT_PHOTOS_SOURCE1 || 'https://disk.360.yandex.ru/d/csRx3vArvfTcPA';
export const SOURCE_2_PUBLIC_KEY =
  process.env.YANDEX_LOT_PHOTOS_SOURCE2 || 'https://disk.360.yandex.ru/d/m0i7Gq5M2G2n7Q';

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || process.env.UPLOADS_DIR || '/app/uploads';
const TARGET_DIR = path.join(UPLOAD_ROOT, 'lot-photos');

const MAX_RETRY_ATTEMPTS = 7;
const DOWNLOAD_PACING_MS = 400;
const LIST_PAGE_LIMIT = 200;

export const ID_FOLDER_RE = /id[:\s]*([0-9]{4,})/i;
export const APT_LEAF_RE = /(\d+)\.(\d+)\s*$/;
export const SOHO_BUILDING_RE = /soho|корпус\s*3\b/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|heic|gif)$/i;

export interface YdItem {
  type: 'dir' | 'file';
  name: string;
  path: string;
  mime_type?: string;
  size?: number;
}

export interface PersonalPhoto {
  path: string;
  name: string;
  size: number;
  publicKey: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isImageItem(item: Pick<YdItem, 'name' | 'mime_type'>): boolean {
  if (item.mime_type?.startsWith('image/')) return true;
  return IMAGE_EXT_RE.test(item.name);
}

export function sanitizeName(s: string): string {
  return s.replace(/[^\w\s.,()\-]/g, '_').replace(/\s+/g, ' ').trim();
}

/**
 * "ЗГ3-2-3-22/1" → last dash-segment "22/1" → aptNum "22", subIndex "1".
 * Falls back to subIndex "0" when the segment has no "/<n>" part, and again
 * as an explicit fallback key when the exact subIndex is not found in the
 * Source 2 index (some studios were split later and the folder was named
 * without a subIndex).
 */
export function buildSohoKey(lotNumber: string, floor: number, subIndexOverride?: string): string | null {
  const seg = (lotNumber || '').split('-').pop();
  if (!seg) return null;
  const [aptNum, subIndexRaw] = seg.split('/');
  if (!aptNum) return null;
  const subIndex = subIndexOverride ?? subIndexRaw ?? '0';
  return `${floor}-${aptNum}-${subIndex}`;
}

/**
 * Assembles the final gallery order: plan first, then the per-floor site
 * plan (Lot.layoutUrl — distinct from the apartment plan, see feed type
 * "plan floor"), then personal Yandex.Disk photos, then whatever else came
 * from the feed (minus the plan and floor plan, already placed). Always
 * keeps the "remaining feed photos" tail, regardless of whether personal
 * photos were found — see docs/yandex-disk-photos-feed.md.
 */
export function computePhotoOrder(
  planImageUrl: string | null,
  layoutUrl: string | null,
  personalUrls: string[],
  feedImageUrls: string[],
): string[] {
  const rest = (feedImageUrls || []).filter(
    (u) => Boolean(u) && u !== planImageUrl && u !== layoutUrl,
  );
  return [planImageUrl, layoutUrl, ...personalUrls, ...rest].filter((u): u is string => Boolean(u));
}

@Injectable()
export class YandexDiskPhotosService {
  private readonly logger = new Logger(YandexDiskPhotosService.name);

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async enrichLotsWithPhotos(): Promise<{
    matchedSource1: number;
    matchedSource2: number;
    updated: number;
    failed: number;
  }> {
    if (!fs.existsSync(TARGET_DIR)) fs.mkdirSync(TARGET_DIR, { recursive: true });

    this.logger.log('Building Yandex.Disk source-1 (by externalId) index...');
    const source1 = await this.buildSource1Index();
    this.logger.log(`Source 1: ${source1.size} lot folders with photos found`);

    this.logger.log('Building Yandex.Disk source-2 (Soho, by apartment number) index...');
    const source2 = await this.buildSource2Index();
    this.logger.log(`Source 2: ${source2.size} lot folders with photos found`);

    const lots = await this.prisma.lot.findMany({
      select: {
        id: true,
        externalId: true,
        number: true,
        building: true,
        floor: true,
        planImageUrl: true,
        layoutUrl: true,
        feedImageUrls: true,
      },
    });

    let matchedSource1 = 0;
    let matchedSource2 = 0;
    let updated = 0;
    let failed = 0;

    for (const lot of lots) {
      try {
        let bucket: string | null = null;
        let personal: PersonalPhoto[] | undefined;

        if (lot.externalId && source1.has(lot.externalId)) {
          bucket = lot.externalId;
          personal = source1.get(bucket);
          matchedSource1++;
        } else if (SOHO_BUILDING_RE.test(lot.building || '')) {
          const key = buildSohoKey(lot.number, lot.floor);
          const keyFallback = buildSohoKey(lot.number, lot.floor, '0');
          if (key && source2.has(key)) {
            bucket = key;
            personal = source2.get(key);
            matchedSource2++;
          } else if (keyFallback && source2.has(keyFallback)) {
            bucket = keyFallback;
            personal = source2.get(keyFallback);
            matchedSource2++;
          }
        }

        const personalUrls: string[] = [];
        if (bucket && personal?.length) {
          for (const file of personal) {
            personalUrls.push(await this.downloadFile(file, bucket));
          }
        }

        const photos = computePhotoOrder(lot.planImageUrl, lot.layoutUrl, personalUrls, lot.feedImageUrls);
        await this.prisma.lot.update({ where: { id: lot.id }, data: { photos } });
        updated++;
      } catch (e) {
        this.logger.error(`Photo enrichment failed for lot ${lot.id} (${lot.number}): ${e}`);
        failed++;
      }
    }

    this.logger.log(
      `Photo enrichment done: source1=${matchedSource1}, source2=${matchedSource2}, updated=${updated}, failed=${failed}`,
    );
    return { matchedSource1, matchedSource2, updated, failed };
  }

  private async buildSource1Index(): Promise<Map<string, PersonalPhoto[]>> {
    const index = new Map<string, PersonalPhoto[]>();
    await this.walkSource1('/', index);
    return index;
  }

  private async walkSource1(dirPath: string, index: Map<string, PersonalPhoto[]>): Promise<void> {
    const items = await this.listDir(SOURCE_1_PUBLIC_KEY, dirPath);
    for (const it of items) {
      if (it.type !== 'dir') continue;
      const m = it.name.match(ID_FOLDER_RE);
      if (m) {
        const externalId = m[1];
        const photos = await this.collectImagesIn(SOURCE_1_PUBLIC_KEY, it.path);
        if (photos.length) {
          if (index.has(externalId)) {
            this.logger.warn(`Source 1: duplicate id ${externalId} — folder "${it.path}" ignored`);
          } else {
            index.set(externalId, photos);
          }
        }
      } else {
        await this.walkSource1(it.path, index);
      }
    }
  }

  private async buildSource2Index(): Promise<Map<string, PersonalPhoto[]>> {
    const index = new Map<string, PersonalPhoto[]>();
    const floors = await this.listDir(SOURCE_2_PUBLIC_KEY, '/');
    for (const floorDir of floors) {
      if (floorDir.type !== 'dir') continue;
      const floor = Number(floorDir.name);
      if (!Number.isFinite(floor)) continue; // structural non-numeric folder, skip
      await this.walkSource2Floor(floorDir.path, floor, index);
    }
    return index;
  }

  private async walkSource2Floor(dirPath: string, floor: number, index: Map<string, PersonalPhoto[]>): Promise<void> {
    const items = await this.listDir(SOURCE_2_PUBLIC_KEY, dirPath);
    for (const it of items) {
      if (it.type !== 'dir') continue;
      const m = it.name.match(APT_LEAF_RE);
      if (m) {
        const [, aptNum, subIndex] = m;
        const photos = await this.collectImagesIn(SOURCE_2_PUBLIC_KEY, it.path);
        if (photos.length) {
          const key = `${floor}-${aptNum}-${subIndex}`;
          if (index.has(key)) {
            this.logger.warn(`Source 2: duplicate key ${key} — folder "${it.path}" ignored`);
          } else {
            index.set(key, photos);
          }
        }
      } else {
        await this.walkSource2Floor(it.path, floor, index);
      }
    }
  }

  /** Direct file children only — never recurses (e.g. skips "необработанные" subfolders). */
  private async collectImagesIn(publicKey: string, dirPath: string): Promise<PersonalPhoto[]> {
    const items = await this.listDir(publicKey, dirPath);
    return items
      .filter((it) => it.type === 'file' && isImageItem(it))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((it) => ({ path: it.path, name: it.name, size: it.size || 0, publicKey }));
  }

  private async listDir(publicKey: string, dirPath: string): Promise<YdItem[]> {
    const items: YdItem[] = [];
    let offset = 0;
    for (;;) {
      const url = new URL(API);
      url.searchParams.set('public_key', publicKey);
      url.searchParams.set('path', dirPath);
      url.searchParams.set('limit', String(LIST_PAGE_LIMIT));
      url.searchParams.set('offset', String(offset));
      const res = await this.fetchWithRetry(url.toString());
      if (!res.ok) throw new Error(`Yandex.Disk list ${res.status} for "${dirPath}"`);
      const data: any = await res.json();
      const batch: YdItem[] = data?._embedded?.items || [];
      items.push(...batch);
      if (batch.length < LIST_PAGE_LIMIT) break;
      offset += LIST_PAGE_LIMIT;
    }
    return items;
  }

  private async getDownloadHref(publicKey: string, filePath: string): Promise<string> {
    const url = new URL(DOWNLOAD_API);
    url.searchParams.set('public_key', publicKey);
    url.searchParams.set('path', filePath);
    const res = await this.fetchWithRetry(url.toString());
    if (!res.ok) throw new Error(`Yandex.Disk download-link ${res.status} for "${filePath}"`);
    const data: any = await res.json();
    return data.href;
  }

  /** Idempotent — skips re-download when a same-size file is already cached. */
  private async downloadFile(file: PersonalPhoto, bucket: string): Promise<string> {
    const bucketSafe = sanitizeName(bucket);
    const nameSafe = sanitizeName(file.name);
    const localDir = path.join(TARGET_DIR, bucketSafe);
    const localPath = path.join(localDir, nameSafe);
    const publicUrl = `/files/lot-photos/${encodeURIComponent(bucketSafe)}/${encodeURIComponent(nameSafe)}`;

    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

    if (fs.existsSync(localPath)) {
      const stat = fs.statSync(localPath);
      if (stat.size === file.size) return publicUrl;
    }

    const href = await this.getDownloadHref(file.publicKey, file.path);
    const res = await this.fetchWithRetry(href);
    if (!res.ok) throw new Error(`Yandex.Disk file download ${res.status} for "${file.path}"`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${localPath}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, localPath);
    await sleep(DOWNLOAD_PACING_MS);
    return publicUrl;
  }

  /** Retries 429/503 with exponential backoff (cap 30s), 7 attempts total. */
  private async fetchWithRetry(url: string): Promise<Response> {
    let lastRes: Response | undefined;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      const res = await fetch(url);
      if (res.status !== 429 && res.status !== 503) return res;
      lastRes = res;
      const waitSec = Math.min(2 ** attempt, 30);
      this.logger.warn(`Yandex.Disk API ${res.status}, retry ${attempt + 1}/${MAX_RETRY_ATTEMPTS} in ${waitSec}s`);
      await sleep(waitSec * 1000);
    }
    return lastRes as Response;
  }
}
