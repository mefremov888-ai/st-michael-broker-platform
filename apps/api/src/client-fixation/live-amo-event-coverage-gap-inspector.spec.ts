import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";

describe("PII-safe live amoCRM event coverage gap inspector", () => {
  const repositoryRoot = resolve(__dirname, "../../../..");
  const sourcePath = resolve(
    repositoryRoot,
    "scripts/inspect-live-amo-source-aggregates.js",
  );
  const eventPath = resolve(
    repositoryRoot,
    "scripts/inspect-live-amo-event-coverage-gap.js",
  );
  const workflowPath = resolve(
    repositoryRoot,
    ".github/workflows/inspect-production-live-amo-event-coverage-gap.yml",
  );
  const sourceScript = readFileSync(sourcePath, "utf8");
  const eventScript = readFileSync(eventPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");
  const specSource = readFileSync(__filename, "utf8");
  const NodeModule = jest.requireActual("module") as any;
  const loadedSource = new NodeModule(sourcePath, module);
  loadedSource.filename = sourcePath;
  loadedSource.paths = NodeModule._nodeModulePaths(dirname(sourcePath));
  loadedSource._compile(sourceScript, sourcePath);
  const source = loadedSource.exports as any;
  const loadedEvent = new NodeModule(eventPath, module);
  loadedEvent.filename = eventPath;
  loadedEvent.paths = NodeModule._nodeModulePaths(dirname(eventPath));
  loadedEvent._compile(eventScript, eventPath);
  const inspector = loadedEvent.exports as any;

  const field = (fieldId: number, value: unknown, enumId?: number) => ({
    field_id: fieldId,
    values: [{ value, ...(enumId ? { enum_id: enumId } : {}) }],
  });
  const relations = (clientId: number, brokerId?: number) => ({
    contacts: [
      { id: clientId, is_main: true },
      ...(brokerId ? [{ id: brokerId }] : []),
    ],
  });

  async function buildFixture(
    contacts: any[],
    leadsByPipeline: Record<string, any[]>,
  ) {
    const state = source.createState();
    const collector = inspector.createEvidenceCollector();
    for (const contact of contacts) {
      source.ingestContact(state, contact);
      await collector.onContact(contact);
    }
    for (const label of Object.keys(source.PIPELINES)) {
      for (const lead of leadsByPipeline[label] || []) {
        source.ingestLead(state, label, lead);
        await collector.onLead(label, lead);
      }
    }
    const sourceReport = await source.finalizeReport(
      state,
      new Date("2026-08-26T08:00:00.000Z"),
    );
    const observed = collector.snapshot();
    return {
      observed,
      sourceReport,
      report: inspector.buildReport(sourceReport, observed),
    };
  }

  it("adds validated observers without changing the aggregate report", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-26T08:00:00.000Z"));
    const broker = {
      id: 81001,
      custom_fields_values: [field(835415, true)],
      _embedded: { companies: [] },
    };
    const lead = {
      id: 82001,
      pipeline_id: 7600546,
      status_id: 62907378,
      created_at: 1_777_000_000,
      custom_fields_values: [field(665195, "Да", 985337)],
      _embedded: relations(83001, broker.id),
    };
    const requestFactory = () =>
      jest.fn(async (pathname: string, query: Record<string, unknown> = {}) => {
        if (pathname === "/api/v4/account") return { id: 28552900 };
        if (pathname === "/api/v4/contacts") {
          return { _embedded: { contacts: [broker] }, _links: {} };
        }
        return {
          _embedded: {
            leads:
              query["filter[pipeline_id][]"] === lead.pipeline_id ? [lead] : [],
          },
          _links: {},
        };
      });
    const baseline = await source.scanLiveAmo(requestFactory());
    const contacts: number[] = [];
    const leads: Array<[string, number]> = [];
    const observed = await source.scanLiveAmo(
      requestFactory(),
      () => undefined,
      {
        onContact: (contact: any) => contacts.push(contact.id),
        onLead: (label: string, item: any) => leads.push([label, item.id]),
      },
    );
    expect(observed).toEqual(baseline);
    expect(contacts).toEqual([broker.id]);
    expect(leads).toEqual([["sales_a", lead.id]]);

    const request = jest.fn();
    await expect(
      source.scanLiveAmo(request, () => undefined, null),
    ).rejects.toThrow("Invalid scan observer callbacks");
    await expect(
      source.scanLiveAmo(request, () => undefined, { onLead: "unsafe" }),
    ).rejects.toThrow("Invalid scan observer callbacks");
    await expect(
      source.scanLiveAmo(request, () => undefined, {
        onContact: () => undefined,
        unexpected: () => undefined,
      }),
    ).rejects.toThrow("Invalid scan observer callbacks");
    expect(request).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("maps current evidence and all applicable gaps without emitting PII", async () => {
    const brokerOne = {
      id: 10001,
      name: "Sensitive Broker One",
      custom_fields_values: [
        field(835415, true),
        field(557903, "+7 (999) 123-45-67"),
        field(842303, true),
        field(842305, 1_777_100_000),
      ],
      _embedded: { companies: [] },
    };
    const brokerTwo = {
      id: 10002,
      name: "Sensitive Broker Two",
      custom_fields_values: [
        field(835415, true),
        field(842303, true),
        field(842305, "not-a-date"),
      ],
      _embedded: { companies: [] },
    };
    const nonBroker = {
      id: 10003,
      name: "Sensitive Client",
      custom_fields_values: [field(557903, "+7 900 000-00-00")],
      _embedded: { companies: [] },
    };
    const strict = field(665195, "Да", 985337);
    const legacy = field(618547, "  ЗАЯВКА   ОТ БРОКЕРА ");
    const leadsByPipeline = {
      brokers: [
        {
          id: 20001,
          pipeline_id: 10787390,
          status_id: 84932446,
        },
      ],
      call_center: [
        {
          id: 20002,
          name: "Sensitive fixation one",
          pipeline_id: 7600542,
          status_id: 142,
          created_at: 1_777_000_001,
          custom_fields_values: [strict, legacy, field(839185, 1_777_200_000)],
          _embedded: relations(21001, brokerOne.id),
        },
      ],
      sales_a: [
        {
          id: 20003,
          name: "Sensitive deal two",
          pipeline_id: 7600546,
          status_id: 62907378,
          custom_fields_values: [
            strict,
            field(833065, "1 000 000,00 ₽"),
            field(558353, 1_777_300_000),
            field(842387, "https://sensitive.invalid/leads/detail/99999"),
          ],
          _embedded: relations(21002, brokerOne.id),
        },
      ],
      sales_b: [
        {
          id: 20004,
          pipeline_id: 7600550,
          status_id: 62907142,
          created_at: 1_777_000_003,
          custom_fields_values: [legacy],
          _embedded: relations(21003, brokerTwo.id),
        },
      ],
      sales_c: [
        {
          id: 20005,
          pipeline_id: 7600554,
          status_id: 62907166,
          created_at: 1_777_000_004,
          custom_fields_values: [strict],
          _embedded: relations(21004),
        },
        {
          id: 20006,
          pipeline_id: 7600554,
          status_id: 62907594,
          created_at: 1_777_000_005,
          custom_fields_values: [
            strict,
            legacy,
            field(839185, "invalid meeting date"),
            field(833065, "not-money"),
            field(558353, "not-a-date"),
          ],
          _embedded: relations(21005, brokerTwo.id),
        },
      ],
    };
    const { report } = await buildFixture(
      [brokerOne, brokerTwo, nonBroker],
      leadsByPipeline,
    );

    expect(report).toMatchObject({
      report: "live_amocrm_event_coverage_gap",
      schemaVersion: 1,
      ruleVersion: "loyalty-amo-event-gap-v1-2026-08-26",
      safety: {
        source: "live_amocrm_api",
        accountIdentityVerified: true,
        httpMethods: ["GET"],
        oauthRefreshAttempted: false,
        brokerPlatformDatabaseUsed: false,
        nestApplicationBootstrapped: false,
        syncRunPersisted: false,
        rawResponsesEmitted: false,
        rawEntityIdentifiersEmitted: false,
        namesPhonesEmailsOrUrlsEmitted: false,
        perRecordRowsEmitted: false,
        completeTraversalRequired: true,
      },
      scan: {
        transactionalSnapshot: false,
        currentStateOnly: true,
        contactsScanned: 3,
        brokerContactsScanned: 2,
        leadsScanned: 6,
        pipelines: {
          brokers: 1,
          call_center: 1,
          sales_a: 1,
          sales_b: 1,
          sales_c: 2,
        },
      },
      coverageDecision: {
        eventCoverageComplete: false,
        fullSnapshotAttestable: false,
        coveredRecords: null,
        attestedActivityTypes: [],
        observedEvidenceTypes: ["FIXATION", "MEETING", "DEAL", "BROKER_TOUR"],
      },
      counts: {
        FIXATION: {
          strictMarkerLeadRows: 4,
          strictMarkerAndBrokerLinkedRows: 3,
          strictMarkerWithoutBrokerLinkRows: 1,
          linkedRows: { validCreatedAt: 2, missingCreatedAt: 1 },
          legacyCommentMarkerRows: 3,
          markerRuleDisagreementRows: 3,
          historicalIncludedEvents: null,
          accuracy: "UNKNOWN",
        },
        MEETING: {
          candidateRows: 3,
          dateCoverage: { valid: 1, missing: 1, invalid: 1 },
          currentHeldOrLaterStageRows: 3,
          validDateAndHeldOrLaterStageRows: 1,
          historicalIncludedEvents: null,
          accuracy: "UNKNOWN",
        },
        DEAL: {
          rawCandidateLeadRows: 2,
          deduplicatedCandidateGroups: 2,
          duplicateRowsCollapsed: 0,
          dduAmountCoverage: {
            valid: 1,
            missing: 0,
            invalid: 1,
            conflicting: 0,
          },
          contractDateCoverage: { valid: 1, missing: 0, invalid: 1 },
          unambiguousCurrentSumRub: "1000000.00",
          historicalIncludedEvents: null,
          accuracy: "UNKNOWN",
        },
        BROKER_TOUR: {
          markedContacts: 2,
          dateCoverage: { valid: 1, missing: 0, invalid: 1 },
          historicalIncludedEvents: null,
          accuracy: "UNKNOWN",
        },
        CALL: {
          sourceScanned: false,
          candidateRows: null,
          historicalIncludedEvents: null,
          accuracy: "UNKNOWN",
        },
      },
      evidenceLedger: {
        kind: "current_observable_event_evidence",
        rowCount: 12,
        algorithm: "sha256",
        canonicalization: "typed-length-prefixed-v1_sorted-type-entity-id",
        hashInputIncludesOpaqueSourceEntityIds: true,
        sourceEntityIdsEmitted: false,
        completeHistoricalLedger: false,
      },
    });
    expect(report.evidenceLedger.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.coverageDecision.blockers).toEqual([
      ...inspector.REQUIRED_BLOCKERS,
      "BROKER_LINK_COVERAGE_INCOMPLETE",
      "EVENT_TIMESTAMP_COVERAGE_INCOMPLETE",
      "DEAL_EVIDENCE_INCOMPLETE",
    ]);

    const serialized = JSON.stringify(report);
    for (const sensitive of [
      "Sensitive Broker One",
      "Sensitive Broker Two",
      "Sensitive Client",
      "Sensitive fixation one",
      "Sensitive deal two",
      "+7 (999) 123-45-67",
      "+7 900 000-00-00",
      "sensitive.invalid",
      "10001",
      "20002",
      "21005",
      "99999",
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(serialized).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  });

  it("never attests completeness even when current observable fields are filled", async () => {
    const broker = {
      id: 31001,
      custom_fields_values: [
        field(835415, true),
        field(842303, true),
        field(842305, 1_777_100_000),
      ],
      _embedded: { companies: [] },
    };
    const deal = {
      id: 32001,
      pipeline_id: 7600546,
      status_id: 62907378,
      created_at: 1_777_000_000,
      custom_fields_values: [
        field(665195, "Да", 985337),
        field(618547, "Заявка от брокера"),
        field(839185, 1_777_200_000),
        field(833065, "2500000"),
        field(558353, 1_777_300_000),
      ],
      _embedded: relations(33001, broker.id),
    };
    const { report } = await buildFixture([broker], { sales_a: [deal] });
    expect(report.coverageDecision).toEqual({
      eventCoverageComplete: false,
      fullSnapshotAttestable: false,
      coveredRecords: null,
      attestedActivityTypes: [],
      observedEvidenceTypes: ["FIXATION", "MEETING", "DEAL", "BROKER_TOUR"],
      blockers: inspector.REQUIRED_BLOCKERS,
    });
    expect(report.counts.FIXATION.accuracy).toBe("UNKNOWN");
    expect(report.counts.MEETING.historicalIncludedEvents).toBeNull();
    expect(report.counts.DEAL.historicalIncludedEvents).toBeNull();
    expect(report.counts.BROKER_TOUR.historicalIncludedEvents).toBeNull();
  });

  it("builds an order-independent ledger that ignores PII but detects evidence changes", async () => {
    const contact = (name: string, phone: string, date = 1_777_100_000) => ({
      id: 41001,
      name,
      custom_fields_values: [
        field(835415, true),
        field(557903, phone),
        field(842303, true),
        field(842305, date),
      ],
      _embedded: { companies: [] },
    });
    const leads = [
      {
        id: 42002,
        name: "Sensitive B",
        pipeline_id: 7600550,
        status_id: 62907142,
        created_at: 1_777_000_002,
        custom_fields_values: [
          field(665195, "Да", 985337),
          field(618547, "Заявка от брокера"),
        ],
        _embedded: relations(43002, 41001),
      },
      {
        id: 42001,
        name: "Sensitive A",
        pipeline_id: 7600546,
        status_id: 62907378,
        created_at: 1_777_000_001,
        custom_fields_values: [
          field(665195, "Да", 985337),
          field(618547, "Заявка от брокера"),
          field(839185, 1_777_200_000),
          field(833065, "1000000"),
          field(558353, 1_777_300_000),
        ],
        _embedded: relations(43001, 41001),
      },
    ];

    async function ledger(broker: any, orderedLeads: any[]): Promise<string> {
      const collector = inspector.createEvidenceCollector();
      await collector.onContact(broker);
      for (const lead of orderedLeads) {
        const label = lead.pipeline_id === 7600546 ? "sales_a" : "sales_b";
        await collector.onLead(label, lead);
      }
      return collector.snapshot().evidenceLedger.sha256;
    }

    const baseline = await ledger(
      contact("Sensitive Broker", "+7 (999) 111-22-33"),
      leads,
    );
    const reorderedAndRedacted = await ledger(
      contact("Completely Different Name", "+7 (900) 000-00-00"),
      [...leads].reverse().map((lead) => ({ ...lead, name: "Different PII" })),
    );
    const changedEvidence = await ledger(
      contact("Sensitive Broker", "+7 (999) 111-22-33", 1_777_186_400),
      leads,
    );
    expect(reorderedAndRedacted).toBe(baseline);
    expect(changedEvidence).not.toBe(baseline);
  });

  it("fails closed with allowlisted errors and has no application mutation path", async () => {
    expect(eventScript).not.toMatch(
      /NestFactory|AppModule|PrismaClient|@st-michael\/database|DATABASE_URL|SystemSetting/,
    );
    expect(eventScript).not.toMatch(
      /AMO_REFRESH_TOKEN|refreshToken|oauth\/token|oauth2\/access_token/i,
    );
    expect(eventScript).not.toMatch(
      /method:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]/i,
    );
    expect(eventScript).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(
      eventScript.match(/process\.stdout\.write\s*\(/g) || [],
    ).toHaveLength(1);
    expect(
      eventScript.match(/process\.stderr\.write\s*\(/g) || [],
    ).toHaveLength(1);
    expect(eventScript).toContain(
      'require("./inspect-live-amo-source-aggregates.js")',
    );
    expect(sourceScript).toContain('method: "GET"');
    expect(sourceScript).not.toMatch(
      /method:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]/i,
    );
    expect(sourceScript).not.toMatch(
      /response\.(?:json|text|arrayBuffer|blob)\s*\(/,
    );
    expect(sourceScript).toContain(
      "const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024",
    );
    expect(sourceScript).toContain("items.length > PAGE_LIMIT");
    expect(source.MAX_RESPONSE_BODY_BYTES).toBe(8 * 1024 * 1024);

    const collector = inspector.createEvidenceCollector();
    await collector.onContact({
      id: 51001,
      custom_fields_values: [field(835415, true), field(842303, true)],
      _embedded: { companies: [] },
    });
    await expect(
      collector.onContact({
        id: 51001,
        custom_fields_values: [field(835415, true), field(842303, true)],
        _embedded: { companies: [] },
      }),
    ).rejects.toThrow("Duplicate event evidence observation");
    expect(
      inspector.classifyFailure(
        new Error("Duplicate event evidence observation"),
      ),
    ).toBe("DUPLICATE_EVIDENCE_OBSERVATION");
    expect(
      inspector.classifyFailure(
        new Error(
          "Bearer secret-token for private@example.test at +7 999 123-45-67",
        ),
      ),
    ).toBe("UNKNOWN_FAILURE");

    const cli = spawnSync(process.execPath, [eventPath], {
      encoding: "utf8",
      env: { ...process.env, AMO_ACCESS_TOKEN: "" },
    });
    expect(cli.status).toBe(1);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toBe(
      "failure_phase=ACCOUNT\nfailure_code=AMO_ACCESS_TOKEN_MISSING\n",
    );
  });

  it("fails if callback observations and the aggregate report diverge", async () => {
    const { observed, sourceReport } = await buildFixture([], {});
    const tampered = {
      ...sourceReport,
      contacts: { ...sourceReport.contacts, total: 1 },
    };
    expect(() => inspector.buildReport(tampered, observed)).toThrow(
      "Source report invariant failed",
    );
    expect(
      inspector.classifyFailure(new Error("Source report invariant failed")),
    ).toBe("SOURCE_REPORT_INVARIANT_FAILED");
  });

  it("streams both exact-SHA sources into one pinned, lock-held session", () => {
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

    const heredocBody = (name: string) => {
      const marker = `cat <<'${name}'\n`;
      const start = workflowShell.indexOf(marker) + marker.length;
      const end = workflowShell.indexOf(`\n${name}`, start);
      expect(start).toBeGreaterThanOrEqual(marker.length);
      expect(end).toBeGreaterThan(start);
      return workflowShell.slice(start, end);
    };
    const generatedRemoteShell = `${heredocBody(
      "REMOTE_PREFIX",
    )}\nYQ==\n${heredocBody("REMOTE_MIDDLE")}\nYg==\n${heredocBody(
      "REMOTE_SUFFIX",
    )}\n`;
    const remoteSyntax = spawnSync(bash, ["-n"], {
      input: generatedRemoteShell,
      encoding: "utf8",
    });
    expect(remoteSyntax.stderr).toBe("");
    expect(remoteSyntax.status).toBe(0);

    const containerMarker = "<<'CONTAINER_PREFIX'\n";
    const containerStart =
      generatedRemoteShell.indexOf(containerMarker) + containerMarker.length;
    const containerEnd = generatedRemoteShell.indexOf(
      "\nCONTAINER_PREFIX",
      containerStart,
    );
    expect(containerStart).toBeGreaterThanOrEqual(containerMarker.length);
    expect(containerEnd).toBeGreaterThan(containerStart);
    const containerSyntax = spawnSync(bash, ["-n"], {
      input: generatedRemoteShell.slice(containerStart, containerEnd),
      encoding: "utf8",
    });
    expect(containerSyntax.stderr).toBe("");
    expect(containerSyntax.status).toBe(0);

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
      '"/repos/$EXPECTED_REPOSITORY/compare/$deployed_sha...$EXPECTED_SHA"',
    );
    expect(workflow).toContain("ahead|identical) ;;");
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
      'test "$production_sha" = "$expected_deployed_sha"',
    );
    expect(workflow).toContain('test "$container_sha" = "$production_sha"');
    expect(workflow).toContain("scripts/inspect-live-amo-source-aggregates.js");
    expect(workflow).toContain(
      "scripts/inspect-live-amo-event-coverage-gap.js",
    );
    expect(workflow).toContain("PII_SAFE_LIVE_AMO_SOURCE_PAYLOAD");
    expect(workflow).toContain("PII_SAFE_LIVE_AMO_EVENT_GAP_PAYLOAD");
    expect(workflow).toContain(
      "inspector_root=$(mktemp -d /app/scripts/.inspect-live-amo-event-gap.XXXXXX)",
    );
    expect(workflow).toContain(
      'test "$actual_source_sha" = "$expected_source_sha"',
    );
    expect(workflow).toContain(
      'test "$actual_event_sha" = "$expected_event_sha"',
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

  it("keeps the Russian rule marker as valid UTF-8", () => {
    expect(eventScript).toContain(
      'const LEGACY_FIXATION_MARKER = "Заявка от брокера"',
    );
    expect(specSource).toContain('field(618547, "Заявка от брокера")');
    const suspicious = [
      "\u0420\u2014",
      "\u0420\u00B0",
      "\u0421\u040F",
      "\u0432\u201A\u0405",
      "\u0421\u0402\u0421\u0453\u0420\u00B1",
      "\uFFFD",
    ];
    for (const text of [eventScript, workflow, specSource]) {
      for (const marker of suspicious) expect(text).not.toContain(marker);
    }
  });
});
