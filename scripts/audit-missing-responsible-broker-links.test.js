const test = require('node:test');
const assert = require('node:assert/strict');
const {
  boundedInt,
  maskPhone,
  effectiveBroker,
  classify,
} = require('./audit-missing-responsible-broker-links');

test('masks phones and bounds audit parameters', () => {
  assert.equal(maskPhone('+7 (927) 414-86-58'), '***8658');
  assert.equal(maskPhone(null), '(нет)');
  assert.equal(boundedInt('30', 10, 1, 100), 30);
  assert.equal(boundedInt('500', 10, 1, 100), 10);
});

test('uses responsible broker with owner fallback', () => {
  const owner = { id: 'owner' };
  const responsible = { id: 'responsible' };
  assert.equal(effectiveBroker({ broker: owner, responsibleBroker: responsible }), responsible);
  assert.equal(effectiveBroker({ broker: owner, responsibleBroker: null }), owner);
});

test('classifies read-only amo snapshots', () => {
  const base = { fetchResult: 'ok', pipelineId: 7600542, contactIds: [10, 20], amoContactId: 20 };
  assert.equal(classify(base), 'broker_attached');
  assert.equal(classify({ ...base, amoContactId: 30 }), 'missing_broker_link');
  assert.equal(classify({ ...base, amoContactId: null }), 'broker_amo_id_missing');
  assert.equal(classify({ ...base, pipelineId: 7600550 }), 'non_kc_pipeline');
  assert.equal(classify({ ...base, fetchResult: 'lead_missing' }), 'lead_missing');
  assert.equal(classify({ ...base, fetchResult: 'api_error' }), 'api_error');
});
