import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";

describe("PII-safe live amoCRM source aggregate inspector", () => {
  const repositoryRoot = resolve(__dirname, "../../../..");
  const scriptPath = resolve(
    repositoryRoot,
    "scripts/inspect-live-amo-source-aggregates.js",
  );
  const workflowPath = resolve(
    repositoryRoot,
    ".github/workflows/inspect-production-live-amo-source.yml",
  );
  const script = readFileSync(scriptPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");
  const specSource = readFileSync(__filename, "utf8");
  const NodeModule = jest.requireActual("module") as any;
  const loadedScript = new NodeModule(scriptPath, module);
  loadedScript.filename = scriptPath;
  loadedScript.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
  loadedScript._compile(script, scriptPath);
  const inspector = loadedScript.exports as any;

  const field = (fieldId: number, value: unknown, enumId?: number) => ({
    field_id: fieldId,
    values: [{ value, ...(enumId ? { enum_id: enumId } : {}) }],
  });

  const streamResponse = (
    raw: Uint8Array,
    options: {
      contentLength?: string | null;
      contentEncoding?: string | null;
      readError?: Error;
      chunkSize?: number;
    } = {},
  ) => {
    let offset = 0;
    const cancel = jest.fn(async () => undefined);
    const releaseLock = jest.fn();
    const read = jest.fn(async () => {
      if (options.readError) throw options.readError;
      if (offset >= raw.byteLength) return { done: true, value: undefined };
      const chunkSize = Math.max(1, options.chunkSize ?? raw.byteLength);
      const end = Math.min(offset + chunkSize, raw.byteLength);
      const value = raw.subarray(offset, end);
      offset = end;
      return { done: false, value };
    });
    const headers = new Map<string, string>();
    const contentLength =
      options.contentLength === undefined
        ? String(raw.byteLength)
        : options.contentLength;
    if (contentLength !== null) headers.set("content-length", contentLength);
    if (options.contentEncoding) {
      headers.set("content-encoding", options.contentEncoding);
    }
    return {
      response: {
        status: 200,
        ok: true,
        headers: {
          get: (name: string) => headers.get(name.toLowerCase()) ?? null,
        },
        body: {
          cancel,
          getReader: () => ({ read, cancel, releaseLock }),
        },
      },
      cancel,
      read,
      releaseLock,
    };
  };

  const jsonStreamResponse = (
    payload: unknown,
    options: Parameters<typeof streamResponse>[1] = {},
  ) => streamResponse(Buffer.from(JSON.stringify(payload), "utf8"), options);

  it("emits only allowlisted PII-safe failure codes", async () => {
    const expectedCodesByMessage = new Map([
      ["Invalid contact record", "INVALID_CONTACT_RECORD"],
      ["Invalid lead record", "INVALID_LEAD_RECORD"],
      ["Lead escaped requested pipeline", "LEAD_PIPELINE_MISMATCH"],
      ["Lead has invalid status", "INVALID_LEAD_STATUS"],
      [
        "Lead contact relations were not embedded",
        "LEAD_CONTACT_RELATIONS_MISSING",
      ],
      ["Unsafe amoCRM path", "UNSAFE_AMO_PATH"],
      ["Unsafe amoCRM URL", "UNSAFE_AMO_URL"],
      ["amoCRM access token is missing", "AMO_ACCESS_TOKEN_MISSING"],
      ["fetch is unavailable", "FETCH_UNAVAILABLE"],
      ["amoCRM request failed", "AMO_REQUEST_FAILED"],
      ["amoCRM request rejected", "AMO_REQUEST_REJECTED"],
      [
        "amoCRM response content length is invalid",
        "AMO_INVALID_CONTENT_LENGTH",
      ],
      [
        "amoCRM response body exceeded safety bound",
        "AMO_RESPONSE_BODY_SAFETY_BOUND_EXCEEDED",
      ],
      ["amoCRM response body is unavailable", "AMO_RESPONSE_BODY_UNAVAILABLE"],
      ["amoCRM response body read failed", "AMO_RESPONSE_BODY_READ_FAILED"],
      ["amoCRM returned invalid JSON", "AMO_INVALID_JSON"],
      ["Malformed amoCRM response", "MALFORMED_AMO_RESPONSE"],
      ["Malformed amoCRM page", "MALFORMED_AMO_PAGE"],
      [
        "amoCRM page exceeded item safety bound",
        "AMO_PAGE_ITEM_SAFETY_BOUND_EXCEEDED",
      ],
      ["amoCRM pagination loop detected", "AMO_PAGINATION_LOOP"],
      [
        "amoCRM pagination exceeded safety bound",
        "AMO_PAGINATION_SAFETY_BOUND_EXCEEDED",
      ],
      ["Unexpected amoCRM account", "UNEXPECTED_AMO_ACCOUNT"],
    ]);
    const fixedMessages = [...script.matchAll(/new Error\("([^"]+)"\)/g)].map(
      (match) => match[1],
    );
    expect(new Set(fixedMessages)).toEqual(
      new Set(expectedCodesByMessage.keys()),
    );
    for (const [message, code] of expectedCodesByMessage) {
      expect(inspector.classifyFailure(new Error(message))).toBe(code);
    }

    const sensitiveMessage =
      "Bearer secret-token for broker@example.test at +7 999 123-45-67; response=https://sensitive.invalid/leads/123";
    const unknownLine = `failure_code=${inspector.classifyFailure(
      new Error(sensitiveMessage),
    )}\n`;
    expect(unknownLine).toBe("failure_code=UNKNOWN_FAILURE\n");
    expect(unknownLine).not.toContain(sensitiveMessage);
    expect(inspector.classifyFailure("amoCRM request failed")).toBe(
      "UNKNOWN_FAILURE",
    );
    expect(
      inspector.classifyFailure(
        new Proxy(new Error("Unsafe amoCRM URL"), {
          get() {
            throw new Error(sensitiveMessage);
          },
        }),
      ),
    ).toBe("UNKNOWN_FAILURE");

    const cli = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, AMO_ACCESS_TOKEN: "" },
    });
    expect(cli.status).toBe(1);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toBe(
      "failure_phase=ACCOUNT\nfailure_code=AMO_ACCESS_TOKEN_MISSING\n",
    );
    for (const rawFragment of [
      "secret-token",
      "broker@example.test",
      "+7 999 123-45-67",
      "https://sensitive.invalid",
    ]) {
      expect(cli.stderr).not.toContain(rawFragment);
    }

    const phases: string[] = [];
    const requestedPaths: string[] = [];
    await expect(
      inspector.scanLiveAmo(
        async (pathname: string, query: Record<string, unknown> = {}) => {
          requestedPaths.push(pathname);
          if (pathname === "/api/v4/account") return { id: 28552900 };
          if (pathname === "/api/v4/contacts") {
            return {
              _embedded: {
                contacts: [
                  {
                    id: 91001,
                    custom_fields_values: [field(835415, true)],
                    _embedded: { companies: [] },
                  },
                ],
              },
              _links: {},
            };
          }
          const leads =
            query["filter[pipeline_id][]"] === 7600546
              ? [
                  {
                    id: 93001,
                    pipeline_id: 7600546,
                    status_id: 62907378,
                    custom_fields_values: [field(665195, "Да", 985337)],
                    _embedded: {
                      contacts: [{ id: 92001, is_main: true }, { id: 91001 }],
                    },
                  },
                ]
              : [];
          return { _embedded: { leads }, _links: {} };
        },
        (phase: string) => phases.push(phase),
      ),
    ).resolves.toMatchObject({
      safety: { source: "live_amocrm_api", httpMethods: ["GET"] },
      deals: { dedupEvidenceCoverage: { entityRelationRowsScanned: 0 } },
    });
    expect(requestedPaths.some((pathname) => pathname.endsWith("/links"))).toBe(
      false,
    );
    expect(phases).toEqual([
      "ACCOUNT",
      "CONTACTS",
      "PIPELINE_BROKERS",
      "PIPELINE_CALL_CENTER",
      "PIPELINE_SALES_A",
      "PIPELINE_SALES_B",
      "PIPELINE_SALES_C",
      "DEAL_AGGREGATION",
    ]);
  });

  it("keeps all Russian markers as valid UTF-8 without mojibake", () => {
    expect(script).toContain('const BROKER_SOURCE_TEXT = "Заявка от брокера"');
    expect(script).toContain("₽");
    expect(script).toContain("руб");
    expect(specSource).toContain('field(665195, "Да", 985337)');
    const suspicious = [
      "\u0420\u2014",
      "\u0420\u00B0",
      "\u0421\u040F",
      "\u0432\u201A\u0405",
      "\u0421\u0402\u0421\u0453\u0420\u00B1",
      "\u0420\u201D\u0420\u00B0",
      "\uFFFD",
    ];
    for (const source of [script, workflow, specSource]) {
      for (const marker of suspicious) expect(source).not.toContain(marker);
    }
  });

  it("has no application DB/Nest path and makes authenticated GET requests only", async () => {
    expect(script).not.toMatch(
      /NestFactory|AppModule|PrismaClient|@st-michael\/database|DATABASE_URL|SystemSetting/,
    );
    expect(script).not.toMatch(/\b(?:axios|got|superagent)\b/);
    expect(script).not.toMatch(
      /method:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]/i,
    );
    expect(script.match(/\bfetchImpl\s*\(/g) || []).toHaveLength(1);
    expect(script).toContain('method: "GET"');
    expect(script).toContain('redirect: "error"');
    expect(script).toContain(
      'const AMO_ORIGIN = "https://stmichael.amocrm.ru"',
    );
    expect(script).toContain("const EXPECTED_ACCOUNT_ID = 28552900");
    expect(script).toContain(
      "createGetOnlyRequester(process.env.AMO_ACCESS_TOKEN)",
    );
    expect(script).not.toContain('with: "leads,companies"');
    expect(script).not.toMatch(
      /process\.env\.(?:AMO_SUBDOMAIN|AMO_API_DOMAIN)/,
    );
    expect(script).not.toMatch(/response\.(?:json|text|arrayBuffer|blob)\s*\(/);
    expect(script).toContain("const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024");
    expect(script).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(script.match(/process\.stdout\.write\s*\(/g) || []).toHaveLength(1);
    expect(script.match(/process\.stderr\.write\s*\(/g) || []).toHaveLength(1);

    const requests: Array<{ url: URL; options: any }> = [];
    const fakeFetch = jest.fn(async (url: URL, options: any) => {
      requests.push({ url, options });
      return jsonStreamResponse({ id: 28552900 }).response;
    });
    const request = inspector.createGetOnlyRequester(
      "fixture-access-token",
      fakeFetch,
    );
    await expect(request("/api/v4/account")).resolves.toEqual({
      id: 28552900,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url.origin).toBe("https://stmichael.amocrm.ru");
    expect(requests[0].url.pathname).toBe("/api/v4/account");
    expect(requests[0].options).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer fixture-access-token",
      },
    });
    expect(() =>
      inspector.canonicalAmoUrl("https://example.test/api/v4/account"),
    ).toThrow("Unsafe amoCRM path");
  });

  it("bounds JSON response bodies and normalizes all body failures", async () => {
    const split = jsonStreamResponse(
      { id: 28552900 },
      { chunkSize: 2, contentEncoding: "identity" },
    );
    const splitRequest = inspector.createGetOnlyRequester(
      "fixture-access-token",
      async () => split.response,
    );
    await expect(splitRequest("/api/v4/account")).resolves.toEqual({
      id: 28552900,
    });
    expect(split.read.mock.calls.length).toBeGreaterThan(2);
    expect(split.releaseLock).toHaveBeenCalledTimes(1);

    const invalidLength = jsonStreamResponse(
      { id: 28552900 },
      { contentLength: "sensitive-invalid-length" },
    );
    const invalidLengthRequest = inspector.createGetOnlyRequester(
      "fixture-access-token",
      async () => invalidLength.response,
    );
    await expect(invalidLengthRequest("/api/v4/account")).rejects.toThrow(
      "amoCRM response content length is invalid",
    );
    expect(invalidLength.read).not.toHaveBeenCalled();
    expect(invalidLength.cancel).toHaveBeenCalledTimes(1);

    let declaredOverflowSignal: AbortSignal | undefined;
    const declaredOverflow = jsonStreamResponse(
      { id: 28552900 },
      { contentLength: String(inspector.MAX_RESPONSE_BODY_BYTES + 1) },
    );
    const declaredOverflowRequest = inspector.createGetOnlyRequester(
      "fixture-access-token",
      async (_url: URL, requestOptions: any) => {
        declaredOverflowSignal = requestOptions.signal;
        return declaredOverflow.response;
      },
    );
    await expect(declaredOverflowRequest("/api/v4/account")).rejects.toThrow(
      "amoCRM response body exceeded safety bound",
    );
    expect(declaredOverflow.read).not.toHaveBeenCalled();
    expect(declaredOverflow.cancel).toHaveBeenCalledTimes(1);
    expect(declaredOverflowSignal?.aborted).toBe(true);

    const mismatchedLength = jsonStreamResponse(
      { id: 28552900 },
      { contentLength: "1" },
    );
    const mismatchedLengthRequest = inspector.createGetOnlyRequester(
      "fixture-access-token",
      async () => mismatchedLength.response,
    );
    await expect(mismatchedLengthRequest("/api/v4/account")).rejects.toThrow(
      "amoCRM response content length is invalid",
    );

    let overflowSignal: AbortSignal | undefined;
    const overflow = streamResponse(
      new Uint8Array(inspector.MAX_RESPONSE_BODY_BYTES + 1),
      { contentLength: null },
    );
    const overflowRequest = inspector.createGetOnlyRequester(
      "fixture-access-token",
      async (_url: URL, requestOptions: any) => {
        overflowSignal = requestOptions.signal;
        return overflow.response;
      },
    );
    await expect(overflowRequest("/api/v4/account")).rejects.toThrow(
      "amoCRM response body exceeded safety bound",
    );
    expect(overflow.cancel).toHaveBeenCalledTimes(1);
    expect(overflowSignal?.aborted).toBe(true);

    const arrayPayload = jsonStreamResponse([{ id: 28552900 }]);
    const arrayRequest = inspector.createGetOnlyRequester(
      "fixture-access-token",
      async () => arrayPayload.response,
    );
    await expect(arrayRequest("/api/v4/account")).rejects.toThrow(
      "Malformed amoCRM response",
    );

    const missingBodyRequest = inspector.createGetOnlyRequester(
      "fixture-access-token",
      async () => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
      }),
    );
    await expect(missingBodyRequest("/api/v4/account")).rejects.toThrow(
      "amoCRM response body is unavailable",
    );

    const readFailure = streamResponse(new Uint8Array([123]), {
      contentLength: null,
      readError: new Error(
        "Bearer sensitive-token private@example.test +7 999 123-45-67",
      ),
    });
    const readFailureRequest = inspector.createGetOnlyRequester(
      "fixture-access-token",
      async () => readFailure.response,
    );
    await expect(readFailureRequest("/api/v4/account")).rejects.toThrow(
      "amoCRM response body read failed",
    );
    expect(
      inspector.classifyFailure(new Error("amoCRM response body read failed")),
    ).toBe("AMO_RESPONSE_BODY_READ_FAILED");
  });

  it("cancels unread HTTP error bodies before retrying or rejecting", async () => {
    const retryable = jsonStreamResponse({ error: "rate-limited" });
    const rejected = jsonStreamResponse({ error: "forbidden" });
    const success = jsonStreamResponse({ id: 28552900 });
    let retrySignal: AbortSignal | undefined;
    const retryFetch = jest
      .fn()
      .mockImplementationOnce(async (_url: URL, options: any) => {
        retrySignal = options.signal;
        return { ...retryable.response, status: 429, ok: false };
      })
      .mockImplementationOnce(async () => success.response);
    const request = inspector.createGetOnlyRequester(
      "fixture-access-token",
      retryFetch,
    );

    await expect(request("/api/v4/account")).resolves.toEqual({ id: 28552900 });
    expect(retryable.read).not.toHaveBeenCalled();
    expect(retryable.cancel).toHaveBeenCalledTimes(1);
    expect(retrySignal?.aborted).toBe(true);

    const rejectedRequest = inspector.createGetOnlyRequester(
      "fixture-access-token",
      async () => ({ ...rejected.response, status: 403, ok: false }),
    );
    await expect(rejectedRequest("/api/v4/account")).rejects.toThrow(
      "amoCRM request rejected",
    );
    expect(rejected.read).not.toHaveBeenCalled();
    expect(rejected.cancel).toHaveBeenCalledTimes(1);
  });

  it("fails a complete scan on malformed pages, duplicate rows, or loops", async () => {
    const pages = [
      {
        _embedded: { contacts: [{ id: 1 }] },
        _links: { next: { href: "sensitive-next-url" } },
      },
      {
        _embedded: { contacts: [{ id: 1 }] },
        _links: {},
      },
    ];
    await expect(
      inspector.paginate({
        request: async () => pages.shift(),
        pathname: "/api/v4/contacts",
        baseQuery: {},
        collection: "contacts",
        maxPages: 3,
        itemKey: (item: any) => item.id,
        onItem: async () => undefined,
      }),
    ).rejects.toThrow("amoCRM pagination loop detected");

    await expect(
      inspector.paginate({
        request: async () => ({ _embedded: {}, _links: {} }),
        pathname: "/api/v4/contacts",
        baseQuery: {},
        collection: "contacts",
        maxPages: 1,
        itemKey: (item: any) => item.id,
        onItem: async () => undefined,
      }),
    ).rejects.toThrow("Malformed amoCRM page");

    await expect(
      inspector.paginate({
        request: async () => ({
          _embedded: {
            contacts: Array.from({ length: 251 }, (_, index) => ({
              id: index + 1,
            })),
          },
          _links: {},
        }),
        pathname: "/api/v4/contacts",
        baseQuery: {},
        collection: "contacts",
        maxPages: 1,
        itemKey: (item: any) => item.id,
        onItem: async () => undefined,
      }),
    ).rejects.toThrow("amoCRM page exceeded item safety bound");

    await expect(
      inspector.paginate({
        request: async () => ({
          _embedded: { contacts: [] },
          _links: { next: "sensitive-next-url" },
        }),
        pathname: "/api/v4/contacts",
        baseQuery: {},
        collection: "contacts",
        maxPages: 1,
        itemKey: (item: any) => item.id,
        onItem: async () => undefined,
      }),
    ).rejects.toThrow("Malformed amoCRM page");
  });

  it("uses strict field parsing and excludes pre-deal sales stages", async () => {
    expect(inspector.normalizePhone("8 (999) 123-45-67")).toBe("+79991234567");
    expect(inspector.normalizePhone("77123456789")).toBeNull();
    expect(inspector.normalizePhone("1 (999) 123-45-67")).toBeNull();
    expect(inspector.normalizePhone("123456789012")).toBeNull();
    expect(inspector.normalizePhone("+7 999 123-45-67 доб. 123")).toBeNull();
    expect(inspector.parseMoneyToCents("1 234 567,89 ₽")).toBe(123456789n);
    expect(inspector.parseMoneyToCents("1e9")).toBeNull();
    expect(inspector.validDateValue("2026-02-29")).toBe(false);
    expect(inspector.validDateValue("2028-02-29")).toBe(true);

    const state = inspector.createState();
    inspector.ingestContact(state, {
      id: 91001,
      custom_fields_values: [field(835415, true)],
      _embedded: { companies: [] },
    });
    const baseLead = {
      pipeline_id: 7600546,
      custom_fields_values: [field(665195, "Да", 985337)],
      _embedded: { contacts: [{ id: 92001, is_main: true }, { id: 91001 }] },
    };
    inspector.ingestLead(state, "sales_a", {
      ...baseLead,
      id: 93001,
      status_id: 62907370,
    });
    inspector.ingestLead(state, "sales_a", {
      ...baseLead,
      id: 93002,
      status_id: 62907374,
    });
    inspector.ingestLead(state, "sales_a", {
      ...baseLead,
      id: 93003,
      status_id: 62907378,
    });
    inspector.ingestLead(state, "sales_a", {
      ...baseLead,
      id: 93004,
      status_id: 64421962,
    });
    inspector.ingestLead(state, "sales_a", {
      ...baseLead,
      id: 93005,
      status_id: 62907142,
    });
    const report = await inspector.finalizeReport(
      state,
      new Date("2026-08-25T20:00:00.000Z"),
    );
    expect(report.clientPipelines.all.strictSourceAndBrokerLinked).toBe(5);
    expect(report.deals.rawQualifyingLeadRows).toBe(1);
    expect(report.deals.deduplicatedDealGroups).toBe(1);
    expect(report.meetings.currentMeetingHeldStageProxy).toMatchObject({
      total: 3,
      byPipeline: { sales_a: 3 },
    });
  });

  it("uses embedded main-client relations for dedup only with matching deal evidence", async () => {
    const base = {
      parentReferenceIds: [],
      brokerCopyReferenceIds: [],
      contractDateValues: ["2026-08-20"],
      dedupClientContactIds: [95001],
    };
    const report = await inspector.buildDealReport([
      { ...base, id: 94001, dduAmountValues: ["1000000"] },
      { ...base, id: 94002, dduAmountValues: ["1 000 000,00"] },
      { ...base, id: 94003, dduAmountValues: ["2000000"] },
    ]);
    expect(report.rawQualifyingLeadRows).toBe(3);
    expect(report.deduplicatedDealGroups).toBe(2);
    expect(report.duplicateLeadRowsCollapsed).toBe(1);
    expect(report.dedupEvidenceCoverage).toMatchObject({
      candidatesWithEmbeddedClientContactRelation: 3,
      candidatesWithCorroboratedClientDealKey: 3,
      candidatesWithUncorroboratedClientRelationOnly: 0,
    });
    expect(report.dedupMethod.uncorroboratedSharedContactMerged).toBe(false);
  });

  it("counts 2026 contract dates without emitting a deal date", async () => {
    const empty = {
      parentReferenceIds: [],
      brokerCopyReferenceIds: [],
      dedupClientContactIds: [],
    };
    const report = await inspector.buildDealReport([
      {
        ...empty,
        id: 96001,
        contractDateValues: ["2025-12-31"],
        dduAmountValues: ["1000000"],
      },
      {
        ...empty,
        id: 96002,
        contractDateValues: ["2026-01-01"],
        dduAmountValues: ["2500000"],
      },
      {
        ...empty,
        id: 96003,
        contractDateValues: ["2026-08-20"],
        dduAmountValues: ["3000000"],
      },
    ]);
    expect(report.from2026).toEqual({
      contractDateOnOrAfter: "2026-01-01",
      groups: 2,
      withValidDduAmount: 2,
      unambiguousSumRub: "5500000.00",
    });
    expect(report.contractDateByYear).toEqual({
      "2025": {
        groups: 1,
        withValidDduAmount: 1,
        unambiguousSumRub: "1000000.00",
      },
      "2026": {
        groups: 2,
        withValidDduAmount: 2,
        unambiguousSumRub: "5500000.00",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("2025-12-31");
    expect(serialized).not.toContain("2026-08-20");
  });

  it("computes contact, lead, meeting and deduplicated deal aggregates without PII", async () => {
    const state = inspector.createState();
    const brokerOne = 10001;
    const brokerTwo = 10002;
    const clientContact = 10003;

    inspector.ingestContact(state, {
      id: brokerOne,
      name: "Sensitive Broker One",
      custom_fields_values: [
        field(835415, true),
        field(557903, "+7 (999) 123-45-67"),
        field(835417, "Sensitive Agency"),
        field(842303, true),
        field(842305, 1_787_616_000),
      ],
      _embedded: { companies: [{ id: 50001 }] },
    });
    inspector.ingestContact(state, {
      id: brokerTwo,
      name: "Sensitive Broker Two",
      custom_fields_values: [
        field(835415, true),
        field(557903, "123"),
        field(842303, true),
        field(842305, "not-a-date"),
      ],
      _embedded: { companies: [{ id: 50001 }] },
    });
    inspector.ingestContact(state, {
      id: clientContact,
      name: "Sensitive Client",
      custom_fields_values: [field(557903, "+7 900 000-00-00")],
      _embedded: { companies: [] },
    });

    inspector.ingestLead(state, "brokers", {
      id: 15001,
      pipeline_id: 10787390,
      status_id: 84932446,
    });
    inspector.ingestLead(state, "brokers", {
      id: 15002,
      pipeline_id: 10787390,
      status_id: 12345678,
    });

    const strictEnum = field(665195, "Да", 985337);
    const strictText = field(618551, "Заявка от брокера");
    const contacts = (clientId: number, brokerId?: number) => ({
      contacts: [{ id: clientId }, ...(brokerId ? [{ id: brokerId }] : [])],
    });
    inspector.ingestLead(state, "call_center", {
      id: 20001,
      pipeline_id: 7600542,
      status_id: 142,
      custom_fields_values: [strictEnum, field(839185, 1_787_616_000)],
      _embedded: contacts(11001, brokerOne),
    });
    inspector.ingestLead(state, "sales_a", {
      id: 20002,
      pipeline_id: 7600546,
      status_id: 62907378,
      custom_fields_values: [
        strictText,
        field(833065, "1 000 000,00 ₽"),
        field(558353, "2026-08-20"),
        field(839249, "parent 30001"),
        field(842387, "https://sensitive.invalid/leads/detail/40001"),
      ],
      _embedded: contacts(11002, brokerOne),
    });
    inspector.ingestLead(state, "sales_b", {
      id: 20003,
      pipeline_id: 7600550,
      status_id: 62907454,
      custom_fields_values: [
        strictEnum,
        field(833065, "1100000"),
        field(839185, "invalid meeting date"),
        field(839249, "30001"),
      ],
      _embedded: contacts(11002, brokerTwo),
    });
    inspector.ingestLead(state, "sales_c", {
      id: 20004,
      pipeline_id: 7600554,
      status_id: 62907594,
      custom_fields_values: [
        strictText,
        field(833065, "500000"),
        field(558353, "invalid contract date"),
      ],
      _embedded: contacts(11003, brokerTwo),
    });
    inspector.ingestLead(state, "sales_c", {
      id: 20005,
      pipeline_id: 7600554,
      status_id: 62907166,
      custom_fields_values: [],
      _embedded: contacts(11004, brokerOne),
    });
    inspector.ingestLead(state, "sales_c", {
      id: 20006,
      pipeline_id: 7600554,
      status_id: 62907166,
      custom_fields_values: [strictText],
      _embedded: contacts(11005),
    });

    const report = await inspector.finalizeReport(
      state,
      new Date("2026-08-25T20:00:00.000Z"),
    );

    expect(report.contacts).toEqual({
      total: 3,
      brokersMarked: 2,
      phoneCoverage: {
        brokersWithAtLeastOneValidNormalizedPhone: 1,
        brokersWithoutValidNormalizedPhone: 1,
        validNormalizedPhoneValues: 1,
        uniqueNormalizedPhones: 1,
      },
      brokerTour: {
        markedVisited: 2,
        markedVisitedWithValidDate: 1,
        markedVisitedWithoutValidDate: 1,
      },
      agencyNameCoverage: { present: 1, missing: 1 },
      linkedCompanies: {
        embeddedRelationPayloadComplete: true,
        brokersWithRelationPayload: 2,
        brokersWithLinkedCompany: 2,
        uniqueLinkedCompanies: 1,
        observedUniqueLinkedCompanies: 1,
      },
    });
    expect(report.brokerPipeline).toMatchObject({
      totalCurrentLeads: 2,
      currentStage: { new_broker: 1, other_current_stage: 1 },
    });
    expect(report.clientPipelines.all).toEqual({
      totalCurrentLeads: 6,
      strictSourceMarked: 5,
      brokerLinkedBroadProxy: 5,
      strictSourceAndBrokerLinked: 4,
      strictSourceWithoutBrokerLink: 1,
      brokerLinkedWithoutStrictSource: 1,
      uniqueStrictLinkedBrokers: 2,
      uniqueBroadLinkedBrokers: 2,
    });
    expect(report.meetings).toMatchObject({
      qualifyingCurrentLeadRows: 4,
      explicitMeetingDateCoverage: { valid: 1, missing: 2, invalid: 1 },
      currentMeetingHeldStageProxy: {
        total: 4,
        byPipeline: {
          call_center: 1,
          sales_a: 1,
          sales_b: 1,
          sales_c: 1,
        },
      },
    });
    expect(report.deals).toMatchObject({
      rawQualifyingLeadRows: 3,
      deduplicatedDealGroups: 2,
      duplicateLeadRowsCollapsed: 1,
      dedupEvidenceCoverage: {
        candidatesWithParentReference: 2,
        candidatesWithBrokerCopyReference: 1,
        candidatesWithEmbeddedClientContactRelation: 3,
        candidatesWithFetchedDedupEntityRelation: 0,
        entityRelationRowsScanned: 0,
      },
      dduAmount: {
        rawQualifyingLeadCoverage: { valid: 3, missing: 0, invalid: 0 },
        coverageByDeduplicatedGroup: {
          valid: 1,
          missing: 0,
          invalid: 0,
          conflicting: 1,
        },
        summedUnambiguousGroups: 1,
        unambiguousSumRub: "500000.00",
        conflictingGroupsExcludedFromSum: 1,
      },
      contractDate: {
        rawQualifyingLeadCoverage: { valid: 1, missing: 1, invalid: 1 },
        coverageByDeduplicatedGroup: {
          valid: 1,
          missing: 0,
          invalid: 1,
        },
      },
    });
    expect(report.calls).toEqual({
      measured: false,
      status: "unavailable",
      reason: "no_call_activity_source_scanned",
    });

    const serialized = JSON.stringify(report);
    for (const sensitive of [
      "Sensitive Broker One",
      "Sensitive Broker Two",
      "Sensitive Client",
      "Sensitive Agency",
      "+7 (999) 123-45-67",
      "+7 900 000-00-00",
      "https://sensitive.invalid/leads/detail/40001",
      "10001",
      "10002",
      "20001",
      "20002",
      "30001",
      "40001",
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(serialized).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    expect(report.safety).toMatchObject({
      source: "live_amocrm_api",
      httpMethods: ["GET"],
      brokerPlatformDatabaseUsed: false,
      rawEntityIdentifiersEmitted: false,
      perRecordRowsEmitted: false,
    });
  });

  it("uses pinned exact-SHA streaming and validates runner and remote bash", () => {
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

    const remoteMarker = "cat <<'REMOTE_PREFIX'\n";
    const remoteStart =
      workflowShell.indexOf(remoteMarker) + remoteMarker.length;
    const remoteEnd = workflowShell.indexOf("\nREMOTE_PREFIX", remoteStart);
    expect(remoteStart).toBeGreaterThan(remoteMarker.length);
    expect(remoteEnd).toBeGreaterThan(remoteStart);
    const generatedRemoteShell = `${workflowShell.slice(
      remoteStart,
      remoteEnd,
    )}\nY29uc29sZS5sb2coInNhZmUiKTs=\nPII_SAFE_LIVE_AMO_PAYLOAD\n`;
    const remoteSyntax = spawnSync(bash, ["-n"], {
      input: generatedRemoteShell,
      encoding: "utf8",
    });
    expect(remoteSyntax.stderr).toBe("");
    expect(remoteSyntax.status).toBe(0);

    expect(workflow).toContain("workflow_dispatch: {}");
    expect(workflow).toContain("group: production-deploy");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain(
      "CANONICAL_REPOSITORY: sereganikitin/st-michael-broker-platform",
    );
    expect(workflow).toContain(
      "HEALTH_URL: https://broker.stmichael.ru/api/health",
    );
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    );
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('test "$EXPECTED_REF" = "refs/heads/master"');
    expect(workflow).toContain(
      'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
    );
    expect(workflow).toContain("runner_tmp=${RUNNER_TEMP:-/tmp}");
    expect(workflow).toContain(
      'ssh_root=$(mktemp -d "$runner_tmp/st-michael-live-amo-report.XXXXXX")',
    );
    expect(workflow).not.toContain("ssh_root=$(mktemp -d)\n");
    expect(workflow).toContain(
      '"/repos/$EXPECTED_REPOSITORY/compare/$deployed_sha...$EXPECTED_SHA"',
    );
    expect(workflow).toContain("ahead|identical) ;;");
    expect(workflow).toContain(
      'test "$production_sha" = "$expected_deployed_sha"',
    );
    expect(workflow).toContain('test "$container_sha" = "$production_sha"');
    expect(workflow).toContain("exec 9</tmp/st-michael-production-deploy.lock");
    expect(workflow).toContain("flock -s -n 9");
    expect(workflow).toContain(
      "base64 -d <<'PII_SAFE_LIVE_AMO_PAYLOAD' | docker exec -i st-michael-api",
    );
    expect(workflow).toContain(
      "inspector=$(mktemp /app/scripts/.inspect-live-amo-source.XXXXXX)",
    );
    expect(workflow).not.toMatch(/mktemp[^\n]*\.XXXXXX\.[A-Za-z0-9]+/);
    expect(workflow).toContain(
      'test "$actual_script_sha" = "$expected_script_sha"',
    );
    expect(workflow).toContain('test -n "${AMO_ACCESS_TOKEN:-}"');
    expect(workflow).toContain("trap cleanup EXIT HUP INT TERM");
    expect(workflow.match(/\bssh -T\b/g) || []).toHaveLength(1);
    expect(workflow).not.toMatch(
      /appleboy\/ssh-action|git fetch|git reset|git checkout|git show|docker cp|docker compose up|docker restart/,
    );
    expect(workflow).not.toMatch(/AMO_ACCESS_TOKEN:\s*\$\{\{/);
    expect(workflow).not.toMatch(
      /echo[^\n]*(?:GH_TOKEN|health_body|AMO_ACCESS_TOKEN)|set\s+-[^\n]*x/,
    );
  });
});
