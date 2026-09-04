import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";

describe("PII-safe GET-only amo fixation lead reconciliation inspector", () => {
  const repositoryRoot = resolve(__dirname, "../../../..");
  const scriptPath = resolve(
    repositoryRoot,
    "scripts/inspect-amo-fixation-lead-reconciliation.js",
  );
  const workflowPath = resolve(
    repositoryRoot,
    ".github/workflows/inspect-production-amo-fixation-lead-reconciliation.yml",
  );
  const script = readFileSync(scriptPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");
  const NodeModule = jest.requireActual("module") as any;
  const loadedScript = new NodeModule(scriptPath, module);
  loadedScript.filename = scriptPath;
  loadedScript.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
  loadedScript._compile(script, scriptPath);
  const inspector = loadedScript.exports as {
    ATTEMPT_LIMIT: number;
    CAS_LINK_ELIGIBLE_ERROR_CLASSES: readonly string[];
    COHORT_ATTESTATION_DOMAIN: string;
    EXPECTED_ACCOUNT_ID: number;
    KC_PIPELINE_ID: number;
    KNOWN_QUEUE_ROWS: number;
    MAX_RESPONSE_BODY_BYTES: number;
    STATEMENT_TIMEOUT_MS: number;
    assertExpectedAccount: (request: any) => Promise<void>;
    assertExpectedQueueRows: (rows: any[]) => void;
    assertReadOnlySession: (prisma: any) => Promise<void>;
    buildReadOnlyDatabaseUrl: (value: string) => string;
    buildReport: (
      rows: any[],
      evidence: any,
      metadata: any,
      attestationKey: Buffer,
      hashKey?: Buffer,
    ) => any;
    canonicalAmoUrl: (path: string, query?: Record<string, unknown>) => URL;
    classifyFailure: (error: unknown) => string;
    collectAmoEvidence: (rows: any[], request: any) => Promise<any>;
    contactHasExactPhone: (contact: any, phone: string) => boolean;
    createGetOnlyRequester: (token: string, fetchImpl?: any) => any;
    lookupExactClientContacts: (
      request: any,
      phone: string,
      maxPages?: number,
    ) => Promise<any>;
    normalizePhone: (value: unknown) => string | null;
    optionalStoredAmoLeadId: (value: unknown) => number | null;
    readBoundedJsonResponse: (response: any, controller?: any) => Promise<any>;
    reduceLeadEvidence: (lead: any, expectedLeadId: number) => any;
    reportHash: (kind: string, value: unknown, key: Buffer) => string | null;
    unixTimestampEvidence: (values: unknown, reference: Date) => any;
  };

  const casLinkEligibleErrors: Array<[string, string]> = [
    [
      "AMO_CREATE_RECONCILIATION_REQUIRED: private payload",
      "create_reconciliation_required",
    ],
    ["fetch failed: ECONNRESET", "network_failure"],
    ["FIXATION_AGENCY_MISSING", "fixation_agency_missing"],
    ["BROKER_AMO_CONTACT_MISSING", "broker_amo_contact_missing"],
  ];

  const metadata = {
    inspectorSha256: "a".repeat(64),
    deployedGitSha: "b".repeat(40),
  };
  const attestationKey = Buffer.alloc(32, 0x31);
  const aliasKey = Buffer.alloc(32, 0x42);

  const queueRow = (overrides: Record<string, unknown> = {}) => ({
    id: "3fc34e89-8a22-4630-81d4-b3a87653d2cb",
    phone: "+7 (999) 123-45-67",
    project: "ZORGE9",
    createdAt: new Date("2026-08-25T07:27:50.500Z"),
    amoLeadId: null,
    amoSyncStatus: "FAILED",
    amoSyncAttempts: 10,
    amoSyncLastAttemptAt: new Date("2026-08-25T07:30:00.000Z"),
    amoSyncError:
      "AMO_CREATE_RECONCILIATION_REQUIRED: private@example.test +79991234567",
    broker: {
      id: "24e7bdeb-20bd-4f3f-83d6-6db564531896",
      amoContactId: BigInt(900001),
    },
    responsibleBroker: null,
    ...overrides,
  });

  const fixedCohort = (primary = queueRow()) => [
    primary,
    ...Array.from({ length: inspector.KNOWN_QUEUE_ROWS - 1 }, (_, index) =>
      queueRow({
        id: `f${String(index + 1).padStart(7, "0")}-0000-4000-8000-${String(
          index + 1,
        ).padStart(12, "0")}`,
        phone: `invalid-phone-${index + 1}`,
        amoSyncError: null,
        broker: null,
      }),
    ),
  ];

  const leadEnvelope = (
    id: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    leadId: id,
    pipelineId: inspector.KC_PIPELINE_ID,
    statusId: 62907350,
    createdAt: 1787642871,
    sourceMarker: true,
    requestValues: [1787642871],
    projectValues: ["Зорге 9"],
    contactIds: [800001, 900001],
    ...overrides,
  });

  const evidence = (leads: any[], contacts = [800001]) => ({
    byPhone: new Map([
      [
        "+79991234567",
        {
          exactContactIds: contacts,
          leads,
        },
      ],
    ]),
    stats: {
      normalizedPhones: 1,
      contactSearchPages: 1,
      contactRowsRead: 1,
      exactContacts: contacts.length,
      distinctLinkedLeadsRead: leads.length,
    },
  });

  const jsonResponse = (payload: unknown, status = 200) => {
    const bytes = Buffer.from(JSON.stringify(payload));
    let completed = false;
    const reader = {
      read: jest.fn(async () => {
        if (completed) return { done: true, value: undefined };
        completed = true;
        return { done: false, value: bytes };
      }),
      cancel: jest.fn(async () => undefined),
      releaseLock: jest.fn(),
    };
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      body: { getReader: () => reader, cancel: jest.fn() },
      reader,
    };
  };

  it("permits only the read-only queue SELECT and canonical GET requests", () => {
    expect(script).toContain("prisma.client.findMany({");
    expect(script).toContain("await prisma.$disconnect()");
    expect(script).toContain('method: "GET"');
    expect(script).toContain('redirect: "error"');
    expect(script).not.toMatch(
      /NestFactory|AppModule|AmoCrmAdapter|refreshAccessToken|AMO_REFRESH_TOKEN|SystemSetting|\baxios\b|node:https|node:http/,
    );
    expect(script).not.toMatch(
      /prisma(?:\.[A-Za-z_$][\w$]*)+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    const taggedQueries = [
      ...script.matchAll(/prisma\.\$queryRaw`([^`]*)`/g),
    ].map((match) => match[1]);
    expect(taggedQueries).toEqual([
      "SELECT current_setting('default_transaction_read_only') AS mode",
    ]);
    expect(taggedQueries[0]).not.toContain("${");
    expect(script).not.toMatch(/prisma\.\$queryRaw\s*\(/);
    expect(script).not.toMatch(
      /\$(?:executeRaw|executeRawUnsafe|queryRawUnsafe|transaction)\b/,
    );
    expect(script.match(/prisma\.client\.findMany\s*\(/g) || []).toHaveLength(
      1,
    );
    expect(script.match(/new PrismaClient\s*\(/g) || []).toHaveLength(1);
    expect(script).toContain(
      "datasources: { db: { url: readOnlyDatabaseUrl } }",
    );
    expect(script.match(/process\.stdout\.write\s*\(/g) || []).toHaveLength(1);
    expect(script.match(/process\.stderr\.write\s*\(/g) || []).toHaveLength(1);
    expect(script).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(script).toContain("amoSyncAttempts: { gte: ATTEMPT_LIMIT }");
    expect(inspector.KNOWN_QUEUE_ROWS).toBe(2);
    expect(script).toContain("const KNOWN_QUEUE_ROWS = 2");
    expect(script).toContain("take: 3");
    expect(script).not.toContain("take: runtime.metadata.expectedQueueRows");
    expect(script).toContain(
      "leads.set(leadId, reduceLeadEvidence(lead, leadId))",
    );
    expect(script).not.toMatch(/leads\.set\([^\n]*\{\s*lead\s*[,}]/);
    expect(script).toContain("oauthRefreshAttempted: false");
    expect(script).toContain("databaseMutationAuthorized: false");
    expect(script).toContain("amoMutationAuthorized: false");
    expect(script).toContain("retryAuthorized: false");
    expect(script).toContain("clientPhonesHeldInMemoryOnly: true");
    expect(script).not.toMatch(
      /process\.env\.(?:BROKER_CONTACT_COHORT_ATTESTATION_KEY|COHORT_ATTESTATION_KEY)\b/,
    );
  });

  it("enforces the PostgreSQL read-only session without exposing URL secrets", async () => {
    const raw =
      "postgresql://audit-user:s3cr%40t-value@db.internal:5432/broker_platform" +
      "?schema=loyalty&connection_limit=3" +
      "&options=-c%20search_path%3Dpublic" +
      "&options=-c%20lock_timeout%3D1s" +
      "&application_name=lead-reconciliation";
    const parsed = new URL(inspector.buildReadOnlyDatabaseUrl(raw));
    expect(parsed.username).toBe("audit-user");
    expect(parsed.password).toBe("s3cr%40t-value");
    expect(parsed.searchParams.get("schema")).toBe("loyalty");
    expect(parsed.searchParams.getAll("options")).toEqual([
      "-c search_path=public -c lock_timeout=1s " +
        "-c default_transaction_read_only=on " +
        `-c statement_timeout=${inspector.STATEMENT_TIMEOUT_MS}`,
    ]);

    const exactSelect = jest.fn(async (strings: TemplateStringsArray) => {
      expect([...strings]).toEqual([
        "SELECT current_setting('default_transaction_read_only') AS mode",
      ]);
      return [{ mode: "on" }];
    });
    await expect(
      inspector.assertReadOnlySession({ $queryRaw: exactSelect }),
    ).resolves.toBeUndefined();
    await expect(
      inspector.assertReadOnlySession({
        $queryRaw: async () => [{ mode: "off" }],
      }),
    ).rejects.toThrow("Database session is not read-only");

    try {
      inspector.buildReadOnlyDatabaseUrl("invalid-db-password-secret");
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain("db-password-secret");
    }
  });

  it("allowlists account/contact/lead GET URLs and never retries a 401", async () => {
    expect(String(inspector.canonicalAmoUrl("/api/v4/account"))).toBe(
      "https://stmichael.amocrm.ru/api/v4/account",
    );
    expect(
      String(
        inspector.canonicalAmoUrl("/api/v4/contacts", {
          query: "9991234567",
          limit: 250,
          page: 1,
        }),
      ),
    ).toBe(
      "https://stmichael.amocrm.ru/api/v4/contacts?limit=250&page=1&query=9991234567",
    );
    expect(
      String(
        inspector.canonicalAmoUrl("/api/v4/contacts/800001", {
          with: "leads",
        }),
      ),
    ).toBe("https://stmichael.amocrm.ru/api/v4/contacts/800001?with=leads");
    expect(
      String(
        inspector.canonicalAmoUrl("/api/v4/leads/32310587", {
          with: "contacts",
        }),
      ),
    ).toBe("https://stmichael.amocrm.ru/api/v4/leads/32310587?with=contacts");
    for (const unsafe of [
      ["/api/v4/leads", {}],
      ["//evil.invalid/api/v4/account", {}],
      ["/api/v4/contacts", { query: "79991234567", limit: 250, page: 1 }],
      ["/api/v4/contacts/800001", { with: "companies" }],
      ["/api/v4/leads/32310587", { with: "contacts", unsafe: "1" }],
    ] as any[]) {
      expect(() => inspector.canonicalAmoUrl(unsafe[0], unsafe[1])).toThrow(
        /Unsafe amoCRM (?:path|query)/,
      );
    }

    const accountFetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ id: inspector.EXPECTED_ACCOUNT_ID }));
    const request = inspector.createGetOnlyRequester(
      "private-access-token",
      accountFetch,
    );
    await expect(
      inspector.assertExpectedAccount(request),
    ).resolves.toBeUndefined();
    expect(accountFetch).toHaveBeenCalledTimes(1);
    expect(accountFetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });

    const rejectedBody = { cancel: jest.fn(async () => undefined) };
    const rejectedFetch = jest.fn().mockResolvedValue({
      status: 401,
      ok: false,
      headers: { get: () => null },
      body: rejectedBody,
    });
    const rejectedRequest = inspector.createGetOnlyRequester(
      "private-access-token",
      rejectedFetch,
    );
    await expect(rejectedRequest("/api/v4/account")).rejects.toThrow(
      "amoCRM request rejected",
    );
    expect(rejectedFetch).toHaveBeenCalledTimes(1);
    expect(rejectedBody.cancel).toHaveBeenCalledTimes(1);
  });

  it("caps response streams and cancels an oversized body before parsing", async () => {
    const body = { cancel: jest.fn(async () => undefined) };
    const controller = { abort: jest.fn() };
    await expect(
      inspector.readBoundedJsonResponse(
        {
          headers: {
            get: (name: string) =>
              name === "content-length"
                ? String(inspector.MAX_RESPONSE_BODY_BYTES + 1)
                : null,
          },
          body,
        },
        controller,
      ),
    ).rejects.toThrow("amoCRM response body exceeded safety bound");
    expect(controller.abort).toHaveBeenCalledTimes(1);
    expect(body.cancel).toHaveBeenCalledTimes(1);

    const invalidUtf8Reader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: Uint8Array.from([0xc3, 0x28]),
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: jest.fn(async () => undefined),
      releaseLock: jest.fn(),
    };
    await expect(
      inspector.readBoundedJsonResponse(
        {
          headers: { get: () => null },
          body: { getReader: () => invalidUtf8Reader },
        },
        { abort: jest.fn() },
      ),
    ).rejects.toThrow("amoCRM returned invalid JSON");
    expect(invalidUtf8Reader.cancel).toHaveBeenCalledTimes(1);
  });

  it("post-filters exact client phones and traverses only their bounded linked leads", async () => {
    expect(inspector.normalizePhone("8 (999) 123-45-67")).toBe("+79991234567");
    expect(inspector.normalizePhone("not-a-phone")).toBeNull();
    const contact = (id: number, phone: string) => ({
      id,
      custom_fields_values: [{ field_id: 557903, values: [{ value: phone }] }],
    });
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        _embedded: {
          contacts: [
            contact(800001, "+7 999 123-45-67"),
            contact(800002, "+7 999 999-99-99"),
          ],
        },
        _links: {},
      })
      .mockResolvedValueOnce({
        ...contact(800001, "8 (999) 123-45-67"),
        _embedded: { leads: [{ id: 32310587 }] },
      });
    await expect(
      inspector.lookupExactClientContacts(request, "+79991234567"),
    ).resolves.toEqual({
      contacts: [{ contactId: 800001, leadIds: [32310587] }],
      pagesRead: 1,
      contactsRead: 2,
    });
    expect(request).toHaveBeenNthCalledWith(1, "/api/v4/contacts", {
      query: "9991234567",
      limit: 250,
      page: 1,
    });
    expect(request).toHaveBeenNthCalledWith(2, "/api/v4/contacts/800001", {
      with: "leads",
    });

    const incompleteHydration = jest
      .fn()
      .mockResolvedValueOnce({
        _embedded: { contacts: [contact(800001, "+79991234567")] },
        _links: {},
      })
      .mockResolvedValueOnce(contact(800001, "+79991234567"));
    await expect(
      inspector.lookupExactClientContacts(incompleteHydration, "+79991234567"),
    ).rejects.toThrow("Invalid amoCRM contact record");

    const routes = jest.fn(async (path: string) => {
      if (path === "/api/v4/contacts") {
        return {
          _embedded: { contacts: [contact(800001, "+79991234567")] },
          _links: {},
        };
      }
      if (path === "/api/v4/contacts/800001") {
        return {
          ...contact(800001, "+79991234567"),
          _embedded: { leads: [{ id: 32310587 }] },
        };
      }
      if (path === "/api/v4/leads/32310587") {
        return {
          id: 32310587,
          pipeline_id: inspector.KC_PIPELINE_ID,
          status_id: 62907350,
          created_at: 1787642871,
          custom_fields_values: [
            { field_id: 665195, values: [{ enum_id: 985337 }] },
            { field_id: 833189, values: [{ value: 1787642871 }] },
            { field_id: 839179, values: [{ value: "Зорге 9" }] },
            {
              field_id: 999999,
              values: [{ value: "unselected-private-payload" }],
            },
          ],
          _embedded: { contacts: [{ id: 800001 }, { id: 900001 }] },
        };
      }
      throw new Error("unexpected route");
    });
    const collected = await inspector.collectAmoEvidence([queueRow()], routes);
    expect(collected.stats).toMatchObject({
      normalizedPhones: 1,
      exactContacts: 1,
      distinctLinkedLeadsRead: 1,
    });
    expect(collected.byPhone.get("+79991234567").leads).toHaveLength(1);
    const reducedLead = collected.byPhone.get("+79991234567").leads[0];
    expect(reducedLead).toMatchObject({
      leadId: 32310587,
      pipelineId: inspector.KC_PIPELINE_ID,
      statusId: 62907350,
      sourceMarker: true,
      requestValues: [1787642871],
      projectValues: ["Зорге 9"],
      contactIds: [800001, 900001],
    });
    expect(reducedLead).not.toHaveProperty("lead");
    expect(JSON.stringify(reducedLead)).not.toContain(
      "unselected-private-payload",
    );
  });

  it("fails closed on duplicate selected amoCRM custom fields", () => {
    expect(() =>
      inspector.contactHasExactPhone(
        {
          custom_fields_values: [
            {
              field_id: 557903,
              field_code: "PHONE",
              values: [{ value: "+79991234567" }],
            },
            {
              field_id: 999999,
              field_code: "PHONE",
              values: [{ value: "+79991234567" }],
            },
          ],
        },
        "+79991234567",
      ),
    ).toThrow("Ambiguous amoCRM selected custom field");

    for (const fieldId of [665195, 833189, 839179]) {
      const selectedValue =
        fieldId === 665195
          ? { enum_id: 985337 }
          : { value: fieldId === 839179 ? "Зорге 9" : 1787642871 };
      expect(() =>
        inspector.reduceLeadEvidence(
          {
            id: 32310587,
            pipeline_id: inspector.KC_PIPELINE_ID,
            status_id: 62907350,
            created_at: 1787642871,
            custom_fields_values: [
              { field_id: fieldId, values: [selectedValue] },
              { field_id: fieldId, values: [selectedValue] },
            ],
            _embedded: { contacts: [{ id: 800001 }, { id: 900001 }] },
          },
          32310587,
        ),
      ).toThrow("Ambiguous amoCRM selected custom field");
    }
  });

  it("emits one HMAC-only strong candidate and a deterministic cohort digest", () => {
    const rawLeadId = 32310587;
    const row = queueRow();
    const report = inspector.buildReport(
      fixedCohort(row),
      evidence([leadEnvelope(rawLeadId)]),
      metadata,
      attestationKey,
      aliasKey,
    );
    const serialized = JSON.stringify(report);
    expect(report.aggregates).toMatchObject({
      exhaustedQueueRows: 2,
      exactClientContacts: { none: 1, one: 1, multiple: 0 },
      candidates: { strong: 1, weak: 0 },
      rowsWithCasLinkCandidate: 1,
      resolution: { single_strong_candidate: 1 },
    });
    expect(report.records[0]).toMatchObject({
      resolution: "single_strong_candidate",
      exactClientContacts: { count: 1 },
      linkedLeadEvidence: { kcPipeline: 1, strong: 1, weak: 0 },
      advisory: {
        casLinkCandidate: true,
        executablePayload: false,
        databaseMutationAuthorized: false,
        amoMutationAuthorized: false,
        retryAuthorized: false,
      },
    });
    expect(report.records[0].queueHash).toMatch(/^queue_[0-9a-f]{24}$/);
    expect(report.records[0].strongCandidates[0].leadHash).toMatch(
      /^lead_[0-9a-f]{24}$/,
    );
    expect(report.records[0].strongCandidates[0]).toMatchObject({
      expectedBrokerAttachment: "present",
      projectEvidence: "match",
      leadCreatedAt: { coverage: "valid", relativeToQueue: "within_15m" },
      brokerRequestAt: { coverage: "valid", relativeToQueue: "within_15m" },
    });
    expect(report.cohortAttestation).toMatchObject({
      domain: inspector.COHORT_ATTESTATION_DOMAIN,
      hmacSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      bindsInspectorSha256: metadata.inspectorSha256,
      bindsDeployedGitSha: metadata.deployedGitSha,
      expectedQueueRows: 2,
    });
    const repeat = inspector.buildReport(
      fixedCohort(row),
      evidence([leadEnvelope(rawLeadId)]),
      { ...metadata, expectedQueueRows: 1 },
      attestationKey,
      Buffer.alloc(32, 0x43),
    );
    expect(repeat.cohortAttestation.hmacSha256).toBe(
      report.cohortAttestation.hmacSha256,
    );
    expect(repeat.records[0].queueHash).not.toBe(report.records[0].queueHash);
    const changedDeployment = inspector.buildReport(
      fixedCohort(row),
      evidence([leadEnvelope(rawLeadId)]),
      { ...metadata, deployedGitSha: "c".repeat(40) },
      attestationKey,
      aliasKey,
    );
    expect(changedDeployment.cohortAttestation.hmacSha256).not.toBe(
      report.cohortAttestation.hmacSha256,
    );
    const sameCountDifferentQueue = inspector.buildReport(
      fixedCohort(queueRow({ id: "8bdc616d-aa3a-493f-82a5-9b26d9e13cf9" })),
      evidence([leadEnvelope(rawLeadId)]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(sameCountDifferentQueue.cohortAttestation.hmacSha256).not.toBe(
      report.cohortAttestation.hmacSha256,
    );
    const sameCountDifferentLead = inspector.buildReport(
      fixedCohort(row),
      evidence([leadEnvelope(32310589)]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(sameCountDifferentLead.cohortAttestation.hmacSha256).not.toBe(
      report.cohortAttestation.hmacSha256,
    );

    for (const secret of [
      row.id,
      row.phone,
      "79991234567",
      row.broker.id,
      String(row.broker.amoContactId),
      String(rawLeadId),
      "private@example.test",
      attestationKey.toString("hex"),
      aliasKey.toString("hex"),
      "2026-08-25T07:27:50.500Z",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    expect(serialized).not.toMatch(/\.\d{3}Z/);
    expect(serialized).not.toContain("queueCreatedAtHourBucket");
    expect(serialized).not.toContain("lastAttemptAtHourBucket");
    expect(serialized).not.toContain("2026-08-25T07:00Z");

    const parsedPublicReport = JSON.parse(serialized);
    expect(parsedPublicReport).not.toHaveProperty("generatedAt");
    expect(
      Object.keys(
        parsedPublicReport.records[0].strongCandidates[0].leadCreatedAt,
      ).sort(),
    ).toEqual(["coverage", "relativeToQueue", "validValueCount"]);
    const pending: Array<{ path: string; value: unknown }> = [
      { path: "$", value: parsedPublicReport },
    ];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (typeof current.value === "string") {
        expect(current.value).not.toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
        );
      } else if (typeof current.value === "number") {
        expect(
          current.value >= 946_684_800 && current.value <= 4_133_980_800,
        ).toBe(false);
      } else if (Array.isArray(current.value)) {
        current.value.forEach((value, index) =>
          pending.push({ path: `${current.path}[${index}]`, value }),
        );
      } else if (current.value && typeof current.value === "object") {
        for (const [key, value] of Object.entries(current.value)) {
          expect([
            "generatedAt",
            "queueCreatedAt",
            "lastAttemptAt",
            "clockBucket",
            "hourBucket",
          ]).not.toContain(key);
          pending.push({ path: `${current.path}.${key}`, value });
        }
      }
    }
  });

  it("never downgrades an invalid non-null stored amo lead BigInt to unlinked", () => {
    expect(inspector.optionalStoredAmoLeadId(32310587n)).toBe(32310587);
    expect(inspector.optionalStoredAmoLeadId("32310587")).toBe(32310587);
    expect(() => inspector.optionalStoredAmoLeadId(32310587)).toThrow(
      "Invalid stored amo lead id",
    );
    expect(() => inspector.optionalStoredAmoLeadId("032310587")).toThrow(
      "Invalid stored amo lead id",
    );

    let failure: unknown;
    let unsafeReport: unknown;
    try {
      unsafeReport = inspector.buildReport(
        fixedCohort(queueRow({ amoLeadId: 9007199254740993n })),
        evidence([leadEnvelope(32310587)]),
        metadata,
        attestationKey,
        aliasKey,
      );
    } catch (error) {
      failure = error;
    }
    expect(unsafeReport).toBeUndefined();
    expect(failure).toMatchObject({ message: "Invalid stored amo lead id" });
    expect(inspector.classifyFailure(failure)).toBe(
      "INVALID_STORED_AMO_LEAD_ID",
    );

    const alreadyLinked = inspector.buildReport(
      fixedCohort(queueRow({ amoLeadId: "32310587" })),
      evidence([leadEnvelope(32310587)]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(alreadyLinked.records[0]).toMatchObject({
      resolution: "database_lead_already_present",
      advisory: { casLinkCandidate: false, retryAuthorized: false },
    });
  });

  it("fails closed on the two-near-simultaneous-lead shape and never authorizes retry", () => {
    const first = leadEnvelope(32310587);
    const second = leadEnvelope(32310589, { createdAt: 1787642872 });
    const report = inspector.buildReport(
      fixedCohort(),
      evidence([second, first]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(report.records[0]).toMatchObject({
      resolution: "multiple_strong_candidates",
      linkedLeadEvidence: { strong: 2 },
      advisory: { casLinkCandidate: false, retryAuthorized: false },
    });
    expect(report.records[0].strongCandidates).toHaveLength(2);
    expect(report.records[0].strongCandidates[0].leadHash).not.toBe(
      report.records[0].strongCandidates[1].leadHash,
    );
    expect(report.plan.retryAuthorized).toBe(false);
  });

  it.each(casLinkEligibleErrors)(
    "advises only a database CAS link for exact strong evidence in %s",
    (amoSyncError, errorClass) => {
      const report = inspector.buildReport(
        fixedCohort(queueRow({ amoSyncError })),
        evidence([leadEnvelope(32310587)]),
        metadata,
        attestationKey,
        aliasKey,
      );
      expect(inspector.CAS_LINK_ELIGIBLE_ERROR_CLASSES).toEqual(
        casLinkEligibleErrors.map(([, value]) => value),
      );
      expect(report.records[0]).toMatchObject({
        errorClass,
        resolution: "single_strong_candidate",
        exactClientContacts: { count: 1 },
        linkedLeadEvidence: { strong: 1, weak: 0 },
        advisory: {
          casLinkCandidate: true,
          executablePayload: false,
          databaseMutationAuthorized: false,
          amoMutationAuthorized: false,
          retryAuthorized: false,
        },
      });
      expect(report.aggregates.rowsWithCasLinkCandidate).toBe(1);
    },
  );

  it.each([
    ["AMO_TEMPORARY_UNAVAILABLE", "temporary_unavailable"],
    ["UNRECOGNIZED_LEGACY_FAILURE", "other"],
  ])(
    "rejects an unsafe or unknown error class even with exact strong evidence: %s",
    (amoSyncError, errorClass) => {
      const report = inspector.buildReport(
        fixedCohort(queueRow({ amoSyncError })),
        evidence([leadEnvelope(32310587)]),
        metadata,
        attestationKey,
        aliasKey,
      );
      expect(report.records[0]).toMatchObject({
        errorClass,
        resolution: "single_strong_candidate",
        advisory: { casLinkCandidate: false, retryAuthorized: false },
      });
      expect(report.aggregates.rowsWithCasLinkCandidate).toBe(0);
    },
  );

  it("keeps weak, ambiguous-contact and changed-cohort states non-executable", () => {
    const weakLead = leadEnvelope(32310600, {
      createdAt: 1779860000,
      requestValues: [],
      contactIds: [800001],
    });
    const weak = inspector.buildReport(
      fixedCohort(),
      evidence([weakLead]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(weak.records[0]).toMatchObject({
      resolution: "single_weak_candidate",
      advisory: { casLinkCandidate: false, retryAuthorized: false },
    });

    const projectMismatch = inspector.buildReport(
      fixedCohort(),
      evidence([leadEnvelope(32310587, { projectValues: ["Берзарина 37"] })]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(projectMismatch.records[0]).toMatchObject({
      resolution: "single_weak_candidate",
      weakCandidates: [{ projectEvidence: "mismatch" }],
      advisory: { casLinkCandidate: false, retryAuthorized: false },
    });

    const brokerClientRoleCollision = inspector.buildReport(
      fixedCohort(
        queueRow({
          broker: {
            id: "24e7bdeb-20bd-4f3f-83d6-6db564531896",
            amoContactId: BigInt(800001),
          },
        }),
      ),
      evidence([leadEnvelope(32310587, { contactIds: [800001] })]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(brokerClientRoleCollision.records[0]).toMatchObject({
      resolution: "broker_client_contact_role_collision",
      weakCandidates: [{ expectedBrokerAttachment: "role_collision" }],
      advisory: { casLinkCandidate: false, retryAuthorized: false },
    });

    const conflictingRequestTime = inspector.buildReport(
      fixedCohort(),
      evidence([
        leadEnvelope(32310587, {
          createdAt: "not-a-timestamp",
          requestValues: [1787642871, 1787642872],
        }),
      ]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(conflictingRequestTime.records[0]).toMatchObject({
      resolution: "single_weak_candidate",
      linkedLeadEvidence: { strong: 0, weak: 1 },
      weakCandidates: [
        {
          brokerRequestAt: {
            coverage: "conflicting",
            relativeToQueue: "unavailable",
          },
        },
      ],
      advisory: { casLinkCandidate: false, retryAuthorized: false },
    });

    const ambiguous = inspector.buildReport(
      fixedCohort(),
      evidence([leadEnvelope(32310587)], [800001, 800002]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(ambiguous.records[0]).toMatchObject({
      resolution: "ambiguous_exact_client_contacts",
      advisory: { casLinkCandidate: false, retryAuthorized: false },
    });
    expect(() => inspector.assertExpectedQueueRows([])).toThrow(
      "Exhausted queue cohort count changed",
    );
    expect(() =>
      inspector.assertExpectedQueueRows([...fixedCohort(), queueRow()]),
    ).toThrow("Exhausted queue cohort count changed");
  });

  it("uses safe relative timestamp classes without emitting exact timestamps", () => {
    const reference = new Date("2026-08-25T07:27:50.500Z");
    const referenceSeconds = Math.floor(reference.getTime() / 1000);
    expect(inspector.unixTimestampEvidence([], reference)).toMatchObject({
      coverage: "missing",
      relativeToQueue: "unavailable",
    });
    expect(inspector.unixTimestampEvidence([1], reference)).toMatchObject({
      coverage: "invalid",
      relativeToQueue: "unavailable",
    });
    expect(
      inspector.unixTimestampEvidence([1787642871, 1787642872], reference),
    ).toMatchObject({
      coverage: "conflicting",
      relativeToQueue: "unavailable",
      validValueCount: 2,
      withinStrongWindow: false,
      withinWeakWindow: false,
    });
    expect(
      inspector.unixTimestampEvidence([referenceSeconds - 600], reference),
    ).toMatchObject({
      relativeToQueue: "within_15m",
      withinStrongWindow: false,
      withinWeakWindow: true,
    });
    const missingAttempt = inspector.buildReport(
      fixedCohort(queueRow({ amoSyncLastAttemptAt: null })),
      evidence([leadEnvelope(32310587)]),
      metadata,
      attestationKey,
      aliasKey,
    );
    const epochAttempt = inspector.buildReport(
      fixedCohort(queueRow({ amoSyncLastAttemptAt: new Date(0) })),
      evidence([leadEnvelope(32310587)]),
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(missingAttempt.cohortAttestation.hmacSha256).not.toBe(
      epochAttempt.cohortAttestation.hmacSha256,
    );
  });

  it("streams an exact-SHA, secret-attested payload under the shared read lock", () => {
    const parsedWorkflow = parse(workflow) as any;
    const workflowShell = parsedWorkflow.jobs.inspect.steps[1].run as string;
    const bash =
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\bin\\bash.exe"
        : "bash";
    expect(existsSync(bash) || process.platform !== "win32").toBe(true);
    const runnerSyntax = spawnSync(bash, ["-n"], {
      input: workflowShell,
      encoding: "utf8",
    });
    expect(runnerSyntax.stderr).toBe("");
    expect(runnerSyntax.status).toBe(0);

    const prefixMarker = "cat <<'REMOTE_PREFIX'\n";
    const prefixStart =
      workflowShell.indexOf(prefixMarker) + prefixMarker.length;
    const prefixEnd = workflowShell.indexOf("\nREMOTE_PREFIX", prefixStart);
    const suffixMarker = "cat <<'REMOTE_SUFFIX'\n";
    const suffixStart =
      workflowShell.indexOf(suffixMarker) + suffixMarker.length;
    const suffixEnd = workflowShell.indexOf("\nREMOTE_SUFFIX", suffixStart);
    expect(prefixStart).toBeGreaterThan(prefixMarker.length);
    expect(prefixEnd).toBeGreaterThan(prefixStart);
    expect(suffixStart).toBeGreaterThan(suffixMarker.length);
    expect(suffixEnd).toBeGreaterThan(suffixStart);
    const generatedRemoteShell = `${workflowShell.slice(
      prefixStart,
      prefixEnd,
    )}\nY29uc29sZS5sb2coInNhZmUiKTs=\nPII_SAFE_LEAD_RECONCILIATION_PAYLOAD\nexpected_payload_sha=${"d".repeat(
      64,
    )}\n${workflowShell.slice(suffixStart, suffixEnd)}\n`;
    const remoteSyntax = spawnSync(bash, ["-n"], {
      input: generatedRemoteShell,
      encoding: "utf8",
    });
    expect(remoteSyntax.stderr).toBe("");
    expect(remoteSyntax.status).toBe(0);

    expect(workflow).toContain("group: production-deploy");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain('EXPECTED_QUEUE_ROWS: "2"');
    expect(workflow).not.toContain("inputs.expected_queue_rows");
    expect(workflow).not.toMatch(/expected_queue_rows:[\s\S]*default:/);
    expect(workflow).toContain(
      'test "$EXPECTED_QUEUE_ROWS" = "2" || { echo "Expected queue row count is invalid"; exit 1; }',
    );
    expect(
      workflow.match(/test "\$expected_queue_rows" = "2"/g) || [],
    ).toHaveLength(2);
    expect(workflow).not.toMatch(/expected_queue_rows[^\n]*1-100|\[1-9\].*100/);
    expect(workflow).toContain(
      "CANONICAL_REPOSITORY: sereganikitin/st-michael-broker-platform",
    );
    expect(workflow).toContain(
      "HEALTH_URL: https://broker.stmichael.ru/api/health",
    );
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain(
      "COHORT_ATTESTATION_KEY: ${{ secrets.BROKER_CONTACT_COHORT_ATTESTATION_KEY }}",
    );
    expect(workflow).toContain(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    );
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('test "$EXPECTED_REF" = "refs/heads/master"');
    expect(workflow).toContain(
      'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
    );
    expect(workflow).toContain(
      "EXPECTED_SSH_FINGERPRINT: ${{ vars.DEPLOY_HOST_FINGERPRINT }}",
    );
    expect(workflow).toContain(
      'ssh-keyscan -p "$SSH_PORT" -t ed25519 "$SSH_HOST"',
    );
    expect(workflow).toContain("-o HostKeyAlgorithms=ssh-ed25519");
    expect(workflow).toContain("-o StrictHostKeyChecking=yes");
    expect(workflow).toContain(
      'test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"',
    );
    expect(workflow).toContain("exec 9</tmp/st-michael-production-deploy.lock");
    expect(workflow).toContain("flock -s -n 9");
    expect(workflow).toContain(
      'test "$(git rev-parse refs/heads/master)" = "$production_sha"',
    );
    expect(workflow).toContain('test "$container_sha" = "$production_sha"');
    expect(workflow).toContain(
      'test "$actual_script_sha" = "$expected_script_sha"',
    );
    expect(workflow).toContain(
      'export BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE="$attestation_key_file"',
    );
    expect(workflow).toContain(
      'export LEAD_RECONCILIATION_INSPECTOR_SHA256="$expected_script_sha"',
    );
    expect(workflow).toContain(
      'export LEAD_RECONCILIATION_DEPLOYED_GIT_SHA="$expected_deployed_sha"',
    );
    expect(workflow).toContain("trap cleanup EXIT HUP INT TERM");
    expect(workflow.match(/\bssh -T\b/g) || []).toHaveLength(1);
    expect(workflow).not.toMatch(
      /appleboy\/ssh-action|git fetch|git reset|git checkout|git show|docker cp/,
    );
    expect(workflow).not.toMatch(
      /echo[^\n]*(?:GH_TOKEN|health_body|COHORT_ATTESTATION_KEY)|set\s+-[^\n]*x/,
    );
    expect(workflow).not.toMatch(
      /bash -s[^\n]*COHORT_ATTESTATION_KEY|ssh[^\n]*COHORT_ATTESTATION_KEY|docker exec[^\n]*COHORT_ATTESTATION_KEY/,
    );
    expect(workflow).toContain(
      'printf \'%s\' "$COHORT_ATTESTATION_KEY" > "$attestation_key_file"',
    );
    expect(workflow).toContain("unset COHORT_ATTESTATION_KEY");
  });
});
