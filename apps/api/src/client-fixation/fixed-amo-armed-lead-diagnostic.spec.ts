import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

describe('literal armed recovery lead readonly diagnostic', () => {
  const path = resolve(__dirname, '../../../../scripts/inspect-fixed-amo-fixation-case.js');
  const NodeModule = jest.requireActual('module') as any;
  const loaded = new NodeModule(path, module);
  loaded.filename = path; loaded.paths = NodeModule._nodeModulePaths(dirname(path));
  loaded._compile(readFileSync(path, 'utf8'), path);
  const inspector = loaded.exports;
  const now = new Date('2026-10-12T13:10:00Z');
  const armedAt = '2026-10-12T13:02:35.000Z';
  const time = Math.floor(Date.parse(armedAt) / 1000);
  const row = { id: inspector.CLIENT_ID, brokerId: inspector.EXPECTED_BROKER_ID,
    responsibleBrokerId: null, responsibleBroker: null,
    broker: { id: inspector.EXPECTED_BROKER_ID, amoContactId: 900001 },
    fullName: 'private-name', project: 'ZORGE9', createdAt: new Date('2026-10-08T14:18:19Z') };
  const phases = ['CLAIMED', 'CONTACT_ARMED', 'CONTACT_RESOLVED', 'LEAD_ARMED', 'UNRESOLVED'];
  const audits = () => phases.map((phase, index) => ({ id: `audit${index}`,
    entity: 'AmoFixedCaseRecovery', entityId: inspector.CLIENT_ID,
    action: `AMO_FIXED_CASE_${phase}`, createdAt: new Date(armedAt),
    payload: { ...inspector.ARMED_RECOVERY_METADATA, phase,
      operationKey: `fixed-amo-fixation-case:v1:${inspector.CLIENT_ID}`,
      contactId: 800001, armedAt, reason: 'LEAD_UNCONFIRMED' } }));
  const lead = (value: any = time) => ({ id: 32377125, name: inspector.expectedGeneratedName(row),
    created_at: time, pipeline_id: 7600542, status_id: 62907118,
    _embedded: { contacts: [{ id: 800001 }, { id: 900001 }] },
    custom_fields_values: [{ field_id: 665195, values: [{ enum_id: 985337 }] },
      { field_id: 839179, values: [{ value: 'Зорге 9' }] }, { field_id: 833189, values: [{ value }] }] });
  const diagnose = (raw = lead(), entries = audits(), ids = [800001]) =>
    inspector.armedRecoveryLeadDiagnostic(row, entries, raw, ids, now);
  it('diagnoses exact integer evidence without giving repair or retry authority', () => {
    expect(diagnose()).toMatchObject({ performed: true, auditBindingConfirmed: true,
      exactLeadContactsMatch: true, exactContactLookupMatchesAudit: true,
      requestWithinArmedWindowStrict: true, requestFieldNumericWindowMatches: true,
      identityConfirmed: false, databaseMutationAuthorized: false, amoMutationAuthorized: false, retryAuthorized: false });
    expect(JSON.stringify(diagnose())).not.toMatch(/private-name|800001|900001|38252692034|33231586/);
  });
  it('separates numeric string response from strict integer gate without normalizing the writer', () => {
    expect(diagnose(lead(String(time)))).toMatchObject({ requestValueIsString: true,
      requestValueIsInteger: false, requestWithinArmedWindowStrict: false,
      requestWithinArmedWindowNumeric: true, requestFieldNumericWindowMatches: true });
  });
  it.each(['runId', 'planRunId', 'caseHash', 'candidateHash', 'sourceSha256', 'deployedGitSha'])('refuses changed provenance %s', (key) => {
    const entries = audits(); (entries[0].payload as any)[key] = 'other';
    expect(diagnose(lead(), entries)).toMatchObject({ performed: false, retryAuthorized: false });
  });
  it('does not accept another lead, contact set, future request or missing phase', () => {
    expect(() => diagnose({ ...lead(), id: 32372907 })).toThrow();
    expect(diagnose(lead(), audits(), [800001, 800002]).exactContactLookupMatchesAudit).toBe(false);
    expect(diagnose(lead(time + 10000)).requestWithinArmedWindowNumeric).toBe(false);
    expect(diagnose(lead(), audits().slice(1)).performed).toBe(false);
  });
  it('separates date-only day normalization from the unchanged strict time predicate', () => {
    const midnight = Math.floor(time / 86400) * 86400;
    expect(diagnose(lead(midnight))).toMatchObject({ requestUtcMidnight: true,
      requestUtcDayMatchesArmed: true, requestWithinArmedWindowStrict: false });
    expect(diagnose(lead(midnight - 10800))).toMatchObject({ requestMoscowMidnight: true,
      requestMoscowDayMatchesArmed: true, requestWithinArmedWindowStrict: false });
    expect(diagnose(lead(midnight - 86400)).requestMoscowDayMatchesArmed).toBe(false);
  });
  it('reports only mismatched reviewed field IDs and price comparison, not private values', () => {
    const raw = lead(); const formRow = { ...row, amount: 12300000, sqm: 42,
      propertyType: 'квартира', roomsCount: '2к', readinessLevel: 'горячий', purchaseTiming: '1-3 месяца' };
    const checks = inspector.armedRecoveryFormDiagnostic(raw, formRow);
    expect(checks).toMatchObject({ expectedFieldCount: 10, priceMatches: false });
    expect(checks.mismatchedFieldIds).toEqual([583155, 842273, 587387, 583447, 833045, 604555, 839449, 612517]);
    expect(JSON.stringify(checks)).not.toMatch(/12300000|private|горяч|квартир/);
  });
  it('bounds the literal recovery note and field schema without claiming exact full note verification', () => {
    const field = { id: 833189, entity_type: 'leads', type: 'date' };
    const note = { id: 1, entity_id: 32377125, note_type: 'common', params: {
      text: `Клиент: private-name\nТелефон: +79991234567\nCabinet case UUID: ${inspector.CLIENT_ID}\nRecovery UUID: 7a8d216e-1637-43eb-985b-19b75fd2b9ed\nRecovery source: st-michael-fixed-amo-case-recovery-v1` } };
    const noteRow = { ...row, phone: '+79991234567' };
    const result = inspector.armedRecoveryExtraDiagnostic(noteRow, { _embedded: { notes: [note] } }, field);
    expect(result).toMatchObject({ dateFieldType: 'date', recoveryNoteCount: 1,
      recoveryNoteMarkersPhoneNameMatch: true, fullNoteExactMatchInspected: false });
    expect(JSON.stringify(result)).not.toMatch(/private-name|79991234567|7a8d216e/);
    expect(() => inspector.armedRecoveryExtraDiagnostic(noteRow, { _embedded: { notes: [note, note] }, _links: { next: {} } }, field)).toThrow();
    expect(() => inspector.armedRecoveryExtraDiagnostic(noteRow, null, { ...field, id: 1 })).toThrow();
  });
  it('allows only the two literal GET endpoints, with TLS redirects refused and no arbitrary scope', async () => {
    let done = false;
    const fetchImpl = jest.fn(async (_url: any, _options: any) => ({ ok: true, status: 200, headers: { get: () => null }, body: {
      getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from('{}') }),
        cancel: async () => {}, releaseLock: () => {} }) } }));
    const request = inspector.createArmedRecoveryExtraRequester('private-token', fetchImpl);
    await request('dateField');
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://stmichael.amocrm.ru/api/v4/leads/custom_fields/833189');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    await expect(request('other')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  const agency = { id: 'private-agency', name: 'private-agency-name', inn: '1234567890', updatedAt: new Date(armedAt) };
  const noteRow = () => ({ ...row, phone: '+79991234567', fixationAgencyId: agency.id,
    email: 'private-email@example.test', comment: 'private-comment', clientRegion: 'private-region',
    propertyType: 'квартира', roomsCount: '2к', amount: 12000000, sqm: 42,
    purchaseTiming: 'private-timing', readinessLevel: 'private-readiness',
    responsibleBrokerId: 'private-responsible',
    responsibleBroker: { id: 'private-responsible', fullName: 'private-broker-name', phone: '+79997654321' },
    broker: { ...row.broker, fullName: 'private-coordinator', phone: '+79990000000' } });
  const notePayload = (text: string) => ({ _embedded: { notes: [{ id: 1, entity_id: 32377125, note_type: 'common', params: { text } }] } });
  const schema = { id: 833189, entity_type: 'leads', type: 'date' };
  it('compares the full note including agency tag and all private form/coordinator data, without outputting it', () => {
    const current = noteRow(); const text = inspector.armedRecoveryExpectedNote(current, agency);
    const result = inspector.armedRecoveryExtraDiagnostic(current, notePayload(text), schema, { row: current, agency });
    expect(result).toMatchObject({ fullNoteExactMatchInspected: true, fullNoteExactMatch: true, exactNoteCount: 1 });
    expect(JSON.stringify(result)).not.toMatch(/private|7999|1234567890|12000000|Recovery agency|7a8d216e/);
    for (const marker of ['private-email', 'private-comment', 'private-coordinator', 'private-broker-name', 'Recovery agency tag:']) {
      expect(inspector.armedRecoveryExtraDiagnostic(current, notePayload(text.replace(marker, 'changed')), schema,
        { row: current, agency }).fullNoteExactMatch).toBe(false);
    }
    expect(inspector.armedRecoveryExtraDiagnostic(current, { _embedded: { notes: [
      ...notePayload(text)._embedded.notes, ...notePayload(text)._embedded.notes.map(n => ({ ...n, id: 2 }))] } }, schema,
      { row: current, agency }).fullNoteExactMatch).toBe(false);
    expect(inspector.armedRecoveryExtraDiagnostic(current, notePayload(text), schema,
      { row: current, agency: { ...agency, updatedAt: new Date('2026-10-12T13:03:00Z') } }).fullNoteExactMatch).toBe(false);
  });
  it('binds note expectations exactly to the reviewed writer rather than an abbreviated reconstruction', () => {
    const writer = readFileSync(resolve(__dirname, '../../../../scripts/apply-fixed-amo-fixation-case.js'), 'utf8');
    const extract = (start: string, end: string) => writer.slice(writer.indexOf(start), writer.indexOf(end));
    const tag = new Function('fingerprint', `return ${extract('function recoveryAgencyTag(', 'function decorateRecoveryNote(')}`)(inspector.privateFingerprint);
    const decorate = new Function('recoveryAgencyTag', 'CLIENT_ID', 'RECOVERY_UUID', 'RECOVERY_SOURCE', 'fail',
      `return ${extract('function decorateRecoveryNote(', 'function createIsolatedAdapter(')}`)(tag, inspector.CLIENT_ID,
        '7a8d216e-1637-43eb-985b-19b75fd2b9ed', 'st-michael-fixed-amo-case-recovery-v1', () => { throw Error('refused'); });
    const expected = new Function('effective', 'decorateRecoveryNote',
      `return ${extract('function expectedRecoveryNote(', 'async function confirmRecoveryNote(')}`)(
        (value: any) => value.responsibleBrokerId === null ? value.broker : value.responsibleBroker, decorate);
    expect(inspector.armedRecoveryExpectedNote(noteRow(), agency)).toBe(expected({ row: noteRow(), agency }));
    expect(() => inspector.armedRecoveryExpectedNote(noteRow(), { ...agency, id: 'other' })).toThrow();
    expect(() => inspector.armedRecoveryExpectedNote(noteRow(), { ...agency, inn: 'bad' })).toThrow();
    expect(() => inspector.armedRecoveryExpectedNote(noteRow(), { ...agency, updatedAt: new Date('invalid') })).toThrow();
    expect(inspector.CLIENT_SELECT.email).toBeUndefined();
    expect(inspector.ARMED_NOTE_SELECT.email).toBe(true);
    expect(inspector.armedRecoveryAuditBound(audits())).toBe(true);
    expect(inspector.armedRecoveryAuditBound(audits().slice(1))).toBe(false);
  });
  it('reads extra note data and agency only inside the literal bound readonly snapshot and detects row drift', async () => {
    const current = { ...noteRow(), updatedAt: new Date(armedAt), amoLeadId: null,
      amoCreatedAt: null, amoUpdatedAt: null, amoSyncStatus: 'FAILED', amoSyncAttempts: 10,
      amoSyncLastAttemptAt: null, amoSyncError: 'marker', uniquenessStatus: 'CONDITIONALLY_UNIQUE',
      uniquenessExpiresAt: null, fixationStatus: 'NOT_FIXED', fixationExpiresAt: null, status: 'NEW',
      broker: { ...noteRow().broker, role: 'BROKER', status: 'ACTIVE', mergedIntoId: null, brokerAgencies: [] },
      responsibleBroker: { ...noteRow().responsibleBroker, amoContactId: 900001, role: 'BROKER', status: 'PENDING',
        mergedIntoId: null, brokerAgencies: [{ agencyId: agency.id, isPrimary: true }] } };
    const env = { PRODUCTION_PG_SYSTEM_IDENTIFIER: '123', PRODUCTION_MIN_BROKER_ROWS: '1' };
    const project = (value: any, selection: any): any => value === null ? null : Object.fromEntries(
      Object.entries(selection).map(([key, selected]: any) => [key, selected === true ? value[key] :
        Array.isArray(value[key]) ? value[key].map((child: any) => project(child, selected.select)) : project(value[key], selected.select)]));
    const database = (entries = audits(), drift = false) => {
      const tx = { $queryRaw: jest.fn(async (sql: any) => sql.join('').includes('pg_control_system') ?
        [{ read_only: 'on', database_name: 'broker_platform', system_identifier: '123', broker_rows: '100' }] : [{ mode: 'on' }]),
        client: { findUnique: jest.fn(async (query: any) => project(query.select === inspector.ARMED_NOTE_SELECT && drift ?
          { ...current, amount: 1 } : current, query.select)) },
        agency: { findUnique: jest.fn(async () => agency) },
        auditLog: { findMany: jest.fn(async (query: any) => query.where.entity === 'AmoFixedCaseRecovery' ? entries : []) } };
      return { tx, $transaction: jest.fn(async (fn: any) => fn(tx)) };
    };
    const db = database();
    expect((await inspector.snapshot(db, env, false, true)).noteBaseline).toEqual({ row: current, agency });
    expect(db.tx.client.findUnique).toHaveBeenCalledTimes(2);
    expect(db.tx.agency.findUnique).toHaveBeenCalledWith({ where: { id: agency.id }, select: { id: true, name: true, inn: true, updatedAt: true } });
    expect(db.tx.$queryRaw.mock.calls[0][0].join('')).toContain('transaction_read_only');
    const unbound = database(audits().slice(1));
    expect((await inspector.snapshot(unbound, env, false, true)).noteBaseline).toBeNull();
    expect(unbound.tx.client.findUnique).toHaveBeenCalledTimes(1);
    expect(unbound.tx.agency.findUnique).not.toHaveBeenCalled();
    await expect(inspector.snapshot(database(audits(), true), env, false, true)).rejects.toMatchObject({ safeCode: 'CASE_CHANGED_DURING_SCAN' });
  });
});
