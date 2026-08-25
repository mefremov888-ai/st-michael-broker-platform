import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";

describe("PII-safe amo fixation queue inspector", () => {
  const repositoryRoot = resolve(__dirname, "../../../..");
  const scriptPath = resolve(
    repositoryRoot,
    "scripts/inspect-amo-fixation-queue.js",
  );
  const workflowPath = resolve(
    repositoryRoot,
    ".github/workflows/inspect-production-amo-fixation-queue.yml",
  );
  const script = readFileSync(scriptPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");
  // The inspector delays loading Prisma until main(), so requiring it here
  // exercises only pure report helpers.
  const NodeModule = jest.requireActual("module") as any;
  const loadedScript = new NodeModule(scriptPath, module);
  loadedScript.filename = scriptPath;
  loadedScript.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
  loadedScript._compile(script, scriptPath);
  const inspector = loadedScript.exports as {
    ATTEMPT_LIMIT: number;
    STATEMENT_TIMEOUT_MS: number;
    assertReadOnlySession: (prisma: any) => Promise<void>;
    buildReport: (rows: any[], generatedAt?: Date, hashKey?: Buffer) => any;
    buildReadOnlyDatabaseUrl: (value: string) => string;
    classifySyncError: (value: unknown) => string;
    hourBucket: (value: unknown) => string | null;
    reportHash: (
      kind: string,
      value: unknown,
      hashKey: Buffer,
    ) => string | null;
  };

  it("allows only the exact read-only guard plus one business SELECT", () => {
    expect(script).toContain("prisma.client.findMany({");
    expect(script).toContain("await prisma.$disconnect()");
    expect(script).not.toMatch(
      /NestFactory|AppModule|AmoCrmAdapter|\bfetch\s*\(|\baxios\b|node:https|node:http/,
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
    expect(script).not.toMatch(/\b(?:fullName|phone|email|amoLeadId)\s*:/);
    expect(script.match(/prisma\.client\.findMany\s*\(/g) || []).toHaveLength(
      1,
    );
    expect(script.match(/new PrismaClient\s*\(/g) || []).toHaveLength(1);
    expect(script).toContain(
      "datasources: { db: { url: readOnlyDatabaseUrl } }",
    );
    expect(script.match(/process\.stdout\.write\s*\(/g) || []).toHaveLength(1);
    expect(script.match(/process\.stderr\.write\s*\(/g) || []).toHaveLength(1);
    expect(script).not.toMatch(
      /process\.(?:stdout|stderr)\.write\([\s\S]{0,160}(?:DATABASE_URL|databaseUrl|readOnlyDatabaseUrl|hashKey)/,
    );
    expect(script).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(script).toContain('createHmac("sha256", hashKey)');
    expect(script).toContain("hashKey = randomBytes(32)");
    expect(script).not.toMatch(
      /\bretryClass\b|retry_exhausted|below_retry_limit/,
    );
  });

  it("preserves the datasource URL while enforcing read-only session options", () => {
    const rawDatabaseUrl =
      "postgresql://audit-user:s3cr%40t-value@db.internal:5432/broker_platform" +
      "?schema=loyalty&connection_limit=3" +
      "&options=-c%20search_path%3Dpublic" +
      "&options=-c%20lock_timeout%3D1s" +
      "&application_name=queue-inspector";
    const derived = inspector.buildReadOnlyDatabaseUrl(rawDatabaseUrl);
    const parsed = new URL(derived);

    expect(parsed.protocol).toBe("postgresql:");
    expect(parsed.username).toBe("audit-user");
    expect(parsed.password).toBe("s3cr%40t-value");
    expect(parsed.hostname).toBe("db.internal");
    expect(parsed.port).toBe("5432");
    expect(parsed.pathname).toBe("/broker_platform");
    expect(parsed.searchParams.get("schema")).toBe("loyalty");
    expect(parsed.searchParams.get("connection_limit")).toBe("3");
    expect(parsed.searchParams.get("application_name")).toBe("queue-inspector");
    expect(parsed.searchParams.getAll("options")).toEqual([
      "-c search_path=public -c lock_timeout=1s " +
        "-c default_transaction_read_only=on " +
        `-c statement_timeout=${inspector.STATEMENT_TIMEOUT_MS}`,
    ]);

    const invalidWithSecret = "not-a-url-with-db-password-secret";
    try {
      inspector.buildReadOnlyDatabaseUrl(invalidWithSecret);
      throw new Error("expected invalid URL to fail");
    } catch (error) {
      expect(String(error)).not.toContain("db-password-secret");
    }
    expect(() =>
      inspector.buildReadOnlyDatabaseUrl("https://user:secret@example.test/db"),
    ).toThrow("DATABASE_URL must use PostgreSQL");
  });

  it("fails closed unless PostgreSQL confirms read-only mode", async () => {
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

    for (const rows of [[], [{ mode: "off" }], [{ mode: "ON" }]]) {
      await expect(
        inspector.assertReadOnlySession({
          $queryRaw: async () => rows,
        }),
      ).rejects.toThrow("Database session is not read-only");
    }
  });

  it("emits only per-report HMAC aliases, bounded classes and hour buckets", () => {
    const clientA = "2a5c157f-7ab7-4c76-a977-1b64da60f034";
    const clientB = "3fc34e89-8a22-4630-81d4-b3a87653d2cb";
    const owner = "24e7bdeb-20bd-4f3f-83d6-6db564531896";
    const responsible = "3e96cddd-1f94-43e3-88a8-72d7c76b0e68";
    const rawAmoContact = 998877665544n;
    const rawError =
      "WAF body containing +7 999 123-45-67 and private@example.test";
    const rawDatabaseUrl =
      "postgresql://pii-user:db-password-secret@db.internal/private";
    const rows = [
      {
        id: clientA,
        createdAt: new Date("2026-08-12T17:58:53.000Z"),
        amoSyncStatus: "FAILED",
        amoSyncAttempts: 10,
        amoSyncLastAttemptAt: new Date("2026-08-13T10:00:00.000Z"),
        amoSyncError: rawError,
        databaseUrl: rawDatabaseUrl,
        broker: { id: owner, amoContactId: null },
        responsibleBroker: { id: responsible, amoContactId: rawAmoContact },
      },
      {
        id: clientB,
        createdAt: new Date("2026-08-14T08:00:00.000Z"),
        amoSyncStatus: "PENDING",
        amoSyncAttempts: 2,
        amoSyncLastAttemptAt: null,
        amoSyncError: "BROKER_AMO_CONTACT_MISSING",
        broker: { id: owner, amoContactId: null },
        responsibleBroker: null,
      },
    ];
    const fixedReportKey = Buffer.alloc(32, 0x42);

    const report = inspector.buildReport(
      rows,
      new Date("2026-08-25T18:00:00.000Z"),
      fixedReportKey,
    );
    const serialized = JSON.stringify(report);

    expect(report.aggregates).toMatchObject({
      total: 2,
      oldestCreatedAtHourBucket: "2026-08-12T17:00Z",
      oldestLastAttemptAtHourBucket: "2026-08-13T10:00Z",
      attemptLimitClass: {
        attempt_limit_reached: 1,
        below_attempt_limit: 1,
      },
      mappingSource: { responsible: 1, owner_fallback: 1, missing: 0 },
      mappingStatus: {
        amo_contact_present: 1,
        amo_contact_missing: 1,
        effective_broker_missing: 0,
      },
    });
    expect(report.classification).toMatchObject({
      hashScheme: "hmac-sha256-per-report-key-v1-24hex",
      crossRunLinkable: false,
      ageBasis: "created_at_hour_bucket",
      timestampResolution: "hour",
    });
    expect(report.records[0]).not.toHaveProperty("retryClass");
    expect(report.aggregates).not.toHaveProperty("retry");
    expect(report.aggregates).not.toHaveProperty("oldestQueueTimestamp");
    expect(report.records[0].queueHash).toMatch(/^queue_[0-9a-f]{24}$/);
    expect(inspector.reportHash("queue", clientA, fixedReportKey)).toBe(
      inspector.reportHash("queue", clientA, fixedReportKey),
    );
    expect(inspector.reportHash("queue", clientA, fixedReportKey)).not.toBe(
      inspector.reportHash("queue", clientA, Buffer.alloc(32, 0x43)),
    );
    const nextRun = inspector.buildReport(
      rows,
      new Date("2026-08-25T18:00:00.000Z"),
      Buffer.alloc(32, 0x43),
    );
    expect(nextRun.records.map((row: any) => row.queueHash)).not.toEqual(
      report.records.map((row: any) => row.queueHash),
    );
    for (const secret of [
      clientA,
      clientB,
      owner,
      responsible,
      String(rawAmoContact),
      rawError,
      "+7 999 123-45-67",
      "private@example.test",
      rawDatabaseUrl,
      "db-password-secret",
      fixedReportKey.toString("hex"),
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    expect(serialized).not.toContain("2026-08-12T17:58:53.000Z");
    expect(serialized).not.toContain("2026-08-13T10:00:00.000Z");
    expect(serialized).not.toMatch(/\.\d{3}Z/);
  });

  it("maps arbitrary stored dependency text to a bounded non-PII class", () => {
    expect(inspector.classifySyncError("AMO_AUTH_401")).toBe("auth_rejected");
    expect(
      inspector.classifySyncError(
        "unknown response for +7 999 123-45-67 private@example.test",
      ),
    ).toBe("other");
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
    )}\nY29uc29sZS5sb2coInNhZmUiKTs=\nPII_SAFE_INSPECTOR_PAYLOAD\n`;
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
      'mktemp -d "$runner_temp/st-michael-amo-queue-inspector.XXXXXX"',
    );
    expect(workflow).not.toContain("ssh_root=$(mktemp -d)\n");
    expect(workflow).toContain("expected_deployed_sha=$3");
    expect(workflow).toContain(
      'test "$production_sha" = "$expected_deployed_sha"',
    );
    expect(workflow).toContain('test "$container_sha" = "$production_sha"');
    expect(workflow).toContain(
      "base64 -d <<'PII_SAFE_INSPECTOR_PAYLOAD' | docker exec -i st-michael-api",
    );
    expect(workflow).toContain(
      'test "$actual_script_sha" = "$expected_script_sha"',
    );
    expect(workflow).toContain(
      "mktemp /app/scripts/.inspect-amo-fixation-queue.XXXXXX",
    );
    expect(workflow).not.toContain(
      "mktemp /app/scripts/.inspect-amo-fixation-queue.XXXXXX.js",
    );
    expect(workflow).toContain("trap cleanup EXIT HUP INT TERM");
    expect(workflow.match(/\bssh -T\b/g) || []).toHaveLength(1);
    expect(workflow).not.toMatch(
      /appleboy\/ssh-action|git fetch|git reset|git checkout|git show|docker cp/,
    );
    expect(workflow).not.toContain('test "$container_sha" = "$EXPECTED_SHA"');
    expect(workflow).not.toContain('test "$container_sha" = "$expected_sha"');
    expect(workflow).not.toMatch(
      /echo[^\n]*(?:GH_TOKEN|health_body)|set\s+-[^\n]*x/,
    );
  });
});
