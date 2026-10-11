import {
  agencyPeriodNarrowingWhere,
  LoyaltyBaseService,
} from "./loyalty-base.service";

const HISTORICAL = "[old-cabinet:";
const PERIOD = { from: "2026-09-01", to: "2026-09-30" };

function qualifyingFixation(client: any): boolean {
  return (
    ["FIXED", "EXPIRED"].includes(String(client.fixationStatus || "")) ||
    ["CONDITIONALLY_UNIQUE", "EXPIRED"].includes(
      String(client.uniquenessStatus || ""),
    )
  );
}

function sourceMatches(client: any, source?: string): boolean {
  const historical = String(client.comment || "").startsWith(HISTORICAL);
  if (source === "old") return historical;
  if (source === "new") return !historical;
  return true;
}

function qualifyingMeeting(meeting: any): boolean {
  return (
    ["CONFIRMED", "COMPLETED"].includes(String(meeting.status || "")) &&
    meeting.type !== "BROKER_TOUR"
  );
}

function loadedAgency(raw: any, filter: any): any {
  return {
    ...raw,
    brokerAgencies: raw.brokerAgencies.map((relation: any) => ({
      ...relation,
      broker: {
        ...relation.broker,
        clients: relation.broker.clients.filter(
          (client: any) =>
            qualifyingFixation(client) &&
            sourceMatches(client, filter.cabinetSource),
        ),
        meetings: relation.broker.meetings.filter(qualifyingMeeting),
      },
    })),
  };
}

function survivesCandidatePushdown(raw: any, filter: any): boolean {
  const clauses = agencyPeriodNarrowingWhere({
    fixationPeriod: filter.fixationPeriod,
    meetingPeriod: filter.meetingPeriod,
    cabinetSource: filter.cabinetSource,
    activityColumn: filter.columns.activity,
    scenario: filter.scenario,
    meetingsMax: filter.meetings.max,
  });
  return clauses.every((clause: any) => {
    const broker = clause.brokerAgencies.some.broker;
    return raw.brokerAgencies.some((relation: any) => {
      if (broker.clients) {
        const range = broker.clients.some.createdAt;
        return relation.broker.clients.some(
          (client: any) =>
            qualifyingFixation(client) &&
            sourceMatches(client, filter.cabinetSource) &&
            client.createdAt >= range.gte &&
            client.createdAt < range.lt,
        );
      }
      const range = broker.meetings.some.date;
      return relation.broker.meetings.some(
        (meeting: any) =>
          qualifyingMeeting(meeting) &&
          meeting.date >= range.gte &&
          meeting.date < range.lt,
      );
    });
  });
}

function agencyFixture(
  id: string,
  brokers: Array<{ clients?: any[]; meetings?: any[] }>,
): any {
  return {
    id,
    name: id,
    phone: "+79990000001",
    email: null,
    deals: [],
    __registryDeals: [],
    __workflowCalls: { effective: [] },
    brokerAgencies: brokers.map((value, index) => ({
      isPrimary: index === 0,
      broker: {
        id: `${id}-broker-${index}`,
        phone: "+79990000001",
        email: null,
        brokerTourVisited: false,
        brokerTourDate: null,
        clients: value.clients || [],
        meetings: value.meetings || [],
        deals: [],
        callLogs: [],
        __workflowCalls: { effective: [] },
      },
    })),
    _count: { brokerAgencies: brokers.length },
  };
}

function fixed(id: string, date: string, comment: string | null = null): any {
  return {
    id,
    createdAt: new Date(date),
    fixationStatus: "FIXED",
    uniquenessStatus: "CONDITIONALLY_UNIQUE",
    comment,
  };
}

function rejected(id: string, date: string): any {
  return {
    id,
    createdAt: new Date(date),
    fixationStatus: "NOT_FIXED",
    uniquenessStatus: "REJECTED",
    comment: null,
  };
}

function meeting(
  id: string,
  date: string,
  status = "COMPLETED",
  type = "OFFICE_VISIT",
): any {
  return { id, date: new Date(date), status, type };
}

