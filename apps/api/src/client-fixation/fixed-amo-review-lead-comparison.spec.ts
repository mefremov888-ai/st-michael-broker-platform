import { readFileSync } from "fs";
import { dirname, resolve } from "path";

describe("fixed amo candidate private comparison (read-only)", () => {
  const path = resolve(__dirname, "../../../../scripts/inspect-fixed-amo-fixation-case.js");
  const NodeModule = jest.requireActual("module") as any;
  const loaded = new NodeModule(path, module);
  loaded.filename = path;
  loaded.paths = NodeModule._nodeModulePaths(dirname(path));
  loaded._compile(readFileSync(path, "utf8"), path);
  const inspector = loaded.exports;
  const row = {
    id: inspector.CLIENT_ID, brokerId: inspector.EXPECTED_BROKER_ID, responsibleBrokerId: null,
    broker: { id: inspector.EXPECTED_BROKER_ID, role: "BROKER", status: "ACTIVE", mergedIntoId: null, amoContactId: 900001n, brokerAgencies: [] },
    phone: "+79991234567", fullName: "Приватное Имя", project: "ZORGE9", fixationAgencyId: null,
    amoSyncAttempts: 10, amoSyncStatus: "FAILED", uniquenessStatus: "CONDITIONALLY_UNIQUE", fixationStatus: "NOT_FIXED", status: "NEW",
    createdAt: new Date("2026-10-08T14:18:19Z"), updatedAt: new Date("2026-10-08T14:18:20Z"),
    amoCreatedAt: null, amoUpdatedAt: null, amoSyncLastAttemptAt: null, uniquenessExpiresAt: null, fixationExpiresAt: null, amoLeadId: null,
  };
  const lead = { id: inspector.REVIEW_LEAD_ID, name: "Приватное Имя", pipeline_id: 7600542, status_id: 143, created_at: 1791469099, _embedded: { contacts: [{ id: 900001 }, { id: 800001 }] }, custom_fields_values: [] };
  const window = { pipelineId: 7600542, from: 1791468979, to: 1791722448 };
  const expanded = (raw = lead) => ({ window, possibleCandidates: [{ leadId: inspector.REVIEW_LEAD_ID, privateLead: inspector.validatedLead(raw, raw.id, row, window, false) }] });
  const contact = { id: 800001, name: "Приватное Имя", custom_fields_values: [{ field_id: 557903, values: [{ value: "+79991234567" }] }] };
  const request = (raw = lead, c = contact) => jest.fn(async (path: string) => path.includes("/leads/") ? raw : c);
  const notes = (text: string) => ({ _embedded: { notes: [{ id: 1, entity_id: inspector.REVIEW_LEAD_ID, params: { text } }] } });
  it("reports name, contact phone and note markers without leaking private text", async () => {
    const get = request();
    const result = await inspector.collectReviewLeadComparison(row, expanded(), get, async () => notes(`Приватное Имя +7 (999) 123-45-67 ${inspector.CLIENT_ID}`));
    expect(result).toMatchObject({ performed: true, normalizedLeadNameMatchesClient: true, identityConfirmed: false, advisoryOnly: true, contacts: [{ exactClientPhoneMatches: true, normalizedClientNameMatches: true }], notes: { read: 1, complete: true, requestUuidMentioned: true, exactClientPhoneMentioned: true, clientNameMentioned: true } });
    expect(JSON.stringify(result)).not.toMatch(/Приватное|79991234567|123-45-67/);
    expect(get.mock.calls.map((call) => call[0])).toEqual(["/api/v4/leads/32372907", "/api/v4/contacts/800001"]);
  });
  it("does not inspect arbitrary candidates or call notes without exact scope", async () => {
    const get = request(), getNotes = jest.fn();
    expect(await inspector.collectReviewLeadComparison(row, { possibleCandidates: [{ leadId: 101 }] }, get, getNotes)).toMatchObject({ performed: false });
    expect(get).not.toHaveBeenCalled(); expect(getNotes).not.toHaveBeenCalled();
  });
  it("does not equate unknown identity with an absence or allow mutation", async () => {
    const raw = { ...lead, name: "Другое Имя" }, c = { ...contact, name: "Другой Клиент", custom_fields_values: [] };
    expect(await inspector.collectReviewLeadComparison(row, expanded(raw), request(raw, c), async () => null)).toMatchObject({ normalizedLeadNameMatchesClient: false, identityConfirmed: false, contacts: [{ exactClientPhoneMatches: false, normalizedClientNameMatches: false }], notes: { complete: true } });
  });
  it("marks paginated history incomplete without following next URL", async () => {
    const result = await inspector.collectReviewLeadComparison(row, expanded(), request(), async () => ({ ...notes("irrelevant"), _links: { next: { href: "https://evil.test" } } }));
    expect(result.notes.complete).toBe(false);
  });
  it("refuses changed lead and foreign notes", async () => {
    await expect(inspector.collectReviewLeadComparison(row, expanded(), request({ ...lead, status_id: 142 }), async () => null)).rejects.toMatchObject({ safeCode: "EXPANDED_LEAD_CHANGED_DURING_SCAN" });
    await expect(inspector.collectReviewLeadComparison(row, expanded(), request(), async () => ({ _embedded: { notes: [{ id: 1, entity_id: 99, params: { text: "private" } }] } }))).rejects.toMatchObject({ safeCode: "REVIEW_NOTES_INVALID" });
  });
  it("refuses more than 100 notes", async () => {
    await expect(inspector.collectReviewLeadComparison(row, expanded(), request(), async () => ({ _embedded: { notes: Array(101).fill({}) } }))).rejects.toMatchObject({ safeCode: "REVIEW_NOTES_INVALID" });
  });
  it("requests only the literal lead notes GET without redirects or arbitrary inputs", async () => {
    let done = false;
    const fetch = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from('{"_embedded":{"notes":[]}}') }), releaseLock() {}, cancel: async () => {} }) } }));
    await inspector.createReviewNotesRequester("private-token", fetch)();
    const calls = fetch.mock.calls as any[];
    expect(String(calls[0][0])).toBe("https://stmichael.amocrm.ru/api/v4/leads/32372907/notes?limit=100&page=1");
    expect(calls[0][1]).toMatchObject({ method: "GET", redirect: "error" });
  });
});
