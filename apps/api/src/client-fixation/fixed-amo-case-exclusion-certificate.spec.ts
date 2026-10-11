import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

describe('exact case broker Calltouch exclusion certificate (pure read evidence)', () => {
  const path = resolve(__dirname, '../../../../scripts/fixed-amo-case-exclusion-certificate.js');
  const NodeModule = jest.requireActual('module') as any;
  const loaded = new NodeModule(path, module);
  loaded.filename = path; loaded.paths = NodeModule._nodeModulePaths(dirname(path));
  loaded._compile(readFileSync(path, 'utf8'), path);
  const cert = loaded.exports;
  const inspectorPath = resolve(dirname(path), 'inspect-fixed-amo-fixation-case.js');
  const inspected = new NodeModule(inspectorPath, module);
  inspected.filename = inspectorPath; inspected.paths = NodeModule._nodeModulePaths(dirname(inspectorPath));
  inspected._compile(readFileSync(inspectorPath, 'utf8'), inspectorPath);
  const inspector = inspected.exports;
  const caseId = '8d082b21-7cba-4778-a6c6-1d80bfe7ed7c', ownerId = '6e414141-f2ca-4c71-8402-2032c9186568';
  const now = new Date('2026-10-11T14:30:00Z');
  const RuntimeDate = jest.requireActual('vm').runInThisContext('Date');
  beforeEach(() => jest.spyOn(RuntimeDate, 'now').mockReturnValue(now.getTime()));
  afterEach(() => jest.restoreAllMocks());
  const makeInput = () => {
    const row = { id: caseId, brokerId: ownerId, responsibleBrokerId: null, responsibleBroker: null, project: 'ZORGE9', phone: '+79990001122', fullName: 'Клиент Секретный', fixationAgencyId: 'agency1', createdAt: new Date('2026-10-08T14:18:19.203Z'), amoSyncLastAttemptAt: new Date('2026-10-08T14:18:19.466Z'), amoLeadId: null, broker: { id: ownerId, phone: '+79993334455', role: 'BROKER', status: 'PENDING', mergedIntoId: null, amoContactId: 47267177n, brokerAgencies: [{ agencyId: 'agency1', isPrimary: true }] } };
    const fields = [[618511, 'Звонок из Calltouch'], [618517, '+79993334455'], [618577, 'private-call-id'], [618527, '09.10.2026 10:52:47']];
    const lead = { id: 32372907, name: 'Брокер Другой', created_at: 1791532367, pipeline_id: 7600542, status_id: 143, custom_fields_values: fields.map(([field_id, value]) => ({ field_id, values: [{ value }] })), _embedded: { contacts: [{ id: 47267177 }], companies: [{ id: 43419077 }] } };
    const event = (id: string, type: string, value_after: any[], created_at = lead.created_at) => ({ id, type, entity_id: lead.id, entity_type: 'lead', account_id: 28552900, created_at, value_before: [], value_after });
    const events = [event('added', 'lead_added', []), event('linked', 'entity_linked', [{ link: { entity: { type: 'contact', id: 47267177 } } }]), event('company', 'entity_linked', [{ link: { entity: { type: 'company', id: 43419077 } } }], lead.created_at + 1000), ...fields.map(([field_id, text]) => event(`field${field_id}`, `custom_field_${field_id}_value_changed`, [{ custom_field_value: { field_id, text } }], lead.created_at + 91))];
    const window = { pipelineId: 7600542, from: 1791468979, to: Math.floor(now.getTime() / 1000) + 120 };
    const expanded = { complete: true, capturedAt: now.toISOString(), window, possibleCandidates: [{ leadId: lead.id, privateLead: inspector.validatedLead(lead, lead.id, row, window, false) }] };
    const broker = { id: 47267177, name: 'Брокер Другой', updated_at: 1791532367, _embedded: { leads: [{ id: lead.id }] }, custom_fields_values: [{ field_id: 835415, values: [{ value: true }] }, { field_id: 557903, field_code: 'PHONE', values: [{ value: row.broker.phone }] }] };
    const notes = { _embedded: { notes: [] } };
    const history = { coverage: 'observed', complete: true, pagesRead: 1, events };
    return { row, agency: { id: 'agency1', name: 'Агентство Секретное', inn: '1234567890' }, expanded, brokerContactId: 47267177, expectedCompanyId: 43419077, candidate: { leadFirst: lead, leadSecond: structuredClone(lead), brokerContactFirst: broker, brokerContactSecond: structuredClone(broker), notesFirst: notes, notesSecond: structuredClone(notes), eventsFirst: history, eventsSecond: structuredClone(history) } };
  };
  const syncReadbacks = (input: any) => {
    input.candidate.leadSecond = structuredClone(input.candidate.leadFirst);
    input.candidate.eventsSecond = structuredClone(input.candidate.eventsFirst);
    input.candidate.brokerContactSecond = structuredClone(input.candidate.brokerContactFirst);
    input.expanded.possibleCandidates[0].privateLead = inspector.validatedLead(input.candidate.leadFirst, 32372907, input.row, input.expanded.window, false);
  };
  it('certifies only this unrelated broker call and removes only its candidate without raw values', () => {
    const input = makeInput();
    input.expanded.possibleCandidates.push({ leadId: 555, privateLead: {} } as any);
    const proof = cert.buildFixedCaseExclusionCertificate(input);
    expect(proof).toMatchObject({ schemaVersion: 1, leadId: 32372907, source: 'exact_case_broker_calltouch_readback' });
    expect(JSON.stringify(proof)).not.toMatch(/private-call|7999|Клиент|Агентство/);
    expect(cert.filterFixedCaseExcludedCandidate(input.expanded, proof, input.row, input.agency).possibleCandidates.map((item: any) => item.leadId)).toEqual([555]);
    expect(input.expanded.possibleCandidates).toHaveLength(2);
  });
  it('rechecks fresh identical evidence and invalidates the old opaque certificate', () => {
    const input = makeInput(), proof = cert.buildFixedCaseExclusionCertificate(input);
    const fresh = makeInput(); fresh.expanded.capturedAt = new Date(now.getTime() + 1000).toISOString();
    (RuntimeDate.now as any).mockReturnValue(now.getTime() + 1000);
    const renewed = cert.recheckFixedCaseExclusionCertificate(proof, fresh);
    expect(() => cert.filterFixedCaseExcludedCandidate(input.expanded, proof, input.row, input.agency)).toThrow();
    expect(cert.filterFixedCaseExcludedCandidate(fresh.expanded, renewed, fresh.row, fresh.agency).possibleCandidates).toEqual([]);
  });
  it('rejects forged or serialized certificates and stale evidence', () => {
    const input = makeInput(), proof = cert.buildFixedCaseExclusionCertificate(input);
    expect(() => cert.filterFixedCaseExcludedCandidate(input.expanded, JSON.parse(JSON.stringify(proof)), input.row, input.agency)).toThrow();
    input.expanded.capturedAt = new Date(now.getTime() - 60001).toISOString();
    expect(() => cert.buildFixedCaseExclusionCertificate(input)).toThrow();
  });
  it('refuses delayed filtering, changed scan window, candidate drift and recheck drift', () => {
    const input = makeInput(), proof = cert.buildFixedCaseExclusionCertificate(input);
    (RuntimeDate.now as any).mockReturnValue(now.getTime() + 60001);
    expect(() => cert.filterFixedCaseExcludedCandidate(input.expanded, proof, input.row, input.agency)).toThrow();
    (RuntimeDate.now as any).mockReturnValue(now.getTime());
    input.expanded.window.from++;
    expect(() => cert.filterFixedCaseExcludedCandidate(input.expanded, proof, input.row, input.agency)).toThrow();
    const fresh: any = makeInput(); fresh.candidate.leadFirst.privateMutation = true; syncReadbacks(fresh);
    expect(() => cert.recheckFixedCaseExclusionCertificate(proof, fresh)).toThrow();
    const drift = makeInput(), driftProof = cert.buildFixedCaseExclusionCertificate(drift);
    drift.expanded.possibleCandidates[0].privateLead.exactGeneratedName = true;
    expect(() => cert.filterFixedCaseExcludedCandidate(drift.expanded, driftProof, drift.row, drift.agency)).toThrow();
  });
  it.each(['leadSecond', 'brokerContactSecond', 'notesSecond', 'eventsSecond'])('rejects unstable %s evidence', (key) => {
    const input: any = makeInput(); input.candidate[key].privateMutation = true;
    expect(() => cert.buildFixedCaseExclusionCertificate(input)).toThrow();
  });
  it.each([618517, 618511, 618577, 618527])('requires independent initial historical field %s', (fieldId) => {
    const input = makeInput(); input.candidate.eventsFirst.events = input.candidate.eventsFirst.events.filter((event) => event.type !== `custom_field_${fieldId}_value_changed`); syncReadbacks(input);
    expect(() => cert.buildFixedCaseExclusionCertificate(input)).toThrow();
  });
  it('rejects any historical client phone, including a changed-away earlier value', () => {
    const input = makeInput();
    const changed = input.candidate.eventsFirst.events.find((event) => event.type === 'custom_field_618517_value_changed')!;
    changed.value_before = [{ custom_field_value: { field_id: 618517, text: input.row.phone } }]; syncReadbacks(input);
    expect(() => cert.buildFixedCaseExclusionCertificate(input)).toThrow();
  });
  it.each(['common_note_deleted', 'entity_unlinked', 'lead_deleted', 'entity_merged'])('rejects incomplete history event %s', (type) => {
    const input = makeInput(); input.candidate.eventsFirst.events[0].type = type; syncReadbacks(input);
    expect(() => cert.buildFixedCaseExclusionCertificate(input)).toThrow();
  });
  it('rejects extra current or historical contacts and mismatched company', () => {
    const input = makeInput(); input.candidate.leadFirst._embedded.contacts.push({ id: 800001 }); syncReadbacks(input);
    expect(() => cert.buildFixedCaseExclusionCertificate(input)).toThrow();
    const other = makeInput(); other.candidate.eventsFirst.events[1].value_after[0].link.entity.id = 800001; syncReadbacks(other);
    expect(() => cert.buildFixedCaseExclusionCertificate(other)).toThrow();
    const company = makeInput(); company.candidate.leadFirst._embedded.companies[0].id = 43419078; syncReadbacks(company);
    expect(() => cert.buildFixedCaseExclusionCertificate(company)).toThrow();
  });
  it('rejects scope drift, incomplete pagination, client mentions and oversized bodies', () => {
    for (const mutate of [
      (input: any) => { input.row.brokerId = 'other'; },
      (input: any) => { input.candidate.eventsFirst.complete = false; },
      (input: any) => { input.candidate.eventsFirst.pagesRead = 6; },
      (input: any) => { input.candidate.leadFirst.name = input.row.fullName; },
      (input: any) => { input.candidate.leadFirst.privateNote = caseId; },
      (input: any) => { input.candidate.leadFirst.privateNote = 'x'.repeat(1024 * 1024); },
      (input: any) => { input.row.amoSyncLastAttemptAt = new Date('2026-10-09T07:52:46Z'); },
      (input: any) => { input.candidate.eventsFirst.events[0].entity_id = 5; },
    ]) { const input = makeInput(); mutate(input); expect(() => cert.buildFixedCaseExclusionCertificate(input)).toThrow(); }
  });
  it('binds client payload and agency but permits only operational CAS marker changes', () => {
    const input: any = makeInput(), proof = cert.buildFixedCaseExclusionCertificate(input);
    input.row.amoSyncError = 'new durable marker'; input.row.amoSyncAttempts = 10; input.row.updatedAt = new Date();
    expect(cert.filterFixedCaseExcludedCandidate(input.expanded, proof, input.row, input.agency).possibleCandidates).toEqual([]);
    input.row.phone = '+79998887766';
    expect(() => cert.filterFixedCaseExcludedCandidate(input.expanded, proof, input.row, input.agency)).toThrow();
    const agency = makeInput(), agencyProof = cert.buildFixedCaseExclusionCertificate(agency); agency.agency.inn = '0987654321';
    expect(() => cert.filterFixedCaseExcludedCandidate(agency.expanded, agencyProof, agency.row, agency.agency)).toThrow();
  });
  it('supports delegated responsibility and never substitutes the owner contact or phone', () => {
    const input: any = makeInput();
    input.row.responsibleBrokerId = 'responsible1';
    input.row.responsibleBroker = { ...structuredClone(input.row.broker), id: 'responsible1' };
    input.row.broker = { ...input.row.broker, phone: '+79997776655', amoContactId: 900001n, role: 'ADMIN', brokerAgencies: [] };
    const proof = cert.buildFixedCaseExclusionCertificate(input);
    expect(cert.filterFixedCaseExcludedCandidate(input.expanded, proof, input.row, input.agency).possibleCandidates).toEqual([]);
    input.row.responsibleBrokerId = 'responsible2'; input.row.responsibleBroker.id = 'responsible2';
    expect(() => cert.filterFixedCaseExcludedCandidate(input.expanded, proof, input.row, input.agency)).toThrow();
    const bad: any = makeInput(); bad.row.responsibleBrokerId = 'responsible1';
    bad.row.responsibleBroker = { ...bad.row.broker, id: 'responsible1', phone: '+79997776655', amoContactId: 900001n };
    expect(() => cert.buildFixedCaseExclusionCertificate(bad)).toThrow();
  });
  it('allows own new lead membership but rejects changed broker identity, phone or flag', () => {
    const input = makeInput(), proof = cert.buildFixedCaseExclusionCertificate(input);
    const fresh = makeInput(); fresh.candidate.brokerContactFirst._embedded.leads.push({ id: 555555 }); fresh.candidate.brokerContactFirst.updated_at++;
    syncReadbacks(fresh);
    expect(cert.recheckFixedCaseExclusionCertificate(proof, fresh).candidateHash).toBe(proof.candidateHash);
    for (const mutate of [
      (broker: any) => { broker.name = 'Changed'; },
      (broker: any) => { broker.custom_fields_values[1].values[0].value = '+79997776655'; },
      (broker: any) => { broker.custom_fields_values[0].values[0].value = false; },
      (broker: any) => { broker.custom_fields_values.push({ field_id: 77, values: [{ value: 'Changed' }] }); },
    ]) { const original = makeInput(), originalProof = cert.buildFixedCaseExclusionCertificate(original), changed = makeInput(); mutate(changed.candidate.brokerContactFirst); syncReadbacks(changed); expect(() => cert.recheckFixedCaseExclusionCertificate(originalProof, changed)).toThrow(); }
  });
});
