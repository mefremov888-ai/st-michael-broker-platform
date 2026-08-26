import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";

describe("exact-cohort amo fixation lead reconciliation apply", () => {
  const repositoryRoot = resolve(__dirname, "../../../..");
  const applyPath = resolve(
    repositoryRoot,
    "scripts/apply-amo-fixation-lead-reconciliation.js",
  );
  const inspectorPath = resolve(
    repositoryRoot,
    "scripts/inspect-amo-fixation-lead-reconciliation.js",
  );
  const workflowPath = resolve(
    repositoryRoot,
    ".github/workflows/apply-production-amo-fixation-lead-reconciliation.yml",
  );
  const applySource = readFileSync(applyPath, "utf8");
  const inspectorSource = readFileSync(inspectorPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");
  const NodeModule = jest.requireActual("module") as any;

  const loadCommonJs = (pathname: string, source: string) => {
    const loaded = new NodeModule(pathname, module);
    loaded.filename = pathname;
    loaded.paths = NodeModule._nodeModulePaths(dirname(pathname));
    loaded._compile(source, pathname);
    return loaded.exports as any;
  };

  const repair = loadCommonJs(applyPath, applySource);
  const inspector = loadCommonJs(inspectorPath, inspectorSource);
  const metadata = {
    inspectorSha256: "a".repeat(64),
    deployedGitSha: "b".repeat(40),
  };
  const attestationKey = Buffer.alloc(32, 0x31);
  const aliasKey = Buffer.alloc(32, 0x42);
  const casLinkEligibleErrors: Array<[string, string]> = [
    [
      "AMO_CREATE_RECONCILIATION_REQUIRED: private payload",
      "create_reconciliation_required",
    ],
    ["fetch failed: ECONNRESET", "network_failure"],
    ["FIXATION_AGENCY_MISSING", "fixation_agency_missing"],
    ["BROKER_AMO_CONTACT_MISSING", "broker_amo_contact_missing"],
  ];

  const queueRow = (overrides: Record<string, unknown> = {}) => ({
    id: "3fc34e89-8a22-4630-81d4-b3a87653d2cb",
    brokerId: "24e7bdeb-20bd-4f3f-83d6-6db564531896",
    responsibleBrokerId: null,
    phone: "+7 (999) 123-45-67",
    project: "ZORGE9",
    createdAt: new Date("2026-08-25T07:27:50.500Z"),
    updatedAt: new Date("2026-08-25T07:30:01.000Z"),
    amoLeadId: null,
    amoSyncStatus: "FAILED",
    amoSyncAttempts: 10,
    amoSyncLastAttemptAt: new Date("2026-08-25T07:30:00.000Z"),
    amoSyncError: "AMO_CREATE_RECONCILIATION_REQUIRED: private payload",
    broker: {
      id: "24e7bdeb-20bd-4f3f-83d6-6db564531896",
      amoContactId: BigInt(900001),
    },
    responsibleBroker: null,
    ...overrides,
  });

  const fixedCohort = (primary = queueRow()) => [
    primary,
    ...Array.from({ length: repair.KNOWN_QUEUE_ROWS - 1 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      const brokerSuffix = String(index + 20).padStart(12, "0");
      const brokerId = `20000000-0000-4000-8000-${brokerSuffix}`;
      return queueRow({
        id: `10000000-0000-4000-8000-${suffix}`,
        brokerId,
        phone: `invalid-phone-${index + 1}`,
        amoSyncError: null,
        broker: { id: brokerId, amoContactId: BigInt(910000 + index) },
      });
    }),
  ];

  const observedLegacyErrorCohort = () =>
    fixedCohort(queueRow({ amoSyncError: "fetch failed: ECONNRESET" })).map(
      (row, index) => ({
        ...row,
        amoSyncError:
          index === 0
            ? "fetch failed: ECONNRESET"
            : index === repair.KNOWN_QUEUE_ROWS - 1
              ? "FIXATION_AGENCY_MISSING"
              : "BROKER_AMO_CONTACT_MISSING",
      }),
    );

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

  const strongReport = (primary = queueRow()) => {
    const rows = fixedCohort(primary);
    const amoEvidence = evidence([leadEnvelope(32310587)]);
    return {
      rows,
      amoEvidence,
      report: inspector.buildReport(
        rows,
        amoEvidence,
        metadata,
        attestationKey,
        aliasKey,
      ),
    };
  };

  const gateEnvironment = (report = strongReport().report) => {
    return {
      LEAD_RECONCILIATION_CONFIRMATION: repair.EXACT_CONFIRMATION,
      LEAD_RECONCILIATION_SOURCE_SHA: metadata.deployedGitSha,
      LEAD_RECONCILIATION_CONFIRM_EXACT_SHA: metadata.deployedGitSha,
      LEAD_RECONCILIATION_DEPLOYED_GIT_SHA: metadata.deployedGitSha,
      LEAD_RECONCILIATION_REVIEWED_INSPECTOR_RUN_ID: "32960000001",
      LEAD_RECONCILIATION_EXPECTED_COHORT_DIGEST:
        report.cohortAttestation.hmacSha256,
      LEAD_RECONCILIATION_INSPECTOR_SHA256: metadata.inspectorSha256,
      LEAD_RECONCILIATION_APPLY_SHA256: "c".repeat(64),
      LEAD_RECONCILIATION_EXPECTED_QUEUE_ROWS: "12",
      LEAD_RECONCILIATION_EXPECTED_REQUEUE_COUNT: "0",
      LEAD_RECONCILIATION_EXPECTED_CAS_COUNT: "1",
      LEAD_RECONCILIATION_EXPECTED_SHARED_STRONG_COUNT: "0",
      LEAD_RECONCILIATION_EXPECTED_RESOLUTION_MANIFEST:
        repair.formatFixedManifest(
          report.aggregates.resolution,
          repair.RESOLUTION_CLASSES,
        ),
      LEAD_RECONCILIATION_EXPECTED_ERROR_MANIFEST: repair.formatFixedManifest(
        report.aggregates.errorClass,
        repair.ERROR_CLASSES,
      ),
    };
  };

  const validCompletionLedger = (gate: any, errorClass: string) => {
    const clientId = queueRow().id;
    const common = {
      schemaVersion: 1,
      source: repair.APPLY_AUDIT_SOURCE,
      sourceSha: gate.sourceSha,
      reviewedRunId: gate.reviewedRunId,
      cohortDigest: gate.expectedCohortDigest,
      inspectorSha256: gate.inspectorSha256,
      applySha256: gate.applySha256,
    };
    const rowPayload = {
      ...common,
      clientId,
      amoLeadId: "32310587",
      resolution: "single_strong_candidate",
      errorClass,
      sourceRowHash: "e".repeat(64),
      amoSyncAttempts: 10,
      amoSyncLastAttemptAt: "2026-08-25T07:30:00.000Z",
      attemptsPreserved: true,
      lastAttemptPreserved: true,
      requeued: false,
      amoMutation: false,
    };
    return {
      completion: [
        {
          entityId: repair.completionEntityId(
            gate.sourceSha,
            gate.expectedCohortDigest,
          ),
          payload: {
            ...common,
            queueRows: 12,
            linked: 1,
            blocked: 11,
            requeued: 0,
            amoMutations: 0,
            links: [{ clientId, amoLeadId: "32310587" }],
          },
        },
      ],
      rows: [{ entityId: clientId, payload: rowPayload }],
    };
  };

  it("contains only a three-field client CAS and no retry or amo mutation path", () => {
    expect(applySource).toContain("SET amo_lead_id =");
    expect(applySource).toContain(
      "amo_sync_status = 'SYNCED'::\"AmoSyncStatus\"",
    );
    expect(applySource).toContain("amo_sync_error = NULL");
    const updateSet = applySource.match(/UPDATE clients[\s\S]*?WHERE id/)?.[0];
    expect(updateSet).toBeDefined();
    expect(updateSet).not.toMatch(
      /amo_sync_attempts\s*=|amo_sync_last_attempt_at\s*=|updated_at\s*=|phone\s*=|project\s*=/,
    );
    expect(applySource).not.toMatch(
      /retry-failed|retryFailed|force-sync|createLead|updateLead|deleteLead|method:\s*["'](?:POST|PATCH|PUT|DELETE)["']/,
    );
    expect(applySource).toContain("EXPECTED_REQUEUE_COUNT = 0");
    expect(applySource).toContain("requeued: false");
    expect(applySource).toContain("amoMutation: false");
    expect(applySource).toContain("inspector.collectAmoEvidence(");
    expect(applySource).toContain("inspector.inspectQueueRow(");
    expect(applySource).not.toContain("strongCandidates[0].leadHash");
  });

  it("requires every exact operator gate and fixed manifest order", () => {
    const gate = repair.readExecutionGate(gateEnvironment());
    expect(gate).toMatchObject({
      sourceSha: metadata.deployedGitSha,
      reviewedRunId: "32960000001",
      expectedCasCount: 1,
      expectedSharedStrongCount: 0,
    });

    for (const [field, value] of [
      ["LEAD_RECONCILIATION_CONFIRMATION", "wrong"],
      ["LEAD_RECONCILIATION_CONFIRM_EXACT_SHA", "d".repeat(40)],
      ["LEAD_RECONCILIATION_DEPLOYED_GIT_SHA", "d".repeat(40)],
      ["LEAD_RECONCILIATION_REVIEWED_INSPECTOR_RUN_ID", "12"],
      ["LEAD_RECONCILIATION_EXPECTED_COHORT_DIGEST", "short"],
      ["LEAD_RECONCILIATION_EXPECTED_QUEUE_ROWS", "11"],
      ["LEAD_RECONCILIATION_EXPECTED_REQUEUE_COUNT", "1"],
      ["LEAD_RECONCILIATION_EXPECTED_SHARED_STRONG_COUNT", "1"],
    ]) {
      expect(() =>
        repair.readExecutionGate({ ...gateEnvironment(), [field]: value }),
      ).toThrow("amo fixation lead reconciliation failed");
    }

    const swapped = gateEnvironment();
    const entries =
      swapped.LEAD_RECONCILIATION_EXPECTED_RESOLUTION_MANIFEST.split(",");
    [entries[0], entries[1]] = [entries[1], entries[0]];
    swapped.LEAD_RECONCILIATION_EXPECTED_RESOLUTION_MANIFEST =
      entries.join(",");
    expect(() => repair.readExecutionGate(swapped)).toThrow(
      "amo fixation lead reconciliation failed",
    );
  });

  it("allows only one exact-contact, one-strong, no-weak reconciliation row", () => {
    const { rows, amoEvidence, report } = strongReport();
    const gate = repair.readExecutionGate(gateEnvironment());
    expect(() => repair.assertReportMatchesGate(report, gate)).not.toThrow();
    const plan = repair.buildExecutionPlan(rows, amoEvidence, inspector);
    expect(() => repair.assertExactPlan(plan, gate)).not.toThrow();
    expect(plan).toMatchObject({
      actionable: [
        {
          resolution: "single_strong_candidate",
          errorClass: "create_reconciliation_required",
          candidateLeadId: 32310587,
          exactClientContactCount: 1,
          strongCount: 1,
          weakCount: 0,
        },
      ],
    });
    expect(plan.blocked).toHaveLength(11);
  });

  it.each(casLinkEligibleErrors)(
    "links one exact strong lead for the signed legacy error class %s",
    (amoSyncError, errorClass) => {
      const { rows, amoEvidence, report } = strongReport(
        queueRow({ amoSyncError }),
      );
      const gate = repair.readExecutionGate(gateEnvironment(report));
      expect(repair.CAS_LINK_ELIGIBLE_ERROR_CLASSES).toEqual(
        casLinkEligibleErrors.map(([, value]) => value),
      );
      expect(inspector.CAS_LINK_ELIGIBLE_ERROR_CLASSES).toEqual(
        repair.CAS_LINK_ELIGIBLE_ERROR_CLASSES,
      );
      expect(() => repair.assertReportMatchesGate(report, gate)).not.toThrow();
      const plan = repair.buildExecutionPlan(rows, amoEvidence, inspector);
      expect(() => repair.assertExactPlan(plan, gate)).not.toThrow();
      expect(plan.actionable).toHaveLength(1);
      expect(plan.actionable[0]).toMatchObject({
        resolution: "single_strong_candidate",
        errorClass,
        candidateLeadId: 32310587,
        exactClientContactCount: 1,
        strongCount: 1,
        weakCount: 0,
      });
      expect(plan.blocked).toHaveLength(11);
    },
  );

  it("matches the observed signed 10/1/1 legacy error manifest with zero requeue", () => {
    const rows = observedLegacyErrorCohort();
    const amoEvidence = evidence([leadEnvelope(32310587)]);
    const report = inspector.buildReport(
      rows,
      amoEvidence,
      metadata,
      attestationKey,
      aliasKey,
    );
    expect(report.aggregates.errorClass).toMatchObject({
      broker_amo_contact_missing: 10,
      network_failure: 1,
      fixation_agency_missing: 1,
      create_reconciliation_required: 0,
    });
    expect(report.aggregates.rowsWithCasLinkCandidate).toBe(1);
    const gate = repair.readExecutionGate(gateEnvironment(report));
    expect(gate.expected.errorClass).toEqual(report.aggregates.errorClass);
    const plan = repair.buildExecutionPlan(rows, amoEvidence, inspector);
    expect(() => repair.assertExactPlan(plan, gate)).not.toThrow();
    expect(plan.actionable).toHaveLength(1);
    expect(plan.actionable[0].errorClass).toBe("network_failure");
    expect(repair.EXPECTED_REQUEUE_COUNT).toBe(0);
  });

  it("blocks no-candidate, strong-plus-weak and two-strong rows", () => {
    const noCandidateRows = fixedCohort();
    const noCandidate = repair.buildExecutionPlan(
      noCandidateRows,
      evidence([]),
      inspector,
    );
    expect(noCandidate.actionable).toHaveLength(0);
    expect(noCandidate.records[0].resolution).toBe("no_candidate");

    const strongPlusWeak = repair.buildExecutionPlan(
      fixedCohort(),
      evidence([
        leadEnvelope(32310587),
        leadEnvelope(32310600, {
          createdAt: 1779860000,
          requestValues: [],
          contactIds: [800001, 900001],
        }),
      ]),
      inspector,
    );
    expect(strongPlusWeak.actionable).toHaveLength(0);
    expect(strongPlusWeak.records[0].resolution).toBe(
      "single_strong_with_weak_candidates",
    );

    const twoStrong = repair.buildExecutionPlan(
      fixedCohort(),
      evidence([leadEnvelope(32310587), leadEnvelope(32310589)]),
      inspector,
    );
    expect(twoStrong.actionable).toHaveLength(0);
    expect(twoStrong.records[0].resolution).toBe("multiple_strong_candidates");
  });

  it.each([
    ["AMO_TEMPORARY_UNAVAILABLE", "temporary_unavailable"],
    ["UNRECOGNIZED_LEGACY_FAILURE", "other"],
  ])(
    "blocks an unsafe or unknown error class even with exact strong evidence: %s",
    (amoSyncError, errorClass) => {
      const { rows, amoEvidence, report } = strongReport(
        queueRow({ amoSyncError }),
      );
      expect(report.aggregates.rowsWithCasLinkCandidate).toBe(0);
      const plan = repair.buildExecutionPlan(rows, amoEvidence, inspector);
      expect(plan.actionable).toHaveLength(0);
      expect(plan.records[0]).toMatchObject({
        resolution: "single_strong_candidate",
        errorClass,
        eligible: false,
      });
    },
  );

  it("fails closed when one strong lead is shared by two cohort rows", () => {
    const second = queueRow({
      id: "4fc34e89-8a22-4630-81d4-b3a87653d2cc",
    });
    const rows = [queueRow(), second, ...fixedCohort().slice(2)];
    expect(() =>
      repair.buildExecutionPlan(
        rows,
        evidence([leadEnvelope(32310587)]),
        inspector,
      ),
    ).toThrow("amo fixation lead reconciliation failed");
  });

  it("checks candidate occupancy under the global client writer lock", async () => {
    const plan = repair.buildExecutionPlan(
      strongReport().rows,
      strongReport().amoEvidence,
      inspector,
    );
    await expect(
      repair.checkCandidateOccupancy(
        { client: { findMany: jest.fn(async () => []) } },
        plan.actionable,
      ),
    ).resolves.toBeUndefined();
    await expect(
      repair.checkCandidateOccupancy(
        {
          client: {
            findMany: jest.fn(async () => [
              { id: "occupied-client", amoLeadId: 32310587n },
            ]),
          },
        },
        plan.actionable,
      ),
    ).rejects.toThrow("amo fixation lead reconciliation failed");
  });

  it("uses a strict CAS and fails when the database row no longer matches", async () => {
    const { rows, amoEvidence } = strongReport();
    const record = repair.buildExecutionPlan(rows, amoEvidence, inspector)
      .actionable[0];
    const Prisma = {
      join: (values: unknown[]) => values,
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings: [...strings],
        values,
      }),
    };
    const queryRaw: jest.Mock = jest.fn(async () => [{ id: record.row.id }]);
    await expect(
      repair.casLinkClient({ $queryRaw: queryRaw }, Prisma, record),
    ).resolves.toBeUndefined();
    const sql = queryRaw.mock.calls[0][0].strings.join("?");
    expect(sql).toContain("amo_lead_id IS NULL");
    expect(sql).toContain("amo_sync_attempts =");
    expect(sql).toContain("amo_sync_last_attempt_at IS NOT DISTINCT FROM");
    expect(sql).toContain("updated_at =");
    expect(sql).toContain("phone =");
    expect(sql).toContain("project::text =");
    await expect(
      repair.casLinkClient(
        { $queryRaw: jest.fn(async () => []) },
        Prisma,
        record,
      ),
    ).rejects.toThrow("amo fixation lead reconciliation failed");
  });

  it("detects every queue snapshot or amo plan drift between scans", () => {
    const { rows, amoEvidence } = strongReport();
    const before = repair.buildExecutionPlan(rows, amoEvidence, inspector);
    for (const override of [
      { phone: "+79990000000" },
      { project: "SILVER_BOR" },
      { amoSyncStatus: "PENDING" },
      { amoSyncAttempts: 11 },
      { amoSyncLastAttemptAt: new Date("2026-08-25T07:30:01Z") },
      {
        broker: {
          id: rows[0].broker.id,
          amoContactId: 900002n,
        },
      },
    ]) {
      const changedRows = [queueRow(override), ...rows.slice(1)];
      const changed = repair.buildExecutionPlan(
        changedRows,
        amoEvidence,
        inspector,
      );
      expect(repair.planIdentity(changed, inspector)).not.toBe(
        repair.planIdentity(before, inspector),
      );
    }

    const changedLead = repair.buildExecutionPlan(
      rows,
      evidence([leadEnvelope(32310589)]),
      inspector,
    );
    expect(repair.planIdentity(changedLead, inspector)).not.toBe(
      repair.planIdentity(before, inspector),
    );
  });

  it("fails on cohorts of 11 or 13 and on count/HMAC drift", () => {
    expect(() =>
      inspector.assertExpectedQueueRows(fixedCohort().slice(1)),
    ).toThrow("Exhausted queue cohort count changed");
    expect(() =>
      inspector.assertExpectedQueueRows([...fixedCohort(), queueRow()]),
    ).toThrow("Exhausted queue cohort count changed");

    const { report } = strongReport();
    const gate = repair.readExecutionGate(gateEnvironment());
    for (const changed of [
      {
        ...report,
        cohortAttestation: {
          ...report.cohortAttestation,
          hmacSha256: "f".repeat(64),
        },
      },
      {
        ...report,
        aggregates: {
          ...report.aggregates,
          rowsWithCasLinkCandidate: 2,
        },
      },
      {
        ...report,
        aggregates: {
          ...report.aggregates,
          strongLeadHashesSharedAcrossRows: 1,
        },
      },
    ]) {
      expect(() => repair.assertReportMatchesGate(changed, gate)).toThrow(
        "amo fixation lead reconciliation failed",
      );
    }
  });

  it("rejects final amo relationship, pipeline, project or candidate drift", () => {
    const row = queueRow();
    expect(() =>
      repair.assertFinalAmoEvidence(
        [row],
        evidence([leadEnvelope(32310587)]),
        [{ clientId: row.id, amoLeadId: 32310587 }],
        inspector,
      ),
    ).not.toThrow();
    for (const changedLead of [
      leadEnvelope(32310587, { pipelineId: 1 }),
      leadEnvelope(32310587, { contactIds: [800001] }),
      leadEnvelope(32310587, { projectValues: ["Берзарина 37"] }),
      leadEnvelope(32310589),
    ]) {
      expect(() =>
        repair.assertFinalAmoEvidence(
          [row],
          evidence([changedLead]),
          [{ clientId: row.id, amoLeadId: 32310587 }],
          inspector,
        ),
      ).toThrow("amo fixation lead reconciliation failed");
    }
  });

  it("validates one exact completion ledger and rejects malformed or duplicate audits", () => {
    const gate = repair.readExecutionGate(gateEnvironment());
    const clientId = queueRow().id;
    const ledger = validCompletionLedger(
      gate,
      "create_reconciliation_required",
    );
    expect(repair.validateCompletionLedger(ledger, gate)).toMatchObject({
      links: [{ clientId, amoLeadId: 32310587 }],
    });
    expect(() =>
      repair.validateCompletionLedger(
        { ...ledger, rows: [...ledger.rows, ...ledger.rows] },
        gate,
      ),
    ).toThrow("amo fixation lead reconciliation failed");
    expect(() =>
      repair.validateCompletionLedger(
        {
          ...ledger,
          completion: [
            {
              ...ledger.completion[0],
              payload: {
                ...ledger.completion[0].payload,
                requeued: 1,
              },
            },
          ],
        },
        gate,
      ),
    ).toThrow("amo fixation lead reconciliation failed");
    expect(() =>
      repair.validateCompletionLedger(
        {
          ...ledger,
          completion: [
            {
              ...ledger.completion[0],
              payload: {
                ...ledger.completion[0].payload,
                unexpected: "unsafe",
              },
            },
          ],
        },
        gate,
      ),
    ).toThrow("amo fixation lead reconciliation failed");
  });

  it.each(casLinkEligibleErrors)(
    "validates the exact audit ledger for linked legacy class %s",
    (amoSyncError, errorClass) => {
      const { report } = strongReport(queueRow({ amoSyncError }));
      const gate = repair.readExecutionGate(gateEnvironment(report));
      const ledger = validCompletionLedger(gate, errorClass);
      expect(repair.validateCompletionLedger(ledger, gate)).toMatchObject({
        links: [{ clientId: queueRow().id, amoLeadId: 32310587 }],
      });
    },
  );

  it("rejects unsafe, unknown and signed-manifest-mismatched audit classes", () => {
    const gate = repair.readExecutionGate(gateEnvironment());
    for (const errorClass of [
      "temporary_unavailable",
      "other",
      // Allowed in another signed cohort, but absent from this gate's exact
      // aggregate manifest and therefore invalid for this completion ledger.
      "network_failure",
    ]) {
      expect(() =>
        repair.validateCompletionLedger(
          validCompletionLedger(gate, errorClass),
          gate,
        ),
      ).toThrow("amo fixation lead reconciliation failed");
    }
  });

  it("keeps failures and stdout bounded and PII-free", () => {
    const output = jest.spyOn(process.stdout, "write").mockReturnValue(true);
    repair.writeSafeEvent({
      event: "lead_reconciliation_completed",
      schemaVersion: 1,
      sourceSha: "b".repeat(40),
      reviewedRunId: "32960000001",
      queueRows: 12,
      linked: 1,
      alreadyLinked: 0,
      blocked: 11,
      requeued: 0,
      amoMutations: 0,
    });
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0][0])).not.toMatch(
      /\+7|private|phone|email|amoLeadId|clientId|cohortDigest/i,
    );
    expect(() =>
      repair.writeSafeEvent({
        event: "unsafe",
        phone: "+79991234567",
      }),
    ).toThrow("amo fixation lead reconciliation failed");
    expect(repair.safeFailureCode(new Error("private-token"))).toBe(
      "UNCLASSIFIED_FAILURE",
    );
    output.mockRestore();
  });

  it("does every GET scan before the short globally locked write transaction", async () => {
    expect(applySource).toContain('isolationLevel: "Serializable"');
    expect(applySource).toContain("timeout: TRANSACTION_TIMEOUT_MS");
    expect(repair.TRANSACTION_TIMEOUT_MS).toBe(300_000);
    const transactionBody = applySource.match(
      /async function executeFirstApply[\s\S]*?async function main/,
    )?.[0];
    expect(transactionBody).toBeDefined();
    expect(transactionBody).not.toContain("collectAmoEvidence");
    expect(transactionBody).not.toContain("requestGet");
    expect(transactionBody).toContain("await casLinkClient(");
    expect(transactionBody).toContain("await createRowAudit(");
    expect(transactionBody).toContain("await createCompletionAudit(");
    expect(transactionBody!.indexOf("await lockClientWriters(")).toBeLessThan(
      transactionBody!.indexOf("await acquireRepairAdvisoryLock("),
    );
    expect(
      transactionBody!.indexOf("await acquireRepairAdvisoryLock("),
    ).toBeLessThan(transactionBody!.indexOf("await findRepairLedger("));
    expect(transactionBody!.indexOf("await lockClientWriters(")).toBeLessThan(
      transactionBody!.indexOf("await loadExactCohort("),
    );
    expect(transactionBody!.indexOf("await lockClientWriters(")).toBeLessThan(
      transactionBody!.indexOf("await checkCandidateOccupancy("),
    );
    expect(transactionBody!.indexOf("await lockClientWriters(")).toBeLessThan(
      transactionBody!.indexOf("await casLinkClient("),
    );
    const preWriteBody = applySource.match(
      /async function collectPreWriteScans[\s\S]*?async function executeFirstApply/,
    )?.[0];
    expect(preWriteBody).toContain("scan <= 3");
    expect(preWriteBody).toContain("inspector.collectAmoEvidence(");
    expect(preWriteBody).not.toContain("$transaction");
    const idempotentBody = applySource.match(
      /async function tryCompletedNoop[\s\S]*?function assertCompletedDatabaseState/,
    )?.[0];
    expect(idempotentBody!.indexOf("collectAmoEvidence(")).toBeLessThan(
      idempotentBody!.indexOf("prisma.$transaction("),
    );
    const idempotentTransaction = idempotentBody!.slice(
      idempotentBody!.indexOf("prisma.$transaction("),
    );
    expect(
      idempotentTransaction.indexOf("await lockClientWriters("),
    ).toBeLessThan(
      idempotentTransaction.indexOf("await acquireRepairAdvisoryLock("),
    );
    expect(
      idempotentTransaction.indexOf("await acquireRepairAdvisoryLock("),
    ).toBeLessThan(idempotentTransaction.indexOf("await findRepairLedger("));
    expect(
      idempotentTransaction.indexOf("await lockClientWriters("),
    ).toBeLessThan(
      idempotentTransaction.indexOf("transaction.client.findMany("),
    );
    expect(applySource).not.toContain("FOR UPDATE");
    expect(applySource.match(/prisma\.\$transaction\s*\(/g) || []).toHaveLength(
      2,
    );

    const executeRaw: jest.Mock = jest.fn(async () => 0);
    await repair.lockClientWriters({ $executeRaw: executeRaw });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.calls[0][0].join(" ")).toBe(
      "LOCK TABLE clients IN SHARE ROW EXCLUSIVE MODE",
    );
    expect(applySource).toContain("commit-time");
    expect(applySource).toContain("invariant only");
    expect(applySource).toContain("transaction's first SQL statement");
    expect(applySource).toContain("latest committed client state");
    expect(applySource).toContain("permanent uniqueness after commit");
  });

  it("delegates all amo access to the exact inspector GET requester and fails on HTTP errors", async () => {
    expect(applySource).not.toMatch(/\bfetch\s*\(|node:https|node:http|axios/);
    expect(applySource).toContain("inspector.createGetOnlyRequester(");
    const rejected = inspector.createGetOnlyRequester(
      "private-token",
      jest.fn(async () => ({
        status: 401,
        ok: false,
        headers: { get: () => null },
        body: { cancel: jest.fn(async () => undefined) },
      })),
    );
    await expect(rejected("/api/v4/account")).rejects.toThrow(
      "amoCRM request rejected",
    );
    expect(inspectorSource).toContain("response?.status === 429");
    expect(inspectorSource).toContain("Number(response?.status) >= 500");
    expect(inspectorSource).toContain(
      'throw new Error("amoCRM request failed")',
    );
  });

  it("exhausts bounded GET retries for 429 and 5xx without exposing a write path", async () => {
    await Promise.all(
      [429, 503].map(async (status) => {
        const body = { cancel: jest.fn(async () => undefined) };
        const fetchMock: jest.Mock = jest.fn(async () => ({
          status,
          ok: false,
          headers: { get: () => null },
          body,
        }));
        const request = inspector.createGetOnlyRequester(
          "private-token",
          fetchMock,
        );
        await expect(request("/api/v4/account")).rejects.toThrow(
          "amoCRM request failed",
        );
        expect(fetchMock).toHaveBeenCalledTimes(4);
        for (const call of fetchMock.mock.calls) {
          expect(call[1]).toMatchObject({ method: "GET" });
        }
      }),
    );
  }, 10_000);

  it("provides an exact-run, exact-SHA, exclusive-lock production workflow", () => {
    const parsed = parse(workflow) as any;
    const workflowShell = parsed.jobs.apply.steps[1].run as string;
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
    )}\nY29uc29sZS5sb2coInNhZmUiKTs=\nPII_SAFE_LEAD_LINK_APPLY_PAYLOAD\nexpected_payload_sha=${"d".repeat(
      64,
    )}\n${workflowShell.slice(suffixStart, suffixEnd)}\n`;
    const remoteSyntax = spawnSync(bash, ["-n"], {
      input: generatedRemoteShell,
      encoding: "utf8",
    });
    expect(remoteSyntax.stderr).toBe("");
    expect(remoteSyntax.status).toBe(0);

    expect(parsed.permissions).toEqual({ contents: "read", actions: "read" });
    expect(workflow).toContain("group: production-deploy");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("flock -x -n 9");
    expect(workflow).toContain('EXPECTED_QUEUE_ROWS: "12"');
    expect(workflow).toContain('EXPECTED_REQUEUE_COUNT: "0"');
    expect(workflow).not.toContain("inputs.expected_queue_rows");
    expect(workflow).not.toContain("inputs.expected_requeue_count");
    expect(workflow).toContain(
      "inspect-production-amo-fixation-lead-reconciliation.yml",
    );
    for (const exactRunGate of [
      "(.id | tostring) == $run_id",
      ".repository.full_name == $repository",
      ".head_repository.full_name == $repository",
      ".path == $workflow",
      '.event == "workflow_dispatch"',
      ".run_attempt == 1",
      '.status == "completed"',
      '.conclusion == "success"',
      '.head_branch == "master"',
      ".head_sha == $sha",
      'test "$reviewed_age" -ge 0 -a "$reviewed_age" -lt 86400',
    ]) {
      expect(workflow).toContain(exactRunGate);
    }
    expect(workflow).toContain('test "$deployed_sha" = "$REQUEST_EXACT_SHA"');
    expect(workflow).toContain('test "$container_sha" = "$production_sha"');
    expect(workflow).toContain('test "$actual_apply_sha" = "$apply_sha"');
    expect(workflow).toContain(
      'test "$actual_inspector_sha" = "$inspector_sha"',
    );
    expect(workflow).toContain(
      'export BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE="$key_file"',
    );
    expect(workflow.match(/\bssh -T\b/g) || []).toHaveLength(1);
    expect(workflow).not.toMatch(
      /appleboy\/ssh-action|git fetch|git reset|git checkout|git show|docker cp/,
    );
  });
});
