import { AmoCrmAdapter, getAmoTokens, setAmoTokens } from '../../../../packages/integrations/src/amo-crm.adapter';
import { AMO_CONTACT_FIELDS } from '../../../../packages/integrations/src/amo-crm.fields';

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
        {
          field_id: AMO_CONTACT_FIELDS.PHONE,
          values: [{ value: '+7 (999) 000-00-01' }],
        },
      ],
    });
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        _embedded: { contacts: [contact(10), contact(11)] },
      }),
    } as any);

    const adapter = new AmoCrmAdapter();
    await expect(adapter.findBrokerContactByPhone('+79990000001', { strict: true })).rejects.toThrow('AMBIGUOUS_BROKER_CONTACT');
  });

  it('exhausts exact-contact pages in strict mode before declaring absence', async () => {
    const phone = '+79990000012';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          _embedded: {
            contacts: [
              {
                id: 120,
                custom_fields_values: [
                  {
                    field_id: AMO_CONTACT_FIELDS.PHONE,
                    values: [{ value: '+79990000099' }],
                  },
                ],
              },
            ],
          },
          _links: { next: { href: 'redacted' } },
        }),
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          _embedded: {
            contacts: [
              {
                id: 121,
                custom_fields_values: [
                  {
                    field_id: AMO_CONTACT_FIELDS.PHONE,
                    values: [{ value: phone }],
                  },
                ],
              },
            ],
          },
          _links: {},
        }),
      } as any);

    await expect(new AmoCrmAdapter().findContactByPhone(phone, { strict: true })).resolves.toEqual(expect.objectContaining({ id: 121 }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String((global.fetch as jest.Mock).mock.calls[1][0])).toContain('page=2');
  });

  it('fails closed on multiple exact contacts regardless of broker flag', async () => {
    const phone = '+79990000013';
    const contact = (id: number) => ({
      id,
      custom_fields_values: [{ field_id: AMO_CONTACT_FIELDS.PHONE, values: [{ value: phone }] }],
    });
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        _embedded: { contacts: [contact(130), contact(131)] },
        _links: {},
      }),
    } as any);

    await expect(new AmoCrmAdapter().findContactByPhone(phone, { strict: true })).rejects.toThrow('AMBIGUOUS_EXACT_CONTACT');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry createContact after a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('socket reset'));

    await expect(new AmoCrmAdapter().createContact({ name: 'Новый брокер' })).rejects.toThrow('amoCRM network error /contacts');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry createContact after a 5xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 503,
      ok: false,
      headers: { get: () => null },
      text: async () => 'unavailable',
    } as any);

    await expect(new AmoCrmAdapter().createContact({ name: 'Новый брокер' })).rejects.toThrow('amoCRM 503 /contacts');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not refresh and replay createContact after a 401 response', async () => {
    setAmoTokens('expired-token', 'refresh-token');
    const previousClientId = process.env.AMO_CLIENT_ID;
    const previousClientSecret = process.env.AMO_CLIENT_SECRET;
    process.env.AMO_CLIENT_ID = 'test-client';
    process.env.AMO_CLIENT_SECRET = 'test-secret';
    global.fetch = jest.fn().mockResolvedValue({
      status: 401,
      ok: false,
      headers: { get: () => null },
      text: async () => 'unauthorized',
    } as any);

    try {
      await expect(new AmoCrmAdapter().createContact({ name: 'One shot broker' })).rejects.toThrow('amoCRM 401 /contacts');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      if (previousClientId === undefined) delete process.env.AMO_CLIENT_ID;
      else process.env.AMO_CLIENT_ID = previousClientId;
      if (previousClientSecret === undefined) {
        delete process.env.AMO_CLIENT_SECRET;
      } else {
        process.env.AMO_CLIENT_SECRET = previousClientSecret;
      }
    }
  });

  it('does not retry createLead after a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('socket reset'));

    await expect(new AmoCrmAdapter().createLead({ name: 'Фиксация клиента' })).rejects.toThrow('amoCRM network error /leads');
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

    const error = (await new AmoCrmAdapter().findContactByPhone(phone).catch((caught) => caught as Error)) as Error;

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
                custom_fields_values: [{ field_code: 'PHONE', values: [{ value: phone }] }],
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

    await expect(new AmoCrmAdapter().checkUniqueness(phone)).rejects.toThrow('amoCRM 403 /contacts/123');
  });

  it('does not retry createLead after a 5xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 503,
      ok: false,
      headers: { get: () => null },
      text: async () => 'unavailable',
    } as any);

    await expect(new AmoCrmAdapter().createLead({ name: 'Фиксация клиента' })).rejects.toThrow('amoCRM 503 /leads');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
