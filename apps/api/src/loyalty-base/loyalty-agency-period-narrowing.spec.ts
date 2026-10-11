import { LoyaltyBaseService } from "./loyalty-base.service";

describe("OUR agency periods narrow the selection", () => {
  const service = new LoyaltyBaseService({} as any) as any;
  const period = { from: "2026-09-01", to: "2026-09-30" };
  const record = (date?: string) => ({
    id: "agency-period-fixture",
    phone: "+79124557274",
    deals: date ? [{ id: "deal", signedAt: date, amount: "100" }] : [],
    __workflowCalls: { effective: date ? [{
      id: "call", type: "CALL", occurredAt: date,
    }] : [] },
    brokerAgencies: [{ broker: {
      id: "broker-period-fixture",
      clients: date ? [{ id: "client", createdAt: date }] : [],
      meetings: date ? [{ id: "meeting", date }] : [],
      deals: [], callLogs: [], __workflowCalls: { effective: [] },
    } }],
  });
  const matches = (source: any, canonical: any = {}, columns: any = {}) => {
    const filter = service.normalizeListFilter({ columns }, {
      includeLowSignal: true, ...canonical,
    });
    const item = { metrics: { fixations: 1, meetings: 1, deals: 1 } };
    return service.matchesOurAgency(source, item, filter);
  };

  it.each(["fixationPeriod", "meetingPeriod", "dealPeriod"])(
    "%s retains only activity inside the dates", (key) => {
      expect(matches(record(), { [key]: period })).toBe(false);
      expect(matches(record("2026-08-20"), { [key]: period })).toBe(false);
      expect(matches(record("2026-09-15"), { [key]: period })).toBe(true);
      expect(matches(record("2026-10-01"), { [key]: period })).toBe(false);
    },
  );

  it("no period does not add an activity predicate", () => {
    expect(matches(record())).toBe(true);
  });

  it("several periods must all match", () => {
    expect(matches(record("2026-09-15"), {
      fixationPeriod: period, meetingPeriod: { from: "2026-08-01", to: "2026-08-31" },
    })).toBe(false);
  });

  it.each(["NO_FIXATIONS", "NO_MEETINGS"])(
    "%s remains usable with its period", (activity) => {
      const key = activity === "NO_FIXATIONS" ? "fixationPeriod" : "meetingPeriod";
      expect(matches(record(), { [key]: period }, { activity })).toBe(true);
      expect(matches(record("2026-09-15"), { [key]: period }, { activity })).toBe(false);
    },
  );

  it("no deals in period is not contradicted by a positive period gate", () => {
    expect(matches(record(), { dealPeriod: period, dealsInPeriod: false })).toBe(true);
    expect(matches(record("2026-09-15"), { dealPeriod: period, dealsInPeriod: false })).toBe(false);
  });

  it("the zero deals column remains usable", () => {
    expect(matches(record(), { dealPeriod: period }, { deals: "NO_DEALS" })).toBe(true);
  });

  it("zero-count and NO_MEETINGS predicates remain usable", () => {
    expect(matches(record(), { dealPeriod: period, dealCount: { max: 0 } })).toBe(true);
    expect(matches(record(), { meetingPeriod: period, meetings: { max: 0 } })).toBe(true);
    expect(matches(record(), { meetingPeriod: period, scenario: "NO_MEETINGS" })).toBe(true);
  });

  it("an explicit period is not hidden by the unrelated low-signal gate", () => {
    const source = record("2026-09-15");
    source.phone = "";
    source.deals = [];
    source.brokerAgencies[0].broker.clients = [];
    const filter = service.normalizeListFilter({}, { meetingPeriod: period });
    expect(service.matchesOurAgency(source, {
      metrics: { fixations: 0, meetings: 1, deals: 0 },
    }, filter)).toBe(true);
  });

  it("unknown period activity is not treated as known zero", () => {
    expect(matches({ id: "unknown", phone: "+79124557274" }, { fixationPeriod: period })).toBe(false);
  });
});
