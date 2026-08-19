import {
  AMO_CONTACT_FIELDS,
  AmoCrmAdapter,
  getAmoTokens,
  setAmoTokens,
} from '@st-michael/integrations';

describe('AmoCrmAdapter broker contact safety', () => {
  const originalFetch = global.fetch;
  let originalTokens: ReturnType<typeof getAmoTokens>;

  beforeEach(() => {
    originalTokens = getAmoTokens();
    setAmoTokens('test-token', '');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setAmoTokens(originalTokens.access, originalTokens.refresh);
    jest.restoreAllMocks();
  });

  it('throws when strict lookup finds multiple exact broker contacts', async () => {
    const contact = (id: number) => ({
      id,
      custom_fields_values: [
        { field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] },
        { field_id: AMO_CONTACT_FIELDS.PHONE, values: [{ value: '+7 (999) 000-00-01' }] },
      ],
    });
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ _embedded: { contacts: [contact(10), contact(11)] } }),
    } as any);

    const adapter = new AmoCrmAdapter();
    await expect(
      adapter.findBrokerContactByPhone('+79990000001', { strict: true }),
    ).rejects.toThrow('AMBIGUOUS_BROKER_CONTACT');
  });

  it('does not retry createContact after a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('socket reset'));

    await expect(
      new AmoCrmAdapter().createContact({ name: 'Новый брокер' }),
    ).rejects.toThrow('amoCRM network error /contacts');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry createContact after a 5xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 503,
      ok: false,
      headers: { get: () => null },
      text: async () => 'unavailable',
    } as any);

    await expect(
      new AmoCrmAdapter().createContact({ name: 'Новый брокер' }),
    ).rejects.toThrow('amoCRM 503 /contacts');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry createLead after a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('socket reset'));

    await expect(
      new AmoCrmAdapter().createLead({ name: 'Фиксация клиента' }),
    ).rejects.toThrow('amoCRM network error /leads');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not expose a contact phone or raw WAF HTML in an error', async () => {
    const rawBody = '<html><body>blocked secret diagnostic</body></html>';
    const phone = '+79990000009';
    global.fetch = jest.fn().mockResolvedValue({
      status: 403,
      ok: false,
      headers: { get: () => null },
      text: async () => rawBody,
    } as any);

    const error = (await new AmoCrmAdapter()
      .findContactByPhone(phone)
      .catch((caught) => caught as Error)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('amoCRM 403 /contacts');
    expect(error.message).not.toContain(phone);
    expect(error.message).not.toContain(rawBody);
  });

  it('propagates a failed lead lookup during uniqueness checking', async () => {
    const phone = '+79990000010';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          _embedded: {
            contacts: [
              {
                id: 123,
                custom_fields_values: [
                  { field_code: 'PHONE', values: [{ value: phone }] },
                ],
              },
            ],
          },
        }),
      } as any)
      .mockResolvedValueOnce({
        status: 403,
        ok: false,
        headers: { get: () => null },
        text: async () => '<html>blocked</html>',
      } as any);

    await expect(
      new AmoCrmAdapter().checkUniqueness(phone),
    ).rejects.toThrow('amoCRM 403 /contacts/123');
  });

  it('does not retry createLead after a 5xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 503,
      ok: false,
      headers: { get: () => null },
      text: async () => 'unavailable',
    } as any);

    await expect(
      new AmoCrmAdapter().createLead({ name: 'Фиксация клиента' }),
    ).rejects.toThrow('amoCRM 503 /leads');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
