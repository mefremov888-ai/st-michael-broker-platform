import { BadRequestException } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import * as feed from './profitbase-feed';

describe('CatalogService last-good XML feed preservation', () => {
  const URL = 'https://pb7828.profitbase.ru/export/profitbase_xml/' + 'a'.repeat(32) + '?scheme=https';
  const OFFER = '<offer internal-id="1"><number>101</number><status>AVAILABLE</status><object><name>Зорге 9</name></object><area><value>50</value></area><price><value>20000000</value></price></offer>';
  function setup() {
    const lastGood = { externalId: '1', status: 'AVAILABLE', price: 21000000, sqm: 50, photos: ['last-good-photo'] };
    const lot = { findUnique: jest.fn(async () => lastGood), update: jest.fn(async () => ({})), create: jest.fn(async () => ({})), deleteMany: jest.fn(), updateMany: jest.fn() };
    const systemSetting = { upsert: jest.fn(async () => ({})), findUnique: jest.fn(async () => null) };
    return { service: new CatalogService({ lot, systemSetting } as any), lot, lastGood, systemSetting };
  }
  afterEach(() => jest.restoreAllMocks());
  it.each(['<realty-feed>' + OFFER, '<realty-feed/>', '<html>private error</html>', '<realty-feed>' + OFFER + OFFER + '</realty-feed>'])('never changes, clears or archives last-good lots for a rejected feed', async (xml) => {
    const f = setup(); const before = JSON.stringify(f.lastGood);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).rejects.toBeInstanceOf(BadRequestException);
    expect(JSON.stringify(f.lastGood)).toBe(before);
    for (const method of Object.values(f.lot)) expect(method).not.toHaveBeenCalled();
  });
  it('rejects an entire semantically corrupted feed before even the first valid offer writes', async () => {
    const f = setup();
    const xml = '<realty-feed>' + OFFER + OFFER.replace('internal-id="1"', 'internal-id="2"').replace('20000000', 'NaN') + '</realty-feed>';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).rejects.toBeInstanceOf(BadRequestException);
    expect(f.lot.update).not.toHaveBeenCalled(); expect(f.lot.create).not.toHaveBeenCalled();
  });
  it.each([
    ['discount unit', '<special-offers><special-offer><discount-unit><nested>PERCENT</nested></discount-unit></special-offer></special-offers>'],
    ['house name', '<house><name><nested>Building</nested></name></house>'],
    ['house year', '<house><built-year>NaN</built-year></house>'],
    ['floor', '<floor>1.5</floor>'],
    ['image', '<image type="house"><nested>private</nested></image>'],
    ['custom field', '<custom-field><name>Feature</name><value><nested>private</nested></value></custom-field>'],
    ['window view', '<window-view><nested>private</nested></window-view>'],
    ['raw XML NUL', '<window-view>invalid\u0000text</window-view>'],
    ['CDATA XML NUL', '<window-view><![CDATA[invalid\u0000text]]></window-view>'],
  ])('refuses corrupted %s before any preceding offer upsert', async (_name, extra) => {
    const f = setup(); const xml = '<realty-feed>' + OFFER + OFFER.replace('internal-id="1"', 'internal-id="2"').replace('</offer>', extra + '</offer>') + '</realty-feed>';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).rejects.toBeInstanceOf(BadRequestException);
    for (const method of Object.values(f.lot)) expect(method).not.toHaveBeenCalled();
  });
  it.each([
    ['floor Int32 overflow', (offer: string) => offer.replace('</offer>', '<floor>2147483648</floor></offer>')],
    ['negative floor Int32 overflow', (offer: string) => offer.replace('</offer>', '<floor>-2147483649</floor></offer>')],
    ...['floors-total', 'built-year', 'ready-quarter'].map((field) => [field + ' Int32 overflow', (offer: string) => offer.replace('</offer>', `<house><${field}>2147483648</${field}></house></offer>`)]),
    ['sqm Decimal10,2 overflow', (offer: string) => offer.replace('<value>50</value>', '<value>100000000</value>')],
    ['sqm rounding carry overflow', (offer: string) => offer.replace('<value>50</value>', '<value>99999999.995</value>')],
    ['price Decimal14,2 overflow', (offer: string) => offer.replace('20000000', '1000000000000')],
    ['price rounding carry overflow', (offer: string) => offer.replace('20000000', '999999999999.995')],
    ['explicit price-meter Decimal10,2 overflow', (offer: string) => offer.replace('</offer>', '<price-meter><value>100000000</value></price-meter></offer>')],
    ['derived price-meter overflow', (offer: string) => offer.replace('<value>50</value>', '<value>0.01</value>')],
    ['zero price-meter fallback overflow', (offer: string) => offer.replace('<value>50</value>', '<value>0.01</value>').replace('</offer>', '<price-meter><value>0</value></price-meter></offer>')],
    ['derived price-meter Infinity', (offer: string) => offer.replace('<value>50</value>', '<value>5e-324</value>')],
    ['discount-price Decimal14,2 overflow', (offer: string) => offer.replace('</offer>', '<special-offers><special-offer><discount-price>1000000000000</discount-price></special-offer></special-offers></offer>')],
    ['discount percent Decimal5,2 overflow', (offer: string) => offer.replace('</offer>', '<special-offers><special-offer><discount-price>18000000</discount-price><discount-unit>PERCENT</discount-unit><value>1000</value></special-offer></special-offers></offer>')],
    ['discount percent rounding carry overflow', (offer: string) => offer.replace('</offer>', '<special-offers><special-offer><discount-price>18000000</discount-price><discount-unit>PERCENT</discount-unit><value>999.995</value></special-offer></special-offers></offer>')],
  ] as Array<[string, (offer: string) => string]>)('refuses %s for the whole feed before first DB lookup', async (_name, corrupt) => {
    const f = setup(); const xml = '<realty-feed>' + OFFER + corrupt(OFFER.replace('internal-id="1"', 'internal-id="2"')) + '</realty-feed>';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).rejects.toBeInstanceOf(BadRequestException);
    for (const method of Object.values(f.lot)) expect(method).not.toHaveBeenCalled();
  });
  it('keeps persistent provider500 as an error, not a successful zero-row sync', async () => {
    const f = setup(); jest.spyOn(feed, 'loadProfitbaseOffers').mockRejectedValue(new feed.ProfitbaseFeedError('FEED_HTTP_ERROR', 500));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).rejects.toThrow('Feed fetch failed: 500');
    expect(f.lot.update).not.toHaveBeenCalled(); expect(f.lot.deleteMany).not.toHaveBeenCalled();
  });
  it('validates the full successful feed then retains existing lot/image/status mapping', async () => {
    const f = setup(); const xml = '<realty-feed>' + OFFER.replace('</offer>', '<image type="plan">https://image.example.test/plan</image><image type="plan floor">https://image.example.test/floor</image></offer>') + '</realty-feed>';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).resolves.toEqual({ created: 0, updated: 1, skipped: 0, total: 1 });
    expect(f.lot.update).toHaveBeenCalledWith({ where: { externalId: '1' }, data: expect.objectContaining({ price: 20000000, sqm: 50, status: 'AVAILABLE', planImageUrl: 'https://image.example.test/plan', layoutUrl: 'https://image.example.test/floor' }) });
    expect(f.lot.deleteMany).not.toHaveBeenCalled(); expect(f.lot.updateMany).not.toHaveBeenCalled();
  });
  it('retains supported optional house/features/discount mapping after full validation', async () => {
    const f = setup();
    const extra = '<floor>4</floor><rooms>2</rooms><studio>0</studio><property_type>Апартаменты</property_type><window-view>Парк</window-view><house><name>Корпус 1</name><floors-total>20</floors-total><built-year>2026</built-year><ready-quarter>4</ready-quarter><building-state>built</building-state></house><custom-field><name>Балкон</name><value>да</value></custom-field><special-offers><special-offer><discount-price>18000000</discount-price><discount-unit>PERCENT</discount-unit><value>10</value><name>Предложение</name></special-offer></special-offers>';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<realty-feed>' + OFFER.replace('</offer>', extra + '</offer>') + '</realty-feed>'));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).resolves.toEqual({ created: 0, updated: 1, skipped: 0, total: 1 });
    expect(f.lot.update).toHaveBeenCalledWith({ where: { externalId: '1' }, data: expect.objectContaining({ floor: 4, rooms: '2', propertyType: 'Апартаменты', building: 'Корпус 1', floorsTotal: 20, builtYear: 2026, readyQuarter: 4, hasBalcony: true, discountPrice: 18000000, discountPercent: 10, discountName: 'Предложение' }) });
  });
  it.each([
    ['blank price and price-meter', OFFER.replace('<price><value>20000000</value></price>', '<price><value/></price>').replace('</offer>', '<price-meter><value/></price-meter></offer>'), 0, 0],
    ['blank price-meter with priced lot', OFFER.replace('</offer>', '<price-meter><value/></price-meter></offer>'), 20_000_000, 400_000],
  ])('preserves safe existing mapping for %s', async (_name, offer, price, pricePerSqm) => {
    const f = setup();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<realty-feed>' + offer + '</realty-feed>'));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).resolves.toEqual({ created: 0, updated: 1, skipped: 0, total: 1 });
    expect(f.lot.update).toHaveBeenCalledWith({ where: { externalId: '1' }, data: expect.objectContaining({ sqm: 50, price, pricePerSqm }) });
  });
  it('still rejects an overflowing derived price-meter from a blank value before first DB lookup', async () => {
    const f = setup(); const corrupt = OFFER.replace('internal-id="1"', 'internal-id="2"').replace('<value>50</value>', '<value>0.01</value>').replace('</offer>', '<price-meter><value/></price-meter></offer>');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<realty-feed>' + OFFER + corrupt + '</realty-feed>'));
    await expect((f.service as any).syncSingleFeed(URL, 'ZORGE9')).rejects.toBeInstanceOf(BadRequestException);
    for (const method of Object.values(f.lot)) expect(method).not.toHaveBeenCalled();
  });
});
