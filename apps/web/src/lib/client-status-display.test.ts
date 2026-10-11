import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clientStatusDisplay, clientTransferUnconfirmed } from './client-status-display';

for (const amoSyncStatus of ['FAILED', 'PENDING']) {
  test(`${amoSyncStatus} and NOT_FIXED do not imply a successful fixation`, () => {
    const client = { uniquenessStatus: 'CONDITIONALLY_UNIQUE', fixationStatus: 'NOT_FIXED', amoSyncStatus };
    const result = clientStatusDisplay(client);
    assert.notEqual(result.label, 'Уникален');
    assert.equal(result.showUniquenessExpiry, false);
    assert.match(result.explanation, /не зафиксирован/);
    assert.equal(client.uniquenessStatus, 'CONDITIONALLY_UNIQUE');
  });
}
test('successful, historical and already fixed rows retain their uniqueness verdict', () => {
  for (const evidence of [{ amoSyncStatus: 'SYNCED', fixationStatus: 'NOT_FIXED' }, { amoSyncStatus: 'FAILED', fixationStatus: 'FIXED' }, {}]) {
    assert.equal(clientStatusDisplay({ uniquenessStatus: 'CONDITIONALLY_UNIQUE', ...evidence }).label, 'Уникален');
  }
});
test('rejected, expired and under review verdicts are not replaced with success', () => {
  for (const [uniquenessStatus, label] of [['REJECTED', 'Не уникален'], ['EXPIRED', 'Истёк'], ['UNDER_REVIEW', 'На проверке']]) {
    assert.equal(clientStatusDisplay({ uniquenessStatus, amoSyncStatus: 'FAILED', fixationStatus: 'NOT_FIXED' }).label, label);
  }
});
test('list, details, dashboard and both staff lists consume the same presentation rule', () => {
  const web = resolve(__dirname, '..');
  for (const file of ['app/(cabinet)/clients/page.tsx', 'app/(cabinet)/dashboard/page.tsx', 'app/(cabinet)/admin/brokers/[id]/page.tsx', 'app/(cabinet)/admin/broker-applications/page.tsx']) {
    assert.match(readFileSync(resolve(web, file), 'utf8'), /clientStatusDisplay/);
  }
  assert.equal(clientTransferUnconfirmed({ amoSyncStatus: 'FAILED', fixationStatus: 'NOT_FIXED' }), true);
});
test('staff application contract carries fixation evidence without overwriting uniqueness', () => {
  const source = readFileSync(resolve(__dirname, '../../../api/src/admin/admin.service.ts'), 'utf8');
  assert.match(source, /extra: \{ project: c\.project, uniquenessStatus: c\.uniquenessStatus, fixationStatus: c\.fixationStatus, fromAmoSync \}/);
});
