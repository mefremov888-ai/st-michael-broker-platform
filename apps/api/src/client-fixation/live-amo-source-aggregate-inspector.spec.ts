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
    expect(script).not.toMatch(/response\.(?:text|arrayBuffer|blob)\s*\(/);
    expect(script).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(script.match(/process\.stdout\.write\s*\(/g) || []).toHaveLength(1);
    expect(script.match(/process\.stderr\.write\s*\(/g) || []).toHaveLength(1);

    const requests: Array<{ url: URL; options: any }> = [];
    const fakeFetch = jest.fn(async (url: URL, options: any) => {
      requests.push({ url, options });
      return {
        status: 200,
        ok: true,
        json: async () => ({ id: 28552900 }),
      };
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
      async () => [],
    );
    expect(report.clientPipelines.all.strictSourceAndBrokerLinked).toBe(5);
    expect(report.deals.rawQualifyingLeadRows).toBe(1);
    expect(report.deals.deduplicatedDealGroups).toBe(1);
    expect(report.meetings.currentMeetingHeldStageProxy).toMatchObject({
      total: 3,
      byPipeline: { sales_a: 3 },
    });
  });

  it("uses client entity relations for dedup only with matching deal evidence", async () => {
    const base = {
      parentReferenceIds: [],
      brokerCopyReferenceIds: [],
      contractDateValues: ["2026-08-20"],
      dedupClientContactIds: [95001],
    };
    const report = await inspector.buildDealReport(
      [
        { ...base, id: 94001, dduAmountValues: ["1000000"] },
        { ...base, id: 94002, dduAmountValues: ["1 000 000,00"] },
        { ...base, id: 94003, dduAmountValues: ["2000000"] },
      ],
      async () => [],
      new Set(),
    );
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

    const relationProvider = async (leadId: number) => {
      if (leadId === 20002 || leadId === 20003) {
        return [
          {
            entity_type: "leads",
            entity_id: leadId,
            to_entity_type: "leads",
            to_entity_id: 77777,
          },
        ];
      }
      return [];
    };
    const report = await inspector.finalizeReport(
      state,
      new Date("2026-08-25T20:00:00.000Z"),
      relationProvider,
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
        candidatesWithFetchedDedupEntityRelation: 2,
        entityRelationRowsScanned: 2,
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
      "77777",
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
