import { spawnSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
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
    BROKER_OWNER_SELECT: Record<string, unknown>;
    BROKER_PROVISION_SELECT: Record<string, unknown>;
    PROVISIONING_QUEUE_ROW_SELECT: Record<string, unknown>;
    buildCohortAttestation: (
      rows: any[],
      brokers: any[],
      lookups: Map<string, any>,
      key: Buffer | string,
      inspectorSha256: string,
      deployedGitSha: string,
    ) => {
      digest: string;
      inspectorSha256: string;
      deployedGitSha: string;
    };
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
    readCohortAttestationKeyFile: (path: string) => Buffer;
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
    fullName: "Test Broker",
    phone: "+79990000001",
    email: "broker@example.test",
    region: "MSK",
    position: "Broker",
    telegramUsername: "test_broker",
    telegramId: "1000001",
    whatsappUsername: "79990000001",
    presentationSent: true,
    doNotCall: false,
    mergedIntoId: null,
    updatedAt: new Date("2026-08-26T00:00:00.000Z"),
    phones: [],
    brokerAgencies: [
      {
        id: "membership-primary",
        agencyId: "agency-primary",
        isPrimary: true,
        joinedAt: new Date("2026-01-01T00:00:00.000Z"),
        agency: {
          id: "agency-primary",
          name: "Primary Agency",
          inn: "7700000000",
          address: "Moscow",
        },
      },
    ],
    ...overrides,
  });
  const row = (id: string, effective: any | null, overrides: any = {}) => ({
    id,
    brokerId: effective?.id ?? null,
    responsibleBrokerId: null,
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
  const attestationKey = Buffer.from(
    "production-cohort-key-32-bytes-minimum",
    "utf8",
  );
  const inspectorSha256 = "a".repeat(64);
  const deployedGitSha = "b".repeat(40);

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

  it("builds a deterministic attestation from canonical raw cohort state regardless of input ordering", () => {
    const firstBroker = broker({
      id: "broker-identity-first",
      phone: "+7 (999) 000-00-01",
      phones: [{ phone: "8 999 000 00 11" }],
    });
    const secondBroker = broker({
      id: "broker-identity-second",
      phone: "+79990000002",
      phones: [{ phone: "+7 999 000 00 12" }],
    });
    const rows = [
      row("queue-identity-first", firstBroker),
      row("queue-identity-second", null, {
        broker: secondBroker,
        responsibleBroker: secondBroker,
        amoLeadId: BigInt(331122),
      }),
    ];
    const lookups = new Map([
      [
        "+79990000001",
        {
          contacts: [
            { contactId: 102, brokerFlag: false },
            { contactId: 101, brokerFlag: true },
          ],
        },
      ],
      ["+79990000002", { contacts: [{ contactId: 202, brokerFlag: true }] }],
    ]);

    const first = inspector.buildCohortAttestation(
      rows,
      [firstBroker, secondBroker],
      lookups,
      attestationKey,
      inspectorSha256,
      deployedGitSha,
    );
    const reordered = inspector.buildCohortAttestation(
      [...rows].reverse(),
      [secondBroker, firstBroker],
      new Map(
        [...lookups.entries()]
          .reverse()
          .map(([phone, lookup]) => [
            phone,
            { contacts: [...lookup.contacts].reverse() },
          ]),
      ),
      attestationKey,
      inspectorSha256,
      deployedGitSha,
    );

    expect(reordered).toEqual(first);
    expect(first).toEqual({
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      inspectorSha256,
      deployedGitSha,
    });
    expect(Object.keys(first).sort()).toEqual([
      "deployedGitSha",
      "digest",
      "inspectorSha256",
    ]);
  });

  it("binds every queue mutation source and primary-agency source while leaving unrelated profile fields out of global ownership", () => {
    const target = broker({
      id: "mutation-source-target",
      phone: "+79990000031",
    });
    const unrelated = broker({
      id: "unrelated-owner",
      phone: "+79990000032",
      amoContactId: BigInt(320),
      fullName: "Unrelated Before",
    });
    const lookups = new Map([
      [target.phone as string, { contacts: [], pagesRead: 1, contactsRead: 0 }],
    ]);
    const attest = (queueBroker: any, allBrokers: any[]) =>
      inspector.buildCohortAttestation(
        [row("mutation-source-queue", queueBroker)],
        allBrokers,
        lookups,
        attestationKey,
        inspectorSha256,
        deployedGitSha,
      ).digest;
    const original = attest(target, [target, unrelated]);

    for (const drift of [
      { fullName: "Changed Broker" },
      { email: "changed@example.test" },
      { region: "SPB" },
      { presentationSent: false },
      { doNotCall: true },
    ]) {
      const changed = broker({ ...target, ...drift });
      expect(attest(changed, [changed, unrelated])).not.toBe(original);
    }

    for (const [field, value] of [
      ["name", "Changed Agency"],
      ["inn", "7800000000"],
      ["address", "Saint Petersburg"],
    ]) {
      const changed = broker({
        ...target,
        brokerAgencies: [
          {
            ...target.brokerAgencies[0],
            agency: {
              ...target.brokerAgencies[0].agency,
              [field]: value,
            },
          },
        ],
      });
      expect(attest(changed, [changed, unrelated])).not.toBe(original);
    }

    const unrelatedProfileDrift = broker({
      ...unrelated,
      fullName: "Unrelated After",
      email: "unrelated-after@example.test",
      region: "KZN",
      doNotCall: true,
    });
    expect(attest(target, [target, unrelatedProfileDrift])).toBe(original);

    for (const ownershipDrift of [
      broker({ ...unrelated, id: "unrelated-owner-replaced" }),
      broker({ ...unrelated, phone: "+79990000039" }),
      broker({ ...unrelated, amoContactId: BigInt(321) }),
    ]) {
      expect(attest(target, [target, ownershipDrift])).not.toBe(original);
    }
  });

  it("changes the attestation for same-count identity swaps and for either bound SHA", () => {
    const firstBroker = broker({
      id: "same-count-broker-first",
      phone: "+79990000001",
    });
    const secondBroker = broker({
      id: "same-count-broker-second",
      phone: "+79990000002",
    });
    const rows = [
      row("same-count-queue-first", firstBroker),
      row("same-count-queue-second", secondBroker),
    ];
    const originalLookups = new Map([
      ["+79990000001", { contacts: [{ contactId: 101, brokerFlag: true }] }],
      ["+79990000002", { contacts: [{ contactId: 202, brokerFlag: false }] }],
    ]);
    const swappedLookups = new Map([
      ["+79990000001", { contacts: [{ contactId: 202, brokerFlag: false }] }],
      ["+79990000002", { contacts: [{ contactId: 101, brokerFlag: true }] }],
    ]);
    const attest = (
      queueRows = rows,
      lookups = originalLookups,
      sourceSha = inspectorSha256,
      deployedSha = deployedGitSha,
    ) =>
      inspector.buildCohortAttestation(
        queueRows,
        [firstBroker, secondBroker],
        lookups,
        attestationKey,
        sourceSha,
        deployedSha,
      ).digest;
    const original = attest();

    expect(attest(rows, swappedLookups)).not.toBe(original);
    expect(
      attest([
        row("same-count-queue-first", secondBroker),
        row("same-count-queue-second", firstBroker),
      ]),
    ).not.toBe(original);
    expect(attest(rows, originalLookups, "c".repeat(64))).not.toBe(original);
    expect(
      attest(rows, originalLookups, inspectorSha256, "d".repeat(40)),
    ).not.toBe(original);
  });

  it("requires a 32-byte key and exact lowercase SHA forms without emitting source identities or the key", () => {
    const rawBrokerId = "attestation-private-broker-4c797756";
    const rawQueueId = "attestation-private-queue-39c68ab2";
    const rawPhone = "+79995554433";
    const rawContactId = 987654321;
    const secretKey = "attestation-secret-that-must-never-be-output";
    const effective = broker({ id: rawBrokerId, phone: rawPhone });
    const rows = [row(rawQueueId, effective)];
    const brokers = [effective];
    const lookups = new Map([
      [
        rawPhone,
        { contacts: [{ contactId: rawContactId, brokerFlag: false }] },
      ],
    ]);
    const attestation = inspector.buildCohortAttestation(
      rows,
      brokers,
      lookups,
      secretKey,
      inspectorSha256,
      deployedGitSha,
    );
    const serialized = JSON.stringify(attestation);

    for (const privateValue of [
      rawBrokerId,
      rawQueueId,
      rawPhone,
      String(rawContactId),
      secretKey,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(() =>
      inspector.buildCohortAttestation(
        rows,
        brokers,
        lookups,
        Buffer.alloc(31),
        inspectorSha256,
        deployedGitSha,
      ),
    ).toThrow("Cohort attestation key is invalid");
    expect(() =>
      inspector.buildCohortAttestation(
        rows,
        brokers,
        lookups,
        attestationKey,
        "A".repeat(64),
        deployedGitSha,
      ),
    ).toThrow("Inspector source SHA is invalid");
    expect(() =>
      inspector.buildCohortAttestation(
        rows,
        brokers,
        lookups,
        attestationKey,
        inspectorSha256,
        "b".repeat(39),
      ),
    ).toThrow("Deployed Git SHA is invalid");
  });

  it("fails provisioning-plan main before database or amo access when production attestation configuration is missing", () => {
    const execution = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        BROKER_CONTACT_PROVISIONING_PLAN: "1",
        BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE: "",
        BROKER_CONTACT_INSPECTOR_SHA256: inspectorSha256,
        BROKER_CONTACT_DEPLOYED_GIT_SHA: deployedGitSha,
        DATABASE_URL: "contains-private-database-location",
        AMO_ACCESS_TOKEN: "contains-private-amo-token",
      },
    });

    expect(execution.status).toBe(1);
    expect(execution.stdout).toBe("");
    expect(execution.stderr).toBe(
      "PII-safe broker link repair-plan inspector failed; failure_phase=ATTESTATION; failure_code=COHORT_ATTESTATION_KEY_FILE_INVALID\n",
    );
    expect(execution.stderr).not.toContain("contains-private");
  });

  it("reads the secret-backed attestation key as exact file bytes without shell trimming", () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "st-michael-cohort-attestation-"),
    );
    const keyPath = join(temporaryDirectory, "attestation.key");
    const exactKey = Buffer.concat([
      Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
      Buffer.from("\n\n", "utf8"),
    ]);
    try {
      writeFileSync(keyPath, exactKey, { mode: 0o600 });
      expect(inspector.readCohortAttestationKeyFile(keyPath)).toEqual(exactKey);
    } finally {
      if (existsSync(keyPath)) unlinkSync(keyPath);
      rmdirSync(temporaryDirectory);
    }
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
    const remoteSuffixMarker = "cat <<'REMOTE_SUFFIX'\n";
    const remoteSuffixStart =
      shell.indexOf(remoteSuffixMarker, remoteEnd) + remoteSuffixMarker.length;
    const remoteSuffixEnd = shell.indexOf("\nREMOTE_SUFFIX", remoteSuffixStart);
    expect(remoteStart).toBeGreaterThan(remoteMarker.length);
    expect(remoteEnd).toBeGreaterThan(remoteStart);
    expect(remoteSuffixStart).toBeGreaterThan(remoteEnd);
    expect(remoteSuffixEnd).toBeGreaterThan(remoteSuffixStart);
    const generatedRemoteShell = `${shell.slice(
      remoteStart,
      remoteEnd,
    )}\nY29uc29sZS5sb2coInNhZmUiKTs=\nPII_SAFE_BROKER_CONTACT_PROVISIONING_PAYLOAD\nexpected_payload_sha=${"c".repeat(
      64,
    )}\n${shell.slice(remoteSuffixStart, remoteSuffixEnd)}\n`;
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
    expect(workflow).toContain(
      "COHORT_ATTESTATION_KEY: ${{ secrets.BROKER_CONTACT_COHORT_ATTESTATION_KEY }}",
    );
    expect(workflow).toContain(
      'printf \'%s\' "$COHORT_ATTESTATION_KEY" > "$attestation_key_file"',
    );
    expect(workflow).toContain("unset COHORT_ATTESTATION_KEY");
    expect(workflow).toContain('test "$attestation_key_bytes" -ge 32');
    expect(workflow).toContain(
      'attestation_key_sha=$(sha256sum -- "$attestation_key_file"',
    );
    expect(workflow).toContain('test "$actual_key_sha" = "$expected_key_sha"');
    expect(workflow).toContain(
      'test "$payload_script_sha" = "$expected_script_sha"',
    );
    expect(workflow).toContain(
      'test "$payload_deployed_sha" = "$expected_deployed_sha"',
    );
    expect(workflow).toContain(
      'export BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE="$attestation_key_file"',
    );
    expect(workflow).not.toContain(
      "BROKER_CONTACT_COHORT_ATTESTATION_KEY=$(cat",
    );
    expect(workflow).toContain(
      'export BROKER_CONTACT_INSPECTOR_SHA256="$expected_script_sha"',
    );
    expect(workflow).toContain(
      'export BROKER_CONTACT_DEPLOYED_GIT_SHA="$expected_deployed_sha"',
    );
    expect(workflow).toContain("trap cleanup_payload EXIT HUP INT TERM");
    expect(workflow).not.toMatch(
      /bash -s --[^\n]*COHORT_ATTESTATION_KEY|ssh[^\n]*COHORT_ATTESTATION_KEY/,
    );
    expect(workflow).not.toMatch(/bash -s --[^\n]*payload_sha/);
    expect(workflow).not.toMatch(
      /(?:echo|printf)[^\n]*(?:\$\{?BROKER_CONTACT_COHORT_ATTESTATION_KEY|\$\{?COHORT_ATTESTATION_KEY)(?![^\n]*attestation_key_file)/,
    );
    expect(workflow).toContain("PII_SAFE_BROKER_CONTACT_PROVISIONING_PAYLOAD");
    expect(workflow).not.toMatch(/--apply|prisma|POST|PATCH|PUT|DELETE/);
    expect(script).toContain('method: "GET"');
    expect(script).toContain(
      "process.env.BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE",
    );
    expect(script).toContain("cohortAttestationKey(readFileSync(pathValue))");
    expect(script).toContain("process.env.BROKER_CONTACT_INSPECTOR_SHA256");
    expect(script).toContain("process.env.BROKER_CONTACT_DEPLOYED_GIT_SHA");
    expect(script).not.toMatch(
      /prisma(?:\.[A-Za-z_$][\w$]*)+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(script).not.toMatch(
      /NestFactory|AppModule|AmoCrmAdapter|refreshAccessToken|AMO_REFRESH_TOKEN/,
    );
  });
});
