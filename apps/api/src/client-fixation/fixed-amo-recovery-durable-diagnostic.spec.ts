import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

describe('fixed failed recovery durable readonly diagnostic', () => {
  const path = resolve(__dirname, '../../../../scripts/inspect-fixed-amo-fixation-case.js');
  const NodeModule = jest.requireActual('module') as any;
  const loaded = new NodeModule(path, module);
  loaded.filename = path; loaded.paths = NodeModule._nodeModulePaths(dirname(path));
  loaded._compile(readFileSync(path, 'utf8'), path);
  const inspector = loaded.exports;
  const entry = (changes: any = {}) => ({ id: 'audit1', entity: 'AmoFixedCaseRecovery', entityId: inspector.CLIENT_ID,
    action: 'AMO_FIXED_CASE_CONTACT_ARMED', createdAt: new Date('2026-10-11T20:00:00Z'),
    payload: { phase: 'CONTACT_ARMED', operationKey: `fixed-amo-fixation-case:v1:${inspector.CLIENT_ID}`,
      runId: '38150838032', planRunId: '38150597583',
      caseHash: '84252dd3069705e3f29d703f4e60b50e89db7e66b45b126cce94f88e63e03a1f',
      candidateHash: '65e35f7515359f37364c8e24a04074562e8dc2570ff30c63eb89da7f8797c67f',
      sourceSha256: 'a'.repeat(64), deployedGitSha: 'b'.repeat(40), automaticRetryBlocked: true,
      secret: 'private-api-token', phone: '+79991112233', contactId: 998877, reason: 'private failure details' }, ...changes });
  it('uses literal scope, UTC day and sentinel ninth record without caller configuration', () => {
    expect(inspector.recoveryAuditQuery()).toMatchObject({ where: { entity: 'AmoFixedCaseRecovery', entityId: inspector.CLIENT_ID,
      createdAt: { gte: new Date('2026-10-11T00:00:00Z'), lte: new Date('2026-10-11T23:59:59.999Z') } }, take: 9 });
    expect(inspector.recoveryAuditQuery({ entityId: 'other' }).where.entityId).toBe(inspector.CLIENT_ID);
    expect(() => inspector.validateRecoveryAuditRows(Array.from({ length: 9 }, (_, i) => entry({ id: `audit${i}` })))).toThrow();
  });
  it('reports only allowlisted classification and comparison booleans, no IDs, hash values or arbitrary strings', () => {
    const report = inspector.recoveryAuditReport([entry()], true);
    expect(report).toMatchObject({ stableReadback: true, absenceProof: false, recordsRead: 1,
      events: [{ phase: 'CONTACT_ARMED', reason: 'unknown_or_missing', applyRunMatches: true, planRunMatches: true,
        caseHashMatchesPlan: true, candidateHashMatchesPlan: true, automaticRetryBlocked: true }] });
    expect(JSON.stringify(report)).not.toMatch(/private|79991112233|998877|84252dd|65e35f|38150838032/);
  });
  it.each([
    { entity: 'Client' }, { entityId: 'other' }, { action: 'AMO_FIXED_CASE_PRIVATE' },
    { createdAt: new Date('2026-10-10T23:59:59.999Z') }, { createdAt: new Date('2026-10-12T00:00:00Z') },
    { payload: null }, { payload: { secret: 'x'.repeat(64001) } },
  ])('rejects foreign, malformed, oversized or out-of-window records %#', (changes) => {
    expect(() => inspector.validateRecoveryAuditRows([entry(changes)])).toThrow();
  });
  it('rejects duplicate rows and preserves unstable evidence without implying successful recovery', () => {
    expect(() => inspector.validateRecoveryAuditRows([entry(), entry()])).toThrow();
    const report = inspector.recoveryAuditReport([entry({ payload: { phase: 'CONTACT_ARMED', runId: 'other',
      reason: 'UNEXPECTED_FAILURE', contactPosts: 0, leadPosts: 0, patchPosts: 2, notePosts: '0' } })], false);
    expect(report).toMatchObject({ stableReadback: false, events: [{ reason: 'UNEXPECTED_FAILURE', contactPosts: 0, leadPosts: 0, applyRunMatches: false }] });
    expect(report.events[0]).not.toHaveProperty('patchPosts'); expect(report.events[0]).not.toHaveProperty('notePosts');
  });
});
