import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

describe('fixed amo lead bounded GET-only history', () => {
  const path = resolve(__dirname, '../../../../scripts/inspect-fixed-amo-fixation-case.js');
  const NodeModule = jest.requireActual('module') as any;
  const loaded = new NodeModule(path, module);
  loaded.filename = path; loaded.paths = NodeModule._nodeModulePaths(dirname(path));
  loaded._compile(readFileSync(path, 'utf8'), path);
  const inspector = loaded.exports;
  const row = {
    id: inspector.CLIENT_ID, brokerId: inspector.EXPECTED_BROKER_ID, responsibleBrokerId: null,
    broker: { id: inspector.EXPECTED_BROKER_ID, role: 'BROKER', status: 'PENDING', mergedIntoId: null, amoContactId: 900001n, brokerAgencies: [] },
    phone: '+79991234567', fullName: 'Секретное Имя', project: 'ZORGE9', fixationAgencyId: null,
    amoSyncAttempts: 10, amoSyncStatus: 'FAILED', uniquenessStatus: 'CONDITIONALLY_UNIQUE', fixationStatus: 'NOT_FIXED', status: 'NEW',
    createdAt: new Date('2026-10-08T14:18:19Z'), updatedAt: new Date('2026-10-08T14:18:20Z'),
    amoCreatedAt: null, amoUpdatedAt: null, amoSyncLastAttemptAt: null, uniquenessExpiresAt: null, fixationExpiresAt: null, amoLeadId: null,
  };
  const lead = { id: inspector.REVIEW_LEAD_ID, name: 'Другое имя', pipeline_id: 7600542, status_id: 143, created_at: 1791469099, _embedded: { contacts: [{ id: 900001 }] }, custom_fields_values: [] };
  const window = { pipelineId: 7600542, from: 1791468979, to: 1791722448 };
  const expanded = { window, possibleCandidates: [{ leadId: inspector.REVIEW_LEAD_ID, privateLead: inspector.validatedLead(lead, lead.id, row, window, false) }] };
  const event = (changes: any = {}) => ({ id: 'event1', entity_id: inspector.REVIEW_LEAD_ID, entity_type: 'lead', account_id: 28552900, type: 'contact_unlinked', created_at: 1791469100, value_before: [{ unlink: { entity: { type: 'contact', id: 800001 } } }], value_after: [], ...changes });
  const observed = (events: any[], links?: any) => ({ coverage: 'observed', payload: { _embedded: { events }, ...(links ? { _links: links } : {}) } });
  const contact = { id: 800001, name: 'Секретное Имя', custom_fields_values: [{ field_id: 557903, values: [{ value: '+79991234567' }] }], _embedded: { leads: [] } };
  const get = jest.fn(async () => lead);
  const history = (events = [event()], contactResult: any = { coverage: 'observed', payload: contact }) => jest.fn(async (kind: string) => kind === 'events' ? observed(events) : contactResult);

  it('finds an exact client in an unlinked historical contact without printing private values', async () => {
    const result = await inspector.collectReviewLeadHistory(row, expanded, get, history());
    expect(result).toMatchObject({ stableReadback: true, eventWindowComplete: true, identityConfirmed: false, absenceProof: false, contactUnlinkEvents: 1, historicalContacts: [{ contactId: 800001, exactClientPhoneMatches: true, normalizedClientNameMatches: true, currentlyLinkedToReviewLead: false }] });
    expect(JSON.stringify(result)).not.toMatch(/Секретное|79991234567/);
  });
  it('reports real other-phone evidence separately from missing phone and undecided client role', async () => {
    const other = { ...contact, name: 'Другой клиент', custom_fields_values: [{ field_id: 557903, values: [{ value: '+79990001122' }] }] };
    const result = await inspector.collectReviewLeadHistory(row, expanded, get, history([event()], { coverage: 'observed', payload: other }));
    expect(result.historicalContacts[0]).toMatchObject({ phoneCoverage: 'valid', allObservedPhonesDifferentFromClient: true, normalizedClientNameMatches: false, clientRoleConfirmed: false });
    expect(inspector.reviewContactEvidence({ ...other, custom_fields_values: [] }, row, lead.name, 800001)).toMatchObject({ phoneCoverage: 'missing', allObservedPhonesDifferentFromClient: false });
  });
  it.each(['deleted_or_unavailable', 'forbidden', 'request_failed'])('marks %s historical contacts incomplete', async (coverage) => {
    const result = await inspector.collectReviewLeadHistory(row, expanded, get, history([event()], { coverage, payload: null }));
    expect(result).toMatchObject({ missingHistoricalEntityObserved: true, historyComplete: false, identityConfirmed: false });
  });
  it('captures historical lead name matches and deleted-note incompleteness', async () => {
    const events = [event({ id: 'name1', type: 'name_field_changed', value_before: [{ name_field: { value: 'Секретное Имя' } }], value_after: [{ name_field: { value: 'Другое имя' } }] }), event({ id: 'note1', type: 'common_note_deleted', value_before: [], value_after: [{ note: { id: 99 } }] })];
    const result = await inspector.collectReviewLeadHistory(row, expanded, get, history(events));
    expect(result).toMatchObject({ historicalClientNameMentioned: true, deletedNoteObserved: true, historyComplete: false, identityConfirmed: false });
  });
  it('caps local pagination at five pages without following server URLs', async () => {
    const request = jest.fn(async (_kind: string, args: any) => observed([event({ id: `event${args.page}` })], { next: { href: 'https://evil.test/private-token' } }));
    const result = await inspector.collectReviewEvents(request, lead.created_at, window.to);
    expect(result).toMatchObject({ complete: false, pagesRead: 5 });
    expect(request.mock.calls.map((call) => call[1].page)).toEqual([1, 2, 3, 4, 5]);
  });
  it('does not prove completeness from a full page lacking next link', async () => {
    const result = await inspector.collectReviewEvents(async () => observed(Array.from({ length: 100 }, (_, i) => event({ id: `event${i}` }))), lead.created_at, window.to);
    expect(result.complete).toBe(false);
  });
  it.each([{ entity_id: 99 }, { entity_type: 'contact' }, { account_id: 99 }, { created_at: 1 }, { type: 'unsafe TYPE' }])('rejects out of scope event %j', async (changes) => {
    await expect(inspector.collectReviewEvents(async () => observed([event(changes)]), lead.created_at, window.to)).rejects.toMatchObject({ safeCode: 'REVIEW_EVENTS_INVALID' });
  });
  it('marks changed lead or event readback unstable instead of claiming confirmed identity', async () => {
    let leadCalls = 0;
    const changedLead = async () => (++leadCalls === 1 ? lead : { ...lead, name: 'Изменилось' });
    const result = await inspector.collectReviewLeadHistory(row, expanded, changedLead, history());
    expect(result).toMatchObject({ stableReadback: false, historyComplete: false, identityConfirmed: false });
    let eventCalls = 0;
    const changedEvents = async (kind: string) => kind === 'events' ? observed(++eventCalls === 1 ? [event()] : []) : { coverage: 'observed', payload: contact };
    expect(await inspector.collectReviewLeadHistory(row, expanded, get, changedEvents)).toMatchObject({ stableReadback: false, historyComplete: false });
  });
  it('marks changed historical contact readback unstable', async () => {
    let calls = 0;
    const changed = async (kind: string) => kind === 'events' ? observed([event()]) : { coverage: 'observed', payload: ++calls === 1 ? contact : { ...contact, name: 'Изменилось' } };
    expect(await inspector.collectReviewLeadHistory(row, expanded, get, changed)).toMatchObject({ stableReadback: false, historyComplete: false });
  });
  it('scopes GET events by the fixed lead and handles 403/404 without leaking provider body', async () => {
    const fetch = jest.fn(async (_url: URL, _options: any) => ({ status: 403, ok: false }));
    const request = inspector.createReviewHistoryRequester('private-token', fetch);
    expect(await request('events', { from: lead.created_at, to: window.to, page: 1 })).toEqual({ coverage: 'forbidden', payload: null });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin).toBe('https://stmichael.amocrm.ru'); expect(url.pathname).toBe('/api/v4/events');
    expect(url.searchParams.get('filter[entity_id][]')).toBe('32372907');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    await expect(request('events', { from: lead.created_at, to: window.to, page: 6 })).rejects.toMatchObject({ safeCode: 'REVIEW_HISTORY_SCOPE_INVALID' });
    await expect(request('historicalContact', { id: 123, allowedIds: [456] })).rejects.toMatchObject({ safeCode: 'REVIEW_HISTORY_SCOPE_INVALID' });
  });
  it('caps body bytes even when the provider omits content length', async () => {
    const fetch = jest.fn(async () => ({ status: 200, ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: false, value: Buffer.alloc(1024 * 1024 + 1) }), cancel: async () => {}, releaseLock() {} }) } }));
    const request = inspector.createReviewHistoryRequester('private-token', fetch);
    expect(await request('events', { from: lead.created_at, to: window.to, page: 1 })).toEqual({ coverage: 'request_failed', payload: null });
  });
  it('represents 404 as missing history rather than an empty successful page', async () => {
    const request = inspector.createReviewHistoryRequester('private-token', async () => ({ status: 404, ok: false }));
    expect(await request('historicalContact', { id: 800001, allowedIds: [800001] })).toEqual({ coverage: 'deleted_or_unavailable', payload: null });
  });
});
