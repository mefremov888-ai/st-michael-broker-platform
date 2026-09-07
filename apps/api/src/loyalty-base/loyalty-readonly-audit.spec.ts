import {
  AMO_BERZARINA_STATUS,
  AMO_KC_STATUS,
  AMO_LEAD_FIELDS,
  AMO_PIPELINES,
  AmoCrmAdapter,
  classifyLoyaltyAmoLead,
  setAmoTokens,
} from "@st-michael/integrations";

const field = (fieldId: number, value: unknown) => ({
  field_id: fieldId,
  values: [{ value }],
});

const context = {
  brokerKey: "test-broker-key",
  normalizedPhone: "70000000000",
  amoContactId: 101,
  linkPath: "DIRECT_BROKER_CONTACT" as const,
  readAt: "2026-08-21T12:00:00.000Z",
};

describe("loyalty amoCRM read-only audit rules", () => {
  it("requires an exact normalized fixation marker and keeps a meeting as an additional fixation", () => {
    const rows = classifyLoyaltyAmoLead(
      {
        id: 501,
        name: "irrelevant title",
        pipeline_id: AMO_PIPELINES.KC,
        status_id: AMO_KC_STATUS.MEETING_HELD,
        created_at: 1_775_000_000,
        custom_fields_values: [
          field(AMO_LEAD_FIELDS.COMMENT_TO_REQUEST, "  ЗАЯВКА   ОТ БРОКЕРА "),
        ],
      },
      context,
    );

    expect(rows).toHaveLength(2);
    expect(
      rows.map(({ type, verdict, reasonCode }) => ({
        type,
        verdict,
        reasonCode,
      })),
    ).toEqual([
      {
        type: "FIXATION",
        verdict: "INCLUDED",
        reasonCode: "FIXATION_RULE_MATCH",
      },
      {
        type: "MEETING",
        verdict: "INCLUDED",
        reasonCode: "MEETING_RULE_MATCH",
      },
    ]);
  });

  it("does not infer a fixation from a title, UTM marker or an unverified contact link", () => {
    const titleOnly = classifyLoyaltyAmoLead(
      {
        id: 502,
        name: "Заявка от брокера",
        pipeline_id: AMO_PIPELINES.KC,
        status_id: AMO_KC_STATUS.MEETING_HELD,
        created_at: 1_775_000_000,
        custom_fields_values: [
          field(AMO_LEAD_FIELDS.UTM_SOURCE, "Заявка от брокера"),
          field(AMO_LEAD_FIELDS.COMMENT_TO_REQUEST, "другое значение"),
        ],
      },
      context,
    );
    expect(titleOnly[0]).toMatchObject({
      verdict: "EXCLUDED",
      reasonCode: "FIXATION_COMMENT_MISMATCH",
    });

    const unverified = classifyLoyaltyAmoLead(
      {
        id: 503,
        name: "lead",
        pipeline_id: AMO_PIPELINES.KC,
        status_id: AMO_KC_STATUS.MEETING_HELD,
        created_at: 1_775_000_000,
        custom_fields_values: [
          field(AMO_LEAD_FIELDS.COMMENT_TO_REQUEST, "Заявка от брокера"),
        ],
      },
      { ...context, linkPath: null },
    );
    expect(unverified[0]).toMatchObject({
      verdict: "EXCLUDED",
      reasonCode: "BROKER_LINK_UNVERIFIED",
    });
  });

  it("includes a deal only for an allowed pipeline/status, positive Decimal DDU and contract date", () => {
    const rows = classifyLoyaltyAmoLead(
      {
        id: 504,
        name: "deal",
        pipeline_id: AMO_PIPELINES.BERZARINA,
        status_id: AMO_BERZARINA_STATUS.PAYMENT_CONTROL,
        created_at: 1_775_000_000,
        custom_fields_values: [
          field(AMO_LEAD_FIELDS.PRICE_DDU, "1 285 000 000,50"),
          field(AMO_LEAD_FIELDS.CONTRACT_DATE, 1_775_100_000),
        ],
      },
      context,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "DEAL",
      verdict: "INCLUDED",
      reasonCode: "DEAL_RULE_MATCH",
      amountRub: "1285000000.50",
      timestampBasis: "CONTRACT_DATE",
    });

    const missingDdu = classifyLoyaltyAmoLead(
      {
        id: 505,
        name: "deal",
        pipeline_id: AMO_PIPELINES.BERZARINA,
        status_id: AMO_BERZARINA_STATUS.PAYMENT_CONTROL,
        created_at: 1_775_000_000,
        custom_fields_values: [
          field(AMO_LEAD_FIELDS.PRICE_DDU, 0),
          field(AMO_LEAD_FIELDS.CONTRACT_DATE, 1_775_100_000),
        ],
      },
      context,
    );
    expect(missingDdu[0]).toMatchObject({
      verdict: "EXCLUDED",
      reasonCode: "DEAL_DDU_AMOUNT_MISSING_OR_NONPOSITIVE",
    });
  });

  it("paginates only GET requests and fails closed instead of returning a partial scan", async () => {
    const originalFetch = global.fetch;
    setAmoTokens("test-token", "");
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ _embedded: { contacts: [{ id: 1 }, { id: 2 }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ _embedded: { contacts: [] } }),
      });
    global.fetch = fetchMock as any;
    try {
      const result = await new AmoCrmAdapter().scanReadonly("contacts", {
        limit: 2,
        maxPages: 3,
        with: "leads,companies",
      });
      expect(result).toMatchObject({ pagesRead: 2, complete: true });
      expect(result.items).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init?.method).toBeUndefined();
      }
    } finally {
      global.fetch = originalFetch;
      setAmoTokens("", "");
    }
  });
});
