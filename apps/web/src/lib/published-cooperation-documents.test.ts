import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { publishedCooperationDocuments, visibleDocumentDescription } from './published-cooperation-documents';

test('archives are removed from cabinet view without deleting source records', () => {
  const rows = [{ isPublic: true, id: 'conditions' }, { isPublic: false, id: 'old-installment' }, { isPublic: false, id: 'august' }, { isPublic: false, id: 'old-rewards' }, { isPublic: true, id: 'calculator' }];
  assert.deepEqual(publishedCooperationDocuments(rows).map(r => r.id), ['conditions', 'calculator']);
  assert.equal(rows.length, 5);
  assert.equal(publishedCooperationDocuments({ documents: rows }).length, 2);
});
test('technical import markers never appear as broker descriptions', () => {
  assert.equal(visibleDocumentDescription('[landing-rewards-button]'), '');
  assert.equal(visibleDocumentDescription('[seed:cooperation-calculator]'), '');
  assert.equal(visibleDocumentDescription('Условия для партнёров'), 'Условия для партнёров');
});
test('document page preserves offer acceptance and uses landing catalogue', () => {
  const source = readFileSync(new URL('../app/(cabinet)/documents/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /\/public\/documents\?category=cooperation/);
  assert.match(source, /\/offer\/my/);
  assert.doesNotMatch(source, /apiDelete|\.delete\(/);
});
