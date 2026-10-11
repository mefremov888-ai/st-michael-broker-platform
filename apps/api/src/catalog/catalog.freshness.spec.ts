import { CatalogService, CATALOG_FEED_FRESHNESS_PREFIX } from './catalog.service';
import { loadProfitbaseOffers, normalizeFeedGeneratedAt } from './profitbase-feed';

const URL = 'https://pb7828.profitbase.ru/export/profitbase_xml/' + 'a'.repeat(32) + '?scheme=https';
const OFFER = '<offer internal-id="1"><number>101</number><status>AVAILABLE</status><area><value>50</value></area><price><value>20000000</value></price></offer>';
const XML = '<realty-feed><generation-date>2026-10-11T01:00:00+03:00</generation-date>' + OFFER + '</realty-feed>';

describe('Catalog durable freshness', () => {
  function setup() {
    const values = new Map<string, string>();
    const systemSetting = {
      upsert: jest.fn(async ({ where, update }: any) => { values.set(where.key, update.value); return {}; }),
      findUnique: jest.fn(async ({ where }: any) => values.has(where.key) ? { value: values.get(where.key) } : null),
    };
    const lot = { findUnique: jest.fn(async () => ({})), update: jest.fn(async () => ({})), create: jest.fn(async () => ({})) };
    return { service: new CatalogService({ lot, systemSetting } as any), lot, systemSetting, values };
  }
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
  it('records completion and generation dates only after successful writes; unchanged prices are healthy', async () => {
    const f = setup();
    jest.useFakeTimers().setSystemTime(new Date('2026-10-11T09:00:00Z'));
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(XML));
    await (f.service as any).syncSingleFeed(URL, 'ZORGE9');
    expect(f.lot.update.mock.invocationCallOrder[0]).toBeLessThan(f.systemSetting.upsert.mock.invocationCallOrder[0]);
    expect(f.values.get(CATALOG_FEED_FRESHNESS_PREFIX + 'ZORGE9')).toBe(JSON.stringify({
      lastSuccessfulImportAt: '2026-10-11T09:00:00.000Z', sourceGeneratedAt: '2026-10-10T22:00:00.000Z',
    }));
    await (f.service as any).syncSingleFeed(URL, 'ZORGE9');
    expect(f.systemSetting.upsert).toHaveBeenCalledTimes(2);
  });
  it('does not advance heartbeat on partial database failure', async () => {
    const f = setup(); f.lot.update.mockRejectedValueOnce(new Error('private DB details') as never);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(XML));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).rejects.toThrow('FEED_IMPORT_INCOMPLETE');
    expect(f.systemSetting.upsert).not.toHaveBeenCalled();
  });
  it('does not advance heartbeat on rejected feed', async () => {
    const f = setup(); jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<realty-feed/>'));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).rejects.toThrow();
    expect(f.systemSetting.upsert).not.toHaveBeenCalled();
  });
  it('does not mark an entirely ignored test-lot feed as successfully imported', async () => {
    const f = setup(); jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(XML.replace('101', 'TEST')));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).rejects.toThrow('FEED_IMPORT_INCOMPLETE');
    expect(f.systemSetting.upsert).not.toHaveBeenCalled();
  });
  it('keeps per-project results and reports unknown metadata honestly without writes', async () => {
    const f = setup();
    f.values.set(CATALOG_FEED_FRESHNESS_PREFIX + 'ZORGE9', JSON.stringify({ lastSuccessfulImportAt: '2026-10-11T10:00:00Z', sourceGeneratedAt: 'secret raw invalid date' }));
    f.values.set(CATALOG_FEED_FRESHNESS_PREFIX + 'SILVER_BOR', 'corrupt JSON');
    expect(await f.service.getFreshnessReport()).toEqual([
      { project: 'ZORGE9', lastSuccessfulImportAt: '2026-10-11T10:00:00.000Z', sourceGeneratedAt: null },
      { project: 'SILVER_BOR', lastSuccessfulImportAt: null, sourceGeneratedAt: null },
    ]);
    expect(f.systemSetting.upsert).not.toHaveBeenCalled();
  });
  it('missing status does not fabricate a fresh timestamp from existing lots', async () => {
    const f = setup(); expect((await f.service.getFreshnessReport()).every(row => row.lastSuccessfulImportAt === null)).toBe(true);
    expect(f.lot.findUnique).not.toHaveBeenCalled();
  });
});

describe('Safe optional feed generation metadata', () => {
  it('preserves the public offers-array API and supplies normalized metadata', async () => {
    const onMetadata = jest.fn();
    const offers = await loadProfitbaseOffers(URL, { fetchImpl: jest.fn(async () => new Response(XML)), onMetadata });
    expect(Array.isArray(offers)).toBe(true);
    expect(onMetadata).toHaveBeenCalledWith({ sourceGeneratedAt: '2026-10-10T22:00:00.000Z' });
  });
  it.each(['<realty-feed>' + OFFER + '</realty-feed>', XML.replace('2026-10-11T01:00:00+03:00', 'private URL/token'), XML.replace('<generation-date>', '<generation-date><nested>').replace('</generation-date>', '</nested></generation-date>')])('missing/unsafe date becomes unknown, not raw text', async xml => {
    const onMetadata = jest.fn(); await loadProfitbaseOffers(URL, { fetchImpl: jest.fn(async () => new Response(xml)), onMetadata });
    expect(onMetadata).toHaveBeenCalledWith({ sourceGeneratedAt: null });
  });
  it('does not report metadata from invalid offers', async () => {
    const onMetadata = jest.fn();
    await expect(loadProfitbaseOffers(URL, { fetchImpl: jest.fn(async () => new Response(XML.replace('20000000', 'NaN'))), onMetadata })).rejects.toThrow();
    expect(onMetadata).not.toHaveBeenCalled();
  });
  it.each(['2026-02-30T01:00:00Z', '2026-10-11T24:00:00Z', '2026-10-11T01:00:00', 'https://private.example/token', {}, null])('rejects non-date metadata %p', value => {
    expect(normalizeFeedGeneratedAt(value)).toBeNull();
  });
});
