import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Prisma } from '@st-michael/database';
import type { ReadableStreamDefaultReader } from 'node:stream/web';

export const FEED_MAX_ATTEMPTS = 3;
export const FEED_TIMEOUT_MS = 30_000;
// Protected read-only verification measured a valid Zorge export at 26,466,669
// decoded bytes. 32MiB keeps an explicit cap with about 27% growth headroom.
export const FEED_MAX_BYTES = 32 * 1024 * 1024;
export const FEED_MAX_OFFERS = 50_000;
const MAX_RETRY_DELAY_MS = 10_000;
type FailureCode = 'FEED_URL_INVALID' | 'FEED_TLS_CONFIGURATION_INVALID' |
  'FEED_HTTP_ERROR' | 'FEED_NETWORK_ERROR' | 'FEED_TIMEOUT' |
  'FEED_RESPONSE_INVALID' | 'FEED_BODY_TOO_LARGE' | 'FEED_BODY_INCOMPLETE' |
  'FEED_BODY_INVALID' | 'FEED_RETRY_AFTER_LIMIT' | 'FEED_XML_INVALID' |
  'FEED_OFFERS_INVALID';

/** Never includes a feed URL/export token, response body or raw network error. */
export class ProfitbaseFeedError extends Error {
  constructor(readonly code: FailureCode, readonly httpStatus?: number) {
    super(httpStatus === undefined ? `Feed load failed: ${code}` : `Feed fetch failed: ${httpStatus}`);
    this.name = 'ProfitbaseFeedError';
  }
}
function reject(code: FailureCode): never { throw new ProfitbaseFeedError(code); }

export function validateProfitbaseFeedUrl(raw: string): string {
  // These two project exports belong to this one known account. Reject an
  // unexpected configured origin instead of following redirects to local or
  // third-party targets. HTTPS verification is never weakened.
  if (typeof raw !== 'string' || !/^https:\/\/pb7828\.profitbase\.ru\/export\/profitbase_xml\/[a-f0-9]{32}\?scheme=https$/.test(raw)) reject('FEED_URL_INVALID');
  const url = new URL(raw);
  if (url.origin !== 'https://pb7828.profitbase.ru' || url.username || url.password || url.hash || url.href !== raw) reject('FEED_URL_INVALID');
  return url.href;
}

export function retryDelayMs(header: string | null, attempt: number, now = Date.now()): number {
  let delay: number | null = null;
  if (header !== null) {
    const value = header.trim();
    if (/^[0-9]+$/.test(value)) delay = Number(value) * 1000;
    // RFC 9110 HTTP-date forms only: permissive Date.parse also accepts invalid
    // Retry-After values such as "1.5" as calendar dates, causing an early retry.
    else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value) || /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [0-9]{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value) || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [0-9]|[0-9]{2}) [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/.test(value)) {
      // The obsolete asctime form has implicit UTC; never use the host timezone.
      const date = Date.parse(value.endsWith('GMT') ? value : value + ' GMT');
      if (Number.isFinite(date)) delay = Math.max(0, date - now);
    }
  }
  // Never retry earlier than a longer provider Retry-After instruction. If it
  // cannot fit this bounded job, leave the last good catalog and report failure.
  if (delay !== null && (!Number.isFinite(delay) || delay > MAX_RETRY_DELAY_MS)) reject('FEED_RETRY_AFTER_LIMIT');
  return delay === null ? Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS) : delay;
}

