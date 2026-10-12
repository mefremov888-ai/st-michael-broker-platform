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
});
