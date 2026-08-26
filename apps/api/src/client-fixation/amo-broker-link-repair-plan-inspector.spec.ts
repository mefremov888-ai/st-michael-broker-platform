import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";

describe("PII-safe amo broker-link repair-plan inspector", () => {
  const repositoryRoot = resolve(__dirname, "../../../..");
  const scriptPath = resolve(
    repositoryRoot,
    "scripts/inspect-amo-broker-link-repair-plan.js",
  );
  const workflowPath = resolve(
    repositoryRoot,
    ".github/workflows/inspect-production-amo-broker-link-repair-plan.yml",
  );
  const script = readFileSync(scriptPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");
  const NodeModule = jest.requireActual("module") as any;
  const loadedScript = new NodeModule(scriptPath, module);
  loadedScript.filename = scriptPath;
  loadedScript.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
  loadedScript._compile(script, scriptPath);
  const inspector = loadedScript.exports as {
    BROKER_OWNER_SELECT: Record<string, any>;
    BROKER_PROVISION_SELECT: Record<string, any>;
    OWNERSHIP_QUEUE_ROW_SELECT: Record<string, any>;
    PROVISIONING_QUEUE_ROW_SELECT: Record<string, any>;
    EXPECTED_ACCOUNT_ID: number;
    MAX_RESPONSE_BYTES: number;
    STATEMENT_TIMEOUT_MS: number;
    assertExpectedAccount: (request: any) => Promise<void>;
    assertReadOnlySession: (prisma: any) => Promise<void>;
    buildReadOnlyDatabaseUrl: (value: string) => string;
    buildProvisioningReport: (
      queueRows: any[],
      brokers: any[],
      lookups: Map<string, any>,
      generatedAt?: Date,
      hashKey?: Buffer,
    ) => any;
    buildReport: (
      queueRows: any[],
      brokers: any[],
      lookups: Map<string, any>,
      generatedAt?: Date,
      hashKey?: Buffer,
    ) => any;
    canonicalAmoUrl: (path: string, query?: Record<string, unknown>) => URL;
    createGetOnlyRequester: (token: string, fetchImpl?: any) => any;
    lookupExactBrokerContacts: (
      request: any,
      phone: string,
      maxPages?: number,
    ) => Promise<any>;
    normalizePhone: (value: unknown) => string | null;
    readJsonBounded: (
      response: any,
      maxBytes?: number,
      controller?: any,
    ) => Promise<any>;
    reportHash: (
      kind: string,
      value: unknown,
      hashKey: Buffer,
    ) => string | null;
    requiredLookupPhones: (rows: any[], brokers: any[]) => string[];
  };

  const broker = (overrides: Record<string, unknown> = {}) => ({
    id: "broker-default",
    amoContactId: null,
    phone: "+79990000001",
    mergedIntoId: null,
    phones: [],
    ...overrides,
  });
  const row = (id: string, effective: any | null, overrides: any = {}) => ({
    id,
    amoLeadId: null,
    fixationAgencyId: "agency-internal-id",
    amoSyncStatus: "FAILED",
    amoSyncAttempts: 10,
    amoSyncError: "BROKER_AMO_CONTACT_MISSING",
    broker: effective,
    responsibleBroker: null,
    ...overrides,
  });

  it("allows only guarded SELECTs and GET-only amoCRM access", () => {
    expect(script).toContain("prisma.client.findMany({");
    expect(script).toContain("prisma.broker.findMany({");
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
    expect(script.match(/prisma\.broker\.findMany\s*\(/g) || []).toHaveLength(
      1,
    );
    expect(script.match(/new PrismaClient\s*\(/g) || []).toHaveLength(1);
    expect(script).toContain(
      "datasources: { db: { url: readOnlyDatabaseUrl } }",
    );
    expect(script.match(/process\.stdout\.write\s*\(/g) || []).toHaveLength(1);
    expect(script.match(/process\.stderr\.write\s*\(/g) || []).toHaveLength(1);
    expect(script).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(script).toContain('createHmac("sha256", hashKey)');
    expect(script).toContain("hashKey = randomBytes(32)");
    expect(script).toContain("databaseMutationAuthorized: false");
    expect(script).toContain("amoMutationAuthorized: false");
    expect(script).toContain("retryAuthorized: false");
  });

  it("uses a PII-minimal Prisma select by default and a full mutation-source select only for provisioning attestation without emitting raw PII", () => {
    expect(inspector.BROKER_OWNER_SELECT).toEqual({
      id: true,
      amoContactId: true,
      phone: true,
      mergedIntoId: true,
      phones: {
        select: { phone: true },
        orderBy: { phone: "asc" },
      },
    });
    expect(inspector.BROKER_OWNER_SELECT).not.toHaveProperty("fullName");
    expect(inspector.BROKER_OWNER_SELECT).not.toHaveProperty("email");
    expect(inspector.BROKER_OWNER_SELECT).not.toHaveProperty("brokerAgencies");
    expect(inspector.OWNERSHIP_QUEUE_ROW_SELECT).toMatchObject({
      broker: { select: inspector.BROKER_OWNER_SELECT },
      responsibleBroker: { select: inspector.BROKER_OWNER_SELECT },
    });
    expect(inspector.PROVISIONING_QUEUE_ROW_SELECT).toMatchObject({
      broker: { select: inspector.BROKER_PROVISION_SELECT },
      responsibleBroker: { select: inspector.BROKER_PROVISION_SELECT },
    });
    expect(inspector.BROKER_PROVISION_SELECT).toMatchObject({
      fullName: true,
      email: true,
      region: true,
      presentationSent: true,
      doNotCall: true,
      brokerAgencies: {
        where: { isPrimary: true },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        take: 2,
      },
    });
    expect(script).toContain(
      "select: provisioningMode\n        ? PROVISIONING_QUEUE_ROW_SELECT\n        : OWNERSHIP_QUEUE_ROW_SELECT",
    );
    const provisioningReportSource = script.slice(
      script.indexOf("function buildProvisioningReport("),
      script.indexOf("async function main()"),
    );
    expect(provisioningReportSource).not.toMatch(
      /broker\.(?:fullName|email|region|position|telegramUsername|telegramId|whatsappUsername|presentationSent|doNotCall|brokerAgencies)/,
    );

    const rawPii = {
      fullName: "Private Broker 9a81c6",
      email: "private-9a81c6@example.test",
      region: "Private Region 9a81c6",
      agencyName: "Private Agency 9a81c6",
      agencyInn: "7700123456",
      agencyAddress: "Private address 9a81c6",
      syncError: "private-9a81c6@example.test +79991112233",
    };
    const effective = broker({
      id: "broker-private-9a81c6",
      phone: "+79991112233",
      ...rawPii,
      brokerAgencies: [
        {
          id: "membership-private-9a81c6",
          agencyId: "agency-private-9a81c6",
          isPrimary: true,
          joinedAt: new Date("2026-08-26T00:00:00.000Z"),
          agency: {
            id: "agency-private-9a81c6",
            name: rawPii.agencyName,
            inn: rawPii.agencyInn,
            address: rawPii.agencyAddress,
          },
        },
      ],
    });
    const queueRows = [
      row("queue-private-9a81c6", effective, {
        amoSyncError: rawPii.syncError,
      }),
    ];
    const generatedAt = new Date("2026-08-26T00:00:00.000Z");
    const reportKey = Buffer.alloc(32, 0x51);
    const defaultJson = JSON.stringify(
      inspector.buildReport(
        queueRows,
        [effective],
        new Map([
          ["+79991112233", { contactIds: [], pagesRead: 1, contactsRead: 0 }],
        ]),
        generatedAt,
        reportKey,
      ),
    );
    const provisioningJson = JSON.stringify(
      inspector.buildProvisioningReport(
        queueRows,
        [effective],
        new Map([
          ["+79991112233", { contacts: [], pagesRead: 1, contactsRead: 0 }],
        ]),
        generatedAt,
        reportKey,
      ),
    );
    for (const output of [defaultJson, provisioningJson]) {
      for (const privateValue of Object.values(rawPii)) {
        expect(output).not.toContain(String(privateValue));
      }
      expect(output).not.toContain("+79991112233");
      expect(output).not.toContain("broker-private-9a81c6");
      expect(output).not.toContain("agency-private-9a81c6");
    }
  });

  it("preserves datasource options while enforcing PostgreSQL read-only mode", async () => {
    const rawDatabaseUrl =
      "postgresql://audit-user:s3cr%40t-value@db.internal:5432/broker_platform" +
      "?schema=loyalty&connection_limit=3" +
      "&options=-c%20search_path%3Dpublic" +
      "&options=-c%20lock_timeout%3D1s" +
      "&application_name=broker-link-inspector";
    const parsed = new URL(inspector.buildReadOnlyDatabaseUrl(rawDatabaseUrl));

    expect(parsed.protocol).toBe("postgresql:");
    expect(parsed.username).toBe("audit-user");
    expect(parsed.password).toBe("s3cr%40t-value");
    expect(parsed.searchParams.get("schema")).toBe("loyalty");
    expect(parsed.searchParams.get("connection_limit")).toBe("3");
    expect(parsed.searchParams.get("application_name")).toBe(
      "broker-link-inspector",
    );
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
    expect(exactSelect).toHaveBeenCalledTimes(1);
    await expect(
      inspector.assertReadOnlySession({
        $queryRaw: async () => [{ mode: "off" }],
      }),
    ).rejects.toThrow("Database session is not read-only");

    const invalidWithSecret = "not-a-url-with-db-password-secret";
    try {
      inspector.buildReadOnlyDatabaseUrl(invalidWithSecret);
      throw new Error("expected invalid URL to fail");
    } catch (error) {
      expect(String(error)).not.toContain("db-password-secret");
    }
  });

  it("uses a canonical GET-only amoCRM requester and checks the exact account", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ id: inspector.EXPECTED_ACCOUNT_ID }),
    });
    const request = inspector.createGetOnlyRequester(
      "private-access-token",
      fetchImpl,
    );

    await expect(
      inspector.assertExpectedAccount(request),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://stmichael.amocrm.ru/api/v4/account");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init.headers.Authorization).toBe("Bearer private-access-token");

    expect(() => inspector.canonicalAmoUrl("/api/v4/leads")).toThrow(
      "Unsafe amoCRM path",
    );
    expect(() =>
      inspector.canonicalAmoUrl("/api/v4/contacts", { unsafe: "value" }),
    ).toThrow("Unsafe amoCRM query");
    expect(() =>
      inspector.canonicalAmoUrl("/api/v4/contacts", {
        query: "79990000001",
        limit: 250,
        page: 1,
      }),
    ).toThrow("Unsafe amoCRM query");
    expect(() =>
      inspector.canonicalAmoUrl("/api/v4/contacts", {
        query: "9990000001",
        limit: 50,
        page: 1,
      }),
    ).toThrow("Unsafe amoCRM query");
    expect(() =>
      inspector.canonicalAmoUrl("/api/v4/contacts", {
        query: "9990000001",
        limit: 250,
        page: 51,
      }),
    ).toThrow("Unsafe amoCRM query");
    await expect(
      inspector.assertExpectedAccount(async () => ({ id: 1 })),
    ).rejects.toThrow("Unexpected amoCRM account");
  });

  it("bounds response bytes before JSON parsing for headers and streams", async () => {
    const tooLargeHeader = {
      headers: {
        get: (name: string) =>
          name === "content-length"
            ? String(inspector.MAX_RESPONSE_BYTES + 1)
            : null,
      },
      text: jest.fn(async () => "{}"),
    };
    await expect(inspector.readJsonBounded(tooLargeHeader)).rejects.toThrow(
      "amoCRM response exceeded size limit",
    );
    expect(tooLargeHeader.text).not.toHaveBeenCalled();

    const invalidHeader = {
      headers: { get: () => "not-a-number" },
      text: jest.fn(async () => "{}"),
    };
    await expect(inspector.readJsonBounded(invalidHeader)).rejects.toThrow(
      "amoCRM response size is invalid",
    );
    expect(invalidHeader.text).not.toHaveBeenCalled();

    const chunks = [Buffer.from('{"safe":'), Buffer.from("true}")];
    const reader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: chunks[0] })
        .mockResolvedValueOnce({ done: false, value: chunks[1] })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: jest.fn(),
    };
    await expect(
      inspector.readJsonBounded({
        headers: { get: () => null },
        body: { getReader: () => reader },
      }),
    ).resolves.toEqual({ safe: true });

    const oversizedReader = {
      read: jest.fn().mockResolvedValueOnce({
        done: false,
        value: Buffer.alloc(9, 0x61),
      }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    const controller = { abort: jest.fn() };
    await expect(
      inspector.readJsonBounded(
        {
          headers: { get: () => null },
          body: { getReader: () => oversizedReader },
        },
        8,
        controller,
      ),
    ).rejects.toThrow("amoCRM response exceeded size limit");
    expect(controller.abort).toHaveBeenCalledTimes(1);
    expect(oversizedReader.cancel).toHaveBeenCalledTimes(1);
  });

  it("normalizes Russian phones and exhaustively post-filters broker contacts", async () => {
    expect(inspector.normalizePhone("8 (999) 000-00-01")).toBe("+79990000001");
    expect(inspector.normalizePhone("9990000001")).toBe("+79990000001");
    expect(inspector.normalizePhone("+77 999 000 00 01")).toBe("+79990000001");
    expect(inspector.normalizePhone("+77 999 000 00 1")).toBeNull();
    expect(inspector.normalizePhone("not-a-phone")).toBeNull();

    const contact = (id: number, phone: string, isBroker: boolean) => ({
      id,
      custom_fields_values: [
        { field_id: 557903, values: [{ value: phone }] },
        { field_id: 835415, values: [{ value: isBroker }] },
      ],
    });
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        _embedded: {
          contacts: [
            contact(10, "+7 (999) 000-00-01", true),
            contact(11, "+7 (999) 000-00-01", false),
          ],
        },
        _links: { next: { href: "redacted" } },
      })
      .mockResolvedValueOnce({
        _embedded: { contacts: [contact(12, "+7 (999) 000-00-02", true)] },
        _links: {},
      });

    await expect(
      inspector.lookupExactBrokerContacts(request, "+79990000001"),
    ).resolves.toEqual({
      contactIds: [10],
      pagesRead: 2,
      contactsRead: 3,
    });
    expect(request).toHaveBeenNthCalledWith(1, "/api/v4/contacts", {
      query: "9990000001",
      limit: 250,
      page: 1,
    });
    expect(request).toHaveBeenNthCalledWith(2, "/api/v4/contacts", {
      query: "9990000001",
      limit: 250,
      page: 2,
    });

    const duplicatePage = jest.fn().mockResolvedValue({
      _embedded: { contacts: [contact(10, "+79990000001", true)] },
      _links: { next: { href: "redacted" } },
    });
    await expect(
      inspector.lookupExactBrokerContacts(duplicatePage, "+79990000001", 2),
    ).rejects.toThrow("amoCRM contacts pagination loop detected");

    let nextId = 100;
    const unbounded = jest.fn(async () => ({
      _embedded: {
        contacts: [contact(nextId++, "+79990000001", true)],
      },
      _links: { next: { href: "redacted" } },
    }));
    await expect(
      inspector.lookupExactBrokerContacts(unbounded, "+79990000001", 2),
    ).rejects.toThrow("amoCRM contacts pagination exceeded safety bound");
  });

  it("emits a non-executable HMAC-only link candidate without PII", () => {
    const brokerId = "2a5c157f-7ab7-4c76-a977-1b64da60f034";
    const queueA = "3fc34e89-8a22-4630-81d4-b3a87653d2cb";
    const queueB = "3e96cddd-1f94-43e3-88a8-72d7c76b0e68";
    const phone = "+7 (999) 000-00-01";
    const candidateId = 998877665544;
    const effective = broker({
      id: brokerId,
      phone,
      phones: [{ phone: "8 999 000-00-01" }],
    });
    const rawError =
      "Responsible broker contact missing for private@example.test";
    const queueRows = [
      row(queueA, effective, { amoSyncError: rawError }),
      row(queueB, effective, { fixationAgencyId: null }),
    ];
    const allBrokers = [effective];
    const lookups = new Map([
      [
        "+79990000001",
        { contactIds: [candidateId], pagesRead: 1, contactsRead: 1 },
      ],
    ]);
    const reportKey = Buffer.alloc(32, 0x42);
    const report = inspector.buildReport(
      queueRows,
      allBrokers,
      lookups,
      new Date("2026-08-25T21:00:00.000Z"),
      reportKey,
    );
    const serialized = JSON.stringify(report);

    expect(report.aggregates).toMatchObject({
      exhaustedQueueRows: 2,
      effectiveBrokerGroups: 1,
      resolutionByBroker: { link_candidate: 1 },
      resolutionByQueueRow: { link_candidate: 2 },
      fixationAgency: { present: 1, absent: 1 },
    });
    expect(report.records).toHaveLength(1);
    expect(report.records[0]).toMatchObject({
      queueCount: 2,
      resolution: "link_candidate",
      searchedPhoneCount: 1,
      exactPhoneMatchCount: 1,
      amoCandidateCount: 1,
      advisory: {
        brokerLinkCandidate: true,
        databaseMutationAuthorized: false,
        amoMutationAuthorized: false,
        retryAuthorized: false,
      },
    });
    expect(report.records[0].brokerHash).toMatch(/^broker_[0-9a-f]{24}$/);
    expect(report.records[0].candidateContactHash).toMatch(
      /^contact_[0-9a-f]{24}$/,
    );
    expect(report.records[0].queueHashes).toHaveLength(2);
    expect(report.plan).toMatchObject({
      advisoryOnly: true,
      executablePayload: false,
      retryAuthorized: false,
    });
    expect(inspector.reportHash("broker", brokerId, reportKey)).toBe(
      inspector.reportHash("broker", brokerId, reportKey),
    );
    expect(inspector.reportHash("broker", brokerId, reportKey)).not.toBe(
      inspector.reportHash("broker", brokerId, Buffer.alloc(32, 0x43)),
    );
    const nextRun = inspector.buildReport(
      queueRows,
      allBrokers,
      lookups,
      new Date("2026-08-25T21:00:00.000Z"),
      Buffer.alloc(32, 0x43),
    );
    expect(nextRun.records[0].brokerHash).not.toBe(
      report.records[0].brokerHash,
    );

    for (const secret of [
      brokerId,
      queueA,
      queueB,
      phone,
      "79990000001",
      String(candidateId),
      rawError,
      "private@example.test",
      reportKey.toString("hex"),
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  });

  it("fails closed on database, amo and ownership collisions", () => {
    const already = broker({
      id: "already",
      phone: "+79990000010",
      amoContactId: BigInt(500),
    });
    const merged = broker({
      id: "merged",
      phone: "+79990000011",
      mergedIntoId: "canonical-internal-id",
    });
    const invalid = broker({ id: "invalid", phone: "not-a-phone" });
    const collision = broker({ id: "collision", phone: "+79990000012" });
    const collisionOther = broker({
      id: "collision-other",
      phone: "8 (999) 000-00-12",
    });
    const noMatch = broker({ id: "no-match", phone: "+79990000013" });
    const ambiguous = broker({ id: "ambiguous", phone: "+79990000014" });
    const occupied = broker({ id: "occupied", phone: "+79990000015" });
    const contactOwner = broker({
      id: "contact-owner",
      phone: "+79990000016",
      amoContactId: BigInt(777),
    });
    const rows = [
      row("q-missing", null),
      row("q-already", already),
      row("q-merged", merged),
      row("q-invalid", invalid),
      row("q-collision", collision),
      row("q-no-match", noMatch),
      row("q-ambiguous", ambiguous),
      row("q-occupied", occupied),
    ];
    const brokers = [
      already,
      merged,
      invalid,
      collision,
      collisionOther,
      noMatch,
      ambiguous,
      occupied,
      contactOwner,
    ];
    const lookups = new Map([
      ["+79990000013", { contactIds: [], pagesRead: 1, contactsRead: 0 }],
      [
        "+79990000014",
        { contactIds: [700, 701], pagesRead: 1, contactsRead: 2 },
      ],
      ["+79990000015", { contactIds: [777], pagesRead: 1, contactsRead: 1 }],
    ]);
    const report = inspector.buildReport(
      rows,
      brokers,
      lookups,
      new Date("2026-08-25T21:00:00.000Z"),
      Buffer.alloc(32, 0x44),
    );
    const resolutions = report.records.map((record: any) => record.resolution);

    expect(resolutions).toEqual(
      expect.arrayContaining([
        "effective_broker_missing",
        "already_linked",
        "broker_merged",
        "no_valid_phone",
        "db_phone_ambiguous",
        "no_exact_broker_contact",
        "ambiguous_amo_match",
        "candidate_already_bound",
      ]),
    );
    expect(resolutions).not.toContain("link_candidate");
    expect(inspector.requiredLookupPhones(rows, brokers)).toEqual([
      "+79990000013",
      "+79990000014",
      "+79990000015",
    ]);
    for (const record of report.records) {
      expect(record.advisory.retryAuthorized).toBe(false);
      expect(record.candidateContactHash).toBeNull();
    }
  });

  it("streams exact-SHA source into a pinned, lock-held production session", () => {
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
    )}\nY29uc29sZS5sb2coInNhZmUiKTs=\nPII_SAFE_BROKER_LINK_PLAN_PAYLOAD\n`;
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
    expect(workflow).toContain(
      "health_body=$(curl --fail --silent --show-error --max-time 15",
    );
    expect(workflow).toContain(
      '"/repos/$EXPECTED_REPOSITORY/compare/$deployed_sha...$EXPECTED_SHA"',
    );
    expect(workflow).toContain("ahead|identical) ;;");
    expect(workflow).toContain("unset health_body");
    expect(workflow).toContain("unset compare_status GH_TOKEN");
    expect(workflow).toContain("runner_temp=${RUNNER_TEMP:-/tmp}");
    expect(workflow).toContain(
      'mktemp -d "$runner_temp/st-michael-amo-broker-link-plan.XXXXXX"',
    );
    expect(workflow).toContain("expected_deployed_sha=$3");
    expect(workflow).toContain(
      'test "$production_sha" = "$expected_deployed_sha"',
    );
    expect(workflow).toContain('test "$container_sha" = "$production_sha"');
    expect(workflow).toContain(
      "base64 -d <<'PII_SAFE_BROKER_LINK_PLAN_PAYLOAD' | docker exec -i st-michael-api",
    );
    expect(workflow).toContain(
      'test "$actual_script_sha" = "$expected_script_sha"',
    );
    expect(workflow).toContain(
      "mktemp /app/scripts/.inspect-amo-broker-link-plan.XXXXXX",
    );
    expect(workflow).toContain('test -n "${DATABASE_URL:-}"');
    expect(workflow).toContain('test -n "${AMO_ACCESS_TOKEN:-}"');
    expect(workflow).toContain("trap cleanup EXIT HUP INT TERM");
    expect(workflow.match(/\bssh -T\b/g) || []).toHaveLength(1);
    expect(workflow).not.toMatch(
      /appleboy\/ssh-action|git fetch|git reset|git checkout|git show|docker cp/,
    );
    expect(workflow).not.toMatch(
      /echo[^\n]*(?:GH_TOKEN|health_body)|set\s+-[^\n]*x/,
    );
  });
});