function object(value: any): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function optionalScalar(value: any): boolean { return value === undefined || ['string', 'number'].includes(typeof value); }
function optionalNumber(value: any, integer = false): boolean {
  return value === undefined || (optionalScalar(value) && Number.isFinite(Number(value)) && (!integer || Number.isInteger(Number(value))));
}
function optionalInt32(value: any): boolean {
  return optionalNumber(value, true) && (value === undefined || (Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647));
}
function fitsLotDecimal(value: number, integerDigits: number): boolean {
  // PostgreSQL rounds NUMERIC(p,2) before checking precision. Validate the same
  // actual Number used by the existing mapping, including a carry at .995.
  return Number.isFinite(value) && new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).abs().lt(new Prisma.Decimal(10).pow(integerDigits));
}
export type ProfitbaseFeedMetadata = { sourceGeneratedAt: string | null };
/** Only a timezone-qualified ISO date is persisted; never raw provider text. */
export function normalizeFeedGeneratedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day, hour, minute, second] = value.match(/\d+/g)!.slice(0, 6).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function parseValidatedProfitbaseFeed(xml: string): { offers: any[]; metadata: ProfitbaseFeedMetadata } {
  // XMLValidator alone accepts forbidden raw XML 1.0 controls (including NUL,
  // which PostgreSQL text cannot store). Reject these before parsing any rows.
  if (!xml.trim() || /<!DOCTYPE|<!ENTITY/i.test(xml) || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(xml)) reject('FEED_XML_INVALID');
  try { if (XMLValidator.validate(xml) !== true) reject('FEED_XML_INVALID'); }
  catch { reject('FEED_XML_INVALID'); }
  let parsed: any;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '@_', maxNestedTags: 64,
      isArray: (name) => ['offer', 'image', 'custom-field', 'special-offer'].includes(name),
    }).parse(xml);
  } catch { reject('FEED_XML_INVALID'); }
  if (!object(parsed) || Object.keys(parsed).some((name) => !['?xml', 'realty-feed'].includes(name)) || !object(parsed['realty-feed'])) reject('FEED_XML_INVALID');
  const offers = parsed['realty-feed'].offer;
  if (!Array.isArray(offers) || offers.length === 0 || offers.length > FEED_MAX_OFFERS) reject('FEED_OFFERS_INVALID');
  const ids = new Set<string>();
  // Validate the entire collection BEFORE any lot upsert. A well-formed XML
  // document with corrupt scalar/price fields is not a partial catalog update.
  for (const offer of offers) {
    const id = offer?.['@_internal-id'];
    if (!object(offer) || typeof id !== 'string' || !id.trim() || id.length > 128 || /[\x00-\x1f\x7f]/.test(id) || ids.has(id)) reject('FEED_OFFERS_INVALID');
    ids.add(id);
    if (offer.status !== undefined && typeof offer.status !== 'string') reject('FEED_OFFERS_INVALID');
    if (offer.object?.name !== undefined && typeof offer.object.name !== 'string') reject('FEED_OFFERS_INVALID');
    for (const field of ['number', 'floor']) if (offer[field] !== undefined && !['string', 'number'].includes(typeof offer[field])) reject('FEED_OFFERS_INVALID');
    for (const field of ['area', 'price', 'price-meter']) {
      if (offer[field] === undefined) continue;
      const value = offer[field]?.value;
      // ProfitBase can publish <value/> for an unpriced lot. Keep the existing
      // mapping's blank -> zero / price-per-sqm fallback behavior, while still
      // rejecting invalid containers, nested values, NaN and negative numbers.
      if (!object(offer[field]) || !['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0) reject('FEED_OFFERS_INVALID');
    }
    const sqm = Number(offer?.area?.value || 0), price = Number(offer?.price?.value || 0);
    const pricePerSqm = Number(offer?.['price-meter']?.value || (sqm > 0 ? Math.round(price / sqm) : 0));
    // Lot: sqm/pricePerSqm NUMERIC(10,2); price NUMERIC(14,2).
    if (!fitsLotDecimal(sqm, 8) || !fitsLotDecimal(price, 12) || !fitsLotDecimal(pricePerSqm, 8)) reject('FEED_OFFERS_INVALID');
    if (!optionalInt32(offer.floor) || !optionalScalar(offer.rooms) || !optionalScalar(offer['building-section'])) reject('FEED_OFFERS_INVALID');
    if (offer.studio !== undefined && !['string', 'number', 'boolean'].includes(typeof offer.studio)) reject('FEED_OFFERS_INVALID');
    for (const field of ['property_type', 'window-view']) if (offer[field] !== undefined && typeof offer[field] !== 'string') reject('FEED_OFFERS_INVALID');
    // Optional containers may be empty XML tags, but their mapped values must
    // not become arrays/objects/NaN that fail after earlier offers were written.
    for (const field of ['object', 'house', 'special-offers']) if (offer[field] !== undefined && offer[field] !== '' && !object(offer[field])) reject('FEED_OFFERS_INVALID');
    const house = offer.house;
    for (const field of ['name', 'building-state']) if (house?.[field] !== undefined && typeof house[field] !== 'string') reject('FEED_OFFERS_INVALID');
    for (const field of ['floors-total', 'built-year', 'ready-quarter']) if (!optionalInt32(house?.[field])) reject('FEED_OFFERS_INVALID');
    for (const image of offer.image || []) {
      if (typeof image === 'string') continue;
      if (!object(image) || Object.keys(image).some((key) => key !== '#text' && !key.startsWith('@_')) || Object.values(image).some((value) => !['string', 'number', 'boolean'].includes(typeof value)) || (image['#text'] !== undefined && typeof image['#text'] !== 'string') || (image['@_type'] !== undefined && typeof image['@_type'] !== 'string')) reject('FEED_OFFERS_INVALID');
    }
    for (const field of offer['custom-field'] || []) {
      if (!object(field) || (field.name !== undefined && typeof field.name !== 'string') || (field.value !== undefined && !['string', 'number', 'boolean'].includes(typeof field.value))) reject('FEED_OFFERS_INVALID');
    }
    for (const special of offer['special-offers']?.['special-offer'] || []) {
      if (!object(special) || !optionalNumber(special['discount-price']) || !optionalNumber(special.value)) reject('FEED_OFFERS_INVALID');
      for (const field of ['discount-unit', 'name']) if (special[field] !== undefined && typeof special[field] !== 'string') reject('FEED_OFFERS_INVALID');
      if (!fitsLotDecimal(Number(special['discount-price'] || 0), 12) || ((special['discount-unit'] || '').toUpperCase() === 'PERCENT' && !fitsLotDecimal(Number(special.value || 0), 3))) reject('FEED_OFFERS_INVALID');
    }
  }
  return { offers, metadata: { sourceGeneratedAt: normalizeFeedGeneratedAt(parsed['realty-feed']['generation-date']) } };
}

export function parseValidatedProfitbaseOffers(xml: string): any[] {
  return parseValidatedProfitbaseFeed(xml).offers;
}

type Dependencies = {
  fetchImpl?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onMetadata?: (metadata: ProfitbaseFeedMetadata) => void;
};
export async function loadProfitbaseOffers(rawUrl: string, dependencies: Dependencies = {}): Promise<any[]> {
  const url = validateProfitbaseFeedUrl(rawUrl);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') reject('FEED_TLS_CONFIGURATION_INVALID');
  const fetchImpl = dependencies.fetchImpl || fetch;
  const wait = dependencies.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now || Date.now;
  for (let attempt = 1; attempt <= FEED_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let retryAfter: string | null = null, retryDelay = 0;
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, failure) => {
      timer = setTimeout(() => { controller.abort(); failure(new ProfitbaseFeedError('FEED_TIMEOUT')); }, FEED_TIMEOUT_MS);
    });
    try {
      const work = async () => {
        response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/xml, text/xml;q=0.9' } });
        if (controller.signal.aborted) reject('FEED_TIMEOUT');
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.redirected === true || (response.url && response.url !== url)) reject('FEED_RESPONSE_INVALID');
        retryAfter = response.headers.get('retry-after');
        if (response.status < 200 || response.status >= 300) throw new ProfitbaseFeedError('FEED_HTTP_ERROR', response.status);
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/html') reject('FEED_XML_INVALID');
        const length = response.headers.get('content-length');
        let declared: number | null = null;
        if (length !== null) {
          if (!/^[0-9]+$/.test(length.trim()) || !Number.isSafeInteger(Number(length))) reject('FEED_RESPONSE_INVALID');
          declared = Number(length);
          if (declared > FEED_MAX_BYTES) reject('FEED_BODY_TOO_LARGE');
        }
        if (!response.body || typeof response.body.getReader !== 'function') reject('FEED_BODY_INVALID');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let bytes = 0;
        while (true) {
          const part = await reader.read();
          if (controller.signal.aborted) reject('FEED_TIMEOUT');
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) reject('FEED_BODY_INVALID');
          bytes += part.value.byteLength;
          if (bytes > FEED_MAX_BYTES) reject('FEED_BODY_TOO_LARGE');
          chunks.push(part.value);
        }
        const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
        if ((!encoding || encoding === 'identity') && declared !== null && bytes !== declared) reject('FEED_BODY_INCOMPLETE');
        let xml: string;
        try { xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { reject('FEED_BODY_INVALID'); }
        const parsed = parseValidatedProfitbaseFeed(xml);
        dependencies.onMetadata?.(parsed.metadata);
        return parsed.offers;
      };
      return await Promise.race([work(), expired]);
    } catch (error) {
      const failure = error instanceof ProfitbaseFeedError ? error : new ProfitbaseFeedError(controller.signal.aborted ? 'FEED_TIMEOUT' : 'FEED_NETWORK_ERROR');
      const transient = ['FEED_NETWORK_ERROR', 'FEED_TIMEOUT', 'FEED_BODY_INCOMPLETE'].includes(failure.code) || (failure.code === 'FEED_HTTP_ERROR' && (failure.httpStatus === 408 || failure.httpStatus === 429 || (failure.httpStatus! >= 500 && failure.httpStatus! <= 599)));
      if (!transient || attempt === FEED_MAX_ATTEMPTS) throw failure;
      // The timer/body are cancelled in finally before sleeping/retrying.
      retryDelay = retryDelayMs(retryAfter, attempt, now());
    } finally {
      clearTimeout(timer!); controller.abort();
      try {
        const cancellation = reader ? reader.cancel() : response?.body?.cancel();
        cancellation?.catch(() => {});
        reader?.releaseLock();
      } catch { /* No provider data is logged; cancellation is best effort. */ }
    }
    await wait(retryDelay);
  }
  throw new ProfitbaseFeedError('FEED_NETWORK_ERROR');
}
