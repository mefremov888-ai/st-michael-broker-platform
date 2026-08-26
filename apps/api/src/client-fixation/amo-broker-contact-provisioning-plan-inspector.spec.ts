import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";

describe("PII-safe amo broker-contact provisioning-plan inspector", () => {
  const repositoryRoot = resolve(__dirname, "../../../..");
  const scriptPath = resolve(
    repositoryRoot,
    "scripts/inspect-amo-broker-link-repair-plan.js",
  );
  const workflowPath = resolve(
    repositoryRoot,
    ".github/workflows/inspect-production-amo-broker-contact-provisioning-plan.yml",
  );
  const script = readFileSync(scriptPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");
  const NodeModule = jest.requireActual("module") as any;
  const loadedScript = new NodeModule(scriptPath, module);
  loadedScript.filename = scriptPath;
  loadedScript.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
  loadedScript._compile(script, scriptPath);
  const inspector = loadedScript.exports as {
    buildProvisioningReport: (
      rows: any[],
      brokers: any[],
      lookups: Map<string, any>,
      generatedAt?: Date,
      hashKey?: Buffer,
    ) => any;
    buildReport: (
      rows: any[],
      brokers: any[],
      lookups: Map<string, any>,
      generatedAt?: Date,
      hashKey?: Buffer,
    ) => any;
    lookupExactBrokerContacts: (
      request: any,
      phone: string,
      maxPages?: number,
    ) => Promise<any>;
    lookupExactContacts: (
      request: any,
      phone: string,
      maxPages?: number,
    ) => Promise<any>;
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
  const contact = (id: number, phone: string, brokerFlag: boolean) => ({
    id,
    custom_fields_values: [
      { field_id: 557903, values: [{ value: phone }] },
      { field_id: 835415, values: [{ value: brokerFlag }] },
    ],
  });

  it("keeps the original broker-only lookup contract while exposing exact unflagged contacts only to the new in-memory plan", async () => {
    const response = {
      _embedded: {
        contacts: [
          contact(101, "+7 (999) 000-00-01", true),
          contact(102, "8 999 000 00 01", false),
          contact(103, "+7 (999) 000-00-02", true),
        ],
      },
      _links: {},
    };

    await expect(
      inspector.lookupExactContacts(
        jest.fn().mockResolvedValue(response),
        "+79990000001",
      ),
    ).resolves.toEqual({
      contacts: [
        { contactId: 101, brokerFlag: true },
        { contactId: 102, brokerFlag: false },
      ],
      pagesRead: 1,
      contactsRead: 3,
    });
    await expect(
      inspector.lookupExactBrokerContacts(
        jest.fn().mockResolvedValue(response),
        "+79990000001",
      ),
    ).resolves.toEqual({
      contactIds: [101],
      pagesRead: 1,
      contactsRead: 3,
    });
  });

  it("classifies exact flagged, exact unflagged, absent, ambiguous and occupied contacts without authorizing a mutation", () => {
    const flagged = broker({ id: "flagged", phone: "+79990000001" });
    const unflagged = broker({ id: "unflagged", phone: "+79990000002" });
    const absent = broker({ id: "absent", phone: "+79990000003" });
    const ambiguous = broker({ id: "ambiguous", phone: "+79990000004" });
    const occupied = broker({ id: "occupied", phone: "+79990000005" });
    const contactOwner = broker({
      id: "contact-owner",
      phone: "+79990000006",
      amoContactId: BigInt(505),
    });
    const already = broker({
      id: "already",
      phone: "+79990000007",
      amoContactId: BigInt(707),
    });
    const rows = [
      row("q-flagged", flagged),
      row("q-unflagged", unflagged),
      row("q-absent", absent),
      row("q-ambiguous", ambiguous),
      row("q-occupied", occupied),
      row("q-already", already),
    ];
    const brokers = [
      flagged,
      unflagged,
      absent,
      ambiguous,
      occupied,
      contactOwner,
      already,
    ];
    const lookups = new Map([
      [
        "+79990000001",
        {
          contacts: [{ contactId: 101, brokerFlag: true }],
          pagesRead: 1,
          contactsRead: 1,
        },
      ],
      [
        "+79990000002",
        {
          contacts: [{ contactId: 202, brokerFlag: false }],
          pagesRead: 1,
          contactsRead: 1,
        },
      ],
      ["+79990000003", { contacts: [], pagesRead: 1, contactsRead: 0 }],
      [
        "+79990000004",
        {
          contacts: [
            { contactId: 401, brokerFlag: true },
            { contactId: 402, brokerFlag: false },
          ],
          pagesRead: 1,
          contactsRead: 2,
        },
      ],
      [
        "+79990000005",
        {
          contacts: [{ contactId: 505, brokerFlag: true }],
          pagesRead: 1,
          contactsRead: 1,
        },
      ],
    ]);
    const report = inspector.buildProvisioningReport(
      rows,
      brokers,
      lookups,
      new Date("2026-08-26T00:00:00.000Z"),
      Buffer.alloc(32, 0x52),
    );
    const byResolution = Object.fromEntries(
      report.records.map((record: any) => [record.resolution, record]),
    );

    expect(report.inspector).toBe("amo_broker_contact_provisioning_plan");
    expect(report.aggregates.resolutionByBroker).toMatchObject({
      link_existing_broker_contact: 1,
      promote_existing_contact_candidate: 1,
      create_contact_candidate: 1,
      ambiguous_exact_contacts: 1,
      candidate_already_bound: 1,
      already_linked: 1,
    });
    expect(byResolution.link_existing_broker_contact).toMatchObject({
      exactContactCount: 1,
      brokerFlaggedContactCount: 1,
      unflaggedContactCount: 0,
      advisory: {
        databaseLinkCandidate: true,
        amoPromotionCandidate: false,
        amoCreateCandidate: false,
        databaseMutationAuthorized: false,
        amoMutationAuthorized: false,
        retryAuthorized: false,
      },
    });
    expect(byResolution.promote_existing_contact_candidate).toMatchObject({
      exactContactCount: 1,
      brokerFlaggedContactCount: 0,
      unflaggedContactCount: 1,
      advisory: {
        databaseLinkCandidate: true,
        amoPromotionCandidate: true,
        amoCreateCandidate: false,
      },
    });
    expect(
      byResolution.create_contact_candidate.candidateContactHash,
    ).toBeNull();
    expect(
      byResolution.ambiguous_exact_contacts.candidateContactHash,
    ).toBeNull();
    expect(
      byResolution.candidate_already_bound.candidateContactHash,
    ).toBeNull();
  });

  it("emits only per-run aliases and preserves the default report mode", () => {
    const rawBrokerId = "a6329d0a-e7a8-42b6-9bda-39c68ab22c4b";
    const rawQueueId = "bd071f23-fb11-4f4a-94fb-88ac4c797756";
    const rawPhone = "+7 (999) 000-00-01";
    const rawContactId = 998877665544;
    const effective = broker({ id: rawBrokerId, phone: rawPhone });
    const rows = [row(rawQueueId, effective)];
    const provisioning = inspector.buildProvisioningReport(
      rows,
      [effective],
      new Map([
        [
          "+79990000001",
          {
            contacts: [{ contactId: rawContactId, brokerFlag: false }],
            pagesRead: 1,
            contactsRead: 1,
          },
        ],
      ]),
      new Date("2026-08-26T00:00:00.000Z"),
      Buffer.alloc(32, 0x53),
    );
    const serialized = JSON.stringify(provisioning);
    for (const secret of [
      rawBrokerId,
      rawQueueId,
      rawPhone,
      "79990000001",
      String(rawContactId),
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    expect(provisioning.records[0].brokerHash).toMatch(/^broker_[0-9a-f]{24}$/);
    expect(provisioning.records[0].candidateContactHash).toMatch(
      /^contact_[0-9a-f]{24}$/,
    );

    const original = inspector.buildReport(
      rows,
      [effective],
      new Map([
        ["+79990000001", { contactIds: [], pagesRead: 1, contactsRead: 1 }],
      ]),
      new Date("2026-08-26T00:00:00.000Z"),
      Buffer.alloc(32, 0x53),
    );
    expect(original.inspector).toBe("amo_broker_link_repair_plan");
    expect(original.records[0].resolution).toBe("no_exact_broker_contact");
  });

  it("runs only the explicit read-only mode from exact master source", () => {
    const parsed = parse(workflow) as any;
    const shell = parsed.jobs.inspect.steps[1].run as string;
    const bash =
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\bin\\bash.exe"
        : "bash";
    expect(existsSync(bash) || process.platform !== "win32").toBe(true);
    const syntax = spawnSync(bash, ["-n"], {
      input: shell,
      encoding: "utf8",
    });
    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe("");

    const remoteMarker = "cat <<'REMOTE_PREFIX'\n";
    const remoteStart = shell.indexOf(remoteMarker) + remoteMarker.length;
    const remoteEnd = shell.indexOf("\nREMOTE_PREFIX", remoteStart);
    expect(remoteStart).toBeGreaterThan(remoteMarker.length);
    expect(remoteEnd).toBeGreaterThan(remoteStart);
    const generatedRemoteShell = `${shell.slice(
      remoteStart,
      remoteEnd,
    )}\nY29uc29sZS5sb2coInNhZmUiKTs=\nPII_SAFE_BROKER_CONTACT_PROVISIONING_PAYLOAD\n`;
    const remoteSyntax = spawnSync(bash, ["-n"], {
      input: generatedRemoteShell,
      encoding: "utf8",
    });
    expect(remoteSyntax.status).toBe(0);
    expect(remoteSyntax.stderr).toBe("");

    expect(workflow).toContain("workflow_dispatch: {}");
    expect(workflow).toContain("group: production-deploy");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain(
      "CANONICAL_REPOSITORY: sereganikitin/st-michael-broker-platform",
    );
    expect(workflow).toContain('test "$EXPECTED_REF" = "refs/heads/master"');
    expect(workflow).toContain(
      'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
    );
    expect(workflow).toContain("flock -s -n 9");
    expect(workflow).toContain(
      'BROKER_CONTACT_PROVISIONING_PLAN=1 node "$inspector"',
    );
    expect(workflow).toContain("PII_SAFE_BROKER_CONTACT_PROVISIONING_PAYLOAD");
    expect(workflow).not.toMatch(/--apply|prisma|POST|PATCH|PUT|DELETE/);
    expect(script).toContain('method: "GET"');
    expect(script).not.toMatch(
      /prisma(?:\.[A-Za-z_$][\w$]*)+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(script).not.toMatch(
      /NestFactory|AppModule|AmoCrmAdapter|refreshAccessToken|AMO_REFRESH_TOKEN/,
    );
  });
});
