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
});