describe("OUR agency period candidate pushdown", () => {
  const service = new LoyaltyBaseService({} as any) as any;

  it("builds two independent positive EXISTS with fail-open date bounds", () => {
    const filter = service.normalizeListFilter(
      {},
      { fixationPeriod: PERIOD, meetingPeriod: PERIOD },
    );
    const clauses = agencyPeriodNarrowingWhere({
      fixationPeriod: filter.fixationPeriod,
      meetingPeriod: filter.meetingPeriod,
    });

    expect(clauses).toHaveLength(2);
    const clients = clauses[0].brokerAgencies.some.broker.clients.some;
    const meetings = clauses[1].brokerAgencies.some.broker.meetings.some;
    expect(clients.OR).toEqual([
      { fixationStatus: { in: ["FIXED", "EXPIRED"] } },
      {
        uniquenessStatus: {
          in: ["CONDITIONALLY_UNIQUE", "EXPIRED"],
        },
      },
    ]);
    expect(meetings.status).toEqual({ in: ["CONFIRMED", "COMPLETED"] });
    expect(meetings.type).toEqual({ not: "BROKER_TOUR" });
    expect(clients.createdAt.gte.toISOString()).toBe(
      "2026-08-31T21:00:00.000Z",
    );
    expect(clients.createdAt.lt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(meetings.date).toEqual(clients.createdAt);
    expect(clauses[0].brokerAgencies.some.broker.meetings).toBeUndefined();
    expect(clauses[1].brokerAgencies.some.broker.clients).toBeUndefined();
  });

  it("preserves cabinet source and never invents a direct fixationAgencyId path", () => {
    const filter = service.normalizeListFilter(
      {},
      { fixationPeriod: PERIOD, cabinetSource: "old" },
    );
    const clauses = agencyPeriodNarrowingWhere({
      fixationPeriod: filter.fixationPeriod,
      cabinetSource: filter.cabinetSource,
    });

    expect(clauses[0].brokerAgencies.some.broker.clients.some.AND).toEqual([
      expect.objectContaining({ OR: expect.any(Array) }),
      { comment: { startsWith: HISTORICAL } },
    ]);
    expect(JSON.stringify(clauses)).not.toContain("fixationAgencyId");
  });

  it("does not add positive EXISTS for inverse filters", () => {
    const normalized = service.normalizeListFilter(
      {},
      { fixationPeriod: PERIOD, meetingPeriod: PERIOD },
    );
    expect(
      agencyPeriodNarrowingWhere({
        fixationPeriod: normalized.fixationPeriod,
        activityColumn: "NO_FIXATIONS",
      }),
    ).toEqual([]);
    for (const guard of [
      { activityColumn: "NO_MEETINGS" },
      { scenario: "NO_MEETINGS" },
      { meetingsMax: 0 },
    ]) {
      expect(
        agencyPeriodNarrowingWhere({
          meetingPeriod: normalized.meetingPeriod,
          ...guard,
        }),
      ).toEqual([]);
    }
  });

  it("adds no candidate predicate when no explicit period was selected", () => {
    expect(agencyPeriodNarrowingWhere({})).toEqual([]);
  });

  it("wires candidate predicates into root where without narrowing include", async () => {
    const prisma = { agency: { findMany: jest.fn().mockResolvedValue([]) } };
    const local = new LoyaltyBaseService(prisma as any) as any;
    local.attachOurAgencyRegistryDeals = jest.fn();
    local.workflowCallReadModels = jest.fn().mockResolvedValue([]);
    local.attachWorkflowCallReadModels = jest.fn();
    local.engagementReadModels = jest.fn().mockResolvedValue([]);
    local.attachEngagementReadModels = jest.fn();
    local.linkedAnnaTargetIds = jest.fn().mockResolvedValue(null);
    local.linkedAnnaPredicate = jest.fn().mockReturnValue(() => true);
    local.sortLoyaltyCandidates = jest.fn();
    local.attachOurLinkedAnna = jest.fn();
    local.oursListEnvelope = jest.fn().mockReturnValue({ filterHash: "hash" });
    local.listActivitySummary = jest.fn().mockResolvedValue(null);
    const filter = local.normalizeListFilter(
      {},
      { fixationPeriod: PERIOD, meetingPeriod: PERIOD },
    );

    await local.listOurAgencies({ page: 1, pageSize: 1 }, filter);

    const query = prisma.agency.findMany.mock.calls[0][0];
    expect(query.where.AND).toHaveLength(2);
    expect(
      query.include.brokerAgencies.include.broker.select.clients.where,
    ).toEqual(expect.objectContaining({ OR: expect.any(Array) }));
    expect(
      query.include.brokerAgencies.include.broker.select.clients.where,
    ).not.toHaveProperty("createdAt");
    expect(
      query.include.brokerAgencies.include.broker.select.meetings.where,
    ).not.toHaveProperty("date");
  });

  it.each([
    ["before", "2026-08-31T20:59:59.999Z", false],
    ["start", "2026-09-01T00:00:00.000Z", true],
    ["end", "2026-09-30T23:59:59.999Z", true],
    ["exclusive after", "2026-10-01T00:00:00.000Z", false],
  ])(
    "keeps final and candidate date boundaries safe at %s",
    (_label, date, expected) => {
      const filter = service.normalizeListFilter(
        {},
        { fixationPeriod: PERIOD, meetingPeriod: PERIOD },
      );
      const raw = agencyFixture(`boundary-${_label}`, [
        {
          clients: [fixed("client", date)],
          meetings: [meeting("meeting", date)],
        },
      ]);
      const loaded = loadedAgency(raw, filter);
      const finalMatch = service.matchesOurAgency(
        loaded,
        { metrics: { fixations: 1, meetings: 1, deals: 0 } },
        filter,
      );

      expect(finalMatch).toBe(expected);
      expect(survivesCandidatePushdown(raw, filter)).toBe(expected);
    },
  );

  it("filters rejected uniqueness, cancelled meetings and broker tours", () => {
    const filter = service.normalizeListFilter(
      {},
      { fixationPeriod: PERIOD, meetingPeriod: PERIOD },
    );
    const raw = agencyFixture("filtered-rows", [
      {
        clients: [rejected("rejected", "2026-09-15T10:00:00.000Z")],
        meetings: [
          meeting("cancelled", "2026-09-15T10:00:00.000Z", "CANCELLED"),
          meeting(
            "tour",
            "2026-09-15T10:00:00.000Z",
            "COMPLETED",
            "BROKER_TOUR",
          ),
        ],
      },
    ]);
    const loaded = loadedAgency(raw, filter);

    expect(
      service.matchesOurAgency(
        loaded,
        { metrics: { fixations: 0, meetings: 0, deals: 0 } },
        filter,
      ),
    ).toBe(false);
    expect(survivesCandidatePushdown(raw, filter)).toBe(false);
  });

  it("treats a null comment as a new-cabinet fixation", () => {
    const filter = service.normalizeListFilter(
      {},
      { fixationPeriod: PERIOD, cabinetSource: "new" },
    );
    const raw = agencyFixture("new-null-comment", [
      { clients: [fixed("new", "2026-09-15T10:00:00.000Z", null)] },
    ]);
    const loaded = loadedAgency(raw, filter);

    expect(
      service.matchesOurAgency(
        loaded,
        { metrics: { fixations: 1, meetings: 0, deals: 0 } },
        filter,
      ),
    ).toBe(true);
    expect(survivesCandidatePushdown(raw, filter)).toBe(true);
  });

  it("has no false negatives across positive, inverse, source and boundary cases", () => {
    const fixtures = [
      agencyFixture("split", [
        { clients: [fixed("new", "2026-09-15T10:00:00.000Z")] },
        { meetings: [meeting("meeting", "2026-09-20T10:00:00.000Z")] },
      ]),
      agencyFixture("old", [
        {
          clients: [
            fixed("old", "2026-09-10T10:00:00.000Z", "[old-cabinet:1]"),
          ],
        },
      ]),
      agencyFixture("utc-end", [
        {
          clients: [fixed("late", "2026-09-30T22:30:00.000Z")],
          meetings: [meeting("late-meeting", "2026-09-30T22:45:00.000Z")],
        },
      ]),
      agencyFixture("rejected-and-cancelled", [
        {
          clients: [rejected("rejected", "2026-09-15T10:00:00.000Z")],
          meetings: [
            meeting("cancelled", "2026-09-15T10:00:00.000Z", "CANCELLED"),
            meeting(
              "tour",
              "2026-09-15T10:00:00.000Z",
              "COMPLETED",
              "BROKER_TOUR",
            ),
          ],
        },
      ]),
      agencyFixture("empty", []),
    ];
    const cases = [
      { canonical: { fixationPeriod: PERIOD } },
      { canonical: { meetingPeriod: PERIOD } },
      { canonical: { fixationPeriod: PERIOD, meetingPeriod: PERIOD } },
      { canonical: { fixationPeriod: PERIOD, cabinetSource: "old" } },
      { canonical: { fixationPeriod: PERIOD, cabinetSource: "new" } },
      {
        canonical: { fixationPeriod: PERIOD },
        columns: { activity: "NO_FIXATIONS" },
      },
      {
        canonical: { meetingPeriod: PERIOD },
        columns: { activity: "NO_MEETINGS" },
      },
      {
        canonical: { meetingPeriod: PERIOD, scenario: "NO_MEETINGS" },
      },
      {
        canonical: { meetingPeriod: PERIOD, meetings: { max: 0 } },
      },
    ];

    for (const fixture of fixtures) {
      for (const input of cases) {
        const filter = service.normalizeListFilter(
          { columns: input.columns || {} },
          { includeLowSignal: true, ...input.canonical },
        );
        const loaded = loadedAgency(fixture, filter);
        const fixations = loaded.brokerAgencies.flatMap(
          (relation: any) => relation.broker.clients,
        ).length;
        const meetings = loaded.brokerAgencies.flatMap(
          (relation: any) => relation.broker.meetings,
        ).length;
        const finalMatch = service.matchesOurAgency(
          loaded,
          { metrics: { fixations, meetings, deals: 0 } },
          filter,
        );
        if (finalMatch) {
          expect(survivesCandidatePushdown(fixture, filter)).toBe(true);
        }
      }
    }
  });
});
