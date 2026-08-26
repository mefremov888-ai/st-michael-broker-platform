import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";
import { brokerToAmoContactFields } from "../../../../packages/integrations/src/amo-crm.fields";
import {
  AMO_BROKER_CONTACT_LOCK_DOMAIN,
  amoBrokerContactAdvisoryLockKey,
  amoBrokerContactGateDigest,
} from "../common/amo-broker-contact-lock";

describe("production-safe amo broker-contact provisioner", () => {
  process.env.BROKER_CONTACT_GATE_HMAC_KEY =
    "test-explicit-broker-contact-gate-key-32-bytes";
  delete process.env.BROKER_CONTACT_GATE_HMAC_KEY_FILE;
  const repositoryRoot = resolve(__dirname, "../../../..");
  const scriptPath = resolve(
    repositoryRoot,
    "scripts/apply-amo-broker-contact-provisioning.js",
  );
  const inspectorPath = resolve(
    repositoryRoot,
    "scripts/inspect-amo-broker-link-repair-plan.js",
  );
  const workflowPath = resolve(
    repositoryRoot,
    ".github/workflows/apply-production-amo-broker-contact-provisioning.yml",
  );
  const script = readFileSync(scriptPath, "utf8");
  const inspectorScript = readFileSync(inspectorPath, "utf8");
  const inspectorSha256 = createHash("sha256")
    .update(inspectorScript)
    .digest("hex");
  const workflow = readFileSync(workflowPath, "utf8");
  const NodeModule = jest.requireActual("module") as any;

  function compileCommonJs(path: string, source: string): any {
    const loaded = new NodeModule(path, module);
    loaded.filename = path;
    loaded.paths = NodeModule._nodeModulePaths(dirname(path));
    loaded._compile(source, path);
    return loaded.exports;
  }

  const provisioner = compileCommonJs(scriptPath, script);
  provisioner.injectGateHmacKeyForTests(
    "test-explicit-broker-contact-gate-key-32-bytes",
  );
  const inspector = compileCommonJs(inspectorPath, inspectorScript);

  const isoDate = new Date("2026-08-26T00:00:00.000Z");
  const sourceSha = "a".repeat(40);
  const cohortAttestationKey = "cohort-attestation-test-key-32-bytes-minimum";
  const expectedCohortDigest = "c".repeat(64);
  const requestId = `provision_${"b".repeat(32)}`;

  function broker(overrides: Record<string, any> = {}) {
    return {
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
      brokerTourVisited: true,
      brokerTourDate: isoDate,
      doNotCall: true,
      mergedIntoId: null,
      updatedAt: isoDate,
      phones: [],
      brokerAgencies: [
        {
          id: "broker-agency-1",
          agencyId: "agency-1",
          isPrimary: true,
          joinedAt: isoDate,
          agency: {
            id: "agency-1",
            name: "Test Agency",
            inn: "7700000000",
            address: "Test address",
          },
        },
      ],
      ...overrides,
    };
  }

  function queueRow(id: string, effective: any, overrides: any = {}) {
    return {
      id,
      brokerId: effective.id,
      responsibleBrokerId: null,
      amoLeadId: null,
      fixationAgencyId: "agency-1",
      amoSyncStatus: "FAILED",
      amoSyncAttempts: 10,
      amoSyncError: "BROKER_AMO_CONTACT_MISSING",
      broker: effective,
      responsibleBroker: null,
      ...overrides,
    };
  }

  function directQueue(row: any) {
    return {
      id: row.id,
      brokerId: row.brokerId,
      responsibleBrokerId: row.responsibleBrokerId,
      amoLeadId: row.amoLeadId,
      fixationAgencyId: row.fixationAgencyId,
      amoSyncStatus: row.amoSyncStatus,
      amoSyncAttempts: row.amoSyncAttempts,
      amoSyncError: row.amoSyncError,
    };
  }

  function amoContact(id: number, phone: string, brokerFlag: boolean) {
    return {
      id,
      custom_fields_values: [
        { field_id: 557903, values: [{ value: phone }] },
        { field_id: 835415, values: [{ value: brokerFlag }] },
      ],
    };
  }

  function contactsPage(contacts: any[]) {
    return { _embedded: { contacts }, _links: {} };
  }

  function liveManifest() {
    const groups = Object.fromEntries(
      provisioner.RESOLUTION_CLASSES.map((key: string) => [key, 0]),
    );
    const rows = { ...groups };
    Object.assign(groups, {
      link_existing_broker_contact: 1,
      promote_existing_contact_candidate: 1,
      create_contact_candidate: 6,
      already_linked: 1,
    });
    Object.assign(rows, {
      link_existing_broker_contact: 1,
      promote_existing_contact_candidate: 2,
      create_contact_candidate: 8,
      already_linked: 1,
    });
    return { queueRows: 12, effectiveBrokerGroups: 9, groups, rows };
  }

  function gateEnv() {
    const manifest = liveManifest();
    const env: Record<string, string> = {
      PROVISION_CONFIRMATION: "PROVISION_AMO_BROKER_CONTACTS",
      PROVISION_CONFIRM_EXACT_SHA: sourceSha,
      PROVISION_SOURCE_SHA: sourceSha,
      PROVISION_REVIEWED_PLAN_RUN_ID: "39947094767",
      PROVISION_EXPECTED_COHORT_DIGEST: expectedCohortDigest,
      BROKER_CONTACT_INSPECTOR_SHA256: inspectorSha256,
      BROKER_CONTACT_DEPLOYED_GIT_SHA: sourceSha,
      EXPECTED_QUEUE_ROWS: String(manifest.queueRows),
      EXPECTED_EFFECTIVE_BROKER_GROUPS: String(manifest.effectiveBrokerGroups),
    };
    for (const resolution of provisioner.RESOLUTION_CLASSES) {
      const name = resolution.toUpperCase();
      env[`EXPECTED_${name}_GROUPS`] = String(manifest.groups[resolution]);
      env[`EXPECTED_${name}_ROWS`] = String(manifest.rows[resolution]);
    }
    return env;
  }

  it("requires exact confirmation, exact SHA, reviewed run and every class count", () => {
    expect(provisioner.readExecutionGate(gateEnv())).toEqual({
      sourceSha,
      inspectorSha256,
      deployedGitSha: sourceSha,
      expectedCohortDigest,
      reviewedPlanRunId: "39947094767",
      expected: liveManifest(),
    });

    for (const [field, value, code] of [
      ["PROVISION_CONFIRMATION", "wrong", "CONFIRMATION_REQUIRED"],
      [
        "PROVISION_CONFIRM_EXACT_SHA",
        "b".repeat(40),
        "SOURCE_SHA_CONFIRMATION_MISMATCH",
      ],
      [
        "PROVISION_REVIEWED_PLAN_RUN_ID",
        "invalid",
        "REVIEWED_PLAN_RUN_ID_INVALID",
      ],
      [
        "PROVISION_EXPECTED_COHORT_DIGEST",
        "same-count-swap",
        "EXPECTED_COHORT_DIGEST_INVALID",
      ],
      ["BROKER_CONTACT_INSPECTOR_SHA256", "bad", "INSPECTOR_SHA256_INVALID"],
      [
        "BROKER_CONTACT_DEPLOYED_GIT_SHA",
        "b".repeat(40),
        "DEPLOYED_SHA_MISMATCH",
      ],
      ["EXPECTED_QUEUE_ROWS", "012", "INVALID_EXPECTED_QUEUE_ROWS"],
      [
        "EXPECTED_CREATE_CONTACT_CANDIDATE_ROWS",
        "",
        "INVALID_EXPECTED_CREATE_CONTACT_CANDIDATE_ROWS",
      ],
    ]) {
      const env = gateEnv();
      env[field] = value;
      expect(() => provisioner.readExecutionGate(env)).toThrow(
        expect.objectContaining({ code }),
      );
    }
  });

  it("rejects a same-count cohort swap and exact inspector-source drift", () => {
    const source = broker({ id: "attested", phone: "+79990000021" });
    const queue = [queueRow("queue-attested", source)];
    const lookups = new Map([
      [source.phone, { contacts: [], pagesRead: 1, contactsRead: 0 }],
    ]);
    const reviewed = inspector.buildCohortAttestation(
      queue,
      [source],
      lookups,
      cohortAttestationKey,
      inspectorSha256,
      sourceSha,
    );
    const gate = {
      expectedCohortDigest: reviewed.digest,
      inspectorSha256,
      deployedGitSha: sourceSha,
    };
    expect(() =>
      provisioner.assertExpectedCohortAttestation(reviewed, gate),
    ).not.toThrow();

    const swapped = inspector.buildCohortAttestation(
      [queueRow("queue-same-count-replacement", source)],
      [source],
      lookups,
      cohortAttestationKey,
      inspectorSha256,
      sourceSha,
    );
    expect(() =>
      provisioner.assertExpectedCohortAttestation(swapped, gate),
    ).toThrow(expect.objectContaining({ code: "COHORT_ATTESTATION_MISMATCH" }));
    expect(() =>
      provisioner.loadPlanModule(inspectorPath, "0".repeat(64)),
    ).toThrow(expect.objectContaining({ code: "PLAN_MODULE_SHA_MISMATCH" }));
    expect(() =>
      provisioner.loadPlanModule(inspectorPath, inspectorSha256),
    ).not.toThrow();
  });

  it("enforces the reviewed 12/9 and per-class one-shot ceilings", () => {
    expect(() =>
      provisioner.assertReviewedRunCeilings(liveManifest()),
    ).not.toThrow();
    const tooMany = liveManifest();
    tooMany.groups.create_contact_candidate = 7;
    tooMany.rows.create_contact_candidate = 9;
    expect(() => provisioner.assertReviewedRunCeilings(tooMany)).toThrow(
      expect.objectContaining({
        code: "REVIEWED_RUN_TOTAL_CEILING_EXCEEDED",
      }),
    );
  });

  it("hard-binds the apply to every exact count from reviewed run 32947094767", () => {
    expect(provisioner.REVIEWED_RUN_MANIFEST).toEqual(liveManifest());
    expect(() =>
      provisioner.assertReviewedRunManifest(liveManifest()),
    ).not.toThrow();

    const paths: Array<["queueRows" | "effectiveBrokerGroups", string?]> = [
      ["queueRows"],
      ["effectiveBrokerGroups"],
    ];
    for (const resolution of provisioner.RESOLUTION_CLASSES) {
      paths.push(["queueRows", `groups.${resolution}`]);
      paths.push(["queueRows", `rows.${resolution}`]);
    }
    for (const [topLevel, nested] of paths) {
      const drifted = liveManifest();
      if (!nested) {
        drifted[topLevel] += 1;
      } else {
        const [bucket, resolution] = nested.split(".");
        drifted[bucket][resolution] += 1;
      }
      expect(() => provisioner.assertReviewedRunManifest(drifted)).toThrow(
        expect.objectContaining({ code: "EXACT_PLAN_COUNT_DRIFT" }),
      );
    }
  });

  it("rebuilds raw apply records consistently with the exact read-only inspector", () => {
    const link = broker({ id: "link", phone: "+79990000001" });
    const promote = broker({ id: "promote", phone: "+79990000002" });
    const create = broker({ id: "create", phone: "+79990000003" });
    const already = broker({
      id: "already",
      phone: "+79990000004",
      amoContactId: BigInt(404),
    });
    const queue = [
      queueRow("q-link", link),
      queueRow("q-promote", promote),
      queueRow("q-create", create),
      queueRow("q-already", already),
    ];
    const owners = [link, promote, create, already];
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
    ]);
    const report = inspector.buildProvisioningReport(
      queue,
      owners,
      lookups,
      isoDate,
      Buffer.alloc(32, 0x44),
    );
    const records = provisioner.buildInternalProvisioningPlan(
      queue,
      owners,
      lookups,
      inspector,
    );
    expect(provisioner.internalPlanManifest(records, queue.length)).toEqual(
      provisioner.reportManifest(report),
    );
    expect(records.map((record: any) => record.resolution).sort()).toEqual(
      [
        "already_linked",
        "create_contact_candidate",
        "link_existing_broker_contact",
        "promote_existing_contact_candidate",
      ].sort(),
    );
  });

  it("keeps the POST payload exactly aligned with brokerToAmoContactFields and omits amo-owned tour fields", () => {
    const source = broker();
    const payload = provisioner.buildBrokerCreatePayload(source);
    expect(payload).toEqual({
      name: source.fullName,
      custom_fields_values: brokerToAmoContactFields(
        source,
        source.brokerAgencies[0].agency,
      ),
    });
    expect(payload.custom_fields_values).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field_id: 842303 }),
        expect.objectContaining({ field_id: 842305 }),
      ]),
    );
  });

  it("blocks create when only an alternate phone is valid", () => {
    const source = broker({
      id: "invalid-primary",
      phone: "invalid",
      phones: [{ phone: "+79990000009" }],
    });
    const row = queueRow("q-invalid-primary", source);
    const records = provisioner.buildInternalProvisioningPlan(
      [row],
      [source],
      new Map([
        ["+79990000009", { contacts: [], pagesRead: 1, contactsRead: 0 }],
      ]),
      inspector,
    );
    expect(() => provisioner.assertExecutablePlan(records, inspector)).toThrow(
      expect.objectContaining({ code: "BROKER_PRIMARY_PHONE_INVALID" }),
    );
  });

  it("fails closed when any blocked resolution class is present", () => {
    expect(() =>
      provisioner.assertExecutablePlan(
        [{ resolution: "db_phone_ambiguous" }],
        inspector,
      ),
    ).toThrow(expect.objectContaining({ code: "PLAN_CONTAINS_BLOCKED_CLASS" }));
  });

  it("uses one POST with an echoed request_id and never retries a lost response", async () => {
    const responsePayload = {
      _embedded: {
        contacts: [{ id: 303, request_id: requestId }],
      },
    };
    const wire = JSON.stringify(responsePayload);
    const fetchOk = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(Buffer.byteLength(wire)) },
      text: async () => wire,
    });
    const request = provisioner.createOneShotMutationRequester(
      "token",
      inspector,
      fetchOk,
    );
    await expect(
      request({
        method: "POST",
        body: {
          ...provisioner.buildBrokerCreatePayload(broker()),
          request_id: requestId,
        },
      }),
    ).resolves.toEqual({
      accepted: true,
      uncertain: false,
      responseContactId: 303,
    });
    expect(fetchOk).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchOk.mock.calls[0][1].body)).toEqual([
      expect.objectContaining({ request_id: requestId }),
    ]);

    const fetchLost = jest
      .fn()
      .mockRejectedValue(new Error("secret network details"));
    const lostRequest = provisioner.createOneShotMutationRequester(
      "token",
      inspector,
      fetchLost,
    );
    await expect(
      lostRequest({ method: "POST", body: { request_id: requestId } }),
    ).resolves.toEqual({
      accepted: false,
      uncertain: true,
      responseContactId: null,
    });
    expect(fetchLost).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
    [429, true],
    [503, true],
  ])(
    "classifies one-shot POST HTTP %s uncertainty as %s",
    async (status, uncertain) => {
      const fetchOnce = jest.fn().mockResolvedValue({
        ok: false,
        status,
        headers: { get: () => "0" },
        text: async () => "",
      });
      const request = provisioner.createOneShotMutationRequester(
        "token",
        inspector,
        fetchOnce,
      );
      await expect(
        request({ method: "POST", body: { request_id: requestId } }),
      ).resolves.toEqual({
        accepted: false,
        uncertain,
        responseContactId: null,
      });
      expect(fetchOnce).toHaveBeenCalledTimes(1);
    },
  );

  it("validates the local create request id before arming a durable gate", async () => {
    const source = broker({ id: "invalid-request-id" });
    const beforeCreateMutation = jest.fn();
    await expect(
      provisioner.provisionAmoContact({
        record: {
          broker: source,
          queueRows: [],
          phones: [source.phone],
          candidateContactId: null,
          resolution: "create_contact_candidate",
        },
        broker: source,
        requestGet: jest.fn().mockResolvedValue(contactsPage([])),
        mutateOnce: jest.fn(),
        planModule: inspector,
        sleepImpl: jest.fn(),
        requestIdFactory: () => "invalid",
        beforeCreateMutation,
      }),
    ).rejects.toMatchObject({ code: "AMO_CREATE_REQUEST_ID_INVALID" });
    expect(beforeCreateMutation).not.toHaveBeenCalled();
  });

  it("rejects an oversized local POST before ARM and permits a later valid attempt", async () => {
    const source = broker({ id: "oversized-local-body" });
    const beforeCreateMutation = jest.fn();
    const mutateOnce = jest.fn();
    const baseRecord = {
      broker: source,
      queueRows: [],
      phones: [source.phone],
      candidateContactId: null,
      resolution: "create_contact_candidate",
    };
    await expect(
      provisioner.provisionAmoContact({
        record: baseRecord,
        broker: { ...source, fullName: "x".repeat(129 * 1024) },
        requestGet: jest.fn().mockResolvedValue(contactsPage([])),
        mutateOnce,
        planModule: inspector,
        sleepImpl: jest.fn(),
        requestIdFactory: () => requestId,
        beforeCreateMutation,
      }),
    ).rejects.toMatchObject({ code: "AMO_MUTATION_BODY_SIZE_INVALID" });
    expect(beforeCreateMutation).not.toHaveBeenCalled();
    expect(mutateOnce).not.toHaveBeenCalled();

    const requestGet = jest
      .fn()
      .mockResolvedValueOnce(contactsPage([]))
      .mockResolvedValueOnce(
        contactsPage([amoContact(778, source.phone, true)]),
      );
    mutateOnce.mockResolvedValue({
      accepted: true,
      uncertain: false,
      responseContactId: 778,
    });
    await expect(
      provisioner.provisionAmoContact({
        record: baseRecord,
        broker: source,
        requestGet,
        mutateOnce,
        planModule: inspector,
        sleepImpl: jest.fn(),
        requestIdFactory: () => requestId,
        beforeCreateMutation,
      }),
    ).resolves.toBe(778);
    expect(beforeCreateMutation).toHaveBeenCalledTimes(1);
    expect(mutateOnce).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost create response only through exact GET and never sends a second POST", async () => {
    const source = broker({ id: "create", phone: "+79990000003" });
    const row = queueRow("q-create", source);
    const record = {
      broker: source,
      queueRows: [row],
      phones: ["+79990000003"],
      candidateContactId: null,
      resolution: "create_contact_candidate",
    };
    const requestGet = jest
      .fn()
      .mockResolvedValueOnce(contactsPage([]))
      .mockResolvedValueOnce(
        contactsPage([amoContact(303, "+79990000003", true)]),
      );
    const mutateOnce = jest.fn().mockResolvedValue({
      accepted: false,
      uncertain: true,
      responseContactId: null,
    });
    await expect(
      provisioner.provisionAmoContact({
        record,
        broker: source,
        requestGet,
        mutateOnce,
        planModule: inspector,
        sleepImpl: jest.fn(),
        requestIdFactory: () => requestId,
      }),
    ).resolves.toBe(303);
    expect(mutateOnce).toHaveBeenCalledTimes(1);
    expect(mutateOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({ request_id: requestId }),
      }),
    );
    expect(requestGet).toHaveBeenCalledTimes(2);
  });

  it("promotes with one flag-only PATCH and then requires the same exact flagged contact", async () => {
    const source = broker({ id: "promote", phone: "+79990000002" });
    const record = {
      broker: source,
      queueRows: [queueRow("q-promote", source)],
      phones: ["+79990000002"],
      candidateContactId: 202,
      resolution: "promote_existing_contact_candidate",
    };
    const requestGet = jest
      .fn()
      .mockResolvedValueOnce(
        contactsPage([amoContact(202, "+79990000002", false)]),
      )
      .mockResolvedValueOnce(
        contactsPage([amoContact(202, "+79990000002", true)]),
      );
    const mutateOnce = jest.fn().mockResolvedValue({ accepted: true });
    await expect(
      provisioner.provisionAmoContact({
        record,
        broker: source,
        requestGet,
        mutateOnce,
        planModule: inspector,
        sleepImpl: jest.fn(),
      }),
    ).resolves.toBe(202);
    expect(mutateOnce).toHaveBeenCalledTimes(1);
    expect(mutateOnce).toHaveBeenCalledWith({
      method: "PATCH",
      contactId: 202,
      body: {
        custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }],
      },
    });
  });

  it("links an existing flagged contact without any amo mutation", async () => {
    const source = broker({ id: "link-only", phone: "+79990000007" });
    const record = {
      broker: source,
      queueRows: [queueRow("q-link-only", source)],
      phones: [source.phone],
      candidateContactId: 207,
      resolution: "link_existing_broker_contact",
    };
    const requestGet = jest
      .fn()
      .mockResolvedValue(contactsPage([amoContact(207, source.phone, true)]));
    const mutateOnce = jest.fn();

    await expect(
      provisioner.provisionAmoContact({
        record,
        broker: source,
        requestGet,
        mutateOnce,
        planModule: inspector,
        sleepImpl: jest.fn(),
      }),
    ).resolves.toBe(207);
    expect(mutateOnce).not.toHaveBeenCalled();
    expect(requestGet).toHaveBeenCalledTimes(2);
  });

  it("uses the same deterministic advisory lock key as the live API helper", async () => {
    const brokerId = "a6329d0a-e7a8-42b6-9bda-39c68ab22c4b";
    const phone = "+79990000001";
    expect(provisioner.AMO_BROKER_CONTACT_LOCK_DOMAIN).toBe(
      AMO_BROKER_CONTACT_LOCK_DOMAIN,
    );
    expect(provisioner.amoBrokerContactAdvisoryLockKey(phone)).toBe(
      amoBrokerContactAdvisoryLockKey(phone),
    );
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce([{ id: brokerId }]),
    };
    await expect(
      provisioner.acquireAmoBrokerContactAdvisoryXactLock(tx, brokerId, phone),
    ).resolves.toBe(amoBrokerContactAdvisoryLockKey(phone));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(String(tx.$queryRaw.mock.calls[0][0][0])).toContain(
      "pg_advisory_xact_lock",
    );
    expect(Array.from(tx.$queryRaw.mock.calls[1][0]).join("")).toContain(
      "FOR UPDATE",
    );
  });

  it("uses exact runtime/apply HMAC parity without exposing the phone", () => {
    const phone = "+79990000077";
    const digest = provisioner.amoBrokerContactGateDigest(phone);
    expect(digest).toBe(amoBrokerContactGateDigest(phone));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("79990000077");
  });

  it("requires a distinct second database backend before any amo work", async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ pid: 101 }]) };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ pid: 202 }]),
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    };
    await expect(
      provisioner.assertDatabasePoolSupportsDurableGate(prisma),
    ).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

    prisma.$queryRaw.mockResolvedValue([{ pid: 101 }]);
    await expect(
      provisioner.assertDatabasePoolSupportsDurableGate(prisma),
    ).rejects.toMatchObject({ code: "DATABASE_POOL_CAPACITY_INSUFFICIENT" });
  });

  it("links with Serializable CAS and audit in the same locked transaction without Client writes", async () => {
    const source = broker({ id: "link", phone: "+79990000001" });
    const row = queueRow("q-link", source);
    const record = {
      broker: source,
      queueRows: [row],
      phones: ["+79990000001"],
      candidateContactId: 101,
      resolution: "link_existing_broker_contact",
      brokerSourceSnapshot: provisioner.brokerSourceSnapshot(source, inspector),
      queueSnapshot: provisioner.queueSnapshot([row]),
    };
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce([{ id: source.id }]),
      broker: {
        findUnique: jest.fn().mockResolvedValue(source),
        findMany: jest.fn().mockResolvedValue([source]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      client: { findMany: jest.fn().mockResolvedValue([directQueue(row)]) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: any, _options?: any) =>
        callback(tx),
      ),
    };
    await expect(
      provisioner.linkBrokerContactCas({
        prisma,
        record,
        contactId: 101,
        planModule: inspector,
        sourceSha,
        reviewedPlanRunId: "32947094767",
      }),
    ).resolves.toEqual({ linked: true });
    expect(prisma.$transaction.mock.calls[0][1]).toEqual(
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    expect(tx.broker.updateMany).toHaveBeenCalledWith({
      where: { id: source.id, amoContactId: null, mergedIntoId: null },
      data: { amoContactId: BigInt(101) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.broker.updateMany.mock.invocationCallOrder[0],
    );
    expect((tx.client as any).update).toBeUndefined();
    expect((tx.client as any).updateMany).toBeUndefined();
  });

  it("fails before CAS on contact ownership drift and never writes audit", async () => {
    const source = broker({ id: "link", phone: "+79990000001" });
    const occupied = broker({
      id: "other",
      phone: "+79990000009",
      amoContactId: BigInt(101),
    });
    const row = queueRow("q-link", source);
    const record = {
      broker: source,
      queueRows: [row],
      phones: ["+79990000001"],
      candidateContactId: 101,
      resolution: "link_existing_broker_contact",
      brokerSourceSnapshot: provisioner.brokerSourceSnapshot(source, inspector),
      queueSnapshot: provisioner.queueSnapshot([row]),
    };
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce([{ id: source.id }]),
      broker: {
        findUnique: jest.fn().mockResolvedValue(source),
        findMany: jest.fn().mockResolvedValue([source, occupied]),
        updateMany: jest.fn(),
      },
      client: { findMany: jest.fn().mockResolvedValue([directQueue(row)]) },
      auditLog: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: any, _options?: any) =>
        callback(tx),
      ),
    };
    await expect(
      provisioner.linkBrokerContactCas({
        prisma,
        record,
        contactId: 101,
        planModule: inspector,
        sourceSha,
        reviewedPlanRunId: "32947094767",
      }),
    ).rejects.toMatchObject({ code: "DATABASE_CONTACT_OWNERSHIP_DRIFT" });
    expect(tx.broker.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rolls back audit when the broker link CAS misses", async () => {
    const source = broker({ id: "cas-miss", phone: "+79990000008" });
    const row = queueRow("q-cas-miss", source);
    const record = {
      broker: source,
      queueRows: [row],
      phones: [source.phone],
      candidateContactId: 108,
      resolution: "link_existing_broker_contact",
      brokerSourceSnapshot: provisioner.brokerSourceSnapshot(source, inspector),
      queueSnapshot: provisioner.queueSnapshot([row]),
    };
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce([{ id: source.id }]),
      broker: {
        findUnique: jest.fn().mockResolvedValue(source),
        findMany: jest.fn().mockResolvedValue([source]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      client: { findMany: jest.fn().mockResolvedValue([directQueue(row)]) },
      auditLog: { create: jest.fn() },
    };
    const prisma = {
      auditLog: tx.auditLog,
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    };

    await expect(
      provisioner.linkBrokerContactCas({
        prisma,
        record,
        contactId: 108,
        planModule: inspector,
        sourceSha,
        reviewedPlanRunId: "32947094767",
      }),
    ).rejects.toMatchObject({ code: "BROKER_CAS_UPDATE_MISSED" });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("durably blocks a second create after an unresolved one-shot POST", async () => {
    const source = broker({ id: "uncertain-create", phone: "+79990000009" });
    const row = queueRow("q-uncertain-create", source);
    const record = {
      broker: source,
      queueRows: [row],
      phones: [source.phone],
      candidateContactId: null,
      resolution: "create_contact_candidate",
      brokerSourceSnapshot: provisioner.brokerSourceSnapshot(source, inspector),
      queueSnapshot: provisioner.queueSnapshot([row]),
    };
    const gateEvents: any[] = [];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: source.id }]),
      broker: {
        findUnique: jest.fn().mockResolvedValue(source),
        findMany: jest.fn().mockResolvedValue([source]),
        update: jest.fn().mockResolvedValue(source),
        updateMany: jest.fn(),
      },
      client: { findMany: jest.fn().mockResolvedValue([directQueue(row)]) },
      auditLog: {
        // Deliberately stale long-transaction view: it can never observe the
        // externally committed phone gate.
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
    };
    const authoritativeAuditLog = {
      findMany: jest.fn(async () => gateEvents),
      create: jest.fn(async ({ data }: any) => {
        gateEvents.push(data);
        return data;
      }),
    };
    const prisma = {
      auditLog: authoritativeAuditLog,
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    };
    const requestGet = jest.fn().mockResolvedValue(contactsPage([]));
    const mutateOnce = jest.fn().mockResolvedValue({
      accepted: false,
      uncertain: true,
      responseContactId: null,
    });

    await expect(
      provisioner.provisionAndLinkBrokerContact({
        prisma,
        record,
        requestGet,
        mutateOnce,
        planModule: inspector,
        sourceSha,
        reviewedPlanRunId: "39947094767",
        sleepImpl: jest.fn(),
        requestIdFactory: () => requestId,
      }),
    ).rejects.toMatchObject({ code: "AMO_POST_MUTATION_NOT_RECONCILED" });
    expect(mutateOnce).toHaveBeenCalledTimes(1);
    expect(
      authoritativeAuditLog.create.mock.invocationCallOrder[0],
    ).toBeLessThan(mutateOnce.mock.invocationCallOrder[0]);
    expect(requestGet).toHaveBeenCalledTimes(7);
    expect(gateEvents[0].action).toBe(
      provisioner.AMO_BROKER_CONTACT_CREATE_UNCERTAIN_ACTION,
    );
    expect(tx.broker.update).not.toHaveBeenCalled();
    expect(tx.broker.updateMany).not.toHaveBeenCalled();
    expect(tx.client).not.toHaveProperty("update");

    requestGet.mockClear();
    mutateOnce.mockClear();
    await expect(
      provisioner.provisionAndLinkBrokerContact({
        prisma,
        record,
        requestGet,
        mutateOnce,
        planModule: inspector,
        sourceSha,
        reviewedPlanRunId: "39947094767",
        sleepImpl: jest.fn(),
        requestIdFactory: () => requestId,
      }),
    ).rejects.toMatchObject({ code: "AMO_CREATE_UNCERTAIN_MARKER_PRESENT" });
    expect(mutateOnce).not.toHaveBeenCalled();
    expect(requestGet).toHaveBeenCalledTimes(1);

    requestGet
      .mockClear()
      .mockResolvedValue(contactsPage([amoContact(909, source.phone, true)]));
    tx.broker.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      provisioner.provisionAndLinkBrokerContact({
        prisma,
        record,
        requestGet,
        mutateOnce,
        planModule: inspector,
        sourceSha,
        reviewedPlanRunId: "39947094767",
        sleepImpl: jest.fn(),
        requestIdFactory: () => requestId,
      }),
    ).resolves.toBe(909);
    expect(mutateOnce).not.toHaveBeenCalled();
    expect(gateEvents.at(-1)).toEqual(
      expect.objectContaining({
        action: provisioner.AMO_BROKER_CONTACT_CREATE_RESOLVED_ACTION,
        payload: expect.objectContaining({
          gateId: gateEvents[0].payload.gateId,
        }),
      }),
    );
  });

  it("classifies database uniqueness and serialization failures without details", () => {
    expect(provisioner.safeFailureCode({ code: "P2002", meta: "PII" })).toBe(
      "DATABASE_UNIQUE_CONSTRAINT",
    );
    expect(provisioner.safeFailureCode({ code: "P2034", message: "PII" })).toBe(
      "DATABASE_SERIALIZATION_CONFLICT",
    );
    expect(provisioner.safeFailureCode(new Error("PII"))).toBe(
      "UNCLASSIFIED_FAILURE",
    );
  });

  it("emits only a classified failure when confirmation contains PII", () => {
    const rawSecret = "Ivan +79991112233 broker@example.test";
    const result = spawnSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        PROVISION_CONFIRMATION: rawSecret,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"failureCode":"CONFIRMATION_REQUIRED"');
    expect(result.stdout).not.toContain(rawSecret);
    expect(result.stdout).not.toContain("79991112233");
    expect(result.stdout).not.toContain("broker@example.test");
  });

  it("keeps the standalone script free of Nest/OAuth/lead and Client mutation paths", () => {
    expect(script).not.toMatch(
      /NestFactory|AppModule|AmoCrmAdapter|refreshAccessToken|AMO_REFRESH_TOKEN/,
    );
    expect(script).not.toMatch(
      /(?:prisma|tx)\.client\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(script).not.toMatch(/createFixationRequest|createLead|retryFailed/);
    expect(script).toContain('method: "POST"');
    expect(script).toContain('method: "PATCH"');
    expect(script).toContain('isolationLevel: "Serializable"');
    expect(script).toContain("pg_advisory_xact_lock");
  });

  it("fails closed on an unflagged recovery contact in all three runtime paths", () => {
    for (const relativePath of [
      "apps/api/src/auth/auth.service.ts",
      "apps/api/src/client-fixation/client-fixation.service.ts",
      "apps/api/src/cms/cms.service.ts",
    ]) {
      const source = readFileSync(
        resolve(repositoryRoot, relativePath),
        "utf8",
      );
      expect(source).toContain("observedGateId && !isAmoBrokerContact");
      expect(source).toContain("AMO_BROKER_CONTACT_GATE_NOT_CONFIRMED");
    }
  });

  it("forwards the dedicated gate secret through both deploy allowlists", () => {
    const deployWorkflow = readFileSync(
      resolve(repositoryRoot, ".github/workflows/deploy.yml"),
      "utf8",
    );
    const deployScript = readFileSync(
      resolve(repositoryRoot, "deploy-update.sh"),
      "utf8",
    );
    expect(deployWorkflow).toContain(
      "BROKER_CONTACT_GATE_HMAC_KEY: ${{ secrets.BROKER_CONTACT_GATE_HMAC_KEY }}",
    );
    const forwarded = deployWorkflow.slice(
      deployWorkflow.indexOf("forwarded_names=("),
      deployWorkflow.indexOf(")", deployWorkflow.indexOf("forwarded_names=(")),
    );
    expect(forwarded).toContain("BROKER_CONTACT_GATE_HMAC_KEY");
    expect(deployScript).toMatch(
      /AMO_REFRESH_TOKEN \\\s+BROKER_CONTACT_GATE_HMAC_KEY \\/,
    );
  });

  it("has a syntactically valid exact-SHA, two-file, secret-backed exclusive-lock workflow with all 26 gates and no deploy", () => {
    const parsed = parse(workflow) as any;
    const workflowDispatch = parsed.on.workflow_dispatch;
    expect(Object.keys(workflowDispatch.inputs)).toHaveLength(26);
    for (const input of Object.values(workflowDispatch.inputs) as any[]) {
      expect(input.required).toBe(true);
    }
    const shell = parsed.jobs.apply.steps[1].run as string;
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
    )}\nc2FmZQ==\nPII_SAFE_AMO_BROKER_CONTACT_APPLY_BUNDLE\n`;
    const remoteSyntax = spawnSync(bash, ["-n"], {
      input: generatedRemoteShell,
      encoding: "utf8",
    });
    expect(remoteSyntax.status).toBe(0);
    expect(remoteSyntax.stderr).toBe("");

    expect(workflow).toContain("group: production-deploy");
    expect(workflow).toMatch(/permissions:\s*[\s\S]*?actions: read/);
    expect(workflow).toContain("environment: production");
    expect(provisioner.HISTORICAL_COUNT_EVIDENCE_RUN_ID).toBe("32947094767");
    expect(workflow).toContain("/actions/runs/$PROVISION_REVIEWED_PLAN_RUN_ID");
    expect(workflow).toContain(
      ".github/workflows/inspect-production-amo-broker-contact-provisioning-plan.yml",
    );
    expect(workflow).toContain(".head_sha");
    expect(workflow).toContain(".head_branch");
    expect(workflow).toContain(".conclusion");
    expect(workflow).toContain(".run_attempt");
    expect(workflow).toContain("reviewed_run_age_seconds");
    expect(workflow).toContain('test "$deployed_sha" = "$EXPECTED_SHA"');
    expect(workflow).toContain('test "$container_sha" = "$production_sha"');
    expect(workflow).toContain("flock -x -n 9");
    expect(workflow).not.toContain("flock -s");
    expect(workflow).toContain("apply_sha=$(sha256sum");
    expect(workflow).toContain("inspector_sha=$(sha256sum");
    expect(workflow).toContain("secrets.BROKER_CONTACT_COHORT_ATTESTATION_KEY");
    expect(workflow).toContain("secrets.BROKER_CONTACT_GATE_HMAC_KEY");
    expect(workflow).toContain("BROKER_CONTACT_GATE_HMAC_KEY_FILE");
    expect(workflow).toContain('test "$runtime_gate_hash" = "$file_gate_hash"');
    expect(workflow).toContain("PROVISION_EXPECTED_COHORT_DIGEST");
    expect(workflow).toContain("cohort-attestation.key");
    expect(workflow).toContain(
      'BROKER_CONTACT_COHORT_ATTESTATION_KEY_FILE="$attestation_key_file"',
    );
    expect(workflow).not.toContain(
      "export BROKER_CONTACT_COHORT_ATTESTATION_KEY",
    );
    expect(workflow).toContain(
      'BROKER_CONTACT_INSPECTOR_SHA256="$expected_inspector_sha"',
    );
    expect(workflow).not.toMatch(
      /bash -s[^\n]*COHORT_ATTESTATION_KEY|docker exec[^\n]*COHORT_ATTESTATION_KEY/,
    );
    expect(workflow).toContain("apply-amo-broker-contact-provisioning.js");
    expect(workflow).toContain("inspect-amo-broker-link-repair-plan.js");
    expect(workflow).not.toMatch(
      /docker compose|git fetch|git pull|git checkout|deploy-update|retry-failed-amo-sync/i,
    );
  });
});
