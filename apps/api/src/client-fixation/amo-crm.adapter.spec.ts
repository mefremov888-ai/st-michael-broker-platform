import {
  AmoCrmAdapter,
  getAmoTokens,
  setAmoTokens,
} from "../../../../packages/integrations/src/amo-crm.adapter";
import {
  AMO_CONTACT_FIELDS,
  AMO_KC_STATUS,
  AMO_PIPELINES,
  AMO_ZORGE_STATUS,
} from "../../../../packages/integrations/src/amo-crm.fields";

describe("AmoCrmAdapter broker contact safety", () => {
  const originalFetch = global.fetch;
  let originalTokens: ReturnType<typeof getAmoTokens>;

  beforeEach(() => {
    originalTokens = getAmoTokens();
    setAmoTokens("test-token", "");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setAmoTokens(originalTokens.access, originalTokens.refresh);
    jest.restoreAllMocks();
  });

  it("throws when strict lookup finds multiple exact broker contacts", async () => {
    const contact = (id: number) => ({
      id,
      custom_fields_values: [
        { field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] },
        {
          field_id: AMO_CONTACT_FIELDS.PHONE,
          values: [{ value: "+7 (999) 000-00-01" }],
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
    await expect(
      adapter.findBrokerContactByPhone("+79990000001", { strict: true }),
    ).rejects.toThrow("AMBIGUOUS_BROKER_CONTACT");
  });

  it("exhausts exact-contact pages in strict mode before declaring absence", async () => {
    const phone = "+79990000012";
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
                    values: [{ value: "+79990000099" }],
                  },
                ],
              },
            ],
          },
          _links: { next: { href: "redacted" } },
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

    await expect(
      new AmoCrmAdapter().findContactByPhone(phone, { strict: true }),
    ).resolves.toEqual(expect.objectContaining({ id: 121 }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String((global.fetch as jest.Mock).mock.calls[1][0])).toContain(
      "page=2",
    );
  });

  it("fails closed on multiple exact contacts regardless of broker flag", async () => {
    const phone = "+79990000013";
    const contact = (id: number) => ({
      id,
      custom_fields_values: [
        { field_id: AMO_CONTACT_FIELDS.PHONE, values: [{ value: phone }] },
      ],
    });
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        _embedded: { contacts: [contact(130), contact(131)] },
        _links: {},
      }),
    } as any);

    await expect(
      new AmoCrmAdapter().findContactByPhone(phone, { strict: true }),
    ).rejects.toThrow("AMBIGUOUS_EXACT_CONTACT");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the exhaustive strict contact lookup for uniqueness decisions", async () => {
    const adapter = new AmoCrmAdapter();
    const strictLookup = jest
      .spyOn(adapter, "findContactByPhone")
      .mockRejectedValue(new Error("AMBIGUOUS_EXACT_CONTACT"));

    await expect(adapter.checkUniqueness("+79990000013")).rejects.toThrow(
      "AMBIGUOUS_EXACT_CONTACT",
    );
    expect(strictLookup).toHaveBeenCalledWith("+79990000013", {
      strict: true,
    });
  });

  it("requires complete strict contact hydration before a uniqueness verdict", async () => {
    const adapter = new AmoCrmAdapter();
    jest.spyOn(adapter, "findContactByPhone").mockResolvedValue({
      id: 140,
      name: "Client",
    });
    jest.spyOn(adapter, "getLeadsByContact").mockResolvedValue([
      {
        id: 141,
        name: "Lead",
        pipeline_id: AMO_PIPELINES.KC,
        status_id: AMO_KC_STATUS.NEW_REQUEST,
        _embedded: { contacts: [{ id: 140 }, { id: 142 }] },
      },
    ]);
    const hydrate = jest
      .spyOn(adapter, "getContactsByIds")
      .mockRejectedValue(new Error("AMO_UNIQUENESS_CONTACTS_INCOMPLETE"));

    await expect(adapter.checkUniqueness("+79990000014")).rejects.toThrow(
      "AMO_UNIQUENESS_CONTACTS_INCOMPLETE",
    );
    expect(hydrate).toHaveBeenCalledWith([140, 142], { strict: true });
  });

  it("rejects a partial contact batch in strict mode", async () => {
    const adapter = new AmoCrmAdapter();
    jest.spyOn(adapter as any, "request").mockResolvedValue({
      _embedded: { contacts: [{ id: 151, name: "First" }] },
    });

    await expect(
      adapter.getContactsByIds([151, 152], { strict: true }),
    ).rejects.toThrow("AMO_UNIQUENESS_CONTACTS_INCOMPLETE");
  });

  it("rejects a partial lead set before evaluating uniqueness", async () => {
    const adapter = new AmoCrmAdapter();
    jest
      .spyOn(adapter as any, "request")
      .mockResolvedValueOnce({
        _embedded: { leads: [{ id: 161 }, { id: 162 }] },
      })
      .mockResolvedValueOnce({
        _embedded: {
          leads: [
            {
              id: 161,
              pipeline_id: AMO_PIPELINES.KC,
              status_id: AMO_KC_STATUS.NEW_REQUEST,
              _embedded: { contacts: [{ id: 160 }] },
            },
          ],
        },
      });

    await expect(adapter.getLeadsByContact(160)).rejects.toThrow(
      "AMO_UNIQUENESS_LEADS_INCOMPLETE",
    );
  });

  it("rejects an unrecognised active lead stage instead of falling through to RULE_3", async () => {
    const adapter = new AmoCrmAdapter();
    jest
      .spyOn(adapter as any, "request")
      .mockResolvedValueOnce({ _embedded: { leads: [{ id: 171 }] } })
      .mockResolvedValueOnce({
        _embedded: {
          leads: [
            {
              id: 171,
              pipeline_id: 99999991,
              status_id: 99999992,
              _embedded: { contacts: [{ id: 170 }] },
            },
          ],
        },
      });

    await expect(adapter.getLeadsByContact(170)).rejects.toThrow(
      "AMO_UNIQUENESS_LEAD_STAGE_UNRECOGNIZED",
    );
  });

  it("fails closed for a known active sales stage with no explicit uniqueness rule", async () => {
    const adapter = new AmoCrmAdapter();
    jest.spyOn(adapter, "findContactByPhone").mockResolvedValue({
      id: 180,
      name: "Client",
    });
    jest
      .spyOn(adapter as any, "request")
      .mockResolvedValueOnce({ _embedded: { leads: [{ id: 181 }] } })
      .mockResolvedValueOnce({
        _embedded: {
          leads: [
            {
              id: 181,
              pipeline_id: AMO_PIPELINES.ZORGE9,
              status_id: AMO_ZORGE_STATUS.NEW_LEAD,
              _embedded: { contacts: [{ id: 180 }] },
            },
          ],
        },
      });

    await expect(adapter.checkUniqueness("+79990000018")).rejects.toThrow(
      "AMO_UNIQUENESS_LEAD_STAGE_UNCLASSIFIED",
    );
  });

  it("does not retry createContact after a network error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("socket reset"));

    await expect(
      new AmoCrmAdapter().createContact({ name: "Новый брокер" }),
    ).rejects.toThrow("amoCRM network error /contacts");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry createContact after a 5xx response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 503,
      ok: false,
      headers: { get: () => null },
      text: async () => "unavailable",
    } as any);

    await expect(
      new AmoCrmAdapter().createContact({ name: "Новый брокер" }),
    ).rejects.toThrow("amoCRM 503 /contacts");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not refresh and replay createContact after a 401 response", async () => {
    setAmoTokens("expired-token", "refresh-token");
    const previousClientId = process.env.AMO_CLIENT_ID;
    const previousClientSecret = process.env.AMO_CLIENT_SECRET;
    process.env.AMO_CLIENT_ID = "test-client";
    process.env.AMO_CLIENT_SECRET = "test-secret";
    global.fetch = jest.fn().mockResolvedValue({
      status: 401,
      ok: false,
      headers: { get: () => null },
      text: async () => "unauthorized",
    } as any);

    try {
      await expect(
        new AmoCrmAdapter().createContact({ name: "One shot broker" }),
      ).rejects.toThrow("amoCRM 401 /contacts");
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

  it("does not replay broker-promotion PATCH after a network error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("socket reset"));

    await expect(
      new AmoCrmAdapter().promoteContactToBroker(1401),
    ).rejects.toThrow("amoCRM network error /contacts/1401");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429, 503])(
    "does not refresh or replay broker-promotion PATCH after HTTP %s",
    async (status) => {
      setAmoTokens("expired-token", "refresh-token");
      global.fetch = jest.fn().mockResolvedValue({
        status,
        ok: false,
        headers: { get: () => null },
        text: async () => "redacted",
      } as any);

      await expect(
        new AmoCrmAdapter().promoteContactToBroker(1402),
      ).rejects.toThrow(`amoCRM ${status} /contacts/1402`);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect((global.fetch as jest.Mock).mock.calls[0][1]).toEqual(
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            custom_fields_values: [
              {
                field_id: AMO_CONTACT_FIELDS.IS_BROKER,
                values: [{ value: true }],
              },
            ],
          }),
        }),
      );
    },
  );

  it("does not retry createLead after a network error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("socket reset"));

    await expect(
      new AmoCrmAdapter().createLead({ name: "Фиксация клиента" }),
    ).rejects.toThrow("amoCRM network error /leads");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not expose a contact phone or raw WAF HTML in an error", async () => {
    const rawBody = "<html><body>blocked secret diagnostic</body></html>";
    const phone = "+79990000009";
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
    expect(error.message).toBe("amoCRM 403 /contacts");
    expect(error.message).not.toContain(phone);
    expect(error.message).not.toContain(rawBody);
  });

  it("propagates a failed lead lookup during uniqueness checking", async () => {
    const phone = "+79990000010";
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
                  { field_code: "PHONE", values: [{ value: phone }] },
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
        text: async () => "<html>blocked</html>",
      } as any);

    await expect(new AmoCrmAdapter().checkUniqueness(phone)).rejects.toThrow(
      "amoCRM 403 /contacts/123",
    );
  });

  it("does not retry createLead after a 5xx response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 503,
      ok: false,
      headers: { get: () => null },
      text: async () => "unavailable",
    } as any);

    await expect(
      new AmoCrmAdapter().createLead({ name: "Фиксация клиента" }),
    ).rejects.toThrow("amoCRM 503 /leads");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses a strict internal client-contact recheck and performs no writes on ambiguity", async () => {
    const adapter = new AmoCrmAdapter();
    const findContact = jest
      .spyOn(adapter, "findContactByPhone")
      .mockRejectedValue(new Error("AMBIGUOUS_EXACT_CONTACT"));
    const createContact = jest.spyOn(adapter, "createContact");
    const updateContact = jest.spyOn(adapter, "updateContact");
    const createLead = jest.spyOn(adapter, "createLead");

    await expect(
      adapter.createFixationRequest({
        clientPhone: "+79990000021",
        clientName: "Client",
        brokerPhone: "+79990000022",
        brokerAmoContactId: 221,
        agencyName: "Agency",
        agencyInn: "7700000000",
        comment: "",
        project: "ZORGE9" as any,
      }),
    ).rejects.toThrow("AMBIGUOUS_EXACT_CONTACT");

    expect(findContact).toHaveBeenCalledWith("+79990000021", {
      strict: true,
    });
    expect(createContact).not.toHaveBeenCalled();
    expect(updateContact).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
  });

  it("creates a fixation client contact through exactly one one-shot contact primitive", async () => {
    const adapter = new AmoCrmAdapter();
    const createContact = jest
      .spyOn(adapter, "createContact")
      .mockResolvedValue({ id: 501, name: "Client" });

    await expect(
      adapter.createFixationClientContactOnce({
        clientPhone: "+79990000501",
        clientEmail: "client@example.test",
        clientName: "Client",
        clientRegion: "Moscow",
      }),
    ).resolves.toMatchObject({ id: 501 });

    expect(createContact).toHaveBeenCalledTimes(1);
    expect(createContact).toHaveBeenCalledWith({
      name: "Client",
      custom_fields_values: [
        {
          field_code: "PHONE",
          values: [{ value: "+79990000501", enum_code: "WORK" }],
        },
        {
          field_code: "EMAIL",
          values: [{ value: "client@example.test", enum_code: "WORK" }],
        },
        { field_id: 589265, values: [{ value: "Moscow" }] },
      ],
    });
  });

  it("uses a pre-resolved exact client and every sibling broker in the sole lead create", async () => {
    global.fetch = jest.fn();
    const adapter = new AmoCrmAdapter();
    const findContact = jest.spyOn(adapter, "findContactByPhone");
    const createContact = jest.spyOn(adapter, "createContact");
    const updateContact = jest.spyOn(adapter, "updateContact");
    const createLead = jest
      .spyOn(adapter, "createLead")
      .mockResolvedValue({ id: 601, name: "Fixation" });
    jest.spyOn(adapter, "updateLead").mockResolvedValue(undefined);
    jest.spyOn(adapter, "addNoteToLead").mockResolvedValue(undefined);

    await expect(
      adapter.createFixationRequest({
        clientPhone: "+79990000601",
        clientName: "Client",
        existingClientAmoContactId: 101,
        brokerPhone: "+79990000602",
        brokerAmoContactId: 201,
        additionalBrokerAmoContactIds: [303, 301, 302],
        agencyName: "Agency",
        agencyInn: "7700000000",
        comment: "",
        project: "ZORGE9" as any,
      }),
    ).resolves.toMatchObject({ id: 601 });

    expect(findContact).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
    expect(updateContact).not.toHaveBeenCalled();
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(createLead).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline_id: AMO_PIPELINES.KC,
        contacts: [
          { id: 101 },
          { id: 201 },
          { id: 301 },
          { id: 302 },
          { id: 303 },
        ],
      }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "duplicate additional ids",
      { additionalBrokerAmoContactIds: [301, 301] },
      "AMO_FIXATION_BROKER_CONTACT_SET_INVALID",
    ],
    [
      "primary repeated as additional",
      { additionalBrokerAmoContactIds: [201] },
      "AMO_FIXATION_BROKER_CONTACT_SET_INVALID",
    ],
    [
      "invalid additional id",
      { additionalBrokerAmoContactIds: [0] },
      "AMO_FIXATION_BROKER_CONTACT_SET_INVALID",
    ],
    [
      "unsafe additional id",
      { additionalBrokerAmoContactIds: [Number.MAX_SAFE_INTEGER + 1] },
      "AMO_FIXATION_BROKER_CONTACT_SET_INVALID",
    ],
    [
      "client equals primary broker",
      { existingClientAmoContactId: 201 },
      "AMO_FIXATION_CONTACT_ROLE_COLLISION",
    ],
    [
      "client equals additional broker",
      { existingClientAmoContactId: 301, additionalBrokerAmoContactIds: [301] },
      "AMO_FIXATION_CONTACT_ROLE_COLLISION",
    ],
    [
      "additional without exact client",
      {
        existingClientAmoContactId: undefined,
        additionalBrokerAmoContactIds: [301],
      },
      "AMO_FIXATION_ADDITIONAL_BROKERS_REQUIRE_EXACT_CLIENT",
    ],
    [
      "additional with reuse",
      { additionalBrokerAmoContactIds: [301], reuseLeadId: 999 },
      "AMO_FIXATION_RECOVERY_CONTRACT_REUSE_UNSUPPORTED",
    ],
    [
      "pre-resolved client with reuse",
      { additionalBrokerAmoContactIds: undefined, reuseLeadId: 999 },
      "AMO_FIXATION_RECOVERY_CONTRACT_REUSE_UNSUPPORTED",
    ],
    [
      "pre-resolved client with zero reuse id",
      { additionalBrokerAmoContactIds: undefined, reuseLeadId: 0 },
      "AMO_FIXATION_RECOVERY_CONTRACT_REUSE_UNSUPPORTED",
    ],
  ])(
    "rejects %s before any contact or lead mutation",
    async (_label, overrides, expectedError) => {
      global.fetch = jest.fn();
      const adapter = new AmoCrmAdapter();
      const findContact = jest.spyOn(adapter, "findContactByPhone");
      const createContact = jest.spyOn(adapter, "createContact");
      const updateContact = jest.spyOn(adapter, "updateContact");
      const createLead = jest.spyOn(adapter, "createLead");

      await expect(
        adapter.createFixationRequest({
          clientPhone: "+79990000701",
          clientName: "Client",
          existingClientAmoContactId: 101,
          brokerPhone: "+79990000702",
          brokerAmoContactId: 201,
          additionalBrokerAmoContactIds: [],
          agencyName: "Agency",
          agencyInn: "7700000000",
          comment: "",
          project: "ZORGE9" as any,
          ...(overrides as any),
        }),
      ).rejects.toThrow(expectedError as string);

      expect(findContact).not.toHaveBeenCalled();
      expect(createContact).not.toHaveBeenCalled();
      expect(updateContact).not.toHaveBeenCalled();
      expect(createLead).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid pre-resolved client contact id %s before any request",
    async (existingClientAmoContactId) => {
      global.fetch = jest.fn();
      const adapter = new AmoCrmAdapter();
      const createLead = jest.spyOn(adapter, "createLead");

      await expect(
        adapter.createFixationRequest({
          clientPhone: "+79990000801",
          clientName: "Client",
          existingClientAmoContactId,
          brokerPhone: "+79990000802",
          brokerAmoContactId: 201,
          agencyName: "Agency",
          agencyInn: "7700000000",
          comment: "",
          project: "ZORGE9" as any,
        }),
      ).rejects.toThrow("AMO_FIXATION_CLIENT_CONTACT_ID_INVALID");
      expect(createLead).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["omitted", undefined, undefined],
    ["omitted with fromBroker=false", undefined, false],
    ["zero", 0, true],
    ["negative", -1, true],
    ["fractional", 7.5, true],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1, true],
  ])(
    "fails closed before any amo request when a broker contact id is %s",
    async (_label, brokerAmoContactId, fromBroker) => {
      global.fetch = jest.fn();
      const adapter = new AmoCrmAdapter();
      const findClientContact = jest.spyOn(adapter, "findContactByPhone");
      const createClientContact = jest.spyOn(adapter, "createContact");
      const createLead = jest.spyOn(adapter, "createLead");
      const data: any = {
        clientPhone: "+79990000031",
        clientName: "Client",
        brokerPhone: "+79990000032",
        brokerAmoContactId,
        agencyName: "Agency",
        agencyInn: "7700000000",
        comment: "",
        project: "ZORGE9",
      };
      if (fromBroker !== undefined) data.fromBroker = fromBroker;

      await expect(adapter.createFixationRequest(data)).rejects.toThrow(
        "BROKER_AMO_CONTACT_MISSING",
      );
      expect(global.fetch).not.toHaveBeenCalled();
      expect(findClientContact).not.toHaveBeenCalled();
      expect(createClientContact).not.toHaveBeenCalled();
      expect(createLead).not.toHaveBeenCalled();
    },
  );
});
