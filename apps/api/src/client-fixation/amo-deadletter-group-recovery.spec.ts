import { readFileSync } from "fs";
import { dirname, resolve } from "path";

jest.mock("@st-michael/integrations", () => ({
  amoFixationPhoneLockRedisKey: (phone: string) =>
    `client-fixation:semantic:test:${phone}`,
}));

describe("signed amo deadletter phone-group recovery", () => {
  const repositoryRoot = resolve(__dirname, "../../../..");
  const NodeModule = jest.requireActual("module") as any;
  const load = (relative: string) => {
    const pathname = resolve(repositoryRoot, relative);
    const loaded = new NodeModule(pathname, module);
    loaded.filename = pathname;
    loaded.paths = NodeModule._nodeModulePaths(dirname(pathname));
    loaded._compile(readFileSync(pathname, "utf8"), pathname);
    return loaded.exports as any;
  };
  const core = load("scripts/amo-deadletter-group-recovery-core.js");
  const legacyInspector = load(
    "scripts/inspect-amo-fixation-lead-reconciliation.js",
  );
  const planModule = load(
    "scripts/inspect-amo-deadletter-group-recovery-plan.js",
  );
  const apply = load("scripts/apply-amo-deadletter-group-recovery.js");
  const key = Buffer.alloc(32, 0x41);
  const metadata = {
    sourceSha: "a".repeat(40),
    coreSha256: "b".repeat(64),
    planSha256: "c".repeat(64),
    legacyInspectorSha256: "d".repeat(64),
  };
  const executionGate = () =>
    apply.readExecutionGate({
      RECOVERY_CONFIRMATION: apply.EXACT_CONFIRMATION,
      RECOVERY_SOURCE_SHA: "a".repeat(40),
      RECOVERY_CONFIRM_EXACT_SHA: "a".repeat(40),
      RECOVERY_DEPLOYED_GIT_SHA: "a".repeat(40),
      RECOVERY_REVIEWED_PLAN_RUN_ID: "32968270615",
      RECOVERY_EXPECTED_COHORT_DIGEST: "b".repeat(64),
      RECOVERY_CORE_SHA256: "c".repeat(64),
      RECOVERY_PLAN_SHA256: "d".repeat(64),
      RECOVERY_LEGACY_INSPECTOR_SHA256: "e".repeat(64),
      RECOVERY_APPLY_SHA256: "f".repeat(64),
      RECOVERY_EXPECTED_MANIFEST:
        "queueRows=12,phoneGroups=9,createGroups=9,blockedGroups=0,clientContactCreates=3,agencyRepairs=1,maxLeadPosts=9,requeues=0",
    });
  const agency = (id = "agency-1") => ({
    id,
    name: `Agency ${id}`,
    inn: id === "agency-1" ? "7700000001" : "7700000002",
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
  });
  const broker = (index: number, agencyId = "agency-1") => ({
    id: `broker-${index}`,
    phone: `+7888${String(index).padStart(7, "0")}`,
    fullName: `Broker ${index}`,
    email: `broker-${index}@example.test`,
    amoContactId: BigInt(90_000 + index),
    mergedIntoId: null,
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
    brokerAgencies: [
      {
        id: `membership-${index}`,
        agencyId,
        joinedAt: new Date("2025-01-01T00:00:00.000Z"),
        isPrimary: true,
      },
    ],
  });
  const row = (
    index: number,
    phoneIndex: number,
    overrides: Record<string, unknown> = {},
  ) => {
    const owner = broker(index);
    return {
      id: `client-${String(index).padStart(2, "0")}`,
      brokerId: owner.id,
      responsibleBrokerId: null,
      phone: `+7999${String(phoneIndex).padStart(7, "0")}`,
      fullName: `Private Client ${index}`,
      email: `private-${index}@example.test`,
      comment: "private comment",
      project: "ZORGE9",
      fixationAgencyId: "agency-1",
      propertyType: "Квартира",
      roomsCount: "2",
      amount: "20000000",
      sqm: "70",
      clientRegion: "Москва",
      purchaseTiming: "1-3 месяца",
      readinessLevel: "Тёплый",
      createdAt: new Date(
        `2026-08-25T10:${String(index).padStart(2, "0")}:00.000Z`,
      ),
      updatedAt: new Date(
        `2026-08-25T11:${String(index).padStart(2, "0")}:00.000Z`,
      ),
      amoLeadId: null,
      amoSyncStatus: "FAILED",
      amoSyncAttempts: 10,
      amoSyncLastAttemptAt: new Date("2026-08-25T12:00:00.000Z"),
      amoSyncError: "BROKER_AMO_CONTACT_MISSING",
      broker: owner,
      responsibleBroker: null,
      ...overrides,
    };
  };
  const rows = () => [
    row(1, 1),
    row(2, 1),
    row(3, 2),
    row(4, 2),
    row(5, 3),
    row(6, 3),
    row(7, 4),
    row(8, 5),
    row(9, 6),
    row(10, 7),
    row(11, 8),
    row(12, 9),
  ];
  const evidence = (items = rows()) =>
    new Map(
      [...new Set(items.map((item) => core.normalizePhone(item.phone)))].map(
        (phone: string, index: number) => [
          phone,
          {
            exactContactIds: [80_000 + index],
            exactContactRoleCollision: false,
            leads: [],
          },
        ],
      ),
    );
  const brokerEvidence = (items = rows()) =>
    new Map(
      items.map((item) => [
        item.broker.id,
        {
          contactId: Number(item.broker.amoContactId),
          exactPhone: true,
          brokerFlag: true,
          occupiedByOtherBroker: false,
        },
      ]),
    );
  const build = (
    items = rows(),
    byPhone = evidence(items),
    agenciesById = new Map([
      ["agency-1", agency("agency-1")],
      ["agency-2", agency("agency-2")],
    ]),
  ) =>
    core.buildPlan({
      rows: items,
      evidenceByPhone: byPhone,
      agenciesById,
      brokerEvidence: brokerEvidence(items),
      metadata,
      attestationKey: key,
      reportKey: Buffer.alloc(32, 0x42),
    });

  it("groups the exact 12 rows into 9 phones and authorizes one lead per phone", () => {
    const plan = build();
    expect(plan.manifest).toEqual({
      queueRows: 12,
      phoneGroups: 9,
      createGroups: 9,
      blockedGroups: 0,
      clientContactCreates: 0,
      agencyRepairs: 0,
      maxLeadPosts: 9,
      requeues: 0,
    });
    expect(plan.classifications[0].group.rows).toHaveLength(2);
    expect(plan.classifications[0].group.leader.id).toBe("client-01");
    expect(JSON.stringify(plan.publicReport)).not.toContain("Private Client");
    expect(JSON.stringify(plan.publicReport)).not.toContain("private-");
    expect(JSON.stringify(plan.publicReport)).not.toContain("+7999");
  });

  it("fails closed instead of treating missing phone evidence as no contacts", () => {
    const items = rows();
    const incomplete = evidence(items);
    incomplete.delete(core.normalizePhone(items[0].phone));
    expect(() => build(items, incomplete)).toThrow("AMO_EVIDENCE_MISSING");
  });

  it("collects complete evidence for a valid +77 phone through the real collector", async () => {
    const items = rows();
    const validDoubleSevenPhone = "+77990000001";
    const clientContactId = 700_001;
    const activeLeadId = 600_001;
    items[11].phone = validDoubleSevenPhone;
    const owners = items.map((item) => ({
      id: item.broker.id,
      amoContactId: item.broker.amoContactId,
    }));
    const prisma = {
      client: { findMany: jest.fn().mockResolvedValue(items) },
      agency: {
        findMany: jest.fn().mockResolvedValue([agency("agency-1")]),
      },
      broker: {
        findMany: jest.fn(async (args: any) => {
          const selectedIds = (args?.where?.amoContactId?.in || []).map(Number);
          return selectedIds.includes(clientContactId) ? [] : owners;
        }),
      },
    };
    const contactQueries: string[] = [];
    const request = jest.fn(async (path: string, query?: any) => {
      if (path === "/api/v4/contacts") {
        contactQueries.push(String(query?.query));
        return {
          _embedded: {
            contacts:
              query?.query === "7990000001"
                ? [
                    {
                      id: clientContactId,
                      custom_fields_values: [
                        {
                          field_id: planModule.CONTACT_PHONE_FIELD_ID,
                          field_code: "PHONE",
                          values: [{ value: validDoubleSevenPhone }],
                        },
                      ],
                    },
                  ]
                : [],
          },
          _links: {},
        };
      }
      if (path === `/api/v4/contacts/${clientContactId}`) {
        return {
          id: clientContactId,
          custom_fields_values: [
            {
              field_id: planModule.CONTACT_PHONE_FIELD_ID,
              field_code: "PHONE",
              values: [{ value: validDoubleSevenPhone }],
            },
          ],
          ...(query?.with === "leads"
            ? { _embedded: { leads: [{ id: activeLeadId }] } }
            : {}),
        };
      }
      if (path === `/api/v4/leads/${activeLeadId}`) {
        return {
          id: activeLeadId,
          pipeline_id: 7_600_542,
          status_id: 62_907_350,
          created_at: 1_787_642_871,
          custom_fields_values: [],
          _embedded: { contacts: [{ id: clientContactId }] },
        };
      }
      const contactId = Number(path.split("/").pop());
      const source = items.find(
        (item) => Number(item.broker.amoContactId) === contactId,
      );
      if (!source) throw new Error("unexpected contact request");
      return {
        id: contactId,
        custom_fields_values: [
          {
            field_id: planModule.CONTACT_PHONE_FIELD_ID,
            field_code: "PHONE",
            values: [{ value: source.broker.phone }],
          },
          {
            field_id: planModule.CONTACT_BROKER_FIELD_ID,
            values: [{ value: true }],
          },
        ],
      };
    });

    const plan = await planModule.collectPlan({
      prisma,
      request,
      metadata,
      attestationKey: key,
      reportKey: Buffer.alloc(32, 0x42),
    });

    expect(core.normalizePhone(validDoubleSevenPhone)).toBe(
      validDoubleSevenPhone,
    );
    expect(legacyInspector.normalizePhone(validDoubleSevenPhone)).toBe(
      validDoubleSevenPhone,
    );
    expect(contactQueries).toHaveLength(9);
    expect(contactQueries).toContain("7990000001");
    expect(plan.manifest).toMatchObject({
      queueRows: 12,
      phoneGroups: 9,
      createGroups: 8,
      blockedGroups: 1,
      maxLeadPosts: 8,
    });
    expect(
      plan.classifications.find(
        (item: any) => item.group.normalizedPhone === validDoubleSevenPhone,
      ),
    ).toMatchObject({
      resolution: "blocked_active_or_unknown_lead",
      evidence: {
        exactContactIds: [clientContactId],
        leads: [{ leadId: activeLeadId, statusId: 62_907_350 }],
      },
    });
  });

  it("binds private source values into HMAC without emitting them", () => {
    const firstRows = rows();
    const first = build(firstRows);
    const changedRows = rows();
    changedRows[0].email = "different-private@example.test";
    const second = build(changedRows);
    expect(second.digest).not.toBe(first.digest);
    expect(JSON.stringify(second.publicReport)).not.toContain(
      "different-private",
    );
  });

  it("binds effective broker merge and update state into the signed plan", () => {
    const first = build();
    const mergedRows = rows();
    mergedRows[0].broker.mergedIntoId = "canonical-broker";
    expect(build(mergedRows).digest).not.toBe(first.digest);

    const updatedRows = rows();
    updatedRows[0].broker.updatedAt = new Date("2026-08-26T00:00:00.000Z");
    expect(build(updatedRows).digest).not.toBe(first.digest);
    expect(core.rowSnapshot(updatedRows[0])).toMatchObject({
      effectiveBrokerMergedIntoId: null,
      effectiveBrokerUpdatedAt: "2026-08-26T00:00:00.000Z",
    });
  });

  it("binds the authoritative agency name and INN used in the lead payload", () => {
    const first = build();
    const changedAgency = agency("agency-1");
    changedAgency.name = "Renamed agency";
    const second = build(
      rows(),
      evidence(rows()),
      new Map([
        ["agency-1", changedAgency],
        ["agency-2", agency("agency-2")],
      ]),
    );
    expect(second.digest).not.toBe(first.digest);
    expect(second.rawAttestation.records[0].rowProofs[0]).toMatchObject({
      agencyName: "Renamed agency",
      agencyInn: "7700000001",
    });
    expect(JSON.stringify(second.publicReport)).not.toContain("Renamed agency");
  });

  it("blocks sibling agency divergence instead of putting the leader agency on a shared lead", () => {
    const items = rows();
    items[1].fixationAgencyId = "agency-2";
    const plan = build(items);
    expect(plan.classifications[0]).toMatchObject({
      resolution: "blocked_agency",
      reason: "sibling_agencies_diverge",
    });
    expect(plan.manifest.blockedGroups).toBe(1);
  });

  it("blocks an exact client contact that is broker-flagged or DB-occupied", () => {
    const items = rows();
    const byPhone = evidence(items);
    byPhone.get("+79990000001").exactContactRoleCollision = true;
    const plan = build(items, byPhone);
    expect(plan.classifications[0]).toMatchObject({
      resolution: "blocked_client_broker_role_collision",
      reason: "exact_client_contact_is_broker_or_db_occupied",
    });
  });

  it("derives client/broker role collision from live amo flags and full DB occupancy", async () => {
    const amoEvidence: any = {
      byPhone: new Map([
        ["+79990000001", { exactContactIds: [101], leads: [] }],
        ["+79990000002", { exactContactIds: [102], leads: [] }],
      ]),
    };
    const prisma = {
      broker: {
        findMany: jest.fn().mockResolvedValue([{ amoContactId: BigInt(101) }]),
      },
    };
    const request = jest.fn(async (path: string) => ({
      id: Number(path.split("/").pop()),
      custom_fields_values: path.endsWith("/102")
        ? [
            {
              field_id: planModule.CONTACT_BROKER_FIELD_ID,
              values: [{ value: true }],
            },
          ]
        : [],
    }));

    await planModule.enrichClientContactRoleEvidence(
      prisma,
      amoEvidence,
      request,
    );

    expect(amoEvidence.byPhone.get("+79990000001")).toMatchObject({
      exactContactRoleCollision: true,
    });
    expect(amoEvidence.byPhone.get("+79990000002")).toMatchObject({
      exactContactRoleCollision: true,
    });
    expect(prisma.broker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { amoContactId: { in: [BigInt(101), BigInt(102)] } },
      }),
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never authorizes a row carrying a prior one-shot recovery marker", () => {
    const items = rows();
    items[0].amoSyncError = `${core.RECOVERY_MARKER_PREFIX}${"f".repeat(64)}`;
    const plan = build(items);
    expect(plan.classifications[0].resolution).toBe(
      "blocked_unresolved_recovery_gate",
    );
  });

  it("requires the fixed full-execution manifest and authenticates audit payloads", () => {
    expect(executionGate().manifest.maxLeadPosts).toBe(9);
    const signed = apply.signedAuditPayload({ operationId: "op" }, key);
    expect(apply.assertSignedAuditPayload(signed, key)).toMatchObject({
      operationId: "op",
    });
    expect(() =>
      apply.assertSignedAuditPayload(
        { ...signed, operationId: "tampered" },
        key,
      ),
    ).toThrow("amo deadletter group recovery failed");
  });

  it("reconciles only one narrow-time lead with the exact initial contact set", () => {
    const armedAt = new Date("2026-08-26T12:00:00.000Z");
    jest.spyOn(Date, "now").mockReturnValue(armedAt.getTime());
    const base = {
      exactContactIds: [100],
      leads: [
        {
          leadId: 555,
          pipelineId: 7600542,
          statusId: 123,
          createdAt: Math.floor(armedAt.getTime() / 1000),
          contactIds: [100, 201, 202],
          sourceMarker: false,
          requestValues: [],
          projectValues: [],
        },
      ],
    };
    expect(
      apply.candidateLeadFromEvidence({
        evidence: base,
        beforeLeadIds: new Set(),
        responseLeadId: null,
        clientContactId: 100,
        brokerContactIds: [201, 202],
        armedAt,
        project: "ZORGE9",
      }),
    ).toBe(555);
    expect(
      apply.candidateLeadFromEvidence({
        evidence: {
          ...base,
          leads: [{ ...base.leads[0], contactIds: [100, 201, 202, 999] }],
        },
        beforeLeadIds: new Set(),
        responseLeadId: null,
        clientContactId: 100,
        brokerContactIds: [201, 202],
        armedAt,
        project: "ZORGE9",
      }),
    ).toBeNull();
    jest.restoreAllMocks();
  });

  it("accepts a lost contact response only with narrow-time exact identity fields", () => {
    const armedAt = new Date("2026-08-26T12:00:00.000Z");
    jest.spyOn(Date, "now").mockReturnValue(armedAt.getTime());
    const sourceRow = rows()[0];
    const contact = {
      id: 777,
      name: sourceRow.fullName,
      created_at: Math.floor(armedAt.getTime() / 1000),
      custom_fields_values: [
        {
          field_id: planModule.CONTACT_PHONE_FIELD_ID,
          values: [{ value: sourceRow.phone }],
        },
        { field_id: 557905, values: [{ value: sourceRow.email }] },
        { field_id: 589265, values: [{ value: sourceRow.clientRegion }] },
      ],
    };
    expect(
      apply.lostContactResponseMatches({
        contact,
        row: sourceRow,
        normalizedPhone: core.normalizePhone(sourceRow.phone),
        armedAt,
      }),
    ).toBe(true);
    expect(
      apply.lostContactResponseMatches({
        contact: {
          ...contact,
          custom_fields_values: contact.custom_fields_values.map((field) =>
            field.field_id === 557905
              ? { ...field, values: [{ value: "wrong@example.test" }] }
              : field,
          ),
        },
        row: sourceRow,
        normalizedPhone: core.normalizePhone(sourceRow.phone),
        armedAt,
      }),
    ).toBe(false);
    expect(
      apply.lostContactResponseMatches({
        contact: {
          ...contact,
          custom_fields_values: [
            ...contact.custom_fields_values,
            {
              field_id: planModule.CONTACT_BROKER_FIELD_ID,
              values: [{ value: true }],
            },
          ],
        },
        row: sourceRow,
        normalizedPhone: core.normalizePhone(sourceRow.phone),
        armedAt,
      }),
    ).toBe(false);
    jest.restoreAllMocks();
  });

  it("builds Morekit parity only from HMAC-bound leader fields", () => {
    const item = build().classifications[0];
    const integrations = {
      morekitPhone: (value: string) => value.replace(/\D/g, ""),
      morekitLeadDate: () => ({
        date: "now",
        timezone_type: "3",
        timezone: "UTC",
      }),
      morekitProjectName: () => "Зорге 9",
    };
    expect(apply.buildMorekitPayload(item, 321, integrations)).toMatchObject({
      id: "321",
      agency: "Agency agency-1",
      broker_id: String(item.leader.broker.contactId),
      agent_name: item.leader.row.broker.fullName,
      agent_mail: item.leader.row.broker.email,
      clients: [{ name: item.leader.row.fullName }],
      project: "Зорге 9",
    });
  });

  it("performs a live owner check before mutation and fails after lease loss", async () => {
    const values = new Map<string, string>();
    let denyOwnerChecks = false;
    const redis = {
      set: jest.fn(async (redisKey: string, value: string) => {
        if (values.has(redisKey)) return null;
        values.set(redisKey, value);
        return "OK";
      }),
      eval: jest.fn(
        async (
          script: string,
          _keys: number,
          redisKey: string,
          owner: string,
          ...args: string[]
        ) => {
          const current = values.get(redisKey);
          if (
            !current ||
            JSON.parse(current).owner !== owner ||
            denyOwnerChecks
          ) {
            return 0;
          }
          if (script.includes("PEXPIRE")) return 1;
          if (script.includes("redis.call('SET'")) {
            values.set(redisKey, args[0]);
            return 1;
          }
          if (script.includes("redis.call('DEL'")) {
            values.delete(redisKey);
            return 1;
          }
          return 0;
        },
      ),
    };
    const leases = await apply.acquirePhoneLeases(
      redis,
      [{ group: { normalizedPhone: "+79990000001" } }],
      key,
    );
    await expect(leases.assertOwned()).resolves.toBeUndefined();
    denyOwnerChecks = true;
    await expect(leases.assertOwned()).rejects.toThrow(
      "amo deadletter group recovery failed",
    );
    denyOwnerChecks = false;
    await leases.release(new Set());
    expect(redis.eval).toHaveBeenCalled();
  });

  it.each(["fresh revalidation", "final lease verification"])(
    "does not POST a contact when %s fails after CONTACT_ARMED",
    async (failurePoint) => {
      const item = build().classifications[0];
      item.clientContactId = null;
      const failure = new Error("precondition failed");
      const revalidate = jest.fn();
      const assertOwned = jest.fn();
      if (failurePoint === "fresh revalidation") {
        revalidate
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(failure);
        assertOwned.mockResolvedValue(undefined);
      } else {
        revalidate.mockResolvedValue(undefined);
        assertOwned
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(failure);
      }
      const adapter = { createFixationClientContactOnce: jest.fn() };
      const prisma = {
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      };

      await expect(
        apply.resolveClientContact({
          prisma,
          adapter,
          requestGet: jest.fn(),
          item,
          key,
          gate: executionGate(),
          operationId: "contact-operation",
          leases: { assertOwned },
          revalidate,
        }),
      ).rejects.toThrow("precondition failed");
      expect(adapter.createFixationClientContactOnce).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["fresh revalidation", "final lease verification"])(
    "does not POST a lead when %s fails after LEAD_ARMED",
    async (failurePoint) => {
      const item = build().classifications[0];
      const failure = new Error("precondition failed");
      const revalidate = jest.fn();
      const assertOwned = jest.fn();
      if (failurePoint === "fresh revalidation") {
        revalidate
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(failure);
        assertOwned.mockResolvedValue(undefined);
      } else {
        revalidate.mockResolvedValue(undefined);
        assertOwned
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(failure);
      }
      const adapter = { createFixationRequest: jest.fn() };
      const prisma = {
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      };

      await expect(
        apply.createOrReconcileLead({
          prisma,
          adapter,
          requestGet: jest.fn(),
          item,
          key,
          gate: executionGate(),
          operationId: "lead-operation",
          clientContactId: item.clientContactId,
          leases: { assertOwned },
          revalidate,
          collectEvidence: jest.fn().mockResolvedValue(item.evidence),
        }),
      ).rejects.toThrow("precondition failed");
      expect(adapter.createFixationRequest).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a signed completed ledger with duplicate groups or clients", async () => {
    const gate = executionGate();
    const duplicateGroup = {
      entityId: "1".repeat(64),
      leadId: "123",
      clientIds: ["client-1", "client-2"],
      morekitStatus: "unresolved",
    };
    const payload = apply.signedAuditPayload(
      {
        source: apply.APPLY_SOURCE,
        sourceSha: gate.sourceSha,
        reviewedRunId: gate.reviewedRunId,
        cohortDigest: gate.expectedDigest,
        manifest: gate.manifestText,
        queueRows: 12,
        phoneGroups: 9,
        groups: Array.from({ length: 9 }, () => ({ ...duplicateGroup })),
        requeued: false,
        piiStored: false,
      },
      key,
    );
    const prisma = {
      auditLog: { findMany: jest.fn().mockResolvedValue([{ payload }]) },
      client: { findMany: jest.fn() },
    };
    await expect(apply.tryCompletedNoop(prisma, gate, key)).rejects.toThrow(
      "amo deadletter group recovery failed",
    );
    expect(prisma.client.findMany).not.toHaveBeenCalled();
  });

  it("keeps the apply workflow at exactly five signed operator inputs", () => {
    const workflow = readFileSync(
      resolve(
        repositoryRoot,
        ".github/workflows/apply-production-amo-deadletter-group-recovery.yml",
      ),
      "utf8",
    );
    const inputBlock = workflow.match(
      /workflow_dispatch:\s*\n\s+inputs:\s*\n([\s\S]*?)\n\nconcurrency:/,
    )?.[1];
    expect(inputBlock).toBeDefined();
    const names = [
      ...String(inputBlock).matchAll(/^\s{6}([a-z_]+):\s*$/gm),
    ].map((match) => match[1]);
    expect(names).toEqual([
      "confirmation",
      "exact_sha",
      "reviewed_plan_run_id",
      "cohort_digest",
      "manifest",
    ]);
    expect(workflow).toContain("flock -x -n 9");
    expect(workflow).toContain(".run_attempt == 1");
    expect(workflow).toContain("RECOVERY_EXPECTED_MANIFEST");
    expect(workflow).not.toContain("rm -rf");
  });
});
