import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "yaml";
import { AMO_CONTACT_FIELDS } from "../../../../packages/integrations/src/amo-crm.fields";

describe("approved single-client GET-only amo inspector", () => {
  const root = resolve(__dirname, "../../../..");
  const scriptPath = resolve(root, "scripts/inspect-fixed-amo-fixation-case.js");
  const source = readFileSync(scriptPath, "utf8");
  const workflowSource = readFileSync(resolve(root, ".github/workflows/inspect-fixed-amo-fixation-case.yml"), "utf8");
  const dependencySource = readFileSync(resolve(root, "scripts/inspect-amo-fixation-lead-reconciliation.js"), "utf8");
  const NodeModule = jest.requireActual("module") as any;
  const loaded = new NodeModule(scriptPath, module);
  loaded.filename = scriptPath;
  loaded.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
  loaded._compile(source, scriptPath);
  const inspector = loaded.exports;
  const scanNow = new Date("2026-10-08T09:00:00Z");
  const run = (args: any) => inspector.run({ ...args, now: () => scanNow });
  const workflow = parse(workflowSource);
  const runSource = workflow.jobs.inspect.steps[1].run.replace(/\r\n/g, "\n");
  const env = {
    FIXED_CASE_INSPECTOR_SHA256: "a".repeat(64),
    FIXED_CASE_DEPENDENCY_SHA256: "b".repeat(64),
    FIXED_CASE_DEPLOYED_GIT_SHA: "c".repeat(40),
    PRODUCTION_PG_SYSTEM_IDENTIFIER: "1234567",
    PRODUCTION_MIN_BROKER_ROWS: "100",
    AMO_ACCESS_TOKEN: "private-env-token",
  };
  const metadata = { inspectorSha256: env.FIXED_CASE_INSPECTOR_SHA256, dependencySha256: env.FIXED_CASE_DEPENDENCY_SHA256, deployedGitSha: env.FIXED_CASE_DEPLOYED_GIT_SHA };
  const row = (changes: any = {}) => ({
    id: inspector.CLIENT_ID, brokerId: inspector.EXPECTED_BROKER_ID,
    responsibleBrokerId: null, responsibleBroker: null,
    broker: { id: inspector.EXPECTED_BROKER_ID, phone: "+79998887766", amoContactId: 900001n, role: "BROKER", status: "ACTIVE", mergedIntoId: null, brokerAgencies: [{ agencyId: "private-agency", isPrimary: true }] },
    phone: "+79991234567", fullName: "private-name", project: "ZORGE9", fixationAgencyId: "private-agency",
    createdAt: new Date("2026-10-08T08:00:00Z"), updatedAt: new Date("2026-10-08T08:02:00Z"),
    amoLeadId: null, amoCreatedAt: null, amoUpdatedAt: null,
    amoSyncStatus: "FAILED", amoSyncAttempts: 3, amoSyncLastAttemptAt: new Date("2026-10-08T08:01:00Z"),
    amoSyncError: "AMO_CREATE_RECONCILIATION_REQUIRED: private-name private@example.test +79991234567",
    uniquenessStatus: "CONDITIONALLY_UNIQUE", uniquenessExpiresAt: new Date("2026-11-07T08:00:00Z"),
    fixationStatus: "NOT_FIXED", fixationExpiresAt: null, status: "NEW", ...changes,
  });
  const created = Math.floor(row().createdAt.getTime() / 1000);
  const envelope = (leadId = 101, changes: any = {}) => ({ leadId, pipelineId: 7600542, statusId: 62907350, createdAt: created, sourceMarker: true, requestValues: [created], projectValues: ["Зорге 9"], contactIds: [800001, 900001], ...changes });
  const evidence = (leads: any[] = [envelope()], contacts = [800001]) => ({ byPhone: new Map([["+79991234567", { exactContactIds: contacts, leads }]]), stats: { normalizedPhones: 1, contactSearchPages: 1, contactRowsRead: contacts.length, exactContacts: contacts.length, distinctLinkedLeadsRead: leads.length } });
  function database(rows = [row(), row()], token: any = "private-db-token", identityChanges: any = {}) {
    let index = 0;
    const tx = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => strings.join("").includes("pg_control_system") ? [{ read_only: "on", database_name: "broker_platform", system_identifier: "1234567", broker_rows: "1000", ...identityChanges }] : [{ mode: "on" }]),
      client: { findUnique: jest.fn(async () => rows[Math.min(index++, rows.length - 1)]) },
      auditLog: { findMany: jest.fn(async () => []) },
      systemSetting: { findUnique: jest.fn(async () => token === null ? null : { value: token }) },
    };
    return { tx, $transaction: jest.fn(async (callback: any) => callback(tx)) };
  }
  function json(payload: any, status = 200) {
    let done = false;
    return { status, ok: status >= 200 && status < 300, headers: { get: (_name?: string): string | null => null }, body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from(JSON.stringify(payload)) }), cancel: async () => {}, releaseLock: () => {} }) } };
  }
  const clientContact = (id = 800001, leads = [101]) => ({ id, name: "private-name", custom_fields_values: [{ field_id: 557903, values: [{ value: "+79991234567" }] }], _embedded: { leads: leads.map((id) => ({ id })) } });
  const crmLead = (id = 101) => ({ id, name: "private-name", pipeline_id: 7600542, status_id: 62907350, created_at: created, _embedded: { contacts: [{ id: 800001 }, { id: 900001 }] }, custom_fields_values: [{ field_id: 665195, values: [{ enum_id: 985337 }] }, { field_id: 833189, values: [{ value: created }] }, { field_id: 839179, values: [{ value: "Зорге 9" }] }] });
  const crm = () => jest.fn(async (url: URL) => {
    const path = new URL(url).pathname;
    if (path === "/api/v4/account") return json({ id: 28552900 });
    if (path === "/api/v4/contacts/900001") return json({ id: 900001, name: "private-broker", _embedded: { leads: [] }, custom_fields_values: [{ field_id: 557903, values: [{ value: "+79998887766" }] }, { field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] }] });
    if (path === "/api/v4/contacts") return json({ _embedded: { contacts: [clientContact()] } });
    if (path === "/api/v4/contacts/800001") return json(clientContact());
    if (path === "/api/v4/leads/101") return json(crmLead());
    if (path === "/api/v4/leads") return json({ _embedded: { leads: [] } });
    throw Error("Unexpected private@example.test +79991234567");
  });

  it("binds exact approved UUIDs with no operator scope", () => {
    expect(inspector.CLIENT_ID).toBe("8d082b21-7cba-4778-a6c6-1d80bfe7ed7c");
    expect(inspector.EXPECTED_BROKER_ID).toBe("6e414141-f2ca-4c71-8402-2032c9186568");
    expect(workflow.on.workflow_dispatch).toEqual({});
    expect(inspector.CLIENT_SELECT.fullName).toBe(true);
    expect(inspector.CLIENT_SELECT.email).toBeUndefined();
    expect(inspector.CLIENT_SELECT.broker.select.passwordHash).toBeUndefined();
  });
  it("reports scoped lead IDs and safe evidence, without raw/private records", () => {
    const report = inspector.buildReport(row(), evidence(), { id: 900001 }, null, metadata);
    expect(report.conclusion).toBe("unique_strong_candidate_advisory");
    expect(report.strongLeadIds).toEqual([101]);
    expect(report.candidates[0]).toMatchObject({ leadId: 101, pipelineId: 7600542, expectedBrokerAttachment: "present", strictBrokerSourceMarker: true });
    expect(report.database.errorClass).toBe("create_reconciliation_required");
    expect(report.advisory).toMatchObject({ executablePayload: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false });
    expect(JSON.stringify(report)).not.toMatch(/private-name|private-broker|private-agency|example.test|79991234567|rawValidValues|contactIds|attestationRecord/);
  });
  it("keeps all strong IDs even when duplicate exact contacts require manual review", () => {
    const report = inspector.buildReport(row(), evidence([envelope()], [800001, 800002]), {}, null, metadata);
    expect(report.exactClientContactCount).toBe(2);
    expect(report.strongLeadIds).toEqual([101]);
    expect(report.resolution).toBe("ambiguous_exact_client_contacts");
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it.each([
    ["multiple strong", evidence([envelope(101), envelope(102)]), "multiple_strong_candidates"],
    ["strong and weak", evidence([envelope(101), envelope(102, { projectValues: [] })]), "single_strong_with_weak_candidates"],
    ["weak", evidence([envelope(101, { projectValues: [] })]), "single_weak_candidate"],
    ["no exact contact", evidence([], []), "no_exact_client_contact"],
    ["outside KC", evidence([envelope(101, { pipelineId: 77 })]), "no_candidate"],
  ])("does not pick the first candidate: %s", (_name, found, resolution) => {
    const report = inspector.buildReport(row(), found, {}, null, metadata);
    expect(report.resolution).toBe(resolution);
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it("limits absence to the completed contact-linked KC scope", () => {
    const report = inspector.buildReport(row(), evidence([], []), null, null, metadata);
    expect(report.conclusion).toBe("no_contact_linked_kc_candidate_observed");
    expect(report.advisory.amoMutationAuthorized).toBe(false);
  });
  it("does not qualify a missing broker contact or absent source marker", () => {
    expect(inspector.buildReport(row(), evidence(), null, null, metadata).advisory.candidateLinkEvidenceSufficient).toBe(false);
    expect(inspector.buildReport(row(), evidence([envelope(101, { sourceMarker: false })]), {}, null, metadata).advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it("reports a stored link separately, never as an automatic relink", () => {
    const report = inspector.buildReport(row({ amoLeadId: 111n }), evidence(), {}, envelope(111), metadata);
    expect(report.database.storedLeadId).toBe(111);
    expect(report.database.storedLeadEvidence.exactClientContactLinked).toBe(true);
    expect(report.conclusion).toBe("stored_link_requires_review");
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it.each([
    ["wrong client", { id: "different" }, "FIXED_CLIENT_MISSING"],
    ["unresolved responsible", { responsibleBrokerId: "unresolved" }, "RESPONSIBLE_BROKER_UNRESOLVED"],
    ["wrong broker", { brokerId: "different", broker: { ...row().broker, id: "different" } }, "EXPECTED_BROKER_MISMATCH"],
    ["staff", { broker: { ...row().broker, role: "ADMIN" } }, "EXPECTED_BROKER_NOT_CANONICAL"],
    ["merged", { broker: { ...row().broker, mergedIntoId: "other" } }, "EXPECTED_BROKER_NOT_CANONICAL"],
    ["invalid phone", { phone: "invalid" }, "INVALID_CLIENT_PHONE"],
    ["unsupported project", { project: "UNKNOWN" }, "PROJECT_MAPPING_UNSUPPORTED"],
    ["malformed timestamp", { createdAt: new Date("invalid") }, "INVALID_CASE_TIMESTAMP"],
    ["unsafe attempts", { amoSyncAttempts: -1 }, "INVALID_SYNC_ATTEMPTS"],
    ["invalid state", { status: "private-name" }, "INVALID_CASE_STATE"],
    ["agency overflow", { broker: { ...row().broker, brokerAgencies: new Array(101).fill({}) } }, "AGENCY_SCOPE_TOO_LARGE"],
  ])("fails closed before token or AMO lookup: %s", async (_name, changes, code) => {
    const db = database([row(changes)]);
    const fetchImpl = crm();
    await expect(run({ prisma: db, environment: env, fetchImpl })).rejects.toMatchObject({ safeCode: code });
    expect(db.tx.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { read_only: "off" }, { database_name: "other" }, { system_identifier: "999" }, { broker_rows: "1" }, { broker_rows: "1\n1000" },
  ])("checks exact read-only database identity and floor before the client SELECT: %j", async (changes) => {
    const db = database(undefined, undefined, changes);
    await expect(run({ prisma: db, environment: env, fetchImpl: crm() })).rejects.toMatchObject({ safeCode: "DATABASE_IDENTITY_MISMATCH" });
    expect(db.tx.client.findUnique).not.toHaveBeenCalled();
  });
  it("uses DB token, GET only, current account, full evidence and a final snapshot", async () => {
    const db = database();
    const fetchImpl = crm();
    const report = await run({ prisma: db, environment: env, fetchImpl });
    expect(report.strongLeadIds).toEqual([101]);
    expect(db.tx.client.findUnique).toHaveBeenCalledTimes(2);
    expect(db.tx.systemSetting.findUnique).toHaveBeenCalledTimes(1);
    expect((db.tx.systemSetting.findUnique.mock.calls as any)[0][0]).toEqual({ where: { key: "AMO_ACCESS_TOKEN" }, select: { value: true } });
    for (const [url, options] of fetchImpl.mock.calls as any) {
      expect(new URL(url).origin).toBe("https://stmichael.amocrm.ru");
      expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer private-db-token" } });
    }
  });
  it("reads bounded audit snapshots in both readonly transactions and flags changed audit evidence", async () => {
    const db = database();
    const entry = { id: 'audit1', entity: 'Client', entityId: inspector.CLIENT_ID, createdAt: new Date('2026-10-08T14:18:19Z'), action: 'AMO_SYNC_FAILED', payload: { error: 'HTTP status 503 private-token' } };
    let calls = 0;
    (db.tx.auditLog.findMany as any).mockImplementation(async () => ++calls === 1 ? [entry] : []);
    const report = await run({ prisma: db, environment: env, fetchImpl: crm() });
    expect(db.tx.auditLog.findMany).toHaveBeenCalledTimes(4);
    expect(db.tx.auditLog.findMany).toHaveBeenCalledWith(inspector.auditQuery());
    expect(report.caseAudit).toMatchObject({ stableReadback: false, recordsRead: 1, absenceProof: false });
    expect(JSON.stringify(report)).not.toContain('private-token');
  });
  it("pairs the narrow durable recovery read inside the same readonly snapshots and flags drift", async () => {
    const db = database();
    const entry = { id: 'durable1', entity: 'AmoFixedCaseRecovery', entityId: inspector.CLIENT_ID,
      createdAt: new Date('2026-10-11T20:00:00Z'), action: 'AMO_FIXED_CASE_CLAIMED',
      payload: { phase: 'CLAIMED', runId: '38150838032', secret: 'never-public' } };
    let durableReads = 0;
    (db.tx.auditLog.findMany as any).mockImplementation(async (query: any) =>
      query.where.entity === 'AmoFixedCaseRecovery' && ++durableReads === 1 ? [entry] : []);
    const report = await run({ prisma: db, environment: env, fetchImpl: crm() });
    expect(durableReads).toBe(2);
    expect(db.tx.auditLog.findMany).toHaveBeenCalledWith(inspector.recoveryAuditQuery());
    expect(report.recoveryAudit).toMatchObject({ stableReadback: false, absenceProof: false,
      recordsRead: 1, events: [{ phase: 'CLAIMED', applyRunMatches: true }] });
    expect(JSON.stringify(report)).not.toContain('never-public');
    expect(db.tx.auditLog).not.toHaveProperty('create');
  });
  it("uses env only when the DB access-token setting is empty", async () => {
    const fetchImpl = jest.fn(async () => json({ id: 1 }));
    await expect(run({ prisma: database(undefined, " "), environment: env, fetchImpl })).rejects.toThrow("Unexpected amoCRM account");
    expect((fetchImpl.mock.calls as any)[0][1].headers.Authorization).toBe("Bearer private-env-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("fails on unauthorized without fallback token, refresh, or retry", async () => {
    const fetchImpl = jest.fn(async () => json({}, 401));
    await expect(run({ prisma: database(), environment: env, fetchImpl })).rejects.toThrow("amoCRM request rejected");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("refuses concurrent row changes instead of printing stale advice", async () => {
    await expect(run({ prisma: database([row(), row({ amoSyncAttempts: 4 })]), environment: env, fetchImpl: crm() })).rejects.toMatchObject({ safeCode: "CASE_CHANGED_DURING_SCAN" });
  });
  it("honours explicit responsible broker, not a different coordinator owner", () => {
    const actual = row({ brokerId: "coordinator", broker: { ...row().broker, id: "coordinator", role: "MANAGER" }, responsibleBrokerId: inspector.EXPECTED_BROKER_ID, responsibleBroker: row().broker });
    expect(inspector.validateCase(actual).source).toBe("responsible");
  });
  it.each([
    ["ADMIN", null, false],
    ["MANAGER", null, false],
    ["BROKER", "private-merged-target", false],
  ])("reports a scoped ownership mismatch DB-only without token/CRM: %s", async (role, mergedIntoId, canonical) => {
    const actual = row({
      responsibleBrokerId: "private-unexpected-broker",
      responsibleBroker: { ...row().broker, id: "private-unexpected-broker", role, mergedIntoId },
    });
    const db = database([actual]);
    const fetchImpl = crm();
    const report = await run({ prisma: db, environment: env, fetchImpl });
    expect(report).toMatchObject({ expectedBrokerMatched: false, expectedBrokerIsOwner: true, expectedBrokerIsResponsible: false, mappingSource: "responsible", effectiveBrokerRole: role, effectiveBrokerStatus: "ACTIVE", effectiveBrokerCanonical: canonical, crmInspectionPerformed: false, tokenRead: false, conclusion: "effective_broker_mismatch_db_only" });
    expect(report.database).toMatchObject({ project: "ZORGE9", status: "NEW", amoSyncStatus: "FAILED", amoSyncAttempts: 3, errorClass: "create_reconciliation_required" });
    expect(report.advisory).toEqual({ executablePayload: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false, candidateLinkEvidenceSufficient: false });
    expect(db.tx.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(db.tx.client.findUnique).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/private-unexpected-broker|private-merged-target|private-name|private-db-token|79991234567|example.test|rawValidValues/);
  });
  it("still refuses the exact client when the expected broker is neither owner nor responsible", async () => {
    const actual = row({ brokerId: "private-other-owner", broker: { ...row().broker, id: "private-other-owner" }, responsibleBrokerId: "private-other-responsible", responsibleBroker: { ...row().broker, id: "private-other-responsible" } });
    const db = database([actual]);
    const fetchImpl = crm();
    await expect(run({ prisma: db, environment: env, fetchImpl })).rejects.toMatchObject({ safeCode: "EXPECTED_BROKER_MISMATCH" });
    expect(db.tx.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reads the canonical PENDING responsible of this exact owner, without repair advice or identity output", async () => {
    const actual = row({ responsibleBrokerId: "private-stored-responsible", responsibleBroker: { ...row().broker, id: "private-stored-responsible", status: "PENDING" } });
    const db = database([actual, actual]);
    const fetchImpl = crm();
    const report = await run({ prisma: db, environment: env, fetchImpl });
    expect(report).toMatchObject({ expectedBrokerMatched: false, expectedBrokerIsOwner: true, expectedBrokerIsResponsible: false, mappingSource: "responsible", effectiveBrokerRole: "BROKER", effectiveBrokerStatus: "PENDING", effectiveBrokerCanonical: true, crmInspectionPerformed: true, brokerLinkageReference: "stored_effective_broker_contact", brokerContactMatchesCurrentBrokerPhone: true, brokerContactHasBrokerFlag: true, brokerContactBrokerFlagEvidence: "valid" });
    expect(report.strongLeadIds).toEqual([101]);
    expect(report.candidates[0]).toMatchObject({ effectiveBrokerAttachment: "present", expectedBrokerAttachment: "not_inspected" });
    expect(report.advisory).toEqual({ executablePayload: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false, candidateLinkEvidenceSufficient: false });
    expect(db.tx.systemSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(db.tx.client.findUnique).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchImpl.mock.calls as any) {
      expect(new URL(url).origin).toBe("https://stmichael.amocrm.ru");
      expect(options.method).toBe("GET");
    }
    expect(JSON.stringify(report)).not.toMatch(/private-stored-responsible|private-agency|private-name|private-db-token|79991234567|79998887766|example.test|rawValidValues|contactIds/);
  });
  it("does not emit repair advice even for an ACTIVE canonical responsible mismatch", () => {
    const actual = row({ responsibleBrokerId: "private-stored-responsible", responsibleBroker: { ...row().broker, id: "private-stored-responsible", status: "ACTIVE" } });
    const brokerContact = { id: 900001, custom_fields_values: [{ field_id: 557903, values: [{ value: "+79998887766" }] }, { field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] }] };
    const report = inspector.buildReport(actual, evidence(), brokerContact, null, metadata);
    expect(report.expectedBrokerMatched).toBe(false);
    expect(report.brokerContactMatchesCurrentBrokerPhone).toBe(true);
    expect(report.brokerContactHasBrokerFlag).toBe(true);
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
  });
  it.each([
    [{ phone: "invalid" }, "INVALID_CLIENT_PHONE"],
    [{ project: "UNKNOWN" }, "PROJECT_MAPPING_UNSUPPORTED"],
    [{ responsibleBroker: { ...row().broker, id: "private-stored-responsible", brokerAgencies: new Array(101).fill({}) } }, "AGENCY_SCOPE_TOO_LARGE"],
    [{ broker: { ...row().broker, id: "private-not-approved-owner" } }, "OWNER_BROKER_UNRESOLVED"],
  ])("validates newly allowed canonical-responsible scope before token/CRM", async (changes, code) => {
    const actual = row({ responsibleBrokerId: "private-stored-responsible", responsibleBroker: { ...row().broker, id: "private-stored-responsible", status: "PENDING" }, ...changes });
    const db = database([actual]);
    const fetchImpl = crm();
    await expect(run({ prisma: db, environment: env, fetchImpl })).rejects.toMatchObject({ safeCode: code });
    expect(db.tx.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects a changed canonical responsible snapshot after the GET scan", async () => {
    const initial = row({ responsibleBrokerId: "private-stored-responsible", responsibleBroker: { ...row().broker, id: "private-stored-responsible", status: "PENDING" } });
    const changed = { ...initial, responsibleBroker: { ...initial.responsibleBroker, phone: "+79998880000" } };
    await expect(run({ prisma: database([initial, changed]), environment: env, fetchImpl: crm() })).rejects.toMatchObject({ safeCode: "CASE_CHANGED_DURING_SCAN" });
  });
  it("binds the reported broker checkbox to the reviewed shared field constant", () => {
    expect(inspector.IS_BROKER_FIELD_ID).toBe(AMO_CONTACT_FIELDS.IS_BROKER);
  });
  it.each([
    [undefined, "missing", null],
    [[], "missing", null],
    [[{ field_id: 835415, values: [{ value: true }] }], "valid", true],
    [[{ field_id: 835415, values: [{ value: false }] }], "valid", false],
    [[{ field_id: 835415, values: [{ value: "true" }] }], "invalid", null],
    [[{ field_id: 835415, values: [{ value: 1 }] }], "invalid", null],
    [[{ field_id: 835415, values: [{ value: true }, { value: false }] }], "invalid", null],
    [[{ field_id: 835415, values: [{ value: true }] }, { field_id: 835415, values: [{ value: true }] }], "invalid", null],
  ])("does not invent broker-flag evidence: %j", (fields, coverage, value) => {
    expect(inspector.brokerFlagEvidence({ custom_fields_values: fields })).toEqual({ coverage, value });
  });
  it("keeps an unmatched broker phone as safe negative evidence, never a phone output", () => {
    const report = inspector.buildReport(row(), evidence(), { id: 900001, custom_fields_values: [{ field_id: 557903, values: [{ value: "+79990000000" }] }] }, null, metadata);
    expect(report.brokerContactMatchesCurrentBrokerPhone).toBe(false);
    expect(report.advisory.candidateLinkEvidenceSufficient).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/79990000000|79998887766/);
  });
  it.each([
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { FIXED_CASE_INSPECTOR_SHA256: "wrong" }, { PRODUCTION_MIN_BROKER_ROWS: "0" }, { PRODUCTION_MIN_BROKER_ROWS: "9007199254740992" },
  ])("refuses unsafe runtime attestation: %j", async (changes) => {
    const db = database();
    await expect(run({ prisma: db, environment: { ...env, ...changes }, fetchImpl: crm() })).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("redacts raw provider/database failures and malicious getter errors", () => {
    expect(inspector.failureCode(Error("private@example.test +79991234567 private-token"))).toBe("UNKNOWN_FAILURE");
    expect(inspector.failureCode({ get safeCode() { throw Error("private-token"); } })).toBe("UNKNOWN_FAILURE");
  });
  const brokerWithLeads = (ids: number[] = []) => ({ id: 900001, _embedded: { leads: ids.map((id) => ({ id })) } });
  const expanded = (changes: any = {}) => inspector.collectExpandedEvidence({ row: row(), brokerContact: brokerWithLeads(), contactEvidence: evidence([], []), request: jest.fn(), requestWindow: jest.fn(async () => null), scanNow, ...changes });
  const generatedLead = (changes: any = {}) => ({ ...crmLead(), name: "Фиксация: private-name (ZORGE9)", ...changes });
  const leadsPage = (leads: any[], next: any = undefined) => ({ _embedded: { leads }, ...(next === undefined ? {} : { _links: { next } }) });
  it("allows a delayed manual review within seven days without changing pagination bounds", () => {
    const delayed = new Date("2026-10-11T11:00:00Z");
    const window = inspector.makeEvidenceWindow(row(), delayed);
    expect(window).toEqual({ pipelineId: 7600542, from: created - 120, to: Math.floor(delayed.getTime() / 1000) + 120 });
    expect(inspector.WINDOW_MAX_PAGES).toBe(10);
    expect(inspector.WINDOW_PAGE_LIMIT).toBe(250);
    expect(() => inspector.makeEvidenceWindow(row(), new Date("2026-10-15T08:00:01Z"))).toThrow();
    expect(() => inspector.makeEvidenceWindow(row(), new Date("2026-10-08T07:57:59Z"))).toThrow();
  });
  it("certifies only the completed bounded scopes, not write authority or global CRM absence", async () => {
    const found = await expanded();
    expect(inspector.assertCompleteNegativeEvidence(found, row())).toBe(true);
    const report = inspector.buildReport(row(), evidence([], []), brokerWithLeads(), null, metadata, found);
    expect(report.conclusion).toBe("no_possible_lead_observed_in_complete_bounded_scopes");
    expect(report.expandedEvidence).toMatchObject({ complete: true, negativeEvidenceComplete: true, kcWindowPagesRead: 1, kcWindowLeadsRead: 0, storedBrokerLinkedLeadsRead: 0, possibleLeadIds: [], absenceScope: "contact_links_and_all_stored_broker_links_and_bounded_kc_creation_window_only" });
    expect(report.advisory.amoMutationAuthorized).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/private-name|private-agency|79991234567|databaseFingerprint|privateLead/);
  });
  it.each([
    { _embedded: { contacts: [] }, custom_fields_values: [] },
    { _embedded: { contacts: [{ id: 7 }] }, custom_fields_values: [{ field_id: 839179, values: [{ value: "Unknown private project" }] }] },
  ])("retains exact generated names despite lost broker/client/source/project evidence", async (changes) => {
    const lead = generatedLead(changes);
    const found = await expanded({ requestWindow: jest.fn(async () => leadsPage([lead])) });
    expect(found.possibleCandidates).toHaveLength(1);
    expect(found.possibleCandidates[0]).toMatchObject({ leadId: 101, exactGeneratedName: true, effectiveBrokerLinked: false, exactClientContactLinked: false, strictBrokerSourceMarker: false, scopes: ["kc_creation_window"] });
    expect(() => inspector.assertCompleteNegativeEvidence(found, row())).toThrow();
    const report = inspector.buildReport(row(), evidence([], []), brokerWithLeads(), null, metadata, found);
    expect(report.conclusion).toBe("possible_lead_observed_in_expanded_scopes");
    expect(report.expandedEvidence.possibleLeadIds).toEqual([101]);
    expect(report.expandedEvidence.negativeEvidenceComplete).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/private-name|Unknown private project|privateLead|contactIds|projectValues|requestValues/);
  });
  it("hydrates every broker lead including moved/out-of-window orphaned same-name leads", async () => {
    const request = jest.fn(async (_path: string) => generatedLead({ pipeline_id: 77, created_at: created - 86400, _embedded: { contacts: [] } }));
    const found = await expanded({ brokerContact: brokerWithLeads([101]), request });
    expect(request).toHaveBeenCalledWith("/api/v4/leads/101", { with: "contacts" });
    expect(found.possibleCandidates[0]).toMatchObject({ leadId: 101, pipelineId: 77, exactGeneratedName: true, effectiveBrokerLinked: false, scopes: ["stored_broker_link"] });
    expect(() => inspector.assertCompleteNegativeEvidence(found, row())).toThrow();
  });
  it("conservatively retains broker-linked recent KC leads even when their name differs", async () => {
    const found = await expanded({ requestWindow: jest.fn(async () => leadsPage([crmLead()])) });
    expect(found.possibleCandidates[0]).toMatchObject({ exactGeneratedName: false, effectiveBrokerLinked: true });
  });
  it("retains exact client linkage even with a different name and no broker", async () => {
    const found = await expanded({ contactEvidence: evidence([], [800001]), requestWindow: jest.fn(async () => leadsPage([{ ...crmLead(), _embedded: { contacts: [{ id: 800001 }] } }])) });
    expect(found.possibleCandidates[0]).toMatchObject({ exactGeneratedName: false, effectiveBrokerLinked: false, exactClientContactLinked: true });
  });
  it("does not expose unrelated window lead IDs or names in the public projection", async () => {
    const found = await expanded({ requestWindow: jest.fn(async () => leadsPage([generatedLead({ id: 303, name: "unrelated-private-name", _embedded: { contacts: [{ id: 42 }] } })])) });
    expect(found.kcWindowLeads).toHaveLength(1);
    expect(found.possibleCandidates).toEqual([]);
    const report = inspector.buildReport(row(), evidence([], []), brokerWithLeads(), null, metadata, found);
    expect(JSON.stringify(report)).not.toMatch(/unrelated-private-name|"leadId":303|"id":42|privateLead/);
  });
  it("deduplicates the same candidate across both scopes and refuses changed evidence", async () => {
    const request = jest.fn(async () => generatedLead());
    const found = await expanded({ brokerContact: brokerWithLeads([101]), request, requestWindow: jest.fn(async () => leadsPage([generatedLead()])) });
    expect(found.possibleCandidates).toHaveLength(1);
    expect(found.possibleCandidates[0].scopes).toEqual(["kc_creation_window", "stored_broker_link"]);
    await expect(expanded({ brokerContact: brokerWithLeads([101]), request: jest.fn(async () => generatedLead({ status_id: 142 })), requestWindow: jest.fn(async () => leadsPage([generatedLead()])) })).rejects.toMatchObject({ safeCode: "EXPANDED_LEAD_CHANGED_DURING_SCAN" });
  });
  it.each([
    [{ id: "101" }, "WINDOW_LEAD_DUPLICATED"],
    [{ pipeline_id: 77 }, "WINDOW_LEAD_OUT_OF_SCOPE"],
    [{ status_id: 0 }, "EXPANDED_LEAD_INVALID"],
    [{ created_at: String(created) }, "EXPANDED_LEAD_INVALID"],
    [{ created_at: created - 121 }, "WINDOW_LEAD_OUT_OF_SCOPE"],
    [{ created_at: Math.floor(scanNow.getTime() / 1000) + 121 }, "WINDOW_LEAD_OUT_OF_SCOPE"],
    [{ name: null }, "EXPANDED_LEAD_INVALID"],
    [{ name: "x".repeat(4001) }, "EXPANDED_LEAD_INVALID"],
    [{ _embedded: {} }, "EXPANDED_LEAD_INVALID"],
    [{ _embedded: { contacts: [{ id: 1 }, { id: 1 }] } }, "EXPANDED_LEAD_INVALID"],
    [{ _embedded: { contacts: [{ id: "1" }] } }, "EXPANDED_LEAD_INVALID"],
    [{ _embedded: { contacts: Array.from({ length: 51 }, (_, i) => ({ id: i + 1 })) } }, "EXPANDED_LEAD_INVALID"],
  ])("refuses malformed/out-of-scope window records rather than certifying absence", async (changes, code) => {
    await expect(expanded({ requestWindow: jest.fn(async () => leadsPage([generatedLead(changes)])) })).rejects.toMatchObject({ safeCode: code });
  });
  it.each([
    { _embedded: { leads: {} } },
    { _embedded: { leads: [] }, _links: "private-link" },
    { _embedded: { leads: [] }, _links: { next: "https://evil.test/private" } },
    { _embedded: { leads: [] }, _links: { next: {} } },
  ])("rejects invalid or looping pagination", async (payload) => {
    await expect(expanded({ requestWindow: jest.fn(async () => payload) })).rejects.toThrow();
  });
  it("uses numeric page increments, ignores next href, and rejects duplicate IDs across pages", async () => {
    const requestWindow = jest.fn(async (page: number) => page === 1 ? leadsPage([generatedLead()], { href: "https://evil.test/private" }) : null);
    const found = await expanded({ requestWindow });
    expect(found.windowPagesRead).toBe(2);
    expect(requestWindow.mock.calls).toEqual([[1], [2]]);
    await expect(expanded({ requestWindow: jest.fn(async () => leadsPage([generatedLead()], {})) })).rejects.toMatchObject({ safeCode: "WINDOW_LEAD_DUPLICATED" });
  });
  it("requires a demonstrable final page and bounds the scan at ten pages", async () => {
    const full = Array.from({ length: 250 }, (_, i) => generatedLead({ id: i + 1 }));
    await expect(expanded({ requestWindow: jest.fn(async () => leadsPage(full)) })).rejects.toMatchObject({ safeCode: "WINDOW_PAGINATION_INCOMPLETE" });
    const requestWindow = jest.fn(async (page: number) => leadsPage([generatedLead({ id: page })], {}));
    await expect(expanded({ requestWindow })).rejects.toMatchObject({ safeCode: "WINDOW_PAGE_BOUND_EXCEEDED" });
    expect(requestWindow).toHaveBeenCalledTimes(10);
  });
  it.each([
    null,
    { id: 900001 },
    { id: 900001, _embedded: { leads: [{ id: 101 }, { id: 101 }] } },
    { id: 900001, _embedded: { leads: [{ id: "101" }] } },
    brokerWithLeads(Array.from({ length: 251 }, (_, i) => i + 1)),
  ])("refuses unavailable, duplicate or unbounded broker links", async (brokerContact) => {
    await expect(expanded({ brokerContact })).rejects.toThrow();
  });
  it("aborts when any broker-linked lead cannot be hydrated", async () => {
    await expect(expanded({ brokerContact: brokerWithLeads([101]), request: jest.fn(async () => null) })).rejects.toMatchObject({ safeCode: "EXPANDED_LEAD_INVALID" });
    await expect(expanded({ brokerContact: brokerWithLeads([101]), request: jest.fn(async () => { throw Error("private-token"); }) })).rejects.toThrow();
  });
  it.each([
    { createdAt: new Date(scanNow.getTime() - (7 * 86400 + 1) * 1000) },
    { createdAt: new Date(scanNow.getTime() + 121 * 1000) },
    { fullName: null }, { fullName: "" }, { fullName: "private\nname" }, { fullName: "x".repeat(1001) },
  ])("refuses stale/future/name-invalid case scopes before AMO calls", async (changes) => {
    const fetchImpl = crm();
    await expect(run({ prisma: database([row(changes)]), environment: env, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("requires current fingerprint, full proof, no contact-linked lead and no stored lead", async () => {
    const found = await expanded();
    expect(() => inspector.assertCompleteNegativeEvidence({ ...found, complete: false }, row())).toThrow();
    expect(() => inspector.assertCompleteNegativeEvidence({ ...found, brokerLinkedLeads: undefined }, row())).toThrow();
    expect(() => inspector.assertCompleteNegativeEvidence(found, row({ updatedAt: scanNow }))).toThrow();
    expect(() => inspector.assertCompleteNegativeEvidence({ ...found, contactEvidence: evidence([envelope()]) }, row())).toThrow();
    const linkedRow = row({ amoLeadId: 101n });
    expect(() => inspector.assertCompleteNegativeEvidence({ ...found, databaseFingerprint: inspector.privateFingerprint(linkedRow) }, linkedRow)).toThrow();
  });
  it("uses only the canonical bounded KC GET query, strict redirects and private auth", async () => {
    const window = inspector.makeEvidenceWindow(row(), scanNow);
    const fetchImpl = jest.fn(async () => json({ _embedded: { leads: [] } }));
    const requestWindow = inspector.createKcWindowRequester(" private-token ", fetchImpl, window);
    await requestWindow(1);
    const [rawUrl, options] = fetchImpl.mock.calls[0] as any;
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname).toBe("https://stmichael.amocrm.ru/api/v4/leads");
    expect(Object.fromEntries(url.searchParams)).toEqual({ "filter[created_at][from]": String(created - 120), "filter[created_at][to]": String(Math.floor(scanNow.getTime() / 1000) + 120), "filter[pipeline_id][]": "7600542", limit: "250", page: "1", with: "contacts" });
    expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer private-token" } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    await expect(requestWindow(11)).rejects.toMatchObject({ safeCode: "WINDOW_PAGE_BOUND_EXCEEDED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 500])("does not refresh, retry or use fallback on window HTTP %s", async (status) => {
    const fetchImpl = jest.fn(async () => json({ private: "private-token" }, status));
    const requestWindow = inspector.createKcWindowRequester("private-token", fetchImpl, inspector.makeEvidenceWindow(row(), scanNow));
    await expect(requestWindow(1)).rejects.toMatchObject({ safeCode: "WINDOW_REQUEST_REJECTED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("sanitizes window network/body failures and never retries", async () => {
    for (const fetchImpl of [jest.fn(async () => { throw Error("private-token"); }), jest.fn(async () => json("private-provider-error"))]) {
      const requestWindow = inspector.createKcWindowRequester("private-token", fetchImpl, inspector.makeEvidenceWindow(row(), scanNow));
      await expect(requestWindow(1)).rejects.toMatchObject({ safeCode: "WINDOW_REQUEST_FAILED" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it("keeps the whole response within twelve seconds, aborts and never retries", async () => {
    // NodeModule executes outside Jest's fake-clock realm. Bind a deterministic
    // timer only in this test compilation and require the exact 12s deadline.
    const timed = new NodeModule(scriptPath, module);
    timed.filename = scriptPath;
    timed.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
    timed._compile('const setTimeout = (callback, milliseconds) => { if (milliseconds !== 12000) throw Error("Unexpected deadline"); queueMicrotask(callback); return 1; }; const clearTimeout = () => {};\n' + source, scriptPath);
    let signal: AbortSignal | undefined;
    const fetchImpl = jest.fn(async (_url: URL, options: any) => {
      signal = options.signal;
      return await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(Error("private-timeout")), { once: true }));
    });
    const requestWindow = timed.exports.createKcWindowRequester("private-token", fetchImpl, inspector.makeEvidenceWindow(row(), scanNow));
    await expect(requestWindow(1)).rejects.toMatchObject({ safeCode: "WINDOW_REQUEST_FAILED" });
    expect(signal!.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("refuses an oversized declared/streamed body and cancels without output", async () => {
    const declared = json({ private: "private-token" });
    declared.headers.get = (name: string) => name.toLowerCase() === "content-length" ? String(8 * 1024 * 1024 + 1) : null;
    const oversized = json({});
    oversized.body.getReader = () => ({ read: async () => ({ done: false, value: Buffer.alloc(8 * 1024 * 1024 + 1) }), cancel: async () => {}, releaseLock: () => {} });
    for (const response of [declared, oversized]) {
      const fetchImpl = jest.fn(async () => response);
      const requestWindow = inspector.createKcWindowRequester("private-token", fetchImpl, inspector.makeEvidenceWindow(row(), scanNow));
      await expect(requestWindow(1)).rejects.toMatchObject({ safeCode: "WINDOW_REQUEST_FAILED" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it("includes private fullName in the final snapshot guard, not the public report", async () => {
    await expect(run({ prisma: database([row(), row({ fullName: "changed-private-name" })]), environment: env, fetchImpl: crm() })).rejects.toMatchObject({ safeCode: "CASE_CHANGED_DURING_SCAN" });
  });
  it("uses only SELECTs, no resets, credentials refresh, repairs, messages or production mutations", () => {
    expect(source).not.toMatch(/\.(updateMany|upsert|create|delete|deleteMany|\$executeRaw)\s*\(|(?:prisma|tx)\.\w+\.update\s*\(/);
    expect(source).not.toMatch(/AMO_REFRESH_TOKEN|refreshAccessToken|sendMail|sendSms|createLead|setAmoTokens/);
    expect(source).toContain('where: { id: CLIENT_ID }');
    expect(source).toContain('current_setting(\'transaction_read_only\')');
    expect(workflowSource).not.toMatch(/docker\s+(restart|start|stop|kill|run|build|pull|push|compose)|git\s+(fetch|reset|checkout|pull|push)|\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/);
  });
  it("pins source, host, existing shared lock, root Docker endpoint and both DB identities", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "production-deploy", "cancel-in-progress": false });
    expect(workflow.jobs.inspect.environment).toBe("production");
    expect(runSource).toContain('test "$master_sha" = "$EXPECTED_SHA"');
    expect(runSource).toContain('case "$compare_status" in ahead|identical)');
    expect(runSource).toContain('test "$fingerprints" = "$EXPECTED_SSH_FINGERPRINT"');
    expect(runSource).toContain('-o StrictHostKeyChecking=yes');
    expect(runSource).toContain('exec 9<"$lock_path"');
    expect(runSource).toContain('flock -s -n 9');
    expect(runSource).toContain('unix:///var/run/docker.sock');
    expect(runSource).toContain('contains("rootless") | not');
    expect(runSource).toContain('BEGIN READ ONLY; SET LOCAL statement_timeout=');
    expect(runSource).toContain('FIXED_CASE_DEPENDENCY_SOURCE_SHA256=');
    expect(runSource).toContain('test "$(sha256sum "$inspector" | cut -d " " -f 1)" = "$expected_bundle_sha"');
  });
  it("builds the actual same-program module without invoking either main", () => {
    const bundleProgram = runSource.split("<<'BUNDLE'\n")[1].split("\nBUNDLE")[0];
    const { createHash } = require("crypto");
    const depHash = createHash("sha256").update(dependencySource).digest("hex");
    const ownHash = createHash("sha256").update(source).digest("hex");
    const result = spawnSync(process.execPath, ["-", resolve(root, "scripts/inspect-amo-fixation-lead-reconciliation.js"), scriptPath, depHash, ownHash], { input: bundleProgram, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0);
    const bundled = new NodeModule(scriptPath, module);
    bundled.filename = scriptPath;
    bundled.paths = NodeModule._nodeModulePaths(dirname(scriptPath));
    bundled._compile(result.stdout, scriptPath);
    expect(bundled.exports.CLIENT_ID).toBe(inspector.CLIENT_ID);
    expect(bundled.exports.validateCase(row()).source).toBe("owner_fallback");
    const bad = spawnSync(process.execPath, ["-", resolve(root, "scripts/inspect-amo-fixation-lead-reconciliation.js"), scriptPath, "0".repeat(64), ownHash], { input: bundleProgram, encoding: "utf8", timeout: 5000 });
    expect(bad.status).not.toBe(0);
  });
  it("parses actual Bash, without executing SSH/Docker/production commands", () => {
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    const result = spawnSync(bash, ["-n"], { input: runSource, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
