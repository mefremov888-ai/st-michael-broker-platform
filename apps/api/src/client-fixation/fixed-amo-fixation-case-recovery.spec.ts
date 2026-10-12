import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { AMO_KC_STATUS } from "../../../../packages/integrations/src/amo-crm.fields";
import { amoFixationPhoneLockRedisKey } from "../../../../packages/integrations/src/amo-fixation-phone-lock";

describe("draft exact-case one-shot recovery (all providers/database mocked)", () => {
  const root = resolve(__dirname, "../../../..");
  const scriptPath = resolve(root, "scripts/apply-fixed-amo-fixation-case.js");
  const source = readFileSync(scriptPath, "utf8");
  const NodeModule = jest.requireActual("module") as any;
  const loaded = new NodeModule(scriptPath, module);
  loaded.filename = scriptPath;
  loaded.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
  loaded._compile(source, scriptPath);
  const recovery = loaded.exports;
  const inspector = loaded.require("./inspect-fixed-amo-fixation-case");
  const helpers = loaded.require("./inspect-amo-fixation-lead-reconciliation");
  const NOW = new Date();
  const unix = Math.floor(NOW.getTime() / 1000);
  const clone = (value: any): any => value === null || typeof value !== "object" ? value
    : value instanceof Date ? new Date(value) : Array.isArray(value) ? value.map(clone)
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  const row = (changes: any = {}) => ({
    id: recovery.CLIENT_ID, brokerId: recovery.OWNER_ID, responsibleBrokerId: null,
    broker: { id: recovery.OWNER_ID, fullName: "private-broker", phone: "+79993334455", amoContactId: 47267177n, role: "BROKER", status: "PENDING", mergedIntoId: null, brokerAgencies: [{ agencyId: "agency1", isPrimary: true }] },
    responsibleBroker: null,
    phone: "+79990001122", fullName: "private-client", email: "private@example.test", comment: "private comment", project: "ZORGE9", fixationAgencyId: "agency1",
    createdAt: new Date("2026-10-08T14:18:19.203Z"), updatedAt: new Date("2026-10-08T14:18:19.466Z"),
    amoLeadId: null, amoCreatedAt: null, amoUpdatedAt: null, amoSyncStatus: "FAILED", amoSyncAttempts: 3,
    amoSyncLastAttemptAt: new Date("2026-10-08T14:18:19.466Z"), amoSyncError: "AMO_CREATE_RECONCILIATION_REQUIRED:AMO_TEMPORARY_UNAVAILABLE",
    uniquenessStatus: "UNDER_REVIEW", uniquenessReason: "private-original-reason", uniquenessExpiresAt: new Date(NOW.getTime() + 86400000),
    fixationStatus: "NOT_FIXED", fixationExpiresAt: null, inspectionActSigned: false, status: "NEW",
    propertyType: "Квартира", roomsCount: "1", amount: null, sqm: null, clientRegion: null, purchaseTiming: null, readinessLevel: null, ...changes,
  });
  const agency = { id: "agency1", name: "private-agency", inn: "1234567890", updatedAt: new Date("2026-10-08T12:00:00.000Z") };
  const metadata = { runId: "123", planRunId: "122", caseHash: "a".repeat(64), candidateHash: "b".repeat(64), deployedGitSha: "c".repeat(40), sourceSha256: "d".repeat(64) };
  describe("reviewed zero-POST abandoned guard takeover (exact case only)", () => {
    const clock = () => recovery.ABANDONED_LEASE_EXPIRES_AT - 3600000;
    const raw = (status = "uncertain") => JSON.stringify({ fingerprint: "a".repeat(64),
      status, owner: "12345678-1234-4234-8234-123456789abc" });
    const approved = { FIXED_CASE_ZERO_POST_FAILURE_RUN_ID: "38150838032" };
    const fixture = (options: any = {}) => {
      let reads = 0;
      return { set: jest.fn(async () => null),
        get: jest.fn(async () => ++reads === 2 && options.changed ? raw("completed") : raw(options.status)),
        pttl: jest.fn(async () => options.ttl ?? 3600000),
        eval: jest.fn(async () => options.casFail ? 0 : 1) };
    };
    it("atomically replaces only the reviewed unchanged uncertain guard without DELETE", async () => {
      const redis = fixture();
      const leases = await recovery.acquireFixedCasePhoneLeases(redis, row(), Buffer.alloc(32, 1), approved, clock);
      await leases.stop();
      expect(redis.get).toHaveBeenCalledTimes(2);
      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, count, key, expectedRaw, newValue] = redis.eval.mock.calls[0] as any;
      expect(script).toContain("raw ~= ARGV[1]");
      expect(script).not.toContain("DEL");
      expect(count).toBe(1);
      expect(key).toBe(amoFixationPhoneLockRedisKey(row().phone));
      expect(expectedRaw).toBe(raw());
      expect(JSON.parse(newValue).status).toBe("processing");
    });
    it.each(["processing", "completed"])("refuses %s / active-or-completed workers", async (status) => {
      const redis = fixture({ status });
      await expect(recovery.acquireFixedCasePhoneLeases(redis, row(), Buffer.alloc(32, 1), approved, clock))
        .rejects.toMatchObject({ safeCode: "ABANDONED_LEASE_UNVERIFIED" });
      expect(redis.eval).not.toHaveBeenCalled();
    });
    it.each([0, -1, 3605000, 90000000])("refuses expired, stale, renewed or unrelated TTL %s", async (ttl) => {
      const redis = fixture({ ttl });
      await expect(recovery.acquireFixedCasePhoneLeases(redis, row(), Buffer.alloc(32, 1), approved, clock))
        .rejects.toMatchObject({ safeCode: "ABANDONED_LEASE_UNVERIFIED" });
      expect(redis.eval).not.toHaveBeenCalled();
    });
    it("refuses changed raw-value readback and missing historical attestation", async () => {
      for (const [redis, environment] of [[fixture({ changed: true }), approved], [fixture(), {}]] as any[]) {
        await expect(recovery.acquireFixedCasePhoneLeases(redis, row(), Buffer.alloc(32, 1), environment, clock))
          .rejects.toMatchObject({ safeCode: "ABANDONED_LEASE_UNVERIFIED" });
        expect(redis.eval).not.toHaveBeenCalled();
      }
    });
    it("loses safely when CAS detects a concurrent change; never retries SET", async () => {
      const redis = fixture({ casFail: true });
      await expect(recovery.acquireFixedCasePhoneLeases(redis, row(), Buffer.alloc(32, 1), approved, clock))
        .rejects.toMatchObject({ code: "PHONE_LOCK_BUSY" });
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });
    it("does not extend exception to another client", async () => {
      const redis = fixture();
      await expect(recovery.acquireFixedCasePhoneLeases(redis, row({ id: "other-client" }), Buffer.alloc(32, 1), approved, clock))
        .rejects.toMatchObject({ safeCode: "FIXED_CLIENT_MISSING" });
      expect(redis.set).not.toHaveBeenCalled();
    });
  });
  function environment(mode = "apply", planHashes: any = {}) {
    const sourceHashes = Object.fromEntries(Object.entries(recovery.SOURCE_FILES).map(([key, path]) => [key, createHash("sha256").update(readFileSync(path as string, "utf8")).digest("hex")]));
    return { NODE_ENV: "production", FIXED_CASE_MODE: mode, FIXED_CASE_RUN_ID: "123456", FIXED_CASE_PLAN_RUN_ID: "123455", FIXED_CASE_RUN_ATTEMPT: "1", FIXED_CASE_SOURCE_HASHES: JSON.stringify(sourceHashes),
      FIXED_CASE_INSPECTOR_SHA256: sourceHashes.inspector, FIXED_CASE_DEPENDENCY_SHA256: sourceHashes.reconciliation, FIXED_CASE_DEPLOYED_GIT_SHA: "c".repeat(40),
      FIXED_CASE_EXPECTED_CASE_HASH: planHashes.caseHash || "a".repeat(64), FIXED_CASE_EXPECTED_CANDIDATE_HASH: planHashes.candidateHash || "b".repeat(64),
      PRODUCTION_PG_SYSTEM_IDENTIFIER: "1234567", PRODUCTION_MIN_BROKER_ROWS: "100", AMO_ACCESS_TOKEN: "private-env-token" };
  }
  function database(initial = row(), options: any = {}) {
    const data = { row: clone(initial), audits: [] as any[], updates: [] as any[] };
    const tx: any = {
      $executeRaw: jest.fn(async () => 0),
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => strings.join("").includes("pg_control_system") ? [{ database_name: "broker_platform", system_identifier: "1234567", broker_rows: "1000", ...options.identity }] : strings.join("").includes("regexp_replace") ? [{ id: data.row.id, phone: data.row.phone }, ...(options.siblings || [])] : []),
      client: {
        findUnique: jest.fn(async () => clone(data.row)),
        findMany: jest.fn(async () => options.occupied ? [{ id: "other-client" }] : []),
        updateMany: jest.fn(async ({ where, data: changes }: any) => {
          if (options.casFail || Object.entries(where).some(([key, expected]) => String(data.row[key]) !== String(expected))) return { count: 0 };
          data.updates.push(clone(changes)); Object.assign(data.row, changes, { updatedAt: new Date(data.row.updatedAt.getTime() + 1) }); return { count: 1 };
        }),
      },
      agency: { findUnique: jest.fn(async () => clone(options.currentAgency || agency)) },
      broker: { findMany: jest.fn(async ({ where }: any) => options.roleCollision && where.amoContactId === 800001n ? [{ id: "other-broker" }] : []) },
      systemSetting: { findUnique: jest.fn(async () => ({ value: "private-db-token" })) },
      auditLog: {
        findMany: jest.fn(async ({ where, take }: any) => {
          const records = where.entity === "AmoDeadletterGroupRecovery" ? options.oldGates || [] : data.audits;
          return records.filter((entry: any) => (!where.action || (typeof where.action === "string" ? entry.action === where.action : where.action.in.includes(entry.action))) && (!where.createdAt?.gte || entry.createdAt >= where.createdAt.gte)).slice(0, take).map(clone);
        }),
        create: jest.fn(async ({ data: audit }: any) => { const value = { id: String(data.audits.length + 1), ...clone(audit) }; data.audits.push(value); options.onAudit?.(value, data); return value; }),
      },
    };
    return { data, tx, $transaction: jest.fn(async (callback: any) => {
      const previous = clone(data);
      try { return await callback(tx); } catch (error) { Object.assign(data, previous); throw error; }
    }) };
  }
  function json(payload: any, status = 200) {
    let done = false;
    return { status, ok: status >= 200 && status < 300, body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from(JSON.stringify(payload)) }), cancel: async () => {}, releaseLock: () => {} }), cancel: async () => {} } };
  }
  const reviewFields: [number, string][] = [[618511, "Звонок из Calltouch"], [618517, "+79993334455"], [618577, "private-call-id"], [618527, "09.10.2026 10:52:47"]];
  const reviewLead = () => ({ id: 32372907, name: "Брокер Другой", created_at: 1791532367, pipeline_id: 7600542, status_id: 143,
    custom_fields_values: reviewFields.map(([field_id, value]) => ({ field_id, values: [{ value }] })),
    _embedded: { contacts: [{ id: 47267177 }], companies: [{ id: 43419077 }] } });
  const reviewEvents = () => {
    const event = (id: string, type: string, value_after: any[], created_at = 1791532367) => ({ id, type, entity_id: 32372907, entity_type: "lead", account_id: 28552900, created_at, value_before: [], value_after });
    return [event("added", "lead_added", []), event("linked", "entity_linked", [{ link: { entity: { type: "contact", id: 47267177 } } }]),
      event("company", "entity_linked", [{ link: { entity: { type: "company", id: 43419077 } } }], 1791533367),
      ...reviewFields.map(([field_id, text]) => event(`field${field_id}`, `custom_field_${field_id}_value_changed`, [{ custom_field_value: { field_id, text } }], 1791532458))];
  };
  const brokerContact = (newLead = false) => ({ id: 47267177, name: "private-broker", updated_at: unix,
    custom_fields_values: [{ field_id: 557903, values: [{ value: "+79993334455" }] }, { field_id: 835415, values: [{ value: true }] }],
    _embedded: { leads: [{ id: 32372907 }, ...(newLead ? [{ id: 700001 }] : [])] } });
  const contact = () => ({ id: 800001, name: "private-client", created_at: unix, custom_fields_values: [{ field_id: 557903, values: [{ value: "+79990001122" }] }, { field_id: 557905, values: [{ value: "private@example.test" }] }], _embedded: { leads: [] } });
  const lead = (changes: any = {}) => ({ id: 700001, name: "Фиксация: private-client (ZORGE9)", pipeline_id: 7600542, status_id: AMO_KC_STATUS.NEW_REQUEST, created_at: unix,
    _embedded: { contacts: [{ id: 800001 }, { id: 47267177 }] },
    custom_fields_values: [{ field_id: 665195, values: [{ enum_id: 985337 }] }, { field_id: 833189, values: [{ value: unix }] }, { field_id: 839179, values: [{ value: "Зорге 9" }] }], ...changes });
  function provider(options: any = {}) {
    const state: any = { contact: options.existingContact ? contact() : null, lead: null, reviewNoteReads: 0 };
    const request = jest.fn(async (path: string) => {
      if (path === "/api/v4/account") return { id: 28552900 };
      if (path === "/api/v4/contacts/47267177") return brokerContact(Boolean(state.lead));
      if (path === "/api/v4/leads/32372907") return reviewLead();
      if (path === "/api/v4/contacts/800001") return state.contact ? { ...state.contact, _embedded: { leads: state.lead ? [{ id: 700001 }] : [] } } : null;
      if (path === "/api/v4/leads/700001") return state.lead;
      throw Error("private token +79990001122 private@example.test");
    });
    const fetch = jest.fn(async (url: URL, optionsFetch: any) => {
      if (url.pathname === "/api/v4/leads/32372907/notes" && optionsFetch.method === "GET") {
        state.reviewNoteReads++;
        if (options.reviewNotes204UntilRead) return state.reviewNoteReads <= options.reviewNotes204UntilRead ? json({}, 204) : json({ _embedded: { notes: [] } });
        if (options.reviewNotesChanging) return state.reviewNoteReads === 1 ? json({}, 204) : json({ _embedded: { notes: [] } });
        if (options.reviewNotes204) return json({}, 204);
        if (options.reviewNotesRejected) return json({}, 403);
        if (options.reviewNotesMalformed) return json({});
        if (options.reviewNotesNull200) return json(null);
      }
      if (url.pathname === "/api/v4/contacts" && optionsFetch.method === "POST") {
        if (options.contactAbsent) throw Error("private-contact-error");
        state.contact = contact();
        if (options.contactUnknown) throw Error("private-contact-error");
        return json({ _embedded: { contacts: [state.contact] } });
      }
      if (url.pathname === "/api/v4/leads" && optionsFetch.method === "POST") {
        if (options.leadAbsent) throw Error("private-lead-error");
        // The real adapter POST creates only the minimum lead. Required
        // business fields must come from its actual follow-up PATCH body.
        // A lost response may be accepted only if independent GET already
        // confirms all fields, never because this script retries a mutation.
        state.lead = lead({ custom_fields_values: options.leadUnknown && !options.leadUnknownMissingFields ? lead().custom_fields_values : [], ...(options.badLead || {}) });
        if (options.leadUnknown) throw Error("private-lead-error");
        return json({ _embedded: { leads: [{ id: 700001 }] } });
      }
      if (url.pathname === "/api/v4/leads/700001" && optionsFetch.method === "PATCH") {
        if (options.badLead?.custom_fields_values === undefined) {
          const fields = JSON.parse(optionsFetch.body).custom_fields_values;
          for (const field of fields || []) {
            state.lead.custom_fields_values = state.lead.custom_fields_values.filter((entry: any) => entry.field_id !== field.field_id);
            state.lead.custom_fields_values.push(field);
          }
        }
        return json({ id: 700001 });
      }
      if (url.pathname === "/api/v4/leads/700001/notes" && optionsFetch.method === "POST") {
        const body = JSON.parse(optionsFetch.body); state.note = { id: 77, entity_id: 700001, note_type: "common", params: { text: body[0].params.text } };
        return json({ _embedded: { notes: [{ id: 77 }] } });
      }
      if (url.pathname === "/api/v4/leads/700001/notes" && optionsFetch.method === "GET") return json({ _embedded: { notes: state.note ? [state.note] : [] } });
      throw Error("Unexpected private credentials");
    });
    const collect = jest.fn(async (rows: any[]) => ({ byPhone: new Map([[helpers.normalizePhone(rows[0].phone), { exactContactIds: state.contact ? [800001] : [], leads: state.lead ? [helpers.reduceLeadEvidence(state.lead, 700001)] : [] }]]), stats: {} }));
    const expanded = jest.fn(async ({ row: selected, contactEvidence, scanNow }: any) => {
      const window = inspector.makeEvidenceWindow(selected, scanNow);
      const fixed = { leadId: 32372907, privateLead: inspector.validatedLead(reviewLead(), 32372907, selected, window, false) };
      const additional = options.candidates || (state.lead ? [{ leadId: 700001 }, ...(options.postLeadCandidate ? [{ leadId: 700002 }] : [])] : []);
      return { complete: true, capturedAt: scanNow.toISOString(), window,
        contactEvidence: await contactEvidence, brokerLinkedLeads: [], kcWindowLeads: [], windowPagesRead: 1,
        possibleCandidates: [fixed, ...additional], databaseFingerprint: inspector.privateFingerprint(selected) };
    });
    return { state, fetch, request, collect, expanded };
  }
  function redis() {
    const data = new Map<string, any>();
    return {
      data, set: jest.fn(async (key: string, value: string) => { if (data.has(key)) return null; data.set(key, JSON.parse(value)); return "OK"; }),
      eval: jest.fn(async (script: string, _keys: number, key: string, owner: string, value: string) => {
        if (data.get(key)?.owner !== owner) return 0;
        if (script.includes("'DEL'")) data.delete(key);
        else if (script.includes("'SET'")) data.set(key, JSON.parse(value));
        return 1;
      }),
    };
  }
  let originals: any;
  beforeEach(() => {
    originals = { get: helpers.createGetOnlyRequester, collect: helpers.collectAmoEvidence, expanded: inspector.collectExpandedEvidence,
      notes: inspector.createReviewNotesRequester, history: inspector.createReviewHistoryRequester };
    inspector.createReviewNotesRequester = jest.fn(() => async () => ({ _embedded: { notes: [] } }));
    inspector.createReviewHistoryRequester = jest.fn(() => async () => ({ coverage: "observed", payload: { _embedded: { events: reviewEvents() } } }));
  });
  afterEach(() => {
    helpers.createGetOnlyRequester = originals.get; helpers.collectAmoEvidence = originals.collect; inspector.collectExpandedEvidence = originals.expanded;
    inspector.createReviewNotesRequester = originals.notes; inspector.createReviewHistoryRequester = originals.history;
  });
  async function execute(options: any = {}) {
    const db = database(options.row || row(), options);
    if (options.prior) db.data.audits.push({ action: "AMO_FIXED_CASE_CONTACT_ARMED", payload: { operationKey: recovery.OPERATION_KEY } });
    const crm = provider(options), lease = redis();
    let clockCalls = 0;
    const clock = () => options.movingCaptures ? new Date(NOW.getTime() - 30_000 + ++clockCalls * 1000) : new Date(NOW);
    let lockCalls = 0;
    const lock = { assertOwned: jest.fn(async () => { if (++lockCalls === options.lockLostAt) throw Error("private-lock-error"); }) };
    if (options.leaseBusy) lease.set.mockImplementation(async (_key, _value) => null);
    helpers.createGetOnlyRequester = jest.fn((token: string) => { expect(token).toBe("private-db-token"); return crm.request; });
    helpers.collectAmoEvidence = crm.collect; inspector.collectExpandedEvidence = crm.expanded;
    const plan = await recovery.runPlan({ prisma: db, environment: environment("plan"), confirmation: recovery.PLAN_CONFIRMATION, operationLock: lock, fetchImpl: crm.fetch, now: clock });
    if (options.planOnly) return { db, crm, lease, lock, plan, result: plan };
    const applyEnvironment = environment("apply", plan);
    if (options.planHashMismatch) applyEnvironment.FIXED_CASE_EXPECTED_CANDIDATE_HASH = "f".repeat(64);
    const result = await recovery.runDraftRecovery({ prisma: db, redis: lease, environment: applyEnvironment, confirmation: recovery.CONFIRMATION, operationLock: lock, fetchImpl: crm.fetch, now: clock, sleep: async () => {} });
    return { db, crm, lease, lock, plan, result };
  }

  it("has no executable entry point or workflow and exact fixed operation identity", () => {
    expect(source).not.toMatch(/require\.main|process\.stdout|process\.stderr|\.sendMail\(|\.sendSms\(/);
    expect(recovery.CLIENT_ID).toBe("8d082b21-7cba-4778-a6c6-1d80bfe7ed7c");
    expect(recovery.OWNER_ID).toBe("6e414141-f2ca-4c71-8402-2032c9186568");
    expect(recovery.OPERATION_KEY).not.toMatch(/123456|sourceSha|runId/);
    expect(recovery.CLIENT_SELECT.broker.select.passwordHash).toBeUndefined();
  });
  it("attests all fixed source dependencies and refuses one changed hash", () => {
    const env = environment(); expect(Object.keys(recovery.attestSources(env).hashes)).toHaveLength(12);
    const hashes = JSON.parse(env.FIXED_CASE_SOURCE_HASHES); hashes.adapter = "0".repeat(64);
    expect(() => recovery.attestSources({ ...env, FIXED_CASE_SOURCE_HASHES: JSON.stringify(hashes) })).toThrow("Fixed case recovery refused");
    expect(() => recovery.attestSources({ ...env, FIXED_CASE_INSPECTOR_SHA256: "0".repeat(64) })).toThrow();
  });
  it("plan is strictly read-only and returns only reviewable private hashes", async () => {
    const { db, crm, plan } = await execute({ planOnly: true });
    expect(plan).toMatchObject({ status: "planned", mutationAuthorized: false, databaseWrites: false, amoWrites: false, deployedGitSha: "c".repeat(40) });
    expect(plan.caseHash).toMatch(/^[a-f0-9]{64}$/); expect(plan.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.tx.client.updateMany).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
    expect(crm.fetch.mock.calls.every(([_url, options]) => options.method === "GET")).toBe(true);
  });
  it("plans with authoritative HTTP204 notes from the strict requester, without any write", async () => {
    inspector.createReviewNotesRequester = originals.notes;
    const { db, crm, plan } = await execute({ planOnly: true, reviewNotes204: true });
    expect(plan.status).toBe("planned");
    expect(db.tx.client.updateMany).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
    const notes = crm.fetch.mock.calls.filter(([url]) => url.pathname === "/api/v4/leads/32372907/notes");
    expect(notes).toHaveLength(4); expect(notes.every(([, options]) => options.method === "GET")).toBe(true);
    expect(crm.fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    inspector.createReviewNotesRequester = jest.fn(() => async () => ({ _embedded: { notes: [] } }));
    const empty200 = await execute({ planOnly: true });
    // 204 provenance cannot disappear unnoticed from the candidate fingerprint.
    expect(plan.candidateHash).not.toBe(empty200.plan.candidateHash);
  });
  it.each([undefined, {}])("does not normalize a missing/malformed notes payload %j", async (payload) => {
    inspector.createReviewNotesRequester = jest.fn(() => async () => payload);
    await expect(execute({ planOnly: true })).rejects.toMatchObject({ safeCode: "CERT_NOTES_INCOMPLETE" });
  });
  it("keeps HTTP403 and malformed HTTP200 notes as failed evidence, not empty notes", async () => {
    inspector.createReviewNotesRequester = originals.notes;
    await expect(execute({ planOnly: true, reviewNotesRejected: true })).rejects.toMatchObject({ safeCode: "REVIEW_NOTES_REQUEST_REJECTED" });
    await expect(execute({ planOnly: true, reviewNotesMalformed: true })).rejects.toMatchObject({ safeCode: "CERT_NOTES_INCOMPLETE" });
  });
  it("rejects an HTTP204-to-200 empty readback change instead of erasing provenance", async () => {
    inspector.createReviewNotesRequester = originals.notes;
    await expect(execute({ planOnly: true, reviewNotesChanging: true })).rejects.toMatchObject({ safeCode: "CERT_READBACK_CHANGED" });
  });
  it("refuses HTTP200 JSON null and unproven null instead of inventing HTTP204 provenance", async () => {
    inspector.createReviewNotesRequester = originals.notes;
    await expect(execute({ planOnly: true, reviewNotesNull200: true })).rejects.toMatchObject({ safeCode: "REVIEW_NOTES_REQUEST_FAILED" });
    inspector.createReviewNotesRequester = jest.fn(() => async () => null);
    await expect(execute({ planOnly: true })).rejects.toMatchObject({ safeCode: "CERTIFICATE_NOTES_OBSERVATION_INVALID" });
  });
  it("apply refuses a plan hash mismatch before the lease or any provider write", async () => {
    await expect(execute({ planHashMismatch: true })).rejects.toThrow("Fixed case recovery refused");
  });
  it.each([{ FIXED_CASE_RUN_ATTEMPT: "2" }, { FIXED_CASE_RUN_ID: "0" }, { NODE_ENV: "test" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }])("refuses invalid runtime gates %j", (changes) => {
    expect(() => recovery.gate({ ...environment(), ...changes }, recovery.CONFIRMATION, { assertOwned() {} })).toThrow();
  });
  it.each(["role", "merged", "blocked", "owner", "agency", "responsibleRelation"]) ("never chooses a new broker: %s", (change) => {
    const value = row();
    if (change === "role") value.broker.role = "MANAGER";
    if (change === "merged") value.broker.mergedIntoId = recovery.OWNER_ID;
    if (change === "blocked") value.broker.status = "BLOCKED";
    if (change === "owner") value.brokerId = "11111111-2222-4333-8444-555555555555";
    if (change === "agency") value.broker.brokerAgencies = [];
    if (change === "responsibleRelation") { value.responsibleBrokerId = "11111111-2222-4333-8444-555555555555"; value.responsibleBroker = null; }
    expect(() => recovery.effective(value)).toThrow();
  });
  it("creates exactly one client contact and one pre-resolved lead, then preserves all business/account state", async () => {
    const { db, crm, lease, result } = await execute();
    expect(result).toMatchObject({ status: "linked", contactPosts: 1, leadPosts: 1, patchPosts: 1, notePosts: 1, assignmentNeeded: true, directMorekitDispatchAttempted: false });
    expect(lease.set).toHaveBeenCalledWith(
      amoFixationPhoneLockRedisKey("+79990001122"),
      expect.any(String),
      "PX",
      600_000,
      "NX",
    );
    expect(db.data.row.amoLeadId).toBe(700001n);
    expect(db.data.row.broker.status).toBe("PENDING");
    for (const key of ["brokerId", "responsibleBrokerId", "uniquenessStatus", "uniquenessReason", "uniquenessExpiresAt", "fixationStatus", "fixationExpiresAt", "inspectionActSigned", "status"]) expect(db.data.row[key]).toEqual(row()[key]);
    expect(db.data.row.amoSyncLastAttemptAt).toEqual(NOW);
    const mutations = crm.fetch.mock.calls;
    expect(mutations.filter(([url, opts]) => url.pathname === "/api/v4/contacts" && opts.method === "POST")).toHaveLength(1);
    expect(mutations.filter(([url, opts]) => url.pathname === "/api/v4/leads" && opts.method === "POST")).toHaveLength(1);
    expect(mutations.filter(([url, opts]) => url.pathname === "/api/v4/leads/700001" && opts.method === "PATCH")).toHaveLength(1);
    expect(mutations.filter(([url, opts]) => url.pathname === "/api/v4/leads/700001/notes" && opts.method === "POST")).toHaveLength(1);
    expect(mutations.every(([url, opts]) => url.origin === "https://stmichael.amocrm.ru" && opts.redirect === "error" && opts.headers.Authorization === "Bearer private-db-token")).toBe(true);
    expect(db.data.audits.map((entry) => entry.action)).toEqual(["CLAIMED", "CONTACT_ARMED", "CONTACT_RESOLVED", "LEAD_ARMED", "LEAD_RESOLVED", "LINKED"].map((name) => `AMO_FIXED_CASE_${name}`));
    expect(JSON.stringify(db.data.audits)).not.toMatch(/private-|7999|example\.test|password|token/);
    expect(lease.data.size).toBe(0);
    expect(crm.expanded).toHaveBeenCalledTimes(7);
    expect(crm.request.mock.calls.filter(([path]) => path === "/api/v4/leads/32372907")).toHaveLength(14);
  });
  it("advancing capture timestamps and KC windows do not change the reviewed certificate before claim", async () => {
    inspector.createReviewNotesRequester = originals.notes;
    const { result, crm } = await execute({ movingCaptures: true, reviewNotes204: true });
    expect(result).toMatchObject({ status: 'linked', contactPosts: 1, leadPosts: 1 });
    const captures = crm.expanded.mock.calls.map(([input]) => input.scanNow.getTime());
    expect(new Set(captures).size).toBe(7);
    expect(captures.every((time, index) => index === 0 || time > captures[index - 1])).toBe(true);
  });
  it("successful plan can refuse before claim when later notes provenance changes, even with no durable audit", async () => {
    inspector.createReviewNotesRequester = originals.notes;
    const certificate = loaded.require('./fixed-amo-case-exclusion-certificate');
    const original = certificate.recheckFixedCaseExclusionCertificate;
    let failureCode: string | undefined;
    certificate.recheckFixedCaseExclusionCertificate = (...args: any[]) => {
      try { return original(...args); } catch (error) { failureCode = (error as any).safeCode; throw error; }
    };
    try {
      // Two plan readbacks (4 GETs), initial apply readback (2 GETs),
      // then the preclaim readback observes HTTP200 rather than HTTP204.
      const { result, db, lease } = await execute({ reviewNotes204UntilRead: 6 });
      expect(failureCode).toBe('CERT_RECHECK_CHANGED');
      expect(result).toMatchObject({ status: 'unresolved', failureCode: 'CERT_RECHECK_CHANGED', contactPosts: 0, leadPosts: 0, patchPosts: 0, notePosts: 0 });
      expect(db.tx.client.updateMany).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
      expect(db.data.row.updatedAt).toEqual(row().updatedAt);
      // No claim and no POST means there is no ambiguous operation to fence.
      expect([...lease.data.values()]).toEqual([]);
    } finally { certificate.recheckFixedCaseExclusionCertificate = original; }
  });
  it("preserves the shared Redis lease code without exposing its error message", async () => {
    const leaseModule = loaded.require('./apply-amo-deadletter-group-recovery');
    let caught: any;
    try { await leaseModule.acquirePhoneLeases({ set: async () => null }, [{ group: { normalizedPhone: '+79990001122' } }], Buffer.alloc(32, 1), amoFixationPhoneLockRedisKey); }
    catch (error) { caught = error; }
    expect(caught?.code).toBe('PHONE_LOCK_BUSY');
    expect(caught?.safeCode).toBeUndefined();
    expect(recovery.safeFailureCode(caught)).toBe('PHONE_LOCK_BUSY');
  });
  it("only reports literal reviewed certificate/provider/lease codes from safeCode or code", () => {
    const certificateSource = readFileSync(resolve(root, 'scripts/fixed-amo-case-exclusion-certificate.js'), 'utf8');
    const constants = Array.from(new Set([...certificateSource.matchAll(/fail\("([A-Z0-9_]+)"\)/g)].map((match) => match[1])));
    expect(constants.length).toBeGreaterThan(20);
    for (const code of constants) {
      expect(recovery.safeFailureCode({ safeCode: code, message: 'private token +7999', stack: 'private' })).toBe(code);
      expect(recovery.safeFailureCode({ code, body: { secret: 'private' } })).toBe(code);
    }
    for (const code of ['PHONE_LOCK_BUSY', 'PHONE_LOCK_OWNERSHIP_LOST', 'SHARED_PHONE_LOCK_CONTRACT_INVALID', 'ATTESTATION_KEY_INVALID', 'REVIEW_NOTES_REQUEST_FAILED']) {
      expect(recovery.safeFailureCode({ code, message: 'private' })).toBe(code);
    }
    for (const value of [{ safeCode: 'CERT_PRIVATE_7999' }, { code: 'PHONE_LOCK_BUSY private' }, { message: 'PHONE_LOCK_BUSY', stack: 'private' }, { safeCode: '+79990001122', code: 'private-api-token' }, null]) {
      expect(recovery.safeFailureCode(value)).toBe('RECOVERY_REFUSED');
    }
    expect(recovery.safeFailureCode(Object.defineProperty({}, 'safeCode', { get() { throw Error('private'); } }))).toBe('RECOVERY_REFUSED');
  });
  it("lost contact response is GET-reconciled without another POST", async () => {
    const { result, crm } = await execute({ contactUnknown: true });
    expect(result.status).toBe("linked");
    expect(crm.fetch.mock.calls.filter(([url, opts]) => url.pathname === "/api/v4/contacts" && opts.method === "POST")).toHaveLength(1);
  });
  it("lost lead response remains blocked after GET-only reconciliation, without another POST/PATCH/note", async () => {
    const { result, crm } = await execute({ leadUnknown: true });
    expect(result).toMatchObject({ status: "unresolved", failureCode: "LEAD_UNCONFIRMED", leadPosts: 1, patchPosts: 0, notePosts: 0 });
    expect(crm.fetch.mock.calls.filter(([url, opts]) => url.pathname === "/api/v4/leads" && opts.method === "POST")).toHaveLength(1);
    expect(crm.fetch.mock.calls.filter(([_url, opts]) => opts.method === "PATCH")).toHaveLength(0);
    expect(crm.fetch.mock.calls.filter(([url, opts]) => url.pathname.endsWith("/notes") && opts.method === "POST")).toHaveLength(0);
  });
  it("lost lead response without required fields never patches/retries the uncertain provider object", async () => {
    const { result, crm } = await execute({ leadUnknown: true, leadUnknownMissingFields: true });
    expect(result).toMatchObject({ status: "unresolved", failureCode: "LEAD_UNCONFIRMED", leadPosts: 1 });
    expect(crm.fetch.mock.calls.filter(([_url, opts]) => opts.method === "PATCH")).toHaveLength(0);
  });
  it.each([{ contactAbsent: true }, { leadAbsent: true }, { badLead: { custom_fields_values: [] } }, { badLead: { status_id: 142 } }, { occupied: true }, { roleCollision: true }])("leaves durable block and uncertain Redis lease for %j", async (options) => {
    const { db, crm, lease, result } = await execute(options);
    expect(result.status).toBe("unresolved"); expect(db.data.row.amoLeadId).toBeNull();
    expect(db.data.row.amoSyncError).toBe(recovery.MARKER);
    expect(db.data.audits.at(-1)?.action).toBe("AMO_FIXED_CASE_UNRESOLVED");
    expect([...lease.data.values()].every((value: any) => value.status === "uncertain")).toBe(true);
    expect(crm.fetch.mock.calls.filter(([url, opts]) => url.pathname === "/api/v4/leads" && opts.method === "POST").length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(result)).not.toMatch(/private|7999|example\.test/);
  });
  it("prior durable case audit blocks every future run/source even when marker was cleared", async () => {
    const { db, crm, result } = await execute({ prior: true });
    expect(result).toMatchObject({ status: "prior_operation_readonly", databaseWrites: false, contactPosts: 0, leadPosts: 0 });
    expect(crm.fetch).not.toHaveBeenCalled(); expect(db.tx.client.updateMany).not.toHaveBeenCalled();
    expect(crm.request).toHaveBeenCalledWith("/api/v4/account");
  });
  it("fresh existing contact or conservative possible lead blocks contact creation before claim", async () => {
    await expect(execute({ existingContact: true })).rejects.toThrow();
    await expect(execute({ candidates: [{ leadId: 2 }] })).rejects.toThrow();
  });
  it("exact DB system identifier is mandatory before token reads/mutations", async () => {
    await expect(execute({ identity: { system_identifier: "987" } })).rejects.toThrow();
  });
  it.each(["+7 (999) 123-45-67", "89991234567", "9991234567", "779991234567"]) ("another local same-normalized-phone case %s blocks before token/POST", async (phone) => {
    await expect(execute({ siblings: [{ id: "other-client", phone }] })).rejects.toThrow();
  });
  it("same-phone guard binds aliases privately, does not interpolate phone into SQL text", async () => {
    const db = database(); await recovery.assertNoOtherPhoneRows(db.tx, row());
    const [strings, values] = db.tx.$queryRaw.mock.calls[0] as any;
    expect(strings.join("")).not.toContain("79990001122");
    expect(values).toEqual(["79990001122", "89990001122", "9990001122", "779990001122"]);
  });
  it.each(["AMO_DEADLETTER_GROUP_CLAIMED", "AMO_DEADLETTER_CLIENT_CONTACT_POST_ARMED", "AMO_DEADLETTER_LEAD_POST_ARMED", "AMO_DEADLETTER_GROUP_AMBIGUOUS"]) ("unresolved causal old gate %s blocks without choosing its hidden phone", async (action) => {
    await expect(execute({ oldGates: [{ action, entityId: "e".repeat(64), createdAt: NOW }] })).rejects.toThrow();
  });
  it("older unrelated global old gate is not claimed as this new case attempt", async () => {
    const { result } = await execute({ oldGates: [{ action: "AMO_DEADLETTER_LEAD_POST_ARMED", entityId: "e".repeat(64), createdAt: new Date(row().createdAt.getTime() - 121000) }] });
    expect(result.status).toBe("linked");
  });
  it("completed causal old group permits proof, but a later re-arm blocks", async () => {
    const base = { entityId: "e".repeat(64) };
    const records = [{ ...base, action: "AMO_DEADLETTER_LEAD_POST_ARMED", createdAt: new Date(NOW.getTime() - 10) }, { ...base, action: "AMO_DEADLETTER_GROUP_COMPLETED", createdAt: NOW }];
    expect((await execute({ oldGates: records })).result.status).toBe("linked");
    await expect(execute({ oldGates: [...records, { ...base, action: "AMO_DEADLETTER_LEAD_POST_ARMED", createdAt: new Date(NOW.getTime() + 1) }] })).rejects.toThrow();
  });
  it("checks durable phase CAS and refuses repeat arming", async () => {
    const db = database(row({ amoSyncError: recovery.MARKER }));
    const baseline = { row: clone(db.data.row), agency };
    db.data.audits.push({ action: "AMO_FIXED_CASE_CLAIMED", payload: metadata });
    await recovery.phase(db, environment(), baseline, metadata, "CONTACT_ARMED");
    await expect(recovery.phase(db, environment(), baseline, { ...metadata, runId: "999" }, "CONTACT_ARMED")).rejects.toThrow();
    await expect(recovery.phase(db, environment(), baseline, metadata, "LEAD_ARMED")).rejects.toThrow();
  });
  it("shared lock lost before contact network request leaves claim fenced and no outbound calls", async () => {
    const { db, crm, result } = await execute({ lockLostAt: 5 });
    expect(result.status).toBe("unresolved"); expect(crm.fetch).not.toHaveBeenCalled();
    expect(db.data.row.amoSyncError).toBe(recovery.MARKER);
  });
  it("existing phone lease refuses before the durable claim and all provider writes", async () => {
    const { db, crm, result } = await execute({ leaseBusy: true });
    expect(result.status).toBe("unresolved"); expect(crm.fetch).not.toHaveBeenCalled();
    expect(db.tx.client.updateMany).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(["brokerId", "responsibleBrokerId", "comment", "uniquenessReason", "fixationExpiresAt"]) ("late case drift %s cannot reach contact POST", async (key) => {
    const { crm, result } = await execute({ onAudit: (audit: any, data: any) => {
      if (audit.action === "AMO_FIXED_CASE_CONTACT_ARMED") data.row[key] = key.endsWith("At") ? new Date(NOW) : "changed-private";
    } });
    expect(result.status).toBe("unresolved"); expect(crm.fetch).not.toHaveBeenCalled();
  });
  it("another possible lead appearing after POST blocks linking even when own lead is otherwise exact", async () => {
    const { db, result } = await execute({ postLeadCandidate: true });
    expect(result).toMatchObject({ status: "unresolved", failureCode: "LEAD_UNCONFIRMED", leadPosts: 1 });
    expect(db.data.row.amoLeadId).toBeNull();
  });
  it("agency INN/name drift at final link is refused and leaves no stored lead", async () => {
    const db = database(row({ amoSyncError: recovery.MARKER, amoSyncAttempts: 10 }), { currentAgency: { ...agency, inn: "0987654321" } });
    db.data.audits.push({ action: "AMO_FIXED_CASE_LEAD_RESOLVED", payload: { operationKey: recovery.OPERATION_KEY, leadId: 700001 } });
    await expect(recovery.link(db, environment(), { row: clone(db.data.row), agency }, metadata, 700001)).rejects.toThrow();
    expect(db.tx.client.updateMany).not.toHaveBeenCalled(); expect(db.data.row.amoLeadId).toBeNull();
  });
  it("CAS mismatch does not arm/send or record a successful claim", async () => {
    const { db, crm, result } = await execute({ casFail: true });
    expect(result).toMatchObject({ status: "unresolved", failureCode: "CLAIM_CAS_FAILED" });
    expect(db.data.audits).toHaveLength(0); expect(crm.fetch).not.toHaveBeenCalled();
  });
  it("adapter console is isolated and never emits private body/provider exceptions", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await execute(); await execute({ contactUnknown: true, leadUnknown: true });
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });
  it("rejects stale/mismatched evidence and requires zero pre-contact / exact one post-contact", async () => {
    const crm = provider();
    const selected = recovery.projectInspectorRow(row());
    const proof = await crm.expanded({ row: selected, contactEvidence: crm.collect([selected]), scanNow: NOW });
    const filtered = { ...proof, possibleCandidates: [] };
    expect(() => recovery.negative({ expanded: filtered }, row(), () => NOW)).not.toThrow();
    expect(() => recovery.negative({ expanded: filtered }, row(), () => new Date(NOW.getTime() + 61000))).toThrow();
    expect(() => recovery.negative({ expanded: filtered }, row({ fullName: "changed" }), () => NOW)).toThrow();
    expect(() => recovery.negative({ expanded: filtered }, row(), () => NOW, 800001)).toThrow();
  });
  it.each(["https://evil.test/contacts", "/contacts/900001/unlink", "/oauth2/access_token", "/tasks", "/leads/700001/link"]) ("transport refuses extra capability %s", async (endpoint) => {
    const fetch = jest.fn(), state = { phase: "CONTACT_ARMED", requests: 0, contactPosts: 0, leadPosts: 0, patchPosts: 0, notePosts: 0, leadId: null };
    await expect(recovery.createCanonicalTransport("secret", fetch, state, async () => {})(endpoint, { method: "POST", body: "[]" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("transport counts attempted lost POST before sending, prevents a second attempt", async () => {
    const fetch = jest.fn(async () => { throw Error("private@example.test passwordhash"); });
    const state = { phase: "CONTACT_ARMED", requests: 0, contactPosts: 0, leadPosts: 0, patchPosts: 0, notePosts: 0, leadId: null };
    const request = recovery.createCanonicalTransport("secret", fetch, state, async () => {});
    await expect(request("/contacts", { method: "POST", body: "[]" })).rejects.toThrow("Fixed case recovery refused");
    await expect(request("/contacts", { method: "POST", body: "[]" })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("transport permits at most one lead PATCH and one note POST, counting ambiguous attempts", async () => {
    const fetch = jest.fn(async () => { throw Error("private ambiguous provider error"); });
    const state = { phase: "LEAD_ARMED", requests: 0, contactPosts: 0, leadPosts: 1, patchPosts: 0, notePosts: 0, leadId: 700001 };
    const pace = jest.fn(async () => {}), request = recovery.createCanonicalTransport("secret", fetch, state, pace);
    await expect(request("/leads/700001", { method: "PATCH", body: "{}" })).rejects.toThrow();
    await expect(request("/leads/700001", { method: "PATCH", body: "{}" })).rejects.toThrow();
    expect(state.patchPosts).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
    await expect(request("/leads/700001/notes", { method: "POST", body: "[]" })).rejects.toThrow();
    await expect(request("/leads/700001/notes", { method: "POST", body: "[]" })).rejects.toThrow();
    expect(state.notePosts).toBe(1); expect(fetch).toHaveBeenCalledTimes(2); expect(pace).toHaveBeenCalledTimes(2);
    expect(pace).toHaveBeenNthCalledWith(1, 400); expect(pace).toHaveBeenNthCalledWith(2, 400);
  });
  it("strict final lead verification requires current field map/project/contacts/source/time/status", () => {
    expect(AMO_KC_STATUS.NEW_REQUEST).toBe(62907118);
    expect(recovery.leadMatches(lead(), row(), 800001, 700001, NOW, () => NOW)).toBe(true);
    for (const changes of [{ pipeline_id: 7 }, { name: "wrong" }, { created_at: unix - 999 }, { _embedded: { contacts: [{ id: 800001 }] } }, { custom_fields_values: [] }]) expect(recovery.leadMatches(lead(changes), row(), 800001, 700001, NOW, () => NOW)).toBe(false);
  });
  it("exact one-shot fields and decorated note match the attested compiled adapter contract", async () => {
    const calls: any[] = [];
    const request = jest.fn(async (endpoint: string, options: any = {}) => {
      calls.push([endpoint, options]);
      if (endpoint === "/leads" && options.method === "POST") return { _embedded: { leads: [{ id: 700001 }] } };
      return { id: 700001 };
    });
    const env = environment(), sources = recovery.attestSources(env).sources;
    const date = jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    try {
      const adapter = recovery.createIsolatedAdapter(sources, request, agency);
      await adapter.createFixationRequest(recovery.payload({ row: row(), agency }, 800001));
    } finally { date.mockRestore(); }
    const firstPatch = calls.find(([endpoint, options]) => endpoint === "/leads/700001" && options.method === "PATCH");
    const actual = new Map(JSON.parse(firstPatch[1].body).custom_fields_values.map((field: any) => [field.field_id, field.values[0]]));
    const expected = new Map(recovery.exactLeadCustomFields(row(), NOW).map((field: any) => [field.field_id, field.values[0]]));
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [fieldId, value] of expected) if (fieldId !== 833189) expect(actual.get(fieldId)).toEqual(value);
    expect(Math.abs(Number((actual.get(833189) as any).value) - Number((expected.get(833189) as any).value))).toBeLessThanOrEqual(2);
    const note = calls.find(([endpoint, options]) => endpoint === "/leads/700001/notes" && options.method === "POST");
    expect(JSON.parse(note[1].body)[0].params.text).toBe(recovery.expectedRecoveryNote({ row: row(), agency }));
  });
  it("audit/failure projection cannot persist secret/raw exception fields", async () => {
    const db = database();
    await expect(recovery.audit(db.tx, "CLAIMED", metadata, { token: "private" })).rejects.toThrow();
    await expect(recovery.audit(db.tx, "UNRESOLVED", metadata, { reason: "private@example.test" })).rejects.toThrow();
    await expect(recovery.audit(db.tx, "CLAIMED", { ...metadata, phone: "+79991234567" })).rejects.toThrow();
    expect(recovery.safeFailureCode(Error("private@example.test +79991234567"))).toBe("RECOVERY_REFUSED");
  });
});
